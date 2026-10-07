import { cloneConfiguration, clonePreviews, monitorSettings, type CloneInput, type CloneResult, type CloneSource } from '../src/target-cloning.ts';
import type { Endpoint, Schedule, Target } from '../src/shared.ts';
import { ApiError, type Env } from './types.ts';
import { row, rows } from './data.ts';
import { decrypt, digest, textValue } from './security.ts';
import { nextDue } from './domain.ts';

const sourceConfiguration = `json_array(t.endpoint_id,t.name,t.protocol,t.request_model,t.claimed_model,t.tier,e.base_url,e.group_id,e.station_name,e.name,e.updated_at,COALESCE(s.enabled,0),COALESCE(s.kind,'interval'),COALESCE(s.interval_minutes,360),COALESCE(s.daily_time,'09:00'),COALESCE(s.tier,'low'))`;
const destinationMatches = `t.endpoint_id=json_extract(j.value,'$.endpoint_id') AND t.name=json_extract(j.value,'$.name')
 AND t.protocol=json_extract(j.value,'$.protocol') AND t.request_model=json_extract(j.value,'$.request_model') AND t.claimed_model=? AND t.tier=json_extract(j.value,'$.tier')
 AND COALESCE(s.enabled,0)=json_extract(j.value,'$.monitor.enabled') AND COALESCE(s.kind,'interval')=json_extract(j.value,'$.monitor.kind')
 AND COALESCE(s.interval_minutes,360)=json_extract(j.value,'$.monitor.interval_minutes') AND COALESCE(s.daily_time,'09:00')=json_extract(j.value,'$.monitor.daily_time') AND COALESCE(s.tier,'low')=json_extract(j.value,'$.monitor.tier')`;

function cloneResult(receipt: Record<string, any>, hash: string): CloneResult {
 if (receipt.request_hash !== hash) throw new ApiError('这次添加已使用其他设置，请关闭窗口后重新添加', 409);
 if (receipt.result === 'pending') throw new ApiError('配置正在保存，请稍后重试', 409);
 const result = JSON.parse(receipt.result);
 if (result.entries.some((item: any) => !item.target_id)) throw new ApiError('复制结果暂时无法读取，请稍后重试', 503);
 const targetIds = [...new Set<string>(result.entries.map((item: any) => item.target_id))];
 const created = new Set(result.entries.filter((item: any) => item.created).map((item: any) => item.target_id)).size;
 return { claimed_model: result.claimed_model, created, reused: targetIds.length - created, target_ids: targetIds };
}
export async function cloneTargets(env: Env, input: Record<string, unknown>): Promise<CloneResult> {
 if (Object.keys(input).some(key => !['operation_id', 'claimed_model', 'sources'].includes(key))) throw new ApiError('复制请求包含不支持的设置');
 const operationId = textValue(input.operation_id, '添加操作 ID', 64); const claimed = textValue(input.claimed_model, '希望验证的模型');
 if (!Array.isArray(input.sources) || !input.sources.length) throw new ApiError('请至少选择一个来源配置');
 const sources: CloneSource[] = input.sources.map(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['source_id', 'request_model', 'configuration'].includes(key))) throw new ApiError('来源配置格式不正确');
  return { source_id: textValue(value.source_id, '来源模型 ID', 64), ...(value.request_model === undefined ? {} : { request_model: textValue(value.request_model, '实际请求模型') }), configuration: textValue(value.configuration, '来源配置预览', 4096) };
 });
 if (new Set(sources.map(source => source.source_id)).size !== sources.length) throw new ApiError('来源配置不能重复选择');
 const normalized: CloneInput = { operation_id: operationId, claimed_model: claimed, sources };
 const hash = await digest(JSON.stringify(normalized));
 const receipt = await row(env, 'SELECT * FROM target_clone_requests WHERE id=?', operationId);
 if (receipt) return cloneResult(receipt, hash);
 const sourceSelection = JSON.stringify(sources.map(source => source.source_id));
 const endpointRows = await rows(env, 'SELECT DISTINCT e.* FROM endpoints e JOIN targets t ON t.endpoint_id=e.id WHERE e.deleted_at IS NULL AND t.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))', sourceSelection);
 const endpointIds = JSON.stringify(endpointRows.map(endpoint => endpoint.id));
 const targetRows = await rows(env, 'SELECT id,endpoint_id,name,protocol,request_model,claimed_model,tier,created_at FROM targets WHERE deleted_at IS NULL AND endpoint_id IN (SELECT value FROM json_each(?))', endpointIds);
 const scheduleRows = await rows(env, 'SELECT s.* FROM schedules s JOIN targets t ON t.id=s.target_id WHERE t.deleted_at IS NULL AND t.endpoint_id IN (SELECT value FROM json_each(?))', endpointIds);
 const endpoints = endpointRows as unknown as Endpoint[]; const targets = targetRows as unknown as Target[]; const schedules = scheduleRows as unknown as Schedule[];
 const previews = clonePreviews({ endpoints, targets, schedules }, sources, claimed);
 const credentials = new Map<string, string>();
 for (const preview of previews) {
  if (!preview.source || !preview.endpoint || preview.status === 'missing') throw new ApiError('来源模型或 Key 已删除，请重新选择', 404);
  if (preview.status === 'incompatible') throw new ApiError('要保持原请求协议，请使用相同模型系列的来源配置；GPT 和 Claude 分别选择', 400);
  const source = sources.find(source => source.source_id === preview.sourceId)!;
  if (source.configuration !== cloneConfiguration(preview.source, preview.endpoint, preview.schedule)) throw new ApiError('来源配置已变化，请关闭窗口后重新核对', 409);
  if (!credentials.has(preview.endpoint.id)) {
   const endpoint = endpointRows.find(endpoint => endpoint.id === preview.endpoint!.id)!;
   credentials.set(preview.endpoint.id, await decrypt(endpoint.key_cipher as string, env, 'endpoint:' + endpoint.id));
  }
  const secret = credentials.get(preview.endpoint.id)!;
  if ([preview.source.name, preview.requestModel, claimed].some(value => value.includes(secret))) throw new ApiError('模型配置中不能包含 API Key');
 }
 const now = Date.now();
 const items = await Promise.all(previews.map(async preview => ({
  id: 'clone-' + (await digest(operationId + ':' + preview.sourceId)).slice(0, 48), source_id: preview.sourceId,
  configuration: sources.find(source => source.source_id === preview.sourceId)!.configuration,
  endpoint_id: preview.source!.endpoint_id, name: preview.source!.name, protocol: preview.source!.protocol,
  request_model: preview.requestModel, tier: preview.source!.tier, monitor: monitorSettings(preview.schedule),
  next_due: preview.schedule?.enabled ? nextDue(monitorSettings(preview.schedule), now) : null,
 })));
 const selection = JSON.stringify(items);
 const pending = "EXISTS(SELECT 1 FROM target_clone_requests WHERE id=? AND request_hash=? AND result='pending')";
 try {
  await env.DB.batch([
   // The NOT NULL receipt is also the transactional gate: one stale or deleted
   // source rolls back every copy, including sources in other relay groups.
   env.DB.prepare(`INSERT INTO target_clone_requests(id,request_hash,result,created_at)
    SELECT ?,?,CASE WHEN (SELECT COUNT(*) FROM json_each(?))=(SELECT COUNT(*) FROM json_each(?) j JOIN targets t ON t.id=json_extract(j.value,'$.source_id') JOIN endpoints e ON e.id=t.endpoint_id LEFT JOIN schedules s ON s.target_id=t.id WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND ${sourceConfiguration}=json_extract(j.value,'$.configuration')) THEN 'pending' ELSE NULL END,?
    WHERE NOT EXISTS(SELECT 1 FROM target_clone_requests WHERE id=?)`).bind(operationId, hash, selection, selection, now, operationId),
   env.DB.prepare(`INSERT INTO targets(id,endpoint_id,name,protocol,request_model,claimed_model,tier,created_at)
    SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.endpoint_id'),json_extract(j.value,'$.name'),json_extract(j.value,'$.protocol'),json_extract(j.value,'$.request_model'),?,json_extract(j.value,'$.tier'),?
    FROM json_each(?) j WHERE ${pending} AND NOT EXISTS(SELECT 1 FROM targets WHERE id=json_extract(j.value,'$.id'))
    AND NOT EXISTS(SELECT 1 FROM targets t LEFT JOIN schedules s ON s.target_id=t.id WHERE t.deleted_at IS NULL AND ${destinationMatches})
    AND CAST(j.key AS INTEGER)=(SELECT MIN(CAST(previous.key AS INTEGER)) FROM json_each(?) previous WHERE json_extract(previous.value,'$.endpoint_id')=json_extract(j.value,'$.endpoint_id') AND json_extract(previous.value,'$.name')=json_extract(j.value,'$.name') AND json_extract(previous.value,'$.protocol')=json_extract(j.value,'$.protocol') AND json_extract(previous.value,'$.request_model')=json_extract(j.value,'$.request_model') AND json_extract(previous.value,'$.tier')=json_extract(j.value,'$.tier') AND json_extract(previous.value,'$.monitor')=json_extract(j.value,'$.monitor'))`).bind(claimed, now, selection, operationId, hash, claimed, selection),
   env.DB.prepare(`INSERT INTO schedules(target_id,enabled,kind,interval_minutes,daily_time,tier,next_due,last_error,updated_at)
    SELECT t.id,json_extract(j.value,'$.monitor.enabled'),json_extract(j.value,'$.monitor.kind'),json_extract(j.value,'$.monitor.interval_minutes'),json_extract(j.value,'$.monitor.daily_time'),json_extract(j.value,'$.monitor.tier'),json_extract(j.value,'$.next_due'),NULL,?
    FROM json_each(?) j JOIN targets t ON t.id=json_extract(j.value,'$.id') WHERE ${pending} AND NOT EXISTS(SELECT 1 FROM schedules WHERE target_id=t.id)`).bind(now, selection, operationId, hash),
   env.DB.prepare(`UPDATE target_clone_requests SET result=json_object('claimed_model',?,'entries',json((SELECT json_group_array(json_object('source_id',json_extract(j.value,'$.source_id'),'created',EXISTS(SELECT 1 FROM targets WHERE id=json_extract(j.value,'$.id')),'target_id',(SELECT t.id FROM targets t LEFT JOIN schedules s ON s.target_id=t.id WHERE t.deleted_at IS NULL AND ${destinationMatches} ORDER BY t.created_at,t.id LIMIT 1))) FROM json_each(?) j)))
    WHERE id=? AND request_hash=? AND result='pending'`).bind(claimed, claimed, selection, operationId, hash),
  ]);
 } catch (error) {
  if (String(error).includes('target_clone_requests.result') || String(error).includes('configuration_deleted')) throw new ApiError('来源配置已变化，未添加任何模型；请关闭窗口后重新核对', 409);
  throw error;
 }
 return cloneResult((await row(env, 'SELECT * FROM target_clone_requests WHERE id=?', operationId))!, hash);
}
