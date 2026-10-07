# Relay Desk Windows 开发交接

公开源码版本 1.4.0，应用版本 1.1.1，交接日期 2026-10-07。应用标识 `com.relaydesk.local`，Rust 包名 `relay-desk-local`。

本包提供 Windows 开发工程与固定离线运行资源，**尚无 Windows EXE**。Mac 1.1.1 已单独发布；Mac 测试不能替代 Windows 编译、安装、WebView2 运行和卸载验收。精确快照时间及逐文件校验值见 `HANDOFF-MANIFEST.json`。

## 架构与包内内容

React 界面 → 模块 Worker → Pyodide 中的 SQLite / 原版 Python 内核 → Tauri IPC → 原生 HTTPS、SMTP 和私有文件。最终软件无需安装 Python、Node 或 Rust，不启动本地网页服务器，也不强制部署云端后台。真实检测需要连接自己的模型 API。

| 路径 | 内容 |
| --- | --- |
| `src/`、`worker/` | 共享界面与业务路由，含模型筛选、搜索和配置复制 |
| `apps/local/` | SQLite、Python / WASM 传输、调度与加密备份适配 |
| `src-tauri/` | 原生文件、网络、退出处理、平台配置与 Windows 卸载钩子 |
| `migrations/` | 全部 9 个数据库迁移 |
| `.vendor/`、`runner/upstream.json` | 原版 meow 4.5.4、六份固定基准及版本 / SHA-256 |
| `.app-build/native-public/` | WASM、Python 标准库及锁定 wheel、检测资源、图标与许可 |
| `package-lock.json`、`src-tauri/Cargo.lock` | 固定 JS / Rust 依赖 |
| `tests/`、`scripts/` | 测试、运行资源校验、构建、收集和清理工具 |
| `LICENSE`、`LICENSES/`、`THIRD_PARTY_NOTICES.md` | 本项目及第三方许可、原作者声明 |
| `HANDOFF-MANIFEST.json` | 文件大小与 SHA-256，开发前核验 |

检测与评分由 chen-006 及贡献者的未修改原版 [meow LLM Detector](https://github.com/chen-006/meow-llm-detector) 4.5.4 提供。面板与集成由 [nethyzz](https://github.com/nethyzz) 维护。保留原作者署名、固定基准与 PolyForm Noncommercial 1.0.0 非商业用途限制。

包内不含用户数据库、API Key、邮箱授权码、签名材料、私人部署参数、SDK 或依赖工具链。离线运行资源齐全；`npm ci`、首次 Cargo / NSIS 工具获取以及 WebView2 安装仍可能需要网络。

## Windows 构建环境

解压到短路径，例如 `C:\Dev\Relay-Desk-Windows`，打开其中真正包含 `package.json` 的工程根目录。不要直接在 ZIP 内运行。

准备 Node.js 22.18+、Rust 1.89+ 的 MSVC 工具链、Microsoft C++ Build Tools（桌面 C++、MSVC 与 Windows SDK）、Evergreen WebView2。开发对照测试推荐 Python 3.12。普通 Intel / AMD 电脑使用 x64 工具链；ARM64 产物需按实际目标另行验证。[Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/#windows)

在原生 Windows PowerShell 中执行：

```powershell
node scripts/verify-handoff.mjs

$env:CARGO_HOME = Join-Path $PWD '.app-build\cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $PWD '.app-build\target'
npm.cmd ci --cache .app-build/npm-cache
npm.cmd run app:doctor

py -3.12 -m venv .venv
$env:RELAY_PYTHON = Join-Path $PWD '.venv\Scripts\python.exe'
& $env:RELAY_PYTHON -m pip install --cache-dir .app-build/pip-cache -r runner/requirements.txt

npm.cmd test
npm.cmd run test:python
npm.cmd run app:verify
node scripts/app.mjs web
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm.cmd run app:build
```

`verify-handoff` 用于完整解压的交接包；普通 Git 克隆没有交接清单。源码修改后旧清单不再匹配，应重新打包。Git 克隆需先运行 `npm run upstream:install`；交接 ZIP 已随附原检测器与基准。

`app:doctor` 不代表 SDK 和 WebView2 已验收，仍需实际编译并启动。若当前 Windows Node 无法展开 `tests/*.test.ts`，可在 PowerShell 枚举后传给测试器：

```powershell
$relayTests = Get-ChildItem tests -Filter '*.test.ts' | ForEach-Object FullName
node --experimental-strip-types --test $relayTests
```

Windows 平台配置为 `src-tauri/tauri.windows.conf.json`，使用当前用户 NSIS 安装。默认安装产物来自 `.app-build/target/release/bundle/nsis/`，构建脚本收集到 `release/`，`build-win32.json` 记录大小及 SHA-256。显式指定 `--target` 时输出多一层目标目录，需要核实收集路径。命令退出成功不等同于已交付可安装 EXE。

## 原生验收

使用隔离的虚拟数据。启动测试 App 前在该终端设置：

```powershell
$env:RELAY_DESK_DATA_DIR = Join-Path $PWD '.app-build\qa\windows-data'
```

测试结束退出应用并清除该终端变量，再启动正式软件。开始菜单启动的进程可能不继承终端环境，需核实设置页中的实际数据目录。

1. 构建并安装 EXE，从开始菜单启动；检查模块 Worker、WASM、SQLite、SSL 与离线资源加载，断网冷启动可查看已保存设置和报告。
2. 使用虚拟站点与 Key 保存模型、分组、组合及设置；重启确认保留，检查凭据没有以明文写入数据库或日志。
3. 验证按模型筛选、菜单搜索、跨站点复制、旧数据从 8 个迁移升到 9 个、重复提交复用与并发冲突回滚。复制继承监测计划和开关，验收来源计划应关闭，避免自动调用收费 API。
4. 用模拟响应检查四种协议、任务进度、预算、队列、取消与退出。真实收费检测和邮件测试另行按使用者明确授权的范围执行。
5. 检查备份导出 / 恢复、错误密码、恢复中断、缓存清理和清空数据；恢复替换接收端数据、停止任务并关闭监测。
6. 核实 Windows 数据目录、文件锁、原子替换、WebView2 缓存、系统代理 / TLS，以及 NSIS 保留数据与删除数据两条卸载路径；不要删除共享 WebView2 或其他项目目录。
7. 检查窄窗口、中文字体、125% / 150% / 200% 缩放、弹窗和键盘操作。正常退出后不保留本应用启动的测试服务器、常驻服务或开机任务。

macOS 的代理适配和 Unix 文件权限不能直接作为 Windows 验证结论。已有本地请求 Origin 修复与来源校验均需保留，不能通过关闭校验绕过失败。自动监测要求应用打开，退出或睡眠后不保证执行。

最终交付 EXE、维护源码、SHA-256、Windows 安装 / 卸载说明与实际验证结果。当前共享代码测试记录见 [交接验证](windows-handoff-validation.md)。

## 配置迁移与清理

在原设备“设置 → 本机数据与备份”导出密码加密备份，单独带到 Windows，完成的正式 App 内恢复。恢复前备份接收端需要保留的数据；密码另行输入，不写入工程或安装包。不要仅拷贝 SQLite 而遗漏解密密钥。

构建清理先运行 `npm.cmd run app:clean` 查看范围，确认后用 `npm.cmd run app:clean -- --all --apply` 清理项目专属构建缓存；保留源码、最终 `release/`、正式用户数据和主动导出文件。安装、数据目录和卸载说明见 [应用指南](cross-platform-apps.md)。

Required Notice: Copyright 2026 chen-006 and contributors. Original project: https://github.com/chen-006/gpt56_api_detector
