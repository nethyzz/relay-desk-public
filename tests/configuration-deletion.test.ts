import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest, tick } from '../worker/index.ts';
import { configurationDeletion } from '../src/configuration-deletion.ts';
import type { Env } from '../worker/types.ts';

function fixture() {
 const db = new SQLiteDatabase();
 for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
 const env: Env = { DB: db, DEV_MODE: 'local', LOCAL_RUNNER_READY: '1', APP_ORIGIN: 'http://127.0.0.1:5173', MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
 const ctx = { waitUntil(p: Promise<unknown>) { void p; } };
 const call = async (path: string, method = 'GET', body?: unknown, origin = env.APP_ORIGIN) => {
  const response = await handleRequest(new Request('http://127.0.0.1:8787/api/' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
  return { status: response.status, data: await response.json() as any };
 };
 const key = async (name = '主用 Key', group = 'default', url = 'https://api.example.com/v1') => (await call('endpoints', 'POST', { name, group_id: group, station_name: '测试中转站', base_url: url, key: 'sk-delete-fixture-1234567890' })).data.id as string;
 const model = async (endpoint: string, name = '模型') => (await call('targets', 'POST', { endpoint_id: endpoint, name, protocol: 'gpt', request_model: 'gpt-6.1-sol', claimed_model: 'gpt-6.1-sol', tier: 'low' })).data.id as string;
 const remove = (resource: string, id: string, targets: string[], endpoints: string[] = []) => call(resource + '/' + id, 'DELETE', { confirm: true, targetIds: targets, endpointIds: endpoints, previous_base_url: 'https://api.example.com/v1' });
 return { db, env, call, key, model, remove };
}
test('model deletion retains its Key, sibling models, quota and complete historical reports while removing schedules and preset membership', async () => {
 const f = fixture();
 try {
  const key = await f.key(); const a = await f.model(key, '移除模型'); const b = await f.model(key, '保留模型');
  const cipher = f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(key)!.key_cipher;
  const run = (await f.call('runs', 'POST', { targetIds: [a] })).data.runIds[0];
  const evidence = { fingerprint: { verdict: 'insufficient' }, results: [{ answer: 'historical evidence' }] };
  f.db.connection.prepare("UPDATE runs SET status='completed',report=?,key_cipher='' WHERE id=?").run(JSON.stringify(evidence), run);
  await f.call('schedules/' + a, 'PUT', { enabled: true, interval_minutes: 360 });
  const keepPreset = (await f.call('run-presets', 'POST', { name: '保留组合', targetIds: [a, b] })).data.id;
  const emptyPreset = (await f.call('run-presets', 'POST', { name: '变空组合', targetIds: [a] })).data.id;
  const before = (await f.call('panel')).data;
  const result = await f.remove('targets', a, [a]); assert.equal(result.status, 200); assert.equal(result.data.models_deleted, 1); assert.equal(result.data.keys_deleted, 0);
  const after = (await f.call('panel')).data;
  assert.deepEqual(after.targets.map((target: {id:string}) => target.id), [b]); assert.equal(after.endpoints.length, 1);
  assert.equal(f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(key)!.key_cipher, cipher);
  assert.equal(after.schedules.some((schedule: {target_id:string}) => schedule.target_id === a), false);
  assert.deepEqual(after.run_presets.find((preset: {id:string}) => preset.id === keepPreset).target_ids, [b]);
  assert.equal(after.run_presets.some((preset: {id:string}) => preset.id === emptyPreset), false);
  assert.deepEqual(after.usage, before.usage);
  assert.deepEqual((await f.call('reports/' + run)).data.run.report, evidence);
  assert.equal(after.runs.some((saved: {id:string}) => saved.id === run), true);
  assert.deepEqual(f.db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await f.remove('targets', a, [a])).data.already_deleted, true);
  assert.equal((await f.call('runs', 'POST', { targetIds: [a] })).status, 404);
  assert.equal((await f.call('schedules/' + a, 'PUT', { enabled: true })).status, 404);
  assert.equal((await f.call('targets', 'POST', { id: a, endpoint_id: key, name: '旧窗口', protocol: 'gpt', request_model: 'gpt-6.1-sol', claimed_model: 'gpt-6.1-sol' })).status, 404);
  assert.equal((await f.call('run-presets', 'POST', { name: '旧组合', targetIds: [a] })).status, 404);
  await tick(f.env); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 1);
 } finally { f.db.close(); }
});
test('Key deletion clears only that credential and its models; station deletion covers every Key across groups and preserves other stations', async () => {
 const f = fixture();
 try {
  const group = (await f.call('groups', 'POST', { name: '另一分组' })).data.id;
  const a = await f.key(); const b = await f.key('备用 Key', group); const c = await f.key('第三 Key', group); const other = await f.key('另一家', 'default', 'https://other.example.com/v1');
  const targets = [await f.model(a, 'A'), await f.model(a, 'B'), await f.model(b, 'C'), await f.model(c, 'D'), await f.model(other, 'E')];
  const first = await f.remove('endpoints', a, targets.slice(0, 2), [a]); assert.equal(first.status, 200); assert.equal(first.data.models_deleted, 2);
  assert.equal(f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(a)!.key_cipher, '');
  assert.ok(f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(b)!.key_cipher);
  const second = await f.remove('stations', b, targets.slice(2, 4), [b, c]); assert.equal(second.status, 200); assert.equal(second.data.keys_deleted, 2); assert.equal(second.data.models_deleted, 2);
  const panel = (await f.call('panel')).data;
  assert.deepEqual(panel.endpoints.map((key: {id:string}) => key.id), [other]); assert.deepEqual(panel.targets.map((model: {id:string}) => model.id), [targets[4]]);
  for (const key of [a, b, c]) assert.equal(f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(key)!.key_cipher, '');
  assert.ok(panel.groups.some((saved: {id:string}) => saved.id === group));
  assert.deepEqual(f.db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await f.call('endpoints', 'POST', { id: a, name: '旧窗口', group_id: 'default', base_url: 'https://api.example.com/v1' })).status, 404);
  assert.equal((await f.call('models', 'POST', { endpoint_id: a })).status, 404);
  const recreated = (await f.call('endpoints', 'POST', { name: '重新添加', station_name: '新名称', group_id: 'default', base_url: 'https://api.example.com/v1', key: 'sk-new-delete-fixture-1234' })).data.id;
  assert.equal((await f.call('panel')).data.endpoints.find((key: {id:string}) => key.id === recreated).station_name, '新名称');
  assert.equal((await f.remove('stations', b, targets.slice(2, 4), [b, c])).data.already_deleted, true);
  assert.equal((await f.call('panel')).data.endpoints.length, 2, 'retrying an old station deletion must not remove a freshly recreated same-URL station');
 } finally { f.db.close(); }
});
test('deletion blocks queued and running tests and succeeds only after stop acknowledgement', async () => {
 const f = fixture();
 try {
  const key = await f.key(); const a = await f.model(key); const run = (await f.call('runs', 'POST', { targetIds: [a] })).data.runIds[0];
  assert.equal((await f.remove('endpoints', key, [a], [key])).status, 409);
  f.db.connection.prepare("UPDATE runs SET status='running',stop_requested_at=1 WHERE id=?").run(run);
  assert.equal((await f.remove('targets', a, [a])).status, 409, 'a stop request is not a stop acknowledgement');
  assert.throws(() => f.db.connection.prepare('UPDATE targets SET deleted_at=1 WHERE id=?').run(a), /configuration_in_use/);
  f.db.connection.prepare("UPDATE runs SET status='cancelled',key_cipher='',report=? WHERE id=?").run(JSON.stringify({ operational_status: 'paused', results: [{ answer: 'partial evidence' }] }), run);
  assert.equal((await f.remove('endpoints', key, [a], [key])).status, 200);
  assert.equal((await f.call('reports/' + run)).data.run.report.results[0].answer, 'partial evidence');
 } finally { f.db.close(); }
});
test('deletion requires authentication, same origin, exact current scope and explicit confirmation', async () => {
 const f = fixture();
 try {
  const key = await f.key(); const a = await f.model(key); const b = await f.model(key);
  assert.equal((await f.call('targets/' + a, 'DELETE', {})).status, 400);
  assert.equal((await f.remove('targets', 'missing', ['missing'])).status, 404);
  assert.equal((await f.remove('endpoints', key, [a], [key])).status, 409);
  assert.equal((await f.remove('stations', key, [a, b], [])).status, 409);
  assert.equal((await f.call('endpoints/' + key, 'DELETE', { confirm: true, targetIds: [a, b], endpointIds: [key], previous_base_url: 'https://stale.example.com' })).status, 409);
  assert.equal((await f.call('targets/' + a, 'DELETE', { confirm: true, targetIds: [a], endpointIds: [] }, 'https://other.example.com')).status, 403);
  f.env.DEV_MODE = undefined; assert.equal((await f.remove('targets', a, [a])).status, 401); f.env.DEV_MODE = 'local';
  assert.equal((await f.call('panel')).data.targets.length, 2); assert.ok(f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(key)!.key_cipher);
 } finally { f.db.close(); }
});
test('a newly added model or Key after the preview cannot cause a partial station deletion', async () => {
 for (const extra of ['model', 'key']) {
  const f = fixture();
  try {
   const key = await f.key(); const a = await f.model(key);
   const originalBatch = f.db.batch.bind(f.db); let inject = true;
   f.db.batch = async statements => {
    if (inject) { inject = false; if (extra === 'model') await f.model(key, '新模型'); else await f.key('新 Key'); }
    return originalBatch(statements);
   };
   assert.equal((await f.remove('stations', key, [a], [key])).status, 409);
   const panel = (await f.call('panel')).data; assert.equal(panel.targets.length, extra === 'model' ? 2 : 1); assert.equal(panel.endpoints.length, extra === 'key' ? 2 : 1);
   assert.equal(f.db.connection.prepare('SELECT deleted_at FROM targets WHERE id=?').get(a)!.deleted_at, null);
   assert.ok(f.db.connection.prepare('SELECT key_cipher FROM endpoints WHERE id=?').get(key)!.key_cipher);
  } finally { f.db.close(); }
 }
});
test('an empty Key can be deleted, and a fresh detection racing the delete keeps all reviewed configuration', async () => {
 const empty = fixture();
 try { const key = await empty.key(); assert.equal((await empty.remove('endpoints', key, [], [key])).status, 200); assert.equal((await empty.call('panel')).data.endpoints.length, 0); } finally { empty.db.close(); }
 const f = fixture();
 try {
  const key = await f.key(); const a = await f.model(key); const b = await f.model(key);
  const originalBatch = f.db.batch.bind(f.db); let inject = true;
  f.db.batch = async statements => { if (inject) { inject = false; await f.call('runs', 'POST', { targetIds: [b] }); } return originalBatch(statements); };
  assert.equal((await f.remove('endpoints', key, [a, b], [key])).status, 409);
  assert.equal((await f.call('panel')).data.targets.length, 2); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM targets WHERE deleted_at IS NOT NULL').get()!.n, 0);
 } finally { f.db.close(); }
});
test('a moved Key replaced by a new same-URL Key during confirmation cannot be mistaken for the original station scope', async () => {
 const f = fixture();
 try {
  const a = await f.key(); const b = await f.key('原备用 Key'); const x = await f.model(a); const y = await f.model(b);
  const originalBatch = f.db.batch.bind(f.db); let inject = true;
  f.db.batch = async statements => {
   if (inject) { inject = false; f.db.connection.prepare('UPDATE endpoints SET base_url=? WHERE id=?').run('https://moved.example.com/v1', b); await f.key('新增 Key'); }
   return originalBatch(statements);
  };
  assert.equal((await f.remove('stations', a, [x, y], [a, b])).status, 409);
  const panel = (await f.call('panel')).data; assert.equal(panel.targets.length, 2); assert.equal(panel.endpoints.length, 3);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM targets WHERE deleted_at IS NOT NULL').get()!.n, 0);
 } finally { f.db.close(); }
});
test('deletion previews include all groups of a station and distinguish Key and single-model scope', async () => {
 const f = fixture();
 try {
  const group = (await f.call('groups', 'POST', { name: '另一分组' })).data.id; const a = await f.key(); const b = await f.key('备用 Key', group);
  const x = await f.model(a); const y = await f.model(b);
  const panel = (await f.call('panel')).data;
  const station = configurationDeletion(panel, {kind:'station',id:a})!; assert.equal(station.profiles.length, 2); assert.equal(station.models.length, 2); assert.deepEqual([...station.request.targetIds].sort(), [x, y].sort());
  const key = configurationDeletion(panel, {kind:'key',id:a})!; assert.deepEqual(key.request.endpointIds, [a]); assert.deepEqual(key.request.targetIds, [x]);
  const model = configurationDeletion(panel, {kind:'model',id:x})!; assert.deepEqual(model.request.endpointIds, []); assert.deepEqual(model.request.targetIds, [x]);
  assert.equal(configurationDeletion(panel, {kind:'model',id:'missing'}), null);
 } finally { f.db.close(); }
});
test('deleting a Key with 205 saved models uses bounded SQL bindings and removes every associated model', async () => {
 const f = fixture();
 try {
  const key = await f.key(); const targets = [];
  for (let index=0; index<205; index++) targets.push(await f.model(key, '模型 '+index));
  const prepare = f.db.prepare.bind(f.db); let statements = 0;
  f.db.prepare = sql => {
   statements++; const statement = prepare(sql); const bind = statement.bind.bind(statement);
   statement.bind = (...values) => { assert.ok(values.length<=100); return bind(...values); };
   return statement;
  };
  const result = await f.remove('endpoints', key, targets, [key]);
  assert.equal(result.status, 200); assert.equal(result.data.models_deleted, 205); assert.ok(statements<=50);
  const panel = (await f.call('panel')).data; assert.equal(panel.targets.length, 0); assert.equal(panel.endpoints.length, 0); assert.equal(panel.schedules.length, 0);
 } finally { f.db.close(); }
});
