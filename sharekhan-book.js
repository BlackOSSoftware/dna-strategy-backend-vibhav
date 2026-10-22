const baseUrl = 'https://api.sharekhan.com';

const first = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

export function sideLabel(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (['B', 'BUY', 'BM'].includes(raw)) return 'BUY';
  if (['S', 'SELL', 'SM', 'SAM'].includes(raw)) return 'SELL';
  return raw || '—';
}

export function listFrom(payload, depth = 0) {
  if (depth > 4 || payload == null) return [];
  if (typeof payload === 'string') {
    try { return listFrom(JSON.parse(payload), depth + 1); } catch { return []; }
  }
  if (Array.isArray(payload)) return payload.filter(row => row && typeof row === 'object' && !Array.isArray(row));
  if (typeof payload !== 'object') return [];
  const keys = ['orders', 'orderBook', 'orderbook', 'orderList', 'reportList', 'reports', 'positions', 'positionList', 'netPosition', 'netPositions', 'trades', 'tradeList', 'tradeBook'];
  const found = [];
  for (const key of keys) if (Array.isArray(payload[key])) found.push(...payload[key]);
  if (found.length) return found.filter(row => row && typeof row === 'object');
  for (const key of ['data', 'result', 'response']) {
    if (payload[key] != null && payload[key] !== payload) return listFrom(payload[key], depth + 1);
  }
  return [];
}

function hasKnownList(payload, depth = 0) {
  if (depth > 4) return false;
  if (typeof payload === 'string') {
    try { return hasKnownList(JSON.parse(payload), depth + 1); } catch { return false; }
  }
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== 'object') return false;
  const keys = ['orders', 'orderBook', 'orderbook', 'orderList', 'reportList', 'reports', 'positions', 'positionList', 'netPosition', 'netPositions', 'trades', 'tradeList', 'tradeBook'];
  if (keys.some(key => Array.isArray(payload[key]))) return true;
  return ['data', 'result', 'response'].some(key => payload[key] != null && hasKnownList(payload[key], depth + 1));
}

function reportError(response, payload, label) {
  const status = payload?.status;
  const statusText = String(status ?? '').trim().toLowerCase();
  if (!response.ok || status === false || (typeof status === 'number' && status >= 400) || ['false', 'error', 'failed', 'failure'].includes(statusText)) {
    return `${label}: ${messageOf(payload, response.status)}`;
  }
  // Sharekhan returns data:null when a successful report contains no rows.
  const successfulStatus = status === true || status === 1 || status === 200 || ['true', 'success', 'ok', '200', '1'].includes(statusText);
  const data = payload?.data;
  const dataMarker = typeof data === 'string' ? data.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') : '';
  const noRows = data == null || data === '' || data === 0 || data === false ||
    /^(?:no\s+)?(?:orders?|trades?|positions?|records?|data|content)(?:\s+(?:not\s+found|unavailable|empty|found|available))?\.?$/i.test(dataMarker);
  if (successfulStatus && noRows) return null;
  if (!hasKnownList(payload)) {
    const top = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 8).join(', ') : typeof payload;
    const nested = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? `; data keys: ${Object.keys(payload.data).slice(0, 8).join(', ')}` : '';
    const dataType = data === null ? 'null' : typeof data;
    const dataLength = typeof data === 'string' ? `, length ${data.length}` : '';
    return `${label}: Sharekhan returned an unrecognized response format (status: ${statusText || 'missing'}; data: ${dataType}${dataLength}; keys: ${top}${nested}; message: ${messageOf(payload, response.status)})`;
  }
  return null;
}

function symbolOf(row) {
  const name = String(first(row, ['tradingSymbol', 'symbol', 'scripName', 'companyName']) || '—');
  const strike = first(row, ['strikePrice', 'strike']);
  const right = first(row, ['optionType', 'optiontype', 'right']);
  const expiry = first(row, ['expiry', 'expiryDate', 'expirydate']);
  const hasOption = strike && Number(strike) > 0 && right && !['XX', '-1', '0'].includes(String(right).toUpperCase());
  const option = hasOption ? `${name} ${strike} ${String(right).toUpperCase()}` : name;
  return expiry ? `${option} · ${expiry}` : option;
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mapOrder(row) {
  return {
    orderId: String(first(row, ['orderId', 'orderID', 'exchangeOrderId', 'nestOrderNumber', 'orderNo']) ?? '—'),
    symbol: symbolOf(row),
    side: sideLabel(first(row, ['transactionType', 'buySell', 'orderSide', 'side'])),
    quantity: String(first(row, ['orderQty', 'quantity', 'qty', 'orderQuantity']) ?? '—'),
    filled: String(first(row, ['execQty', 'executedQty', 'filledQty', 'tradedQty', 'fillQty']) ?? '0'),
    price: numOrNull(first(row, ['orderPrice', 'price', 'limitPrice', 'avgPrice'])),
    execPrice: numOrNull(first(row, ['execPrice', 'averagePrice', 'tradedPrice'])),
    status: String(first(row, ['orderStatus', 'status', 'orderstate']) ?? '—'),
    reason: String(first(row, ['errorMsg', 'errorMessage', 'rejectionReason', 'rejectReason', 'rmsReason', 'remarks', 'orderRemarks']) ?? '').trim(),
    product: String(first(row, ['productType', 'product']) ?? '—'),
    exchange: String(first(row, ['exchange']) ?? ''),
    tradingSymbol: String(first(row, ['tradingSymbol', 'symbol', 'scripName']) ?? ''),
    scripCode: String(first(row, ['scripCode', 'scripcode', 'scrip_code']) ?? ''),
    instrumentType: String(first(row, ['instrumentType', 'instType']) ?? ''),
    strike: numOrNull(first(row, ['strikePrice', 'strike'])),
    optionType: String(first(row, ['optionType', 'optiontype']) ?? ''),
    expiry: String(first(row, ['expiry', 'expiryDate', 'expirydate']) ?? ''),
    rmsCode: String(first(row, ['rmsCode', 'rmscode']) ?? '')
  };
}

export function parseOptionName(name) {
  const match = String(name || '').trim().toUpperCase().match(/^([A-Z0-9&-]+)\s+(\d{2})([A-Z]{3})(\d{4})\s+(CE|PE)\s+(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return {underlying:match[1], expiry:`${match[2]}${match[3]}${match[4]}`, optionType:match[5], strike:Number(match[6])};
}

export function mapPosition(row) {
  const buy = numOrNull(first(row, ['buyQty', 'buyQuantity']));
  const sell = numOrNull(first(row, ['sellQty', 'sellQuantity']));
  let quantity = first(row, ['netQty', 'netQuantity', 'quantity', 'openQty', 'qty']);
  if (quantity == null && buy != null && sell != null) quantity = buy - Math.abs(sell);
  const net = Number(quantity) || 0;
  const buyRate = numOrNull(first(row, ['buyRate', 'buyAvg']));
  const sellRate = numOrNull(first(row, ['sellRate', 'sellAvg']));
  const avgRaw = numOrNull(first(row, ['avgPrice', 'averagePrice', 'netAvg', 'netRate']));
  const avg = avgRaw > 0 ? avgRaw : net > 0 ? buyRate : net < 0 ? sellRate : buyRate;
  const ltpRaw = numOrNull(first(row, ['ltp', 'lastPrice', 'LTP', 'mktPrice']));
  const tradingSymbol = String(first(row, ['tradingSymbol', 'symbol', 'scripName']) ?? '');
  return {
    symbol: symbolOf(row),
    side: net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'CLOSED',
    quantity: quantity == null ? '—' : String(quantity),
    net,
    avg,
    buyRate, sellRate,
    ltp: ltpRaw > 0 ? ltpRaw : null,
    booked: numOrNull(first(row, ['bpl', 'bookedPnl', 'realisedPnl', 'realizedPnl'])),
    pnl: numOrNull(first(row, ['pnl', 'unrealizedPnl', 'profitAndLoss', 'profitLoss'])),
    mtm: numOrNull(first(row, ['mtm'])),
    product: String(first(row, ['productType', 'product']) ?? '—'),
    exchange: String(first(row, ['exchange']) ?? ''),
    scripCode: String(first(row, ['scripCode', 'scripcode']) ?? ''),
    tradingSymbol,
    option: parseOptionName(tradingSymbol)
  };
}

function messageOf(payload, status) {
  return String(payload?.message || payload?.error || payload?.errormsg || payload?.data?.message || `Sharekhan book failed (HTTP ${status})`);
}

export function mapFunds(row) {
  if (!row || typeof row !== 'object' || row.currentCashBalance == null) return null;
  const num = value => { const number = Number(value); return Number.isFinite(number) ? number : 0; };
  return {cash:num(row.currentCashBalance), nonCash:num(row.nonCashLimit), shareLimit:num(row.limitAgainstShares), fnoMargin:num(row.intradayMarginFno), hold:num(row.holdFunds), withdrawal:num(row.pendingWithdrawalRequest), fnoPremium:num(row.fnoPremium)};
}
export async function sharekhanBook({apiKey, accessToken, customerId, loginId = '', fetchImpl = fetch}) {
  const profile = {loginId:String(loginId || ''), customerId:String(customerId || '')};
  const empty = {connected: false, orders: [], positions: [], funds: null, profile, error: 'Connect Sharekhan to load the live order book and positions'};
  if (!accessToken || !customerId) return empty;
  const headers = {Accept: 'application/json', 'api-key': String(apiKey || '').trim(), 'access-token': String(accessToken).trim()};
  const get = path => fetchImpl(`${baseUrl}${path}`, {method: 'GET', headers, signal: AbortSignal.timeout(10000)});
  try {
    const [ordersResponse, positionsResponse, fundsResponse] = await Promise.all([
      get(`/skapi/services/reports/${encodeURIComponent(customerId)}`),
      get(`/skapi/services/trades/${encodeURIComponent(customerId)}`),
      get(`/skapi/services/limitstmt/NC/${encodeURIComponent(customerId)}`).catch(() => null)
    ]);
    const ordersPayload = await ordersResponse.json().catch(() => null);
    const positionsPayload = await positionsResponse.json().catch(() => null);
    const fundsPayload = await fundsResponse?.json?.().catch(() => null);
    const funds = mapFunds(Array.isArray(fundsPayload?.data) ? fundsPayload.data[0] : null);
    if (ordersResponse.status === 401 || positionsResponse.status === 401 || ordersResponse.status === 403 || positionsResponse.status === 403) {
      return {connected: false, orders: [], positions: [], funds, profile, error: 'Sharekhan session expired. Connect again to see the live order book.'};
    }
    const ordersError = reportError(ordersResponse, ordersPayload, 'Order book');
    const positionsError = reportError(positionsResponse, positionsPayload, 'Positions');
    return {
      connected: !ordersError && !positionsError,
      orders: ordersError ? [] : listFrom(ordersPayload).map(mapOrder),
      positions: positionsError ? [] : listFrom(positionsPayload).map(mapPosition),
      funds, profile,
      error: [ordersError, positionsError].filter(Boolean).join('; ') || null
    };
  } catch (error) {
    return {connected: false, orders: [], positions: [], funds: null, profile, error: error.name === 'TimeoutError' ? 'Sharekhan order book timed out' : 'Could not load the Sharekhan order book right now'};
  }
}
