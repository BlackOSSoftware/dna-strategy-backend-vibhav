import crypto from 'node:crypto';

const baseUrl = 'https://api.sharekhan.com';
const zeroIv = Buffer.alloc(16, 0);
const normalize = value => String(value ?? '').trim();
const secureKeyBytes = secureKey => {
  const key = Buffer.from(normalize(secureKey).replace(/^["']+|["']+$/g, '').replace(/\s+/g, ''), 'utf8');
  if (key.length !== 32) throw Error('Sharekhan Secure Key must be 32 bytes');
  return key;
};

export function buildLoginUrl(apiKey, state, vendorKey = '', versionId = '') {
  if (!normalize(apiKey) || !normalize(state)) throw Error('Sharekhan API Key and state are required');
  const params = new URLSearchParams({api_key: normalize(apiKey), state: normalize(state)});
  if (normalize(vendorKey)) params.set('vendor_key', normalize(vendorKey));
  if (normalize(versionId)) params.set('version_id', normalize(versionId));
  return `${baseUrl}/skapi/auth/login.html?${params}`;
}

export function extractRequestToken(value) {
  const raw=normalize(value);
  if (!raw) throw Error('Request token is required');
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const url=new URL(raw);
    const token=url.searchParams.get('requestToken') || url.searchParams.get('request_token') || url.searchParams.get('token');
    if (!token) throw Error('No request token found in callback URL');
    return token.replace(/ /g,'+');
  }
  return raw.replace(/ /g,'+');
}

export function prepareSessionToken(requestToken, secureKey) {
  const key=secureKeyBytes(secureKey);
  const normalized=extractRequestToken(requestToken).replace(/-/g,'+').replace(/_/g,'/');
  const encrypted=Buffer.from(normalized,'base64');
  if (encrypted.length<=16) throw Error('Invalid Sharekhan request token');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,zeroIv);
  const decoded=decipher.update(encrypted.subarray(0,-16)).toString('utf8');
  const parts=decoded.split('|');
  if (parts.length<2 || parts.some(x=>!x) || /[\u0000-\u001f]/.test(decoded)) throw Error('Request token could not be decoded with this Secure Key');
  const swapped=`${parts[1]}|${parts[0]}`;
  const cipher=crypto.createCipheriv('aes-256-gcm',key,zeroIv);
  const bytes=Buffer.concat([cipher.update(swapped,'utf8'),cipher.final(),cipher.getAuthTag()]);
  return {encryptedRequestToken:bytes.toString('base64'),customerId:parts.find(x=>/^\d+$/.test(x))||''};
}

export async function exchangeAccessToken({apiKey,secureKey,requestToken,state,vendorKey='',versionId='',fetchImpl=fetch}) {
  const prepared=prepareSessionToken(requestToken,secureKey);
  const body={apiKey:normalize(apiKey),requestToken:prepared.encryptedRequestToken,state:normalize(state)};
  if (normalize(vendorKey)) body.vendorkey=normalize(vendorKey);
  if (normalize(versionId)) body.versionId=normalize(versionId);
  const response=await fetchImpl(`${baseUrl}/skapi/services/access/token`,{
    method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','api-key':normalize(apiKey)},
    body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
  });
  const payload=await response.json().catch(()=>null);
  const token=normalize(payload?.data?.token||payload?.data?.accessToken||payload?.data?.access_token||payload?.token||payload?.accessToken||payload?.access_token);
  if (!response.ok || !token) throw Error(`Sharekhan token exchange failed (HTTP ${response.status})`);
  return {accessToken:token,customerId:normalize(payload?.data?.customerId||payload?.data?.customer_id||payload?.customerId||prepared.customerId)};
}

export async function verifySharekhanSession({apiKey,accessToken,customerId,fetchImpl=fetch}) {
  if (!customerId) return {connectionStatus:'unverified',error:'Customer ID is required to verify the Sharekhan session'};
  try {
    const response=await fetchImpl(`${baseUrl}/skapi/services/reports/${encodeURIComponent(customerId)}`,{
      method:'GET',headers:{Accept:'application/json','api-key':normalize(apiKey),'access-token':normalize(accessToken)},
      signal:AbortSignal.timeout(10000)
    });
    const payload=await response.json().catch(()=>null);
    const message=String(payload?.message||payload?.error||payload?.errormsg||payload?.data?.message||payload?.data?.errormsg||'');
    const expired=response.status===401||response.status===403||/token.*(expir|invalid|unauthor)|expir.*token|session.*(expir|invalid)|unauthori|access.?denied|invalid.?access/i.test(message);
    if(expired)return {connectionStatus:'expired',error:'Sharekhan session expired or was rejected'};
    if(!response.ok||payload?.status===false)return {connectionStatus:'unverified',error:`Sharekhan session check failed (HTTP ${response.status})`};
    return {connectionStatus:'connected',error:null};
  }catch{return {connectionStatus:'unverified',error:'Could not verify the Sharekhan session right now'};}
}

export class SharekhanAuth {
  constructor(config={},deps={}) { this.config=config; this.pending=null; this.session=null; this.connectionStatus='disconnected'; this.lastCheck=0; this.lastError=null; this.exchange=deps.exchange||exchangeAccessToken; this.probe=deps.probe||verifySharekhanSession; }
  useSavedCredentials(saved = {}) {
    const secureKey = normalize(saved.secureKey);
    if (saved.apiKey) this.config.apiKey = normalize(saved.apiKey);
    if (secureKey) { secureKeyBytes(secureKey); this.config.secureKey = secureKey; }
    this.config.customerId = normalize(saved.customerId);
    this.config.vendorKey = normalize(saved.vendorKey);
    this.config.versionId = normalize(saved.versionId);
    return this.config;
  }
  updateCredentials(input = {}) {
    this.useSavedCredentials({
      apiKey: normalize(input.apiKey) || this.config.apiKey,
      secureKey: normalize(input.secureKey) || this.config.secureKey,
      customerId: input.customerId != null ? input.customerId : this.config.customerId,
      vendorKey: input.vendorKey != null ? input.vendorKey : this.config.vendorKey,
      versionId: input.versionId != null ? input.versionId : this.config.versionId
    });
    if (!this.config.apiKey || !this.config.secureKey) throw Error('Sharekhan API Key and Secure Key are required');
    return this.logout();
  }
  credentialError() {
    if(!this.config.apiKey||!this.config.secureKey)return 'Sharekhan API Key and Secure Key are required in backend/.env';
    try{secureKeyBytes(this.config.secureKey);return null}catch{return 'Sharekhan Secure Key must be exactly 32 bytes. Recopy it from the same API app as the API Key.'}
  }
  status() {const credentialError=this.credentialError();return {configured:!credentialError,apiKey:this.config.apiKey||'',secureKey:this.config.secureKey||'',apiKeyHint:this.config.apiKey?`••••${String(this.config.apiKey).slice(-4)}`:null,connected:this.connectionStatus==='connected',expired:this.connectionStatus==='expired',connectionStatus:this.connectionStatus,customerId:this.session?.customerId||this.config.customerId||null,error:credentialError||this.lastError};}
  start() {
    const credentialError=this.credentialError();if(credentialError)throw Error(credentialError);
    const state=`gridpilot-${crypto.randomBytes(24).toString('hex')}`;
    this.pending={state,expiresAt:Date.now()+10*60_000};
    this.connectionStatus='disconnected';this.lastError=null;
    return {loginUrl:buildLoginUrl(this.config.apiKey,state,this.config.vendorKey,this.config.versionId),expiresInSeconds:600};
  }
  async verify(force=false) {
    if(!this.session?.accessToken)return this.status();
    if(!force&&Date.now()-this.lastCheck<30000)return this.status();
    this.lastCheck=Date.now();
    const result=await this.probe({apiKey:this.config.apiKey,accessToken:this.session.accessToken,customerId:this.session.customerId||this.config.customerId});
    this.connectionStatus=result.connectionStatus;this.lastError=result.error;
    if(result.connectionStatus==='expired')this.session=null;
    return this.status();
  }
  async complete({requestToken,state}) {
    if (!this.pending || this.pending.expiresAt<Date.now() || state!==this.pending.state) throw Error('Login session expired or state mismatch; start login again');
    this.pending=null;
    const session=await this.exchange({...this.config,requestToken,state});
    this.session={...session,connectedAt:new Date().toISOString()};
    return this.verify(true);
  }
  async restoreSession(session) {
    if (!session?.accessToken || !session?.customerId) throw Error('Stored Sharekhan session is incomplete');
    this.session={accessToken:session.accessToken,customerId:session.customerId,connectedAt:session.connectedAt};
    this.connectionStatus='unverified';
    this.lastCheck=0;
    return this.verify(true);
  }
  accessToken() { return this.session?.accessToken || ''; }
  logout() { this.pending=null; this.session=null; this.connectionStatus='disconnected';this.lastError=null;this.lastCheck=0;return this.status(); }
}
