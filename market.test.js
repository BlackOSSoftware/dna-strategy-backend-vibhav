import test from 'node:test';
import assert from 'node:assert/strict';
import {emaSeries, fillIntradayGaps, marketCandles} from './market.js';

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

test('missing intraday minutes are filled flat so the chart has no gaps',()=>{
  const start=Math.floor(Date.parse('2026-10-15T09:15:00+05:30')/1000);
  const rows=[
    {time:start,open:100,high:101,low:99,close:100.5,volume:10},
    {time:start+60,open:100.5,high:102,low:100,close:101.5,volume:10},
    {time:start+240,open:99,high:100,low:98,close:99.5,volume:10},
    {time:start+900,open:99.5,high:100,low:99,close:100,volume:10}
  ];
  const filled=fillIntradayGaps(rows,1);
  assert.equal(filled.length,16);
  assert.deepEqual(filled.slice(2,4).map(candle=>candle.time),[start+120,start+180]);
  assert.equal(filled[2].close,101.5);
  assert.equal(filled[2].open,101.5);
  assert.equal(filled[2].volume,0);
  const untouched=fillIntradayGaps(rows,15);
  assert.equal(untouched.length,4);
});

test('ema seeds with the simple average then weights the newest price',()=>{
  const candles=[10,10,10,20,20].map(close=>({open:close,close}));
  assert.deepEqual(emaSeries(candles,3,candle=>candle.close),[null,null,10,15,17.5]);
  const opens=[5,5,5,5,25].map(open=>({open,close:open}));
  assert.equal(emaSeries(opens,5,candle=>candle.open).at(-1),9);
});

test('market data never falls back to another provider',async()=>{
  const angel={status:()=>({connected:true}),candles:async()=>{throw Error('Angel unavailable');}};
  await assert.rejects(marketCandles({exchange:'NC',scripCode:'other',symbol:'NIFTY',angel}),/Angel unavailable/);
});
