import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { importSetting, localExport } from '../scripts/local-export.ts';
import { decrypt, encrypt } from '../worker/security.ts';
import type { Env } from '../worker/types.ts';

const schema = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
const laterMigrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql') && name !== '0001_initial.sql').sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
async function sourceFixture() {
 const source = { MASTER_KEY: randomBytes(32).toString('base64') } as Env;
 const destination = { MASTER_KEY: randomBytes(32).toString('base64') } as Env;
 const db = new DatabaseSync(':memory:'); db.exec(schema);
 const key = 'sk-migration-fixture-private-key';
 db.prepare('INSERT INTO endpoints VALUES (?,?,?,?,?,?,?)').run('endpoint', 'default', "站点 ' 名称", 'https://api.example.com/v1', await encrypt(key, source, 'endpoint:endpoint'), 1, 1);
 db.prepare('INSERT INTO targets VALUES (?,?,?,?,?,?,?,?)').run('target', 'endpoint', '测试模型', 'gpt', 'custom-model', 'gpt-6-astra', 'low', 1);
 db.prepare('INSERT INTO schedules(target_id,updated_at) VALUES (?,?)').run('target', 1);
 db.prepare("INSERT INTO batches(id,status,created_at,lease_hash) VALUES ('batch','completed',1,'local-lease-hash')").run();
 db.prepare("INSERT INTO runs(id,batch_id,target_id,status,source,created_at,snapshot,key_cipher,report,attempts,reserved_attempts,quota_day) VALUES ('run','batch','target','completed','manual',1,?,?,?,32,48,'2026-10-03')").run(JSON.stringify({ endpoint_id: 'endpoint' }), await encrypt(key, source, 'run:run'), JSON.stringify({ fingerprint: { verdict: 'match', valid_samples: 32 } }));
 db.prepare("INSERT INTO runs(id,batch_id,target_id,status,source,created_at,snapshot,key_cipher,attempts,reserved_attempts,quota_day) VALUES ('cleared','batch','target','failed','manual',1,'{}','',0,48,'2026-10-03')").run();
 const password = 'migration-private-smtp-password';
 db.prepare("UPDATE settings SET value=? WHERE id='mail'").run(JSON.stringify({ enabled: false, mode: 'changes', host: 'smtp.example.com', password_cipher: await encrypt(password, source, 'smtp') }));
 db.exec(laterMigrations);
 db.prepare('INSERT INTO run_presets VALUES (?,?,?,?)').run('preset', '常用检测', 1, 1);
 db.prepare('INSERT INTO run_preset_targets VALUES (?,?,?)').run('preset', 'target', 0);
 return { db, source, destination, key, password };
}
test('local data migration rekeys credentials and preserves reports without writing plaintext or leases', async () => {
 const f = await sourceFixture(); const exported = await localExport(f.db, f.source, f.destination);
 assert.ok(!exported.sql.includes(f.key)); assert.ok(!exported.sql.includes(f.password)); assert.ok(!exported.sql.includes('local-lease-hash'));
 const dest = new DatabaseSync(':memory:'); dest.exec(schema + laterMigrations); dest.exec(exported.sql);
 const endpoint = dest.prepare('SELECT * FROM endpoints').get()!;
 assert.equal(endpoint.name, "站点 ' 名称");
 assert.equal(endpoint.station_name, "站点 ' 名称");
 assert.equal(await decrypt(endpoint.key_cipher as string, f.destination, 'endpoint:endpoint'), f.key);
 await assert.rejects(decrypt(endpoint.key_cipher as string, f.source, 'endpoint:endpoint'));
 const run = dest.prepare('SELECT * FROM runs').get()!;
 assert.equal(await decrypt(run.key_cipher as string, f.destination, 'run:run'), f.key);
 assert.equal(JSON.parse(run.report as string).fingerprint.valid_samples, 32);
 assert.equal(dest.prepare("SELECT name FROM run_presets WHERE id='preset'").get()!.name, '常用检测');
 assert.deepEqual(dest.prepare("SELECT target_id FROM run_preset_targets WHERE preset_id='preset' ORDER BY position").all().map(row => row.target_id), ['target']);
 assert.equal(dest.prepare("SELECT key_cipher FROM runs WHERE id='cleared'").get()!.key_cipher, '');
 const mail = JSON.parse(dest.prepare("SELECT value FROM settings WHERE id='mail'").get()!.value as string);
 assert.equal(await decrypt(mail.password_cipher, f.destination, 'smtp'), f.password); assert.equal(mail.enabled, false);
 assert.equal((dest.prepare('PRAGMA foreign_key_check').all()).length, 0);
 assert.equal(JSON.parse(dest.prepare('SELECT value FROM settings WHERE id=?').get(importSetting)!.value as string).status, 'complete');
 assert.throws(() => dest.exec(exported.sql), /CHECK/);
 f.db.close(); dest.close();
});
test('migration refuses an occupied destination and unfinished or scheduled local jobs', async () => {
 const f = await sourceFixture(); const exported = await localExport(f.db, f.source, f.destination);
 const dest = new DatabaseSync(':memory:'); dest.exec(schema + laterMigrations);
 dest.prepare('INSERT INTO endpoints(id,group_id,name,base_url,key_cipher,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('existing', 'default', '已有站点', 'https://other.example.com', 'existing-cipher', 2, 2);
 assert.throws(() => dest.exec(exported.sql), /CHECK/);
 assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM endpoints').get()!.n, 1);
 assert.equal(dest.prepare('SELECT key_cipher FROM endpoints').get()!.key_cipher, 'existing-cipher');
 f.db.exec("UPDATE runs SET status='running' WHERE id='run'");
 await assert.rejects(localExport(f.db, f.source, f.destination), /本地任务未结束/);
 f.db.exec("UPDATE runs SET status='completed'; UPDATE schedules SET enabled=1;");
 await assert.rejects(localExport(f.db, f.source, f.destination), /关闭本地自动监测/);
 f.db.close(); dest.close();
});
test('migration retains deleted configuration only as report anchors and never restores cleared Keys', async () => {
 const f = await sourceFixture();
 f.db.exec("DELETE FROM schedules; DELETE FROM run_presets; UPDATE runs SET key_cipher=''; UPDATE targets SET deleted_at=100; UPDATE endpoints SET deleted_at=100,key_cipher='';");
 const exported = await localExport(f.db, f.source, f.destination);
 const dest = new DatabaseSync(':memory:');
 try {
  dest.exec(schema + laterMigrations); dest.exec(exported.sql);
  assert.equal(dest.prepare('SELECT deleted_at FROM targets').get()!.deleted_at, 100);
  assert.equal(dest.prepare('SELECT deleted_at FROM endpoints').get()!.deleted_at, 100);
  assert.equal(dest.prepare('SELECT key_cipher FROM endpoints').get()!.key_cipher, '');
  assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 2);
  assert.equal(JSON.parse(dest.prepare("SELECT report FROM runs WHERE id='run'").get()!.report as string).fingerprint.valid_samples, 32);
  assert.deepEqual(dest.prepare('PRAGMA foreign_key_check').all(), []);
 } finally { f.db.close(); dest.close(); }
});
test('relay names migrate consistently across existing same-URL Key profiles without changing credentials', () => {
 const db = new DatabaseSync(':memory:'); db.exec(schema);
 const insert = db.prepare('INSERT INTO endpoints VALUES (?,?,?,?,?,?,?)');
 insert.run('first', 'default', '中转站', 'https://same.example.com/v1', 'cipher-first', 1, 1);
 insert.run('second', 'default', '备用 Key 配置', 'https://same.example.com/v1', 'cipher-second', 2, 2);
 insert.run('other', 'default', '其他中转站', 'https://other.example.com/v1', 'cipher-other', 3, 3);
 db.exec(laterMigrations);
 assert.deepEqual(db.prepare('SELECT station_name FROM endpoints ORDER BY created_at').all().map(row => row.station_name), ['中转站', '中转站', '其他中转站']);
 assert.deepEqual(db.prepare('SELECT key_cipher FROM endpoints ORDER BY created_at').all().map(row => row.key_cipher), ['cipher-first', 'cipher-second', 'cipher-other']);
 assert.equal(db.prepare("SELECT name FROM endpoints WHERE id='second'").get()!.name, '备用 Key 配置'); db.close();
});
