import crypto from 'node:crypto';

const secret = () => process.env.AUTH_SECRET || 'gridpilot-auth';
const username = () => process.env.AUTH_USERNAME || 'admin';
const password = () => process.env.AUTH_PASSWORD || 'admin';

function same(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (!same(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.u || !payload?.exp || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function login(id, passphrase) {
  if (!same(String(id ?? '').trim(), username()) || !same(passphrase, password())) return null;
  return signToken({u: username(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000});
}

export function tokenFrom(req, url) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return url?.searchParams?.get('token') || '';
}
