import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest } from '../worker/index.ts';
import { row, rows } from '../worker/data.ts';
import { createLoginCredentials } from '../worker/password.ts';
import { sign } from '../worker/security.ts';
import type { Env } from '../worker/types.ts';
import { cloneConfiguration, clonePreviews, detectionModelGroups, monitorSettings, type CloneInput } from '../src/target-cloning.ts';
import { endpointsInScope, targetsInScope, type PanelData } from '../src/shared.ts';

const secret = 'sk-clone-fixture-secret-123456';
function fixture(t: TestContext) {
 const db = new SQLiteDatabase(); t.after(() => db.close());
 for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
 const env: Env = { DB: db, APP_ORIGIN: 'http://127.0.0.1:5173', DEV_MODE: 'local', LOCAL_PREVIEW_ONLY: '1', MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
 const pending: Promise<unknown>[] = []; const ctx = { waitUntil(value: Promise<unknown>) { pending.push(value); } };
 const call = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await handleRequest(new Request('http://127.0.0.1:8787/api/' + path, { method, headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
  return { status: response.status, data: await response.json() as any };
 };
 const panel = async () => (await call('panel')).data as PanelData;
 const group = async (name: string) => (await call('groups', 'POST', { name })).data.id as string;
 const endpoint = async (base_url = 'https://relay.example.com/v1', group_id = 'default', name = '普通 Key') => (await call('endpoints', 'POST', { name, station_name: name + ' 中转站', base_url, group_id, key: secret })).data.id as string;
 const target = async (endpoint_id: string, name = '测试目标', protocol = 'gpt', tier = 'medium', claimed_model = 'gpt-6.1-sol', request_model = claimed_model) => (await call('targets', 'POST', { name, endpoint_id, protocol, tier, claimed_model, request_model })).data.id as string;
 const request = async (ids: string[], claimed_model = 'gpt-6-astra', overrides: Record<string, string> = {}): Promise<CloneInput> => {
  const data = await panel();
  return { operation_id: crypto.randomUUID(), claimed_model, sources: ids.map(source_id => {
   const source = data.targets.find(target => target.id === source_id)!; const ep = data.endpoints.find(endpoint => endpoint.id === source.endpoint_id)!;
   return { source_id, configuration: cloneConfiguration(source, ep, data.schedules.find(schedule => schedule.target_id === source_id)), ...(overrides[source_id] === undefined ? {} : { request_model: overrides[source_id] }) };
  }) };
 };
 const clone = (input: CloneInput) => call('targets/clone', 'POST', input);
 return { db, env, call, pending, panel, group, endpoint, target, request, clone };
}

test('model scope groups across relay stations, Keys and groups while preserving other scopes', async t => {
 const f = fixture(t); const a = await f.endpoint(); const g = await f.group('0.08'); const b = await f.endpoint('https://second.example.com/v1', g);
 const one = await f.target(a); const two = await f.target(b, '第二家'); const other = await f.target(a, 'Astra', 'gpt-chat', 'low', 'gpt-6-astra');
 const data = await f.panel();
 assert.deepEqual(targetsInScope(data.targets, data.endpoints, { kind: 'model', value: 'gpt-6.1-sol' }).map(target => target.id).sort(), [one, two].sort());
 assert.deepEqual(endpointsInScope(data.endpoints, { kind: 'model', value: 'gpt-6-astra' }, data.targets).map(endpoint => endpoint.id), [a]);
 assert.equal(targetsInScope(data.targets, data.endpoints, { kind: 'group', value: g })[0].id, two);
 assert.equal(targetsInScope(data.targets, data.endpoints, { kind: 'station', value: 'https://relay.example.com/v1' }).length, 2);
 assert.equal(targetsInScope(data.targets, data.endpoints, { kind: 'model', value: 'all' }).length, 3);
 assert.equal(detectionModelGroups(data.targets).find(group => group.model === 'gpt-6.1-sol')!.count, 2);
 assert.equal(detectionModelGroups(data.targets).find(group => group.model === 'gpt-6-luna')!.count, 0);
 assert.equal(data.targets.find(target => target.id === other)!.protocol, 'gpt-chat');
});

test('copy changes only model fields across stations, preserves Keys, groups, names, protocols, tiers and monitoring', async t => {
 const f = fixture(t); const g = await f.group('0.08');
 const a = await f.target(await f.endpoint(), '主力', 'gpt', 'high'); const b = await f.target(await f.endpoint('https://second.example.com/v1', g, '另一 Key'), '备用', 'gpt-chat', 'low');
 await f.call('schedules/' + a, 'PUT', { enabled: true, kind: 'daily', daily_time: '09:30', interval_minutes: 90, tier: 'medium' });
 const before = await f.panel(); const ciphertext = await rows(f.env, 'SELECT id,key_cipher FROM endpoints ORDER BY id');
 const copied = await f.clone(await f.request([a, b])); assert.equal(copied.status, 200); assert.equal(copied.data.created, 2); assert.equal(copied.data.reused, 0);
 const after = await f.panel(); assert.equal(after.targets.length, 4); assert.deepEqual(after.endpoints, before.endpoints);
 for (const id of [a, b]) {
  const original = before.targets.find(target => target.id === id)!;
  assert.deepEqual(after.targets.find(target => target.id === id), original);
  const copy = after.targets.find(target => copied.data.target_ids.includes(target.id) && target.endpoint_id === original.endpoint_id)!;
  assert.deepEqual({ ...copy, id: original.id, created_at: original.created_at, claimed_model: original.claimed_model, request_model: original.request_model }, original);
  assert.equal(copy.claimed_model, 'gpt-6-astra'); assert.equal(copy.request_model, 'gpt-6-astra');
  const sourcePlan = before.schedules.find(schedule => schedule.target_id === original.id)!;
  const newPlan = after.schedules.find(schedule => schedule.target_id === copy.id)!;
  assert.deepEqual(monitorSettings(newPlan), monitorSettings(sourcePlan));
  assert.equal(newPlan.last_error, null);
  if (newPlan.enabled) assert.ok(newPlan.next_due! > Date.now());
 }
 assert.deepEqual(await rows(f.env, 'SELECT id,key_cipher FROM endpoints ORDER BY id'), ciphertext);
 assert.equal(after.runs.length, 0); assert.deepEqual(after.usage, before.usage); assert.equal(f.pending.length, 0);
 assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 0);
 assert.ok(!JSON.stringify(copied.data).includes(secret)); assert.ok(!JSON.stringify(after).includes(secret));
});

test('receipt makes retries and concurrent identical clicks idempotent without overwriting copied edits', async t => {
 const f = fixture(t); const source = await f.target(await f.endpoint()); const input = await f.request([source]);
 const [one, two] = await Promise.all([f.clone(input), f.clone(input)]);
 assert.equal(one.status, 200); assert.deepEqual(two, one); assert.equal((await f.panel()).targets.length, 2);
 const saved = one.data.target_ids[0];
 await f.env.DB.prepare("UPDATE targets SET tier='low' WHERE id=?").bind(saved).run();
 const retry = await f.clone(input); assert.deepEqual(retry, one);
 assert.equal((await row(f.env, 'SELECT tier FROM targets WHERE id=?', saved))!.tier, 'low');
 assert.equal((await rows(f.env, 'SELECT * FROM target_clone_requests')).length, 1);
 const changed = await f.clone({ ...input, claimed_model: 'gpt-6-luna' }); assert.equal(changed.status, 409);
 assert.equal((await f.panel()).targets.length, 2);
});

test('same destination is reused across separate operations and duplicate equivalent sources create one target', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const a = await f.target(ep); const b = await f.target(ep, '测试目标', 'gpt', 'medium', 'gpt-5.6-terra');
 const copied = await f.clone(await f.request([a, b])); assert.equal(copied.status, 200); assert.equal(copied.data.created, 1); assert.equal(copied.data.target_ids.length, 1);
 const again = await f.clone(await f.request([a, b])); assert.equal(again.data.created, 0); assert.equal(again.data.reused, 1); assert.deepEqual(again.data.target_ids, copied.data.target_ids);
 assert.equal((await f.panel()).targets.length, 3);
});

test('simultaneous separate operations reuse the same new target and keep copied monitoring settings', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint());
 await f.call('schedules/' + a, 'PUT', { enabled: true, interval_minutes: 120, tier: 'high' });
 const [one, two] = await Promise.all([f.clone(await f.request([a])), f.clone(await f.request([a]))]);
 assert.equal(one.status, 200); assert.equal(two.status, 200);
 assert.deepEqual(one.data.target_ids, two.data.target_ids); assert.equal(one.data.created + two.data.created, 1);
 const monitor = (await f.panel()).schedules.find(schedule => schedule.target_id === one.data.target_ids[0])!;
 assert.equal(monitor.enabled, true); assert.equal(monitor.interval_minutes, 120); assert.equal(monitor.tier, 'high');
});

test('Claude copies keep both Messages and Chat protocols and derive aliases per relay', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint(), 'Claude 普通', 'claude', 'low', 'claude-fable-5.1', 'claude-fable-5-1');
 const b = await f.target(await f.endpoint('https://openrouter.ai/api/v1'), 'Claude Router', 'claude-chat', 'high', 'claude-fable-5.1', 'anthropic/claude-fable-5.1');
 const copied = await f.clone(await f.request([a, b], 'claude-opus-5.5')); assert.equal(copied.status, 200);
 const copies = (await f.panel()).targets.filter(target => copied.data.target_ids.includes(target.id));
 assert.equal(copies.find(target => target.protocol === 'claude')!.request_model, 'claude-opus-5-5');
 assert.equal(copies.find(target => target.protocol === 'claude-chat')!.request_model, 'anthropic/claude-opus-5.5');
 assert.ok(copies.every(target => target.claimed_model === 'claude-opus-5.5'));
});

test('custom request aliases and unlisted models can be saved, cross-family sources fail without partial copies', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const a = await f.target(ep); const c = await f.target(ep, 'Claude', 'claude', 'low', 'claude-fable-5.1');
 const copied = await f.clone(await f.request([a], 'custom-claimed-v2', { [a]: 'paid-model-alias' })); assert.equal(copied.status, 200);
 const target = (await f.panel()).targets.find(target => target.id === copied.data.target_ids[0])!;
 assert.equal(target.request_model, 'paid-model-alias'); assert.equal(target.claimed_model, 'custom-claimed-v2');
 const incompatible = await f.clone(await f.request([a, c], 'gpt-6-luna')); assert.equal(incompatible.status, 400);
 assert.equal((await f.panel()).targets.length, 3);
});

test('old dialog cannot silently use modified model, group, Key or monitor configuration', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const a = await f.target(ep);
 for (const mutate of [
  () => f.env.DB.prepare("UPDATE targets SET tier='high' WHERE id=?").bind(a).run(),
  () => f.env.DB.prepare('UPDATE endpoints SET updated_at=updated_at+1 WHERE id=?').bind(ep).run(),
  () => f.env.DB.prepare('UPDATE schedules SET interval_minutes=interval_minutes+5 WHERE target_id=?').bind(a).run(),
 ]) {
  const input = await f.request([a]); await mutate(); const copied = await f.clone(input); assert.equal(copied.status, 409);
  assert.equal((await f.panel()).targets.length, 1); assert.equal((await rows(f.env, 'SELECT * FROM target_clone_requests')).length, 0);
 }
});

test('changes racing the transaction roll back every relay copy and the receipt', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint()); const b = await f.target(await f.endpoint('https://second.example.com/v1'));
 const input = await f.request([a, b]); const batch = f.db.batch.bind(f.db); let changed = false;
 f.db.batch = async statements => {
  if (!changed) { changed = true; await f.db.prepare("UPDATE targets SET name='已更名' WHERE id=?").bind(b).run(); }
  return batch(statements);
 };
 const copied = await f.clone(input); assert.equal(copied.status, 409);
 assert.equal((await f.panel()).targets.length, 2); assert.equal((await rows(f.env, 'SELECT * FROM target_clone_requests')).length, 0);
});

test('deleted sources cannot be copied, and retrying a finished receipt cannot restore a deleted copy', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint()); const input = await f.request([a]);
 const copied = await f.clone(input); const targetId = copied.data.target_ids[0];
 assert.equal((await f.call('targets/' + targetId, 'DELETE', { confirm: true, targetIds: [targetId], endpointIds: [] })).status, 200);
 assert.equal((await f.clone(input)).status, 200); assert.equal((await f.panel()).targets.length, 1);
 const stale = await f.request([a]);
 assert.equal((await f.call('targets/' + a, 'DELETE', { confirm: true, targetIds: [a], endpointIds: [] })).status, 200);
 assert.equal((await f.clone(stale)).status, 404);
});

test('saving many copies is independent of detection budgets and uses bounded D1 parameters', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const source = await f.target(ep);
 for (let i = 0; i < 205; i++) await f.env.DB.prepare("INSERT INTO targets(id,endpoint_id,name,protocol,request_model,claimed_model,tier,created_at) VALUES (?, ?,?,'gpt','gpt-6.1-sol','gpt-6.1-sol','low',1)").bind('many-' + i, ep, '批量来源 ' + i).run();
 await f.call('settings/limits', 'PUT', { daily_requests: 1, monthly_minutes: 15 });
 const input = await f.request([source, ...Array.from({ length: 205 }, (_, i) => 'many-' + i)], 'gpt-6-luna');
 const prepare = f.db.prepare.bind(f.db); let statements = 0;
 f.db.prepare = sql => { statements++; const statement = prepare(sql); const bind = statement.bind.bind(statement); statement.bind = (...values) => { assert.ok(values.length < 100); return bind(...values); }; return statement; };
 const copied = await f.clone(input); assert.equal(copied.status, 200); assert.equal(copied.data.created, 206); assert.ok(statements < 50);
 const after = await f.panel(); assert.equal(after.targets.length, 412); assert.equal(after.usage.daily_requests, 0); assert.equal(after.usage.monthly_minutes, 0); assert.equal(f.pending.length, 0);
});

test('copy route protects authentication, origin and secrets and rejects unsupported writable fields', async t => {
 const f = fixture(t); const a = await f.target(await f.endpoint()); const input = await f.request([a]);
 assert.equal((await f.call('targets/clone', 'POST', { ...input, key: secret })).status, 400);
 assert.equal((await f.clone({ ...input, sources: [...input.sources, input.sources[0]] })).status, 400);
 assert.equal((await f.clone({ ...input, sources: [] })).status, 400);
 assert.equal((await f.clone({ ...input, sources: [{ ...input.sources[0], request_model: secret }] })).status, 400);
 f.env.DEV_MODE = undefined;
 assert.equal((await f.clone(input)).status, 401);
 const credentials = await createLoginCredentials('clone@example.com', 'fixture-password-with-enough-length');
 f.env.LOGIN_CREDENTIALS = JSON.stringify(credentials);
 const token = await sign({ type: 'password', login: credentials.email, id: credentials.email, revision: credentials.revision, expires: Date.now() + 60000 }, f.env);
 assert.equal((await f.call('targets/clone', 'POST', input, { Cookie: '__Host-relay_session=' + token, Origin: 'https://untrusted.example.com' })).status, 403);
 assert.equal((await rows(f.env, 'SELECT * FROM target_clone_requests')).length, 0);
});

test('preview clearly distinguishes equivalent sources, existing tests and incompatible protocols', async t => {
 const f = fixture(t); const ep = await f.endpoint(); const a = await f.target(ep); const b = await f.target(ep, '测试目标', 'gpt', 'medium', 'gpt-6-luna'); const c = await f.target(ep, 'Claude', 'claude', 'low', 'claude-fable-5.1');
 const data = await f.panel();
 const sources = [a, b, c, 'missing'].map(source_id => ({ source_id }));
 assert.deepEqual(clonePreviews(data, sources, 'gpt-6-astra').map(preview => preview.status), ['ready', 'duplicate', 'incompatible', 'missing']);
 await f.clone(await f.request([a]));
 assert.deepEqual(clonePreviews(await f.panel(), [{ source_id: a }], 'gpt-6-astra').map(preview => preview.status), ['existing']);
});
