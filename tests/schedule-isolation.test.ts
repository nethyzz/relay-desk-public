import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SQLiteDatabase } from '../scripts/sqlite.ts';
import { handleRequest, tick } from '../worker/index.ts';
import { BASELINES, type Protocol, type Tier } from '../src/shared.ts';
import { rows } from '../worker/data.ts';
import type { Env } from '../worker/types.ts';

function fixture() {
 const db = new SQLiteDatabase(); const migrations = new URL('../migrations/', import.meta.url);
 for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
 const env: Env = { DB: db, APP_ORIGIN: 'http://127.0.0.1:5173', DEV_MODE: 'local', LOCAL_RUNNER_READY: '1', LOCAL_RUNNER_TOKEN: 'schedule-fixture-token', MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
 const call = async (path: string, method: string, value: unknown) => {
  const response = await handleRequest(new Request('http://127.0.0.1:8787/api/' + path, { method, headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }), env, { waitUntil() {} });
  assert.equal(response.status, 200); return await response.json() as any;
 };
 const setup = async (protocol: Protocol, tier: Tier, name: string, claimed = BASELINES[protocol].models[0]) => {
  const endpoint = (await call('endpoints', 'POST', { name, base_url: 'https://api.example.com/v1', key: 'mock-schedule-private-key', group_id: 'default' })).id;
  const target = (await call('targets', 'POST', { name, endpoint_id: endpoint, protocol, request_model: claimed, claimed_model: claimed, tier })).id;
  await call('schedules/' + target, 'PUT', { enabled: true, tier, interval_minutes: 360 });
  await db.prepare('UPDATE schedules SET next_due=? WHERE target_id=?').bind(Date.now() - 1, target).run();
  return target as string;
 };
 return { db, env, setup };
}

test('an unsupported automatic target keeps its own error while supported GPT and Claude targets share a round', async () => {
 const f = fixture();
 try {
  const unsupported = await f.setup('gpt', 'medium', '未收录模型', 'custom-unrecorded-model');
  const gpt = await f.setup('gpt', 'low', 'GPT');
  const claude = await f.setup('claude', 'high', 'Claude');
  const before = Date.now(); await tick(f.env);
  const runs = await rows(f.env, 'SELECT target_id,source,snapshot,batch_id FROM runs');
  assert.deepEqual(new Set(runs.map(r => r.target_id)), new Set([gpt, claude]));
  assert.equal(new Set(runs.map(r => r.batch_id)).size, 1);
  assert.ok(runs.every(r => r.source === 'scheduled'));
  assert.equal(JSON.parse(runs.find(r => r.target_id === gpt)!.snapshot).tier, 'low');
  assert.equal(JSON.parse(runs.find(r => r.target_id === claude)!.snapshot).tier, 'high');
  const sets = await rows(f.env, 'SELECT set_id FROM run_set_members');
  assert.equal(sets.length, 2); assert.equal(new Set(sets.map(s => s.set_id)).size, 1);
  const schedules = await rows(f.env, 'SELECT target_id,next_due,last_error,enabled FROM schedules');
  assert.match(schedules.find(s => s.target_id === unsupported)!.last_error, /暂无对应基准/);
  assert.ok(schedules.filter(s => s.target_id !== unsupported).every(s => s.last_error === null));
  assert.ok(schedules.every(s => s.enabled === 1 && s.next_due > before));
  await tick(f.env); assert.equal((await rows(f.env, 'SELECT id FROM runs')).length, 2, 'not-yet-due schedules do not retry or duplicate requests');
 } finally { f.db.close(); }
});

test('a round containing only unsupported targets creates no jobs or quota reservations', async () => {
 const f = fixture();
 try {
  const target = await f.setup('claude', 'low', '未收录 Claude', 'custom-unrecorded-claude');
  const before = Date.now(); await tick(f.env);
  assert.equal((await rows(f.env, 'SELECT id FROM batches')).length, 0);
  assert.equal((await rows(f.env, 'SELECT id FROM quota_reservations')).length, 0);
  const [schedule] = await rows(f.env, 'SELECT * FROM schedules WHERE target_id=?', target);
  assert.match(schedule.last_error, /暂无对应基准/); assert.ok(schedule.next_due > before); assert.equal(schedule.enabled, 1);
  await f.db.prepare('UPDATE targets SET claimed_model=? WHERE id=?').bind(BASELINES.claude.models[0], target).run();
  await f.db.prepare('UPDATE schedules SET next_due=? WHERE target_id=?').bind(Date.now() - 1, target).run();
  await tick(f.env);
  assert.equal((await rows(f.env, 'SELECT id FROM runs WHERE target_id=?', target)).length, 1);
  assert.equal((await rows(f.env, 'SELECT last_error FROM schedules WHERE target_id=?', target))[0].last_error, null, 'fixing the model clears the unsupported error on its next due round');
 } finally { f.db.close(); }
});
