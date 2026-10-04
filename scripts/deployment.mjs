import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export const cliEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
export function command(program, args, { input, quiet = false, inherit = false } = {}) {
 const result = spawnSync(program, args, { encoding: 'utf8', env: cliEnv, input, maxBuffer: 8 * 1024 * 1024, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
 if (result.error || result.status !== 0) {
  // Never echo command arguments, stdin or command output: any may contain secrets.
  throw new Error(`${program === 'gh' ? 'GitHub CLI' : '部署命令'}执行失败。请检查账号登录、权限和网络。`);
 }
 if (!quiet && !inherit && result.stdout) process.stdout.write(result.stdout);
 return result.stdout || '';
}
export function wrangler(args, options = {}) { return command(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], options); }
export function github(args, options = {}) {
 const program = existsSync('.local/tools/bin/gh') ? '.local/tools/bin/gh' : 'gh';
 return command(program, args, options);
}
export function ghJson(path) { return JSON.parse(github(['api', path], { quiet: true })); }
export function config() { return JSON.parse(readFileSync('wrangler.jsonc', 'utf8')); }
export function validateConfig(value) {
 if (/REPLACE_WITH/.test(JSON.stringify(value))) throw new Error('部署配置尚未填写。先运行 npm run configure。');
 if (!/^[a-z0-9-]{1,63}$/.test(value.name) || !/^[a-f0-9]{32}$/.test(value.account_id || '') || !/^[a-f0-9-]{36}$/.test(value.d1_databases?.[0]?.database_id || '')) throw new Error('Worker、Cloudflare 账户或 D1 配置不正确。');
 const v = value.vars || {};
 if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(v.APP_ORIGIN || '') || !/^\d+$/.test(v.GITHUB_OWNER_ID || '') || !/^\d+$/.test(v.GITHUB_REPOSITORY_ID || '') || !/^[\w.-]+\/[\w.-]+$/.test(v.GITHUB_REPOSITORY || '')) throw new Error('网站地址或 GitHub 配置不正确。');
 if (v.DEV_MODE || v.LOCAL_RUNNER_TOKEN || v.LOCAL_RUNNER_READY) throw new Error('生产配置不能开启本地登录或本地执行器。');
 if (value.triggers?.crons?.[0] !== '* * * * *') throw new Error('请保留每分钟任务调度。');
 return value;
}
export function verifyRepository(value, verifyFiles = true) {
 const user = ghJson('user'); const repo = ghJson('repos/' + value.vars.GITHUB_REPOSITORY);
 if (!repo.private || String(repo.id) !== value.vars.GITHUB_REPOSITORY_ID || String(repo.owner.id) !== value.vars.GITHUB_OWNER_ID || String(user.id) !== value.vars.GITHUB_OWNER_ID) throw new Error('需要所有者的私人 GitHub 仓库，且 ID 必须与部署配置一致。');
 if ('refs/heads/' + repo.default_branch !== value.vars.GITHUB_REF) throw new Error('GitHub 默认分支与执行器 OIDC 配置不一致。');
 if (verifyFiles) for (const file of ['.github/workflows/detector.yml', 'runner/upstream.json', 'runner/execute.py', 'runner/mail.py', 'runner/network.py', 'scripts/bootstrap_upstream.py', 'runner/requirements.txt']) {
  const content = readFileSync(file);
  const localHash = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const remote = ghJson(`repos/${repo.full_name}/contents/${file}?ref=${repo.default_branch}`);
  if (remote.sha !== localHash) throw new Error(`请先把最新的 ${file} 推送到 GitHub 默认分支，再部署面板。`);
 }
 return repo;
}
export function secretNames() {
 const output = wrangler(['secret', 'list', '--format', 'json'], { quiet: true });
 const arrayStart = output.indexOf('[');
 if (arrayStart < 0) throw new Error('无法读取 Worker Secrets 列表。');
 const values = JSON.parse(output.slice(arrayStart));
 return new Set(values.map(value => value.name));
}
export function python() {
 if (process.env.RELAY_PYTHON) return process.env.RELAY_PYTHON;
 if (existsSync('.venv/bin/python')) return '.venv/bin/python';
 return 'python3';
}
