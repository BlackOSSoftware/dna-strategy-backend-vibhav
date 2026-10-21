import crypto from 'node:crypto';

const base='https://apiconnect.angelone.in';
const masterUrl='https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const exchangeMap={NC:'NSE',BC:'BSE',NF:'NFO',BF:'BFO',MX:'MCX',RN:'CDS'};
const indexNames=new Set(['NIFTY','NIFTY50','BANKNIFTY','NIFTYBANK','FINNIFTY','MIDCPNIFTY','SENSEX']);
const knownIndices={NIFTY:{exchange:'NSE',token:'99926000',symbol:'Nifty 50'},NIFTY50:{exchange:'NSE',token:'99926000',symbol:'Nifty 50'},BANKNIFTY:{exchange:'NSE',token:'99926009',symbol:'Nifty Bank'},NIFTYBANK:{exchange:'NSE',token:'99926009',symbol:'Nifty Bank'},SENSEX:{exchange:'BSE',token:'99919000',symbol:'SENSEX'}};
const intervals={'1minute':'ONE_MINUTE','3minute':'THREE_MINUTE','5minute':'FIVE_MINUTE','15minute':'FIFTEEN_MINUTE','30minute':'THIRTY_MINUTE','60minute':'ONE_HOUR'};
const quoteCache=new Map();
const quoteJobs=new Map();
const instrumentCache=new Map();
let instruments=null,masterAt=0,masterJob=null;
function expiryId(value){
  const raw=String(value||'').toUpperCase();
  const numeric=raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(numeric)return `${numeric[1]}${numeric[2]}${numeric[3]}`;
  const named=raw.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if(named){const month=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(named[2])+1;return `${named[1]}${String(month).padStart(2,'0')}${named[3]}`;}
  return raw.replace(/\D/g,'');
}
function optionSymbol(symbol,expiry,strike,right){
  const id=expiryId(expiry),match=id.match(/^(\d{2})(\d{2})(\d{4})$/);
  if(!match)return '';
  const month=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(match[2])-1];
  return month?`${symbol}${match[1]}${month}${match[3].slice(-2)}${strike}${right}`:'';
}

export function totp(secret,now=Date.now()){
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes=[];
  for(const letter of String(secret||'').replace(/[\s=]/g,'').toUpperCase()){
    const digit=alphabet.indexOf(letter);if(digit<0)throw Error('Invalid Angel TOTP secret');
    value=(value<<5)|digit;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>bits)&255);}
  }
  const key=Buffer.from(bytes);
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(now/30000)));
  const digest=crypto.createHmac('sha1',key).update(counter).digest();
  const offset=digest.at(-1)&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}

export class AngelData{
  constructor(env=process.env,fetchImpl=fetch){this.env=env;this.fetch=fetchImpl;this.jwt=env.ANGEL_JWT_TOKEN||'';this.lastQuoteAt=0;this.dataError='';this.marketChain=Promise.resolve();this.lastMarketAt=0;this.lastHistAt=0;this.blockedUntil=0;}
  async throttle(route){
    const path=String(route);
    const historical=path.includes('getCandleData');
    if(!historical&&!/market\/v1\/quote|searchScrip/.test(path))return;
    const gap=historical?1500:1000;
    const key=historical?'lastHistAt':'lastMarketAt';
    const step=async()=>{const wait=Math.max(0,gap-(Date.now()-(this[key]||0)));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));this[key]=Date.now();};
    this.marketChain=this.marketChain.then(step,step);
    return this.marketChain;
  }
  status(){return {configured:!!(this.env.ANGEL_API_KEY&&this.env.ANGEL_CLIENT_ID),connected:!!this.jwt,dataReady:!!this.jwt&&!this.dataError&&Date.now()-this.lastQuoteAt<30000,lastQuoteAt:this.lastQuoteAt,dataError:this.dataError,clientId:this.env.ANGEL_CLIENT_ID||''};}
  async request(route,body,{auth=true}={}){
    if(!this.env.ANGEL_API_KEY)throw Error('Angel API key is missing');
    if(auth&&!this.jwt)throw Error('Connect Angel One for market data');
    const headers={'Content-Type':'application/json',Accept:'application/json','X-PrivateKey':this.env.ANGEL_API_KEY,'X-SourceID':this.env.ANGEL_SOURCE_ID||'WEB','X-ClientLocalIP':this.env.ANGEL_CLIENT_LOCAL_IP||'127.0.0.1','X-ClientPublicIP':this.env.ANGEL_CLIENT_PUBLIC_IP||'127.0.0.1','X-MACAddress':this.env.ANGEL_MAC_ADDRESS||'00:00:00:00:00:00','X-UserType':this.env.ANGEL_USER_TYPE||'USER'};
    if(auth)headers.Authorization=`Bearer ${this.jwt}`;
    if(this.blockedUntil&&Date.now()<this.blockedUntil&&/market\/v1\/quote|historical\/v1\/getCandleData|searchScrip/.test(String(route))){
      const error=Error('Angel data is rate-limited; retry shortly');error.retryMs=this.blockedUntil-Date.now();throw error;
    }
    await this.throttle(route);
    const response=await this.fetch(`${base}${route}`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(Number(this.env.ANGEL_REQUEST_TIMEOUT_SEC||10)*1000)});
    const raw=typeof response.text==='function'?await response.text():JSON.stringify(await response.json().catch(()=>null));
    let payload=null;
    try{payload=JSON.parse(raw);}catch{/* Angel sometimes returns plain text for rate limits. */}
    if(!response.ok||payload?.status===false){
      const rateLimited=/exceeding access rate|too many requests/i.test(raw);
      if(response.status===401||(response.status===403&&!rateLimited)||/token.*(invalid|expired)/i.test(payload?.message||''))this.jwt='';
      const message=payload?.message||(rateLimited?'Angel data is rate-limited; retry shortly':`Angel API failed (HTTP ${response.status})`);
      const error=Error(message);if(rateLimited){error.retryMs=60000;this.blockedUntil=Date.now()+60000;}throw error;
    }
    return payload?.data;
  }
  async login(){
    if(!this.env.ANGEL_CLIENT_ID||!this.env.ANGEL_PIN||!this.env.ANGEL_TOTP_SECRET)throw Error('Angel login credentials are missing on the backend');
    const data=await this.request('/rest/auth/angelbroking/user/v1/loginByPassword',{clientcode:this.env.ANGEL_CLIENT_ID,password:this.env.ANGEL_PIN,totp:totp(this.env.ANGEL_TOTP_SECRET)},{auth:false});
    if(!data?.jwtToken)throw Error('Angel login returned no access token');
    this.jwt=data.jwtToken;this.lastQuoteAt=0;this.dataError='';this.blockedUntil=0;return this.status();
  }
  logout(){this.jwt='';this.lastQuoteAt=0;this.dataError='';quoteCache.clear();return this.status();}
  async master(){
    if(instruments&&Date.now()-masterAt<12*3600000)return instruments;
    if(masterJob)return masterJob;
    masterJob=this.fetch(masterUrl,{signal:AbortSignal.timeout(40000)}).then(async response=>{
      if(!response.ok)throw Error('Angel instrument master is unavailable');
      const rows=await response.json();if(!Array.isArray(rows))throw Error('Angel instrument master is invalid');
      instruments=rows;masterAt=Date.now();return rows;
    }).finally(()=>{masterJob=null;});return masterJob;
  }
  async instrument({exchange,scripCode,symbol,tradingSymbol,expiry,strike,optionType}){
    symbol=symbol||tradingSymbol;
    const index=(!strike&&!optionType)&&indexNames.has(String(symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,''));
    const sourceExchange=String(exchange||'').toUpperCase();
    const market=index&&sourceExchange==='NF'?'NSE':index&&sourceExchange==='BF'?'BSE':exchangeMap[sourceExchange]||sourceExchange;
    if(!market)throw Error('Choose an exchange');
    const cacheKey=[market,scripCode,symbol,expiry,strike,optionType].join(':');
    if(instrumentCache.has(cacheKey))return instrumentCache.get(cacheKey);
    const known=index?knownIndices[String(symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,'')]:null;
    if(known&&known.exchange===market){instrumentCache.set(cacheKey,known);return known;}
    if(strike&&optionType&&this.jwt){
      const expected=optionSymbol(String(symbol||'').toUpperCase(),expiry,strike,String(optionType).toUpperCase());
      if(expected){
        try{
          const found=await this.request('/rest/secure/angelbroking/order/v1/searchScrip',{exchange:market,searchscrip:expected});
          const exact=Array.isArray(found)?found.filter(row=>String(row.tradingsymbol||'').toUpperCase()===expected):[];
          if(exact.length===1){const result={exchange:market,token:String(exact[0].symboltoken),symbol:exact[0].tradingsymbol};instrumentCache.set(cacheKey,result);return result;}
        }catch{/* The instrument master provides the fallback when search is unavailable. */}
      }
    }
    const rows=await this.master();const target=String(symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    let matches=rows.filter(row=>row.exch_seg===market);
    if(strike&&optionType){
      const exp=expiryId(expiry);
      matches=matches.filter(row=>String(row.name||'').toUpperCase().replace(/[^A-Z0-9]/g,'')===target&&String(row.symbol||'').toUpperCase().endsWith(String(optionType).toUpperCase())&&Math.abs(Number(row.strike)/100-Number(strike))<0.01&&expiryId(row.expiry)===exp);
    }else{
      const byToken=matches.filter(row=>String(row.token)===String(scripCode)&&String(row.name||'').toUpperCase().replace(/[^A-Z0-9]/g,'')===target);
      matches=byToken.length===1?byToken:matches.filter(row=>String(row.symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,'')===target);
      if(!matches.length){
        const named=rows.filter(row=>row.exch_seg===market&&String(row.name||'').toUpperCase().replace(/[^A-Z0-9]/g,'')===target&&(!row.expiry||row.expiry===''));
        const equity=named.filter(row=>String(row.symbol||'').toUpperCase()===`${target}-EQ`);
        matches=equity.length===1?equity:named;
      }
    }
    if(matches.length!==1)throw Error(`Angel token mapping ${matches.length?'is ambiguous':'was not found'} for ${symbol||scripCode}`);
    const result={exchange:market,token:String(matches[0].token),symbol:matches[0].symbol};instrumentCache.set(cacheKey,result);return result;
  }
  async quote(contract){
    try{return await this.fetchQuote(contract);}catch(error){this.dataError=error.message;throw error;}
  }
  async fetchQuote(contract){
    const item=await this.instrument(contract);const key=`${item.exchange}:${item.token}`;
    const cached=quoteCache.get(key);if(cached&&Date.now()-cached.at<4000){this.lastQuoteAt=cached.at;this.dataError='';return cached.value;}
    if(quoteJobs.has(key))return quoteJobs.get(key);
    const job=(async()=>{
      const data=await this.request('/rest/secure/angelbroking/market/v1/quote/',{mode:'LTP',exchangeTokens:{[item.exchange]:[item.token]}});
      const row=data?.fetched?.find(row=>String(row.symbolToken||row.symboltoken)===item.token)||data?.fetched?.[0];
      const price=Number(row?.ltp);if(!(price>0))throw Error(`Angel quote is unavailable for ${item.symbol}`);
      const value={price,source:'angel',symbol:item.symbol,token:item.token};this.lastQuoteAt=Date.now();this.dataError='';quoteCache.set(key,{at:this.lastQuoteAt,value});return value;
    })();
    quoteJobs.set(key,job);
    try{return await job;}catch(error){
      const stale=quoteCache.get(key);
      if(stale&&Date.now()-stale.at<600000)return stale.value;
      throw error;
    }finally{quoteJobs.delete(key);}
  }
  async candles(contract,interval='15minute'){
    const item=await this.instrument(contract);const frame=intervals[String(interval).toLowerCase()]||'FIFTEEN_MINUTE';
    const days={ONE_MINUTE:2,THREE_MINUTE:2,FIVE_MINUTE:3,FIFTEEN_MINUTE:5,THIRTY_MINUTE:7,ONE_HOUR:10}[frame]||5;
    const end=new Date(),start=new Date(end.getTime()-days*86400000);
    const fmt=date=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replace('T',' ');
    const data=await this.request('/rest/secure/angelbroking/historical/v1/getCandleData',{exchange:item.exchange,symboltoken:item.token,interval:frame,fromdate:fmt(start),todate:fmt(end)});
    if(!Array.isArray(data)||!data.length)throw Error(`Angel candles are unavailable for ${item.symbol}`);
    return data;
  }
}
