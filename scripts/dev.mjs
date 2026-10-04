import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { localNetworkEnvironment } from './local-network.mjs';
const pythonExecutable = process.env.RELAY_PYTHON || (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const env = localNetworkEnvironment(pythonExecutable);
const api = spawn(process.execPath, ['--experimental-strip-types', 'scripts/dev-server.ts'], { stdio: 'inherit', env });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env });
const python = existsSync('.vendor/gpt56_vnext/detector.py') ? spawn(pythonExecutable, ['runner/execute.py', '--local'], { stdio: 'inherit', env }) : null;
function stop() { api.kill(); vite.kill(); python?.kill(); }
process.on('SIGINT', () => { stop(); process.exit(0); }); process.on('SIGTERM', () => { stop(); process.exit(0); });
for (const child of [api, vite, python].filter(Boolean)) child.on('exit', code => { if (code && code !== 0) { stop(); process.exit(code); } });
