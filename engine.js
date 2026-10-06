export const defaults = Object.freeze({
  symbol: 'DEMO', exchange: 'NC', scripCode: '', productType: 'INVESTMENT',
  quantity: 1, maxLegs: 4, entryBuffer: 2, gridStep: 7, targetPoints: 12,
  initialStop: 20, trailStartLeg: 3, trailStep: 8,
  maxLoss: 5000, maxProfit: 20000, tickSize: 0.05,
  optionMoneyness: 'ATM', optionDepth: 1, optionRight: 'AUTO'
});

const round = (n, tick) => Math.round(n / tick) * tick;
const fmt = n => Math.round((n + Number.EPSILON) * 100) / 100;
const day = ts => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(ts));

export class Strategy {
  constructor(config = {}) { this.config = {...defaults, ...config}; this.reset(); }
  reset() {
    this.direction = null; this.status = 'idle'; this.mode = 'paper'; this.day = null;
    this.candles = []; this.pending = null; this.legs = []; this.history = [];
    this.events = []; this.realized = 0; this.lastPrice = null; this.level = 0;
    this.highWater = null; this.lowWater = null; this.sharedStop = null;
    this.haltReason = null; this.nextId = 1; this.firstEntry = null; this.trailAnchor = null; this.option = null;
    this.optionOrders = []; this.optionPrice = null;
  }
  log(type, message, data = {}) { this.events.unshift({id:this.nextId++, time:new Date().toISOString(), type, message, ...data}); this.events.length = Math.min(this.events.length, 200); }
  configure(input) {
    if (this.status === 'running' && this.legs.length) throw Error('Close positions before changing settings');
    const next = {...this.config, ...input};
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
    next.symbol = String(next.symbol || '').trim().toUpperCase();
    if (!next.symbol) throw Error('Symbol is required');
    this.config = next; this.log('settings','Strategy settings updated'); return this.snapshot();
  }
  start(direction, mode = 'paper', contract = null) {
    if (!['buy','short'].includes(direction)) throw Error('Choose buy or short');
    if (this.legs.length) throw Error('Open positions must be closed before starting again');
    if (this.status === 'running' && this.direction === direction) return this.snapshot();
    if (this.status === 'paused' && this.direction === direction) return this.resume();
    if (this.status !== 'idle' || this.direction || this.level) {
      const keep = {config:this.config, events:this.events, history:this.history, realized:this.realized, candles:this.candles, lastPrice:this.lastPrice, nextId:this.nextId, optionOrders:this.optionOrders, optionPrice:this.optionPrice};
      this.reset();
      Object.assign(this, keep);
    }
    return this.arm(direction, mode, contract);
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
  arm(direction, mode = 'paper', contract = null) {
    if (!['buy','short'].includes(direction)) throw Error('Choose buy or short');
    if (this.status === 'killed') throw Error('Killed strategy can only reset on a new day');
    if (this.direction && this.direction !== direction) throw Error('Direction is locked for the day');
    if (this.level || this.pending) throw Error('Entry already used; no re-entry today');
    this.day = this.day || day(Date.now()); this.direction = direction; this.mode = mode; this.option = contract || null;
    this.status = 'running'; this.log('system',`${direction.toUpperCase()} armed in ${mode} mode${this.option ? ` · ${this.option.label} ${this.option.expiry}` : ''}`); return this.snapshot();
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
  sma(length, source) { if (this.candles.length < length) return null; return this.candles.slice(-length).reduce((a,c)=>a+c[source],0)/length; }
  candle(c) {
    for (const k of ['open','high','low','close']) if (!Number.isFinite(+c[k])) throw Error(`Invalid candle ${k}`);
    const bar = {time:c.time || new Date().toISOString(),open:+c.open,high:+c.high,low:+c.low,close:+c.close};
    if (bar.high < Math.max(bar.open,bar.close) || bar.low > Math.min(bar.open,bar.close)) throw Error('Invalid OHLC range');
    const barDay = day(bar.time);
    if (this.day && barDay !== this.day && this.status === 'running') { this.pause(); this.log('risk','New date detected; manual day reset required'); }
    this.candles.push(bar); this.candles = this.candles.slice(-200);
    const smaClose = this.sma(5,'close'), smaOpen = this.sma(6,'open');
    bar.smaClose = smaClose === null ? null : fmt(smaClose);
    bar.smaOpen = smaOpen === null ? null : fmt(smaOpen);
    if (this.status === 'running' && !this.level && !this.pending && smaClose !== null && smaOpen !== null) {
      const long = this.direction === 'buy' && bar.close > bar.open && bar.close > smaClose && bar.close > smaOpen;
      const short = this.direction === 'short' && bar.close < bar.open && bar.close < smaClose && bar.close < smaOpen;
      if (long || short) {
        const raw = long ? bar.high + this.config.entryBuffer : bar.low - this.config.entryBuffer;
        this.pending = {side:this.direction, price:fmt(round(raw,this.config.tickSize)), time:bar.time};
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
    if (allowEntry && this.pending && favorable(price,this.pending.price)) { this.addLeg(price); this.pending=null; }
    if (allowEntry && this.level && this.legs.length && this.level<this.config.maxLegs) {
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
    if (!this.orders().length) {
      if (!rows.length && action !== 'add') throw Error('Load the option grid before changing orders');
      this.optionOrders = rows.map(row => this.draftOrder(row));
    }
    if (action === 'add') {
      const last = this.optionOrders.at(-1);
      const side = input.side === 'short' || last?.side === 'short' ? 'short' : 'buy';
      const sign = side === 'short' ? -1 : 1;
      const entry = last ? last.entry + sign * this.config.gridStep : Number(input.entry);
      this.optionOrders.push(this.draftOrder({side, entry, target:entry + sign * this.config.targetPoints, stop:entry - sign * this.config.initialStop, quantity:this.config.quantity}));
      this.numberOrders();
      this.log('order', `Added level ${this.optionOrders.length}`);
      return this.snapshot();
    }
    const order = this.orders().find(item => item.id === Number(input.id)) || this.orders().find(item => item.level === Number(input.level));
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
      if (order.brokerOrderId) throw Error('This order is already with Sharekhan');
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
    const order = {id:this.nextId++, level:Number(row.level) || 0, side:row.side === 'short' ? 'short' : 'buy', entry:0, target:0, stop:0, quantity:this.config.quantity, status:'draft'};
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
  numberOrders() { this.optionOrders.forEach((order, index) => { order.level = index + 1; }); }
  markOptionPrice(price) {
    const next = Number(price);
    if (!Number.isFinite(next) || next <= 0) return this.snapshot();
    this.optionPrice = fmt(next);
    for (const order of this.orders()) {
      if (order.routing === 'live') continue;
      if (order.status === 'pending') {
        const reached = order.side === 'buy' ? next >= order.entry : next <= order.entry;
        if (reached) { order.status = 'open'; order.filled = fmt(next); this.log('fill', `Option level ${order.level} filled at ${order.filled}`); }
      } else if (order.status === 'open') {
        const target = order.side === 'buy' ? next >= order.target : next <= order.target;
        const stopped = order.side === 'buy' ? next <= order.stop : next >= order.stop;
        if (stopped || target) this.closeOptionOrder(order, next, stopped ? 'Stop' : 'Target');
      }
    }
    return this.snapshot();
  }
  closeOptionOrder(order, price, reason) {
    order.status = 'closed'; order.exit = fmt(price); order.reason = reason;
    order.pnl = fmt((order.side === 'buy' ? price - order.filled : order.filled - price) * order.quantity);
    this.realized = fmt(this.realized + order.pnl);
    this.log('exit', `Option level ${order.level} ${reason} at ${order.exit}`, {pnl:order.pnl});
  }
  snapshot() { return {config:this.config,direction:this.direction,status:this.status,mode:this.mode,day:this.day,
    candles:this.candles,pending:this.pending,legs:this.legs,history:this.history,events:this.events,
    realized:this.realized,pnl:this.pnl(),lastPrice:this.lastPrice,level:this.level,firstEntry:this.firstEntry,trailAnchor:this.trailAnchor,sharedStop:this.sharedStop,haltReason:this.haltReason,option:this.option,optionOrders:this.orders(),optionPrice:this.optionPrice}; }
}
