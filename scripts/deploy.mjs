import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { command, config, github, python, secretNames, validateConfig, verifyRepository, wrangler } from './deployment.mjs';
try {
 const value = validateConfig(config());
 if (!process.argv.includes('--free-tier-checked')) throw new Error('首次部署前，请在 Cloudflare 确认使用 Free 计划，并在 GitHub Actions 预算中启用超额停止。完成后运行 npm run deploy -- --free-tier-checked。');
 console.log('校验私人仓库与执行器版本…'); verifyRepository(value);
 command('npm', ['test'], { inherit: true });
 command(python(), ['scripts/bootstrap_upstream.py'], { inherit: true });
 command(python(), ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], { inherit: true });
 command('npm', ['run', 'build'], { inherit: true });
 console.log('应用远程 D1 迁移…'); wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { inherit: true });
 console.log('上传网站和 Worker…'); wrangler(['deploy'], { inherit: true });
 const names = secretNames(); const backupFile = '.local/production-keys.json';
 const identity = [value.account_id, value.name, value.d1_databases[0].database_id].join(':');
 let backup = existsSync(backupFile) ? JSON.parse(readFileSync(backupFile, 'utf8')) : null;
 if (backup && backup.identity !== identity) throw new Error('此目录保存了其他部署的主密钥备份，请使用独立目录部署新面板。');
 if (!backup) {
  backup = { identity, MASTER_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(48).toString('base64') };
  mkdirSync('.local', { recursive: true, mode: 0o700 }); writeFileSync(backupFile, JSON.stringify(backup), { mode: 0o600 });
 }
 for (const name of ['MASTER_KEY', 'SESSION_SECRET']) if (!names.has(name)) wrangler(['secret', 'put', name], { input: backup[name] + '\n', quiet: true });
 if (!names.has('LOGIN_CREDENTIALS')) {
  const loginFile = '.local/production-login.json';
  if (!existsSync(loginFile)) throw new Error('请先运行 npm run configure:login -- --email 你的邮箱，再重新部署。');
  const login = JSON.parse(readFileSync(loginFile, 'utf8'));
  if (login.identity !== identity) throw new Error('登录备份属于其他部署，请重新配置。');
  wrangler(['secret', 'put', 'LOGIN_CREDENTIALS'], { input: JSON.stringify(login.credentials) + '\n', quiet: true });
 }
 for (const name of ['GITHUB_DISPATCH_TOKEN']) if (!names.has(name)) {
  if (!process.stdin.isTTY) throw new Error(`需要安全输入 ${name}。请在自己的终端运行部署命令，或先用 npx wrangler secret put ${name} 保存。`);
  console.log('请在下面的 Wrangler 输入框中填写 ' + name + '，不要把秘密放进命令或聊天。');
  wrangler(['secret', 'put', name], { inherit: true });
 }
 github(['variable', 'set', 'PANEL_ORIGIN', '--repo', value.vars.GITHUB_REPOSITORY, '--body', value.vars.APP_ORIGIN], { quiet: true });
 console.log('网站已部署：' + value.vars.APP_ORIGIN);
 console.log('下一步：npm run deploy:check -- --remote，然后登录网站保存一个目标，选择快速档实测。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
