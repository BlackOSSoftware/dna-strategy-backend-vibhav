import {MongoClient} from 'mongodb';
import crypto from 'node:crypto';

const documentId = 'paper';

export class StrategyStore {
  constructor(uri, dbName = 'dna-strategy', sessionEncryptionKey = '') {
    if (!uri) throw Error('MONGODB_URI is required in backend/.env');
    this.dbName = dbName;
    this.client = new MongoClient(uri, {serverSelectionTimeoutMS: 8000});
    this.sessionKey = sessionEncryptionKey ? Buffer.from(sessionEncryptionKey, 'base64') : null;
    if (this.sessionKey && this.sessionKey.length !== 32) throw Error('SHAREKHAN_SESSION_ENCRYPTION_KEY must decode to 32 bytes');
  }
  collection() { return this.client.db(this.dbName).collection('strategy_state'); }
  brokerCollection() { return this.client.db(this.dbName).collection('broker_sessions'); }
  async connect() {
    await this.client.connect();
    await this.client.db(this.dbName).command({ping: 1});
  }
  async load() {
    const doc = await this.collection().findOne({_id: documentId});
    if (!doc) return null;
    const {_id, updatedAt, ...state} = doc;
    return state;
  }
  async save(snapshot) {
    const {pnl, ...state} = snapshot;
    await this.collection().updateOne(
      {_id: documentId},
      {$set: {...state, updatedAt: new Date()}},
      {upsert: true}
    );
  }
  async saveBrokerSession(session) {
    if (!this.sessionKey) throw Error('SHAREKHAN_SESSION_ENCRYPTION_KEY is required to persist login');
    if (!session?.accessToken || !session?.customerId) throw Error('A complete Sharekhan session is required');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sessionKey, iv);
    cipher.setAAD(Buffer.from('gridpilot:sharekhan-session:v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    await this.brokerCollection().updateOne(
      {_id:'sharekhan'},
      {$set:{version:1, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:encrypted.toString('base64'), updatedAt:new Date()}},
      {upsert:true}
    );
  }
  async loadBrokerSession() {
    if (!this.sessionKey) return null;
    const doc = await this.brokerCollection().findOne({_id:'sharekhan'});
    if (!doc) return null;
    try {
      if (doc.version !== 1) throw Error('Unsupported session version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.sessionKey, Buffer.from(doc.iv, 'base64'));
      decipher.setAAD(Buffer.from('gridpilot:sharekhan-session:v1'));
      decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
      const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]).toString('utf8'));
      if (!session?.accessToken || !session?.customerId) throw Error('Incomplete session');
      return session;
    } catch {
      throw Error('Stored Sharekhan session cannot be decrypted; reconnect to Sharekhan');
    }
  }
  async clearBrokerSession() { await this.brokerCollection().deleteOne({_id:'sharekhan'}); }
}
