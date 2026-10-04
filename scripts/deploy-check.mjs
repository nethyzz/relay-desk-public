import { existsSync, readFileSync } from 'node:fs';
import { command, config, python, secretNames, validateConfig, verifyRepository } from './deployment.mjs';
let failures = 0;
function check(label, action) { try { action(); console.log('✓ ' + label); } catch (error) { failures++; console.log('✗ ' + label + '：' + error.message); } }
check('部署配置无占位符且本地登录关闭', () => validateConfig(config()));
check('本地主密钥文件不会提交到 Git', () => {
 const ignored = readFileSync('.gitignore', 'utf8');
 if (!['.local/', '.vendor/', '.venv/', '.dev.vars', '.env'].every(item => ignored.split('\n').includes(item))) throw new Error('秘密或缓存目录缺少 Git 忽略规则');
 const tracked = command('git', ['ls-files', '-z'], { quiet: true }).split('\0');
 if (tracked.some(file => /^\.local\/|^\.venv\/|^\.vendor\/|^\.dev.vars$|^\.env$/.test(file))) throw new Error('发现凭据目录已被 Git 跟踪，请先取消跟踪');
});
check('原检测器与基准版本锁定', () => { if (!existsSync('.vendor/gpt56_vnext/detector.py')) throw new Error('先运行 npm run setup:local'); command(python(), ['scripts/bootstrap_upstream.py'], { quiet: true }); });
check('数据库迁移和执行器工作流齐全', () => { if (!existsSync('migrations/0001_initial.sql') || !existsSync('migrations/0002_password_login.sql') || !existsSync('migrations/0003_station_names.sql') || !existsSync('.github/workflows/detector.yml')) throw new Error('项目不完整'); });
if (process.argv.includes('--remote')) {
 check('GitHub 私人仓库和线上执行器与本地一致', () => verifyRepository(validateConfig(config())));
 check('Worker 登录、加密及任务 Secrets 齐全', () => { const names = secretNames(); for (const key of ['MASTER_KEY', 'SESSION_SECRET', 'LOGIN_CREDENTIALS', 'GITHUB_DISPATCH_TOKEN']) if (!names.has(key)) throw new Error('缺少 ' + key); });
 try {
  const value = validateConfig(config());
  const session = await fetch(value.vars.APP_ORIGIN + '/api/session', { signal: AbortSignal.timeout(15000) });
  const state = await session.json();
  if (!session.ok || !state.configured || !state.password_kdf || state.password_kdf.iterations !== 600000 || !state.execution_ready || state.local || state.authenticated) throw new Error('账号密码登录或执行器尚未连接，或检测到错误的本地身份');
  const response = await fetch(value.vars.APP_ORIGIN + '/api/panel', { signal: AbortSignal.timeout(15000) });
  if (response.status !== 401) throw new Error('匿名访问私人数据没有被拒绝');
  console.log('✓ 线上登录已配置，匿名访问报告被拒绝');
 } catch (error) { failures++; console.log('✗ 线上访问检查：' + error.message); }
}
console.log(failures ? `还有 ${failures} 项部署条件未满足。` : '部署检查通过。真实目标测试需在登录后的面板内完成。');
process.exitCode = failures ? 1 : 0;
