import { BASELINES, DETECTION_BATCH_SIZE, baselineFor, type Limits, type Run, type RunSnapshot, type Protocol, type Tier } from '../src/shared.ts';
import { ApiError, type Env } from './types.ts';
import { decrypt, encrypt, randomToken, digest, verifyOidc } from './security.ts';
import { manualMailEnabled, requestPlan, shanghaiDay, shanghaiMonth, safeReport } from './domain.ts';
import { reportIssues } from '../src/diagnostics.ts';
type Row = Record<string, any>;
export const id = () => crypto.randomUUID();
export async function rows(env: Env, sql: string, ...params: unknown[]): Promise<Row[]> { return (await env.DB.prepare(sql).bind(...params).all<Row>()).results; }
export async function row(env: Env, sql: string, ...params: unknown[]): Promise<Row | null> { return env.DB.prepare(sql).bind(...params).first<Row>(); }
export async function setting<T>(env: Env, name: string): Promise<T> { const value = await row(env, 'SELECT value FROM settings WHERE id=?', name); if (!value) throw new ApiError('配置不存在', 500); return JSON.parse(value.value); }
export async function saveSetting(env: Env, name: string, value: unknown) { await env.DB.prepare('INSERT INTO settings(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(name, JSON.stringify(value)).run(); }
export async function usage(env: Env) {
 const records = await rows(env, 'SELECT kind,COALESCE(SUM(amount),0) AS used FROM quota_reservations WHERE (kind=? AND period=?) OR (kind=? AND period=?) GROUP BY kind', 'requests', shanghaiDay(), 'minutes', shanghaiMonth());
 return { daily_requests: records.find(r => r.kind === 'requests')?.used || 0, monthly_minutes: records.find(r => r.kind === 'minutes')?.used || 0 };
}
export function decodeRun(value: Row): Run { const { key_cipher: _key, ...safe } = value; return { ...safe, snapshot: JSON.parse(value.snapshot), report: value.report ? JSON.parse(value.report) : null, progress: value.progress ? JSON.parse(value.progress) : null } as Run; }
// Reduce reports in D1 before they reach the free Worker's CPU budget. Full
// sample answers and event logs stay in the database for on-demand viewing.
const panelReport = `CASE WHEN r.report IS NULL THEN NULL ELSE json_set(
 json_remove(r.report,'$.results','$.events'),'$.summary_only',json('true'),
 '$.benchmark',json(CASE WHEN json_type(r.report,'$.benchmark')='object' THEN json_object(
  'id',json_extract(r.report,'$.benchmark.id'),'version',json_extract(r.report,'$.benchmark.version'),
  'content_sha256',json_extract(r.report,'$.benchmark.content_sha256')
 ) ELSE NULL END),
 '$.results',json((SELECT json_group_array(json_object('error',json(error),'count',n)) FROM (
  SELECT json_extract(value,'$.error') AS error,COUNT(*) AS n FROM json_each(r.report,'$.results')
  WHERE json_type(value,'$.error')='object' GROUP BY json_extract(value,'$.error') ORDER BY MIN(CAST(key AS INTEGER))
 ))),
 '$.events',json((SELECT json_group_array(json_object('type',type,'payload',json(payload),'count',n)) FROM (
  SELECT json_extract(value,'$.type') AS type,json_extract(value,'$.payload') AS payload,COUNT(*) AS n
  FROM json_each(r.report,'$.events')
  WHERE json_extract(value,'$.type')='run_error' OR json_type(value,'$.payload.error')='object'
  GROUP BY json_extract(value,'$.type'),json_extract(value,'$.payload') ORDER BY MIN(CAST(key AS INTEGER))
 )))) END`;
const publicRunColumns = 'r.id,r.batch_id,r.target_id,r.status,r.source,r.created_at,r.started_at,r.ended_at,r.stop_requested_at,r.attempts,r.reserved_attempts,r.snapshot,r.progress,r.error';
export async function fullReportJson(env: Env, runId: string): Promise<string | null> {
 // Let D1 serialize one complete report, avoiding another parse/stringify pass
 // through large sample payloads inside the Worker. Credentials are excluded.
 const result = await row(env, `SELECT json_object(
  'id',id,'batch_id',batch_id,'target_id',target_id,'status',status,'source',source,
  'created_at',created_at,'started_at',started_at,'ended_at',ended_at,'stop_requested_at',stop_requested_at,
  'attempts',attempts,'reserved_attempts',reserved_attempts,'snapshot',json(snapshot),
  'progress',json(progress),'report',json(report),'error',error
 ) AS value FROM runs WHERE id=?`, runId);
 return result?.value ?? null;
}
export function executionReady(env: Env) { return env.DEV_MODE === 'local' ? env.LOCAL_PREVIEW_ONLY !== '1' && env.LOCAL_RUNNER_READY === '1' : !!(env.GITHUB_DISPATCH_TOKEN && env.GITHUB_REPOSITORY && !env.GITHUB_REPOSITORY.includes('REPLACE_')); }
export async function panel(env: Env) {
 const [groups, endpoints, targets, schedules, runs, limits, mail, counts, mailError, mailTest, runSets, runPresets, presetMembers] = await Promise.all([
  rows(env, 'SELECT * FROM groups ORDER BY created_at'),
  rows(env, 'SELECT id,group_id,name,station_name,base_url,created_at,updated_at FROM endpoints WHERE deleted_at IS NULL ORDER BY created_at'),
  rows(env, 'SELECT id,endpoint_id,name,protocol,request_model,claimed_model,tier,created_at FROM targets WHERE deleted_at IS NULL ORDER BY created_at'), rows(env, 'SELECT s.* FROM schedules s JOIN targets t ON t.id=s.target_id WHERE t.deleted_at IS NULL'),
  rows(env, `WITH applicable AS (
   SELECT r.id,r.status,
    ROW_NUMBER() OVER(PARTITION BY r.target_id ORDER BY r.created_at DESC,r.id DESC) AS latest,
    ROW_NUMBER() OVER(PARTITION BY r.target_id,r.status NOT IN ('queued','running') ORDER BY r.created_at DESC,r.id DESC) AS last_finished,
    ROW_NUMBER() OVER(PARTITION BY r.target_id,r.status NOT IN ('queued','running','cancelled') ORDER BY r.created_at DESC,r.id DESC) AS last_evidence
   FROM runs r JOIN targets t ON t.id=r.target_id JOIN endpoints e ON e.id=t.endpoint_id
   WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND json_extract(r.snapshot,'$.endpoint_id')=e.id AND json_extract(r.snapshot,'$.base_url')=e.base_url
    AND json_extract(r.snapshot,'$.protocol')=t.protocol AND json_extract(r.snapshot,'$.request_model')=t.request_model
    AND json_extract(r.snapshot,'$.claimed_model')=t.claimed_model
  ) SELECT ${publicRunColumns},${panelReport} AS report,1 AS report_summary FROM runs r WHERE status IN ('queued','running')
   OR id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 200)
   OR id IN (SELECT id FROM applicable WHERE latest=1 OR (last_finished=1 AND status NOT IN ('queued','running')) OR (last_evidence=1 AND status NOT IN ('queued','running','cancelled')))
   OR id IN (SELECT m.run_id FROM run_set_members m JOIN run_sets s ON s.id=m.set_id WHERE s.superseded_by IS NULL AND
    (s.ended_at IS NULL OR s.id IN (SELECT id FROM run_sets WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 20)))
   ORDER BY created_at DESC`), setting<Limits>(env, 'limits'), setting<Row>(env, 'mail'), usage(env),
  row(env, "SELECT error FROM notices WHERE status IN ('sent','failed') ORDER BY created_at DESC LIMIT 1"),
  row(env, "SELECT id,status,created_at,sent_at,error FROM notices WHERE kind='test' ORDER BY created_at DESC LIMIT 1"),
  rows(env, `SELECT s.id,s.source,s.created_at,s.ended_at,
   (SELECT json_group_array(run_id) FROM run_set_members WHERE set_id=s.id) AS run_ids,
   (SELECT json_object('id',n.id,'status',n.status,'created_at',n.created_at,'sent_at',n.sent_at,'error',n.error)
    FROM notices n WHERE n.kind='batch' AND n.reference='set:'||s.id ORDER BY n.created_at DESC LIMIT 1) AS notice
   FROM run_sets s WHERE s.superseded_by IS NULL AND (s.ended_at IS NULL OR s.id IN
    (SELECT id FROM run_sets WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 20)) ORDER BY s.created_at DESC`),
  rows(env, 'SELECT * FROM run_presets ORDER BY created_at,id'),
  rows(env, 'SELECT preset_id,target_id FROM run_preset_targets ORDER BY preset_id,position,target_id'),
 ]);
 const { password_cipher, ...safeMail } = mail;
 return { groups, endpoints: endpoints.map(e => ({ ...e, credential_saved: true })), targets, schedules: schedules.map(s => ({ ...s, enabled: !!s.enabled })), runs: runs.map(decodeRun), run_sets: runSets.map(s => ({ ...s, run_ids: JSON.parse(s.run_ids || '[]'), notice: s.notice ? JSON.parse(s.notice) : null })), run_presets: runPresets.map(preset => ({ ...preset, target_ids: presetMembers.filter(member => member.preset_id === preset.id).map(member => member.target_id) })), limits, mail: { ...safeMail, notify_manual: manualMailEnabled(mail), credential_saved: !!password_cipher }, usage: counts, execution_ready: executionReady(env), local: env.DEV_MODE === 'local', preview_only: env.DEV_MODE === 'local' && env.LOCAL_PREVIEW_ONLY === '1', last_mail_error: mailError?.error || null, last_mail_test: mailTest };
}
async function attachRunSet(env: Env, runIds: string[], source: string) {
 const unique = [...new Set(runIds)].sort();
 const setId = await digest(JSON.stringify([source, unique]));
 const existing = await row(env, `SELECT s.id FROM run_sets s WHERE s.source=? AND
  (SELECT COUNT(*) FROM run_set_members WHERE set_id=s.id)=? AND NOT EXISTS(
   SELECT 1 FROM run_set_members WHERE set_id=s.id AND run_id NOT IN (SELECT value FROM json_each(?))
  ) ORDER BY s.created_at DESC LIMIT 1`, source, unique.length, JSON.stringify(unique));
 if (existing) return existing.id as string;
 await env.DB.batch([
  env.DB.prepare('INSERT OR IGNORE INTO run_sets(id,source,created_at) VALUES (?,?,?)').bind(setId, source, Date.now()),
  env.DB.prepare('INSERT OR IGNORE INTO run_set_members(set_id,run_id) SELECT ?,value FROM json_each(?)').bind(setId, JSON.stringify(unique)),
  // A larger selection subsumes an unsent selection of the same active runs.
  env.DB.prepare(`UPDATE run_sets SET superseded_by=? WHERE id!=? AND source=? AND superseded_by IS NULL AND
   (ended_at IS NULL OR EXISTS(SELECT 1 FROM notices WHERE reference='set:'||run_sets.id AND status='pending')) AND
   NOT EXISTS(SELECT 1 FROM run_set_members WHERE set_id=run_sets.id AND run_id NOT IN (SELECT value FROM json_each(?)))`
  ).bind(setId, setId, source, JSON.stringify(unique)),
  env.DB.prepare("UPDATE notices SET status='cancelled' WHERE kind='batch' AND status='pending' AND reference IN (SELECT 'set:'||id FROM run_sets WHERE superseded_by=?)").bind(setId),
 ]);
 await finalizeRunSets(env, setId);
 return setId;
}
export async function createRuns(env: Env, targetIds: string[], overrideTier?: Tier, source = 'manual', tiers: Record<string, Tier> = {}, raceRetries = 2): Promise<{ runId: string; batchIds: string[]; runIds: string[]; setId: string; reused: boolean }> {
 targetIds = [...new Set(targetIds)];
 if (!targetIds.length) throw new ApiError('请至少选择一个检测目标');
 if (!executionReady(env)) throw new ApiError('检测执行器尚未连接。请先完成部署或安装本地原检测器。', 503);
 const active = await rows(env, "SELECT * FROM runs WHERE target_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','running')", JSON.stringify(targetIds));
 const remaining = targetIds.filter(target => !active.some(r => r.target_id === target));
 if (!remaining.length) {
  const runIds = active.map(r => r.id); const setId = await attachRunSet(env, runIds, source);
  return { runId: active[0].batch_id, batchIds: [...new Set(active.map(r => r.batch_id))], runIds, setId, reused: true };
 }
 const selected = await rows(env, 'SELECT t.*,e.name AS endpoint_name,e.station_name,e.base_url,e.key_cipher,e.group_id,g.name AS group_name FROM targets t JOIN endpoints e ON t.endpoint_id=e.id JOIN groups g ON e.group_id=g.id WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))', JSON.stringify(remaining));
 if (selected.length !== remaining.length) throw new ApiError('检测目标不存在', 404);
 const order = new Map(remaining.map((target, index) => [target, index])); selected.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
 const batchIds = Array.from({ length: Math.ceil(selected.length / DETECTION_BATCH_SIZE) }, () => id());
 const now = Date.now(); const day = shanghaiDay(now); const month = shanghaiMonth(now);
 const frozen: { runId: string; batchId: string; target: string; snapshot: RunSnapshot; key: string; maximum: number }[] = [];
 const secrets = new Map<string, string>();
 for (const t of selected) {
  const protocol = t.protocol as Protocol; const baseline = BASELINES[protocol] ? baselineFor(protocol, t.claimed_model) : null; const tier = tiers[t.id] || overrideTier || t.tier as Tier;
  if (!baseline || !baseline.models.includes(t.claimed_model)) throw new ApiError(`${t.name} 暂无对应基准，不能判定此模型`);
  const p = requestPlan(protocol, tier); const runId = id();
  if (!secrets.has(t.endpoint_id)) secrets.set(t.endpoint_id, await decrypt(t.key_cipher, env, 'endpoint:' + t.endpoint_id));
  frozen.push({ runId, batchId: batchIds[Math.floor(frozen.length / DETECTION_BATCH_SIZE)], target: t.id, maximum: p.maximum, key: await encrypt(secrets.get(t.endpoint_id)!, env, 'run:' + runId), snapshot: { target_name: t.name, station_name: t.station_name, endpoint_name: t.station_name === t.endpoint_name ? t.endpoint_name : `${t.station_name} / ${t.endpoint_name}`, base_url: t.base_url, group_name: t.group_name, endpoint_id: t.endpoint_id, protocol, request_model: t.request_model, claimed_model: t.claimed_model, tier, baseline_id: baseline.id, baseline_version: baseline.version, baseline_sha256: baseline.sha256, logical_requests: p.logical, retry_budget: p.retry } });
 }
 const limits = await setting<Limits>(env, 'limits'); const maximum = frozen.reduce((sum, r) => sum + r.maximum, 0);
 const requestReservation = batchIds[0] + ':requests';
 const batches = batchIds.map((batchId, index) => ({ id: batchId, created_at: now + index, maximum: 0 }));
 for (const [index, run] of frozen.entries()) batches[Math.floor(index / DETECTION_BATCH_SIZE)].maximum += run.maximum;
 // One transaction reserves the whole selection, then creates bounded runner
 // batches. JSON inserts avoid per-target SQL queries and D1 binding limits.
 const statements = [
  env.DB.prepare("INSERT INTO quota_reservations SELECT ?,'requests',?,? WHERE (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='requests' AND period=?)+?<=? AND (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='minutes' AND period=?)+?<=?").bind(requestReservation, day, batches[0].maximum, day, maximum, limits.daily_requests, month, batches.length * 15, limits.monthly_minutes),
  env.DB.prepare("INSERT INTO quota_reservations SELECT json_extract(value,'$.id')||':requests','requests',?,json_extract(value,'$.maximum') FROM json_each(?) WHERE json_extract(value,'$.id')!=? AND EXISTS(SELECT 1 FROM quota_reservations WHERE id=?)").bind(day, JSON.stringify(batches), batchIds[0], requestReservation),
  env.DB.prepare("INSERT INTO quota_reservations SELECT json_extract(value,'$.id')||':minutes','minutes',?,15 FROM json_each(?) WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE id=?)").bind(month, JSON.stringify(batches), requestReservation),
  env.DB.prepare("INSERT INTO batches(id,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.created_at') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE id=?)").bind(JSON.stringify(batches), requestReservation),
  env.DB.prepare("INSERT INTO runs(id,batch_id,target_id,source,created_at,snapshot,key_cipher,reserved_attempts,quota_day) SELECT json_extract(value,'$.runId'),json_extract(value,'$.batchId'),json_extract(value,'$.target'),?,?,json_extract(value,'$.snapshot'),json_extract(value,'$.key'),json_extract(value,'$.maximum'),? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE id=?)").bind(source, now, day, JSON.stringify(frozen), requestReservation),
 ];
 try { await env.DB.batch(statements); } catch (error) {
  // 数据库唯一索引负责并发去重；整批事务失败时预算也回滚。
  if (String(error).includes('configuration_deleted')) throw new ApiError('所选模型已删除，请刷新后重新选择', 404);
  if (String(error).includes('UNIQUE')) {
   const concurrent = await rows(env, "SELECT * FROM runs WHERE target_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','running')", JSON.stringify(targetIds));
   if (concurrent.length === targetIds.length) {
    const runIds = concurrent.map(r => r.id); const setId = await attachRunSet(env, runIds, source);
    return { runId: concurrent[0].batch_id, batchIds: [...new Set(concurrent.map(r => r.batch_id))], runIds, setId, reused: true };
   }
   if (raceRetries > 0) return createRuns(env, targetIds, overrideTier, source, tiers, raceRetries - 1);
   throw new ApiError('检测任务正在更新，请稍后重试；已有任务会继续运行。', 409);
  }
  throw error;
 }
 if (!await row(env, 'SELECT id FROM batches WHERE id=?', batchIds[0])) throw new ApiError('用量上限不足，已暂停新检测。可调整预算或等待额度重置。', 429);
 const runIds = [...active.map(r => r.id), ...frozen.map(r => r.runId)]; const setId = await attachRunSet(env, runIds, source);
 return { runId: batchIds[0], batchIds, runIds, setId, reused: false };
}
export async function dispatch(env: Env, batchId: string) {
 if (env.DEV_MODE === 'local') return;
 const now = Date.now();
 const reserved = await env.DB.prepare("UPDATE batches SET status='dispatched',dispatched_at=?,dispatch_started_at=COALESCE(dispatch_started_at,?),last_dispatch_error=NULL WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM batches occupied WHERE occupied.id!=? AND occupied.status IN ('dispatched','running'))").bind(now, now, batchId, batchId).run();
 if (!reserved.meta.changes) return;
 try {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW || 'detector.yml'}/dispatches`, { method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Relay-Desk', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify({ ref: (env.GITHUB_REF || 'refs/heads/main').replace('refs/heads/', ''), inputs: { batch_id: batchId } }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`GitHub 任务启动失败（HTTP ${response.status}）。请检查令牌、工作流和可用额度。`);
 } catch (error) {
  await env.DB.prepare("UPDATE batches SET status='queued',last_dispatch_error=? WHERE id=? AND status='dispatched'").bind(error instanceof Error && error.message.startsWith('GitHub') ? error.message : '暂时无法连接 GitHub 执行器，稍后自动重试。', batchId).run();
 }
}
export async function dispatchQueued(env: Env) {
 if (env.DEV_MODE === 'local') return;
 const next = await row(env, "SELECT id FROM batches WHERE status='queued' AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY created_at,rowid LIMIT 1", Date.now() - 5 * 60000);
 if (next) await dispatch(env, next.id);
}
export async function claim(request: Request, env: Env, batchId: string) {
 const identity = await verifyOidc(request, env); const batch = await row(env, 'SELECT * FROM batches WHERE id=?', batchId);
 if (!batch) throw new ApiError('任务不存在', 404);
 if (['completed', 'failed'].includes(batch.status)) return { done: true };
 const now = Date.now(); const lease = randomToken();
 // 排队跨日或跨月时，在发出任何模型请求前重新预留当期预算。
 const limits = await setting<Limits>(env, 'limits');
 await env.DB.batch([
  env.DB.prepare("UPDATE quota_reservations SET period=? WHERE id=? AND (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='requests' AND period=? AND id!=?)+amount<=?").bind(shanghaiDay(now), batchId + ':requests', shanghaiDay(now), batchId + ':requests', limits.daily_requests),
  env.DB.prepare("UPDATE quota_reservations SET period=? WHERE id=? AND (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='minutes' AND period=? AND id!=?)+amount<=?").bind(shanghaiMonth(now), batchId + ':minutes', shanghaiMonth(now), batchId + ':minutes', limits.monthly_minutes),
 ]);
 const reserved = await row(env, "SELECT COUNT(*) AS n FROM quota_reservations WHERE (id=? AND period=?) OR (id=? AND period=?)", batchId + ':requests', shanghaiDay(now), batchId + ':minutes', shanghaiMonth(now));
 if (reserved!.n !== (batch.kind === 'mail' ? 1 : 2)) throw new ApiError('当期预算不足，任务尚未开始。', 429);
 const result = await env.DB.prepare("UPDATE batches SET status='running',started_at=?,heartbeat_at=?,claimed_by=?,lease_hash=?,lease_until=? WHERE id=? AND status IN ('queued','dispatched') AND NOT EXISTS(SELECT 1 FROM batches occupied WHERE occupied.id!=? AND occupied.status IN ('dispatched','running'))").bind(now, now, String(identity.run_id), await digest(lease), now + 15 * 60000, batchId, batchId).run();
 if (!result.meta.changes) {
  if (['completed', 'failed'].includes((await row(env, 'SELECT status FROM batches WHERE id=?', batchId))?.status)) return { done: true };
  throw new ApiError('任务已被领取或前一批尚未结束，请等待排队。', 409);
 }
 if (batch.kind === 'mail') return { batch_id: batchId, lease, kind: 'mail', mail: await mailCredential(env), notices: JSON.parse(batch.mail_payload || '[]') };
 await env.DB.prepare("UPDATE runs SET status='running',started_at=? WHERE batch_id=? AND status='queued'").bind(now, batchId).run();
 const tasks = await rows(env, "SELECT * FROM runs WHERE batch_id=? AND status='running'", batchId);
 await env.DB.prepare('UPDATE runs SET quota_day=? WHERE batch_id=?').bind(shanghaiDay(now), batchId).run();
 const jobs = [];
 for (const task of tasks) jobs.push({ id: task.id, config: JSON.parse(task.snapshot), api_key: await decrypt(task.key_cipher, env, 'run:' + task.id), maximum_attempts: task.reserved_attempts, stop_requested: task.stop_requested_at !== null });
 return { batch_id: batchId, lease, kind: 'detection', jobs, timeout_seconds: 600 };
}
export async function requireLease(request: Request, env: Env, batchId: string) {
 const lease = request.headers.get('Authorization')?.replace(/^Bearer /, '');
 const batch = await row(env, 'SELECT * FROM batches WHERE id=?', batchId);
 if (!lease || !batch || batch.lease_hash !== await digest(lease) || batch.lease_until < Date.now() || !['running', 'completed'].includes(batch.status)) throw new ApiError('任务凭证已失效', 401);
 return batch;
}
export async function mailCredential(env: Env) {
 const mail = await setting<Row>(env, 'mail');
 if (!mail.enabled) return null;
 return { ...mail, password: await decrypt(mail.password_cipher, env, 'smtp') };
}
export async function reconcileRequests(env: Env, batchId: string) {
 await env.DB.prepare("UPDATE quota_reservations SET amount=(SELECT COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN reserved_attempts ELSE attempts END),0) FROM runs WHERE batch_id=?) WHERE id=?").bind(batchId, batchId + ':requests').run();
}
export async function stopRuns(env: Env, runIds: string[]) {
 const selection = JSON.stringify(runIds);
 const selected = await rows(env, 'SELECT id,batch_id FROM runs WHERE id IN (SELECT value FROM json_each(?))', selection);
 if (selected.length !== runIds.length) throw new ApiError('检测任务不存在，请刷新后重试', 404);
 const now = Date.now();
 // Stop the exact runs the user saw. Queued runs have no provider requests;
 // running runs keep their lease, credential and reservation until runner ACK.
 await env.DB.batch([
  env.DB.prepare("UPDATE runs SET stop_requested_at=COALESCE(stop_requested_at,?),status='cancelled',ended_at=?,attempts=0,key_cipher='',error=NULL WHERE id IN (SELECT value FROM json_each(?)) AND status='queued'").bind(now, now, selection),
  env.DB.prepare("UPDATE runs SET stop_requested_at=COALESCE(stop_requested_at,?) WHERE id IN (SELECT value FROM json_each(?)) AND status='running'").bind(now, selection),
  // A dispatched workflow can still start and immediately exit. Retain its
  // minute reservation conservatively; a never-dispatched batch costs zero.
  env.DB.prepare("UPDATE batches SET status='completed',ended_at=?,used_minutes=CASE WHEN status='queued' THEN 0 ELSE reserved_minutes END WHERE id IN (SELECT batch_id FROM runs WHERE id IN (SELECT value FROM json_each(?))) AND status IN ('queued','dispatched') AND NOT EXISTS(SELECT 1 FROM runs WHERE batch_id=batches.id AND status IN ('queued','running'))").bind(now, selection),
  env.DB.prepare("UPDATE quota_reservations SET amount=0 WHERE id IN (SELECT id||':minutes' FROM batches WHERE status='completed' AND used_minutes=0 AND id IN (SELECT batch_id FROM runs WHERE id IN (SELECT value FROM json_each(?))))").bind(selection),
  env.DB.prepare("UPDATE quota_reservations SET amount=(SELECT COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN reserved_attempts ELSE attempts END),0) FROM runs WHERE batch_id=substr(quota_reservations.id,1,length(quota_reservations.id)-9)) WHERE kind='requests' AND id IN (SELECT batch_id||':requests' FROM runs WHERE id IN (SELECT value FROM json_each(?)))").bind(selection),
 ]);
 await finalizeRunSets(env);
 const states = await rows(env, 'SELECT id,status,stop_requested_at FROM runs WHERE id IN (SELECT value FROM json_each(?))', selection);
 return { runs: states, stopped: states.filter(run => run.status === 'cancelled').length, stopping: states.filter(run => run.status === 'running' && run.stop_requested_at !== null).length };
}
export async function finishRun(env: Env, batchId: string, runId: string, body: Row) {
 const run = await row(env, 'SELECT * FROM runs WHERE id=? AND batch_id=?', runId, batchId);
 if (!run) throw new ApiError('任务不存在', 404);
 if (!['queued', 'running'].includes(run.status)) { await finalizeRunSets(env); return { ok: true, reused: true }; }
 const secret = await decrypt(run.key_cipher, env, 'run:' + run.id);
 const report = body.report ? safeReport(body.report, [secret]) : null;
 if (body.status === 'cancelled' && run.stop_requested_at === null) throw new ApiError('此任务尚未申请停止', 409);
 const status = ['completed', 'failed', 'timed_out', 'cancelled'].includes(body.status) ? body.status : 'failed';
 const attempts = Number.isSafeInteger(body.attempts) && body.attempts >= 0 && body.attempts <= run.reserved_attempts ? body.attempts : run.reserved_attempts;
 const issue = reportIssues(report, status)[0];
 const error = status === 'timed_out' ? '检测超过 10 分钟，已保存有效样本。' : status === 'failed' ? issue?.summary || '检测未完成，请查看报告中的错误摘要。' : null;
 // Check the stop flag inside the write: a stop arriving during final result
 // processing must not be overwritten by a late success or failure response.
 await env.DB.prepare(`UPDATE runs SET status=CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE ? END,ended_at=?,
  report=CASE WHEN stop_requested_at IS NOT NULL AND COALESCE(?,report) IS NOT NULL THEN json_set(COALESCE(?,report),'$.operational_status','paused') ELSE COALESCE(?,report) END,
  attempts=?,error=CASE WHEN stop_requested_at IS NOT NULL THEN NULL ELSE ? END,key_cipher=''
  WHERE id=? AND status IN ('queued','running')`).bind(status, Date.now(), report ? JSON.stringify(report) : null, report ? JSON.stringify(report) : null, report ? JSON.stringify(report) : null, attempts, error, runId).run();
 await reconcileRequests(env, batchId);
 await finalizeRunSets(env);
 return { ok: true };
}
export async function finishBatch(env: Env, batchId: string, minutes: number) {
 const unfinished = await row(env, "SELECT id FROM runs WHERE batch_id=? AND status IN ('queued','running')", batchId);
 if (unfinished) throw new ApiError('还有未提交的检测结果', 409);
 const batch = await row(env, 'SELECT * FROM batches WHERE id=?', batchId);
 if (!batch || batch.status === 'completed') return { ok: true, reused: true };
 const used = Math.max(1, Math.min(15, Math.ceil(minutes)));
 await env.DB.batch([
  env.DB.prepare("UPDATE batches SET status='completed',ended_at=?,used_minutes=? WHERE id=? AND status='running'").bind(Date.now(), used, batchId),
  env.DB.prepare('UPDATE quota_reservations SET amount=? WHERE id=?').bind(used, batchId + ':minutes'),
 ]);
 return { ok: true };
}
export async function expireBatches(env: Env) {
 const expired = await rows(env, "SELECT id,status,kind,mail_payload FROM batches WHERE (status='running' AND lease_until<?) OR (status IN ('queued','dispatched') AND (status='dispatched' OR last_dispatch_error IS NOT NULL) AND COALESCE(dispatch_started_at,dispatched_at,created_at)<?) ORDER BY created_at LIMIT 1", Date.now() - 120000, Date.now() - 30 * 60000);
 for (const batch of expired) {
  const running = batch.status === 'running';
  await env.DB.batch([
   env.DB.prepare("UPDATE runs SET status=CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,ended_at=?,attempts=CASE WHEN ? THEN reserved_attempts ELSE 0 END,error=CASE WHEN stop_requested_at IS NOT NULL THEN '停止请求已保存，但执行器中断，无法确认最后的请求数；按预留上限计入预算。' ELSE ? END,key_cipher='' WHERE batch_id=? AND status IN ('queued','running')").bind(Date.now(), running ? 1 : 0, running ? '执行器中断，已保留此前回传的报告。' : '排队超过 30 分钟，请检查 GitHub 额度和执行器配置。', batch.id),
   env.DB.prepare("UPDATE batches SET status='failed',ended_at=?,error=? WHERE id=?").bind(Date.now(), '执行器未完成任务', batch.id),
   env.DB.prepare('UPDATE quota_reservations SET amount=? WHERE id=?').bind(running ? 15 : 0, batch.id + ':minutes'),
  ]);
  await reconcileRequests(env, batch.id);
  if (batch.kind === 'mail') for (const notice of JSON.parse(batch.mail_payload || '[]')) {
   await env.DB.prepare("UPDATE notices SET status='failed',error=? WHERE id=? AND status IN ('pending','processing')").bind(running ? '邮件执行器中断，发送结果未确认。请检查收件箱后再试。' : '邮件任务排队超时，请检查 GitHub 执行器和额度。', notice.id).run();
  }
 }
 await finalizeRunSets(env);
 return expired.length;
}

function notificationState(run: Row) {
 if (run.status !== 'completed') return run.status;
 const report = run.report ? JSON.parse(run.report) : null;
 return report?.fingerprint?.valid_samples > 0 ? report.fingerprint.verdict : 'insufficient';
}
export async function finalizeRunSets(env: Env, setId?: string) {
 // Bridge tasks created by the previous Worker between migration and deployment.
 await env.DB.batch([
  env.DB.prepare(`INSERT OR IGNORE INTO run_sets(id,source,created_at,ended_at)
   SELECT b.id,(SELECT source FROM runs WHERE batch_id=b.id ORDER BY created_at LIMIT 1),b.created_at,
    CASE WHEN b.status IN ('completed','failed') AND NOT EXISTS(SELECT 1 FROM notices n JOIN runs r ON r.id=n.reference WHERE r.batch_id=b.id AND n.kind='run' AND n.status='pending')
      OR EXISTS(SELECT 1 FROM notices n JOIN runs r ON r.id=n.reference WHERE r.batch_id=b.id AND n.kind='run' AND n.status='processing')
     THEN COALESCE(b.ended_at,b.created_at) ELSE NULL END
   FROM batches b WHERE b.kind='detection' AND EXISTS(SELECT 1 FROM runs WHERE batch_id=b.id)
    AND NOT EXISTS(SELECT 1 FROM run_set_members m JOIN runs r ON r.id=m.run_id WHERE r.batch_id=b.id)`),
  env.DB.prepare('INSERT OR IGNORE INTO run_set_members(set_id,run_id) SELECT b.id,r.id FROM batches b JOIN runs r ON r.batch_id=b.id JOIN run_sets s ON s.id=b.id'),
  env.DB.prepare("UPDATE notices SET status='cancelled' WHERE kind='run' AND status='pending' AND reference IN (SELECT run_id FROM run_set_members)"),
 ]);
 const waiting = await rows(env, "SELECT * FROM run_sets WHERE ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM run_set_members m JOIN runs r ON r.id=m.run_id WHERE m.set_id=run_sets.id AND r.status IN ('queued','running'))" + (setId ? ' AND id=?' : '') + ' ORDER BY created_at LIMIT 3', ...(setId ? [setId] : []));
 if (!waiting.length) return;
 const mail = await setting<Row>(env, 'mail');
 for (const group of waiting) {
  const reports = await rows(env, 'SELECT r.* FROM runs r JOIN run_set_members m ON r.id=m.run_id WHERE m.set_id=?', group.id);
  if (!reports.length || reports.some(r => ['queued', 'running'].includes(r.status))) continue;
  const manual = group.source !== 'scheduled';
  let send = !group.superseded_by && mail.enabled && reports.some(r => r.status !== 'cancelled') && (manual ? manualMailEnabled(mail) : mail.mode !== 'daily');
  if (send && !manual && mail.mode === 'changes') {
   send = false;
   const previousRuns = await rows(env, `SELECT r.target_id,r.report,r.status FROM runs r WHERE r.id IN (
    SELECT (SELECT r2.id FROM runs r2 JOIN run_set_members m ON m.run_id=r2.id JOIN run_sets s ON s.id=m.set_id
     WHERE r2.target_id=current.target_id AND s.source='scheduled' AND s.id!=? AND s.created_at<=? AND s.ended_at IS NOT NULL
      AND s.superseded_by IS NULL AND r2.status NOT IN ('queued','running','cancelled') ORDER BY s.created_at DESC LIMIT 1)
    FROM runs current JOIN run_set_members member ON member.run_id=current.id WHERE member.set_id=?)`, group.id, group.created_at, group.id);
   for (const run of reports.filter(r => r.status !== 'cancelled')) {
    const previous = previousRuns.find(previous => previous.target_id === run.target_id);
    const state = notificationState(run);
    if (state !== (previous ? notificationState(previous) : null) && (previous || state !== 'match')) { send = true; break; }
   }
  }
  const now = Date.now();
  // Decision and unique notice creation commit together, including mail-off decisions.
  await env.DB.batch([
   env.DB.prepare("INSERT OR IGNORE INTO notices(id,kind,reference,created_at) SELECT ?,'batch',?,? WHERE ? AND EXISTS(SELECT 1 FROM run_sets WHERE id=? AND ended_at IS NULL AND superseded_by IS NULL) AND NOT EXISTS(SELECT 1 FROM run_set_members m JOIN runs r ON r.id=m.run_id WHERE m.set_id=? AND r.status IN ('queued','running'))").bind(id(), 'set:' + group.id, now, send ? 1 : 0, group.id, group.id),
   env.DB.prepare("UPDATE run_sets SET ended_at=? WHERE id=? AND ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM run_set_members m JOIN runs r ON r.id=m.run_id WHERE m.set_id=? AND r.status IN ('queued','running'))").bind(now, group.id, group.id),
  ]);
 }
}
export async function pendingNotices(env: Env) {
 const records = await rows(env, "SELECT * FROM notices WHERE status='pending' ORDER BY created_at LIMIT 3");
 const result: Row[] = [];
 for (const notice of records) {
  let reports: Row[] = []; let source: string | undefined;
  if (notice.kind === 'batch') {
   const group = await row(env, 'SELECT * FROM run_sets WHERE id=?', notice.reference.slice(4));
   if (!group?.ended_at || group.superseded_by) continue;
   reports = await rows(env, 'SELECT r.* FROM runs r JOIN run_set_members m ON r.id=m.run_id WHERE m.set_id=?', group.id);
   source = group.source;
   if (reports.some(r => ['queued', 'running'].includes(r.status))) continue;
  } else if (notice.kind === 'daily') {
   // At 09:00, wait for the automatic rounds already in progress to finish.
   if (await row(env, "SELECT id FROM run_sets WHERE source='scheduled' AND superseded_by IS NULL AND created_at<=? AND created_at>=? AND ended_at IS NULL LIMIT 1", notice.created_at, notice.created_at - 86400000)) continue;
   reports = await rows(env, `SELECT DISTINCT r.* FROM runs r JOIN run_set_members m ON m.run_id=r.id JOIN run_sets s ON s.id=m.set_id
    WHERE s.source='scheduled' AND s.superseded_by IS NULL AND s.ended_at IS NOT NULL AND
     ((s.ended_at>=? AND s.ended_at<=?) OR (s.created_at>=? AND s.created_at<=? AND s.ended_at>?)) ORDER BY r.ended_at DESC`,
    notice.created_at - 86400000, notice.created_at, notice.created_at - 86400000, notice.created_at, notice.created_at);
  } else if (notice.kind === 'run') reports = await rows(env, 'SELECT * FROM runs WHERE id=?', notice.reference);
  result.push({ ...notice, source, reports: reports.map(decodeRun) });
 }
 return result;
}
export async function noticeInBatch(env: Env, notice: Row, batchId: string) {
 const batch = await row(env, 'SELECT * FROM batches WHERE id=?', batchId);
 if (batch?.kind === 'mail') return JSON.parse(batch.mail_payload || '[]').some((n: Row) => n.id === notice.id);
 if (notice.kind === 'batch') return !!await row(env, 'SELECT r.id FROM runs r JOIN run_set_members m ON r.id=m.run_id WHERE m.set_id=? AND r.batch_id=? LIMIT 1', notice.reference.slice(4), batchId);
 return notice.kind === 'run' && !!await row(env, 'SELECT id FROM runs WHERE id=? AND batch_id=?', notice.reference, batchId);
}
export async function noticeAllowed(env: Env, notice: Row, mail: Row) {
 if (!mail.enabled) return false;
 if (notice.kind === 'test') return true;
 if (notice.kind === 'daily') return mail.mode === 'daily';
 const group = notice.kind === 'batch' ? await row(env, 'SELECT * FROM run_sets WHERE id=?', notice.reference.slice(4)) : null;
 if (notice.kind === 'batch' && (!group?.ended_at || group.superseded_by)) return false;
 const run = notice.kind === 'run' ? await row(env, 'SELECT source FROM runs WHERE id=?', notice.reference) : null;
 const source = group?.source || run?.source;
 return !!source && (source === 'scheduled' ? mail.mode !== 'daily' : manualMailEnabled(mail));
}
