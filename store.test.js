import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {StrategyStore} from './store.js';

test('Sharekhan session is encrypted in MongoDB and can be restored', async () => {
  const key=crypto.randomBytes(32).toString('base64');
  let saved=null;
  const collection={
    async updateOne(_filter,update){saved=update.$set;},
    async findOne(){return saved;},
    async deleteOne(){saved=null;}
  };
  const store=new StrategyStore('mongodb://127.0.0.1:27017','test',key);
  store.brokerCollection=()=>collection;
  const session={accessToken:'private-token',customerId:'12345',connectedAt:'2026-10-06T07:00:00Z'};
  await store.saveBrokerSession(session);
  assert.equal(saved.version,1);
  assert.equal(JSON.stringify(saved).includes(session.accessToken),false);
  assert.deepEqual(await store.loadBrokerSession(),session);
  await store.clearBrokerSession();
  assert.equal(await store.loadBrokerSession(),null);
  await store.client.close();
});

test('Sharekhan credentials are encrypted in MongoDB and can be restored', async () => {
  const key=crypto.randomBytes(32).toString('base64');
  let saved=null;
  const collection={async updateOne(_filter,update){saved=update.$set;},async findOne(){return saved;}};
  const store=new StrategyStore('mongodb://127.0.0.1:27017','test',key);
  store.credentialCollection=()=>collection;
  const credentials={apiKey:'api-key-value',secureKey:'12345678901234567890123456789012',customerId:'1464067',loginId:'pandurangs22',vendorKey:'',versionId:''};
  await store.saveSharekhanCredentials(credentials);
  assert.equal(JSON.stringify(saved).includes(credentials.apiKey),false);
  assert.equal(JSON.stringify(saved).includes(credentials.secureKey),false);
  assert.deepEqual(await store.loadSharekhanCredentials(),credentials);
  await store.client.close();
});
test('wrong encryption key cannot restore a Sharekhan session', async () => {
  let saved=null;
  const collection={async updateOne(_filter,update){saved=update.$set;},async findOne(){return saved;}};
  const first=new StrategyStore('mongodb://127.0.0.1:27017','test',crypto.randomBytes(32).toString('base64'));
  const second=new StrategyStore('mongodb://127.0.0.1:27017','test',crypto.randomBytes(32).toString('base64'));
  first.brokerCollection=second.brokerCollection=()=>collection;
  await first.saveBrokerSession({accessToken:'private-token',customerId:'12345'});
  await assert.rejects(()=>second.loadBrokerSession(),/cannot be decrypted/);
  await first.client.close();
  await second.client.close();
});
