import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest, tick } from '../worker/index.ts';
import { dispatch, dispatchQueued, expireBatches, pendingNotices, row, rows } from '../worker/data.ts';
import { BASELINES, DETECTION_BATCH_SIZE, type Run } from '../src/shared.ts';
import { detectionOverview } from '../src/detection-progress.ts';
import type { Env, Statement } from '../worker/types.ts';

// Exercise the Free D1 query/binding envelope, not just SQLite's higher limits.
class LimitedDatabase extends SQLiteDatabase {
 queries = 0;
 override prepare(sql: string): Statement {
  const original = super.prepare(sql); const count = () => { assert.ok(++this.queries <= 50, 'exceeded Free D1 per-request queries'); };
  const result: Statement = {
   bind: (...values) => { assert.ok(values.length <= 100, 'exceeded D1 bound parameters'); original.bind(...values); return result; },
   first: async <T>(column?: string) => { count(); return original.first<T>(column); },
   all: async <T>() => { count(); return original.all<T>(); },
   run: async () => { count(); return original.run(); },
  }; return result;
 }
}
const privateKey = 'sk-offline-queue-fixture-only';
function fixture() {
 const db = new LimitedDatabase(); const directory = new URL('../migrations/', import.meta.url);
 for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
 const env: Env = { DB: db, APP_ORIGIN: 'http://127.0.0.1:5173', DEV_MODE: 'local', LOCAL_RUNNER_READY: '1', LOCAL_RUNNER_TOKEN: 'offline-queue-runner', MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
 const pending: Promise<unknown>[] = [];
 const call = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  db.queries = 0;
  const response = await handleRequest(new Request('http://127.0.0.1:8787/api/' + path, { method, headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending.splice(0));
  return { status: response.status, data: await response.json() as any };
 };
 const makeTargets = async (count: number) => {
  const endpoint = await call('endpoints', 'POST', { name: '离线测试凭据', base_url: 'https://queue.example.com/v1', group_id: 'default', key: privateKey });
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
   const result = await call('targets', 'POST', { endpoint_id: endpoint.data.id, name: `离线模型 ${index + 1}`, protocol: 'gpt', request_model: BASELINES.gpt.models[0], claimed_model: BASELINES.gpt.models[0], tier: 'low' });
   assert.equal(result.status, 200, result.data.error); ids.push(result.data.id);
  }
  assert.equal((await call('settings/limits', 'PUT', { daily_requests: 100000, monthly_minutes: 5000 })).status, 200);
  return ids;
 };
 const runnerHeaders = { 'X-Local-Runner': env.LOCAL_RUNNER_TOKEN!, 'X-Local-Run': 'offline-job' };
 const claim = (id: string) => call(`runner/batches/${id}/claim`, 'POST', {}, runnerHeaders);
 const lease = (token: string) => ({ Authorization: 'Bearer ' + token });
 return { db, env, call, makeTargets, claim, lease };
}
function evidence() {
 const model = BASELINES.gpt.models[0];
 return { fingerprint: { verdict: 'match', claimed_model: model, model, matches: { [model]: .9 }, thresholds: { [model]: .5 }, valid_samples: 32, planned_samples: 32, reasons: [] }, progress: { logical_completed: 32 }, benchmark: { id: BASELINES.gpt.id, version: BASELINES.gpt.version, content_sha256: BASELINES.gpt.sha256 } };
}

test('more than 200 saved targets support large presets, edits, duplicate detection and stops within Free D1 limits', async t => {
 const f = fixture(); t.after(() => f.db.close()); const targets = await f.makeTargets(205);
 let panel = (await f.call('panel')).data; assert.equal(panel.targets.length, 205); assert.equal(panel.schedules.length, 205);
 const preset = await f.call('run-presets', 'POST', { name: '大型跨组组合', targetIds: [...targets, ...targets] }); assert.equal(preset.status, 200);
 assert.deepEqual((await f.call('panel')).data.run_presets[0].target_ids, targets);
 const edited = await f.call('targets/batch', 'POST', { targetIds: targets, changes: { request_model: 'gpt-offline-alias' } });
 assert.equal(edited.status, 200); assert.equal(edited.data.updated, 205);
 const started = await f.call('runs', 'POST', { targetIds: targets }); assert.equal(started.status, 202, started.data.error);
 assert.equal(started.data.batchIds.length, Math.ceil(205 / DETECTION_BATCH_SIZE)); assert.equal(started.data.runIds.length, 205);
 const repeated = await f.call('runs', 'POST', { targetIds: [...targets].reverse() }); assert.equal(repeated.data.reused, true); assert.equal(repeated.data.setId, started.data.setId);
 panel = (await f.call('panel')).data; assert.equal(panel.runs.length, 205); assert.equal(detectionOverview(panel)!.total, 205);
 assert.equal(panel.usage.daily_requests, 205 * 48); assert.equal(panel.usage.monthly_minutes, Math.ceil(205 / DETECTION_BATCH_SIZE) * 15);
 assert.ok(!JSON.stringify(panel).includes(privateKey)); assert.ok(!JSON.stringify(panel).includes('key_cipher'));
 const stopped = await f.call('runs/stop', 'POST', { runIds: [...started.data.runIds, ...started.data.runIds] }); assert.equal(stopped.status, 200); assert.equal(stopped.data.stopped, 205);
 panel = (await f.call('panel')).data; assert.equal(panel.runs.length, 205);
 assert.equal(detectionOverview(panel)!.percent, 100); assert.equal(detectionOverview(panel)!.stopped, 205);
 assert.equal(panel.usage.daily_requests, 0); assert.equal(panel.usage.monthly_minutes, 0); assert.equal(panel.targets.length, 205);
});

test('large selections run twenty at a time and generate one summary only after the entire selection finishes', async t => {
 const count = DETECTION_BATCH_SIZE * 2 + 1;
 const f = fixture(); t.after(() => f.db.close()); const targets = await f.makeTargets(count);
 await f.call('settings/mail', 'PUT', { enabled: true, notify_manual: true, mode: 'all', host: 'smtp.example.com', port: 465, username: 'offline@example.com', from: 'offline@example.com', to: 'recipient@example.com', password: 'offline-smtp-secret' });
 const started = await f.call('runs', 'POST', { targetIds: targets }); assert.equal(started.status, 202);
 const expectedSizes = [DETECTION_BATCH_SIZE, DETECTION_BATCH_SIZE, 1];
 for (const [index, batchId] of started.data.batchIds.entries()) {
  const claimed = await f.claim(batchId); assert.equal(claimed.status, 200, claimed.data.error); assert.equal(claimed.data.jobs.length, expectedSizes[index]);
  if (index === 0) {
   assert.equal((await f.claim(started.data.batchIds[1])).status, 409);
   const panel = (await f.call('panel')).data; assert.equal(panel.runs.filter((run: Run) => run.status === 'running').length, DETECTION_BATCH_SIZE); assert.equal(detectionOverview(panel)!.queued, count - DETECTION_BATCH_SIZE);
  }
  const prefix = `runner/batches/${batchId}/`; const headers = f.lease(claimed.data.lease);
  for (const job of claimed.data.jobs) assert.equal((await f.call(prefix + 'results/' + job.id, 'POST', { status: 'completed', attempts: 32, report: evidence() }, headers)).status, 200);
  const notices = (await f.call(prefix + 'notices', 'POST', {}, headers)).data.notices;
  assert.equal(notices.length, index === 2 ? 1 : 0);
  if (index === 2) { assert.equal(notices[0].reports.length, count); assert.ok(!JSON.stringify(notices).includes(privateKey)); }
  assert.equal((await f.call(prefix + 'complete', 'POST', { minutes: 1 }, headers)).status, 200);
 }
 const panel = (await f.call('panel')).data;
 assert.equal(detectionOverview(panel)!.percent, 100); assert.equal(detectionOverview(panel)!.total, count); assert.equal(panel.usage.daily_requests, count * 32); assert.equal(panel.usage.monthly_minutes, 3);
 f.db.queries = 0; assert.equal((await pendingNotices(f.env)).length, 1);
});

test('a selection exceeding either budget creates no partial batches or reservations', async t => {
 const count = DETECTION_BATCH_SIZE * 2 + 1;
 const f = fixture(); t.after(() => f.db.close()); const targets = await f.makeTargets(count);
 for (const limits of [{ daily_requests: count * 48 - 1, monthly_minutes: 5000 }, { daily_requests: 100000, monthly_minutes: 44 }]) {
  await f.call('settings/limits', 'PUT', limits);
  assert.equal((await f.call('runs', 'POST', { targetIds: targets })).status, 429);
  const panel = (await f.call('panel')).data; assert.equal(panel.runs.length, 0); assert.equal(panel.run_sets.length, 0); assert.equal(panel.usage.daily_requests, 0); assert.equal(panel.usage.monthly_minutes, 0);
 }
 assert.equal((await f.call('runs', 'POST', { targetIds: [...targets, 'missing'] })).status, 404);
});

test('waiting behind earlier batches does not expire; a dispatched batch times out after its own startup window', async t => {
 const count = DETECTION_BATCH_SIZE * 2 + 1;
 const f = fixture(); t.after(() => f.db.close()); const targets = await f.makeTargets(count);
 const started = (await f.call('runs', 'POST', { targetIds: targets })).data;
 f.db.queries = 0; await f.env.DB.prepare('UPDATE batches SET created_at=?').bind(Date.now() - 4 * 3600000).run(); await expireBatches(f.env);
 assert.equal((await f.call('panel')).data.runs.every((run: Run) => run.status === 'queued'), true);
 f.db.queries = 0; const old = Date.now() - 31 * 60000;
 await f.env.DB.prepare("UPDATE batches SET status='dispatched',dispatched_at=?,dispatch_started_at=? WHERE id=?").bind(old, old, started.batchIds[0]).run(); await expireBatches(f.env);
 const panel = (await f.call('panel')).data; assert.equal(panel.runs.filter((run: Run) => run.status === 'failed').length, DETECTION_BATCH_SIZE); assert.equal(panel.runs.filter((run: Run) => run.status === 'queued').length, count - DETECTION_BATCH_SIZE);
});

test('concurrent dispatch attempts launch one workflow and the next queued batch launches after the slot is freed', async t => {
 const f = fixture(); t.after(() => f.db.close()); const targets = await f.makeTargets(DETECTION_BATCH_SIZE * 2 + 1);
 const started = (await f.call('runs', 'POST', { targetIds: targets })).data;
 const originalFetch = globalThis.fetch; const launched: string[] = [];
 globalThis.fetch = async (input, options) => { assert.match(String(input), /^https:\/\/api.github.com\/repos\//); launched.push(JSON.parse(String(options?.body)).inputs.batch_id); return new Response(null, { status: 204 }); };
 t.after(() => { globalThis.fetch = originalFetch; });
 f.env.DEV_MODE = undefined; f.env.GITHUB_DISPATCH_TOKEN = 'offline-token'; f.env.GITHUB_REPOSITORY = 'offline/detector';
 f.db.queries = 0; await Promise.all(started.batchIds.map((batchId: string) => dispatch(f.env, batchId))); assert.equal(launched.length, 1);
 const first = launched[0]; f.env.DEV_MODE = 'local'; const claimed = (await f.claim(first)).data; const headers = f.lease(claimed.lease);
 for (const job of claimed.jobs) await f.call(`runner/batches/${first}/results/${job.id}`, 'POST', { status: 'completed', attempts: 32, report: evidence() }, headers);
 await f.call(`runner/batches/${first}/complete`, 'POST', { minutes: 1 }, headers);
 f.env.DEV_MODE = undefined; f.db.queries = 0; await dispatchQueued(f.env); assert.equal(launched.length, 2); assert.notEqual(launched[1], first);
 f.db.queries = 0; assert.equal((await rows(f.env, "SELECT * FROM batches WHERE status='dispatched'")).length, 1);
});

test('one automatic round spans multiple twenty-target batches in one aggregate with per-target tiers', async t => {
 const count = DETECTION_BATCH_SIZE * 2 + 2;
 const f = fixture(); t.after(() => f.db.close()); const targets = await f.makeTargets(count);
 for (const [index, target] of targets.entries()) await f.call('schedules/' + target, 'PUT', { enabled: true, interval_minutes: 360, tier: index % 2 ? 'high' : 'low' });
 f.db.queries = 0; await f.env.DB.prepare('UPDATE schedules SET next_due=?').bind(Date.now() - 1).run(); await tick(f.env);
 const panel = (await f.call('panel')).data; assert.equal(panel.runs.length, count); assert.equal(panel.run_sets.length, 1);
 assert.equal(new Set(panel.runs.map((run: Run) => run.batch_id)).size, 3); assert.equal(panel.schedules.every((schedule: any) => schedule.next_due > Date.now()), true);
 assert.equal(panel.runs.filter((run: Run) => run.snapshot.tier === 'high').length, count / 2);
});
