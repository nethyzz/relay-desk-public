import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config, validateConfig, wrangler } from './deployment.mjs';
import { importSetting, localExport } from './local-export.ts';

try {
 const value = validateConfig(config());
 const identity = [value.account_id, value.name, value.d1_databases[0].database_id].join(':');
 if (!existsSync('.local/production-keys.json')) throw new Error('请先完成线上密钥配置，再迁移本地数据。');
 const production = JSON.parse(readFileSync('.local/production-keys.json', 'utf8'));
 if (production.identity !== identity) throw new Error('线上主密钥备份与目标部署不一致。');
 const source = JSON.parse(readFileSync('.local/secrets.json', 'utf8'));
 const db = new DatabaseSync('.local/panel.sqlite', { readOnly: true });
 let exported;
 try { db.exec('BEGIN'); exported = await localExport(db, source, production); } finally { db.close(); }
 const folder = '.local/production-import';
 mkdirSync(folder, { recursive: true, mode: 0o700 });
 const file = `${folder}/${exported.id}.sql`;
 if (!existsSync(file)) writeFileSync(file, exported.sql, { mode: 0o600 });
 chmodSync(file, 0o600);
 if (process.argv.includes('--prepare-only')) { console.log('加密迁移文件已生成；包含 ' + exported.counts.endpoints + ' 个站点、' + exported.counts.targets + ' 个模型和 ' + exported.counts.reports + ' 份报告。'); }
 else {
  const output = wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', `SELECT value FROM settings WHERE id='${importSetting}'`], { quiet: true });
  const query = JSON.parse(output.slice(output.indexOf('[')));
  const marker = query.flatMap(item => item.results || [])[0];
  const previous = marker ? JSON.parse(marker.value) : null;
  if (previous?.id === exported.id && previous.status === 'complete') console.log('这些本地数据已经迁移，未重复写入。');
  else {
   if (previous && previous.id !== exported.id) throw new Error('线上已迁移其他本地数据，已停止以避免覆盖。');
   wrangler(['d1', 'execute', 'DB', '--remote', '--file', file, '--yes'], { quiet: true });
   console.log('本地站点、模型、预算和历史报告已迁移；自动监测与邮件保持关闭。');
  }
 }
} catch (error) {
 // Never echo a database or cryptography exception, which may contain data.
 const safe = error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message) ? error.message : '加密迁移失败，请检查密钥、登录和数据库状态；本地数据未修改。';
 console.error(safe); process.exitCode = 1;
}
