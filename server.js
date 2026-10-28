import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Strategy, defaults, latestSignal, sessionSignal, signalSequence, upcomingSignal} from './engine.js';
import {SharekhanAuth} from './sharekhan-auth.js';
import {StrategyStore} from './store.js';
import {assertInstrument,instrumentMeta,optionMarket,optionRows,searchInstruments,warmInstrumentCache} from './instruments.js';
import {marketCandles, setEmaPeriods} from './market.js';
import {detectOption,optionSide,optionUnderlying,premiumAt,selectUnderlying,sideActions,sideGridField,sideGridKeys,withOptionGrid} from './options.js';
import {attachLive} from './live.js';
import {AngelData} from './angel.js';
import {login, tokenFrom, verifyToken} from './auth.js';
import {sharekhanBook} from './sharekhan-book.js';
import {alignOrderContract, submitLiveOrder} from './sharekhan-orders.js';
import {applyBrokerFills, liveIntents, manualBrokerExits, trailOpenStops} from './live-grid.js';
import {advancePaperGrid, seedGridOrders} from './paper-grid.js';

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
  setEmaPeriods(engine.config.emaOpenPeriod, engine.config.emaClosePeriod);
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
      const held=await heldSide(right,gridSource);
      if(held){display.push(held);continue;}
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
    const heldOrders=activeOrdersFor(item.right);
    const kept=heldOrders.length?contractFor(heldOrders[0]):engine.status==='running'&&engine.tradeMode!=='live'?(engine.sideContracts?.[item.right]||(engine.option?.optionType===item.right?engine.option:null)):null;
    try{contract=kept?.scripCode?kept:await resolveOption({...selection,optionRight:item.right},direction,strikeSpot,market);}
    catch(error){sides.push({optionType:item.right,side:item.side,label:'',grid:[],gridError:error.message,orders:[],gridSource});continue;}
    const own=gridSettingsFor(url,item.right);
    const sideSettings={...settings,...own,side:item.side};
    if(Number(contract.tickSize)>0)sideSettings.tickSize=Number(contract.tickSize);
    let quote=null;
    try{quote=await optionQuote(contract);}catch(error){quote={error};}
    let board;
    const signalRef=currentSignalRef(settings);
    const manual=manualAnchorFor(item.right,signalRef?.time);
    try{
      if(quote?.error)throw quote.error;
      if(manual){sideSettings.anchor=manual;sideSettings.anchorSource='manual';}
      else if(gridSource==='signal'){
        const found=await signalOptionAnchor(contract,direction,settings.previewSignal);
        if(found.error)throw Error(found.error);
        sideSettings.anchor=found.price;sideSettings.signalTime=found.time;sideSettings.anchorSource='signal';
      }
      board=await withOptionGrid(contract,{...sideSettings,quote});
    }catch(error){board={...contract,side:item.side,price:quote?.price||null,anchor:null,gridSource,signalTime:null,grid:[],gridError:error.message};}
    board.side=item.side;
    board.anchorSource=sideSettings.anchorSource||'premium';
    board.anchorSignalTime=signalRef?.time||null;
    rememberSideGrid(board,sideSettings);
    if(board.grid?.length)applyGridAnchor(board);
    board.orders=engine.orders().filter(order=>!order.parked&&(order.right||'CE')===item.right&&(!order.scripCode||!board.scripCode||String(order.scripCode)===String(board.scripCode)));
    sides.push(board);
  }
  for(const right of ['CE','PE']){
    if(plan.some(item=>item.right===right))continue;
    const held=await heldSide(right,gridSource);
    if(held)sides.push(held);
  }
  engine.sideContracts={};
  for(const side of sides)if(side.scripCode)engine.sideContracts[side.optionType]=side;
  if(sides[0]?.scripCode)engine.option=sides[0];
  const first=sides[0]||{label:'',side:direction==='short'?'short':'buy',price:null,grid:[],orders:[],gridError:'This signal has no active side.',gridSource};
  return {...first,sides};
}
async function optionBoard(url,maxAge=15000){
  let direction=url.searchParams.get('direction')||engine.direction||'buy';
  let signalInfo=null,previewSignal=null;
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
  const heldCurrent=engine.status==='running'&&engine.tradeMode==='existing'&&engine.config.signalLock!==false&&engine.signal?.time&&engine.signal?.spot>0;
  if(heldCurrent){
    direction=engine.signal.side==='short'?'short':'buy';
    previewSignal=engine.signal;
    signalInfo={side:direction,spot:engine.signal.spot,time:engine.signal.time,interval:engine.config.signalInterval||'15minute'};
    url.searchParams.set('spot',String(engine.signal.spot));
    url.searchParams.set('direction',direction);
  }
  if(!heldCurrent&&url.searchParams.get('tradeMode')!=='live'&&!(engine.tradeMode==='live'&&engine.status==='running')){
    try{
      const market=await signalMarket();
      const session={after:0,strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd,onDay:istToday(),minutes:signalMinutes()};
      const sequence=signalSequence(market.candles||[],session).filter(item=>item?.spot>0);
      const signal=sequence.at(-1);
      if(signal?.spot>0){
        previewSignal=signal;
        direction=signal.side;
        signalInfo={side:signal.side,spot:signal.spot,time:signal.time,interval:engine.config.signalInterval||'15minute'};
        url.searchParams.set('spot',String(signal.spot));
        url.searchParams.set('direction',direction);
      }
    }catch{}
  }
  const settings=gridSettings(url,direction);
  settings.maxAge=maxAge;
  settings.previewSignal=previewSignal;
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
  const signalRef=currentSignalRef(settings);
  const manual=manualAnchorFor(contract?.optionType==='PE'?'PE':'CE',signalRef?.time);
  try{
    if(quote?.error)throw quote.error;
    if(manual){settings.anchor=manual;settings.anchorSource='manual';}
    else if(gridSource==='signal'){
      const found=await signalOptionAnchor(contract,direction,settings.previewSignal);
      if(found.error)throw Error(found.error);
      settings.anchor=found.price;
      settings.signalTime=found.time;
      settings.anchorSource='signal';
    }
    board=rememberSideGrid(await withOptionGrid(contract,{...settings,quote}),settings);
  }
  catch(error){board=rememberSideGrid({...contract,side:settings.side,price:quote?.price||null,anchor:null,gridSource,signalTime:settings.signalTime||null,grid:[],gridError:error.message},settings);}
  board.anchorSource=settings.anchorSource||'premium';
  board.anchorSignalTime=signalRef?.time||null;
  const ordersBefore=JSON.stringify(engine.optionOrders||[]);
  if(board.grid?.length)applyGridAnchor(board);
  if(board.price)engine.markOptionPrice(board.price,board.optionType||contract?.optionType||'');
  if(JSON.stringify(engine.optionOrders||[])!==ordersBefore)await save();
  board.orders=String(engine.option?.scripCode||'')===String(contract?.scripCode||'')?engine.orders().filter(order=>!order.parked):[];
  if(signalInfo)board.signalInfo=signalInfo;
  return board;
}
async function signalOptionAnchor(contract, direction, given=null){
  let signal=null;
  if(engine.tradeMode==='live'&&engine.status==='running')signal=engine.signal?.time?engine.signal:null;
  else if(given?.time)signal=given;
  else{
    const market=await signalMarket();
    signal=sessionSignal(market.candles||[],{direction:direction==='short'?'short':'buy',after:0,strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd,onDay:istToday(),minutes:signalMinutes()});
  }
  if(!signal?.time)return {error:engine.tradeMode==='live'&&engine.status==='running'?'Signal price waits for the next signal after the strategy starts.':'Signal price waits for today\'s confirmed signal.'};
  let minute=Number(signal.time);
  try{
    const spot=await marketCandles({exchange:engine.config.exchange||'NC',scripCode:engine.config.scripCode||'20000',symbol:engine.config.symbol||'NIFTY',angel,interval:'1minute'});
    const end=minute+signalMinutes()*60;
    const level=Number(signal.spot);
    const hit=(spot.candles||[]).find(candle=>candle.time>=minute&&candle.time<end&&(signal.side==='short'?candle.low<level:candle.high>level));
    if(hit)minute=hit.time;
  }catch{}
  const history=await marketCandles({...contract,symbol:contract?.tradingSymbol||contract?.symbol||'',angel,interval:'1minute'});
  const exact=(history.candles||[]).find(candle=>candle.time===minute);
  const price=exact?.close>0?Number(exact.close):premiumAt(history.candles,minute);
  if(!(price>0))return {error:'The option premium at the signal time is not in the chart yet.'};
  return {price,time:minute};
}
function setGridAnchor(data={}){
  const right=String(data.right||'CE').toUpperCase()==='PE'?'PE':'CE';
  const busy=engine.orders().some(order=>(order.right||'CE')===right&&(order.status==='open'||order.status==='pending'||order.exitBrokerOrderId));
  if(busy)throw Error(`${right} grid already has a placed order. Unplace or close it before changing the entry price.`);
  const clear=data.price===''||data.price==null;
  const price=clear?null:Math.round(Number(data.price)*100)/100;
  if(!clear&&!(price>0))throw Error('Entry price must be greater than 0');
  const signalTime=engine.tradeMode==='live'&&engine.status==='running'?(engine.signal?.time||null):(Number(data.signalTime)||null);
  if(engine.tradeMode==='live'&&engine.status==='running'&&!signalTime)throw Error('Wait for the next signal before setting the entry price');
  const anchors={...(engine.manualAnchors||{})};
  if(clear)delete anchors[right];
  else anchors[right]={price,signalTime};
  engine.manualAnchors=anchors;
  engine.optionOrders=engine.orders().filter(order=>(order.right||'CE')!==right);
  engine.gridKeys={...(engine.gridKeys||{}),[right]:''};
  boardDirty=true;
  engine.log('order',clear?`${right} grid entry is automatic again`:`${right} grid entry set manually to ${price}; all levels follow it`);
  return engine.snapshot();
}
function currentSignalRef(settings){
  if(engine.status==='running'){
    if(engine.tradeMode==='live')return engine.signal?.time?engine.signal:null;
    if(engine.config.signalLock!==false&&engine.signal?.time)return engine.signal;
  }
  return settings?.previewSignal||null;
}
function manualAnchorFor(right,signalTime){
  const manual=engine.manualAnchors?.[right];
  if(!(Number(manual?.price)>0))return null;
  if((Number(manual.signalTime)||null)!==(Number(signalTime)||null))return null;
  return Number(manual.price);
}
function applyGridAnchor(board){
  const source=board.gridSource==='signal'?'signal':'premium';
  const slot=board.optionType||'CE';
  const key=board.anchorSource==='manual'?`manual:${board.scripCode||''}:${board.anchor||''}`:source==='signal'?`signal:${board.scripCode||''}:${board.anchor||''}`:`premium:${board.scripCode||''}`;
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
      const next=board.grid.map(row=>engine.draftOrder({...row,side,quantity:board.orderQuantity||engine.config.quantity,right:slot,scripCode:board.scripCode,strike:board.strike,expiry:board.expiry,tradingSymbol:board.tradingSymbol,lotSize:board.lotSize}));
      engine.optionOrders=[...kept,...next];
      engine.gridKeys={...(engine.gridKeys||{}),[slot]:key};
    }catch(error){board.gridError=error.message;}
  };
  const previous=engine.gridKeys?.[slot]||'';
  const idle=!running&&!slotOrders().some(active);
  if(idle&&slotOrders().some(dead))return install();
  const firstLevel=slotOrders().find(order=>order.level===1);
  if(idle&&(source==='signal'||board.anchorSource==='manual')&&firstLevel&&Number(firstLevel.entry)!==Number(board.grid[0]?.entry))return install();
  if(!slotOrders().length)return install();
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
let publicIpCache={at:0,ip:''};
async function serverPublicIp(){
  const fixed=String(process.env.SERVER_PUBLIC_IP||'').trim();
  if(fixed)return {ip:fixed,source:'configured'};
  if(publicIpCache.ip&&Date.now()-publicIpCache.at<3600000)return {ip:publicIpCache.ip,source:'detected'};
  for(const source of ['https://api.ipify.org','https://ifconfig.me/ip','https://icanhazip.com']){
    try{
      const text=(await (await fetch(source,{signal:AbortSignal.timeout(5000)})).text()).trim();
      if(/^\d{1,3}(\.\d{1,3}){3}$/.test(text)){publicIpCache={at:Date.now(),ip:text};return {ip:text,source:'detected'};}
    }catch{}
  }
  return {ip:publicIpCache.ip||'',source:publicIpCache.ip?'detected':'unavailable'};
}
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
  await pricePositions(value);
  bookCache={at:Date.now(),value};
  await syncBookOrders(value);
  return value;
}
function paperOrderLabel(order){
  const name=order.tradingSymbol||engine.option?.tradingSymbol||engine.config.symbol||'OPTION';
  const strike=order.strike||engine.sideContracts?.[order.right||'CE']?.strike||engine.option?.strike||'';
  const right=order.right||engine.option?.optionType||'CE';
  return `${name} ${strike} ${right} · L${order.level}`.trim();
}
async function paperBook(){
  try{
    const rows=(engine.orders()||[]).filter(order=>!order.parked&&order.routing!=='live');
    const prices={};
    if(engine.optionPrice>0&&engine.option?.optionType)prices[engine.option.optionType]=engine.optionPrice;
    for(const order of rows.filter(item=>item.status==='open')){
      const right=order.right||'CE';
      if(prices[right]>0)continue;
      try{
        const contract=contractFor(order);
        if(!contract?.scripCode)continue;
        const quote=await angel.quote(contract);
        if(quote?.price>0)prices[right]=quote.price;
      }catch{}
    }
    const orders=rows.filter(order=>order.status!=='draft').map(order=>{
      const lot=Number(engine.lotOf(order))||1;
      const qty=Number(order.quantity)||0;
      const units=qty*lot;
      const done=order.status==='open'||order.status==='closed'?units:0;
      const price=order.status==='closed'?(order.exit??order.filled):order.status==='open'?(order.filled??order.entry):order.entry;
      return {
        orderId:`P${order.id}`,
        symbol:paperOrderLabel(order),
        side:order.side==='short'?'SELL':'BUY',
        quantity:String(units),
        filled:String(done),
        price:Number(price)>0?Number(price):null,
        status:String(order.status||'').toUpperCase(),
        reason:order.reason||order.exitReason||(order.status==='pending'?'Waiting for entry':''),
        product:'PAPER',
        level:order.level,
        right:order.right||'',
        id:order.id
      };
    }).reverse();
    const positions=rows.filter(order=>order.status==='open'&&order.filled>0).map(order=>{
      const lot=Number(engine.lotOf(order))||1;
      const qty=Number(order.quantity)||0;
      const units=qty*lot;
      const ltp=prices[order.right||'CE']||null;
      const pnl=ltp>0?((order.side==='buy'?ltp-order.filled:order.filled-ltp)*units):null;
      return {
        symbol:paperOrderLabel(order),
        side:order.side==='short'?'SELL':'BUY',
        quantity:String(units),
        net:order.side==='short'?-units:units,
        avg:order.filled,
        ltp:ltp>0?ltp:null,
        pnl:pnl==null?null:Math.round(pnl*100)/100,
        product:'PAPER',
        scripCode:order.scripCode||'',
        level:order.level,
        right:order.right||'',
        id:order.id,
        paper:true
      };
    });
    return {connected:true,mode:'paper',orders,positions,profile:{},funds:null};
  }catch(error){
    return {connected:true,mode:'paper',orders:[],positions:[],profile:{},funds:null,error:error.message||'Paper book failed'};
  }
}
function positionContract(position){
  const option=position?.option;
  if(!option)return null;
  return {exchange:position.exchange||'NF',tradingSymbol:option.underlying,symbol:option.underlying,scripCode:position.scripCode,strike:option.strike,optionType:option.optionType,expiry:option.expiry};
}
async function pricePositions(book){
  for(const position of book?.positions||[]){
    const booked=Number(position.booked)||0;
    if(position.net&&!(position.ltp>0)&&angel.status().connected){
      const contract=positionContract(position);
      if(contract){try{position.ltp=(await angel.quote(contract)).price;}catch{}}
    }
    if(position.net&&position.ltp>0&&position.avg>0)position.pnl=Math.round((booked+(position.ltp-position.avg)*position.net)*100)/100;
    else if(!position.net)position.pnl=booked;
  }
}
function applyFillsWithLog(book){
  const before=new Map(engine.orders().map(order=>[order,order.status]));
  applyBrokerFills(engine.orders(), book?.orders||[], (order, price, reason)=>engine.closeOptionOrder(order, price, reason), {trustedBook:!!book?.connected});
  for(const order of engine.orders()){
    if(before.get(order)==='pending'&&order.status==='open'&&order.brokerOrderId)engine.log('fill',`Level ${order.level} ${order.right||''} filled at ${order.filled} · Sharekhan #${order.brokerOrderId}`);
  }
}
async function syncBookOrders(book){
  const orders=engine.orders();
  if(!book||!orders.some(order=>order.brokerOrderId||order.exitBrokerOrderId))return;
  const stamp=()=>`${engine.orders().length}|`+engine.orders().map(order=>`${order.id}:${order.status}:${order.brokerOrderId||''}:${order.rejectReason||''}`).join('|');
  const before=stamp();
  applyFillsWithLog(book);
  if(book.connected){
    for(const {order,row,price} of manualBrokerExits(engine.orders(), book.orders, claimedExits)){
      let exitPrice=price;
      if(!(exitPrice>0)){try{exitPrice=(await angel.quote(contractFor(order))).price;}catch{exitPrice=order.filled||order.entry;}}
      engine.closeOptionOrder(order, exitPrice, 'Closed in Sharekhan');
      engine.log('risk',`Level ${order.level} ${order.right||''} was squared off outside GridPilot (Sharekhan #${row.orderId}) at ${exitPrice}`);
    }
  }
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
let liveBusy=false, liveAt=0, paperBusy=false, paperAt=0, signalAt=0, lockFreeSince=null, boardDirty=false;
const claimedExits=new Set();
async function startStrategy(data, fresh){
  const mode=data.mode==='live'?'live':'paper';
  const tradeMode=data.tradeMode==='live'?'live':'existing';
  if(mode==='live'&&!broker.accessToken())throw Error('Connect Sharekhan before starting live trading');
  if(!angel.status().connected)throw Error('Connect Angel One before starting — paper and live both need the live option price feed');
  let startSignal=null;
  if(tradeMode==='existing'){
    try{
      const market=await signalMarket();
      startSignal=signalSequence(market.candles||[],{after:0,strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd,onDay:istToday(),minutes:signalMinutes()}).filter(item=>item?.spot>0).at(-1)||null;
    }catch{}
  }
  const direction=startSignal?(startSignal.side==='short'?'short':'buy'):data.direction;
  const hadActive=engine.orders().some(isActiveOrder);
  const contract=tradeMode==='live'?null:(engine.option?.scripCode?engine.option:await resolveOption(engine.config,direction,data.spot));
  lockFreeSince=null;signalAt=0;
  const result=fresh?engine.start(direction,mode,contract,tradeMode):engine.arm(direction,mode,contract,tradeMode);
  if(tradeMode==='existing'&&startSignal&&!hadActive&&engine.status==='running'){
    engine.signal={...startSignal,side:direction};
    boardDirty=true;
    engine.log('signal',`Current signal held for this run: ${direction==='short'?'SELL':'BUY'} ${startSignal.spot}`);
    return engine.snapshot();
  }
  return result;
}
function isActiveOrder(order){
  return !order.parked&&(order.status==='open'||(order.status==='pending'&&order.brokerOrderId)||(order.exitBrokerOrderId&&order.status!=='closed'));
}
function activeOrdersFor(right){
  return engine.orders().filter(order=>(order.right||'CE')===right&&isActiveOrder(order));
}
async function heldSide(right,gridSource){
  const held=activeOrdersFor(right);
  if(!held.length)return null;
  const contract=contractFor(held[0]);
  let quote=null;
  try{quote=await optionQuote(contract);}catch{}
  return {...contract,optionType:right,side:held[0].side==='short'?'short':'buy',manageOnly:true,price:quote?.price||null,anchor:null,gridSource,anchorSource:'held',grid:[],gridError:'Open trade from an earlier signal. Its stop, target and trailing keep running; no new levels are placed on this side.',orders:engine.orders().filter(order=>!order.parked&&(order.right||'CE')===right&&String(order.scripCode||'')===String(contract.scripCode||order.scripCode||''))};
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
      const held=engine.orders().filter(isActiveOrder);
      engine.optionOrders=held;
      engine.direction=side;
      engine.signal={...found,side};
      engine.option=null;
      boardDirty=true;
      engine.log('signal',`${String(found.side).toUpperCase()} signal ${found.spot} · unlock mode: grid naye signal par shift ho gaya${held.length?`; purane ${held.length} khule level ka SL, target aur trailing chalta rahega`:''}`);
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
  const same=item=>item?.scripCode&&(!order?.scripCode||String(item.scripCode)===String(order.scripCode));
  if(right&&same(engine.sideContracts?.[right]))return engine.sideContracts[right];
  if(same(engine.option)&&(!right||engine.option.optionType===right))return engine.option;
  if(order?.scripCode){
    const name=order.tradingSymbol||optionUnderlying(engine.config.symbol||'NIFTY');
    return {tradingSymbol:name,exchange:optionMarket(engine.config.exchange||'NF'),scripCode:String(order.scripCode),strike:order.strike,expiry:order.expiry,optionType:right||'CE',lotSize:order.lotSize||engine.option?.lotSize||0,label:`${name} ${order.strike||''} ${right||'CE'}`};
  }
  return (right&&engine.sideContracts?.[right])||engine.option;
}
function marketablePrice(price,side,tick=0.05){
  const step=Number(tick)>0?Number(tick):0.05;
  const raw=side==='short'?price*0.99:price*1.01;
  return Math.max(step,Math.round(Math.round(raw/step)*step*100)/100);
}
async function exitOpenOrder(data){
  const right=String(data.right||'').toUpperCase();
  const order=engine.orders().find(item=>item.status==='open'&&(item.id===Number(data.id)||item.level===Number(data.level))&&(!right||(item.right||'CE')===right));
  if(!order)throw Error('Only an open (filled) level can be exited');
  if(order.exitBrokerOrderId)throw Error('An exit order for this level is already with Sharekhan');
  const contract=contractFor(order);
  let ltp=null;
  try{ltp=(await angel.quote(contract)).price;}catch{}
  if(!(ltp>0))throw Error('Live option price is unavailable, so the exit was not sent');
  if(!order.brokerOrderId){engine.closeOptionOrder(order,ltp,'Manual exit');return engine.snapshot();}
  const side=order.side==='short'?'buy':'short';
  const price=marketablePrice(ltp,side,contract?.tickSize);
  const sent=await sendLive(contract,{side,entry:price,quantity:order.quantity});
  order.exitBrokerOrderId=sent.orderId;
  order.exitReason='manual';
  engine.log('order',`Manual exit ${order.right||''} level ${order.level} at ${price} · ${sent.orderId}`);
  return engine.snapshot();
}
async function closePosition(data){
  if(!broker.accessToken())throw Error('Connect Sharekhan before closing a position');
  const book=await brokerBook(true);
  if(!book.connected)throw Error(book.error||'Sharekhan book is not available');
  const position=(book.positions||[]).find(item=>String(item.scripCode)===String(data.scripCode||'')&&item.net);
  if(!position)throw Error('This position is already closed');
  const base=positionContract(position);
  if(!base)throw Error('Only option positions can be closed from GridPilot');
  const contract=await liveContract({...base,label:position.tradingSymbol});
  const lot=Number(contract.lotSize);
  if(!(lot>0))throw Error('Lot size for this contract is unknown, so the order was not sent');
  const lots=Math.abs(position.net)/lot;
  if(!Number.isInteger(lots))throw Error('Position quantity is not a whole number of lots, so the order was not sent');
  let ltp=position.ltp;
  if(!(ltp>0)){try{ltp=(await angel.quote(base)).price;}catch{}}
  if(!(ltp>0))throw Error('Live option price is unavailable, so the order was not sent');
  const side=position.net>0?'short':'buy';
  const price=marketablePrice(ltp,side,contract.tickSize);
  const sent=await sendLive(contract,{side,entry:price,quantity:lots});
  for(const order of engine.orders()){
    if(order.status==='open'&&!order.exitBrokerOrderId&&String(order.scripCode||'')===String(position.scripCode)){order.exitBrokerOrderId=sent.orderId;order.exitReason='manual';}
  }
  engine.log('order',`Square off ${position.tradingSymbol} · ${Math.abs(position.net)} qty at ${price} · ${sent.orderId}`);
  await save();
  return {...engine.snapshot(),closeResult:{orderId:sent.orderId,price,quantity:Math.abs(position.net)}};
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
async function executePaperGrid(board){
  if(engine.mode!=='paper'||engine.status!=='running'||!engine.inSession()||paperBusy||Date.now()-paperAt<1000)return;
  if(engine.tradeMode==='live'&&!(engine.signal?.spot>0))return;
  paperBusy=true; paperAt=Date.now();
  try{
    if(advancePaperGrid(engine, board))await save();
  }finally{paperBusy=false;}
}
async function executeLiveGrid(board){
  if(engine.mode!=='live'||engine.status!=='running'||!engine.inSession()||liveBusy||Date.now()-liveAt<1000)return;
  if(engine.tradeMode==='live'&&!(engine.signal?.spot>0))return;
  if(!broker.accessToken())return;
  const sides=board?.sides?.length?board.sides:[board];
  if(!sides.some(side=>side?.price>0))return;
  liveBusy=true; liveAt=Date.now();
  try{
    seedGridOrders(engine, board);
    const book=await brokerBook();
    applyFillsWithLog(book);
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
        if(side.manageOnly&&intent.type==='entry')continue;
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
  if(data.action==='exit')return exitOpenOrder(data);
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
  if(before?.status==='open')throw Error('This level is already filled at Sharekhan. Use Exit to close it instead of sending it again.');
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
    if(req.method==='GET'&&url.pathname==='/api/server-ip')return reply(res,200,await serverPublicIp());
    if(req.method==='GET'&&url.pathname==='/api/sharekhan/book')return reply(res,200,await brokerBook(url.searchParams.get('fresh')==='1'));
    if(req.method==='GET'&&url.pathname==='/api/paper/book')return reply(res,200,await paperBook());
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
        case '/api/sharekhan/close-position':result=await closePosition(data);break;
        case '/api/sharekhan/logout':result=broker.logout();await store.clearBrokerSession();bookCache={at:0,value:null};break;
        case '/api/sharekhan/credentials':result=broker.updateCredentials(data);await store.saveSharekhanCredentials(broker.config);writeSharekhanEnv(broker.config);await store.clearBrokerSession();bookCache={at:0,value:null};break;
        case '/api/config': result=engine.configure(await assertInstrument(data));break;
        case '/api/signal-lock': engine.config.signalLock=data.locked!==false; engine.log('settings',engine.config.signalLock?'Signal lock ON: chal raha trade hi chalega':'Signal lock OFF: naya signal aate hi grid shift hoga'); result=engine.snapshot(); break;
        case '/api/grid-anchor': result=setGridAnchor(data); break;
        case '/api/arm': result=await startStrategy(data,false);break;
        case '/api/start': result=await startStrategy(data,true);break;
        case '/api/stop': result=engine.stop();break;
        case '/api/option-order': result=await liveOptionOrder(data);break;
        case '/api/pause':result=engine.pause();break;
        case '/api/resume':result=engine.resume();break;
        case '/api/kill':await squareLivePositions();result=engine.kill();break;
        case '/api/new-day':result=engine.newDay();break;
        case '/api/activity/clear':result=engine.clearActivity();break;
        case '/api/paper/clear':result=engine.clearPaperBook();break;
        case '/api/candle':result=engine.candle(data);break;
        case '/api/tick':result=engine.tick(data.price);break;
        default:return reply(res,404,{error:'Unknown action'});
      }
      if(setEmaPeriods(engine.config.emaOpenPeriod, engine.config.emaClosePeriod))boardDirty=true;
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
    attachLive(server,{intervalMs:1000,idleIntervalMs:()=>angel.feed?.healthy()?1000:10000,authorize:token=>!!verifyToken(token),shouldTick:()=>engine.status==='running',nextTick:async()=>{
      const url=new URL('http://127.0.0.1/api/option');
      url.searchParams.set('moneyness',engine.config.optionMoneyness||'ATM');
      url.searchParams.set('depth',String(engine.config.optionDepth||1));
      url.searchParams.set('right',engine.config.optionRight||'AUTO');
      const chartLtp=engine.config.scripCode?(await angel.quote({exchange:engine.config.exchange||'NC',scripCode:engine.config.scripCode,symbol:engine.config.symbol||'NIFTY'})).price:null;
      const optionLtp=engine.option?.scripCode?(await angel.quote(engine.option)).price:null;
      if(!boardCache||boardDirty||Date.now()-boardAt>10000||!optionLtp){
        boardDirty=false;
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
      if(engine.mode==='live')await executeLiveGrid(liveBoard);
      else if(engine.mode==='paper')await executePaperGrid(liveBoard);
      const run={status:engine.status,haltReason:engine.haltReason||'',tradeMode:engine.tradeMode,direction:engine.direction,signal:engine.signal||null,events:(engine.events||[]).slice(0,8).map(event=>({id:event.id,type:event.type,message:event.message,pnl:event.pnl??null}))};
      if(!price && !chartLtp && !Object.keys(prices).length)return {error:board?.gridError||'Waiting for the option price',run};
      const orders=sideList.length?sideList.flatMap(side=>(side.orders||[]).map(order=>({...order,right:order.right||side.optionType}))):(board.orders||[]);
      return {nifty:chartLtp||board.nifty,price,prices,right:engine.option?.optionType||board.optionType||'',bid:board.bid,ask:board.ask,label:board.label,side:board.side,run,orders:orders.map(order=>({id:order.id,level:order.level,right:order.right||'',status:order.status,entry:order.entry,stop:order.stop}))};
    }});
  });
}
start().catch(error=>{
  const secret=process.env.MONGODB_URI||'';
  console.error('Startup failed:',String(error.message||error).split(secret).join('[redacted]'));
  process.exit(1);
});
