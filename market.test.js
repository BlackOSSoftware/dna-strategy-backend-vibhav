import test from 'node:test';
import assert from 'node:assert/strict';
import {marketCandles} from './market.js';

test('option history uses Sharekhan tradeDate and tradeTime', async () => {
  const result = await marketCandles({
    exchange: 'NF',
    scripCode: '44596-test',
    symbol: 'NIFTY',
    apiKey: 'key',
    accessToken: 'token',
    fetchImpl: async (url) => {
      assert.match(String(url), /\/NF\/44596-test\/15minute$/);
      return {ok: true, status: 200, json: async () => ({status: 200, message: 'chart', data: [
        {open: 439.95, high: 471, low: 420.15, close: 467, qty: 10205, tradeTime: '09:29:56', tradeDate: '5/10/2026'}
      ]})};
    }
  });
  assert.equal(result.interval, '15minute');
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].close, 467);
  assert.equal(result.candles[0].volume, 10205);
  assert.equal(result.candles[0].time, Date.parse('2026-10-05T09:29:56+05:30') / 1000);
});

test('a Sharekhan 429 is not retried until the cooldown ends', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), /\/15minute$/);
    return {ok: false, status: 429, headers: {get: () => '20'}, json: async () => ({message: 'Too Many Requests'})};
  };
  const input = {exchange: 'NF', scripCode: '125855-rate', symbol: 'RELIANCE', apiKey: 'key', accessToken: 'token', fetchImpl};
  await assert.rejects(() => marketCandles(input), /rate-limited/);
  await assert.rejects(() => marketCandles(input), /rate-limited/);
  assert.equal(calls, 1);
});
