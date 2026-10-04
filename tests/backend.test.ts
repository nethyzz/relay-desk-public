import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest, tick } from '../worker/index.ts';
import { BASELINES, LEGACY_BASELINES, baselineFor, defaultRequestModel, comparisonKey, plannedRequests, targetsInGroup, targetsInScope, type Run } from '../src/shared.ts';
import { decrypt, encrypt, ensurePublicHostname, publicUrl, session, sign } from '../worker/security.ts';
import { createLoginCredentials } from '../worker/password.ts';
import { derivePasswordProof } from '../src/password.ts';
import { nextDue, safeReport, shanghaiDay } from '../worker/domain.ts';
import { createRuns, finalizeRunSets, pendingNotices, setting, row, rows } from '../worker/data.ts';
import type { Env } from '../worker/types.ts';
const secret = 'sk-private-validation-123456789';
function fixture() {
 const db = new SQLiteDatabase(); const migrations = new URL('../migrations/', import.meta.url);
 for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
 const env: Env = { DB: db, APP_ORIGIN: 'http://127.0.0.1:5173', DEV_MODE: 'local', LOCAL_RUNNER_READY: '1', LOCAL_RUNNER_TOKEN: 'test-runner-token', MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
 const pending: Promise<unknown>[] = [];
 const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
 const call = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const request = new Request('http://127.0.0.1:8787/api/' + path, { method, headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const response = await handleRequest(request, env, ctx); return { status: response.status, data: await response.json() as any };
 };
 const endpoint = async () => (await call('endpoints', 'POST', { name: '验证站点', base_url: 'https://api.example.com/v1', key: secret, group_id: 'default' })).data.id as string;
 const target = async (endpointId: string, protocol = 'gpt', name = '验证 GPT', claimed = BASELINES.gpt.models[0]) => (await call('targets', 'POST', { name, endpoint_id: endpointId, protocol, request_model: claimed, claimed_model: claimed, tier: 'medium' })).data.id as string;
 const runnerHeaders = { 'X-Local-Runner': env.LOCAL_RUNNER_TOKEN!, 'X-Local-Run': '12345' };
 const leaseHeaders = (lease: string) => ({ Authorization: 'Bearer ' + lease });
 return { db, env, call, endpoint, target, runnerHeaders, leaseHeaders, pending };
}
function report(verdict = 'match', claimed = BASELINES.gpt.models[0]) { return { fingerprint: { verdict, claimed_model: claimed, model: verdict === 'match' ? claimed : null, matches: { [claimed]: .86 }, thresholds: { [claimed]: .65 }, valid_samples: 32, planned_samples: 32, reasons: [] }, progress: { actual_attempts: 32 }, benchmark: { id: BASELINES.gpt.id, version: BASELINES.gpt.version, content_sha256: BASELINES.gpt.sha256 } }; }
test('credentials are encrypted at rest and never returned to the browser', async () => {
 const f = fixture(); const ep = await f.endpoint(); const stored = await row(f.env, 'SELECT * FROM endpoints WHERE id=?', ep);
 assert.ok(!stored!.key_cipher.includes(secret)); assert.equal(await decrypt(stored!.key_cipher, f.env, 'endpoint:' + ep), secret);
 const panel = await f.call('panel'); assert.ok(!JSON.stringify(panel.data).includes(secret)); assert.ok(!JSON.stringify(panel.data).includes('key_cipher'));
 assert.equal(panel.data.endpoints[0].credential_saved, true);
 await assert.rejects(decrypt(stored!.key_cipher, f.env, 'endpoint:other')); f.db.close();
});
test('station names and key labels save separately while the same URL keeps its canonical station name', async () => {
 const f = fixture();
 const first = await f.call('endpoints', 'POST', { station_name: '中转站 A', name: '主用 Key', base_url: 'https://api.example.com/v1', key: secret });
 assert.equal(first.status, 200);
 const group = (await f.call('groups', 'POST', { name: '0.08' })).data.id;
 const second = await f.call('endpoints', 'POST', { station_name: '不能覆盖总名称', name: '0.08 Key', base_url: 'https://api.example.com/v1', key: 'sk-independent-key-fixture', group_id: group });
 assert.equal(second.status, 200);
 const panel = (await f.call('panel')).data;
 assert.deepEqual(new Set(panel.endpoints.map((e: any) => e.station_name)), new Set(['中转站 A']));
 assert.deepEqual(new Set(panel.endpoints.map((e: any) => e.name)), new Set(['主用 Key', '0.08 Key']));
 assert.equal(panel.endpoints.find((e: any) => e.id === second.data.id).group_id, group);
 for (const station_name of ['', secret]) {
  assert.equal((await f.call('endpoints', 'POST', { station_name, name: '不得保存', base_url: 'https://other.example.com/v1', key: secret })).status, 400);
 }
 assert.equal((await rows(f.env, 'SELECT id FROM endpoints')).length, 2); f.db.close();
});
test('panel progress metadata retains selections and safe notice status, excluding superseded sets and credentials', async () => {
 const f = fixture(); const ep = await f.endpoint(); const a = await f.target(ep, 'gpt', 'A'); const b = await f.target(ep, 'gpt', 'B');
 const single = await createRuns(f.env, [a], 'low'); const group = await createRuns(f.env, [a, b], 'low');
 let panel = (await f.call('panel')).data;
 assert.equal(panel.run_sets.length, 1); assert.equal(panel.run_sets[0].id, group.setId); assert.notEqual(group.setId, single.setId);
 assert.deepEqual(new Set(panel.run_sets[0].run_ids), new Set(group.runIds)); assert.equal(panel.run_sets[0].notice, null);
 const ended = Date.now(); await f.db.prepare("UPDATE runs SET status='completed',ended_at=?").bind(ended).run();
 await f.db.prepare('UPDATE run_sets SET ended_at=? WHERE id=?').bind(ended, group.setId).run();
 await f.call('settings/mail', 'PUT', { enabled: true, mode: 'all', host: 'smtp.example.com', port: 465, username: 'a@example.com', from: 'a@example.com', to: 'b@example.com', password: 'smtp-secret-metadata-fixture' });
 await f.db.prepare("INSERT INTO notices(id,kind,reference,status,created_at) VALUES ('metadata-notice','batch',?,'processing',?)").bind('set:' + group.setId, ended).run();
 panel = (await f.call('panel')).data;
 assert.equal(panel.run_sets[0].ended_at, ended); assert.equal(panel.run_sets[0].notice.status, 'processing');
 await f.db.prepare("UPDATE notices SET status='sent',sent_at=? WHERE id='metadata-notice'").bind(ended + 8000).run();
 panel = (await f.call('panel')).data;
 assert.equal(panel.run_sets[0].notice.status, 'sent'); assert.equal(panel.run_sets[0].notice.sent_at, ended + 8000);
 for (const privateValue of [secret, 'smtp-secret-metadata-fixture', 'key_cipher', 'password_cipher']) assert.ok(!JSON.stringify(panel).includes(privateValue));
 f.db.close();
});
test('local layout preview identifies demo data and cannot enqueue real detection jobs', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); f.env.LOCAL_PREVIEW_ONLY = '1';
 const panel = (await f.call('panel')).data; assert.equal(panel.preview_only, true); assert.equal(panel.execution_ready, false);
 assert.equal((await f.call('runs', 'POST', { targetIds: [target] })).status, 503);
 assert.equal((await rows(f.env, 'SELECT id FROM runs')).length, 0); f.db.close();
});
test('saved keys remain usable; changing URL requires a replacement key', async () => {
 const f = fixture(); const ep = await f.endpoint();
 assert.equal((await f.call('endpoints', 'POST', { id: ep, name: '新名称', base_url: 'https://api.example.com/v1', key: '' })).status, 200);
 assert.equal((await f.call('endpoints', 'POST', { id: ep, name: '新名称', base_url: 'https://other.example.com/v1', key: '' })).status, 400); f.db.close();
});
test('one saved station supports multiple custom request models and inline group changes without key re-entry', async () => {
 const f = fixture(); const ep = await f.endpoint(); const cipher = (await row(f.env, 'SELECT key_cipher FROM endpoints WHERE id=?', ep))!.key_cipher;
 const first = await f.target(ep); const group = (await f.call('groups', 'POST', { name: '自定义分组' })).data.id;
 const response = await f.call('targets', 'POST', { name: '站点模型别名', endpoint_id: ep, group_id: group, protocol: 'gpt', request_model: 'custom-relay-model-alias', claimed_model: BASELINES.gpt.models[0], tier: 'low' });
 assert.equal(response.status, 200);
 const panel = (await f.call('panel')).data;
 assert.equal(panel.endpoints.length, 1); assert.equal(panel.targets.length, 2); assert.equal(panel.endpoints[0].group_id, group);
 assert.equal(panel.targets.find((t: any) => t.id === response.data.id).request_model, 'custom-relay-model-alias');
 assert.equal((await row(f.env, 'SELECT key_cipher FROM endpoints WHERE id=?', ep))!.key_cipher, cipher);
 const created = await f.call('runs', 'POST', { targetIds: [first, response.data.id], tier: 'low' });
 assert.equal(created.status, 202);
 const claimed = await f.call(`runner/batches/${created.data.runId}/claim`, 'POST', {}, f.runnerHeaders);
 assert.equal(claimed.data.jobs.length, 2); assert.ok(claimed.data.jobs.every((j: any) => j.api_key === secret));
 const invalid = await f.call('targets', 'POST', { name: '不应保存', endpoint_id: ep, group_id: 'missing', protocol: 'gpt', request_model: 'x', claimed_model: BASELINES.gpt.models[0] });
 assert.equal(invalid.status, 400); assert.equal((await rows(f.env, 'SELECT * FROM targets')).length, 2); f.db.close();
});
test('one URL can keep independent keys in different groups and runner jobs use the matching key', async () => {
 const f = fixture(); const first = await f.endpoint(); const secondKey = 'sk-second-validation-987654321'; const group = (await f.call('groups', 'POST', { name: '备用 Key' })).data.id as string;
 const second = await f.call('endpoints', 'POST', { name: '验证站点 · 备用 Key', base_url: 'https://api.example.com/v1', key: secondKey, group_id: group });
 assert.equal(second.status, 200); assert.notEqual(second.data.id, first);
 const endpointRows = await rows(f.env, 'SELECT * FROM endpoints ORDER BY created_at'); assert.equal(endpointRows.length, 2); assert.equal(endpointRows[0].base_url, endpointRows[1].base_url); assert.notEqual(endpointRows[0].key_cipher, endpointRows[1].key_cipher);
 assert.equal(await decrypt(endpointRows[0].key_cipher, f.env, 'endpoint:' + endpointRows[0].id), secret); assert.equal(await decrypt(endpointRows[1].key_cipher, f.env, 'endpoint:' + endpointRows[1].id), secondKey);
 const firstTarget = await f.target(first); const secondTarget = await f.target(second.data.id, 'gpt', '备用 Key 模型'); const panel = (await f.call('panel')).data;
 assert.deepEqual(new Set(panel.endpoints.map((endpoint: any) => endpoint.group_id)), new Set(['default', group])); assert.equal(panel.targets.length, 2);
 const created = await f.call('runs', 'POST', { targetIds: [firstTarget, secondTarget], tier: 'low' }); assert.equal(created.status, 202);
 const claimed = await f.call(`runner/batches/${created.data.runId}/claim`, 'POST', {}, f.runnerHeaders); assert.deepEqual(new Set(claimed.data.jobs.map((job: any) => job.api_key)), new Set([secret, secondKey])); f.db.close();
});
test('editing a relay updates every same-URL profile while preserving keys, groups, models and frozen tasks', async () => {
 const f = fixture(); const first = await f.endpoint(); const group = (await f.call('groups', 'POST', { name: '0.08' })).data.id;
 const second = (await f.call('endpoints', 'POST', { name: '备用 Key', base_url: 'https://api.example.com/v1', key: 'sk-second-private-fixture', group_id: group })).data.id;
 const target = await f.target(first); await f.target(second, 'gpt', '备用模型');
 const before = await rows(f.env, 'SELECT * FROM endpoints ORDER BY id'); const queued = await f.call('runs', 'POST', { targetIds: [target], tier: 'low' });
 const updated = await f.call('stations/' + second, 'PUT', { name: '中转站总名称', base_url: 'https://new.example.com/v1', previous_base_url: 'https://api.example.com/v1', confirm_url_change: true });
 assert.equal(updated.status, 200); assert.equal(updated.data.profiles_updated, 2);
 const after = await rows(f.env, 'SELECT * FROM endpoints ORDER BY id');
 assert.deepEqual(after.map(e => [e.id, e.name, e.group_id, e.key_cipher]), before.map(e => [e.id, e.name, e.group_id, e.key_cipher]));
 assert.ok(after.every(e => e.station_name === '中转站总名称' && e.base_url === 'https://new.example.com/v1'));
 const panel = (await f.call('panel')).data; assert.equal(panel.targets.length, 2); assert.equal(panel.schedules.length, 2);
 assert.equal(panel.runs[0].snapshot.base_url, 'https://api.example.com/v1');
 const claim = await f.call(`runner/batches/${queued.data.runId}/claim`, 'POST', {}, f.runnerHeaders); assert.equal(claim.data.jobs[0].config.base_url, 'https://api.example.com/v1'); assert.equal(claim.data.jobs[0].api_key, secret);
 const added = await f.call('endpoints', 'POST', { name: '第三条 Key', base_url: 'https://new.example.com/v1', key: 'sk-third-private-fixture' });
 assert.equal((await row(f.env, 'SELECT station_name FROM endpoints WHERE id=?', added.data.id))!.station_name, '中转站总名称');
 await f.call('endpoints', 'POST', { id: second, name: '重命名独立配置', group_id: 'default', base_url: 'https://new.example.com/v1' });
 assert.equal((await row(f.env, 'SELECT station_name FROM endpoints WHERE id=?', second))!.station_name, '中转站总名称');
 assert.equal((await row(f.env, 'SELECT name FROM endpoints WHERE id=?', first))!.name, '验证站点'); f.db.close();
});
test('relay edits reject unsafe URLs, secret names, stale forms, missing confirmation and merging another relay', async () => {
 const f = fixture(); const ep = await f.endpoint(); const body = { name: '新中转站', previous_base_url: 'https://api.example.com/v1', base_url: 'https://api.example.com/v1' };
 assert.equal((await f.call('stations/' + ep, 'PUT', { ...body, name: secret })).status, 400);
 assert.equal((await f.call('stations/' + ep, 'PUT', { ...body, base_url: 'https://127.0.0.1/v1', confirm_url_change: true })).status, 400);
 assert.equal((await f.call('stations/' + ep, 'PUT', { ...body, previous_base_url: 'https://stale.example.com' })).status, 409);
 assert.equal((await f.call('stations/' + ep, 'PUT', { ...body, base_url: 'https://changed.example.com/v1' })).status, 400);
 await f.call('endpoints', 'POST', { name: '另一家中转站', base_url: 'https://other.example.com/v1', key: secret });
 assert.equal((await f.call('stations/' + ep, 'PUT', { ...body, base_url: 'https://other.example.com/v1', confirm_url_change: true })).status, 409);
 assert.equal((await row(f.env, 'SELECT station_name,base_url FROM endpoints WHERE id=?', ep))!.station_name, '验证站点');
 assert.equal((await f.call('stations/missing', 'PUT', body)).status, 404); f.db.close();
});
test('the current group batch includes only visible targets; all groups include all targets and reuse active jobs', async () => {
 const f = fixture(); const ep = await f.endpoint(); const group = (await f.call('groups', 'POST', { name: '0.08' })).data.id;
 const other = (await f.call('endpoints', 'POST', { name: '0.08 Key', base_url: 'https://api.example.com/v1', key: 'sk-group-private-fixture', group_id: group })).data.id;
 const hidden = await f.target(ep); const a = await f.target(other, 'gpt', '本组 A'); const b = await f.target(other, 'gpt', '本组 B');
 const panel = (await f.call('panel')).data;
 const selected = targetsInGroup(panel.targets, panel.endpoints, group).map(t => t.id); assert.deepEqual(selected, [a, b]);
 const scoped = await f.call('runs', 'POST', { targetIds: selected, tier: 'low' }); assert.equal(scoped.status, 202);
 let runs = await rows(f.env, 'SELECT target_id FROM runs'); assert.deepEqual(new Set(runs.map(r => r.target_id)), new Set([a, b]));
 const all = targetsInGroup(panel.targets, panel.endpoints, 'all').map(t => t.id); assert.deepEqual(new Set(all), new Set([hidden, a, b]));
 assert.equal((await f.call('runs', 'POST', { targetIds: all, tier: 'low' })).status, 202);
 runs = await rows(f.env, 'SELECT target_id FROM runs'); assert.equal(runs.length, 3);
 assert.equal((await f.call('panel')).data.usage.daily_requests, 144);
 assert.deepEqual(targetsInGroup(panel.targets, panel.endpoints, 'missing'), []); f.db.close();
});
test('station filtering collects all its groups and keys but excludes other relays in the same group', async () => {
 const f = fixture(); const first = await f.endpoint(); const group = (await f.call('groups', 'POST', { name: '0.08' })).data.id;
 const second = (await f.call('endpoints', 'POST', { name: '同站备用 Key', base_url: 'https://api.example.com/v1', key: 'sk-filter-second-private', group_id: group })).data.id;
 const other = (await f.call('endpoints', 'POST', { name: '其他中转站', base_url: 'https://other.example.com/v1', key: 'sk-filter-other-private', group_id: 'default' })).data.id;
 const a = await f.target(first); const b = await f.target(second, 'gpt', '同站另一分组'); const c = await f.target(other, 'gpt', '另一家中转站');
 const panel = (await f.call('panel')).data;
 const selection = targetsInScope(panel.targets, panel.endpoints, { kind: 'station', value: 'https://api.example.com/v1' }).map(t => t.id);
 assert.deepEqual(new Set(selection), new Set([a, b])); assert.ok(!selection.includes(c));
 const runs = await f.call('runs', 'POST', { targetIds: selection, tier: 'low' }); assert.equal(runs.status, 202);
 const claimed = await f.call(`runner/batches/${runs.data.runId}/claim`, 'POST', {}, f.runnerHeaders);
 assert.deepEqual(new Set(claimed.data.jobs.map((job: any) => job.api_key)), new Set([secret, 'sk-filter-second-private']));
 assert.deepEqual(new Set(claimed.data.jobs.map((job: any) => job.config.group_name)), new Set(['默认分组', '0.08']));
 assert.equal(targetsInScope(panel.targets, panel.endpoints, { kind: 'station', value: 'all' }).length, 3); f.db.close();
});
test('public DNS permits CNAME records but rejects private and fake proxy addresses', async () => {
 const original = globalThis.fetch;
 try {
  globalThis.fetch = async () => Response.json({ Answer: [{ type: 5, data: 'alias.example.com' }, { type: 1, data: '8.8.8.8' }] });
  await ensurePublicHostname('https://api.example.com');
  for (const address of ['198.18.1.1', '198.19.1.1', '10.0.0.1', '::ffff:0:c612:2b', '::ffff:198.18.0.43', '64:ff9b::c612:2b', '::ffff:0:7f00:1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'ff02::1', 'fec0::1']) {
   globalThis.fetch = async () => Response.json({ Answer: [{ type: address.includes(':') ? 28 : 1, data: address }] });
   await assert.rejects(ensurePublicHostname('https://api.example.com'), /没有解析到公网/);
  }
  for (const address of ['2606:4700:3034::ac43:9681', '::ffff:8.8.8.8', '::ffff:0:808:808', '64:ff9b::808:808']) {
   globalThis.fetch = async () => Response.json({ Answer: [{ type: 28, data: address }] });
   await ensurePublicHostname('https://api.example.com');
  }
 } finally { globalThis.fetch = original; }
});
test('all four protocols and three tiers keep frozen baseline request budgets', async () => {
 for (const protocol of Object.keys(BASELINES) as (keyof typeof BASELINES)[]) for (const tier of ['low', 'medium', 'high'] as const) {
  const f = fixture(); const ep = await f.endpoint(); const target = await f.target(ep, protocol, '验证', BASELINES[protocol].models[0]);
  const result = await f.call('runs', 'POST', { targetIds: [target], tier }); assert.equal(result.status, 202);
  const run = await row(f.env, 'SELECT * FROM runs WHERE batch_id=?', result.data.runId); const snapshot = JSON.parse(run!.snapshot);
  assert.equal(snapshot.logical_requests, BASELINES[protocol].counts[tier]); assert.equal(run!.reserved_attempts, Math.ceil(BASELINES[protocol].counts[tier] * 1.5)); assert.equal(snapshot.baseline_sha256, BASELINES[protocol].sha256); assert.equal(snapshot.protocol, protocol); f.db.close();
 }
});
test('unsupported models can be saved but cannot create a paid detection', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint(), 'gpt', '未收录', 'unlisted-model');
 const created = await f.call('runs', 'POST', { targetIds: [target] }); assert.equal(created.status, 400); assert.match(created.data.error, /暂无对应基准/); assert.equal((await rows(f.env, 'SELECT * FROM quota_reservations')).length, 0); f.db.close();
});
test('duplicate and concurrent clicks reuse one active run and one reservation', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint());
 const results = await Promise.all([f.call('runs', 'POST', { targetIds: [target], tier: 'low' }), f.call('runs', 'POST', { targetIds: [target], tier: 'low' })]);
 assert.ok(results.every(r => r.status === 202)); assert.equal(results[0].data.runId, results[1].data.runId);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 1); assert.equal((await rows(f.env, 'SELECT * FROM quota_reservations')).length, 2); f.db.close();
});
test('daily and monthly budgets block new requests atomically', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint());
 await f.call('settings/limits', 'PUT', { daily_requests: 47, monthly_minutes: 1500 });
 assert.equal((await f.call('runs', 'POST', { targetIds: [target], tier: 'low' })).status, 429);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 0); assert.equal((await rows(f.env, 'SELECT * FROM quota_reservations')).length, 0);
 await f.call('settings/limits', 'PUT', { daily_requests: 2000, monthly_minutes: 15 });
 const target2 = await f.target((await rows(f.env, 'SELECT * FROM endpoints'))[0].id, 'gpt', '第二个模型');
 assert.equal((await f.call('runs', 'POST', { targetIds: [target], tier: 'low' })).status, 202);
 assert.equal((await f.call('runs', 'POST', { targetIds: [target2], tier: 'low' })).status, 429);
 assert.equal((await rows(f.env, "SELECT * FROM quota_reservations WHERE kind='requests'")).length, 1); f.db.close();
});
test('claim credentials are frozen, scoped to one runner, and results are idempotent', async () => {
 const f = fixture(); const ep = await f.endpoint(); const target = await f.target(ep); const created = await f.call('runs', 'POST', { targetIds: [target], tier: 'low' }); const batch = created.data.runId; const runId = created.data.runIds[0];
 await f.call('endpoints', 'POST', { id: ep, name: '新配置', base_url: 'https://new.example.com/v1', key: 'sk-replacement-secret-987654' });
 assert.equal((await f.call(`runner/batches/${batch}/claim`, 'POST', {}, { 'X-Local-Runner': 'wrong' })).status, 401);
 const claimed = await f.call(`runner/batches/${batch}/claim`, 'POST', {}, f.runnerHeaders); assert.equal(claimed.status, 200); assert.equal(claimed.data.jobs[0].api_key, secret); assert.equal(claimed.data.jobs[0].config.base_url, 'https://api.example.com/v1');
 assert.equal((await f.call(`runner/batches/${batch}/claim`, 'POST', {}, f.runnerHeaders)).status, 409);
 const raw = { ...report(), events: [{ message: 'upstream echoed ' + secret }] };
 assert.equal((await f.call(`runner/batches/${batch}/results/${runId}`, 'POST', { status: 'completed', attempts: 32, report: raw }, f.leaseHeaders(claimed.data.lease))).status, 200);
 assert.equal((await f.call(`runner/batches/${batch}/results/${runId}`, 'POST', { status: 'failed', attempts: 0 }, f.leaseHeaders(claimed.data.lease))).data.reused, true);
 const saved = await f.call('runs/' + runId); assert.equal(saved.data.runs[0].status, 'completed'); assert.ok(!JSON.stringify(saved.data).includes(secret));
 assert.equal((await f.call(`runner/batches/${batch}/complete`, 'POST', { minutes: 2 }, f.leaseHeaders(claimed.data.lease))).status, 200);
 const panel = (await f.call('panel')).data; assert.equal(panel.usage.daily_requests, 32); assert.equal(panel.usage.monthly_minutes, 2); assert.equal(panel.mail.enabled, false); assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 0); f.db.close();
});
test('timeouts and failures retain evidence without manufacturing a mismatch', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); const created = await f.call('runs', 'POST', { targetIds: [target], tier: 'low' }); const batch = created.data.runId;
 const claim = await f.call(`runner/batches/${batch}/claim`, 'POST', {}, f.runnerHeaders);
 const partial = report('insufficient'); partial.fingerprint.valid_samples = 10;
 await f.call(`runner/batches/${batch}/results/${created.data.runIds[0]}`, 'POST', { status: 'timed_out', attempts: 20, report: partial }, f.leaseHeaders(claim.data.lease));
 const run = (await f.call('runs/' + batch)).data.runs[0]; assert.equal(run.status, 'timed_out'); assert.equal(run.report.fingerprint.verdict, 'insufficient'); assert.equal(run.report.fingerprint.valid_samples, 10); f.db.close();
});
test('failed reports expose a Chinese diagnosis and inline evidence while redacting credentials', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); const created = await f.call('runs', 'POST', { targetIds: [target], tier: 'low' });
 const batch = created.data.runId; const claimed = await f.call(`runner/batches/${batch}/claim`, 'POST', {}, f.runnerHeaders);
 const failure = { ...report('insufficient'), results: [{ status: 'error', error: { code: 'upstream_http_error', http_status: 404, upstream: { message: 'unknown model ' + secret } } }] };
 failure.fingerprint.valid_samples = 0;
 await f.call(`runner/batches/${batch}/results/${created.data.runIds[0]}`, 'POST', { status: 'failed', attempts: 32, report: failure }, f.leaseHeaders(claimed.data.lease));
 const saved = (await f.call('runs/' + batch)).data.runs[0];
 assert.match(saved.error, /HTTP 404/); assert.match(saved.error, /路径/);
 assert.equal(saved.report.fingerprint.verdict, 'insufficient'); assert.equal(saved.report.results[0].error.http_status, 404);
 assert.equal(saved.report.results[0].error.upstream.message, 'unknown model [REDACTED]'); assert.ok(!JSON.stringify(saved).includes(secret)); f.db.close();
});
test('schedules default off, missed cycles coalesce, and pause prevents future creation', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); assert.equal((await f.call('panel')).data.schedules[0].enabled, false);
 await f.call(`schedules/${target}`, 'PUT', { enabled: true, interval_minutes: 5, kind: 'interval', tier: 'low' });
 await f.env.DB.prepare('UPDATE schedules SET next_due=? WHERE target_id=?').bind(Date.now() - 3600000, target).run();
 await tick(f.env); await tick(f.env); assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 1);
 await f.call(`schedules/${target}`, 'PUT', { enabled: false }); await f.env.DB.prepare('UPDATE schedules SET next_due=0 WHERE target_id=?').bind(target).run(); await tick(f.env);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 1); f.db.close();
});
test('run expiry releases unstarted reservations and charges uncertain running attempts conservatively', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); const result = await f.call('runs', 'POST', { targetIds: [target], tier: 'low' });
 await f.env.DB.prepare('UPDATE batches SET created_at=? WHERE id=?').bind(Date.now() - 31 * 60000, result.data.runId).run(); await tick(f.env);
 assert.equal((await f.call('panel')).data.usage.daily_requests, 0); assert.equal((await f.call('runs/' + result.data.runId)).data.runs[0].status, 'failed'); f.db.close();
});
test('mail defaults off; failures do not erase reports, and duplicate state does not spam', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint());
 assert.equal((await setting<any>(f.env, 'mail')).enabled, false);
 assert.equal((await f.call('settings/mail', 'PUT', { enabled: true, mode: 'changes', host: 'smtp.example.com', port: 465, username: 'a@example.com', from: 'a@example.com', to: 'b@example.com', password: 'mail-test-password' })).status, 200);
 for (let i = 0; i < 2; i++) {
  const created = { data: await createRuns(f.env, [target], 'low', 'scheduled') }; const batch = created.data.runId;
  const claim = await f.call(`runner/batches/${batch}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claim.data.lease);
  await f.call(`runner/batches/${batch}/results/${created.data.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report('mismatch') }, headers);
  const mail = await f.call(`runner/batches/${batch}/notices`, 'POST', {}, headers);
  if (i === 0) { assert.equal(mail.data.notices.length, 1); const notice = mail.data.notices[0].id;
   assert.equal((await f.call(`runner/batches/${batch}/notice-begin`, 'POST', { notice_id: notice }, headers)).data.send, true);
   assert.equal((await f.call(`runner/batches/${batch}/notice-begin`, 'POST', { notice_id: notice }, headers)).data.send, false);
   await f.call(`runner/batches/${batch}/notice-result`, 'POST', { notice_id: notice, ok: false }, headers);
  } else assert.equal(mail.data.notices.length, 0);
  await f.call(`runner/batches/${batch}/complete`, 'POST', { minutes: 1 }, headers);
 }
 assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 1); assert.ok((await f.call('panel')).data.last_mail_error); assert.equal((await rows(f.env, "SELECT * FROM runs WHERE status='completed'")).length, 2); f.db.close();
});
test('manual notification switch controls every manual result independently of the automatic policy', async () => {
 for (const mode of ['changes', 'all', 'daily']) for (const notify_manual of [true, false]) {
  const f = fixture(); const endpoint = await f.endpoint();
  const values = { enabled: true, notify_manual, mode, host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'receiver@qq.com', password: 'manual-mail-private' };
  assert.equal((await f.call('settings/mail', 'PUT', values)).status, 200);
  for (const source of ['manual', 'scheduled']) {
   const target = await f.target(endpoint, 'gpt', source);
   const created = await createRuns(f.env, [target], 'low', source);
   const claim = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const lease = f.leaseHeaders(claim.data.lease);
   await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report('mismatch') }, lease);
   const notices = await f.call(`runner/batches/${created.runId}/notices`, 'POST', {}, lease);
   const wanted = source === 'manual' ? notify_manual : mode !== 'daily';
   assert.equal(notices.data.notices.length, wanted ? 1 : 0, `${source}, ${mode}, notify_manual=${notify_manual}`);
   if (wanted) assert.equal((await f.call(`runner/batches/${created.runId}/notice-begin`, 'POST', { notice_id: notices.data.notices[0].id }, lease)).data.send, true);
   await f.call(`runner/batches/${created.runId}/complete`, 'POST', { minutes: 1 }, lease);
  }
  f.db.close();
 }
});
test('turning manual mail off cancels queued mail, rejects stale runner payloads, and keeps SMTP credentials', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint());
 const values = { enabled: true, mode: 'all', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'receiver@qq.com', password: 'switch-private-authorization' };
 await f.call('settings/mail', 'PUT', values);
 assert.equal((await f.call('panel')).data.mail.notify_manual, true);
 const cipher = (await setting<any>(f.env, 'mail')).password_cipher;
 const created = await createRuns(f.env, [target], 'low');
 const claim = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const lease = f.leaseHeaders(claim.data.lease);
 await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report('match') }, lease);
 const notice = (await f.call(`runner/batches/${created.runId}/notices`, 'POST', {}, lease)).data.notices[0];
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, password: '', notify_manual: false })).status, 200);
 assert.equal((await row(f.env, 'SELECT status FROM notices WHERE id=?', notice.id))!.status, 'cancelled');
 await f.db.prepare("UPDATE notices SET status='pending' WHERE id=?").bind(notice.id).run();
 assert.equal((await f.call(`runner/batches/${created.runId}/notice-begin`, 'POST', { notice_id: notice.id }, lease)).data.send, false);
 assert.equal((await setting<any>(f.env, 'mail')).password_cipher, cipher);
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, password: '' })).status, 200);
 assert.equal((await f.call('panel')).data.mail.notify_manual, false, 'older clients preserve saved preference');
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, notify_manual: 'false' })).status, 400);
 f.db.close();
});
test('daily summaries include only automatic results when manual mail is disabled', async () => {
 const f = fixture(); const endpoint = await f.endpoint();
 await f.call('settings/mail', 'PUT', { enabled: true, notify_manual: false, mode: 'daily', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'receiver@qq.com', password: 'daily-private-authorization' });
 const anchor = Date.parse(shanghaiDay() + 'T09:00:00+08:00'); let scheduledRun = '';
 for (const source of ['manual', 'scheduled']) {
  const created = await createRuns(f.env, [await f.target(endpoint, 'gpt', source)], 'low', source);
  const claim = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const lease = f.leaseHeaders(claim.data.lease);
  await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report('match') }, lease);
  await f.db.prepare('UPDATE runs SET ended_at=? WHERE id=?').bind(anchor - 3600000, created.runIds[0]).run();
  await f.db.prepare('UPDATE run_sets SET created_at=?,ended_at=? WHERE id=?').bind(anchor - 3601000, anchor - 3600000, created.setId).run();
  await f.call(`runner/batches/${created.runId}/complete`, 'POST', { minutes: 1 }, lease);
  if (source === 'scheduled') scheduledRun = created.runIds[0];
 }
 assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 0);
 await f.db.prepare("INSERT INTO notices(id,kind,reference,created_at) VALUES ('daily-test','daily',?,?)").bind('daily:' + shanghaiDay(), anchor).run();
 await tick(f.env);
 const batch = await row(f.env, "SELECT id FROM batches WHERE kind='mail'");
 const claim = await f.call(`runner/batches/${batch!.id}/claim`, 'POST', {}, f.runnerHeaders);
 assert.deepEqual(claim.data.notices[0].reports.map((r: any) => r.id), [scheduledRun]);
 f.db.close();
});
test('owner authentication, CSRF, bad runner tokens, and private URLs are rejected', async () => {
 const f = fixture(); const production = { ...f.env, DEV_MODE: undefined, GITHUB_OWNER_ID: '42' };
 const credentials = await createLoginCredentials('owner@example.com', 'fixture-password-0001'); production.LOGIN_CREDENTIALS = JSON.stringify(credentials);
 const ctx = { waitUntil() {} }; const request = new Request('https://panel.example.com/api/panel');
 assert.equal((await handleRequest(request, production, ctx)).status, 401);
 const valid = await sign({ type: 'password', id: credentials.email, revision: credentials.revision, login: credentials.email, expires: Date.now() + 60000 }, production);
 assert.ok(await session(new Request(request.url, { headers: { Cookie: '__Host-relay_session=' + valid } }), production));
 const wrong = await sign({ type: 'password', id: 'another@example.com', revision: credentials.revision, expires: Date.now() + 60000 }, production); assert.equal(await session(new Request(request.url, { headers: { Cookie: '__Host-relay_session=' + wrong } }), production), null);
 const legacy = await sign({ id: '42', login: 'owner', expires: Date.now() + 60000 }, production); assert.equal(await session(new Request(request.url, { headers: { Cookie: '__Host-relay_session=' + legacy } }), production), null);
 assert.equal((await f.call('groups', 'POST', { name: 'x' }, { Origin: 'https://evil.example' })).status, 403);
 for (const url of ['http://api.example.com/v1', 'https://127.0.0.1', 'https://10.1.2.3', 'https://localhost', 'https://x.internal', 'https://api.example.com/?key=secret', 'https://user:password@api.example.com']) assert.throws(() => publicUrl(url));
 assert.equal(publicUrl('https://api.example.com/v1/'), 'https://api.example.com/v1'); f.db.close();
});
test('SMTP recipient changes reuse the saved authorization code, but changing the sender account needs a new code', async () => {
 const f = fixture(); const values = { enabled: false, mode: 'changes', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'sender@qq.com' };
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, password: 'fixture-smtp-authorization' })).status, 200);
 const cipher = (await setting<any>(f.env, 'mail')).password_cipher;
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, to: 'receiver@example.com', password: '' })).status, 200);
 assert.equal((await setting<any>(f.env, 'mail')).password_cipher, cipher);
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, username: 'new@qq.com', from: 'new@qq.com', password: '' })).status, 400);
 const panel = (await f.call('panel')).data; assert.equal(panel.mail.enabled, false); assert.equal(panel.mail.to, 'receiver@example.com'); assert.ok(!JSON.stringify(panel).includes('fixture-smtp-authorization')); assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 0); f.db.close();
});
test('test email uses the mail runner without any model calls and exposes safe delivery results', async () => {
 const f = fixture(); const values = { enabled: true, mode: 'daily', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'receiver@qq.com', password: 'smtp-private-authorization' };
 assert.equal((await f.call('settings/mail/test', 'POST', {})).status, 400);
 await f.call('settings/mail', 'PUT', values);
 const simultaneous = await Promise.all([f.call('settings/mail/test', 'POST', {}), f.call('settings/mail/test', 'POST', {})]);
 const first = simultaneous[0]; assert.equal(first.status, 202); assert.equal(simultaneous[1].data.id, first.data.id);
 await Promise.all(f.pending);
 const again = await f.call('settings/mail/test', 'POST', {}); assert.equal(again.data.id, first.data.id);
 const batches = await rows(f.env, 'SELECT * FROM batches'); assert.equal(batches.length, 1); assert.equal(batches[0].kind, 'mail');
 assert.equal((await f.call('panel')).data.usage.monthly_minutes, 15);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 0); assert.equal((await f.call('panel')).data.usage.daily_requests, 0);
 const claim = await f.call(`runner/batches/${batches[0].id}/claim`, 'POST', {}, f.runnerHeaders);
 assert.equal(claim.data.mail.password, values.password); assert.equal(claim.data.notices[0].kind, 'test'); assert.deepEqual(claim.data.notices[0].reports, []);
 const path = `runner/batches/${batches[0].id}/`; const lease = f.leaseHeaders(claim.data.lease);
 assert.equal((await f.call(path + 'notice-begin', 'POST', { notice_id: first.data.id }, lease)).data.send, true);
 assert.equal((await f.call(path + 'notice-begin', 'POST', { notice_id: first.data.id }, lease)).data.send, false);
 await f.call(path + 'notice-result', 'POST', { notice_id: first.data.id, ok: false, error_code: 'smtp_auth', detail: values.password }, lease);
 const panel = (await f.call('panel')).data; assert.equal(panel.last_mail_test.status, 'failed'); assert.match(panel.last_mail_test.error, /邮箱认证失败/); assert.ok(!JSON.stringify(panel).includes(values.password));
 await f.db.prepare("INSERT INTO notices(id,kind,reference,status,created_at,sent_at) VALUES ('later-success','test','test-later','sent',?,?)").bind(Date.now() + 1, Date.now() + 1).run();
 assert.equal((await f.call('panel')).data.last_mail_error, null);
 f.db.close();
});
test('test email respects disabled settings and execution budget', async () => {
 const f = fixture(); const values = { enabled: true, mode: 'all', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'receiver@qq.com', password: 'smtp-private-authorization' };
 await f.call('settings/mail', 'PUT', values); await f.call('settings/limits', 'PUT', { daily_requests: 2000, monthly_minutes: 15 });
 await f.db.prepare("INSERT INTO quota_reservations VALUES ('used','minutes',?,15)").bind(shanghaiDay().slice(0, 7)).run();
 assert.equal((await f.call('settings/mail/test', 'POST', {})).status, 429); assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 0);
 await f.call('settings/mail', 'PUT', { ...values, enabled: false }); assert.equal((await f.call('settings/mail/test', 'POST', {})).status, 400); f.db.close();
});
test('multiple recipients normalize and deduplicate without replacing SMTP credentials or allowing header injection', async () => {
 const f = fixture(); const values = { enabled: true, mode: 'all', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'One@Example.com\nsecond@qq.com；one@example.com, third@example.com', password: 'smtp-multiple-private' };
 assert.equal((await f.call('settings/mail', 'PUT', values)).status, 200);
 const old = await setting<any>(f.env, 'mail'); assert.equal(old.to, 'one@example.com, second@qq.com, third@example.com');
 assert.equal((await f.call('settings/mail', 'PUT', { ...values, to: 'second@qq.com;fourth@example.com', password: '' })).status, 200);
 assert.equal((await setting<any>(f.env, 'mail')).password_cipher, old.password_cipher);
 for (const to of ['broken-email', 'victim@example.com\r\nBcc: attacker@example.com', ['first@example.com'], '', Array.from({ length: 21 }, (_, i) => `user${i}@example.com`).join(',')]) {
  assert.equal((await f.call('settings/mail', 'PUT', { ...values, to, password: '' })).status, 400);
 }
 assert.equal((await f.call('panel')).data.mail.to, 'second@qq.com, fourth@example.com'); f.db.close();
});
test('group editing and deletion preserve station keys, models, monitoring and active report snapshots', async () => {
 const f = fixture(); const ep = await f.endpoint(); const target = await f.target(ep);
 const group = (await f.call('groups', 'POST', { name: '主力分组' })).data.id;
 await f.call('endpoints', 'POST', { id: ep, group_id: group, name: '验证站点', base_url: 'https://api.example.com/v1' });
 const key = (await row(f.env, 'SELECT key_cipher FROM endpoints WHERE id=?', ep))!.key_cipher;
 const run = await f.call('runs', 'POST', { targetIds: [target], tier: 'low' });
 assert.equal((await f.call('groups', 'POST', { id: group, name: '重命名分组' })).status, 200);
 assert.equal((await row(f.env, 'SELECT name FROM groups WHERE id=?', group))!.name, '重命名分组');
 assert.equal((await f.call('groups', 'POST', { id: 'missing', name: '无此分组' })).status, 404);
 assert.equal((await f.call('groups/' + group, 'DELETE', {})).status, 200);
 const panel = (await f.call('panel')).data;
 assert.equal(panel.endpoints[0].group_id, 'default'); assert.equal(panel.targets[0].id, target); assert.equal(panel.schedules[0].target_id, target);
 assert.equal((await row(f.env, 'SELECT key_cipher FROM endpoints WHERE id=?', ep))!.key_cipher, key);
 assert.equal(panel.runs[0].id, run.data.runIds[0]); assert.equal(panel.runs[0].snapshot.group_name, '主力分组');
 assert.equal((await f.call('groups/default', 'DELETE', {})).status, 400);
 assert.equal((await f.call('groups/missing', 'DELETE', {})).status, 404); f.db.close();
});
test('all-target detection spans groups, keeps each model tier and reuses existing tasks', async () => {
 const f = fixture(); const first = await f.target(await f.endpoint());
 const group = (await f.call('groups', 'POST', { name: '备用分组' })).data.id;
 const ep = (await f.call('endpoints', 'POST', { name: '备用站', base_url: 'https://backup.example.com/v1', key: secret, group_id: group })).data.id;
 const second = await f.target(ep, 'claude', '备用 Claude', BASELINES.claude.models[0]);
 await f.call('targets', 'POST', { id: second, endpoint_id: ep, name: '备用 Claude', protocol: 'claude', request_model: BASELINES.claude.models[0], claimed_model: BASELINES.claude.models[0], tier: 'low' });
 const active = await f.call('runs', 'POST', { targetIds: [first] });
 const result = await f.call('runs', 'POST', { targetIds: [first, second] }); assert.equal(result.status, 202); assert.equal(result.data.runIds.length, 2);
 assert.ok(result.data.runIds.includes(active.data.runIds[0]));
 const saved = (await rows(f.env, 'SELECT snapshot FROM runs')).map(r => JSON.parse(r.snapshot));
 assert.deepEqual(new Set(saved.map(r => r.group_name)), new Set(['默认分组', '备用分组']));
 assert.equal(saved.find(r => r.protocol === 'gpt').tier, 'medium'); assert.equal(saved.find(r => r.protocol === 'claude').tier, 'low');
 const duplicate = await f.call('runs', 'POST', { targetIds: [first, second] }); assert.equal(duplicate.data.reused, true);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 2); f.db.close();
});
test('Beijing daily scheduling and comparison keys prevent cross-version trends', () => {
 const before = Date.parse('2026-10-02T08:59:00+08:00'); const after = Date.parse('2026-10-02T09:01:00+08:00'); const config = { kind: 'daily', interval_minutes: 360, daily_time: '09:00' };
 assert.equal(nextDue(config, before), Date.parse('2026-10-02T09:00:00+08:00')); assert.equal(nextDue(config, after), Date.parse('2026-10-03T09:00:00+08:00')); assert.equal(shanghaiDay(Date.parse('2026-10-01T20:00:00Z')), '2026-10-02');
 const one = { target_id: 'x', snapshot: { request_model: 'x', claimed_model: 'x', protocol: 'gpt', tier: 'low' }, report: report() } as unknown as Run;
 const two = structuredClone(one); two.report!.benchmark!.version = 'new'; assert.notEqual(comparisonKey(one), comparisonKey(two));
 assert.ok(!JSON.stringify(safeReport({ events: [{ raw: secret }], api_key: secret }, [secret])).includes(secret));
});
test('browser and runner manifests agree on fixed hashes, versions and counts', () => {
 const manifest = JSON.parse(readFileSync(new URL('../runner/upstream.json', import.meta.url), 'utf8'));
 for (const [protocol, entry] of Object.entries(BASELINES)) { const pinned = manifest.baselines[protocol]; assert.equal(entry.id, pinned.id); assert.equal(entry.version, pinned.version); assert.equal(entry.sha256, pinned.sha256); assert.equal(entry.sha256.length, 64); assert.deepEqual(entry.counts, pinned.counts); }
 for (const [protocol, entry] of Object.entries(LEGACY_BASELINES)) { const pinned = manifest.archived_baselines[protocol === 'gpt' ? 'gpt-sol' : 'gpt-sol-chat']; assert.equal(entry.sha256, pinned.sha256); assert.equal(entry.version, pinned.version); }
});
const testMail = { enabled: true, notify_manual: true, mode: 'all', host: 'smtp.qq.com', port: 465, username: 'sender@qq.com', from: 'sender@qq.com', to: 'receiver@qq.com', password: 'batch-fixture-smtp-private' };
test('a selected batch waits for every outcome and creates exactly one full, credential-free summary', async () => {
 const f = fixture(); const ep = await f.endpoint(); const ids = await Promise.all(['A', 'B', 'C'].map(name => f.target(ep, 'gpt', name)));
 await f.call('settings/mail', 'PUT', testMail);
 const selected = [ids[0], ids[2]];
 const created = (await f.call('runs', 'POST', { targetIds: selected, tier: 'low' })).data;
 assert.equal(created.runIds.length, 2); assert.equal((await rows(f.env, 'SELECT id FROM runs WHERE target_id=?', ids[1])).length, 0);
 const duplicate = (await f.call('runs', 'POST', { targetIds: [...selected].reverse(), tier: 'low' })).data;
 assert.equal(duplicate.setId, created.setId); assert.equal(duplicate.reused, true);
 const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claimed.data.lease); const prefix = `runner/batches/${created.runId}/`;
 const result = { status: 'completed', attempts: 32, report: report('match') };
 await f.call(prefix + 'results/' + created.runIds[0], 'POST', result, headers);
 assert.equal((await f.call(prefix + 'notices', 'POST', {}, headers)).data.notices.length, 0);
 await f.call(prefix + 'results/' + created.runIds[1], 'POST', { status: 'timed_out', attempts: 10, report: report('insufficient') }, headers);
 await f.call(prefix + 'results/' + created.runIds[0], 'POST', result, headers);
 const summaries = (await f.call(prefix + 'notices', 'POST', {}, headers)).data.notices;
 assert.equal(summaries.length, 1); assert.equal(summaries[0].kind, 'batch'); assert.equal(summaries[0].reports.length, 2);
 assert.deepEqual(new Set(summaries[0].reports.map((r: Run) => r.status)), new Set(['completed', 'timed_out']));
 assert.ok(!JSON.stringify(summaries).includes(secret)); assert.ok(!JSON.stringify(summaries).includes('key_cipher'));
 assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 1); f.db.close();
});
test('overlapping selections reuse runs from multiple runners, combine unsent sub-batches and permit only one sender', async () => {
 const f = fixture(); const ep = await f.endpoint(); const a = await f.target(ep, 'gpt', 'A'); const b = await f.target(ep, 'gpt', 'B');
 await f.call('settings/mail', 'PUT', testMail);
 const first = await createRuns(f.env, [a], 'low'); const second = await createRuns(f.env, [b], 'low');
 const group = await createRuns(f.env, [a, b], 'low'); assert.equal(group.reused, true); assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 2);
 const claims = await Promise.all([first, second].map(task => f.call(`runner/batches/${task.runId}/claim`, 'POST', {}, f.runnerHeaders)));
 for (const [index, task] of [first, second].entries()) {
  const headers = f.leaseHeaders(claims[index].data.lease); const prefix = `runner/batches/${task.runId}/`;
  await f.call(prefix + 'results/' + task.runIds[0], 'POST', { status: index === 0 ? 'completed' : 'failed', attempts: 32, report: report('insufficient') }, headers);
  assert.equal((await f.call(prefix + 'notices', 'POST', {}, headers)).data.notices.length, index === 0 ? 0 : 1);
 }
 const notices = await pendingNotices(f.env); assert.equal(notices.length, 1); assert.equal(notices[0].reports.length, 2);
 const begin = await Promise.all([first, second].map((task, index) => f.call(`runner/batches/${task.runId}/notice-begin`, 'POST', { notice_id: notices[0].id }, f.leaseHeaders(claims[index].data.lease))));
 assert.equal(begin.filter(response => response.data.send).length, 1);
 assert.ok((await rows(f.env, 'SELECT * FROM run_sets WHERE id!=?', group.setId)).every(set => set.superseded_by === group.setId));
 assert.equal((await f.call('panel')).data.usage.daily_requests, 64); f.db.close();
});
test('one automatic round combines different tiers and waits for all targets before notifying', async () => {
 const f = fixture(); const ep = await f.endpoint(); const a = await f.target(ep, 'gpt', '快速'); const b = await f.target(ep, 'gpt', '深度');
 await f.call('settings/mail', 'PUT', { ...testMail, notify_manual: false });
 for (const [target, tier] of [[a, 'low'], [b, 'high']]) await f.call(`schedules/${target}`, 'PUT', { enabled: true, tier, interval_minutes: 360 });
 await f.db.prepare('UPDATE schedules SET next_due=?').bind(Date.now() - 1).run(); await tick(f.env); await tick(f.env);
 const batches = await rows(f.env, "SELECT * FROM batches WHERE kind='detection'"); assert.equal(batches.length, 1);
 const claimed = await f.call(`runner/batches/${batches[0].id}/claim`, 'POST', {}, f.runnerHeaders);
 assert.deepEqual(new Set(claimed.data.jobs.map((job: any) => job.config.tier)), new Set(['low', 'high']));
 assert.equal((await f.call('panel')).data.usage.monthly_minutes, 15);
 const headers = f.leaseHeaders(claimed.data.lease); const prefix = `runner/batches/${batches[0].id}/`;
 for (const [i, job] of claimed.data.jobs.entries()) {
  await f.call(prefix + 'results/' + job.id, 'POST', { status: 'completed', attempts: 32, report: report('match') }, headers);
  const notices = (await f.call(prefix + 'notices', 'POST', {}, headers)).data.notices;
  assert.equal(notices.length, i === 0 ? 0 : 1);
  if (notices.length) { assert.equal(notices[0].source, 'scheduled'); assert.equal(notices[0].reports.length, 2); }
 }
 f.db.close();
});
test('automatic changes sends all batch results once, stays quiet for unchanged states, and groups recovery', async () => {
 const f = fixture(); const ep = await f.endpoint(); const ids = [await f.target(ep, 'gpt', 'A'), await f.target(ep, 'gpt', 'B')];
 await f.call('settings/mail', 'PUT', { ...testMail, mode: 'changes' });
 for (const [round, states] of [['abnormal', ['mismatch', 'match']], ['same', ['mismatch', 'match']], ['recovery', ['match', 'match']]] as const) {
  const created = await createRuns(f.env, ids, 'low', 'scheduled'); const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claimed.data.lease); const prefix = `runner/batches/${created.runId}/`;
  for (const [i, runId] of created.runIds.entries()) await f.call(prefix + 'results/' + runId, 'POST', { status: 'completed', attempts: 32, report: report(states[i]) }, headers);
  const notices = (await f.call(prefix + 'notices', 'POST', {}, headers)).data.notices;
  assert.equal(notices.length, round === 'same' ? 0 : 1);
  if (notices.length) { assert.equal(notices[0].reports.length, 2); await f.call(prefix + 'notice-begin', 'POST', { notice_id: notices[0].id }, headers); await f.call(prefix + 'notice-result', 'POST', { notice_id: notices[0].id, ok: true }, headers); }
  await f.call(prefix + 'complete', 'POST', { minutes: 1 }, headers);
 }
 assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 2); f.db.close();
});
test('disabled mail at batch completion does not turn into an unexpected historical email when later enabled', async () => {
 const f = fixture(); const ep = await f.endpoint(); const created = await createRuns(f.env, [await f.target(ep), await f.target(ep, 'gpt', 'B')], 'low');
 const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claimed.data.lease);
 for (const runId of created.runIds) await f.call(`runner/batches/${created.runId}/results/${runId}`, 'POST', { status: 'completed', attempts: 32, report: report() }, headers);
 await f.call('settings/mail', 'PUT', testMail); await finalizeRunSets(f.env);
 assert.equal((await pendingNotices(f.env)).length, 0); assert.ok((await row(f.env, 'SELECT ended_at FROM run_sets WHERE id=?', created.setId))!.ended_at); f.db.close();
});
test('an interrupted batch preserves completed reports and includes failed remaining targets in one summary', async () => {
 const f = fixture(); const ep = await f.endpoint(); await f.call('settings/mail', 'PUT', testMail);
 const created = await createRuns(f.env, [await f.target(ep), await f.target(ep, 'gpt', 'B')], 'low'); const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claimed.data.lease);
 await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report() }, headers);
 await f.db.prepare('UPDATE batches SET lease_until=? WHERE id=?').bind(Date.now() - 3 * 60000, created.runId).run(); await tick(f.env);
 const group = await row(f.env, "SELECT * FROM notices WHERE kind='batch'"); assert.ok(group);
 const mailBatch = await row(f.env, "SELECT * FROM batches WHERE kind='mail'"); const notices = JSON.parse(mailBatch!.mail_payload);
 assert.equal(notices.length, 1); assert.equal(notices[0].reports.length, 2); assert.deepEqual(new Set(notices[0].reports.map((r: Run) => r.status)), new Set(['completed', 'failed']));
 assert.ok(!mailBatch!.mail_payload.includes(secret)); f.db.close();
});
test('a daily digest waits for the round running at its cutoff and includes the eventual full result', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); await f.call('settings/mail', 'PUT', { ...testMail, mode: 'daily' });
 const created = await createRuns(f.env, [target], 'low', 'scheduled'); const anchor = Date.now();
 await f.db.prepare('UPDATE runs SET created_at=? WHERE id=?').bind(anchor - 1000, created.runIds[0]).run();
 await f.db.prepare('UPDATE run_sets SET created_at=? WHERE id=?').bind(anchor - 1000, created.setId).run();
 await f.db.prepare("INSERT INTO notices(id,kind,reference,created_at) VALUES ('daily-wait','daily','daily-wait',?)").bind(anchor).run();
 assert.equal((await pendingNotices(f.env)).length, 0);
 const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claimed.data.lease);
 await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report() }, headers);
 await f.db.prepare('UPDATE runs SET ended_at=? WHERE id=?').bind(anchor + 1000, created.runIds[0]).run();
 const notices = await pendingNotices(f.env); assert.equal(notices.length, 1); assert.deepEqual(notices[0].reports.map((r: Run) => r.id), created.runIds); f.db.close();
});
test('new 6.1 Sol targets use official October baselines while saved 6 Sol targets keep their exact September baseline', async () => {
 for (const protocol of ['gpt', 'gpt-chat'] as const) {
  const f = fixture(); const ep = await f.endpoint(); const newer = await f.target(ep, protocol, '6.1 Sol', 'gpt-6.1-sol'); const previous = await f.target(ep, protocol, '6 Sol', 'gpt-6-sol');
  const created = await createRuns(f.env, [newer, previous], 'low'); const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders);
  for (const job of claimed.data.jobs) { const baseline = baselineFor(protocol, job.config.claimed_model); assert.equal(job.config.baseline_sha256, baseline.sha256); assert.equal(job.config.baseline_version, baseline.version); }
  assert.match(claimed.data.jobs.find((job: any) => job.config.claimed_model === 'gpt-6.1-sol').config.baseline_version, /20261003/);
  assert.match(claimed.data.jobs.find((job: any) => job.config.claimed_model === 'gpt-6-sol').config.baseline_version, /20260924/); f.db.close();
 }
});
test('scheduled reuse of a manual run is automatic evidence for change deduplication and daily summaries', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint());
 await f.call('settings/mail', 'PUT', { ...testMail, notify_manual: false, mode: 'changes' });
 const manual = await createRuns(f.env, [target], 'low'); const automatic = await createRuns(f.env, [target], 'low', 'scheduled');
 assert.equal(automatic.reused, true); assert.deepEqual(automatic.runIds, manual.runIds);
 const finish = async (created: typeof manual) => {
  const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders); const headers = f.leaseHeaders(claimed.data.lease);
  await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report('mismatch') }, headers);
  await f.call(`runner/batches/${created.runId}/complete`, 'POST', { minutes: 1 }, headers);
 };
 await finish(manual); assert.equal((await pendingNotices(f.env)).length, 1);
 await f.db.prepare("UPDATE notices SET status='sent'").run();
 const second = await createRuns(f.env, [target], 'low', 'scheduled'); await finish(second);
 assert.equal((await rows(f.env, "SELECT * FROM notices WHERE kind='batch'")).length, 1, 'unchanged scheduled state does not send twice');
 await f.call('settings/mail', 'PUT', { ...testMail, notify_manual: false, mode: 'daily' });
 const cutoff = Date.now() + 1000;
 await f.db.prepare("INSERT INTO notices(id,kind,reference,created_at) VALUES ('reuse-daily','daily','reuse-daily',?)").bind(cutoff).run();
 const notices = await pendingNotices(f.env); assert.equal(notices.length, 1);
 assert.deepEqual(new Set(notices[0].reports.map((r: Run) => r.id)), new Set([...manual.runIds, ...second.runIds])); f.db.close();
});
test('simultaneous partially overlapping selections reuse the shared target and create only the remainder', async () => {
 const f = fixture(); const ep = await f.endpoint(); const a = await f.target(ep, 'gpt', 'A'); const b = await f.target(ep, 'gpt', 'B'); const c = await f.target(ep, 'gpt', 'C');
 const selections = await Promise.all([createRuns(f.env, [a, b], 'low'), createRuns(f.env, [b, c], 'low')]);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 3); assert.ok(selections.every(s => s.runIds.length === 2));
 assert.equal(selections[0].runIds.filter(id => selections[1].runIds.includes(id)).length, 1);
 assert.equal((await f.call('panel')).data.usage.daily_requests, 144); f.db.close();
});
test('a task created during Worker rollout gets lazy membership and one complete summary', async () => {
 const f = fixture(); await f.call('settings/mail', 'PUT', testMail);
 const created = await createRuns(f.env, [await f.target(await f.endpoint())], 'low');
 await f.db.prepare('DELETE FROM run_set_members').run(); await f.db.prepare('DELETE FROM run_sets').run();
 const claimed = await f.call(`runner/batches/${created.runId}/claim`, 'POST', {}, f.runnerHeaders);
 await f.call(`runner/batches/${created.runId}/results/${created.runIds[0]}`, 'POST', { status: 'completed', attempts: 32, report: report() }, f.leaseHeaders(claimed.data.lease));
 const notices = await pendingNotices(f.env); assert.equal(notices.length, 1); assert.equal(notices[0].reports[0].id, created.runIds[0]);
 await finalizeRunSets(f.env); assert.equal((await rows(f.env, 'SELECT * FROM notices')).length, 1); f.db.close();
});
test('Claude defaults follow official relay and OpenRouter request aliases while GPT aliases stay unchanged', () => {
 for (const protocol of ['claude', 'claude-chat'] as const) {
  assert.equal(defaultRequestModel(protocol, 'claude-fable-5.1', 'https://relay.example.com/v1'), 'claude-fable-5-1');
  assert.equal(defaultRequestModel(protocol, 'claude-haiku-4.5', 'https://openrouter.ai/api/v1/'), 'anthropic/claude-haiku-4.5');
  assert.equal(defaultRequestModel(protocol, 'claude-sonnet-5', 'https://relay.example.com/v1'), 'claude-sonnet-5');
 }
 assert.equal(defaultRequestModel('gpt', 'gpt-6.1-sol', 'https://relay.example.com/v1'), 'gpt-6.1-sol');
});
test('common selections persist across groups and relays, and editing or deleting them leaves model settings and evidence intact', async () => {
 const f = fixture(); const ep = await f.endpoint(); const a = await f.target(ep);
 const group = (await f.call('groups', 'POST', { name: '备用分组' })).data.id;
 const other = (await f.call('endpoints', 'POST', { station_name: '另一家中转站', name: '备用 Key', base_url: 'https://other.example.com/v1', key: 'sk-other-preset-fixture', group_id: group })).data.id;
 const b = await f.target(other, 'claude', '常用 Claude', BASELINES.claude.models[0]);
 const before = (await f.call('panel')).data;
 const created = await f.call('run-presets', 'POST', { name: ' 日常检测 ', targetIds: [b, a, b] }); assert.equal(created.status, 200);
 let panel = (await f.call('panel')).data;
 const preset = panel.run_presets[0]; assert.equal(preset.name, '日常检测'); assert.deepEqual(preset.target_ids, [b, a]);
 assert.equal(panel.runs.length, 0); assert.deepEqual(panel.usage, before.usage);
 const updated = await f.call('run-presets', 'POST', { id: created.data.id, name: '常用线路', targetIds: [a] }); assert.equal(updated.status, 200);
 panel = (await f.call('panel')).data; assert.equal(panel.run_presets.length, 1); assert.deepEqual(panel.run_presets[0].target_ids, [a]);
 assert.equal(panel.run_presets[0].created_at, preset.created_at);
 assert.deepEqual(panel.targets, before.targets); assert.deepEqual(panel.endpoints, before.endpoints);
 assert.equal((await f.call('run-presets/' + created.data.id, 'DELETE')).status, 200);
 assert.equal((await rows(f.env, 'SELECT * FROM run_preset_targets')).length, 0);
 panel = (await f.call('panel')).data; assert.equal(panel.run_presets.length, 0); assert.deepEqual(panel.targets, before.targets); assert.deepEqual(panel.schedules, before.schedules); assert.deepEqual(panel.usage, before.usage);
 assert.equal((await f.call('run-presets/' + created.data.id, 'DELETE')).status, 404); f.db.close();
});
test('invalid common selections cannot replace a valid selection or silently create a missing edit', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint()); const preset = (await f.call('run-presets', 'POST', { name: '保留组合', targetIds: [target] })).data.id;
 const before = (await f.call('panel')).data.run_presets;
 for (const change of [{ targetIds: [] }, { targetIds: [target, 'missing'] }, { targetIds: [123] }, { targetIds: [' '] }, { targetIds: Array(6).fill(target) }, { name: '' }, { name: 'n'.repeat(65) }, { name: 'bad\nname' }, { key: secret }]) {
  const result = await f.call('run-presets', 'POST', { id: preset, name: '不能覆盖', targetIds: [target], ...change });
  assert.ok([400, 404].includes(result.status)); assert.deepEqual((await f.call('panel')).data.run_presets, before);
 }
 assert.equal((await f.call('run-presets', 'POST', { id: 'missing', name: '不得新增', targetIds: [target] })).status, 404);
 assert.equal((await rows(f.env, 'SELECT * FROM runs')).length, 0); f.db.close();
});
test('common selections require private authentication and same-origin access and cannot expose API credentials', async () => {
 const f = fixture(); const target = await f.target(await f.endpoint());
 assert.equal((await f.call('run-presets', 'POST', { name: '泄露 ' + secret, targetIds: [target] })).status, 400);
 assert.equal((await f.call('run-presets', 'POST', { name: '第三方页面', targetIds: [target] }, { Origin: 'https://evil.example.com' })).status, 403);
 const preset = (await f.call('run-presets', 'POST', { name: '私人组合', targetIds: [target] })).data.id;
 const panel = await f.call('panel'); assert.ok(!JSON.stringify(panel.data).includes(secret)); assert.ok(!JSON.stringify(panel.data.run_presets).includes('cipher'));
 f.env.DEV_MODE = undefined;
 assert.equal((await f.call('panel')).status, 401);
 assert.equal((await f.call('run-presets', 'POST', { name: '未登录', targetIds: [target] })).status, 401);
 assert.equal((await f.call('run-presets/' + preset, 'DELETE')).status, 401);
 assert.equal((await rows(f.env, 'SELECT * FROM run_presets')).length, 1); f.db.close();
});
test('starting a common selection uses only its members with current keys and tiers, reuses active jobs and sends one combined report', async () => {
 const f = fixture(); await f.call('settings/mail', 'PUT', testMail);
 const ep = await f.endpoint(); const a = await f.target(ep, 'gpt', '常用 GPT'); const excluded = await f.target(ep, 'gpt', '未选中的 GPT');
 const group = (await f.call('groups', 'POST', { name: '跨组' })).data.id;
 const other = (await f.call('endpoints', 'POST', { station_name: '备用中转站', name: '常用 Key', base_url: 'https://other.example.com/v1', key: 'sk-preset-original', group_id: group })).data.id;
 const b = await f.target(other, 'claude', '常用 Claude', BASELINES.claude.models[0]);
 const preset = (await f.call('run-presets', 'POST', { name: '跨组检测', targetIds: [a, b] })).data.id;
 await f.call('targets/batch', 'POST', { targetIds: [a], changes: { tier: 'low', request_model: 'new-gpt-alias' } });
 await f.call('targets/batch', 'POST', { targetIds: [b], changes: { tier: 'high' } });
 await f.call('endpoints', 'POST', { id: other, name: '新 Key', base_url: 'https://other.example.com/v1', group_id: group, key: 'sk-preset-replacement' });
 const members = (await f.call('panel')).data.run_presets.find((p: any) => p.id === preset).target_ids;
 const started = await f.call('runs', 'POST', { targetIds: members }); assert.equal(started.status, 202);
 const quota = (await f.call('panel')).data.usage.daily_requests;
 assert.equal(quota, plannedRequests('gpt', 'low').maximum + plannedRequests('claude', 'high').maximum);
 const repeat = await f.call('runs', 'POST', { targetIds: members }); assert.equal(repeat.status, 202); assert.equal(repeat.data.reused, true);
 assert.deepEqual(new Set(repeat.data.runIds), new Set(started.data.runIds)); assert.equal((await f.call('panel')).data.usage.daily_requests, quota);
 assert.equal((await rows(f.env, 'SELECT * FROM runs WHERE target_id=?', excluded)).length, 0);
 const claimed = await f.call(`runner/batches/${started.data.runId}/claim`, 'POST', {}, f.runnerHeaders); assert.equal(claimed.status, 200);
 const jobs = claimed.data.jobs; assert.equal(jobs.length, 2);
 const gpt = jobs.find((job: any) => job.config.protocol === 'gpt'); const claude = jobs.find((job: any) => job.config.protocol === 'claude');
 assert.equal(gpt.config.request_model, 'new-gpt-alias'); assert.equal(gpt.config.tier, 'low'); assert.equal(gpt.api_key, secret);
 assert.equal(claude.config.tier, 'high'); assert.equal(claude.api_key, 'sk-preset-replacement');
 const headers = f.leaseHeaders(claimed.data.lease);
 for (const [index, job] of jobs.entries()) {
  const result = await f.call(`runner/batches/${started.data.runId}/results/${job.id}`, 'POST', { status: 'completed', attempts: 32, report: report('match', job.config.claimed_model) }, headers);
  assert.equal(result.status, 200); if (!index) assert.equal((await pendingNotices(f.env)).length, 0, 'wait for all members before mailing');
 }
 const notices = await pendingNotices(f.env); assert.equal(notices.length, 1); assert.equal(notices[0].kind, 'batch');
 assert.deepEqual(new Set(notices[0].reports.map((r: Run) => r.target_id)), new Set([a, b])); f.db.close();
});
