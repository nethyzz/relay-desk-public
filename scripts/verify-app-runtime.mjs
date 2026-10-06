import { loadPyodide } from 'pyodide';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const directory = resolve('.app-build/native-public/runtime');
try {
  const executable = process.env.RELAY_PYTHON || (existsSync('.venv/bin/python') ? '.venv/bin/python' : existsSync('.venv/Scripts/python.exe') ? '.venv/Scripts/python.exe' : process.platform === 'win32' ? 'python' : 'python3');
  const python = spawnSync(executable, ['tests/app-runtime-fixture.py'], { encoding: 'utf8' });
  if (python.status !== 0) throw new Error(python.stderr.slice(-3000));
  const expected = JSON.parse(python.stdout);
  const py = await loadPyodide({ indexURL: directory, stdout: () => {}, stderr: () => {} });
  await py.loadPackage(['numpy', 'httpx', 'sqlite3', 'ssl']);
  const bundle = JSON.parse(readFileSync(directory + '/engine.json', 'utf8'));
  for (const [name, source] of Object.entries(bundle.files)) {
    const path = '/engine/' + name;
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    py.FS.writeFile(path, source);
  }
  py.runPython('import sys; sys.path.insert(0, "/engine"); import relay_runtime');
  py.globals.set('migration_json', JSON.stringify(bundle.migrations));
  py.runPython('relay_runtime.panel_restore(""); relay_runtime.panel_migrate(migration_json)');
  const groups = JSON.parse(py.runPython('relay_runtime.panel_query("SELECT name FROM groups", "[]", "all")'));
  assert.equal(groups.length, 1);
  py.runPython(readFileSync('tests/app-runtime-fixture.py', 'utf8').replace('if __name__ == "__main__":', 'if False:'));
  const actual = JSON.parse(await py.runPythonAsync('await app_fixture()'));
  function compare(left, right, path = '') {
    if (typeof left === 'number' && typeof right === 'number') {
      assert.ok(Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-10), `${path}: ${left} != ${right}`);
    } else if (left && typeof left === 'object') {
      assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), path);
      for (const key of Object.keys(left)) compare(left[key], right[key], path + '.' + key);
    } else assert.deepEqual(left, right, path);
  }
  compare(expected, actual);
  const saved = py.runPython('relay_runtime.panel_snapshot()');
  py.globals.set('saved_snapshot', saved);
  py.runPython('relay_runtime.panel_restore(saved_snapshot)');
  assert.deepEqual(JSON.parse(py.runPython('relay_runtime.panel_query("SELECT name FROM groups", "[]", "all")')), groups);
  console.log(`通过：${actual.detectors.length} 组离线原检测器对照、${actual.transports.length} 组原生传输／取消对照、SQLite 初始化及保存恢复。没有调用模型 API。`);
} catch (error) {
  console.error(String(error).slice(-4000));
  process.exitCode = 1;
}
// The WASM event loop can keep Node alive after all awaited checks finish.
// Flush the CLI output, then preserve the success or failure exit status.
await new Promise(resolve => process.stdout.write('', resolve));
await new Promise(resolve => process.stderr.write('', resolve));
process.exit(process.exitCode ?? 0);
