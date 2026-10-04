import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { config, ghJson, wrangler } from './deployment.mjs';
try {
 const { values } = parseArgs({ options: { repository: { type: 'string' }, subdomain: { type: 'string' }, 'account-id': { type: 'string' }, 'database-id': { type: 'string' }, name: { type: 'string' } } });
 if (!/^[\w.-]+\/[\w.-]+$/.test(values.repository || '') || !/^[a-z0-9-]+$/.test(values.subdomain || '')) throw new Error('用法：npm run configure -- --repository 用户名/relay-desk --subdomain 你的workers子域名');
 const user = ghJson('user'); const repo = ghJson('repos/' + values.repository);
 if (!repo.private || repo.owner.id !== user.id) throw new Error('请使用当前 GitHub 账号自己拥有的私人仓库。');
 const raw = wrangler(['whoami', '--json'], { quiet: true });
 const info = JSON.parse(raw.slice(raw.indexOf('{')));
 if (!info.loggedIn) throw new Error('请先运行 npx wrangler login 登录 Cloudflare。');
 const accountId = values['account-id'] || (info.accounts?.length === 1 ? info.accounts[0].id : null);
 if (!accountId || !info.accounts.some(account => account.id === accountId)) throw new Error('有多个 Cloudflare 账户，请加 --account-id 指定要部署的账户。');
 const value = config(); value.account_id = accountId;
 value.name = values.name || value.name;
 if (!/^[a-z0-9-]{1,63}$/.test(value.name)) throw new Error('Worker 名称只支持小写英文字母、数字和短横线。');
 value.vars = { APP_ORIGIN: `https://${value.name}.${values.subdomain}.workers.dev`, GITHUB_OWNER_ID: String(user.id), GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: String(repo.id), GITHUB_WORKFLOW: 'detector.yml', GITHUB_REF: 'refs/heads/' + repo.default_branch };
 if (values['database-id']) value.d1_databases[0].database_id = values['database-id'];
 writeFileSync('wrangler.jsonc', JSON.stringify(value, null, 2) + '\n');
 if (value.d1_databases[0].database_id.includes('REPLACE')) {
  console.log('正在创建本应用的 D1 数据库（不修改已有数据库）。');
  wrangler(['d1', 'create', value.d1_databases[0].database_name, '--binding', 'DB', '--update-config'], { inherit: true });
 }
 console.log('账号与仓库 ID 已校验并保存。网站地址：' + value.vars.APP_ORIGIN);
 console.log('下一步配置账号密码：npm run configure:login -- --email 你的邮箱');
} catch (error) { console.error(error.message); process.exitCode = 1; }
