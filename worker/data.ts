import { BASELINES, baselineFor, type Limits, type Run, type RunSnapshot, type Protocol, type Tier } from '../src/shared.ts';
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
export function executionReady(env: Env) { return env.DEV_MODE === 'local' ? env.LOCAL_PREVIEW_ONLY !== '1' && env.LOCAL_RUNNER_READY === '1' : !!(env.GITHUB_DISPATCH_TOKEN && env.GITHUB_REPOSITORY && !env.GITHUB_REPOSITORY.includes('REPLACE_')); }
export async function panel(env: Env) {
 const [groups, endpoints, targets, schedules, runs, limits, mail, counts, mailError, mailTest, runSets, runPresets, presetMembers] = await Promise.all([
  rows(env, 'SELECT * FROM groups ORDER BY created_at'),
  rows(env, 'SELECT id,group_id,name,station_name,base_url,created_at,updated_at FROM endpoints ORDER BY created_at'),
  rows(env, 'SELECT * FROM targets ORDER BY created_at'), rows(env, 'SELECT * FROM schedules'),
  rows(env, 'SELECT * FROM runs ORDER BY created_at DESC LIMIT 200'), setting<Limits>(env, 'limits'), setting<Row>(env, 'mail'), usage(env),
  row(env, "SELECT error FROM notices WHERE status IN ('sent','failed') ORDER BY created_at DESC LIMIT 1"),
  row(env, "SELECT id,status,created_at,sent_at,error FROM notices WHERE kind='test' ORDER BY created_at DESC LIMIT 1"),
  rows(env, `SELECT s.id,s.source,s.created_at,s.ended_at,
   (SELECT json_group_array(run_id) FROM run_set_members WHERE set_id=s.id) AS run_ids,
   (SELECT json_object('id',n.id,'status',n.status,'created_at',n.created_at,'sent_at',n.sent_at,'error',n.error)
    FROM notices n WHERE n.kind='batch' AND n.reference='set:'||s.id ORDER BY n.created_at DESC LIMIT 1) AS notice
   FROM run_sets s WHERE s.superseded_by IS NULL ORDER BY s.created_at DESC LIMIT 20`),
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
   SELECT 1 FROM run_set_members WHERE set_id=s.id AND run_id NOT IN (${unique.map(() => '?').join(',')})
  ) ORDER BY s.created_at DESC LIMIT 1`, source, unique.length, ...unique);
 if (existing) return existing.id as string;
 await env.DB.batch([
  env.DB.prepare('INSERT OR IGNORE INTO run_sets(id,source,created_at) VALUES (?,?,?)').bind(setId, source, Date.now()),
  ...unique.map(runId => env.DB.prepare('INSERT OR IGNORE INTO run_set_members(set_id,run_id) VALUES (?,?)').bind(setId, runId)),
  // A larger selection subsumes an unsent selection of the same active runs.
  env.DB.prepare(`UPDATE run_sets SET superseded_by=? WHERE id!=? AND source=? AND superseded_by IS NULL AND
   (ended_at IS NULL OR EXISTS(SELECT 1 FROM notices WHERE reference='set:'||run_sets.id AND status='pending')) AND
   NOT EXISTS(SELECT 1 FROM run_set_members WHERE set_id=run_sets.id AND run_id NOT IN (${unique.map(() => '?').join(',')}))`
  ).bind(setId, setId, source, ...unique),
  env.DB.prepare("UPDATE notices SET status='cancelled' WHERE kind='batch' AND status='pending' AND reference IN (SELECT 'set:'||id FROM run_sets WHERE superseded_by=?)").bind(setId),
 ]);
 await finalizeRunSets(env, setId);
 return setId;
}
export async function createRuns(env: Env, targetIds: string[], overrideTier?: Tier, source = 'manual', tiers: Record<string, Tier> = {}, raceRetries = 2): Promise<{ runId: string; runIds: string[]; setId: string; reused: boolean }> {
 if (!executionReady(env)) throw new ApiError('检测执行器尚未连接。请先完成部署或安装本地原检测器。', 503);
 const active = await rows(env, `SELECT * FROM runs WHERE target_id IN (${targetIds.map(() => '?').join(',')}) AND status IN ('queued','running')`, ...targetIds);
 const remaining = targetIds.filter(target => !active.some(r => r.target_id === target));
 if (!remaining.length) {
  const runIds = active.map(r => r.id); const setId = await attachRunSet(env, runIds, source);
  return { runId: active[0].batch_id, runIds, setId, reused: true };
 }
 const selected = await rows(env, `SELECT t.*,e.name AS endpoint_name,e.station_name,e.base_url,e.key_cipher,e.group_id,g.name AS group_name FROM targets t JOIN endpoints e ON t.endpoint_id=e.id JOIN groups g ON e.group_id=g.id WHERE t.id IN (${remaining.map(() => '?').join(',')})`, ...remaining);
 if (selected.length !== remaining.length) throw new ApiError('检测目标不存在', 404);
 const batchId = id(); const now = Date.now(); const day = shanghaiDay(now); const month = shanghaiMonth(now);
 const frozen: { runId: string; target: string; snapshot: RunSnapshot; key: string; maximum: number }[] = [];
 for (const t of selected) {
  const protocol = t.protocol as Protocol; const baseline = BASELINES[protocol] ? baselineFor(protocol, t.claimed_model) : null; const tier = tiers[t.id] || overrideTier || t.tier as Tier;
  if (!baseline || !baseline.models.includes(t.claimed_model)) throw new ApiError(`${t.name} 暂无对应基准，不能判定此模型`);
  const p = requestPlan(protocol, tier); const runId = id();
  const secret = await decrypt(t.key_cipher, env, 'endpoint:' + t.endpoint_id);
  frozen.push({ runId, target: t.id, maximum: p.maximum, key: await encrypt(secret, env, 'run:' + runId), snapshot: { target_name: t.name, station_name: t.station_name, endpoint_name: t.station_name === t.endpoint_name ? t.endpoint_name : `${t.station_name} / ${t.endpoint_name}`, base_url: t.base_url, group_name: t.group_name, endpoint_id: t.endpoint_id, protocol, request_model: t.request_model, claimed_model: t.claimed_model, tier, baseline_id: baseline.id, baseline_version: baseline.version, baseline_sha256: baseline.sha256, logical_requests: p.logical, retry_budget: p.retry } });
 }
 const limits = await setting<Limits>(env, 'limits'); const maximum = frozen.reduce((sum, r) => sum + r.maximum, 0);
 const requestReservation = batchId + ':requests'; const minuteReservation = batchId + ':minutes';
 const statements = [
  env.DB.prepare("INSERT INTO quota_reservations SELECT ?,'requests',?,? WHERE (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='requests' AND period=?)+?<=?").bind(requestReservation, day, maximum, day, maximum, limits.daily_requests),
  env.DB.prepare("INSERT INTO quota_reservations SELECT ?,'minutes',?,15 WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE id=?) AND (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='minutes' AND period=?)+15<=?").bind(minuteReservation, month, requestReservation, month, limits.monthly_minutes),
  env.DB.prepare("INSERT INTO batches(id,created_at) SELECT ?,? WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE id=?)").bind(batchId, now, minuteReservation),
  ...frozen.map(r => env.DB.prepare("INSERT INTO runs(id,batch_id,target_id,source,created_at,snapshot,key_cipher,reserved_attempts,quota_day) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM batches WHERE id=?)").bind(r.runId, batchId, r.target, source, now, JSON.stringify(r.snapshot), r.key, r.maximum, day, batchId)),
  env.DB.prepare('DELETE FROM quota_reservations WHERE id=? AND NOT EXISTS(SELECT 1 FROM batches WHERE id=?)').bind(requestReservation, batchId),
 ];
 try { await env.DB.batch(statements); } catch (error) {
  // 数据库唯一索引负责并发去重；整批事务失败时预算也回滚。
  if (String(error).includes('UNIQUE')) {
   const concurrent = await rows(env, `SELECT * FROM runs WHERE target_id IN (${targetIds.map(() => '?').join(',')}) AND status IN ('queued','running')`, ...targetIds);
   if (concurrent.length === targetIds.length) {
    const runIds = concurrent.map(r => r.id); const setId = await attachRunSet(env, runIds, source);
    return { runId: concurrent[0].batch_id, runIds, setId, reused: true };
   }
   if (raceRetries > 0) return createRuns(env, targetIds, overrideTier, source, tiers, raceRetries - 1);
   throw new ApiError('检测任务正在更新，请稍后重试；已有任务会继续运行。', 409);
  }
  throw error;
 }
 if (!await row(env, 'SELECT id FROM batches WHERE id=?', batchId)) throw new ApiError('用量上限不足，已暂停新检测。可调整预算或等待额度重置。', 429);
 const runIds = [...active.map(r => r.id), ...frozen.map(r => r.runId)]; const setId = await attachRunSet(env, runIds, source);
 return { runId: batchId, runIds, setId, reused: false };
}
export async function dispatch(env: Env, batchId: string) {
 if (env.DEV_MODE === 'local') return;
 const reserved = await env.DB.prepare("UPDATE batches SET status='dispatched',dispatched_at=?,last_dispatch_error=NULL WHERE id=? AND status='queued'").bind(Date.now(), batchId).run();
 if (!reserved.meta.changes) return;
 try {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW || 'detector.yml'}/dispatches`, { method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Relay-Desk', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify({ ref: (env.GITHUB_REF || 'refs/heads/main').replace('refs/heads/', ''), inputs: { batch_id: batchId } }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`GitHub 任务启动失败（HTTP ${response.status}）。请检查令牌、工作流和可用额度。`);
 } catch (error) {
  await env.DB.prepare("UPDATE batches SET status='queued',last_dispatch_error=? WHERE id=? AND status='dispatched'").bind(error instanceof Error && error.message.startsWith('GitHub') ? error.message : '暂时无法连接 GitHub 执行器，稍后自动重试。', batchId).run();
 }
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
 const result = await env.DB.prepare("UPDATE batches SET status='running',started_at=?,heartbeat_at=?,claimed_by=?,lease_hash=?,lease_until=? WHERE id=? AND status IN ('queued','dispatched')").bind(now, now, String(identity.run_id), await digest(lease), now + 15 * 60000, batchId).run();
 if (!result.meta.changes) throw new ApiError('任务已由其他执行器领取', 409);
 if (batch.kind === 'mail') return { batch_id: batchId, lease, kind: 'mail', mail: await mailCredential(env), notices: JSON.parse(batch.mail_payload || '[]') };
 await env.DB.prepare("UPDATE runs SET status='running',started_at=? WHERE batch_id=? AND status='queued'").bind(now, batchId).run();
 const tasks = await rows(env, 'SELECT * FROM runs WHERE batch_id=?', batchId);
 await env.DB.prepare('UPDATE runs SET quota_day=? WHERE batch_id=?').bind(shanghaiDay(now), batchId).run();
 const jobs = [];
 for (const task of tasks) jobs.push({ id: task.id, config: JSON.parse(task.snapshot), api_key: await decrypt(task.key_cipher, env, 'run:' + task.id), maximum_attempts: task.reserved_attempts });
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
export async function finishRun(env: Env, batchId: string, runId: string, body: Row) {
 const run = await row(env, 'SELECT * FROM runs WHERE id=? AND batch_id=?', runId, batchId);
 if (!run) throw new ApiError('任务不存在', 404);
 if (!['queued', 'running'].includes(run.status)) { await finalizeRunSets(env); return { ok: true, reused: true }; }
 const secret = await decrypt(run.key_cipher, env, 'run:' + run.id);
 const report = body.report ? safeReport(body.report, [secret]) : null;
 const status = ['completed', 'failed', 'timed_out'].includes(body.status) ? body.status : 'failed';
 const attempts = Number.isSafeInteger(body.attempts) && body.attempts >= 0 && body.attempts <= run.reserved_attempts ? body.attempts : run.reserved_attempts;
 const issue = reportIssues(report, status)[0];
 const error = status === 'timed_out' ? '检测超过 10 分钟，已保存有效样本。' : status === 'failed' ? issue?.summary || '检测未完成，请查看报告中的错误摘要。' : null;
 await env.DB.prepare("UPDATE runs SET status=?,ended_at=?,report=?,attempts=?,error=?,key_cipher='' WHERE id=? AND status IN ('queued','running')").bind(status, Date.now(), report ? JSON.stringify(report) : null, attempts, error, runId).run();
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
 const expired = await rows(env, "SELECT id,status,kind,mail_payload FROM batches WHERE (status='running' AND lease_until<?) OR (status IN ('queued','dispatched') AND created_at<?)", Date.now() - 120000, Date.now() - 30 * 60000);
 for (const batch of expired) {
  const running = batch.status === 'running';
  await env.DB.batch([
   env.DB.prepare("UPDATE runs SET status='failed',ended_at=?,attempts=CASE WHEN ? THEN reserved_attempts ELSE 0 END,error=?,key_cipher='' WHERE batch_id=? AND status IN ('queued','running')").bind(Date.now(), running ? 1 : 0, running ? '执行器中断，已保留此前回传的报告。' : '排队超过 30 分钟，请检查 GitHub 额度和执行器配置。', batch.id),
   env.DB.prepare("UPDATE batches SET status='failed',ended_at=?,error=? WHERE id=?").bind(Date.now(), '执行器未完成任务', batch.id),
   env.DB.prepare('UPDATE quota_reservations SET amount=? WHERE id=?').bind(running ? 15 : 0, batch.id + ':minutes'),
  ]);
  await reconcileRequests(env, batch.id);
  if (batch.kind === 'mail') for (const notice of JSON.parse(batch.mail_payload || '[]')) {
   await env.DB.prepare("UPDATE notices SET status='failed',error=? WHERE id=? AND status IN ('pending','processing')").bind(running ? '邮件执行器中断，发送结果未确认。请检查收件箱后再试。' : '邮件任务排队超时，请检查 GitHub 执行器和额度。', notice.id).run();
  }
 }
 await finalizeRunSets(env);
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
 const waiting = await rows(env, "SELECT * FROM run_sets WHERE ended_at IS NULL" + (setId ? ' AND id=?' : '') + ' ORDER BY created_at', ...(setId ? [setId] : []));
 if (!waiting.length) return;
 const mail = await setting<Row>(env, 'mail');
 for (const group of waiting) {
  const reports = await rows(env, 'SELECT r.* FROM runs r JOIN run_set_members m ON r.id=m.run_id WHERE m.set_id=?', group.id);
  if (!reports.length || reports.some(r => ['queued', 'running'].includes(r.status))) continue;
  const manual = group.source !== 'scheduled';
  let send = !group.superseded_by && mail.enabled && (manual ? manualMailEnabled(mail) : mail.mode !== 'daily');
  if (send && !manual && mail.mode === 'changes') {
   send = false;
   for (const run of reports) {
    const previous = await row(env, `SELECT r.report,r.status FROM runs r JOIN run_set_members m ON m.run_id=r.id JOIN run_sets s ON s.id=m.set_id
     WHERE r.target_id=? AND s.source='scheduled' AND s.id!=? AND s.created_at<=? AND s.ended_at IS NOT NULL
      AND s.superseded_by IS NULL AND r.status NOT IN ('queued','running') ORDER BY s.created_at DESC LIMIT 1`, run.target_id, group.id, group.created_at);
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
 const records = await rows(env, "SELECT * FROM notices WHERE status='pending' ORDER BY created_at LIMIT 30");
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
