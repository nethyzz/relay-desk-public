import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest } from '../worker/index.ts';
import { BASELINES } from '../src/shared.ts';
import { row, rows } from '../worker/data.ts';
import { createLoginCredentials } from '../worker/password.ts';
import { sign } from '../worker/security.ts';
import type { Env } from '../worker/types.ts';

const secret = 'sk-batch-edit-test-secret-123456';
function fixture(t: TestContext) {
 const db = new SQLiteDatabase(); t.after(() => db.close());
 const migrations = new URL('../migrations/', import.meta.url);
 for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
 const env: Env = { DB: db, APP_ORIGIN: 'http://127.0.0.1:5173', DEV_MODE: 'local', LOCAL_RUNNER_READY: '1', LOCAL_RUNNER_TOKEN: 'fixture-local-runner', MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
 const dispatches: Promise<unknown>[] = []; const ctx = { waitUntil(p: Promise<unknown>) { dispatches.push(p); } };
 const call = async (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
  const response = await handleRequest(new Request('http://127.0.0.1:8787/api/' + path, { method, headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', ...headers }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) }), env, ctx);
  return { status: response.status, data: await response.json() as any };
 };
 const endpoint = async (base = 'https://relay.example.com/v1', key = secret, group = 'default') => {
  const response = await call('endpoints', 'POST', { name: '验证中转站', base_url: base, key, group_id: group }); assert.equal(response.status, 200); return response.data.id as string;
 };
 const target = async (ep: string, claimed = BASELINES.gpt.models[0], protocol = 'gpt', tier = 'medium', model = 'relay-custom-alias') => {
  const response = await call('targets', 'POST', { endpoint_id: ep, name: '验证检测目标', claimed_model: claimed, request_model: model, protocol, tier }); assert.equal(response.status, 200); return response.data.id as string;
 };
 const edit = (targetIds: string[], changes: unknown, sync_request_model?: boolean) => call('targets/batch', 'POST', { targetIds, changes, ...(sync_request_model !== undefined ? { sync_request_model } : {}) });
 return { db, env, ctx, dispatches, call, endpoint, target, edit };
}

test('batch edits only selected model fields, deduplicates IDs and counts changed targets', async t => {
 const f = fixture(t); const ep = await f.endpoint();
 const a = await f.target(ep, 'gpt-6-sol', 'gpt', 'low'); const b = await f.target(ep, 'gpt-6-sol', 'gpt', 'high'); const c = await f.target(ep);
 const before = await rows(f.env, 'SELECT * FROM targets ORDER BY id');
 const result = await f.edit([a, b, a], { tier: 'high' }); assert.deepEqual(result, { status: 200, data: { ok: true, updated: 1 } });
 const after = await rows(f.env, 'SELECT * FROM targets ORDER BY id');
 assert.deepEqual(after.map(value => ({ ...value })), before.map(value => ({ ...value, ...(value.id === a ? { tier: 'high' } : {}) })));
 assert.equal((await row(f.env, 'SELECT tier FROM targets WHERE id=?', c))!.tier, 'medium');
 const next = await f.edit([a, b], { claimed_model: 'gpt-6.1-sol' }); assert.equal(next.data.updated, 2);
 assert.ok((await rows(f.env, 'SELECT request_model FROM targets WHERE id IN (?,?)', a, b)).every(value => value.request_model === 'relay-custom-alias'));
 assert.equal((await f.edit([a, b], { claimed_model: 'gpt-6.1-sol' })).status, 400);
 assert.equal(f.dispatches.length, 0); assert.equal((await rows(f.env, 'SELECT * FROM quota_reservations')).length, 0);
});

test('batch sync computes Claude aliases separately for regular relays and OpenRouter', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const router = await f.endpoint('https://openrouter.ai/api/v1');
 const a = await f.target(ep); const b = await f.target(router);
 assert.equal((await f.edit([a, b], { protocol: 'claude-chat', claimed_model: 'claude-fable-5.1', tier: 'low' }, true)).status, 200);
 const regular = await row(f.env, 'SELECT * FROM targets WHERE id=?', a); const openrouter = await row(f.env, 'SELECT * FROM targets WHERE id=?', b);
 assert.equal(regular!.request_model, 'claude-fable-5-1'); assert.equal(openrouter!.request_model, 'anthropic/claude-fable-5.1');
 assert.ok([regular, openrouter].every(value => value!.protocol === 'claude-chat' && value!.claimed_model === 'claude-fable-5.1' && value!.tier === 'low'));
 assert.equal((await f.edit([a, b], { protocol: 'claude', claimed_model: 'claude-opus-5.5' }, true)).status, 200);
 assert.equal((await row(f.env, 'SELECT request_model FROM targets WHERE id=?', a))!.request_model, 'claude-opus-5-5');
 assert.equal((await row(f.env, 'SELECT request_model FROM targets WHERE id=?', b))!.request_model, 'anthropic/claude-opus-5.5');
});

test('batch edits repair unsupported targets and also permit custom models to be saved', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint(), 'not-in-baseline');
 assert.equal((await f.call('runs', 'POST', { targetIds: [a] })).status, 400);
 assert.equal((await f.edit([a], { claimed_model: 'gpt-6.1-sol' }, true)).status, 200);
 const saved = await row(f.env, 'SELECT * FROM targets WHERE id=?', a); assert.equal(saved!.request_model, 'gpt-6.1-sol');
 assert.equal((await f.edit([a], { claimed_model: 'new-custom-model', request_model: 'paid-relay-alias' })).status, 200);
 assert.equal((await row(f.env, 'SELECT claimed_model FROM targets WHERE id=?', a))!.claimed_model, 'new-custom-model');
 assert.equal((await f.call('runs', 'POST', { targetIds: [a] })).status, 400);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 0); assert.equal(f.dispatches.length, 0);
});

test('batch edits preserve groups, keys, schedules, budgets and frozen active and historical runs', async t => {
 const f = fixture(t); const group = (await f.call('groups', 'POST', { name: '0.08' })).data.id;
 const ep = await f.endpoint('https://relay.example.com/v1', secret, group); const a = await f.target(ep, 'gpt-6-sol'); const b = await f.target(ep);
 await f.call('schedules/' + a, 'PUT', { enabled: true, kind: 'interval', interval_minutes: 360, tier: 'low' });
 const old = await f.call('runs', 'POST', { targetIds: [a], tier: 'low' }); assert.equal(old.status, 202);
 await f.env.DB.prepare("UPDATE runs SET status='completed',ended_at=?,report=? WHERE id=?").bind(Date.now(), JSON.stringify({ fingerprint: { verdict: 'match', valid_samples: 32 } }), old.data.runIds[0]).run();
 const active = await f.call('runs', 'POST', { targetIds: [a, b], tier: 'low' }); assert.equal(active.status, 202);
 const tables = ['groups', 'endpoints', 'schedules', 'runs', 'batches', 'quota_reservations', 'run_sets', 'run_set_members', 'settings', 'notices'];
 const before = await Promise.all(tables.map(table => rows(f.env, 'SELECT * FROM ' + table + ' ORDER BY rowid')));
 const dispatchCount = f.dispatches.length;
 assert.deepEqual(await f.edit([a, b], { protocol: 'gpt-chat', claimed_model: 'gpt-6.1-sol', tier: 'high' }, true), { status: 200, data: { ok: true, updated: 2 } });
 const after = await Promise.all(tables.map(table => rows(f.env, 'SELECT * FROM ' + table + ' ORDER BY rowid'))); assert.deepEqual(after, before); assert.equal(f.dispatches.length, dispatchCount);
 const claim = await f.call(`runner/batches/${active.data.runId}/claim`, 'POST', {}, { 'X-Local-Runner': f.env.LOCAL_RUNNER_TOKEN!, 'X-Local-Run': 'batch-edit-fixture' }); assert.equal(claim.status, 200);
 assert.ok(claim.data.jobs.every((job: any) => job.config.protocol === 'gpt' && job.config.tier === 'low' && job.config.request_model === 'relay-custom-alias' && job.api_key === secret));
 assert.equal(claim.data.jobs.find((job: any) => job.config.claimed_model === 'gpt-6-sol').config.baseline_version, '4.5.4-predictive.20260924.2');
});

test('missing IDs and malformed partial updates leave every selected target unchanged', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint()); const before = await rows(f.env, 'SELECT * FROM targets');
 const invalid = [
  { targetIds: [], changes: { tier: 'low' } }, { targetIds: [a, 'missing'], changes: { tier: 'low' } },
  { targetIds: [a], changes: {} }, { targetIds: [a], changes: null }, { targetIds: [a], changes: [] },
  { targetIds: [a], changes: { name: 'not-allowed' } }, { targetIds: [a], changes: { endpoint_id: 'not-allowed' } },
  { targetIds: [a], changes: { group_id: 'default' } }, { targetIds: [a], changes: { key: secret } },
  { targetIds: [a], changes: { tier: ['low'] } }, { targetIds: [a], changes: { tier: 0 } }, { targetIds: [a], changes: { tier: 'invalid' } },
  { targetIds: [a], changes: { protocol: 'toString' } }, { targetIds: [a], changes: { protocol: 'unknown' } },
  { targetIds: [a], changes: { request_model: '' } }, { targetIds: [a], changes: { claimed_model: 'bad\nmodel' } },
  { targetIds: [a], changes: { request_model: 'x'.repeat(257) } }, { targetIds: [a], changes: { request_model: null } },
  { targetIds: [a], changes: {}, sync_request_model: 'yes' },
  { targetIds: [a], changes: { request_model: 'alias' }, sync_request_model: true },
  { targetIds: [a], changes: { tier: 'low' }, extra: true },
  { targetIds: [a, 42], changes: { tier: 'low' } },
  { targetIds: [a, 'a', 'b', 'c', 'd', 'e'], changes: { tier: 'low' } },
 ];
 for (const body of invalid) {
  const result = await f.call('targets/batch', 'POST', body); assert.ok([400, 404].includes(result.status), JSON.stringify(body));
  assert.deepEqual(await rows(f.env, 'SELECT * FROM targets'), before);
 }
 assert.equal(f.dispatches.length, 0);
});

test('a secret in any final model config rejects the entire batch and never echoes the key', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint()); const privateKey = 'sk-second-batch-edit-secret-9876'; const b = await f.target(await f.endpoint('https://second.example.com/v1', privateKey));
 const before = await rows(f.env, 'SELECT * FROM targets ORDER BY id');
 const rejected = await f.edit([a, b], { request_model: privateKey }); assert.equal(rejected.status, 400); assert.ok(!JSON.stringify(rejected.data).includes(privateKey));
 assert.deepEqual(await rows(f.env, 'SELECT * FROM targets ORDER BY id'), before);
 await f.env.DB.prepare('UPDATE targets SET name=? WHERE id=?').bind('invalid-' + privateKey, b).run();
 const badName = await f.edit([a, b], { tier: 'high' }); assert.equal(badName.status, 400); assert.ok(!JSON.stringify(badName.data).includes(privateKey));
 assert.equal((await row(f.env, 'SELECT tier FROM targets WHERE id=?', a))!.tier, 'medium');
});

test('database failure in the second update rolls back the first model edit', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const a = await f.target(ep); const b = await f.target(ep);
 const before = await rows(f.env, 'SELECT * FROM targets ORDER BY id');
 f.db.exec(`CREATE TRIGGER reject_batch_fixture BEFORE UPDATE ON targets WHEN NEW.id='${b}' BEGIN SELECT RAISE(ABORT, 'synthetic batch failure'); END;`);
 assert.equal((await f.edit([a, b], { tier: 'high' })).status, 500);
 assert.deepEqual(await rows(f.env, 'SELECT * FROM targets ORDER BY id'), before);
});

test('batch edit requires owner login and a same-origin request', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint()); const before = await rows(f.env, 'SELECT * FROM targets');
 const env = { ...f.env, DEV_MODE: undefined, APP_ORIGIN: 'https://panel.example.com' };
 const credentials = await createLoginCredentials('owner@example.com', 'fixture-password-0001'); env.LOGIN_CREDENTIALS = JSON.stringify(credentials);
 const signed = await sign({ type: 'password', id: credentials.email, login: credentials.email, revision: credentials.revision, expires: Date.now() + 60000 }, env);
 const body = JSON.stringify({ targetIds: [a], changes: { tier: 'low' } });
 const anonymous = new Request(env.APP_ORIGIN + '/api/targets/batch', { method: 'POST', headers: { Origin: env.APP_ORIGIN }, body }); assert.equal((await handleRequest(anonymous, env, f.ctx)).status, 401);
 for (const origin of ['https://evil.example.com', '']) {
  const badOrigin = new Request(env.APP_ORIGIN + '/api/targets/batch', { method: 'POST', headers: { Origin: origin, Cookie: '__Host-relay_session=' + signed }, body }); assert.equal((await handleRequest(badOrigin, env, f.ctx)).status, 403);
 }
 assert.deepEqual(await rows(f.env, 'SELECT * FROM targets'), before);
 const authenticated = new Request(env.APP_ORIGIN + '/api/targets/batch', { method: 'POST', headers: { Origin: env.APP_ORIGIN, Cookie: '__Host-relay_session=' + signed }, body }); assert.equal((await handleRequest(authenticated, env, f.ctx)).status, 200);
});
