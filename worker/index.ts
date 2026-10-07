import { ApiError, type Env, type Context } from './types.ts';
import { decrypt, encrypt, ensurePublicHostname, integerValue, localRequest, publicUrl, sameOrigin, session, sign, textValue, verifyOidc } from './security.ts';
import { deleteConfiguration } from './configuration-delete.ts';
import { cloneTargets } from './target-clone.ts';
import { clearLoginAttempts, loginCredentials, reserveLoginAttempt, verifyLoginProof } from './password.ts';
import { mailRecipients, manualMailEnabled, nextDue, protocolValue, safeReport, shanghaiDay, tierValue } from './domain.ts';
import { claim, createRuns, decodeRun, dispatch, dispatchQueued, executionReady, expireBatches, finishBatch, finishRun, finalizeRunSets, fullReportJson, id, noticeAllowed, noticeInBatch, panel, pendingNotices, requireLease, row, rows, saveSetting, setting, stopRuns, usage } from './data.ts';
import { BASELINES, baselineFor, defaultRequestModel, type Limits, type MailSettings, type Protocol } from '../src/shared.ts';
type Json = Record<string, any>;
function json(value: unknown, status = 200, headers: Record<string, string> = {}) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } }); }
async function body(request: Request, limit = 65536): Promise<Json> { const raw = await request.text(); if (raw.length > limit) throw new ApiError('提交内容过大', 413); try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw new ApiError('提交内容不是有效的 JSON'); } }
function selectedIds(value: unknown, label: string): string[] {
 if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string')) throw new ApiError(`请至少选择一个${label}`);
 return [...new Set(value.map(id => textValue(id, label + ' ID', 64)))];
}
export async function handleRequest(request: Request, env: Env, ctx: Context): Promise<Response> {
 const url = new URL(request.url); const path = url.pathname;
 try {
  if (path === '/api/session' && request.method === 'GET') { const who = await session(request, env); const credentials = loginCredentials(env); return json({ authenticated: !!who, login: who?.login || null, local: localRequest(request, env), configured: !!credentials, password_kdf: credentials ? { salt: credentials.salt, iterations: credentials.iterations } : null, execution_ready: executionReady(env) }); }
  if (path === '/api/auth/login') {
   if (request.method !== 'POST') throw new ApiError('请在面板登录页输入账号和密码', 405);
   sameOrigin(request, env);
   const credentials = loginCredentials(env); if (!credentials) throw new ApiError('账号密码登录尚未配置，请先完成部署设置。', 503);
   const b = await body(request, 2048); const bucket = await reserveLoginAttempt(request, env);
   if (!await verifyLoginProof(b.email, b.proof, credentials)) throw new ApiError('账号或密码不正确', 401);
   await clearLoginAttempts(bucket, env);
   const signed = await sign({ type: 'password', id: credentials.email, login: credentials.email, revision: credentials.revision, expires: Date.now() + 30 * 86400000 }, env);
   return json({ ok: true }, 200, { 'Set-Cookie': `__Host-relay_session=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
  }
  if (path === '/api/auth/callback') throw new ApiError('已改为账号密码登录，请返回面板登录页', 410);
  if (path.startsWith('/api/runner/')) return await runnerRoute(request, env, path, ctx);
  if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Relay Desk API', { status: 200 });
  if (!await session(request, env)) throw new ApiError('请先登录', 401);
  if (!['GET', 'HEAD'].includes(request.method)) sameOrigin(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': '__Host-relay_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  if (path === '/api/panel' && request.method === 'GET') return json(await panel(env));
  if (/^\/api\/reports\/[^/]+$/.test(path) && request.method === 'GET') {
   const report = await fullReportJson(env, path.split('/')[3]);
   if (report === null) throw new ApiError('报告不存在', 404);
   return new Response(`{"run":${report}}`, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (path === '/api/run-presets' && request.method === 'POST') {
   const b = await body(request, 1200000);
   if (Object.keys(b).some(field => !['id', 'name', 'targetIds'].includes(field))) throw new ApiError('常用组合包含不支持的设置');
   const presetId = b.id === undefined ? id() : textValue(b.id, '组合 ID', 64);
   const name = textValue(b.name, '组合名称', 64);
   if (b.id !== undefined && !await row(env, 'SELECT id FROM run_presets WHERE id=?', presetId)) throw new ApiError('常用组合不存在，请刷新后重试', 404);
   const targetIds = selectedIds(b.targetIds, '模型'); const selection = JSON.stringify(targetIds);
   const selected = await rows(env, 'SELECT DISTINCT e.id,e.key_cipher FROM targets t JOIN endpoints e ON e.id=t.endpoint_id WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))', selection);
   const existing = await rows(env, 'SELECT id FROM targets WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))', selection);
   if (existing.length !== targetIds.length) throw new ApiError('组合中的模型已不存在，请刷新后重新选择', 404);
   for (const endpoint of selected) if (name.includes(await decrypt(endpoint.key_cipher, env, 'endpoint:' + endpoint.id))) throw new ApiError('组合名称不能包含 API Key');
   if (b.id === undefined && (await row(env, 'SELECT COUNT(*) AS n FROM run_presets'))!.n >= 20) throw new ApiError('最多保存二十个常用组合，请编辑已有组合');
   const now = Date.now();
   await env.DB.batch([
    env.DB.prepare('INSERT INTO run_presets(id,name,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at').bind(presetId, name, now, now),
    env.DB.prepare('DELETE FROM run_preset_targets WHERE preset_id=?').bind(presetId),
    env.DB.prepare('INSERT INTO run_preset_targets(preset_id,target_id,position) SELECT ?,value,CAST(key AS INTEGER) FROM json_each(?)').bind(presetId, selection),
   ]);
   return json({ id: presetId });
  }
  if (/^\/api\/run-presets\/[^/]+$/.test(path) && request.method === 'DELETE') {
   const presetId = path.split('/')[3];
   if (!await row(env, 'SELECT id FROM run_presets WHERE id=?', presetId)) throw new ApiError('常用组合不存在', 404);
   await env.DB.prepare('DELETE FROM run_presets WHERE id=?').bind(presetId).run();
   return json({ ok: true });
  }
  if (path === '/api/groups' && request.method === 'POST') {
   const b = await body(request); const groupId = b.id === undefined ? id() : textValue(b.id, '分组 ID', 64); const name = textValue(b.name, '分组名称', 64);
   if (b.id !== undefined && !await row(env, 'SELECT id FROM groups WHERE id=?', groupId)) throw new ApiError('分组不存在', 404);
   await env.DB.prepare('INSERT INTO groups(id,name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').bind(groupId, name, Date.now()).run(); return json({ id: groupId });
  }
  if (/^\/api\/groups\/[^/]+$/.test(path) && request.method === 'DELETE') {
   const groupId = path.split('/')[3]; if (groupId === 'default') throw new ApiError('默认分组不能删除');
   if (!await row(env, 'SELECT id FROM groups WHERE id=?', groupId)) throw new ApiError('分组不存在', 404);
   await env.DB.batch([env.DB.prepare("UPDATE endpoints SET group_id='default' WHERE group_id=?").bind(groupId), env.DB.prepare('DELETE FROM groups WHERE id=?').bind(groupId)]); return json({ ok: true });
  }
  if (/^\/api\/(stations|endpoints|targets)\/[^/]+$/.test(path) && request.method === 'DELETE') {
   const resource = path.split('/')[2];
   return json(await deleteConfiguration(env, resource === 'stations' ? 'station' : resource === 'endpoints' ? 'key' : 'model', path.split('/')[3], await body(request, 1200000)));
  }
  if (path === '/api/endpoints' && request.method === 'POST') {
   const b = await body(request); const endpointId = b.id || id(); const existing = await row(env, 'SELECT * FROM endpoints WHERE id=?', endpointId);
   if (existing?.deleted_at !== null && existing?.deleted_at !== undefined) throw new ApiError('这条 Key 配置已删除，请刷新后重新添加', 404);
   const name = textValue(b.name, 'Key 配置名称'); const base = publicUrl(b.base_url); const groupId = textValue(b.group_id || 'default', '分组');
   if (!await row(env, 'SELECT id FROM groups WHERE id=?', groupId)) throw new ApiError('分组不存在');
   const key = typeof b.key === 'string' && b.key.trim() ? textValue(b.key, 'API Key', 4096) : '';
   if (!existing && !key) throw new ApiError('首次保存需要填写 API Key');
   if (existing && existing.base_url !== base && !key) throw new ApiError('修改 API 地址后，需要重新填写对应的 API Key');
   const secret = key || (existing ? await decrypt(existing.key_cipher, env, 'endpoint:' + endpointId) : '');
   const sameStation = await row(env, 'SELECT station_name FROM endpoints WHERE base_url=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1', base);
   const stationName = sameStation?.station_name || existing?.station_name || textValue(b.station_name ?? name, '中转站名称');
   if ([name, stationName, base, groupId].some(v => v.includes(secret))) throw new ApiError('名称或地址中不能包含 API Key');
   const cipher = key ? await encrypt(key, env, 'endpoint:' + endpointId) : existing!.key_cipher;
   await env.DB.prepare('INSERT INTO endpoints(id,group_id,name,station_name,base_url,key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,name=excluded.name,station_name=excluded.station_name,base_url=excluded.base_url,key_cipher=excluded.key_cipher,updated_at=excluded.updated_at').bind(endpointId, groupId, name, stationName, base, cipher, Date.now(), Date.now()).run(); return json({ id: endpointId, credential_saved: true });
  }
  if (/^\/api\/stations\/[^/]+$/.test(path) && request.method === 'PUT') {
   const anchor = await row(env, 'SELECT * FROM endpoints WHERE id=? AND deleted_at IS NULL', path.split('/')[3]);
   if (!anchor) throw new ApiError('中转站不存在', 404);
   const b = await body(request); const name = textValue(b.name, '中转站名称'); const base = publicUrl(b.base_url);
   if (b.previous_base_url !== anchor.base_url) throw new ApiError('中转站地址已被修改，请关闭后重新打开编辑。', 409);
   const changedUrl = base !== anchor.base_url;
   if (changedUrl && b.confirm_url_change !== true) throw new ApiError('请确认此中转站的所有 Key 配置都改用新地址');
   if (changedUrl && await row(env, 'SELECT id FROM endpoints WHERE base_url=? AND deleted_at IS NULL LIMIT 1', base)) throw new ApiError('新地址已属于另一家中转站，请编辑对应中转站，避免合并配置。', 409);
   const profiles = await rows(env, 'SELECT id,key_cipher FROM endpoints WHERE base_url=? AND deleted_at IS NULL', anchor.base_url);
   for (const profile of profiles) {
    const secret = await decrypt(profile.key_cipher, env, 'endpoint:' + profile.id);
    if ([name, base].some(value => value.includes(secret))) throw new ApiError('名称或地址中不能包含 API Key');
   }
   await env.DB.prepare('UPDATE endpoints SET station_name=?,base_url=?,updated_at=? WHERE base_url=? AND deleted_at IS NULL').bind(name, base, Date.now(), anchor.base_url).run();
   return json({ ok: true, profiles_updated: profiles.length, base_url: base });
  }
  if (path === '/api/targets/batch' && request.method === 'POST') {
   const b = await body(request, 1200000);
   if (Object.keys(b).some(field => !['targetIds', 'changes', 'sync_request_model'].includes(field))) throw new ApiError('批量编辑包含不支持的字段');
   const targetIds = selectedIds(b.targetIds, '检测目标');
   const changes = b.changes;
   if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(field => !['protocol', 'claimed_model', 'request_model', 'tier'].includes(field))) throw new ApiError('批量编辑的模型设置不正确');
   if (b.sync_request_model !== undefined && typeof b.sync_request_model !== 'boolean') throw new ApiError('同步请求模型开关不正确');
   const sync = b.sync_request_model === true;
   if (sync && Object.hasOwn(changes, 'request_model')) throw new ApiError('同步请求模型时不能同时填写统一请求模型名');
   if (!Object.keys(changes).length && !sync) throw new ApiError('请选择至少一个需要修改的设置');
   if (Object.hasOwn(changes, 'protocol') && (typeof changes.protocol !== 'string' || !Object.hasOwn(BASELINES, changes.protocol))) throw new ApiError('请选择受支持的请求协议');
   if (Object.hasOwn(changes, 'tier') && typeof changes.tier !== 'string') throw new ApiError('检测档位不正确');
   const protocolChange = Object.hasOwn(changes, 'protocol') ? protocolValue(changes.protocol) : undefined;
   const tierChange = Object.hasOwn(changes, 'tier') ? tierValue(changes.tier) : undefined;
   const claimedChange = Object.hasOwn(changes, 'claimed_model') ? textValue(changes.claimed_model, '申报模型') : undefined;
   const requestChange = Object.hasOwn(changes, 'request_model') ? textValue(changes.request_model, '实际请求模型') : undefined;
   const updates = []; const secrets = new Map<string, string>();
   const targets = await rows(env, 'SELECT t.*,e.base_url,e.key_cipher FROM targets t JOIN endpoints e ON e.id=t.endpoint_id WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))', JSON.stringify(targetIds));
   if (targets.length !== targetIds.length) throw new ApiError('所选检测目标或对应站点不存在，请刷新后重新选择', 404);
   for (const target of targets) {
    if (!protocolChange && (typeof target.protocol !== 'string' || !Object.hasOwn(BASELINES, target.protocol))) throw new ApiError('所选目标的请求协议不正确，请选择新的协议');
    const protocol = protocolChange ?? protocolValue(target.protocol);
    const claimed = claimedChange ?? textValue(target.claimed_model, '申报模型');
    const model = textValue(sync ? defaultRequestModel(protocol, claimed, target.base_url) : requestChange ?? target.request_model, '实际请求模型');
    const tier = tierChange ?? tierValue(target.tier);
    const name = textValue(target.name, '目标名称');
    if (!secrets.has(target.endpoint_id)) secrets.set(target.endpoint_id, await decrypt(target.key_cipher, env, 'endpoint:' + target.endpoint_id));
    const secret = secrets.get(target.endpoint_id)!;
    if ([name, model, claimed].some(value => value.includes(secret))) throw new ApiError('模型配置中不能包含 API Key');
    if (protocol !== target.protocol || claimed !== target.claimed_model || model !== target.request_model || tier !== target.tier) updates.push({ id: target.id, protocol, request_model: model, claimed_model: claimed, tier });
   }
   if (!updates.length) throw new ApiError('所选目标已经使用这些设置，无需更新');
   await env.DB.prepare(`WITH changes AS (SELECT value FROM json_each(?)) UPDATE targets SET
    protocol=(SELECT json_extract(value,'$.protocol') FROM changes WHERE json_extract(value,'$.id')=targets.id),
    request_model=(SELECT json_extract(value,'$.request_model') FROM changes WHERE json_extract(value,'$.id')=targets.id),
    claimed_model=(SELECT json_extract(value,'$.claimed_model') FROM changes WHERE json_extract(value,'$.id')=targets.id),
    tier=(SELECT json_extract(value,'$.tier') FROM changes WHERE json_extract(value,'$.id')=targets.id)
    WHERE id IN (SELECT json_extract(value,'$.id') FROM changes)`).bind(JSON.stringify(updates)).run();
   return json({ ok: true, updated: updates.length });
  }
  if (path === '/api/targets/clone' && request.method === 'POST') return json(await cloneTargets(env, await body(request, 1200000)));
  if (path === '/api/targets' && request.method === 'POST') {
   const b = await body(request); const targetId = b.id || id();
   if (await row(env, 'SELECT id FROM targets WHERE id=? AND deleted_at IS NOT NULL', targetId)) throw new ApiError('这个模型已删除，请刷新后重新添加', 404);
   const endpoint = await row(env, 'SELECT * FROM endpoints WHERE id=? AND deleted_at IS NULL', b.endpoint_id); if (!endpoint) throw new ApiError('请先保存站点');
   const protocol = protocolValue(b.protocol); const name = textValue(b.name, '目标名称'); const model = textValue(b.request_model, '实际请求模型'); const claimed = textValue(b.claimed_model, '申报模型'); const tier = tierValue(b.tier || 'medium');
   const secret = await decrypt(endpoint.key_cipher, env, 'endpoint:' + endpoint.id);
   if ([name, model, claimed].some(v => v.includes(secret))) throw new ApiError('模型配置中不能包含 API Key');
   const groupId = b.group_id === undefined ? endpoint.group_id : textValue(b.group_id, '分组');
   if (!await row(env, 'SELECT id FROM groups WHERE id=?', groupId)) throw new ApiError('分组不存在');
   await env.DB.batch([
    env.DB.prepare('INSERT INTO targets(id,endpoint_id,name,protocol,request_model,claimed_model,tier,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint_id=excluded.endpoint_id,name=excluded.name,protocol=excluded.protocol,request_model=excluded.request_model,claimed_model=excluded.claimed_model,tier=excluded.tier').bind(targetId, endpoint.id, name, protocol, model, claimed, tier, Date.now()),
    env.DB.prepare('INSERT OR IGNORE INTO schedules(target_id,updated_at) VALUES (?,?)').bind(targetId, Date.now()),
    env.DB.prepare('UPDATE endpoints SET group_id=?,updated_at=? WHERE id=? AND group_id!=?').bind(groupId, Date.now(), endpoint.id, groupId),
   ]); return json({ id: targetId });
  }
  if (path === '/api/models' && request.method === 'POST') {
   const b = await body(request); const endpoint = await row(env, 'SELECT * FROM endpoints WHERE id=? AND deleted_at IS NULL', b.endpoint_id); if (!endpoint) throw new ApiError('站点不存在', 404);
   const key = await decrypt(endpoint.key_cipher, env, 'endpoint:' + endpoint.id); const base = publicUrl(endpoint.base_url); await ensurePublicHostname(base);
   const response = await fetch(base.replace(/\/(responses|messages|chat\/completions)$/, '') + '/models', { headers: { Authorization: 'Bearer ' + key, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
   if (!response.ok) throw new ApiError(`获取模型失败（HTTP ${response.status}），可以手动填写模型名。`, 502);
   const raw = await response.text(); if (raw.length > 1000000) throw new ApiError('模型列表过大，请手动填写');
   let result: Json; try { result = JSON.parse(raw); } catch { throw new ApiError('上游没有返回有效模型列表，可以手动填写'); }
   const models = (Array.isArray(result.data) ? result.data : []).map((v: Json) => v.id).filter((v: unknown): v is string => typeof v === 'string' && v.length <= 256 && !v.includes(key)); return json({ models });
  }
  if (path === '/api/runs' && request.method === 'POST') {
   const b = await body(request, 1200000); const targetIds = selectedIds(b.targetIds, '检测目标');
   const result = await createRuns(env, targetIds, b.tier ? tierValue(b.tier) : undefined); ctx.waitUntil(dispatchQueued(env)); return json(result, 202);
  }
  if (path === '/api/runs/stop' && request.method === 'POST') {
   const b = await body(request, 1200000);
   if (Object.keys(b).some(field => field !== 'runIds')) throw new ApiError('停止请求包含不支持的设置');
   const runIds = selectedIds(b.runIds, '正在进行的检测');
   const result = await stopRuns(env, runIds); ctx.waitUntil(dispatchQueued(env)); return json(result, result.stopping ? 202 : 200);
  }
  if (/^\/api\/runs\/[^/]+$/.test(path) && request.method === 'GET') {
   const runId = path.split('/')[3]; const single = await row(env, 'SELECT * FROM runs WHERE id=?', runId); const batch = await row(env, 'SELECT id,kind,status,created_at,started_at,ended_at,error,last_dispatch_error FROM batches WHERE id=?', single?.batch_id || runId);
   if (!batch) throw new ApiError('报告不存在', 404);
   return json({ batch, runs: (await rows(env, 'SELECT * FROM runs WHERE batch_id=? ORDER BY created_at', batch.id)).map(decodeRun) });
  }
  if (/^\/api\/schedules\/[^/]+$/.test(path) && request.method === 'PUT') {
   const targetId = path.split('/')[3]; if (!await row(env, 'SELECT id FROM targets WHERE id=? AND deleted_at IS NULL', targetId)) throw new ApiError('目标不存在', 404);
   const b = await body(request); if (typeof b.enabled !== 'boolean') throw new ApiError('监测开关不正确');
   const kind = b.kind === 'daily' ? 'daily' : 'interval'; const interval = integerValue(b.interval_minutes ?? 360, '监测间隔（分钟）', 5, 43200); const tier = tierValue(b.tier || 'low'); const time = b.daily_time || '09:00';
   if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ApiError('每日检测时间不正确');
   const due = b.enabled ? nextDue({ kind, interval_minutes: interval, daily_time: time }) : null;
   await env.DB.prepare('INSERT INTO schedules(target_id,enabled,kind,interval_minutes,daily_time,tier,next_due,last_error,updated_at) VALUES (?,?,?,?,?,?,?,NULL,?) ON CONFLICT(target_id) DO UPDATE SET enabled=excluded.enabled,kind=excluded.kind,interval_minutes=excluded.interval_minutes,daily_time=excluded.daily_time,tier=excluded.tier,next_due=excluded.next_due,last_error=NULL,updated_at=excluded.updated_at').bind(targetId, b.enabled ? 1 : 0, kind, interval, time, tier, due, Date.now()).run(); return json({ ok: true, next_due: due });
  }
  if (path === '/api/settings/limits' && request.method === 'PUT') {
   const b = await body(request); const limits: Limits = { daily_requests: integerValue(b.daily_requests, '每日请求上限', 1, 1000000), monthly_minutes: integerValue(b.monthly_minutes, '每月执行分钟上限', 15, 100000) }; await saveSetting(env, 'limits', limits); return json({ ok: true });
  }
  if (path === '/api/settings/mail' && request.method === 'PUT') {
   const b = await body(request); const old = await setting<Json>(env, 'mail');
   if (typeof b.enabled !== 'boolean' || !['changes', 'daily', 'all'].includes(b.mode) || (b.notify_manual !== undefined && typeof b.notify_manual !== 'boolean')) throw new ApiError('邮件设置不正确');
   const values = { enabled: b.enabled, notify_manual: b.notify_manual ?? manualMailEnabled(old), mode: b.mode, host: b.host || '', port: integerValue(b.port || 465, 'SMTP 端口', 1, 65535), username: b.username || '', from: b.from || '', to: mailRecipients(b.to || '') };
   for (const [field, value] of Object.entries(values)) if (typeof value === 'string' && ((field !== 'to' && value.length > 256) || /[\r\n\u0000]/.test(value))) throw new ApiError(`邮件 ${field} 格式不正确`);
   if (values.host && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(values.host)) throw new ApiError('SMTP 需要使用公网域名');
   const password = typeof b.password === 'string' && b.password ? textValue(b.password, 'SMTP 授权码', 4096) : '';
   if (!password && old.password_cipher && ['host', 'username', 'port'].some(k => values[k as keyof typeof values] !== old[k])) throw new ApiError('修改邮件服务器或账户后，请重新填写 SMTP 授权码');
   const cipher = password ? await encrypt(password, env, 'smtp') : old.password_cipher;
   if (b.enabled && (!cipher || !values.host || !values.username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.from) || !values.to)) throw new ApiError('开启邮件前，请填写完整的 SMTP 和收发邮箱');
   if (password && [values.host, values.username, values.from, values.to].some(v => v.includes(password))) throw new ApiError('邮件配置字段中不能包含授权码');
   await saveSetting(env, 'mail', { ...values, password_cipher: cipher });
   if (!values.enabled) await env.DB.prepare("UPDATE notices SET status='cancelled' WHERE status='pending'").run();
   else {
    if (values.mode !== old.mode) await env.DB.prepare("UPDATE notices SET status='cancelled' WHERE status='pending' AND (kind='daily' OR (kind='run' AND reference IN (SELECT id FROM runs WHERE source='scheduled')) OR (kind='batch' AND reference IN (SELECT 'set:'||id FROM run_sets WHERE source='scheduled')))").run();
    if (!values.notify_manual) await env.DB.prepare("UPDATE notices SET status='cancelled' WHERE status='pending' AND ((kind='run' AND reference IN (SELECT id FROM runs WHERE source!='scheduled')) OR (kind='batch' AND reference IN (SELECT 'set:'||id FROM run_sets WHERE source!='scheduled')))").run();
   }
   return json({ ok: true });
  }
  if (path === '/api/settings/mail/test' && request.method === 'POST') {
   const mail = await setting<Json>(env, 'mail');
   if (!mail.enabled || !mail.password_cipher) throw new ApiError('请先保存 SMTP 授权码并开启邮件通知');
   if (!executionReady(env)) throw new ApiError('邮件执行器尚未连接', 503);
   const pending = await row(env, "SELECT id,status FROM notices WHERE kind='test' AND status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1");
   if (pending) return json({ ...pending, reused: true }, 202);
   const limits = await setting<Limits>(env, 'limits'); const counts = await usage(env);
   if (counts.monthly_minutes + 15 > limits.monthly_minutes) throw new ApiError('本月执行预算不足，无法发送测试邮件。', 429);
   const now = Date.now(); const reference = 'smtp-test:' + Math.floor(now / 60000);
   await env.DB.prepare("INSERT OR IGNORE INTO notices(id,kind,reference,created_at) VALUES (?,'test',?,?)").bind(id(), reference, now).run();
   const notice = await row(env, 'SELECT id,status FROM notices WHERE reference=?', reference);
   ctx.waitUntil(tick(env)); return json(notice, 202);
  }
  throw new ApiError('接口不存在', 404);
 } catch (error) {
  if (!(error instanceof ApiError) && /configuration_(deleted|changed|in_use)/.test(String(error))) return json({ error: '配置或检测状态已变化，请刷新后重试；未完成部分删除。' }, 409);
  return json({ error: error instanceof ApiError ? error.message : '操作暂时失败，请稍后重试。' }, error instanceof ApiError ? error.status : 500);
 }
}
async function runnerRoute(request: Request, env: Env, path: string, ctx: Context) {
 if (path === '/api/runner/queue' && request.method === 'GET') { if (!localRequest(request, env)) throw new ApiError('接口不存在', 404); await verifyOidc(request, env); return json({ batches: await rows(env, "SELECT id FROM batches WHERE status='queued' ORDER BY created_at LIMIT 1") }); }
 const match = path.match(/^\/api\/runner\/batches\/([^/]+)\/(claim|heartbeat|progress|complete|notices|notice-begin|notice-result|results\/[^/]+)$/);
 if (!match || request.method !== 'POST') throw new ApiError('执行器接口不存在', 404);
 const [, batchId, action] = match;
 if (action === 'claim') return json(await claim(request, env, batchId));
 await requireLease(request, env, batchId);
 const b = await body(request, action.startsWith('results/') || action === 'progress' ? 1200000 : 65536);
 if (action === 'heartbeat') {
  await env.DB.prepare("UPDATE batches SET heartbeat_at=? WHERE id=? AND status='running'").bind(Date.now(), batchId).run();
  const stopped = await rows(env, "SELECT id FROM runs WHERE batch_id=? AND status='running' AND stop_requested_at IS NOT NULL", batchId);
  return json({ ok: true, stop_run_ids: stopped.map(run => run.id) });
 }
 if (action === 'progress') {
  const run = await row(env, "SELECT * FROM runs WHERE id=? AND batch_id=? AND status='running'", b.run_id, batchId); if (!run) return json({ ok: true });
  const key = await decrypt(run.key_cipher, env, 'run:' + run.id); const report = b.report ? safeReport(b.report, [key]) : null;
  const progress = report?.progress || {};
  await env.DB.prepare("UPDATE runs SET progress=?,report=COALESCE(?,report) WHERE id=? AND status='running'").bind(JSON.stringify(progress), report ? JSON.stringify(report) : null, run.id).run();
  const control = await row(env, 'SELECT stop_requested_at FROM runs WHERE id=?', run.id);
  return json({ ok: true, stop_requested: control?.stop_requested_at != null });
 }
 if (action.startsWith('results/')) return json(await finishRun(env, batchId, action.split('/')[1], b));
 if (action === 'complete') { const minutes = integerValue(b.minutes, '执行分钟', 1, 15); const result = await finishBatch(env, batchId, minutes); ctx.waitUntil(dispatchQueued(env)); return json(result); }
 if (action === 'notices') {
  const mail = await setting<Json>(env, 'mail'); if (!mail.enabled) return json({ mail: null, notices: [] });
  await finalizeRunSets(env);
  const notices = [];
  for (const notice of await pendingNotices(env)) if (await noticeInBatch(env, notice, batchId) && await noticeAllowed(env, notice, mail)) notices.push(notice);
  const { password_cipher, ...safe } = mail; return json({ mail: { ...safe, password: await decrypt(password_cipher, env, 'smtp') }, notices });
 }
 if (action === 'notice-result' || action === 'notice-begin') {
  const notice = await row(env, 'SELECT * FROM notices WHERE id=?', b.notice_id); if (!notice) throw new ApiError('邮件任务不存在', 404);
  if (!await noticeInBatch(env, notice, batchId)) throw new ApiError('邮件任务不属于此执行器', 403);
  if (action === 'notice-begin') {
   const mail = await setting<Json>(env, 'mail');
   if (!await noticeAllowed(env, notice, mail)) return json({ send: false });
   // SMTP 无法保证收到回执；发送前先原子领取，回执丢失也不自动重复投递。
   const reserved = await env.DB.prepare("UPDATE notices SET status='processing' WHERE id=? AND status='pending'").bind(notice.id).run();
   return json({ send: !!reserved.meta.changes });
  }
  if (notice.status === 'sent') return json({ ok: true, reused: true });
  const mailErrors: Record<string, string> = { smtp_auth: '邮箱认证失败。请确认 SMTP 服务已开启，并重新填写邮箱授权码。', smtp_recipient: '部分或全部收件邮箱被拒绝。请检查地址及邮箱限制；部分邮箱可能已经收到。', smtp_sender: '发件邮箱被拒绝。请确认发件地址与 SMTP 登录账号一致。', smtp_busy: '邮箱服务器暂时繁忙或限流，请稍后再试。', smtp_connect: '无法连接邮件服务器，请检查 SMTP 地址和端口。', smtp_tls: '邮件服务器的加密连接失败，请检查 SMTP 端口及 TLS 支持。', smtp_rejected: '邮箱服务器拒绝了邮件。请检查收发地址及邮箱发送限制。', smtp_protocol: '邮件服务器返回了异常响应，或不支持所需的 SMTP 登录和加密方式。请检查服务设置。' };
  const phaseErrors: Record<string, string> = { greeting: '邮件服务器已连接，但在 SMTP 握手时断开。请检查邮箱服务和连接限制。', authentication: '邮件服务器在登录认证时断开连接，尚未确认授权码有效。请检查 SMTP 服务、授权码及邮箱登录限制。', delivery: '邮件服务器在发送过程中断开连接，未确认投递结果。请检查收件箱和邮箱限制后再试。' };
  const error = b.ok === true ? null : b.error_code === 'smtp_connect' && phaseErrors[b.phase] || mailErrors[b.error_code] || '邮件发送失败。请检查 SMTP 设置，检测报告已保存。';
  await env.DB.prepare("UPDATE notices SET status=?,sent_at=?,error=?,attempts=attempts+1 WHERE id=? AND status='processing'").bind(b.ok === true ? 'sent' : 'failed', b.ok === true ? Date.now() : null, error, notice.id).run(); return json({ ok: true });
 }
 throw new ApiError('接口不存在', 404);
}
export async function tick(env: Env) {
 await expireBatches(env);
 if (!executionReady(env)) return;
 const now = Date.now(); const due = await rows(env, 'SELECT s.*,t.protocol,t.claimed_model,t.name AS target_name FROM schedules s JOIN targets t ON t.id=s.target_id WHERE t.deleted_at IS NULL AND s.enabled=1 AND s.next_due<=? ORDER BY s.next_due', now);
 const supported = []; const advances: { target_id: string; next_due: number; last_error: string | null }[] = [];
 const advance = (s: Json, last_error: string | null) => ({ target_id: s.target_id as string, next_due: nextDue({ kind: s.kind, interval_minutes: s.interval_minutes, daily_time: s.daily_time }, now), last_error });
 for (const s of due) {
  if (baselineFor(s.protocol as Protocol, s.claimed_model)?.models.includes(s.claimed_model)) supported.push(s);
  else advances.push(advance(s, `${s.target_name} 暂无对应基准，暂不支持自动检测。`));
 }
 // A scheduler round shares one summary across bounded, queued runner batches.
 if (supported.length) {
  try { await createRuns(env, supported.map(s => s.target_id), undefined, 'scheduled', Object.fromEntries(supported.map(s => [s.target_id, tierValue(s.tier)])));
   advances.push(...supported.map(s => advance(s, null)));
  } catch (error) {
   advances.push(...supported.map(s => advance(s, error instanceof ApiError ? error.message : '监测执行失败，下一周期重试。')));
  }
 }
 if (advances.length) await env.DB.prepare(`WITH advances AS (SELECT value FROM json_each(?)) UPDATE schedules SET
  next_due=(SELECT json_extract(value,'$.next_due') FROM advances WHERE json_extract(value,'$.target_id')=schedules.target_id),
  last_error=(SELECT json_extract(value,'$.last_error') FROM advances WHERE json_extract(value,'$.target_id')=schedules.target_id)
  WHERE enabled=1 AND target_id IN (SELECT json_extract(value,'$.target_id') FROM advances)`).bind(JSON.stringify(advances)).run();
 await dispatchQueued(env);
 const mail = await setting<Json>(env, 'mail'); if (!mail.enabled) return;
 if (mail.mode === 'daily') {
  const anchor = Date.parse(shanghaiDay(now) + 'T09:00:00+08:00');
  if (now >= anchor && await row(env, "SELECT id FROM run_sets WHERE source='scheduled' AND superseded_by IS NULL AND ((ended_at>=? AND ended_at<=?) OR (created_at>=? AND created_at<=?)) LIMIT 1", anchor - 86400000, anchor, anchor - 86400000, anchor)) await env.DB.prepare('INSERT OR IGNORE INTO notices(id,kind,reference,created_at) VALUES (?,?,?,?)').bind(id(), 'daily', 'daily:' + shanghaiDay(now), anchor).run();
 }
 // 运行中的检测批次负责自身邮件；后台独立任务处理未被该批次发送的通知和日报。
 if (await row(env, "SELECT id FROM batches WHERE status IN ('queued','dispatched','running') LIMIT 1")) return;
 const notices = [];
 for (const notice of await pendingNotices(env)) if (await noticeAllowed(env, notice, mail)) notices.push(notice);
 if (!notices.length) return;
 const batchId = id(); const limits = await setting<Limits>(env, 'limits');
 await env.DB.batch([
  env.DB.prepare("INSERT INTO quota_reservations SELECT ?,'minutes',?,15 WHERE (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind='minutes' AND period=?)+15<=? AND NOT EXISTS(SELECT 1 FROM batches WHERE status IN ('queued','dispatched','running'))").bind(batchId + ':minutes', shanghaiDay(now).slice(0, 7), shanghaiDay(now).slice(0, 7), limits.monthly_minutes),
  env.DB.prepare("INSERT INTO batches(id,kind,created_at,mail_payload) SELECT ?,'mail',?,? WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE id=?)").bind(batchId, now, JSON.stringify(notices), batchId + ':minutes'),
 ]);
 if (await row(env, 'SELECT id FROM batches WHERE id=?', batchId)) await dispatch(env, batchId);
}
export default {
 fetch: handleRequest,
 scheduled: (_event: unknown, env: Env, ctx: Context) => ctx.waitUntil(tick(env)),
};
