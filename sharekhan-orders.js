const baseUrl = 'https://api.sharekhan.com';

function findOrderId(payload) {
  for (const item of [payload, payload?.data, payload?.data?.data]) {
    if (item == null) continue;
    if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item.trim()))) return String(item).trim();
    const id = item.orderId || item.orderID || item.nestOrderNumber || item.exchangeOrderId;
    if (id) return String(id);
  }
  return '';
}

const indexUnderlyings = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']);

export function optionInstrumentType(contract) {
  const given = String(contract?.instrumentType || '').toUpperCase();
  if (['OI', 'OS', 'FI', 'FS'].includes(given)) return given;
  const symbol = String(contract?.tradingSymbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return indexUnderlyings.has(symbol) ? 'OI' : 'OS';
}

export function alignOrderContract(contract, rows) {
  const match = (rows || []).find(row => String(row.scripCode) === String(contract?.scripCode || ''));
  if (!match) return {...contract, instrumentType: optionInstrumentType(contract)};
  const listedRight = match.optionType === 'CE' || match.optionType === 'PE' ? match.optionType : '';
  return {
    ...contract,
    tradingSymbol: match.tradingSymbol || contract?.tradingSymbol,
    scripCode: String(match.scripCode),
    expiry: match.expiry || contract?.expiry,
    strike: Number(match.strike) > 0 ? Number(match.strike) : contract?.strike,
    optionType: listedRight || contract?.optionType,
    instrumentType: String(match.instType || '').toUpperCase() || optionInstrumentType(contract),
    lotSize: Number(match.lotSize) > 0 ? Number(match.lotSize) : contract?.lotSize
  };
}

export function buildOptionOrder({customerId, loginId, contract, order, productType, requestType = 'NEW', orderId = ''}) {
  const lot = Number(contract?.lotSize);
  const lots = Number(order?.quantity);
  if (!Number.isInteger(lot) || lot < 1) throw Error('Option lot size is missing, so the live order was not sent');
  if (!Number.isInteger(lots) || lots < 1) throw Error('Quantity must be a whole number of lots');
  if (!contract?.scripCode || !contract?.strike || !contract?.optionType || !contract?.expiry) throw Error('Detected option is incomplete, so the live order was not sent');
  const apiLoginId = String(loginId || customerId);
  const body = {
    customerId: Number(customerId),
    scripCode: Number(contract.scripCode),
    tradingSymbol: contract.tradingSymbol || 'NIFTY',
    exchange: contract.exchange || 'NF',
    transactionType: ['B', 'S', 'BM', 'SM', 'SAM'].includes(order?.transactionType) ? order.transactionType : (order.side === 'short' ? 'S' : 'B'),
    quantity: lots * lot,
    disclosedQty: 0,
    executedQty: 0,
    price: String(order.entry),
    triggerPrice: '0',
    rmsCode: 'ANY',
    afterHour: 'N',
    orderType: 'NORMAL',
    channelUser: apiLoginId,
    validity: 'GFD',
    requestType,
    productType: productType || 'INVESTMENT',
    instrumentType: optionInstrumentType(contract),
    strikePrice: String(contract.strike),
    optionType: contract.optionType,
    expiry: contract.expiry
  };
  if (orderId) body.orderId = String(orderId);
  return body;
}

export async function sendSharekhanOrder({apiKey, accessToken, body, fetchImpl = fetch}) {
  const response = await fetchImpl(`${baseUrl}/skapi/services/orders`, {
    method: 'POST',
    headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'api-key': String(apiKey || '').trim(), 'access-token': String(accessToken)},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  const message = String(payload?.message || payload?.error || payload?.errormsg || payload?.data?.message || payload?.data?.errormsg || '');
  if (!response.ok || payload?.status === false) throw Error(message || `Sharekhan rejected the order (HTTP ${response.status})`);
  const orderId = findOrderId(payload) || String(body.orderId || '');
  if (body.requestType === 'NEW' && !orderId) throw Error(message || 'Sharekhan did not return an order id');
  return {orderId, quantity: body.quantity, message};
}

export function cancelOrderBody({customerId, loginId, order}) {
  const original = order?.brokerOrder;
  if (!original?.scripCode || !order?.brokerOrderId) return null;
  return {
    ...original,
    customerId: Number(customerId),
    channelUser: String(loginId || customerId),
    requestType: 'CANCEL',
    orderId: String(order.brokerOrderId)
  };
}

export async function submitLiveOrder({apiKey, accessToken, customerId, loginId, contract, order, productType, fetchImpl}) {
  if (!accessToken || !customerId) throw Error('Connect Sharekhan before placing a live order');
  const body = cancelOrderBody({customerId, loginId, order}) || buildOptionOrder({customerId, loginId, contract, order, productType, requestType: order?.brokerOrderId ? 'CANCEL' : 'NEW', orderId: order?.brokerOrderId || ''});
  const sent = await sendSharekhanOrder({apiKey, accessToken, body, fetchImpl});
  return {...sent, body};
}
