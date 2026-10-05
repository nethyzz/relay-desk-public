import { ApiError, type Env } from './types.ts';
import { row, rows } from './data.ts';

export type ConfigurationKind = 'station' | 'key' | 'model';
function sameIds(input: unknown, expected: string[]) {
 const ids = new Set(expected);
 return Array.isArray(input) && input.length === ids.size && new Set(input).size === input.length && input.every(value => typeof value === 'string' && ids.has(value));
}

export async function deleteConfiguration(env: Env, kind: ConfigurationKind, itemId: string, input: Record<string, unknown>) {
 if (input.confirm !== true) throw new ApiError('请先确认要删除的配置和关联模型');
 const anchor = await row(env, kind === 'model' ? 'SELECT * FROM targets WHERE id=?' : 'SELECT * FROM endpoints WHERE id=?', itemId);
 if (!anchor) throw new ApiError('要删除的配置不存在', 404);
 if (anchor.deleted_at !== null) return { ok: true, already_deleted: true, models_deleted: 0, keys_deleted: 0 };
 const profiles = kind === 'model' ? [] : kind === 'station'
  ? await rows(env, 'SELECT id FROM endpoints WHERE base_url=? AND deleted_at IS NULL', anchor.base_url)
  : [{ id: itemId }];
 const endpointIds = profiles.map(profile => profile.id as string);
 const endpointSelection = JSON.stringify(endpointIds);
 const targets = kind === 'model' ? [anchor] : await rows(env, 'SELECT id FROM targets WHERE endpoint_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL', endpointSelection);
 const targetIds = targets.map(target => target.id as string);
 if (!sameIds(input.targetIds, targetIds) || !sameIds(input.endpointIds, endpointIds) || kind !== 'model' && input.previous_base_url !== anchor.base_url) throw new ApiError('关联配置已变化，请关闭窗口后重新确认删除范围', 409);
 const selection = JSON.stringify(targetIds);
 if (await row(env, "SELECT id FROM runs WHERE target_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','running') LIMIT 1", selection)) throw new ApiError('还有检测正在进行，请先停止并等待结束，再删除配置', 409);
 const presets = await rows(env, 'SELECT DISTINCT preset_id FROM run_preset_targets WHERE target_id IN (SELECT value FROM json_each(?))', selection);
 const now = Date.now();
 // All checks are repeated inside the mutation transaction. If a new Key or
 // model was added after the preview, none of the reviewed configuration moves.
 const scopeCount = kind === 'station'
  ? '(SELECT COUNT(*) FROM endpoints WHERE base_url=? AND deleted_at IS NULL)=? AND (SELECT COUNT(*) FROM endpoints WHERE id IN (SELECT value FROM json_each(?)) AND base_url=? AND deleted_at IS NULL)=?'
  : kind === 'key' ? '(SELECT COUNT(*) FROM endpoints WHERE id IN (SELECT value FROM json_each(?)) AND base_url=? AND deleted_at IS NULL)=?'
  : '(SELECT COUNT(*) FROM endpoints WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL)=?';
 const scopeParams = kind === 'station' ? [anchor.base_url, endpointIds.length, endpointSelection, anchor.base_url, endpointIds.length]
  : kind === 'key' ? [endpointSelection, anchor.base_url, endpointIds.length] : [endpointSelection, endpointIds.length];
 const modelCount = kind === 'model'
  ? '(SELECT COUNT(*) FROM targets WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL)=?'
  : '(SELECT COUNT(*) FROM targets WHERE endpoint_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL)=?';
 const modelParams = [kind === 'model' ? selection : endpointSelection, targetIds.length];
 const statements = [
  env.DB.prepare(`WITH permitted AS MATERIALIZED (SELECT ${scopeCount} AND ${modelCount}
   AND NOT EXISTS(SELECT 1 FROM runs WHERE target_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','running')) AS valid)
   UPDATE targets SET deleted_at=? WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND (SELECT valid FROM permitted)`).bind(...scopeParams, ...modelParams, selection, now, selection),
  env.DB.prepare(`WITH permitted AS MATERIALIZED (SELECT ${scopeCount} AND
   NOT EXISTS(SELECT 1 FROM targets WHERE endpoint_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL) AS valid)
   UPDATE endpoints SET deleted_at=?,key_cipher='',updated_at=? WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND (SELECT valid FROM permitted)`).bind(...scopeParams, endpointSelection, now, now, endpointSelection),
  env.DB.prepare('DELETE FROM schedules WHERE target_id IN (SELECT id FROM targets WHERE deleted_at=? AND id IN (SELECT value FROM json_each(?)))').bind(now, selection),
  env.DB.prepare("UPDATE runs SET key_cipher='' WHERE status NOT IN ('queued','running') AND target_id IN (SELECT id FROM targets WHERE deleted_at=? AND id IN (SELECT value FROM json_each(?)))").bind(now, selection),
  env.DB.prepare('DELETE FROM run_preset_targets WHERE target_id IN (SELECT id FROM targets WHERE deleted_at=? AND id IN (SELECT value FROM json_each(?)))').bind(now, selection),
  env.DB.prepare(`DELETE FROM run_presets WHERE id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM run_preset_targets WHERE preset_id=run_presets.id)
   AND EXISTS(SELECT 1 FROM targets WHERE deleted_at=? AND id IN (SELECT value FROM json_each(?)))`).bind(JSON.stringify(presets.map(preset => preset.preset_id)), now, selection),
 ];
 const result = await env.DB.batch(statements);
 const modelsDeleted = result[0].meta.changes || 0; const keysDeleted = result[1].meta.changes || 0;
 if (!modelsDeleted && !keysDeleted) throw new ApiError('配置或检测状态已变化，请重新确认删除范围', 409);
 return { ok: true, models_deleted: modelsDeleted, keys_deleted: keysDeleted };
}
