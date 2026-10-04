import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { SQLiteDatabase } from './sqlite.ts';
import { handleRequest, tick } from '../worker/index.ts';
import type { Env } from '../worker/types.ts';
setGlobalDispatcher(new EnvHttpProxyAgent());
mkdirSync('.local', { recursive: true, mode: 0o700 });
const secretPath = '.local/secrets.json';
if (!existsSync(secretPath)) writeFileSync(secretPath, JSON.stringify({ SESSION_SECRET: randomBytes(48).toString('base64'), MASTER_KEY: randomBytes(32).toString('base64'), LOCAL_RUNNER_TOKEN: randomBytes(32).toString('hex') }), { mode: 0o600 });
const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
const db = new SQLiteDatabase(process.env.RELAY_LOCAL_DB || '.local/panel.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)');
for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) {
 if (!db.connection.prepare('SELECT name FROM local_migrations WHERE name=?').get(name)) { db.exec(readFileSync('migrations/' + name, 'utf8')); db.connection.prepare('INSERT INTO local_migrations VALUES (?)').run(name); }
}
const previewOnly = process.env.RELAY_PREVIEW_ONLY === '1';
const env: Env = { DB: db, ...secrets, APP_ORIGIN: 'http://127.0.0.1:5173', DEV_MODE: 'local', LOCAL_PREVIEW_ONLY: previewOnly ? '1' : '0', LOCAL_RUNNER_READY: !previewOnly && existsSync('.vendor/gpt56_vnext/detector.py') ? '1' : '0' };
const tasks = new Set<Promise<unknown>>();
const ctx = { waitUntil(p: Promise<unknown>) { tasks.add(p); p.finally(() => tasks.delete(p)).catch(() => {}); } };
const server = createServer(async (req, res) => {
 try {
  const buffers: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 1300000) { res.writeHead(413); res.end('{"error":"请求过大"}'); return; } buffers.push(chunk); }
  const request = new Request('http://127.0.0.1:8787' + req.url, { method: req.method, headers: req.headers as Record<string, string>, ...(buffers.length ? { body: Buffer.concat(buffers) } : {}) });
  const response = await handleRequest(request, env, ctx);
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
 } catch { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"本地服务操作失败"}'); }
});
server.listen(8787, '127.0.0.1', () => process.stdout.write('本地 API 已启动：http://127.0.0.1:8787（仅本机访问）\n'));
const timer = previewOnly ? null : setInterval(() => tick(env).catch(() => {}), 60000);
process.on('SIGTERM', () => { if (timer) clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); });
