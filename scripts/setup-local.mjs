import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { command } from './deployment.mjs';
try {
 const candidates = [process.env.RELAY_PYTHON, '.venv/bin/python', 'python3.12', 'python3.11', 'python3', process.env.HOME && process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'].filter(Boolean);
 const executable = candidates.find(candidate => spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'], { stdio: 'ignore' }).status === 0);
 if (!executable) throw new Error('请安装 Python 3.11 或以上版本，再运行本命令。');
 if (!existsSync('.venv/bin/python')) command(executable, ['-m', 'venv', '.venv'], { inherit: true });
 command('.venv/bin/python', ['-m', 'pip', 'install', '-r', 'runner/requirements.txt'], { inherit: true });
 command('.venv/bin/python', ['scripts/bootstrap_upstream.py', ...process.argv.slice(2)], { inherit: true });
 console.log('本地检测器就绪。运行 npm run dev，打开 http://127.0.0.1:5173。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
