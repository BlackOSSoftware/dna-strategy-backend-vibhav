const exchanges = [
  {code:'NC', label:'NC · NSE Cash'},
  {code:'BC', label:'BC · BSE Cash'},
  {code:'NF', label:'NF · NSE F&O'},
  {code:'BF', label:'BF · BSE F&O'},
  {code:'MX', label:'MX · MCX'},
  {code:'RN', label:'RN · NSE Currency'}
];
const productTypes = [
  {code:'INVESTMENT', label:'INVESTMENT · Delivery'},
  {code:'BIGTRADE', label:'BIGTRADE · Intraday'},
  {code:'BIGTRADEPLUS', label:'BIGTRADEPLUS · BigTrade Plus'}
];
const cache = new Map();
const loading = new Map();

const indexNames = {
  NIFTY:'Nifty 50', NIFTYNXT50:'Nifty Next 50', NIFTY500:'Nifty 500', NIFTY100:'Nifty 100', NIFTY200:'Nifty 200',
  NIFTYBANK:'Nifty Bank', NIFTYIT:'Nifty IT', NIFTYMIDCAP50:'Nifty Midcap 50', NIFTYFINSERVICE:'Nifty Financial Services',
  INDIAVIX:'India VIX', NIFTYMID100FREE:'Nifty Midcap 100', NIFTYSML100FREE:'Nifty Smallcap 100',
  NIFTY50VALUE20:'Nifty 50 Value 20', NIFTYMIDCAP150:'Nifty Midcap 150', NIFTYSMLCAP250:'Nifty Smallcap 250',
  NIFTYSMLCAP50:'Nifty Smallcap 50', NIFTYTOTALMKT:'Nifty Total Market', NIFTYMIDSML400:'Nifty MidSmallcap 400',
  NIFTYMIDSELECT:'Nifty Midcap Select', NIFTYAUTO:'Nifty Auto', NIFTYMETAL:'Nifty Metal', NIFTYPHARMA:'Nifty Pharma',
  NIFTYFMCG:'Nifty FMCG', NIFTYENERGY:'Nifty Energy', NIFTYREALTY:'Nifty Realty', NIFTYINFRA:'Nifty Infrastructure',
  NIFTYMEDIA:'Nifty Media', NIFTYPSUBANK:'Nifty PSU Bank', NIFTYPRIVATEBANK:'Nifty Private Bank',
  NIFTYOILANDGAS:'Nifty Oil and Gas', NIFTYHEALTHCARE:'Nifty Healthcare', NIFTYCONSRDURBL:'Nifty Consumer Durables',
  NIFTYCONSUMPTION:'Nifty Consumption', NIFTYCOMMODITIES:'Nifty Commodities', NIFTYCPSE:'Nifty CPSE', NIFTYMNC:'Nifty MNC',
  NIFTYPSE:'Nifty PSE', NIFTYDIVOPPS50:'Nifty Dividend Opportunities 50', NIFTYQUALITY30:'Nifty Quality 30',
  NIFTYALPHA50:'Nifty Alpha 50', NIFTY100ESG:'Nifty 100 ESG', NIFTY100LIQ15:'Nifty 100 Liquid 15',
  NIFTYGROWSECT15:'Nifty Growth Sectors 15', NIFTYMIDCAPLIQUID15:'Nifty Midcap Liquid 15',
  NIFTYMICROCAP250:'Nifty Microcap 250', NIFTYINDDIGITAL:'Nifty India Digital'
};

function indexLabel(symbol) {
  const key = String(symbol || '').toUpperCase();
  if (indexNames[key]) return indexNames[key];
  return String(symbol || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
}

function slim(row) {
  const group = row.groupName && row.groupName !== 'NA' ? row.groupName : '';
  const isIndex = /indices/i.test(group);
  const company = isIndex ? indexLabel(row.tradingSymbol) : (row.companyName && row.companyName !== 'NA' ? row.companyName : '');
  return {
    scripCode: row.scripCode,
    tradingSymbol: String(row.tradingSymbol || ''),
    companyName: company,
    group,
    tickSize: Number(row.tickSize) > 0 ? Number(row.tickSize) : 0.05,
    instType: row.instType || '',
    expiry: row.expiry || '',
    strike: Number(row.strike) || 0,
    optionType: row.optionType && row.optionType !== 'XX' ? row.optionType : '',
    lotSize: Number(row.lotSize) || 0
  };
}

function detail(row) {
  if (row.group && /indices/i.test(row.group)) return row.group;
  return [row.instType, row.expiry, row.strike > 0 ? row.strike : '', row.optionType, row.lotSize > 0 ? `Lot ${row.lotSize}` : ''].filter(Boolean).join(' · ');
}

async function master(exchange) {
  const code = String(exchange || '').trim().toUpperCase();
  if (!exchanges.some(item => item.code === code)) throw Error('Choose an exchange from the list');
  if (cache.has(code)) return cache.get(code);
  if (loading.has(code)) return loading.get(code);
  const apiKey = process.env.SHAREKHAN_API_KEY;
  if (!apiKey) throw Error('Sharekhan API Key is missing');
  const job = fetch(`https://api.sharekhan.com/skapi/services/master/${code}`, {
    headers:{Accept:'application/json', 'api-key':apiKey},
    signal:AbortSignal.timeout(40000)
  }).then(async response => {
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.data)) throw Error(`Sharekhan scrip master failed for ${code}`);
    const rows = payload.data.map(slim);
    cache.set(code, rows);
    loading.delete(code);
    return rows;
  }).catch(error => {
    loading.delete(code);
    throw error;
  });
  loading.set(code, job);
  return job;
}

function rank(row, query) {
  const symbol = row.tradingSymbol.toUpperCase();
  const company = row.companyName.toUpperCase();
  const compactQuery = query.replace(/ /g, '');
  const compactName = company.replace(/ /g, '');
  const code = String(row.scripCode);
  const text = `${symbol} ${company} ${compactName} ${code} ${row.group || ''} ${row.expiry} ${row.strike || ''} ${row.optionType}`.toUpperCase();
  const parts = query.split(' ').filter(Boolean);
  const tokensMatch = parts.every(part => text.includes(part));
  const compactMatch = compactQuery.length > 1 && (compactName === compactQuery || symbol === compactQuery);
  if (!tokensMatch && !compactMatch) return 0;
  if (symbol === query || code === query || company === query || compactName === compactQuery) return 100;
  if (symbol.startsWith(query)) return 80;
  if (company.startsWith(query)) return 70;
  if (parts.length === 1 && symbol.includes(query)) return 50;
  if (parts.length === 1 && (company.includes(query) || code.startsWith(query))) return 30;
  return 20;
}

export function instrumentMeta() {
  return {exchanges, productTypes};
}

export async function searchInstruments(exchange, query) {
  const q = String(query || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (q.length < 1) return [];
  const rows = await master(exchange);
  const scored = [];
  for (const row of rows) {
    const score = rank(row, q);
    if (score) scored.push({score, row});
  }
  scored.sort((a, b) => b.score - a.score || a.row.tradingSymbol.localeCompare(b.row.tradingSymbol) || String(a.row.expiry).localeCompare(String(b.row.expiry)) || a.row.strike - b.row.strike);
  return scored.slice(0, 20).map(({row}) => ({...row, detail:detail(row)}));
}

export async function assertInstrument(input) {
  const exchange = String(input.exchange || '').trim().toUpperCase();
  const productType = String(input.productType || '').trim().toUpperCase();
  if (!exchanges.some(item => item.code === exchange)) throw Error('Choose an exchange from the list');
  if (!productTypes.some(item => item.code === productType)) throw Error('Choose a product type from the list');
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const scripCode = String(input.scripCode || '').trim();
  const match = (await master(exchange)).find(row => String(row.scripCode) === scripCode && row.tradingSymbol.toUpperCase() === symbol);
  if (!match) throw Error('Choose a scrip from the search list');
  input.exchange = exchange;
  input.productType = productType;
  input.symbol = match.tradingSymbol;
  input.scripCode = String(match.scripCode);
  if (!Number(input.tickSize)) input.tickSize = match.tickSize;
  return input;
}

export function niftyOptionRows() {
  return master('NF');
}

export function warmInstrumentCache() {
  master('NC').catch(error => console.error('NSE master cache failed:', error.message));
  master('NF').catch(error => console.error('NSE F&O master cache failed:', error.message));
}
