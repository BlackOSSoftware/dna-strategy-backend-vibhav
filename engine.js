import {sideGridField, sideGridKeys, sideGridSettings} from './options.js';
import {trailOpenStops} from './live-grid.js';

export const defaults = Object.freeze({
  symbol: 'DEMO', exchange: 'NC', scripCode: '', productType: 'INVESTMENT',
  quantity: 1, maxLegs: 4, entryBuffer: 2, gridStep: 7, targetPoints: 12,
  initialStop: 20, trailStartLeg: 3, trailStep: 8,
  maxLoss: 5000, maxProfit: 20000, tickSize: 0.05,
  strategyStart: '09:15', strategyEnd: '15:15', signalInterval: '15minute', signalLock: true, emaOpenPeriod: 5, emaClosePeriod: 6,
  optionMoneyness: 'ATM', optionDepth: 1, optionRight: 'AUTO', optionMode: 'BOTH',
  callOnBuy: 'buy', callOnSell: 'sell', putOnBuy: 'sell', putOnSell: 'buy',
  gridSource: 'premium'
});
const clockValue = value => {
  const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return '';
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
};
const clockMinutes = value => { const clock = clockValue(value); return clock ? Number(clock.slice(0,2)) * 60 + Number(clock.slice(3)) : null; };

const round = (n, tick) => Math.round(n / tick) * tick;
const fmt = n => Math.round((n + Number.EPSILON) * 100) / 100;
const day = ts => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(ts));
const istMinutes = ts => {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(ts));
  const hour = parts.find(part => part.type === 'hour')?.value;
  const minute = parts.find(part => part.type === 'minute')?.value;
  return (hour === '24' ? 0 : Number(hour)) * 60 + Number(minute);
};

export function sessionSignal(candles, {direction = 'buy', after = 0, strategyStart = '09:15', strategyEnd = '15:15', onDay = '', minutes = 15} = {}) {
  const start = clockMinutes(strategyStart) ?? 9 * 60 + 15;
  const end = clockMinutes(strategyEnd) ?? 15 * 60 + 15;
  const span = Math.max(1, Number(minutes) || 15) * 60;
  const afterSec = after > 1e12 ? Math.floor(after / 1000) : Math.floor(Number(after) || 0);
  const rows = Array.isArray(candles) ? candles : [];
  const targetDay = onDay || (rows.length ? day(Number(rows[rows.length - 1].time) * 1000) : '');
  let level = null;
  for (let index = 0; index < rows.length; index++) {
    const candle = rows[index];
    const time = Number(candle.time);
    if (!Number.isFinite(time)) continue;
    if (targetDay && day(time * 1000) !== targetDay) continue;
    const minute = istMinutes(time * 1000);
    if (minute < start || minute >= end) continue;
    if (level && (direction === 'short' ? candle.low < level.low : candle.high > level.high)) {
      return {day:day(time * 1000), side:direction, spot:direction === 'short' ? level.low : level.high, time};
    }
    const closed = index < rows.length - 1 || Date.now() >= time * 1000 + span * 1000;
    if (!closed || candle.emaClose == null || candle.emaOpen == null) continue;
    if (time + span <= afterSec) continue;
    const buy = direction !== 'short' && candle.close > candle.open && candle.close > candle.emaClose && candle.close > candle.emaOpen;
    const sell = direction === 'short' && candle.close < candle.open && candle.close < candle.emaClose && candle.close < candle.emaOpen;
    if (buy) level = {high:candle.high};
    if (sell) level = {low:candle.low};
  }
  return null;
}

export function signalSequence(candles, {after = 0, strategyStart = '09:15', strategyEnd = '15:15', onDay = '', minutes = 15} = {}) {
  const start = clockMinutes(strategyStart) ?? 9 * 60 + 15;
  const end = clockMinutes(strategyEnd) ?? 15 * 60 + 15;
  const span = Math.max(1, Number(minutes) || 15) * 60;
  const afterSec = after > 1e12 ? Math.floor(after / 1000) : Math.floor(Number(after) || 0);
  const rows = Array.isArray(candles) ? candles : [];
  const targetDay = onDay || (rows.length ? day(Number(rows[rows.length - 1].time) * 1000) : '');
  const signals = [];
  let buyLevel = null, sellLevel = null, last = null;
  for (let index = 0; index < rows.length; index++) {
    const candle = rows[index];
    const time = Number(candle.time);
    if (!Number.isFinite(time)) continue;
    if (targetDay && day(time * 1000) !== targetDay) continue;
    const minute = istMinutes(time * 1000);
    if (minute < start || minute >= end) { buyLevel = null; sellLevel = null; continue; }
    if (last !== 'short' && sellLevel && candle.low < sellLevel.low) {
      signals.push({day: day(time * 1000), side: 'short', spot: sellLevel.low, time});
      sellLevel = null; buyLevel = null; last = 'short';
    } else if (last !== 'buy' && buyLevel && candle.high > buyLevel.high) {
      signals.push({day: day(time * 1000), side: 'buy', spot: buyLevel.high, time});
      buyLevel = null; sellLevel = null; last = 'buy';
    }
    const closed = index < rows.length - 1 || Date.now() >= time * 1000 + span * 1000;
    if (!closed || candle.emaClose == null || candle.emaOpen == null) continue;
    if (time + span <= afterSec) continue;
    if (last !== 'short' && candle.close < candle.open && candle.close < candle.emaClose && candle.close < candle.emaOpen) sellLevel = {low: candle.low};
    if (last !== 'buy' && candle.close > candle.open && candle.close > candle.emaClose && candle.close > candle.emaOpen) buyLevel = {high: candle.high};
  }
  return signals;
}

export function upcomingSignal(candles, options = {}) {
  return signalSequence(candles, options)[0] || null;
}

export function latestSignal(candles, options = {}) {
  return signalSequence(candles, options).at(-1) || null;
}

export class Strategy {
  constructor(config = {}) { this.config = {...defaults, ...config}; this.reset(); }
  reset() {
    this.direction = null; this.status = 'idle'; this.mode = 'paper'; this.tradeMode = 'existing'; this.day = null;
    this.candles = []; this.pending = null; this.signal = null; this.startedAt = null; this.legs = []; this.history = [];
    this.events = []; this.realized = 0; this.lastPrice = null; this.level = 0;
    this.highWater = null; this.lowWater = null; this.sharedStop = null;
    this.haltReason = null; this.nextId = 1; this.firstEntry = null; this.trailAnchor = null; this.option = null;
    this.optionOrders = []; this.optionPrice = null; this.sideContracts = {}; this.gridKeys = {}; this.manualAnchors = {};
  }
  log(type, message, data = {}) { this.events.unshift({id:this.nextId++, time:new Date().toISOString(), type, message, ...data}); this.events.length = Math.min(this.events.length, 200); }
  configure(input) {
    if (this.status === 'running') throw Error('Stop the strategy before changing settings');
    const next = {...defaults, ...this.config, ...input};
    const start = clockValue(next.strategyStart), end = clockValue(next.strategyEnd);
    if (!start || !end) throw Error('Strategy start and end must be a time like 09:15');
    if (clockMinutes(start) >= clockMinutes(end)) throw Error('Strategy end must be after the start');
    next.strategyStart = start; next.strategyEnd = end;
    const frame = String(next.signalInterval || '15minute').toLowerCase();
    if (!['1minute', '3minute', '5minute', '15minute', '30minute', '60minute'].includes(frame)) throw Error('Choose a signal timeframe of 1, 3, 5, 15, 30, or 60 minutes');
    next.signalInterval = frame;
    next.signalLock = next.signalLock !== false;
    for (const [key, label] of [['emaOpenPeriod', 'EMA on Open period'], ['emaClosePeriod', 'EMA on Close period']]) {
      const period = Number(next[key]);
      if (!Number.isInteger(period) || period < 2 || period > 100) throw Error(`${label} must be a whole number from 2 to 100`);
      next[key] = period;
    }
    if (next.emaOpenPeriod >= next.emaClosePeriod) throw Error(`EMA on Open period (${next.emaOpenPeriod}) must be smaller than EMA on Close period (${next.emaClosePeriod})`);
    const labels = {quantity:'Quantity per leg',maxLegs:'Maximum legs',entryBuffer:'Entry buffer',gridStep:'Grid step',targetPoints:'Target per leg',initialStop:'Initial stop',trailStartLeg:'Trail starts at leg',trailStep:'Trailing step',maxLoss:'Max daily loss',maxProfit:'Max daily profit',tickSize:'Tick size'};
    for (const k of Object.keys(labels)) {
      if (!Number.isFinite(+next[k]) || +next[k] <= 0) throw Error(`${labels[k]} must be greater than 0`);
      next[k] = +next[k];
    }
    for (const k of ['quantity','maxLegs','trailStartLeg']) if (!Number.isInteger(next[k])) throw Error(`${labels[k]} must be a whole number`);
    if (next.trailStartLeg > next.maxLegs) throw Error('Trail start cannot exceed max legs');
    const moneyness = String(next.optionMoneyness || 'ATM').toUpperCase();
    const right = String(next.optionRight || 'AUTO').toUpperCase();
    const depth = Math.trunc(Number(next.optionDepth ?? 1));
    if (!['ATM', 'ITM', 'OTM'].includes(moneyness)) throw Error('Choose ITM, ATM, or OTM');
    if (!['AUTO', 'CE', 'PE'].includes(right)) throw Error('Choose Auto, CE, or PE');
    if (!Number.isInteger(depth) || depth < 1 || depth > 10) throw Error('Strikes away must be from 1 to 10');
    next.optionMoneyness = moneyness; next.optionRight = right; next.optionDepth = depth;
    const mode = String(next.optionMode || 'BOTH').toUpperCase();
    if (!['CE', 'PE', 'BOTH'].includes(mode)) throw Error('Choose Call, Put, or Both');
    next.optionMode = mode;
    for (const key of ['callOnBuy', 'callOnSell', 'putOnBuy', 'putOnSell']) {
      const action = String(next[key] || 'off').toLowerCase();
      if (!['buy', 'sell', 'off'].includes(action)) throw Error('Each signal action must be a buy grid, sell grid, or off');
      next[key] = action;
    }
    const sideLabels = {quantity:'quantity per leg',maxLegs:'maximum legs',entryBuffer:'entry buffer',gridStep:'grid step',targetPoints:'target per leg',initialStop:'initial stop',trailStartLeg:'trail start',trailStep:'trailing step',tickSize:'tick size'};
    for (const prefix of ['call', 'put']) {
      const title = prefix === 'call' ? 'Call' : 'Put';
      for (const key of sideGridKeys) {
        const name = sideGridField(prefix, key);
        const raw = next[name] == null || next[name] === '' ? next[key] : next[name];
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw Error(`${title} ${sideLabels[key]} must be greater than 0`);
        if (['quantity', 'maxLegs', 'trailStartLeg'].includes(key) && !Number.isInteger(value)) throw Error(`${title} ${sideLabels[key]} must be a whole number`);
        next[name] = ['quantity', 'maxLegs', 'trailStartLeg'].includes(key) ? Math.trunc(value) : value;
      }
      if (next[sideGridField(prefix, 'trailStartLeg')] > next[sideGridField(prefix, 'maxLegs')]) throw Error(`${title} trail start cannot exceed maximum legs`);
    }
    Object.assign(next, sideGridSettings(next, mode === 'PE' ? 'PE' : 'CE'));
    next.gridSource = next.gridSource === 'signal' ? 'signal' : 'premium';
    next.symbol = String(next.symbol || '').trim().toUpperCase();
    if (!next.symbol) throw Error('Symbol is required');
    this.config = next; this.log('settings',`Strategy settings updated · ${start}–${end} IST`); return this.snapshot();
  }
  inSession(ts = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(ts));
    const hour = parts.find(part => part.type === 'hour')?.value;
    const minute = parts.find(part => part.type === 'minute')?.value;
    const now = clockMinutes(`${hour === '24' ? '00' : hour}:${minute}`);
    const start = clockMinutes(this.config.strategyStart) ?? clockMinutes(defaults.strategyStart);
    const end = clockMinutes(this.config.strategyEnd) ?? clockMinutes(defaults.strategyEnd);
    return now !== null && now >= start && now < end;
  }
  start(direction, mode = 'paper', contract = null, tradeMode = null) {
    if (!['buy','short'].includes(direction)) throw Error('Choose buy or short');
    if (this.legs.length) throw Error('Open positions must be closed before starting again');
    const nextTrade = tradeMode === 'live' ? 'live' : 'existing';
    if (this.status === 'running') {
      if (this.direction === direction && this.tradeMode === nextTrade && this.mode === mode) return this.snapshot();
      throw Error('Strategy is already running; stop it before starting again');
    }
    const dead = new Set(['rejected', 'cancelled', 'canceled', 'closed']);
    if (this.orders().length && this.orders().every(order => dead.has(String(order.status || '').toLowerCase()))) this.optionOrders = [];
    const brokerBusy = this.orders().some(order => order.status === 'open' || order.status === 'pending' || (order.brokerOrderId && !dead.has(String(order.status || '').toLowerCase())));
    if (nextTrade === 'live' && brokerBusy) throw Error('Close the current option orders before Live mode');
    if (this.realized !== 0) this.log('system', `P&L reset to 0 for this run (previous ${fmt(this.realized)})`);
    this.realized = 0;
    if (this.status === 'paused' && this.direction === direction && this.tradeMode === nextTrade && nextTrade !== 'live') { this.mode = mode; return this.resume(); }
    if (this.status !== 'idle' || this.direction || this.level || this.tradeMode !== nextTrade) {
      const keep = {config:this.config, events:this.events, history:this.history, realized:this.realized, candles:this.candles, lastPrice:this.lastPrice, nextId:this.nextId, optionPrice:this.optionPrice, manualAnchors:this.manualAnchors || {}};
      if (nextTrade === 'existing') { keep.option = contract || this.option; keep.optionOrders = this.optionOrders; }
      this.reset();
      Object.assign(this, keep);
    }
    return this.arm(direction, mode, nextTrade === 'live' ? null : (contract || this.option), nextTrade);
  }
  stop() {
    if (this.status === 'idle') return this.snapshot();
    this.pending = null;
    if (this.legs.length) this.closeAll(this.lastPrice, 'Strategy stopped');
    this.status = 'paused';
    this.haltReason = 'Stopped';
    this.log('system','Strategy stopped');
    return this.snapshot();
  }
  arm(direction, mode = 'paper', contract = null, tradeMode = 'existing') {
    if (!['buy','short'].includes(direction)) throw Error('Choose buy or short');
    if (this.status === 'killed') throw Error('Killed strategy can only reset on a new day');
    if (this.direction && this.direction !== direction) throw Error('Direction is locked for the day');
    if (this.level || this.pending) throw Error('Entry already used; no re-entry today');
    this.tradeMode = tradeMode === 'live' ? 'live' : 'existing';
    this.day = this.day || day(Date.now()); this.direction = direction; this.mode = mode;
    if (this.tradeMode === 'live') { this.option = null; this.optionOrders = []; this.signal = null; this.startedAt = Date.now(); }
    else this.option = contract || this.option || null;
    this.status = 'running';
    const label = this.tradeMode === 'live' ? 'LIVE mode · waiting for the next signal' : `EXISTING mode${this.option ? ` · ${this.option.label} ${this.option.expiry}` : ''}`;
    this.log('system',`${direction.toUpperCase()} armed in ${mode} · ${label}`); return this.snapshot();
  }
  pause() { if (this.status === 'running') { this.status = 'paused'; this.pending = null; this.log('system','Paused; pending trigger cancelled'); } return this.snapshot(); }
  resume() { if (this.status !== 'paused') throw Error('Strategy is not paused'); this.status='running'; this.haltReason=null; this.log('system','Strategy started'); return this.snapshot(); }
  kill() {
    this.pending=null; this.closeAll(this.lastPrice, 'Manual kill');
    for (const order of this.orders()) {
      if (order.status === 'pending') order.status = 'draft';
      if (order.status === 'open') this.closeOptionOrder(order, this.optionPrice || order.filled, 'Manual kill');
    }
    this.status='killed'; this.haltReason='Manual kill'; this.log('risk','Kill switch activated'); return this.snapshot();
  }
  newDay() { if (this.legs.length) throw Error('Open positions must be closed first'); this.reset(); this.log('system','New trading day reset'); return this.snapshot(); }
  clearActivity() { this.events = []; return this.snapshot(); }
  ema(length, source) {
    if (this.candles.length < length) return null;
    const k = 2 / (length + 1);
    let ema = null;
    for (let index = 0; index < this.candles.length; index++) {
      if (index < length - 1) continue;
      if (ema === null) { let sum = 0; for (let offset = 0; offset < length; offset++) sum += this.candles[index - offset][source]; ema = sum / length; }
      else ema = this.candles[index][source] * k + ema * (1 - k);
    }
    return ema;
  }
  candle(c) {
    for (const k of ['open','high','low','close']) if (!Number.isFinite(+c[k])) throw Error(`Invalid candle ${k}`);
    const bar = {time:c.time || new Date().toISOString(),open:+c.open,high:+c.high,low:+c.low,close:+c.close};
    if (bar.high < Math.max(bar.open,bar.close) || bar.low > Math.min(bar.open,bar.close)) throw Error('Invalid OHLC range');
    const barDay = day(bar.time);
    if (this.day && barDay !== this.day && this.status === 'running') {
      this.day = barDay; this.pending = null; this.level = 0; this.legs = [];
      if (this.tradeMode === 'live') {
        this.signal = null; this.option = null; this.startedAt = Date.parse(bar.time) || Date.now();
        this.optionOrders = this.orders().filter(order => order.status === 'open' || order.brokerOrderId);
        this.log('signal','New day · live mode is waiting for the next signal');
      }
      else this.log('system','Existing mode continues on the current contract');
    }
    this.candles.push(bar); this.candles = this.candles.slice(-200);
    const emaOpen = this.ema(Number(this.config.emaOpenPeriod) || 5,'open'), emaClose = this.ema(Number(this.config.emaClosePeriod) || 6,'close');
    bar.emaOpen = emaOpen === null ? null : fmt(emaOpen);
    bar.emaClose = emaClose === null ? null : fmt(emaClose);
    if (this.status === 'running' && !this.level && !this.pending && this.inSession(bar.time) && emaClose !== null && emaOpen !== null) {
      const long = this.direction === 'buy' && bar.close > bar.open && bar.close > emaClose && bar.close > emaOpen;
      const short = this.direction === 'short' && bar.close < bar.open && bar.close < emaClose && bar.close < emaOpen;
      if (long || short) {
        const raw = long ? bar.high + this.config.entryBuffer : bar.low - this.config.entryBuffer;
        this.pending = {side:this.direction, price:fmt(round(raw,this.config.tickSize)), time:bar.time};
        this.signal = {day:barDay, side:this.direction, spot:long ? bar.high : bar.low, time:bar.time};
        this.log('signal',`${this.direction.toUpperCase()} trigger at ${this.pending.price}`);
      }
    }
    this.tick(bar.close, false);
    return this.snapshot();
  }
  addLeg(price) {
    const id=this.nextId++, side=this.direction, cfg=this.config;
    const leg={id,number:this.level+1,side,entry:fmt(price),quantity:cfg.quantity,
      target:fmt(round(price+(side==='buy'?1:-1)*cfg.targetPoints,cfg.tickSize)),
      stop:fmt(round(price+(side==='buy'?-1:1)*cfg.initialStop,cfg.tickSize)),status:'open'};
    this.legs.push(leg); this.level++; this.log('fill',`Level ${leg.number} ${side} at ${leg.entry}`,{legId:id});
    if (this.level === 1) this.firstEntry = leg.entry;
    if (this.level >= 3) {
      this.sharedStop = this.firstEntry;
      this.log('risk',`Shared stop moved to first entry ${this.sharedStop}`);
    }
    if (this.level === cfg.trailStartLeg) this.trailAnchor = price;
    return leg;
  }
  closeLeg(leg, price, reason) {
    leg.status='closed'; leg.exit=fmt(price); leg.reason=reason;
    leg.pnl=fmt((leg.side==='buy'?price-leg.entry:leg.entry-price)*leg.quantity);
    this.realized=fmt(this.realized+leg.pnl); this.history.unshift({...leg});
    this.legs=this.legs.filter(x=>x.id!==leg.id); this.log('exit',`Level ${leg.number} ${reason} at ${leg.exit}`,{pnl:leg.pnl});
  }
  closeAll(price, reason) {
    if (!Number.isFinite(price)) { if (this.legs.length) throw Error('No market price to square off open positions'); return; }
    for (const leg of [...this.legs]) this.closeLeg(leg,price,reason);
    this.pending=null;
  }
  pnl(price=this.lastPrice) { return fmt(this.realized + (Number.isFinite(price) ? this.legs.reduce((a,l)=>a+(l.side==='buy'?price-l.entry:l.entry-price)*l.quantity,0) : 0)); }
  tick(price, allowEntry=true) {
    price=+price; if (!Number.isFinite(price) || price<=0) throw Error('Price must be positive');
    this.lastPrice=fmt(price);
    if (this.status !== 'running') return this.snapshot();
    const side=this.direction, favorable=side==='buy'?(p,t)=>p>=t:(p,t)=>p<=t;
    const adverse=side==='buy'?(p,t)=>p<=t:(p,t)=>p>=t;
    if (this.pnl(price)<=-this.config.maxLoss || this.pnl(price)>=this.config.maxProfit) {
      const reason=this.pnl(price)<=-this.config.maxLoss?'Maximum loss':'Maximum profit';
      this.closeAll(price,reason); this.status='killed'; this.haltReason=reason; this.log('risk',`${reason} limit reached`); return this.snapshot();
    }
    if (this.legs.length) {
      const stop=this.sharedStop;
      if (stop!==null && adverse(price,stop)) { this.closeAll(price,'Shared stop'); this.status='halted'; this.haltReason='Shared stop'; return this.snapshot(); }
      for (const leg of [...this.legs]) {
        if (adverse(price,leg.stop)) this.closeLeg(leg,price,'Stop loss');
        else if (favorable(price,leg.target)) this.closeLeg(leg,price,'Target');
      }
      if (!this.legs.length) { this.status='halted'; this.haltReason='All legs exited; no re-entry'; return this.snapshot(); }
    }
    const sessionOpen = this.inSession(this.candles.at(-1)?.time || Date.now());
    if (allowEntry && !sessionOpen && this.pending) { this.pending = null; this.log('signal','Trigger cancelled; outside strategy hours'); }
    if (allowEntry && sessionOpen && this.pending && favorable(price,this.pending.price)) { this.addLeg(price); this.pending=null; }
    if (allowEntry && sessionOpen && this.level && this.legs.length && this.level<this.config.maxLegs) {
      if (this.firstEntry !== null) {
        const next=this.firstEntry+(side==='buy'?1:-1)*this.config.gridStep*this.level;
        if (favorable(price,next)) this.addLeg(price);
      }
    }
    if (this.level>=this.config.trailStartLeg && this.legs.length) {
      if (side==='buy') this.highWater=Math.max(this.highWater??price,price);
      else this.lowWater=Math.min(this.lowWater??price,price);
      const steps=Math.floor(Math.abs((side==='buy'?this.highWater:this.lowWater)-this.trailAnchor)/this.config.trailStep);
      if (steps>0) {
        const candidate=this.firstEntry+(side==='buy'?1:-1)*steps*this.config.trailStep;
        if (this.sharedStop===null || (side==='buy'?candidate>this.sharedStop:candidate<this.sharedStop)) {
          this.sharedStop=fmt(round(candidate,this.config.tickSize)); this.log('risk',`Trailing stop → ${this.sharedStop}`);
        }
      }
    }
    if (this.pnl(price)<=-this.config.maxLoss || this.pnl(price)>=this.config.maxProfit) {
      const reason=this.pnl(price)<=-this.config.maxLoss?'Maximum loss':'Maximum profit';
      this.closeAll(price,reason); this.status='killed'; this.haltReason=reason; this.log('risk',`${reason} limit reached`);
    }
    return this.snapshot();
  }
  orders() { if (!Array.isArray(this.optionOrders)) this.optionOrders = []; return this.optionOrders; }
  optionOrder(input = {}) {
    const action = String(input.action || '');
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const right = String(input.right || '').toUpperCase();
    const scoped = order => !right || (order.right || 'CE') === right;
    if (!this.orders().some(scoped)) {
      if (!rows.length && action !== 'add') throw Error('Load the option grid before changing orders');
      const seeded = rows.filter(row => !right || String(row.right || right).toUpperCase() === right).map(row => this.draftOrder({...row, right: row.right || right}));
      this.optionOrders = [...this.orders(), ...seeded];
    }
    if (action === 'add') {
      const slot = right || 'CE';
      const grid = sideGridSettings(this.config, slot);
      const last = this.optionOrders.filter(order => (order.right || 'CE') === slot).at(-1);
      const side = input.side === 'short' || last?.side === 'short' ? 'short' : 'buy';
      const sign = side === 'short' ? -1 : 1;
      const entry = last ? last.entry + sign * grid.gridStep : Number(input.entry);
      this.optionOrders.push(this.draftOrder({side, right:slot, entry, target:entry + sign * grid.targetPoints, stop:entry - sign * grid.initialStop, quantity:grid.quantity}));
      this.numberOrders();
      this.log('order', `Added level ${this.optionOrders.length}`);
      return this.snapshot();
    }
    const order = this.orders().find(item => item.id === Number(input.id) && scoped(item)) || this.orders().find(item => item.level === Number(input.level) && scoped(item));
    if (!order) throw Error('Choose an order from the grid');
    if (action === 'edit') {
      if (order.status === 'open') throw Error('An open order cannot be edited');
      this.applyOrder(order, input);
      this.log('order', `Modified level ${order.level} entry ${order.entry}`);
    } else if (action === 'remove') {
      if (order.status === 'open') throw Error('Close the open order before removing it');
      this.optionOrders = this.optionOrders.filter(item => item.id !== order.id);
      this.log('order', `Removed level ${order.level}`);
    } else if (action === 'place') {
      if (order.status === 'pending' && order.brokerOrderId) throw Error('This order is already with Sharekhan');
      if (order.status !== 'pending') order.brokerOrderId = '';
      order.status = 'pending';
      order.routing = input.live ? 'live' : 'paper';
      if (input.live) order.filled = null;
      this.log('order', `Placed level ${order.level} ${order.side.toUpperCase()} at ${order.entry}`);
    } else if (action === 'unplace') {
      if (order.status !== 'pending') throw Error('Only a placed pending order can be unplaced');
      order.status = 'draft';
      this.log('order', `Unplaced level ${order.level}`);
    } else throw Error('Unknown order action');
    this.numberOrders();
    return this.snapshot();
  }
  draftOrder(row) {
    const order = {id:this.nextId++, level:Number(row.level) || 0, side:row.side === 'short' ? 'short' : 'buy', right:String(row.right || '').toUpperCase(), entry:0, target:0, stop:0, quantity:this.config.quantity, status:'draft'};
    if (Number(row.lotSize) > 0) order.lotSize = Number(row.lotSize);
    if (row.scripCode) order.scripCode = String(row.scripCode);
    if (Number(row.strike) > 0) order.strike = Number(row.strike);
    if (row.expiry) order.expiry = row.expiry;
    if (row.tradingSymbol) order.tradingSymbol = row.tradingSymbol;
    this.applyOrder(order, row);
    return order;
  }
  applyOrder(order, input) {
    for (const key of ['entry', 'target', 'stop']) {
      if (input[key] == null || input[key] === '') continue;
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value <= 0) throw Error('Order price must be greater than 0');
      order[key] = fmt(value);
    }
    if (![order.entry, order.target, order.stop].every(value => value > 0)) throw Error('Entry, target, and stop are required');
    if (input.quantity != null && input.quantity !== '') {
      const quantity = Number(input.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw Error('Quantity must be a whole number');
      order.quantity = quantity;
    }
    if (input.side === 'buy' || input.side === 'short') order.side = input.side;
  }
  numberOrders() {
    const groups = new Map();
    for (const order of this.optionOrders) {
      const right = order.right || 'CE';
      groups.set(right, [...(groups.get(right) || []), order]);
    }
    for (const list of groups.values()) list.forEach((order, index) => { order.level = index + 1; });
  }
  markOptionPrice(price, right = '') {
    const next = Number(price);
    if (!Number.isFinite(next) || next <= 0) return this.snapshot();
    this.optionPrice = fmt(next);
    const slot = String(right || '').toUpperCase();
    const mine = order => order.routing !== 'live' && (!slot || !order.right || order.right === slot);
    const paperOpen = this.orders().filter(order => mine(order) && order.status === 'open');
    if (paperOpen.length) {
      const grid = sideGridSettings(this.config, slot || paperOpen[0].right || 'CE');
      trailOpenStops(paperOpen, next, {side:paperOpen[0].side === 'short' ? 'short' : 'buy', trailStartLeg:grid.trailStartLeg || this.config.trailStartLeg, trailStep:grid.trailStep || this.config.trailStep, tick:grid.tickSize || this.config.tickSize});
    }
    for (const order of this.orders()) {
      if (!mine(order)) continue;
      if (order.status === 'pending') {
        const reached = order.side === 'buy' ? next >= order.entry : next <= order.entry;
        if (reached) { order.status = 'open'; order.filled = fmt(next); this.log('fill', `Option level ${order.level} filled at ${order.filled}`); }
      } else if (order.status === 'open') {
        const target = order.side === 'buy' ? next >= order.target : next <= order.target;
        const stopped = order.side === 'buy' ? next <= order.stop : next >= order.stop;
        if (stopped || target) this.closeOptionOrder(order, next, stopped ? 'Stop' : 'Target');
      }
    }
    const openPaper = this.orders().some(order => order.status === 'open' && order.routing !== 'live');
    if (this.status === 'running' || openPaper) {
      const total = this.optionPnl(next);
      const maxLoss = Number(this.config.maxLoss) || 0, maxProfit = Number(this.config.maxProfit) || 0;
      if ((maxLoss > 0 && total <= -maxLoss) || (maxProfit > 0 && total >= maxProfit)) {
        const reason = maxLoss > 0 && total <= -maxLoss ? 'Maximum loss' : 'Maximum profit';
        for (const order of this.orders()) if (order.status === 'open' && order.routing !== 'live') this.closeOptionOrder(order, next, reason);
        if (this.status === 'running') { this.status = 'killed'; this.haltReason = reason; }
        this.log('risk', `${reason} limit reached on option trades`);
      }
    }
    return this.snapshot();
  }
  lotOf(order) {
    const lot = Number(order?.lotSize);
    if (lot > 0) return lot;
    const fallback = Number(this.option?.lotSize);
    return fallback > 0 ? fallback : 1;
  }
  optionPnl(priceByRight = {}) {
    let total = this.realized;
    for (const order of this.orders()) {
      if (order.status !== 'open' || !(order.filled > 0)) continue;
      const price = typeof priceByRight === 'number' ? priceByRight : priceByRight[order.right || 'CE'];
      if (!(price > 0)) continue;
      total += (order.side === 'buy' ? price - order.filled : order.filled - price) * order.quantity * this.lotOf(order);
    }
    return fmt(total);
  }
  closeOptionOrder(order, price, reason) {
    order.status = 'closed'; order.exit = fmt(price); order.reason = reason;
    order.pnl = fmt((order.side === 'buy' ? price - order.filled : order.filled - price) * order.quantity * this.lotOf(order));
    this.realized = fmt(this.realized + order.pnl);
    this.log('exit', `Option level ${order.level} ${reason} at ${order.exit}`, {pnl:order.pnl});
  }
  snapshot() { return {config:this.config,signalFrame:this.config.signalInterval||'15minute',direction:this.direction,status:this.status,mode:this.mode,tradeMode:this.tradeMode||'existing',signal:this.signal||null,startedAt:this.startedAt||null,day:this.day,
    candles:this.candles,pending:this.pending,legs:this.legs,history:this.history,events:this.events,
    realized:this.realized,pnl:this.pnl(),lastPrice:this.lastPrice,level:this.level,firstEntry:this.firstEntry,trailAnchor:this.trailAnchor,sharedStop:this.sharedStop,haltReason:this.haltReason,option:this.option,optionOrders:this.orders(),optionPrice:this.optionPrice,gridKey:this.gridKey||'',manualAnchors:this.manualAnchors||{}}; }
}
