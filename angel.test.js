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

test('Angel plain-text rate limit is shown without clearing a valid session',async()=>{
  const angel=new AngelData({ANGEL_API_KEY:'key',ANGEL_CLIENT_ID:'client',ANGEL_JWT_TOKEN:'jwt'},async()=>({ok:false,status:403,text:async()=> 'Access denied because of exceeding access rate'}));
  await assert.rejects(angel.request('/rest/secure/angelbroking/historical/v1/getCandleData',{}),/rate-limited/);
  assert.equal(angel.status().connected,true);
});
