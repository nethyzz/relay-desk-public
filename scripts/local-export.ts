import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt } from '../worker/security.ts';
import type { Env } from '../worker/types.ts';

type Row = Record<string, any>;
const tables = ['groups', 'endpoints', 'targets', 'run_presets', 'run_preset_targets', 'schedules', 'settings', 'batches', 'runs', 'run_sets', 'run_set_members', 'quota_reservations'] as const;
export const importSetting = 'local_import';
function literal(value: unknown): string {
 if (value === null || value === undefined) return 'NULL';
 if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
 if (typeof value !== 'string' || value.includes('\0')) throw new Error('本地数据包含无法迁移的值。');
 return "'" + value.replace(/'/g, "''") + "'";
}

export async function localExport(db: DatabaseSync, source: Pick<Env, 'MASTER_KEY'>, destination: Pick<Env, 'MASTER_KEY'>) {
 const data = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) as Record<typeof tables[number], Row[]>;
 if (data.runs.some(run => ['queued', 'running'].includes(run.status)) || data.batches.some(batch => ['queued', 'dispatched', 'running'].includes(batch.status))) throw new Error('还有本地任务未结束，请完成后再迁移。');
 if (data.schedules.some(schedule => schedule.enabled)) throw new Error('请先关闭本地自动监测，避免本地与线上重复检测。');
 const mail = JSON.parse(data.settings.find(setting => setting.id === 'mail')!.value);
 if (mail.enabled) throw new Error('请先关闭本地邮件，再迁移已保存的设置。');
 data.settings = data.settings.filter(setting => ['limits', 'mail'].includes(setting.id));
 const importId = createHash('sha256').update(JSON.stringify(data)).update(destination.MASTER_KEY).digest('hex');
 const secrets = new Set<string>();
 async function rekey(cipher: string, context: string) {
  const plaintext = await decrypt(cipher, source as Env, context);
  secrets.add(plaintext);
  return encrypt(plaintext, destination as Env, context);
 }
 for (const endpoint of data.endpoints) endpoint.key_cipher = await rekey(endpoint.key_cipher, 'endpoint:' + endpoint.id);
 for (const run of data.runs) if (run.key_cipher) run.key_cipher = await rekey(run.key_cipher, 'run:' + run.id);
 if (mail.password_cipher) mail.password_cipher = await rekey(mail.password_cipher, 'smtp');
 data.settings.find(setting => setting.id === 'mail')!.value = JSON.stringify(mail);
 for (const batch of data.batches) for (const field of ['claimed_by', 'lease_hash', 'lease_until', 'heartbeat_at', 'mail_payload']) batch[field] = null;
 const pending = JSON.stringify({ id: importId, status: 'importing' });
 const complete = JSON.stringify({ id: importId, status: 'complete' });
 const canImport = `((NOT EXISTS(SELECT 1 FROM endpoints) AND NOT EXISTS(SELECT 1 FROM targets) AND NOT EXISTS(SELECT 1 FROM runs) AND NOT EXISTS(SELECT 1 FROM batches) AND NOT EXISTS(SELECT 1 FROM settings WHERE id='${importSetting}')) OR EXISTS(SELECT 1 FROM settings WHERE id='${importSetting}' AND value=${literal(pending)}))`;
 const statements = [
  'CREATE TABLE IF NOT EXISTS relay_import_guard (id INTEGER PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));',
  `INSERT OR REPLACE INTO relay_import_guard VALUES (1,CASE WHEN ${canImport} THEN 1 ELSE 0 END);`,
  `INSERT OR IGNORE INTO settings VALUES ('${importSetting}',${literal(pending)});`,
 ];
 for (const table of tables) for (const row of data[table]) {
  const columns = Object.keys(row);
  const conflict = table === 'settings' || table === 'groups' ? ' ON CONFLICT(id) DO UPDATE SET ' + columns.filter(column => column !== 'id').map(column => `${column}=excluded.${column}`).join(',') : ' ON CONFLICT DO NOTHING';
  statements.push(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(column => literal(row[column])).join(',')})${conflict};`);
 }
 statements.push(`UPDATE settings SET value=${literal(complete)} WHERE id='${importSetting}';`, 'DROP TABLE relay_import_guard;');
 if (statements.some(statement => Buffer.byteLength(statement) > 100000)) throw new Error('历史报告超过 D1 单条导入限制，请使用分块迁移。');
 const sql = statements.join('\n') + '\n';
 if ([...secrets].some(secret => secret && sql.includes(secret))) throw new Error('迁移检查发现未清洗的凭据，已停止导出。');
 return { id: importId, sql, counts: { groups: data.groups.length, endpoints: data.endpoints.length, targets: data.targets.length, reports: data.runs.length }, destinationKeyHash: createHash('sha256').update(destination.MASTER_KEY).digest('hex') };
}
