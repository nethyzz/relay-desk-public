import { mkdirSync, writeFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { createLoginCredentials } from '../worker/password.ts';
import { config, validateConfig, wrangler } from './deployment.mjs';
function passwordInput(label) {
 if (!process.stdin.isTTY) throw new Error('请在自己的终端运行此命令，密码只能通过隐藏输入填写。');
 process.stdout.write(label); emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
 return new Promise((resolve, reject) => {
  let value = '';
  const cleanup = () => { process.stdin.removeListener('keypress', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
  const input = (text, key = {}) => {
   if (key.ctrl && key.name === 'c') { cleanup(); reject(new Error('已取消')); }
   else if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); }
   else if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
   else if (typeof text === 'string' && !key.ctrl && !key.meta && !/[\u0000-\u001f]/.test(text)) value += text;
  };
  process.stdin.on('keypress', input);
 });
}
try {
 const { values } = parseArgs({ options: { email: { type: 'string' }, upload: { type: 'boolean', default: false } } });
 const value = validateConfig(config());
 if (!values.email) throw new Error('用法：npm run configure:login -- --email 你的邮箱 [--upload]');
 const password = await passwordInput('输入面板密码（不会显示）：');
 const confirm = await passwordInput('再次输入密码：');
 if (password !== confirm) throw new Error('两次密码不同，请重新运行。');
 const credentials = await createLoginCredentials(values.email, password);
 const identity = [value.account_id, value.name, value.d1_databases[0].database_id].join(':');
 mkdirSync('.local', { recursive: true, mode: 0o700 });
 writeFileSync('.local/production-login.json', JSON.stringify({ identity, credentials }) + '\n', { mode: 0o600 });
 if (values.upload) wrangler(['secret', 'put', 'LOGIN_CREDENTIALS'], { input: JSON.stringify(credentials) + '\n', quiet: true });
 console.log(values.upload ? '账号密码已更新，已有登录状态已失效。' : '登录校验值已保存，部署时会安全上传。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
