import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new EnvHttpProxyAgent());

export const PYODIDE_VERSION = '0.28.3';
const directory = resolve('.app-build/native-public/runtime');
const origin = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/package.json`, JSON.stringify({ type: 'commonjs' }));
for (const name of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  await cp(`node_modules/pyodide/${name}`, `${directory}/${name}`);
}
const lock = JSON.parse(await readFile(`${directory}/pyodide-lock.json`, 'utf8'));
const selected = new Set();
function select(name) {
  if (selected.has(name)) return;
  const item = lock.packages[name];
  if (!item) throw new Error(`运行环境未包含依赖：${name}`);
  selected.add(name);
  item.depends.forEach(select);
}
['numpy', 'httpx', 'sqlite3', 'ssl'].forEach(select);
for (const name of selected) {
  const item = lock.packages[name];
  const path = `${directory}/${item.file_name}`;
  let bytes;
  try { bytes = await readFile(path); } catch { /* Download only the pinned dependencies. */ }
  if (!bytes || hash(bytes) !== item.sha256) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(origin + item.file_name, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('下载失败');
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      } catch {
        if (attempt === 2) throw new Error(`运行环境依赖下载失败：${name}，请检查网络或代理。`);
      }
    }
    if (hash(bytes) !== item.sha256) throw new Error(`运行环境依赖校验失败：${name}`);
    await writeFile(path, bytes);
  }
}
const manifest = JSON.parse(await readFile('runner/upstream.json', 'utf8'));
const files = {};
for (const name of (await readdir('.vendor/gpt56_vnext')).filter(name => name.endsWith('.py'))) {
  files[`gpt56_vnext/${name}`] = await readFile(`.vendor/gpt56_vnext/${name}`, 'utf8');
}
for (const baseline of [...Object.values(manifest.baselines), ...Object.values(manifest.archived_baselines || {})]) {
  const name = `${baseline.id}--${baseline.version}.meow.json`;
  const bytes = await readFile(`.vendor/benchmarks/${name}`);
  if (hash(bytes) !== baseline.sha256) throw new Error('原检测器基准校验失败');
  files[`benchmarks/${name}`] = bytes.toString('utf8');
}
files['relay_runtime.py'] = await readFile('apps/local/relay_runtime.py', 'utf8');
files['relay_mail.py'] = await readFile('runner/mail.py', 'utf8');
const migrations = await Promise.all((await readdir('migrations')).filter(name => name.endsWith('.sql')).sort().map(async name => ({ name, sql: await readFile(`migrations/${name}`, 'utf8') })));
await writeFile(`${directory}/engine.json`, JSON.stringify({ version: manifest.engine_version, engine_ref: manifest.engine_ref, files, migrations }));
for (const name of ['icon.svg', 'icon-192.png', 'icon-512.png']) await cp(`public/${name}`, resolve('.app-build/native-public', name));
await cp('THIRD_PARTY_NOTICES.md', resolve('.app-build/native-public/THIRD_PARTY_NOTICES.md'));
await cp('LICENSES', resolve('.app-build/native-public/LICENSES'), { recursive: true });
console.log(`本地运行环境已准备：Pyodide ${PYODIDE_VERSION}、原检测器 ${manifest.engine_version}；运行时无需从 CDN 下载。`);
