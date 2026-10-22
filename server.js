import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Strategy, defaults, latestSignal, sessionSignal, signalSequence, upcomingSignal} from './engine.js';
import {SharekhanAuth} from './sharekhan-auth.js';
import {StrategyStore} from './store.js';
import {assertInstrument,instrumentMeta,optionMarket,optionRows,searchInstruments,warmInstrumentCache} from './instruments.js';
import {marketCandles} from './market.js';
import {detectOption,optionSide,optionUnderlying,premiumAt,selectUnderlying,sideActions,sideGridField,sideGridKeys,withOptionGrid} from './options.js';
import {attachLive} from './live.js';
import {AngelData} from './angel.js';
import {login, tokenFrom, verifyToken} from './auth.js';
import {sharekhanBook} from './sharekhan-book.js';
import {alignOrderContract, submitLiveOrder} from './sharekhan-orders.js';
import {applyBrokerFills, liveIntents, trailOpenStops} from './live-grid.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const stateFile=path.join(root,'data','state.json');
function loadLocalEnv(){
  const file=path.join(root,'.env');
  if(!fs.existsSync(file))return;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    const match=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if(match && (match[1].startsWith('SHAREKHAN_') || process.env[match[1]]===undefined))process.env[match[1]]=match[2].replace(/^["']|["']$/g,'');
  }
}
loadLocalEnv();
const port=Number(process.env.PORT||4000);
const host=process.env.HOST||'127.0.0.1';
const broker=new SharekhanAuth({
  apiKey:process.env.SHAREKHAN_API_KEY,
  secureKey:process.env.SHAREKHAN_SECURE_KEY,
  customerId:process.env.SHAREKHAN_CUSTOMER_ID,
  loginId:process.env.SHAREKHAN_LOGIN_ID,
  vendorKey:process.env.SHAREKHAN_VENDOR_KEY,
  versionId:process.env.SHAREKHAN_VERSION_ID
});
const angel=new AngelData();
const store=new StrategyStore(process.env.MONGODB_URI, process.env.MONGODB_DB||'dna-strategy',process.env.SHAREKHAN_SESSION_ENCRYPTION_KEY);
const engine=new Strategy();
function restore(snapshot){
  if(!snapshot)return;
  const {pnl,...state}=snapshot;
  Object.assign(engine,state);
  engine.config={...defaults,...engine.config};
  const savedFrame=String(state.signalFrame||'').toLowerCase();
  if(['1minute','3minute','5minute','15minute','30minute','60minute'].includes(savedFrame))engine.config.signalInterval=savedFrame;
  engine.nextId=(engine.events||[]).reduce((max,event)=>Math.max(max,Number(event.id)||0),0)+1;
  if(engine.tradeMode!=='live')engine.tradeMode='existing';
  engine.signal=engine.signal||null;
  engine.startedAt=engine.startedAt||null;
  if(engine.status==='running'){engine.status='paused';engine.pending=null;engine.log('risk','Server restarted; manually resume after checking broker positions');}
}
async function save(){await store.save(engine.snapshot());}
const istToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const signalMinutes=()=>({'1minute':1,'3minute':3,'5minute':5,'15minute':15,'30minute':30,'60minute':60}[engine.config.signalInterval]||15);
const signalMarket=()=>marketCandles({exchange:engine.config.exchange||'NC',scripCode:engine.config.scripCode||'20000',symbol:engine.config.symbol||'NIFTY',angel,interval:engine.config.signalInterval||'15minute'});
async function underlyingSpot(given,market={}){
  const price=Number(given);
  if(Number.isFinite(price)&&price>0)return price;
  const symbol=optionUnderlying(market.symbol||engine.config.symbol||'NIFTY');
  const exchange=market.exchange||engine.config.exchange||'NC';
  const scripCode=market.scripCode||engine.config.scripCode;
  const indices=new Set(['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','SENSEX']);
  let quoteTarget={exchange,scripCode,symbol};
  if(!indices.has(symbol)){
    const underlying=selectUnderlying(await optionRows(exchange),{symbol,scripCode});
    if(!underlying)throw Error(`${symbol} price is not available yet`);
    quoteTarget={exchange:optionMarket(exchange),scripCode:underlying.scripCode,symbol:underlying.tradingSymbol};
  }
  const close=Number((await angel.quote(quoteTarget)).price);
  if(!(close>0))throw Error(`${symbol} price is not available yet`);
  return close;
}
async function optionQuote(contract){
  return angel.quote(contract);
}
function gridSettings(url,direction){
  const cfg=engine.config;
  const num=(name,fallback)=>{const value=Number(url.searchParams.get(name));return Number.isFinite(value)&&value>0?value:fallback;};
  return {side:direction==='short'?'short':'buy',gridStep:num('gridStep',cfg.gridStep),targetPoints:num('targetPoints',cfg.targetPoints),initialStop:num('initialStop',cfg.initialStop),maxLegs:Math.trunc(num('maxLegs',cfg.maxLegs)),tickSize:num('tickSize',cfg.tickSize||0.05),trailStartLeg:Math.trunc(num('trailStartLeg',cfg.trailStartLeg)),trailStep:num('trailStep',cfg.trailStep)};
}
function gridSettingsFor(url,right){
  const prefix=right==='PE'?'put':'call';
  const cfg=engine.config;
  const pick=key=>{
    const field=sideGridField(prefix,key);
    const fromUrl=Number(url.searchParams.get(field));
    if(Number.isFinite(fromUrl)&&fromUrl>0)return fromUrl;
    const saved=Number(cfg[field]);
    if(Number.isFinite(saved)&&saved>0)return saved;
    return Number(cfg[key]);
  };
  const values={};
  for(const key of sideGridKeys)values[key]=['quantity','maxLegs','trailStartLeg'].includes(key)?Math.trunc(pick(key)):pick(key);
  return values;
}
function rememberSideGrid(board,settings){
  if(!board)return board;
  board.orderQuantity=Math.trunc(settings.quantity||settings.orderQuantity||engine.config.quantity);
  board.trailStartLeg=Math.trunc(settings.trailStartLeg||engine.config.trailStartLeg);
  board.trailStep=settings.trailStep||engine.config.trailStep;
  return board;
}
async function boardForPlan(url,direction,settings,plan,previewConfig={}){
  const market={symbol:url.searchParams.get('symbol')||engine.config.symbol,exchange:url.searchParams.get('exchange')||engine.config.exchange,scripCode:url.searchParams.get('scripCode')||engine.config.scripCode};
  const gridSource=(url.searchParams.get('gridSource')||engine.config.gridSource)==='signal'?'signal':'premium';
  if(engine.config.gridSource!==gridSource){engine.config.gridSource=gridSource;await save();}
  settings.gridSource=gridSource;
  const selection={optionMoneyness:url.searchParams.get('moneyness')||engine.config.optionMoneyness,optionDepth:url.searchParams.get('depth')||engine.config.optionDepth};
  const signalSpot=engine.tradeMode==='live'&&engine.status==='running'&&engine.signal?.spot>0?engine.signal.spot:undefined;
  const givenSpot=Number(url.searchParams.get('spot'));
  const strikeSpot=signalSpot??(Number.isFinite(givenSpot)&&givenSpot>0?givenSpot:undefined);
  if(!plan.length){
    const mode=String(previewConfig.optionMode||'BOTH').toUpperCase();
    const rights=mode==='CE'?['CE']:mode==='PE'?['PE']:['CE','PE'];
    const display=[];
    for(const right of rights){
      try{
        const contract=await resolveOption({...selection,optionRight:right},direction,strikeSpot,market);
        let quote=null;
        try{quote=await optionQuote(contract);}catch(error){quote={error};}
        display.push({...contract,side:direction==='short'?'short':'buy',off:true,price:quote?.price||null,anchor:null,gridSource,signalTime:null,grid:[],gridError:`${direction==='short'?'Sell':'Buy'} signal: ${right} grid is Off in settings, so no trade will be placed on this signal.`,orders:[]});
      }catch(error){display.push({optionType:right,side:direction==='short'?'short':'buy',label:'',grid:[],gridError:error.message,orders:[],gridSource});}
    }
    engine.sideContracts={};
    for(const side of display)if(side.scripCode)engine.sideContracts[side.optionType]=side;
    if(display[0]?.scripCode)engine.option=display[0];
    const first=display[0]||{label:'',side:direction==='short'?'short':'buy',price:null,grid:[],orders:[],gridError:'This signal has no active side.',gridSource};
    return {...first,sides:display};
  }
  const sides=[];
  for(const item of plan){
    let contract;
    const kept=engine.status==='running'&&engine.tradeMode!=='live'?(engine.sideContracts?.[item.right]||(engine.option?.optionType===item.right?engine.option:null)):null;
    try{contract=kept?.scripCode?kept:await resolveOption({...selection,optionRight:item.right},direction,strikeSpot,market);}
    catch(error){sides.push({optionType:item.right,side:item.side,label:'',grid:[],gridError:error.message,orders:[],gridSource});continue;}
    const own=gridSettingsFor(url,item.right);
    const sideSettings={...settings,...own,side:item.side};
    if(Number(contract.tickSize)>0)sideSettings.tickSize=Number(contract.tickSize);
    let quote=null;
    try{quote=await optionQuote(contract);}catch(error){quote={error};}
    let board;
    try{
      if(quote?.error)throw quote.error;
      board=await withOptionGrid(contract,{...sideSettings,quote});
    }catch(error){board={...contract,side:item.side,price:quote?.price||null,anchor:null,gridSource,signalTime:null,grid:[],gridError:error.message};}
    board.side=item.side;
    rememberSideGrid(board,sideSettings);
    if(board.grid?.length)applyGridAnchor(board);
    board.orders=engine.orders().filter(order=>!order.parked&&(order.right||'CE')===item.right&&(!order.scripCode||!board.scripCode||String(order.scripCode)===String(board.scripCode)));
    sides.push(board);
  }
  engine.sideContracts={};
  for(const side of sides)if(side.scripCode)engine.sideContracts[side.optionType]=side;
  if(sides[0]?.scripCode)engine.option=sides[0];
  const first=sides[0]||{label:'',side:direction==='short'?'short':'buy',price:null,grid:[],orders:[],gridError:'This signal has no active side.',gridSource};
  return {...first,sides};
}
async function optionBoard(url,maxAge=15000){
  let direction=url.searchParams.get('direction')||engine.direction||'buy';
  let signalInfo=null;
  if(engine.tradeMode==='live'&&engine.status==='running'&&!(engine.signal?.spot>0)){
    return {label:'Waiting for next signal',side:direction==='short'?'short':'buy',price:null,grid:[],orders:[],gridError:'Upcoming signal has not formed yet. The new trade is placed when it does.',sides:[]};
  }
  if(engine.tradeMode==='live'&&engine.status==='running'&&engine.signal?.spot>0){
    direction=engine.direction||direction;
    signalInfo={side:engine.signal.side==='short'?'short':'buy',spot:engine.signal.spot,time:engine.signal.time,interval:engine.config.signalInterval||'15minute'};
    url.searchParams.set('spot',String(engine.signal.spot));
    url.searchParams.set('direction',direction);
  }
  const previewConfig={...engine.config};
  for(const key of ['optionMode','callOnBuy','callOnSell','putOnBuy','putOnSell']){
    const value=url.searchParams.get(key);
    if(value)previewConfig[key]=value;
  }
  if(url.searchParams.get('tradeMode')!=='live'&&!(engine.tradeMode==='live'&&engine.status==='running')){
    try{
      const market=await signalMarket();
      const session={after:0,strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd,onDay:istToday(),minutes:signalMinutes()};
      const sequence=signalSequence(market.candles||[],session).filter(item=>item?.spot>0);
      const signal=sequence.at(-1);
      if(signal?.spot>0){
        direction=signal.side;
        signalInfo={side:signal.side,spot:signal.spot,time:signal.time,interval:engine.config.signalInterval||'15minute'};
        url.searchParams.set('spot',String(signal.spot));
        url.searchParams.set('direction',direction);
      }
    }catch{}
  }
  const settings=gridSettings(url,direction);
  settings.maxAge=maxAge;
  const plan=sideActions(previewConfig,direction);
  if(Array.isArray(plan)){const planned=await boardForPlan(url,direction,settings,plan,previewConfig);if(signalInfo)planned.signalInfo=signalInfo;return planned;}
  let contract;
  if(url.searchParams.get('strike')&&url.searchParams.get('expiry')){
    const right=optionSide(url.searchParams.get('right')||'CE',direction);
    const strike=Number(url.searchParams.get('strike'));
    const name=optionUnderlying(url.searchParams.get('symbol')||engine.option?.tradingSymbol||engine.config.symbol||'NIFTY');
    const market=optionMarket(url.searchParams.get('exchange')||engine.option?.exchange||engine.config.exchange||'NF');
    contract={tradingSymbol:name,exchange:market,scripCode:url.searchParams.get('scrip')||'',expiry:url.searchParams.get('expiry'),strike,optionType:right,instrumentType:engine.option?.instrumentType||'',moneyness:url.searchParams.get('moneyness')||'',lotSize:Number(url.searchParams.get('lot'))||engine.option?.lotSize||0,spot:Number(url.searchParams.get('spot'))||null,label:`${name} ${strike} ${right}`};
  }else contract=await resolveOption({optionMoneyness:url.searchParams.get('moneyness')||engine.config.optionMoneyness,optionDepth:url.searchParams.get('depth')||engine.config.optionDepth,optionRight:url.searchParams.get('right')||engine.config.optionRight},direction,url.searchParams.get('spot'),{symbol:url.searchParams.get('symbol')||engine.config.symbol,exchange:url.searchParams.get('exchange')||engine.config.exchange,scripCode:url.searchParams.get('scripCode')||engine.config.scripCode});
  const previewOnly=engine.tradeMode==='live'&&!(engine.signal?.spot>0);
  const keepExisting=engine.tradeMode!=='live'&&engine.option?.scripCode&&engine.status!=='idle';
  const liveLocked=engine.orders().some(order=>order.brokerOrderId||order.status==='open'||order.status==='pending');
  const sameContract=engine.option?.scripCode&&String(engine.option.scripCode)===String(contract?.scripCode);
  if(contract?.scripCode&&!liveLocked&&!sameContract){engine.optionOrders=[];engine.option=contract;await save();}
  else if(!previewOnly&&!keepExisting&&contract?.scripCode&&!liveLocked&&(engine.option?.tradingSymbol!==contract.tradingSymbol||Number(engine.option?.strike)!==Number(contract.strike)||engine.option?.optionType!==contract.optionType)){engine.option=contract;await save();}
  Object.assign(settings,gridSettingsFor(url,contract?.optionType==='PE'?'PE':'CE'));
  if(Number(contract?.tickSize)>0)settings.tickSize=Number(contract.tickSize);
  const gridSource=(url.searchParams.get('gridSource')||engine.config.gridSource)==='signal'?'signal':'premium';
  if(engine.config.gridSource!==gridSource){engine.config.gridSource=gridSource;await save();}
  settings.gridSource=gridSource;
  let quote=null;
  try{quote=await optionQuote(contract);}catch(error){quote={error};}
  let board;
  try{
    if(quote?.error)throw quote.error;
    if(gridSource==='signal'){
      const found=await signalOptionAnchor(contract,direction);
      if(found.error)throw Error(found.error);
      settings.anchor=found.price;
      settings.signalTime=found.time;
    }
    board=rememberSideGrid(await withOptionGrid(contract,{...settings,quote}),settings);
  }
  catch(error){board=rememberSideGrid({...contract,side:settings.side,price:quote?.price||null,anchor:null,gridSource,signalTime:settings.signalTime||null,grid:[],gridError:error.message},settings);}
  const ordersBefore=JSON.stringify(engine.optionOrders||[]);
  if(board.grid?.length)applyGridAnchor(board);
  if(board.price)engine.markOptionPrice(board.price,board.optionType||contract?.optionType||'');
  if(JSON.stringify(engine.optionOrders||[])!==ordersBefore)await save();
  board.orders=String(engine.option?.scripCode||'')===String(contract?.scripCode||'')?engine.orders().filter(order=>!order.parked):[];
  if(signalInfo)board.signalInfo=signalInfo;
  return board;
}
async function signalOptionAnchor(contract, direction){
  let signal=null;
  if(engine.tradeMode==='live'&&engine.status==='running')signal=engine.signal?.time?engine.signal:null;
  else{
    const market=await signalMarket();
    signal=sessionSignal(market.candles||[],{direction:direction==='short'?'short':'buy',after:0,strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd,onDay:istToday(),minutes:signalMinutes()});
  }
  if(!signal?.time)return {error:engine.tradeMode==='live'&&engine.status==='running'?'Signal price waits for the next signal after the strategy starts.':'Signal price waits for today\'s confirmed signal.'};
  const history=await marketCandles({...contract,angel,interval:engine.config.signalInterval||'15minute'});
  const price=premiumAt(history.candles,signal.time);
  if(!(price>0))return {error:'The option premium at the signal time is not in the chart yet.'};
  return {price,time:signal.time};
}
function applyGridAnchor(board){
  const source=board.gridSource==='signal'?'signal':'premium';
  const slot=board.optionType||'CE';
  const key=source==='signal'?`signal:${board.scripCode||''}:${board.anchor||''}`:`premium:${board.scripCode||''}`;
  const slotOrders=()=>engine.orders().filter(order=>(order.right||'CE')===slot);
  const dead=order=>['rejected','cancelled','canceled','closed'].includes(String(order.status||'').toLowerCase());
  const active=order=>order.status==='open'||order.status==='pending'||(order.exitBrokerOrderId&&order.status!=='closed');
  const running=engine.status==='running';
  const locked=slotOrders().some(order=>active(order)||(running&&(order.brokerOrderId||dead(order))));
  if(!board.grid?.length)return;
  const install=()=>{
    try{
      const side=board.side==='short'?'short':'buy';
      const kept=engine.orders().filter(order=>(order.right||'CE')!==slot);
      const next=board.grid.map(row=>engine.draftOrder({...row,side,quantity:board.orderQuantity||engine.config.quantity,right:slot,scripCode:board.scripCode,strike:board.strike,expiry:board.expiry,tradingSymbol:board.tradingSymbol}));
      engine.optionOrders=[...kept,...next];
      engine.gridKeys={...(engine.gridKeys||{}),[slot]:key};
    }catch(error){board.gridError=error.message;}
  };
  const previous=engine.gridKeys?.[slot]||'';
  if(!running&&slotOrders().length&&slotOrders().every(dead))return install();
  if(source==='signal'&&!slotOrders().length)return install();
  if(!locked&&previous&&previous!==key)return install();
  if(locked&&previous&&previous!==key)board.gridHeld=true;
  if(!previous)engine.gridKeys={...(engine.gridKeys||{}),[slot]:key};
}
async function resolveOption(config,direction,spot,market={}){
  const exchange=market.exchange||engine.config.exchange||'NF';
  const symbol=optionUnderlying(market.symbol||engine.config.symbol||'NIFTY');
  const rows=await optionRows(exchange);
  const selection={symbol,exchange:optionMarket(exchange),spot:await underlyingSpot(spot,{...market,symbol,exchange}),moneyness:config.optionMoneyness,depth:config.optionDepth,right:optionSide(config.optionRight,direction)};
  const contract=detectOption(rows,selection);
  const depths=selection.moneyness==='ATM'?[1]:[1,2,3,4,5];
  contract.strikeChoices=depths.flatMap(depth=>{
    try{const option=detectOption(rows,{...selection,depth});return [{depth,strike:option.strike,label:`${option.strike} ${option.optionType}`}];}
    catch{return [];}
  });
  return contract;
}
const allowedOrigins=new Set(['https://strategy-dna.emotionlesstraders.com','http://strategy-dna.emotionlesstraders.com']);
function allowOrigin(req,res){
  const origin=req.headers.origin;
  if(!allowedOrigins.has(origin))return;
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
}
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
let bookCache={at:0,value:null};
async function verifyBroker(){
  const hadSession=!!broker.session;
  const status=await broker.verify();
  if(hadSession&&!broker.session){await store.clearBrokerSession();bookCache={at:0,value:null};}
  return status;
}
async function brokerBook(force=false){
  const accessToken=broker.accessToken();
  if(!accessToken){bookCache={at:0,value:null};return sharekhanBook({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:'',customerId:''});}
  if(!force&&bookCache.value&&Date.now()-bookCache.at<2000)return bookCache.value;
  const value=await sharekhanBook({apiKey:process.env.SHAREKHAN_API_KEY,accessToken,customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:broker.config.loginId||''});
  bookCache={at:Date.now(),value};
  await syncBookOrders(value);
  return value;
}
async function syncBookOrders(book){
  const orders=engine.orders();
  if(!book||!orders.some(order=>order.brokerOrderId||order.exitBrokerOrderId))return;
  const stamp=()=>`${engine.orders().length}|`+engine.orders().map(order=>`${order.id}:${order.status}:${order.brokerOrderId||''}:${order.rejectReason||''}`).join('|');
  const before=stamp();
  applyBrokerFills(orders, book.orders, (order, price, reason)=>engine.closeOptionOrder(order, price, reason), {trustedBook:!!book.connected});
  for(const order of [...engine.orders()]){
    if(order.staleCleared){
      order.staleCleared=false;
      engine.log('risk',`Level ${order.level} pending saaf kiya: Sharekhan book me iska order nahi mila`);
      if(!order.right&&!order.scripCode)engine.optionOrders=engine.optionOrders.filter(item=>item!==order);
    }
    if(order.status==='rejected'&&order.rejectReason&&!order.rejectLogged){
      order.rejectLogged=true;
      engine.log('risk',`Sharekhan rejected level ${order.level}: ${order.rejectReason}`);
    }
  }
  if(stamp()!==before)await save();
}
let liveBusy=false, liveAt=0, signalAt=0, lockFreeSince=null;
async function startStrategy(data, fresh){
  const mode=data.mode==='live'?'live':'paper';
  const tradeMode=data.tradeMode==='live'?'live':'existing';
  if(mode==='live'&&!broker.accessToken())throw Error('Connect Sharekhan before starting live trading');
  if(mode==='live'&&!angel.status().connected)throw Error('Connect Angel One before starting live trading');
  const contract=tradeMode==='live'?null:(engine.option?.scripCode?engine.option:await resolveOption(engine.config,data.direction,data.spot));
  lockFreeSince=null;signalAt=0;
  return fresh?engine.start(data.direction,mode,contract,tradeMode):engine.arm(data.direction,mode,contract,tradeMode);
}
async function refreshLiveSignal(){
  if(engine.tradeMode!=='live'||engine.status!=='running'||Date.now()-signalAt<20000)return;
  signalAt=Date.now();
  const follow=engine.config.signalLock===false;
  const active=engine.orders().some(order=>order.status==='open'||(order.status==='pending'&&order.brokerOrderId));
  if(!follow&&active){lockFreeSince=null;return;}
  if(!follow&&!lockFreeSince)lockFreeSince=engine.signal?.time?Date.now():(engine.startedAt||Date.now());
  try{
    const market=await signalMarket();
    const sequence=signalSequence(market.candles||[],{after:engine.startedAt||Date.now(),strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd,onDay:istToday(),minutes:signalMinutes()});
    const frameSec=signalMinutes()*60;
    const found=follow?sequence.at(-1):sequence.find(item=>item.time>(engine.signal?.time||0)&&(item.time+frameSec)*1000>=lockFreeSince);
    if(!found||engine.signal?.time===found.time)return;
    const side=found.side==='short'?'short':'buy';
    if(follow&&engine.signal?.time){
      const parked=engine.orders().filter(order=>order.brokerOrderId&&(order.status==='open'||order.status==='pending'));
      for(const order of parked)order.parked=true;
      engine.optionOrders=parked;
      engine.direction=side;
      engine.signal={...found,side};
      engine.option=null;
      engine.log('signal',`${String(found.side).toUpperCase()} signal ${found.spot} · unlock mode: working grid naye signal par shift ho gaya; purana trade broker par chhod diya gaya hai`);
    }else{
      if(active)return;
      engine.direction=side;
      engine.signal={...found,side};
      engine.option=null;
      engine.optionOrders=[];
      lockFreeSince=null;
      engine.log('signal',`${String(found.side).toUpperCase()} signal ${found.spot} · strike will be selected from this price`);
    }
    await save();
  }catch(error){engine.log('risk',`Live signal check failed: ${error.message}`);}
}
function contractFor(order){
  const right=String(order?.right||'').toUpperCase();
  return (right&&engine.sideContracts?.[right])||engine.option;
}
async function liveContract(contract){
  if(!contract?.scripCode)return contract;
  try{
    const rows=await optionRows(contract.exchange||engine.config.exchange||'NF');
    return alignOrderContract(contract, rows);
  }catch{return contract;}
}
async function sendLive(contract, order){
  try{
    return await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken(),customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:sharekhanLoginId(),contract:await liveContract(contract),order,productType:engine.config.productType});
  }finally{bookCache={at:0,value:null};}
}
function rememberBrokerOrder(order, sent){
  if(sent?.body?.scripCode)order.brokerOrder=sent.body;
}
function cancelSnapshot(order, listed, contract){
  const scrip=listed?.scripCode||contract?.scripCode;
  if(!scrip)return null;
  const quantity=Number(listed?.quantity);
  return {
    customerId:Number(broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID),
    scripCode:Number(scrip),
    tradingSymbol:listed?.tradingSymbol||contract?.tradingSymbol||'NIFTY',
    exchange:listed?.exchange||contract?.exchange||'NF',
    transactionType:order?.side==='short'?'S':'B',
    quantity:Number.isInteger(quantity)&&quantity>0?quantity:Number(order?.brokerQty)||0,
    disclosedQty:0,
    executedQty:0,
    price:String(listed?.price||order?.entry||''),
    triggerPrice:'0',
    rmsCode:listed?.rmsCode||'ANY',
    afterHour:'N',
    orderType:'NORMAL',
    channelUser:sharekhanLoginId(),
    validity:'GFD',
    requestType:'NEW',
    productType:listed?.product&&listed.product!=='—'?listed.product:(engine.config.productType||'INVESTMENT'),
    instrumentType:listed?.instrumentType||contract?.instrumentType||'OS',
    strikePrice:String(listed?.strike||contract?.strike||''),
    optionType:listed?.optionType||contract?.optionType||'',
    expiry:listed?.expiry||contract?.expiry||''
  };
}
async function listedContract(listed, contract){
  if(!listed)return contract;
  if(listed.scripCode)return {...contract, ...listed, scripCode:listed.scripCode};
  if(!(listed.strike>0)||!listed.optionType)return contract;
  try{
    const rows=await optionRows(listed.exchange||contract?.exchange||engine.config.exchange||'NF');
    const name=String(listed.tradingSymbol||contract?.tradingSymbol||'').toUpperCase();
    const match=rows.find(row=>String(row.tradingSymbol).toUpperCase()===name&&Number(row.strike)===Number(listed.strike)&&row.optionType===listed.optionType&&(!listed.expiry||row.expiry===listed.expiry));
    if(match?.scripCode)return {...contract, tradingSymbol:match.tradingSymbol, exchange:listed.exchange||contract?.exchange, scripCode:String(match.scripCode), expiry:match.expiry, strike:Number(match.strike), optionType:match.optionType, instrumentType:match.instType||listed.instrumentType, lotSize:match.lotSize||contract?.lotSize};
  }catch{return contract;}
  return contract;
}
async function cancelLiveOrder(order){
  if(!order?.brokerOrderId)return;
  if(!order.brokerOrder?.scripCode){
    let listed=null;
    try{
      const book=await brokerBook();
      listed=(book.orders||[]).find(row=>String(row.orderId)===String(order.brokerOrderId))||null;
    }catch{listed=null;}
    const contract=await listedContract(listed, contractFor(order));
    const snap=cancelSnapshot(order, listed, contract);
    if(snap?.scripCode)order.brokerOrder=snap;
  }
  await sendLive(contractFor(order), order);
}
function seedLiveGrid(board){
  const sides=board?.sides?.length?board.sides:[board];
  for(const side of sides){
    const right=side?.optionType||'CE';
    if(engine.orders().some(order=>(order.right||'CE')===right&&!order.parked)||!side?.grid?.length)continue;
    const rows=side.grid.filter(row=>row.entry>0&&row.target>0&&row.stop>0);
    if(!rows.length)continue;
    const made=rows.map(row=>engine.draftOrder({...row,side:side.side==='short'?'short':'buy',quantity:side.orderQuantity||engine.config.quantity,right,scripCode:side.scripCode,strike:side.strike,expiry:side.expiry,tradingSymbol:side.tradingSymbol,lotSize:side.lotSize}));
    engine.optionOrders=[...engine.orders(),...made];
  }
}
async function executeLiveGrid(board){
  if(engine.mode!=='live'||engine.status!=='running'||!engine.inSession()||liveBusy||Date.now()-liveAt<1000)return;
  if(engine.tradeMode==='live'&&!(engine.signal?.spot>0))return;
  if(!broker.accessToken())return;
  const sides=board?.sides?.length?board.sides:[board];
  if(!sides.some(side=>side?.price>0))return;
  liveBusy=true; liveAt=Date.now();
  try{
    seedLiveGrid(board);
    const book=await brokerBook();
    applyBrokerFills(engine.orders(), book.orders||[], (order, price, reason)=>engine.closeOptionOrder(order, price, reason), {trustedBook:!!book.connected});
    for(const order of engine.orders()){
      if(order.status==='rejected'&&order.rejectReason&&!order.rejectLogged){
        order.rejectLogged=true;
        engine.log('risk',`Sharekhan rejected level ${order.level}: ${order.rejectReason}`);
      }
    }
    const capReason=(()=>{
      const prices={};
      for(const side of sides)if(side?.price>0)prices[side.optionType||'CE']=side.price;
      if(!Object.keys(prices).length&&!(engine.realized!==0))return '';
      const total=Object.keys(prices).length?engine.optionPnl(prices):engine.realized;
      const maxLoss=Number(engine.config.maxLoss)||0, maxProfit=Number(engine.config.maxProfit)||0;
      if(maxLoss>0&&total<=-maxLoss)return 'Maximum loss';
      if(maxProfit>0&&total>=maxProfit)return 'Maximum profit';
      return '';
    })();
    if(capReason){
      for(const side of sides){
        if(!(side?.price>0))continue;
        const right=side.optionType||'CE';
        const contract=engine.sideContracts?.[right]||side;
        for(const order of engine.orders().filter(item=>(item.right||'CE')===right)){
          try{
            if(order.status==='pending'&&order.brokerOrderId&&!order.exitBrokerOrderId){await cancelLiveOrder(order);order.brokerOrderId='';}
            else if(order.status==='open'&&!order.exitBrokerOrderId){
              const exitOrder={side:order.side==='short'?'buy':'short',entry:side.price,quantity:order.quantity};
              const sent=await sendLive(contract,exitOrder);
              order.exitBrokerOrderId=sent.orderId; order.exitReason=capReason;
            }
          }catch(error){engine.log('risk',`Daily cap exit for level ${order.level} failed: ${error.message}`);}
        }
      }
      engine.status='killed'; engine.haltReason=capReason; engine.pending=null;
      engine.log('risk',`${capReason} limit reached on live option trades; positions exit bhej diye gaye hain`);
      await save();
      return;
    }
    for(const side of sides){
      if(!(side?.price>0))continue;
      const right=side.optionType||'CE';
      const orders=engine.orders().filter(order=>(order.right||'CE')===right);
      const sideName=orders[0]?.side||side.side||'buy';
      const contract=engine.sideContracts?.[right]||side;
      trailOpenStops(orders, side.price, {side:sideName, trailStartLeg:side.trailStartLeg||engine.config.trailStartLeg, trailStep:side.trailStep||engine.config.trailStep, tick:side.tickSize||engine.config.tickSize});
      for(const intent of liveIntents(orders, side.price, sideName)){
        const order=orders.find(item=>item.level===intent.level);
        if(!order)continue;
        try{
          if(intent.type==='entry'){
            engine.optionOrder({action:'place', level:order.level, right, live:true});
            const sent=await sendLive(contract, order);
            order.brokerOrderId=sent.orderId;
            if(Number(contract?.lotSize)>0)order.lotSize=Number(contract.lotSize);
            order.brokerPlacedAt=Date.now();
            rememberBrokerOrder(order, sent);
            engine.log('order',`Live entry ${right} level ${order.level} at ${order.entry} · ${sent.orderId}`);
          }else{
            const exitOrder={side:order.side==='short'?'buy':'short', entry:intent.price, quantity:order.quantity};
            const sent=await sendLive(contract, exitOrder);
            order.exitBrokerOrderId=sent.orderId;
            order.exitReason=intent.reason;
            engine.log('order',`Live ${intent.reason} ${right} level ${order.level} at ${intent.price} · ${sent.orderId}`);
          }
        }catch(error){
          if(intent.type==='entry'&&order.status==='pending'&&!order.brokerOrderId)order.status='draft';
          order.liveHoldUntil=Date.now()+15000;
          engine.log('risk',`Live level ${order.level} was not sent: ${error.message}`);
        }
      }
    }
    await save();
  }finally{liveBusy=false;}
}
async function squareLivePositions(){
  if(engine.mode!=='live'||!broker.accessToken()||!engine.option?.scripCode)return;
  for(const order of [...engine.orders()]){
    try{
      if(order.status==='pending'&&order.brokerOrderId&&!order.exitBrokerOrderId){
        await cancelLiveOrder(order);
        order.brokerOrderId='';
      }else if(order.status==='open'&&!order.exitBrokerOrderId&&engine.optionPrice>0){
        const exitOrder={side:order.side==='short'?'buy':'short', entry:engine.optionPrice, quantity:order.quantity};
        const sent=await sendLive(contractFor(order), exitOrder);
        order.exitBrokerOrderId=sent.orderId;
      }
    }catch(error){engine.log('risk',`Kill could not close level ${order.level}: ${error.message}`);}
  }
}
async function liveOptionOrder(data){
  if(data.action==='unplace'){
    const right=String(data.right||'').toUpperCase();
    const existing=engine.orders().find(item=>(item.id===Number(data.id)||item.level===Number(data.level))&&(!right||(item.right||'CE')===right));
    if(existing?.brokerOrderId){
      await cancelLiveOrder(existing);
      existing.brokerOrderId='';
      existing.routing='paper';
    }
    return engine.optionOrder(data);
  }
  if(data.action!=='place')return engine.optionOrder(data);
  const accessToken=broker.accessToken();
  const customerId=broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID;
  const loginId=sharekhanLoginId();
  if(!accessToken||!customerId)throw Error('Connect Sharekhan before placing a live order');
  const right=String(data.right||'').toUpperCase();
  const contract=engine.sideContracts?.[right]||engine.option;
  if(!contract?.scripCode)throw Error('Detected option has no scrip code yet');
  try{await angel.quote(contract);}catch{/* Angel quote sirf price warm-up hai; Sharekhan order ke liye zaroori nahi */}
  const scoped=item=>(!right||(item.right||'CE')===right);
  const before=engine.orders().find(item=>(item.id===Number(data.id)||item.level===Number(data.level))&&scoped(item));
  const wasOpen=before?.status==='open';
  const previousStatus=before?.status||'draft';
  const previousFilled=before?.filled??null;
  engine.optionOrder({...data,live:true});
  const order=engine.orders().find(item=>item.level===Number(data.level)&&scoped(item))||engine.orders().find(item=>item.id===Number(data.id)&&scoped(item));
  if(data.transactionType)order.transactionType=String(data.transactionType).toUpperCase();
  try{
    const sent=await sendLive(contract, order);
    order.brokerOrderId=sent.orderId;
    if(Number(contract?.lotSize)>0)order.lotSize=Number(contract.lotSize);
    order.brokerPlacedAt=Date.now();
    order.brokerQty=sent.quantity;
    rememberBrokerOrder(order, sent);
    engine.log('order',`Sharekhan order ${sent.orderId} · level ${order.level} · qty ${sent.quantity}`);
    return engine.snapshot();
  }catch(error){
    order.routing='paper';
    order.brokerOrderId='';
    if(wasOpen){order.status='open';order.filled=previousFilled;}
    else order.status=previousStatus==='pending'?'pending':'draft';
    engine.log('risk',`Sharekhan rejected level ${order.level}: ${error.message}`);
    throw error;
  }
}
function sharekhanLoginId(){return broker.config.loginId||broker.session?.loginId||broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID||'';}
function writeSharekhanEnv(config){
  const file=path.join(root,'.env');
  const keys={SHAREKHAN_API_KEY:config.apiKey||'',SHAREKHAN_SECURE_KEY:config.secureKey||'',SHAREKHAN_CUSTOMER_ID:config.customerId||'',SHAREKHAN_LOGIN_ID:config.loginId||'',SHAREKHAN_VENDOR_KEY:config.vendorKey||'',SHAREKHAN_VERSION_ID:config.versionId||''};
  const lines=fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/):[];
  const seen=new Set();
  const next=lines.map(line=>{const match=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);if(!match||!(match[1] in keys))return line;seen.add(match[1]);return `${match[1]}=${keys[match[1]]}`;}).filter((line,index,all)=>line!==''||index<all.length-1);
  for(const [key,value] of Object.entries(keys))if(!seen.has(key))next.push(`${key}=${value}`);
  fs.writeFileSync(file,`${next.join('\n').replace(/\n*$/,'')}\n`);
  for(const [key,value] of Object.entries(keys))process.env[key]=value;
}
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw Error('Request too large');}return raw?JSON.parse(raw):{};}
const server=http.createServer(async(req,res)=>{
  try {
    allowOrigin(req,res);
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const url=new URL(req.url,`http://${req.headers.host}`);
    if(req.method==='POST'&&url.pathname==='/api/login'){
      const data=await body(req);
      const token=login(data.username||data.id, data.password);
      if(!token)return reply(res,401,{error:'Invalid ID or password'});
      return reply(res,200,{ok:true,username:verifyToken(token).u,token});
    }
    if(!verifyToken(tokenFrom(req,url)))return reply(res,401,{error:'Login required'});
    if(req.method==='GET'&&url.pathname==='/api/session')return reply(res,200,{ok:true,username:verifyToken(tokenFrom(req,url)).u});
    if(req.method==='GET'&&url.pathname==='/api/state')return reply(res,200,engine.snapshot());
    if(req.method==='GET'&&url.pathname==='/api/instruments/meta')return reply(res,200,instrumentMeta());
    if(req.method==='GET'&&url.pathname==='/api/instruments')return reply(res,200,await searchInstruments(url.searchParams.get('exchange'),url.searchParams.get('q')));
    if(req.method==='GET'&&url.pathname==='/api/market'){const exchange=url.searchParams.get('exchange')||engine.config.exchange;const scripCode=url.searchParams.get('scripCode')||engine.config.scripCode;const interval=url.searchParams.get('interval')||'15minute';const contract=String(engine.option?.scripCode)===String(scripCode)?engine.option:{};return reply(res,200,await marketCandles({...contract,exchange,scripCode,interval,symbol:url.searchParams.get('symbol')||contract.tradingSymbol||engine.config.symbol,angel}));}
    if(req.method==='GET'&&url.pathname==='/api/option')return reply(res,200,await optionBoard(url));
    if(req.method==='GET'&&url.pathname==='/api/angel/status')return reply(res,200,angel.status());
    if(req.method==='GET'&&url.pathname==='/api/sharekhan/status')return reply(res,200,await verifyBroker());
    if(req.method==='GET'&&url.pathname==='/api/sharekhan/book')return reply(res,200,await brokerBook(url.searchParams.get('fresh')==='1'));
    if(req.method==='POST'&&url.pathname.startsWith('/api/')){
      const data=await body(req); let result;
      switch(url.pathname){
        case '/api/angel/login':result=await angel.login();break;
        case '/api/angel/logout':result=angel.logout();break;
        case '/api/sharekhan/start':result=broker.start();break;
        case '/api/sharekhan/complete':
          result=await broker.complete(data);
          if(broker.session)await store.saveBrokerSession(broker.session);
          else await store.clearBrokerSession();
          bookCache={at:0,value:null};
          break;
        case '/api/sharekhan/logout':result=broker.logout();await store.clearBrokerSession();bookCache={at:0,value:null};break;
        case '/api/sharekhan/credentials':result=broker.updateCredentials(data);await store.saveSharekhanCredentials(broker.config);writeSharekhanEnv(broker.config);await store.clearBrokerSession();bookCache={at:0,value:null};break;
        case '/api/config': result=engine.configure(await assertInstrument(data));break;
        case '/api/signal-lock': engine.config.signalLock=data.locked!==false; engine.log('settings',engine.config.signalLock?'Signal lock ON: chal raha trade hi chalega':'Signal lock OFF: naya signal aate hi grid shift hoga'); result=engine.snapshot(); break;
        case '/api/arm': result=await startStrategy(data,false);break;
        case '/api/start': result=await startStrategy(data,true);break;
        case '/api/stop': result=engine.stop();break;
        case '/api/option-order': result=await liveOptionOrder(data);break;
        case '/api/pause':result=engine.pause();break;
        case '/api/resume':result=engine.resume();break;
        case '/api/kill':await squareLivePositions();result=engine.kill();break;
        case '/api/new-day':result=engine.newDay();break;
        case '/api/activity/clear':result=engine.clearActivity();break;
        case '/api/candle':result=engine.candle(data);break;
        case '/api/tick':result=engine.tick(data.price);break;
        default:return reply(res,404,{error:'Unknown action'});
      }
      if(!url.pathname.startsWith('/api/sharekhan/')&&!url.pathname.startsWith('/api/angel/'))await save();
      return reply(res,200,result);
    }
    reply(res,404,{error:'Not found'});
  }catch(e){reply(res,400,{error:e.message});}
});
function applySharekhanProcessEnv(config){
  process.env.SHAREKHAN_API_KEY=config.apiKey||'';
  process.env.SHAREKHAN_SECURE_KEY=config.secureKey||'';
  process.env.SHAREKHAN_CUSTOMER_ID=config.customerId||'';
  process.env.SHAREKHAN_LOGIN_ID=config.loginId||'';
  process.env.SHAREKHAN_VENDOR_KEY=config.vendorKey||'';
  process.env.SHAREKHAN_VERSION_ID=config.versionId||'';
}
async function start(){
  await store.connect();
  try {
    const saved=await store.loadSharekhanCredentials();
    if(saved?.apiKey&&saved?.secureKey){broker.useSavedCredentials(saved);applySharekhanProcessEnv(broker.config);}
    else if(broker.config.apiKey&&broker.config.secureKey)await store.saveSharekhanCredentials(broker.config);
  }catch(error){console.warn('Sharekhan credentials stayed on the saved server configuration');}
  try {
    const session=await store.loadBrokerSession();
    if(session){
      await broker.restoreSession(session);
      if(!broker.session)await store.clearBrokerSession();
    }
  }catch(error){broker.lastError=error.message;console.warn('Sharekhan session restore requires a new login');}
  let snapshot=await store.load();
  if(!snapshot&&fs.existsSync(stateFile)){
    snapshot=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    console.log('Imported backend/data/state.json into MongoDB');
  }
  restore(snapshot);
  await save();
  server.listen(port,host,()=>{
    console.log(`Grid API: http://${host}:${port} · MongoDB ${store.dbName}`);
    warmInstrumentCache();
    let boardCache=null,boardAt=0;
    attachLive(server,{intervalMs:1000,idleIntervalMs:()=>angel.feed?.healthy()?1000:10000,authorize:token=>!!verifyToken(token),shouldTick:()=>engine.status==='running'&&(engine.mode==='live'||engine.tradeMode==='live'),nextTick:async()=>{
      const url=new URL('http://127.0.0.1/api/option');
      url.searchParams.set('moneyness',engine.config.optionMoneyness||'ATM');
      url.searchParams.set('depth',String(engine.config.optionDepth||1));
      url.searchParams.set('right',engine.config.optionRight||'AUTO');
      const chartLtp=engine.config.scripCode?(await angel.quote({exchange:engine.config.exchange||'NC',scripCode:engine.config.scripCode,symbol:engine.config.symbol||'NIFTY'})).price:null;
      const optionLtp=engine.option?.scripCode?(await angel.quote(engine.option)).price:null;
      if(!boardCache||Date.now()-boardAt>10000||!optionLtp){
        await refreshLiveSignal();
        url.searchParams.set('direction',engine.direction||'buy');
        if(engine.tradeMode==='live'&&engine.signal?.spot>0)url.searchParams.set('spot',String(engine.signal.spot));
        else if(engine.tradeMode!=='live'&&engine.option?.strike&&engine.option?.expiry){url.searchParams.set('strike',engine.option.strike);url.searchParams.set('expiry',engine.option.expiry);url.searchParams.set('right',engine.option.optionType);url.searchParams.set('scrip',engine.option.scripCode||'');url.searchParams.set('symbol',engine.option.tradingSymbol||engine.config.symbol||'');url.searchParams.set('exchange',engine.option.exchange||engine.config.exchange||'');}
        boardCache=await optionBoard(url,10000);
        boardAt=Date.now();
      }
      const board=boardCache;
      const price=optionLtp||board.price;
      const sideList=board?.sides?.length?board.sides:[];
      const prices={};
      for(const side of sideList){
        if(!side?.scripCode)continue;
        try{prices[side.optionType||'CE']=(await angel.quote(side)).price;}catch{if(side.price>0)prices[side.optionType||'CE']=side.price;}
      }
      if(engine.option?.optionType&&optionLtp&&prices[engine.option.optionType]==null)prices[engine.option.optionType]=optionLtp;
      const liveBoard=sideList.length?{...board,price,sides:sideList.map(side=>({...side,price:prices[side.optionType||'CE']||side.price}))}:{...board,price};
      const run={status:engine.status,tradeMode:engine.tradeMode,direction:engine.direction,signal:engine.signal||null};
      if(engine.mode==='live')await executeLiveGrid(liveBoard);
      if(!price && !chartLtp && !Object.keys(prices).length)return {error:board?.gridError||'Waiting for the option price',run};
      const orders=sideList.length?sideList.flatMap(side=>(side.orders||[]).map(order=>({...order,right:order.right||side.optionType}))):(board.orders||[]);
      return {nifty:chartLtp||board.nifty,price,prices,right:engine.option?.optionType||board.optionType||'',bid:board.bid,ask:board.ask,label:board.label,side:board.side,run,orders:orders.map(order=>({level:order.level,right:order.right||'',status:order.status,entry:order.entry,stop:order.stop}))};
    }});
  });
}
start().catch(error=>{
  const secret=process.env.MONGODB_URI||'';
  console.error('Startup failed:',String(error.message||error).split(secret).join('[redacted]'));
  process.exit(1);
});
