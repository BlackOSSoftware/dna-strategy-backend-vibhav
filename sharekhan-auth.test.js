import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {SharekhanAuth,buildLoginUrl,exchangeAccessToken,extractRequestToken,verifySharekhanSession} from './sharekhan-auth.js';

const key='12345678901234567890123456789012';
test('restored Sharekhan session is verified before being marked connected', async () => {
  const auth=new SharekhanAuth({apiKey:'demo-key',secureKey:key},{probe:async ({accessToken}) => {
    assert.equal(accessToken,'stored-token');
    return {connectionStatus:'connected',error:null};
  }});
  const status=await auth.restoreSession({accessToken:'stored-token',customerId:'12345'});
  assert.equal(status.connected,true);
  assert.equal(auth.accessToken(),'stored-token');
});
function requestToken(plain){
  const cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(key),Buffer.alloc(16));
  return Buffer.concat([cipher.update(plain,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
}
test('login URL carries a fresh state and no secure key',()=>{
  const auth=new SharekhanAuth({apiKey:'demo-key',secureKey:key});
  const first=auth.start().loginUrl,second=auth.start().loginUrl;
  assert.notEqual(new URL(first).searchParams.get('state'),new URL(second).searchParams.get('state'));
  assert.equal(new URL(first).searchParams.get('api_key'),'demo-key');
  assert.ok(!first.includes(key));
});
test('request token can be pasted as callback URL',()=>{
  const token=requestToken('request-id|12345');
  assert.equal(extractRequestToken(`https://example.com/callback?requestToken=${encodeURIComponent(token)}`),token);
});
test('token exchange sends swapped encrypted request and keeps access token server side',async()=>{
  const raw=requestToken('request-id|12345');
  let sent;
  const fetchImpl=async(_url,options)=>{sent=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({data:{token:'access-only-on-server'}})}};
  const result=await exchangeAccessToken({apiKey:'demo-key',secureKey:key,requestToken:raw,state:'state-1',fetchImpl});
  assert.equal(result.accessToken,'access-only-on-server');
  assert.equal(result.customerId,'12345');
  assert.notEqual(sent.requestToken,raw);
  assert.equal(sent.state,'state-1');
});
test('credentials can be replaced without returning the secure key',()=>{
  const auth=new SharekhanAuth({apiKey:'demo-key',secureKey:key,customerId:'111'});
  const status=auth.updateCredentials({apiKey:'new-key-value',secureKey:key,customerId:'222'});
  assert.equal(auth.config.apiKey,'new-key-value');
  assert.equal(auth.config.customerId,'222');
  assert.equal(status.apiKeyHint,'••••alue');
  assert.equal(JSON.stringify(status).includes(key),false);
  assert.throws(()=>auth.updateCredentials({secureKey:'short'}),/32 bytes/);
});
test('invalid Secure Key is not shown as ready',()=>{
  const auth=new SharekhanAuth({apiKey:'demo-key',secureKey:'x'.repeat(33)});
  assert.equal(auth.status().configured,false);
  assert.match(auth.status().error,/32 bytes/);
  assert.throws(()=>auth.start(),/32 bytes/);
});
test('broker probe distinguishes connected and expired sessions',async()=>{
  const base={apiKey:'demo-key',accessToken:'token',customerId:'12345'};
  const connected=await verifySharekhanSession({...base,fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[]})})});
  const expired=await verifySharekhanSession({...base,fetchImpl:async()=>({ok:false,status:401,json:async()=>({message:'Token expired'})})});
  assert.equal(connected.connectionStatus,'connected');
  assert.equal(expired.connectionStatus,'expired');
});
test('login is connected only after broker verifies the token',async()=>{
  const auth=new SharekhanAuth({apiKey:'demo-key',secureKey:key},{exchange:async()=>({accessToken:'token',customerId:'12345'}),probe:async()=>({connectionStatus:'connected',error:null})});
  const state=new URL(auth.start().loginUrl).searchParams.get('state');
  assert.equal((await auth.complete({requestToken:'sample',state})).connected,true);
  auth.probe=async()=>({connectionStatus:'expired',error:'Session expired'});
  assert.equal((await auth.verify(true)).expired,true);
  assert.equal(auth.status().connected,false);
});
