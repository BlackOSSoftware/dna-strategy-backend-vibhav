import test from 'node:test';
import assert from 'node:assert/strict';
import {login, signToken, verifyToken} from './auth.js';

test('default admin login issues a token and rejects a wrong password', () => {
  const token = login('admin', 'admin');
  assert.equal(verifyToken(token)?.u, 'admin');
  assert.equal(login('admin', 'wrong'), null);
  assert.equal(login('other', 'admin'), null);
  assert.equal(verifyToken(`${token}x`), null);
  assert.equal(verifyToken(signToken({u:'admin', exp:Date.now() - 1000})), null);
});
