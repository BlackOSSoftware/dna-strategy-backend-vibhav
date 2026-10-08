import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Strategy, defaults, sessionSignal} from './engine.js';
import {SharekhanAuth} from './sharekhan-auth.js';
import {StrategyStore} from './store.js';
import {assertInstrument,instrumentMeta,niftyOptionRows,searchInstruments,warmInstrumentCache} from './instruments.js';
import {marketCandles} from './market.js';
import {detectOption,optionPremium,optionSide,optionUnderlying,withOptionGrid} from './options.js';
import {attachLive} from './live.js';
import {login, tokenFrom, verifyToken} from './auth.js';
import {sharekhanBook} from './sharekhan-book.js';
import {submitLiveOrder} from './sharekhan-orders.js';
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
const store=new StrategyStore(process.env.MONGODB_URI, process.env.MONGODB_DB||'dna-strategy',process.env.SHAREKHAN_SESSION_ENCRYPTION_KEY);
const engine=new Strategy();
function restore(snapshot){
  if(!snapshot)return;
  const {pnl,...state}=snapshot;
  Object.assign(engine,state);
  engine.config={...defaults,...engine.config};
  engine.nextId=(engine.events||[]).reduce((max,event)=>Math.max(max,Number(event.id)||0),0)+1;
  if(engine.tradeMode!=='live')engine.tradeMode='existing';
  engine.signal=engine.signal||null;
  engine.startedAt=engine.startedAt||null;
  if(engine.status==='running'){engine.status='paused';engine.pending=null;engine.log('risk','Server restarted; manually resume after checking broker positions');}
}
async function save(){await store.save(engine.snapshot());}
async function underlyingSpot(given){
  const price=Number(given);
  if(Number.isFinite(price)&&price>0)return price;
  const symbol=engine.config.symbol||'NIFTY';
  const market=await marketCandles({exchange:engine.config.exchange||'NC',scripCode:engine.config.scripCode,symbol,apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken()});
  const close=Number(market.last?.close);
  if(!(close>0))throw Error(`${optionUnderlying(symbol)} price is not available yet`);
  return close;
}
async function optionQuote(contract){
  try{
    return await optionPremium({expiry:contract.expiry,strike:contract.strike,right:contract.optionType,symbol:contract.tradingSymbol});
  }catch(nseError){
    if(!(broker.accessToken()&&contract?.scripCode))throw nseError;
    try{
      const market=await marketCandles({exchange:contract.exchange||'NF',scripCode:contract.scripCode,symbol:contract.tradingSymbol,apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken()});
      const price=Number(market.last?.close);
      if(price>0)return {price,bid:null,ask:null,underlying:null};
    }catch{/* History can be rate-limited; the chart retries on its own. */}
    throw nseError;
  }
}
function gridSettings(url,direction){
  const cfg=engine.config;
  const num=(name,fallback)=>{const value=Number(url.searchParams.get(name));return Number.isFinite(value)&&value>0?value:fallback;};
  return {side:direction==='short'?'short':'buy',gridStep:num('gridStep',cfg.gridStep),targetPoints:num('targetPoints',cfg.targetPoints),initialStop:num('initialStop',cfg.initialStop),maxLegs:Math.trunc(num('maxLegs',cfg.maxLegs)),tickSize:num('tickSize',cfg.tickSize||0.05),trailStartLeg:Math.trunc(num('trailStartLeg',cfg.trailStartLeg)),trailStep:num('trailStep',cfg.trailStep)};
}
async function optionBoard(url,maxAge=15000){
  const direction=url.searchParams.get('direction')||engine.direction||'buy';
  const settings=gridSettings(url,direction);
  settings.maxAge=maxAge;
  let contract;
  if(url.searchParams.get('strike')&&url.searchParams.get('expiry')){
    const right=optionSide(url.searchParams.get('right')||'CE',direction);
    const strike=Number(url.searchParams.get('strike'));
    const name=optionUnderlying(url.searchParams.get('symbol')||engine.config.symbol||'NIFTY');
    contract={tradingSymbol:name,exchange:'NF',scripCode:url.searchParams.get('scrip')||'',expiry:url.searchParams.get('expiry'),strike,optionType:right,moneyness:url.searchParams.get('moneyness')||'',lotSize:Number(url.searchParams.get('lot'))||0,spot:Number(url.searchParams.get('spot'))||null,label:`${name} ${strike} ${right}`};
  }else contract=await resolveOption({optionMoneyness:url.searchParams.get('moneyness')||engine.config.optionMoneyness,optionDepth:url.searchParams.get('depth')||engine.config.optionDepth,optionRight:url.searchParams.get('right')||engine.config.optionRight},direction,url.searchParams.get('spot'));
  const previewOnly=engine.tradeMode==='live'&&!(engine.signal?.spot>0);
  const keepExisting=engine.tradeMode!=='live'&&engine.option?.scripCode&&engine.status!=='idle';
  const liveLocked=engine.orders().some(order=>order.brokerOrderId||order.status==='open'||order.status==='pending');
  const sameContract=engine.option?.scripCode&&String(engine.option.scripCode)===String(contract?.scripCode);
  if(contract?.scripCode&&!liveLocked&&!sameContract){engine.optionOrders=[];engine.option=contract;await save();}
  else if(!previewOnly&&!keepExisting&&contract?.scripCode&&!liveLocked&&(engine.option?.tradingSymbol!==contract.tradingSymbol||Number(engine.option?.strike)!==Number(contract.strike)||engine.option?.optionType!==contract.optionType)){engine.option=contract;await save();}
  if(Number(contract?.tickSize)>0)settings.tickSize=Number(contract.tickSize);
  let quote=null;
  try{quote=await optionQuote(contract);}catch(error){quote={error};}
  let board;
  try{if(quote?.error)throw quote.error;board=await withOptionGrid(contract,{...settings,quote});}
  catch(error){board={...contract,side:settings.side,price:null,grid:[],gridError:error.message};}
  if(board.price){
    const before=JSON.stringify(engine.optionOrders||[]);
    engine.markOptionPrice(board.price);
    if(JSON.stringify(engine.optionOrders||[])!==before)await save();
  }
  board.orders=String(engine.option?.scripCode||'')===String(contract?.scripCode||'')?engine.orders():[];
  return board;
}
async function resolveOption(config,direction,spot){
  const symbol=optionUnderlying(engine.config.symbol||'NIFTY');
  return detectOption(await niftyOptionRows(),{symbol,spot:await underlyingSpot(spot),moneyness:config.optionMoneyness,depth:config.optionDepth,right:optionSide(config.optionRight,direction)});
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
async function brokerBook(){
  const accessToken=broker.accessToken();
  if(!accessToken){bookCache={at:0,value:null};return sharekhanBook({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:'',customerId:''});}
  if(bookCache.value&&Date.now()-bookCache.at<2000)return bookCache.value;
  const value=await sharekhanBook({apiKey:process.env.SHAREKHAN_API_KEY,accessToken,customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:broker.config.loginId||''});
  bookCache={at:Date.now(),value};
  return value;
}
let liveBusy=false, liveAt=0, signalAt=0;
async function startStrategy(data, fresh){
  const mode=data.mode==='live'?'live':'paper';
  const tradeMode=data.tradeMode==='live'?'live':'existing';
  if(mode==='live'&&!broker.accessToken())throw Error('Connect Sharekhan before starting live trading');
  const contract=tradeMode==='live'?null:(engine.option?.scripCode?engine.option:await resolveOption(engine.config,data.direction,data.spot));
  return fresh?engine.start(data.direction,mode,contract,tradeMode):engine.arm(data.direction,mode,contract,tradeMode);
}
async function refreshLiveSignal(){
  if(engine.tradeMode!=='live'||engine.status!=='running'||Date.now()-signalAt<20000)return;
  signalAt=Date.now();
  if(engine.orders().some(order=>order.brokerOrderId||order.status==='open'))return;
  try{
    const market=await marketCandles({exchange:engine.config.exchange||'NC',scripCode:engine.config.scripCode||'20000',symbol:engine.config.symbol||'NIFTY',apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken()});
    const found=sessionSignal(market.candles||[],{direction:engine.direction||'buy',after:engine.startedAt||Date.now(),strategyStart:engine.config.strategyStart,strategyEnd:engine.config.strategyEnd});
    if(!found||engine.signal?.time===found.time)return;
    engine.signal=found;
    engine.option=null;
    engine.optionOrders=[];
    engine.log('signal',`${String(found.side).toUpperCase()} signal ${found.spot} · strike will be selected from this price`);
    await save();
  }catch(error){engine.log('risk',`Live signal check failed: ${error.message}`);}
}
function seedLiveGrid(board){
  if(engine.orders().length||!board?.grid?.length)return;
  const side=board.side==='short'?'short':'buy';
  const rows=board.grid.filter(row=>row.entry>0&&row.target>0&&row.stop>0);
  if(!rows.length){engine.log('risk','Live grid was not armed because a level price is not tradable');return;}
  engine.optionOrders=rows.map(row=>engine.draftOrder({...row, side, quantity:engine.config.quantity}));
}
async function executeLiveGrid(board){
  if(engine.mode!=='live'||engine.status!=='running'||!engine.inSession()||liveBusy||Date.now()-liveAt<1000)return;
  if(engine.tradeMode==='live'&&!(engine.signal?.spot>0))return;
  if(!broker.accessToken()||!engine.option?.scripCode||!(board?.price>0))return;
  liveBusy=true; liveAt=Date.now();
  try{
    seedLiveGrid(board);
    const orders=engine.orders();
    const side=orders[0]?.side||board.side||'buy';
    trailOpenStops(orders, board.price, {side, trailStartLeg:engine.config.trailStartLeg, trailStep:engine.config.trailStep, tick:engine.config.tickSize});
    const book=await brokerBook();
    applyBrokerFills(orders, book.orders||[], (order, price, reason)=>engine.closeOptionOrder(order, price, reason));
    for(const order of orders){
      if(order.status==='rejected'&&order.rejectReason&&!order.rejectLogged){
        order.rejectLogged=true;
        engine.log('risk',`Sharekhan rejected level ${order.level}: ${order.rejectReason}`);
      }
    }
    for(const intent of liveIntents(orders, board.price, side)){
      const order=orders.find(item=>item.level===intent.level);
      if(!order)continue;
      try{
        if(intent.type==='entry'){
          engine.optionOrder({action:'place', level:order.level, live:true});
          const sent=await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken(),customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:sharekhanLoginId(),contract:engine.option,order,productType:engine.config.productType});
          order.brokerOrderId=sent.orderId;
          engine.log('order',`Live entry level ${order.level} at ${order.entry} · ${sent.orderId}`);
        }else{
          const exitOrder={side:order.side==='short'?'buy':'short', entry:intent.price, quantity:order.quantity};
          const sent=await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken(),customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:sharekhanLoginId(),contract:engine.option,order:exitOrder,productType:engine.config.productType});
          order.exitBrokerOrderId=sent.orderId;
          order.exitReason=intent.reason;
          engine.log('order',`Live ${intent.reason} level ${order.level} at ${intent.price} · ${sent.orderId}`);
        }
      }catch(error){
        if(intent.type==='entry'&&order.status==='pending'&&!order.brokerOrderId)order.status='draft';
        order.liveHoldUntil=Date.now()+15000;
        engine.log('risk',`Live level ${order.level} was not sent: ${error.message}`);
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
        await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken(),customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:sharekhanLoginId(),contract:engine.option,order,productType:engine.config.productType});
        order.brokerOrderId='';
      }else if(order.status==='open'&&!order.exitBrokerOrderId&&engine.optionPrice>0){
        const exitOrder={side:order.side==='short'?'buy':'short', entry:engine.optionPrice, quantity:order.quantity};
        const sent=await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken(),customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:sharekhanLoginId(),contract:engine.option,order:exitOrder,productType:engine.config.productType});
        order.exitBrokerOrderId=sent.orderId;
      }
    }catch(error){engine.log('risk',`Kill could not close level ${order.level}: ${error.message}`);}
  }
}
async function liveOptionOrder(data){
  if(data.action==='unplace'){
    const existing=engine.orders().find(item=>item.id===Number(data.id)||item.level===Number(data.level));
    if(existing?.brokerOrderId){
      await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken(),customerId:broker.session?.customerId||process.env.SHAREKHAN_CUSTOMER_ID,loginId:sharekhanLoginId(),contract:engine.option,order:existing,productType:engine.config.productType});
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
  const contract=engine.option;
  if(!contract?.scripCode)throw Error('Detected option has no scrip code yet');
  const before=engine.orders().find(item=>item.id===Number(data.id)||item.level===Number(data.level));
  const wasOpen=before?.status==='open';
  const previousStatus=before?.status||'draft';
  const previousFilled=before?.filled??null;
  engine.optionOrder({...data,live:true});
  const order=engine.orders().find(item=>item.level===Number(data.level))||engine.orders().find(item=>item.id===Number(data.id));
  try{
    const sent=await submitLiveOrder({apiKey:process.env.SHAREKHAN_API_KEY,accessToken,customerId,loginId,contract,order,productType:engine.config.productType});
    order.brokerOrderId=sent.orderId;
    order.brokerQty=sent.quantity;
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
    if(req.method==='GET'&&url.pathname==='/api/market')return reply(res,200,await marketCandles({exchange:url.searchParams.get('exchange')||engine.config.exchange,scripCode:url.searchParams.get('scripCode')||engine.config.scripCode,symbol:url.searchParams.get('symbol')||engine.config.symbol,apiKey:process.env.SHAREKHAN_API_KEY,accessToken:broker.accessToken()}));
    if(req.method==='GET'&&url.pathname==='/api/option')return reply(res,200,await optionBoard(url));
    if(req.method==='GET'&&url.pathname==='/api/sharekhan/status')return reply(res,200,await verifyBroker());
    if(req.method==='GET'&&url.pathname==='/api/sharekhan/book')return reply(res,200,await brokerBook());
    if(req.method==='POST'&&url.pathname.startsWith('/api/')){
      const data=await body(req); let result;
      switch(url.pathname){
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
        case '/api/arm': result=await startStrategy(data,false);break;
        case '/api/start': result=await startStrategy(data,true);break;
        case '/api/stop': result=engine.stop();break;
        case '/api/option-order': result=await liveOptionOrder(data);break;
        case '/api/pause':result=engine.pause();break;
        case '/api/resume':result=engine.resume();break;
        case '/api/kill':await squareLivePositions();result=engine.kill();break;
        case '/api/new-day':result=engine.newDay();break;
        case '/api/candle':result=engine.candle(data);break;
        case '/api/tick':result=engine.tick(data.price);break;
        default:return reply(res,404,{error:'Unknown action'});
      }
      if(!url.pathname.startsWith('/api/sharekhan/'))await save();
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
    attachLive(server,{intervalMs:50,authorize:token=>!!verifyToken(token),nextTick:async()=>{
      const url=new URL('http://127.0.0.1/api/option');
      url.searchParams.set('direction',engine.direction||'buy');
      url.searchParams.set('moneyness',engine.config.optionMoneyness||'ATM');
      url.searchParams.set('depth',String(engine.config.optionDepth||1));
      url.searchParams.set('right',engine.config.optionRight||'AUTO');
      await refreshLiveSignal();
      if(engine.tradeMode==='live'&&engine.signal?.spot>0)url.searchParams.set('spot',String(engine.signal.spot));
      else if(engine.tradeMode!=='live'&&engine.option?.strike&&engine.option?.expiry){url.searchParams.set('strike',engine.option.strike);url.searchParams.set('expiry',engine.option.expiry);url.searchParams.set('right',engine.option.optionType);url.searchParams.set('scrip',engine.option.scripCode||'');}
      const board=await optionBoard(url,2000);
      if(engine.mode==='live')await executeLiveGrid(board);
      if(!board?.price)return {error:board?.gridError||'Waiting for the option price'};
      return {nifty:board.nifty,price:board.price,bid:board.bid,ask:board.ask,label:board.label,side:board.side,orders:(board.orders||[]).map(order=>({level:order.level,status:order.status,entry:order.entry}))};
    }});
  });
}
start().catch(error=>{
  const secret=process.env.MONGODB_URI||'';
  console.error('Startup failed:',String(error.message||error).split(secret).join('[redacted]'));
  process.exit(1);
});
