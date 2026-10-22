import test from 'node:test';
import assert from 'node:assert/strict';
import {AngelData,totp} from './angel.js';

test('TOTP matches RFC 6238 SHA1 vector',()=>{
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',59000),'287082');
});

test('Angel quote maps a Sharekhan option to its Angel token',async()=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{
    requests.push({url,options});
    if(url.includes('ScripMaster'))return {ok:true,json:async()=>[{token:'12345',symbol:'NIFTY29OCT2625000CE',name:'NIFTY',expiry:'29OCT2026',strike:'2500000.000000',exch_seg:'NFO'}]};
    return {ok:true,json:async()=>({status:true,data:{fetched:[{symbolToken:'12345',ltp:120.5}]}})};
  };
  const angel=new AngelData({ANGEL_API_KEY:'key',ANGEL_CLIENT_ID:'client',ANGEL_JWT_TOKEN:'jwt'},fetchImpl);
  const quote=await angel.quote({exchange:'NF',scripCode:'999',tradingSymbol:'NIFTY',expiry:'29/10/2026',strike:25000,optionType:'CE'});
  assert.equal(quote.price,120.5);
  const quoteRequest=requests.find(item=>item.url.includes('/market/v1/quote/'));
  assert.deepEqual(JSON.parse(quoteRequest.options.body).exchangeTokens,{NFO:['12345']});
});

test('Sharekhan NF Bank Nifty index uses Angel NSE index token',async()=>{
  const angel=new AngelData({ANGEL_API_KEY:'key',ANGEL_CLIENT_ID:'client',ANGEL_JWT_TOKEN:'jwt'},async()=>{throw Error('Index should not fetch master')});
  assert.deepEqual(await angel.instrument({exchange:'NF',scripCode:'20001',symbol:'BANKNIFTY'}),{exchange:'NSE',token:'99926009',symbol:'Nifty Bank'});
});

test('quote uses the live feed price without any REST call',async()=>{
  const watched=[];
  const feed={watch:(exchange,token)=>watched.push(`${exchange}:${token}`),price:()=>22811.35,stop(){},status:()=>({connected:true})};
  const angel=new AngelData({ANGEL_API_KEY:'key',ANGEL_CLIENT_ID:'client',ANGEL_JWT_TOKEN:'jwt'},async()=>{throw Error('REST should not be called');},feed);
  const quote=await angel.quote({exchange:'NC',scripCode:'1',symbol:'NIFTY'});
  assert.equal(quote.price,22811.35);
  assert.equal(quote.source,'angel-feed');
  assert.deepEqual(watched,['NSE:99926000']);
});

test('REST quote batches recently used tokens into one request',async()=>{
  const bodies=[];
  const feed={watch(){},price:()=>null,stop(){},status:()=>({connected:false})};
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    const fetched=Object.entries(body.exchangeTokens).flatMap(([exchange,tokens])=>tokens.map(token=>({exchange,symbolToken:token,ltp:token==='99926000'?22800:token==='99926009'?54700:1})));
    return {ok:true,json:async()=>({status:true,data:{fetched}})};
  };
  const angel=new AngelData({ANGEL_API_KEY:'key',ANGEL_CLIENT_ID:'client',ANGEL_JWT_TOKEN:'jwt'},fetchImpl,feed);
  await angel.quote({exchange:'NC',scripCode:'1',symbol:'BANKNIFTY'});
  await new Promise(resolve=>setTimeout(resolve,4100));
  const nifty=await angel.quote({exchange:'NC',scripCode:'2',symbol:'NIFTY'});
  assert.equal(nifty.price,22800);
  assert.deepEqual(bodies.at(-1).exchangeTokens.NSE.sort(),['99926000','99926009']);
  const callsBefore=bodies.length;
  const bank=await angel.quote({exchange:'NC',scripCode:'1',symbol:'BANKNIFTY'});
  assert.equal(bank.price,54700);
  assert.equal(bodies.length,callsBefore);
});

test('Angel plain-text rate limit is shown without clearing a valid session',async()=>{
  const angel=new AngelData({ANGEL_API_KEY:'key',ANGEL_CLIENT_ID:'client',ANGEL_JWT_TOKEN:'jwt'},async()=>({ok:false,status:403,text:async()=> 'Access denied because of exceeding access rate'}));
  await assert.rejects(angel.request('/rest/secure/angelbroking/historical/v1/getCandleData',{}),/rate-limited/);
  assert.equal(angel.status().connected,true);
});
