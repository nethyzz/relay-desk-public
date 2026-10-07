# 云端部署指南

Relay Desk 使用 Cloudflare Workers 托管网站与 API，D1 保存配置及报告，私有 GitHub Actions 执行原版 meow 内核。部署需要自己的 Cloudflare 账户和自己拥有的私有 GitHub 仓库。

公开源码仓库与私人执行仓库承担不同用途。不要把本公开仓库直接配置为执行器；`configure` 与部署检查要求私有仓库，并校验账户、仓库 ID、默认分支和工作流身份。

## 1. 准备依赖与登录

先按 [README](../README.md#快速开始) 克隆项目，运行 `npm ci` 和 `npm run setup:local`。安装 [GitHub CLI](https://cli.github.com/)；macOS 使用 Homebrew 时可执行：

```bash
brew install gh
gh auth login
npx wrangler login
```

没有 Homebrew 或使用 Linux 时，按 GitHub CLI 官网安装。注册自己的 `workers.dev` 子域名；Wrangler 首次部署时会提示。

## 2. 建立私有执行仓库

在新克隆的目录中运行以下命令，保留公开项目作为 `upstream`，把自己的私有仓库设为 `origin`：

```bash
RELAY_GITHUB_OWNER=$(gh api user --jq .login)
git remote rename origin upstream
gh repo create "${RELAY_GITHUB_OWNER}/relay-desk" --private --source=. --remote=origin --push
```

如果已存在自己的私有执行仓库，跳过创建步骤，把 `origin` 设为该仓库并推送源码到它的默认分支。不要依靠公开仓库的 Fork 来建立私有执行仓库。

后续 `configure`、fine-grained token、工作流和 `PANEL_ORIGIN` 都使用这个私有仓库。

## 3. 生成自己的 Cloudflare 配置

```bash
npm run configure -- --repository 你的GitHub用户名/relay-desk --subdomain 你的workers子域名
```

命令会读取当前 GitHub 用户与仓库 ID、确认所有权，并创建新的 D1 数据库，写入本地 `wrangler.jsonc`。它不读取或覆盖其他 D1 数据库。多个 Cloudflare 账户可使用 `--account-id` 指定账户；`--name` 可指定 Worker 名称。只有明确复用自己已有数据库时才使用 `--database-id`。

配置文件中的账户 ID、数据库 ID、网站地址都是部署参数，不是 token；私有执行仓库可保留自己的配置。向公开项目贡献代码时，应保留占位符模板。

## 4. 配置登录与任务 token

创建一个仅授权到该私有仓库的 GitHub fine-grained token，权限为 **Actions: Read and write** 与 **Metadata: Read-only**。它仅用于 Worker 启动检测工作流；网站登录使用自己的邮箱和密码。

在终端隐藏输入两次面板密码：

```bash
npm run configure:login -- --email 你的邮箱
```

密码校验材料保存在被 Git 忽略的 `.local/production-login.json`（权限 0600），其中没有明文密码。不要把密码、API Key、SMTP 授权码或 token 写进 README、Issue、命令参数或 Git 提交。

`.env.example` 只说明秘密名称；部署脚本使用 Wrangler Secrets，不要求把秘密写入 `.env`。

## 5. 检查预算并部署

Cloudflare 选择 Free 计划，并在 GitHub Actions 预算中启用超额停止。GitHub Free 私有仓库的标准 runner 当前每月包含 2,000 分钟；配额按账户共享。具体收费以 [GitHub Actions 官方说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions) 为准。面板默认每日请求上限为 2,000、每月 runner 分钟上限为 1,500；模型 API 请求仍按服务商定价计费。

先把源码推送到私有仓库默认分支，确保尤其是工作流、runner 和上游版本清单已同步，然后运行：

```bash
git push origin main
npm run deploy -- --free-tier-checked
```

若默认分支名不同，请使用实际分支名。部署脚本会：

1. 校验私有仓库与执行器文件是否一致。
2. 校验固定内核，运行 TypeScript / Python 对照测试和生产构建。
3. 应用 D1 迁移并部署网站与 Worker。
4. 保存并上传 `MASTER_KEY`、`SESSION_SECRET`、`LOGIN_CREDENTIALS`，安全输入 `GITHUB_DISPATCH_TOKEN`。
5. 自动在私有仓库写入 Actions 变量 `PANEL_ORIGIN`。

主密钥备份位于 `.local/production-keys.json`。**保留该文件：更换主密钥后，已有 API Key 和 SMTP 授权码无法用新密钥解密。**

## 6. 验证与首次使用

```bash
npm run deploy:check -- --remote
```

检查会核验 Worker Secrets、账号密码登录、GitHub OIDC 执行器及匿名访问限制。匿名读取 `/api/panel` 应返回 401。登录自己部署的网站，新增一个目标，先以快速档验证配置和连接；正式 GPT 比较推荐深度档。手机 Safari 可通过「添加到主屏幕」作为 PWA 使用。

不要在 GitHub Actions 页面直接随意填写批次 ID；由面板创建任务并触发工作流。

## 7. 本地数据迁移与备份

首次云端部署成功且线上数据库为空时，可迁移本地已有配置：

```bash
npm run migrate:local
```

先结束本地任务，关闭本地监测和邮件。迁移脚本会用线上主密钥重新加密站点 Key、历史任务 Key 和 SMTP 授权码；导入配置、模型、预算和历史报告，不导出明文凭据或执行器租约。脚本只向空的新面板导入，不覆盖已有配置；迁移文件保存于被 Git 忽略的 `.local/production-import/`，权限 0600。

本地备份须同时保留 `.local/panel.sqlite` 和 `.local/secrets.json`。云端须保留 `.local/production-keys.json` 与 `.local/production-login.json`，并按自己的备份策略导出 D1 数据。

## 8. 修改密码与升级

```bash
npm run configure:login -- --email 你的邮箱 --upload
```

修改后旧会话立即失效。登录会话默认保持 30 天，支持浏览器密码管理器；生产 Cookie 使用 HttpOnly、Secure、SameSite。

更新源码后，先检查变更并将执行器文件推送到私有默认分支，再执行部署及远程检查。运行 `npm run setup:local` 会按版本清单核验内核和六套基准；只有维护者更新锁定清单才会改变新任务使用的内核或基准，历史报告保留当时的快照。

## 从 1.0.0 升级到 1.1.0

1. 等待进行中的检测与邮件任务结束，并备份自己的数据库、`.local/` 中的密钥与登录校验文件。
2. 更新到本项目 `v1.1.0`，保留自己的 `wrangler.jsonc` 账户、D1 和仓库配置。将新版源码、runner 与迁移文件推送到私有执行仓库默认分支。
3. 重新部署并验证：

   ```bash
   npm ci
   npm run setup:local
   npm run deploy -- --free-tier-checked
   npm run deploy:check -- --remote
   ```

新版包含 `0006_stop_runs.sql` 与 `0007_execution_queue.sql`，增加停止请求标记、执行队列字段及索引。部署脚本自动应用 D1 迁移；本地启动时自动应用 SQLite 迁移，不需要重建数据库。原模型配置、API Key、历史报告和定时计划继续保留。

暂停检测需要新版 Worker 与新版 Python runner 配合。先同步私有仓库默认分支，再部署网站；仅更新浏览器界面不足以启用暂停和自动队列。

## 升级到 1.2.0

1. 等待进行中的检测与邮件任务结束，备份数据库及 `.local/` 中的密钥、登录校验文件。
2. 更新项目源码到 `v1.2.0`，保留自己的 `wrangler.jsonc` 部署参数及本地数据，将新版源码推送到自己的私有执行仓库默认分支。
3. 运行以下命令，并在登录后的面板确认配置与历史报告可正常读取：

   ```bash
   npm ci
   npm run setup:local
   npm run deploy -- --free-tier-checked
   npm run deploy:check -- --remote
   ```

本版新增 `0008_configuration_deletion.sql`，为配置增加删除标记、索引及关联保护。部署脚本自动应用 D1 迁移，本地启动自动应用 SQLite 迁移；升级本身不会删除已有配置或历史报告。只有在面板确认删除时才清理选定配置、关联监测与组合成员，并清除相应凭据。

从 `1.0.0` 直接升级时，迁移工具会依次应用 `0006`、`0007`、`0008`，无需分别安装中间版本。本地到云端迁移也保留已经删除配置的历史报告关联。

报告摘要与完整报告接口需要新版界面和 Worker 配合更新。数据库继续保存完整样本，展开报告或导出时按需读取；无需改动固定内核和基准。

## 升级到 1.4.0

1. 等待任务结束并备份数据库、密钥及登录校验文件，更新源码到 `v1.4.0`，保留自己的部署参数。
2. 将新版界面、Worker、runner 和全部迁移推送到自己的私有执行仓库默认分支。
3. 运行 `npm ci`、`npm run setup:local`、`npm run deploy -- --free-tier-checked` 和 `npm run deploy:check -- --remote`，登录确认旧配置与报告可读取。

本版新增 `0009_target_clone_requests.sql`，用于记录复制操作的请求摘要和结果，使重试能够复用；不保存明文凭据。部署自动应用 D1 迁移，本地网页启动和 App 启动自动应用对应 SQLite 迁移。从更早版本升级会依次应用缺失迁移，已有配置与历史报告继续保留，不需要重建数据库。

按模型筛选、模型菜单和复制接口需要新版前端与 Worker 配合。复制继承监测计划和开关，保存本身不检测，已开启的计划随后运行。检测内核与固定基准不变。

Mac App 从 1.1.0 更新到 1.1.1：先在设置导出加密备份，正常退出，再使用新版 DMG 替换“应用程序”中的 Relay Desk；保持应用标识 `com.relaydesk.local`，首次启动自动迁移原本机数据库。Windows 尚无可安装的发行包，开发步骤见 [Windows 交接说明](windows-handoff.md)。
