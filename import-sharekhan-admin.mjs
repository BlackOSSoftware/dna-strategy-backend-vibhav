import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const source=process.argv[2] || 'E:\\webhook-triger-algo';
const envFile=path.join(source,'backend','.env');
const env=Object.fromEntries(fs.readFileSync(envFile,'utf8').split(/\r?\n/)
  .map(line=>line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean)
  .map(match=>[match[1],match[2].replace(/^["']|["']$/g,'')]));
if(!env.MONGODB_URI)throw Error('Source MongoDB connection is not configured');

const requireSource=createRequire(path.join(source,'backend','package.json'));
const {MongoClient}=requireSource('mongodb');
const client=new MongoClient(env.MONGODB_URI,{serverSelectionTimeoutMS:8000});
try{
  await client.connect();
  const db=client.db(env.MONGODB_DB||'webhook_trigger_algo');
  const record=await db.collection('admin_sharekhan_market_data').findOne({_id:'price-feed'},{projection:{loginKeys:1}});
  const apiKey=String(record?.loginKeys?.apiKey||'').trim();
  const secureKey=String(record?.loginKeys?.secureKey||'').trim();
  if(!apiKey||!secureKey)throw Error('Admin Sharekhan API/Secure Key were not found in source database');
  if(Buffer.byteLength(secureKey,'utf8')!==32)throw Error('Source Secure Key is not 32 bytes');
  const target=path.join(import.meta.dirname,'.env');
  const previous=fs.existsSync(target)?fs.readFileSync(target,'utf8'):'';
  const keep=previous.split(/\r?\n/).filter(line=>!/^SHAREKHAN_(API_KEY|SECURE_KEY)=/.test(line)).filter(Boolean);
  const data=[...keep,`SHAREKHAN_API_KEY=${apiKey}`,`SHAREKHAN_SECURE_KEY=${secureKey}`].join('\n')+'\n';
  fs.writeFileSync(target,data,{mode:0o600});
  console.log('Sharekhan admin API/Secure Key imported into ignored backend/.env; values were not printed.');
}finally{await client.close();}
