import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest } from '../worker/index.ts';
import { createLoginCredentials, loginCredentials } from '../worker/password.ts';
import { derivePasswordProof, PASSWORD_ITERATIONS } from '../src/password.ts';
import { sign } from '../worker/security.ts';
import type { Env } from '../worker/types.ts';
const account = 'owner@example.com'; const password = 'fixture-password-0001';
async function fixture() {
 const db = new SQLiteDatabase(); const migrations = new URL('../migrations/', import.meta.url);
 for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
 const credentials = await createLoginCredentials(account, password);
 const env: Env = { DB: db, APP_ORIGIN: 'https://panel.example.com', SESSION_SECRET: randomBytes(48).toString('base64'), MASTER_KEY: randomBytes(32).toString('base64'), LOGIN_CREDENTIALS: JSON.stringify(credentials) };
 const proof = await derivePasswordProof(password, credentials);
 const call = async (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
  const request = new Request(env.APP_ORIGIN + '/api/' + path, { method, headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.23', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const response = await handleRequest(request, env, { waitUntil() {} });
  return { status: response.status, headers: response.headers, data: await response.json() as any };
 };
 return { db, env, credentials, proof, call };
}
test('password proof follows PBKDF2-SHA256 and secrets contain no plaintext password or replayable proof', async () => {
 const f = await fixture();
 assert.equal(f.proof, pbkdf2Sync(password, Buffer.from(f.credentials.salt, 'base64'), PASSWORD_ITERATIONS, 32, 'sha256').toString('base64'));
 assert.ok(!f.env.LOGIN_CREDENTIALS!.includes(password)); assert.notEqual(f.credentials.verifier, f.proof);
 const state = await f.call('session'); assert.equal(state.data.configured, true); assert.equal(state.data.login, null);
 for (const secret of [password, f.proof, f.credentials.verifier, f.credentials.pepper, account]) assert.ok(!JSON.stringify(state.data).includes(secret));
 assert.deepEqual(state.data.password_kdf, { salt: f.credentials.salt, iterations: PASSWORD_ITERATIONS });
 assert.equal((await f.call('auth/login', 'POST', { email: account, proof: f.credentials.verifier })).status, 401); f.db.close();
});
test('correct login returns a secure 30-day session and only it can access the private panel', async () => {
 const f = await fixture(); assert.equal((await f.call('panel')).status, 401);
 const response = await f.call('auth/login', 'POST', { email: ' OWNER@EXAMPLE.COM ', proof: f.proof }); assert.equal(response.status, 200);
 const cookie = response.headers.get('Set-Cookie')!;
 for (const flag of ['__Host-relay_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000', 'Path=/']) assert.ok(cookie.includes(flag));
 const headers = { Cookie: cookie.split(';')[0] };
 assert.equal((await f.call('panel', 'GET', undefined, headers)).status, 200); assert.equal((await f.call('session', 'GET', undefined, headers)).data.login, account);
 assert.equal((await f.call('auth/logout', 'POST', {}, headers)).headers.get('Set-Cookie')?.includes('Max-Age=0'), true);
 assert.equal((await f.call('panel')).status, 401);
 const storage = JSON.stringify(f.db.connection.prepare('SELECT * FROM settings').all()) + JSON.stringify(f.db.connection.prepare('SELECT * FROM login_limits').all());
 for (const secret of [password, f.proof, f.credentials.verifier, f.credentials.pepper]) assert.ok(!storage.includes(secret)); f.db.close();
});
test('wrong account, wrong password and malformed proofs return the same message; login requires same-origin POST', async () => {
 const f = await fixture(); const wrong = await derivePasswordProof('different-fixture-password', f.credentials);
 for (const value of [{ email: 'another@example.com', proof: f.proof }, { email: account, proof: wrong }, { email: account, proof: 'malformed' }]) {
  const result = await f.call('auth/login', 'POST', value); assert.equal(result.status, 401); assert.equal(result.data.error, '账号或密码不正确'); assert.equal(result.headers.get('Set-Cookie'), null);
 }
 const before = f.db.connection.prepare('SELECT attempts FROM login_limits').all();
 assert.equal((await f.call('auth/login', 'POST', { email: account, proof: f.proof }, { Origin: 'https://evil.example' })).status, 403);
 assert.equal((await f.call('auth/login', 'POST', { email: account, proof: f.proof }, { Origin: '' })).status, 403);
 assert.deepEqual(f.db.connection.prepare('SELECT attempts FROM login_limits').all(), before);
 assert.equal((await f.call('auth/login')).status, 405); assert.equal((await f.call('auth/callback')).status, 410); f.db.close();
});
test('login failures are rate limited atomically, expire after 15 minutes, and do not store raw IPs', async () => {
 const f = await fixture();
 const results = await Promise.all(Array.from({ length: 8 }, () => f.call('auth/login', 'POST', { email: account, proof: 'invalid' })));
 assert.equal(results.filter(r => r.status === 401).length, 5); assert.equal(results.filter(r => r.status === 429).length, 3);
 assert.equal((await f.call('auth/login', 'POST', { email: account, proof: f.proof })).status, 429);
 assert.ok(!JSON.stringify(f.db.connection.prepare('SELECT * FROM login_limits').all()).includes('203.0.113.23'));
 f.db.connection.prepare('UPDATE login_limits SET reset_at=?').run(Date.now() - 1);
 assert.equal((await f.call('auth/login', 'POST', { email: account, proof: f.proof })).status, 200);
 assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM login_limits WHERE bucket LIKE 'ip:%'").get()!.n, 0); f.db.close();
});
test('successful login clears preceding failures, and a changed credential or expired session requires login again', async () => {
 const f = await fixture(); await f.call('auth/login', 'POST', { email: account, proof: 'invalid' });
 const response = await f.call('auth/login', 'POST', { email: account, proof: f.proof }); assert.equal(response.status, 200);
 assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM login_limits WHERE bucket LIKE 'ip:%'").get()!.n, 0);
 const cookie = { Cookie: response.headers.get('Set-Cookie')!.split(';')[0] };
 f.env.LOGIN_CREDENTIALS = JSON.stringify(await createLoginCredentials(account, 'replacement-fixture-password'));
 assert.equal((await f.call('panel', 'GET', undefined, cookie)).status, 401);
 const current = loginCredentials(f.env)!;
 const expired = await sign({ type: 'password', id: account, login: account, revision: current.revision, expires: Date.now() - 1000 }, f.env);
 assert.equal((await f.call('panel', 'GET', undefined, { Cookie: '__Host-relay_session=' + expired })).status, 401);
 f.env.LOGIN_CREDENTIALS = ''; assert.equal((await f.call('auth/login', 'POST', { email: account, proof: f.proof })).status, 503); f.db.close();
});
