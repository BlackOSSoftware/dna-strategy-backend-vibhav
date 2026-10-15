import test from 'node:test';
import assert from 'node:assert/strict';
import {marketCandles} from './market.js';

test('chart candles come from Angel and retain Sharekhan routing code',async()=>{
  let received;
  const angel={status:()=>({connected:true}),candles:async(contract,interval)=>{received={contract,interval};return [['2026-10-15T09:15:00+05:30',100,105,99,103,1000]];}};
  const result=await marketCandles({exchange:'NC',scripCode:'20000',symbol:'NIFTY',angel});
  assert.equal(result.source,'angel');
  assert.equal(result.scripCode,'20000');
  assert.equal(result.last.close,103);
  assert.equal(received.contract.symbol,'NIFTY');
  assert.equal(received.interval,'15minute');
});

test('market data never falls back to another provider',async()=>{
  const angel={status:()=>({connected:true}),candles:async()=>{throw Error('Angel unavailable');}};
  await assert.rejects(marketCandles({exchange:'NC',scripCode:'other',symbol:'NIFTY',angel}),/Angel unavailable/);
});
