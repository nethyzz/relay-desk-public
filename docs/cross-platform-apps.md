# Relay Desk 本地应用：安装、备份与清理

本地应用版本 1.1.1；对应公开源码发行版 v1.4.0，发布日期 2026-10-07。两者分别编号。

软件从 [GitHub Release](https://github.com/nethyzz/relay-desk-public/releases/tag/v1.4.0) 下载。Mac 推荐选择 `Relay-Desk-1.1.1-macos-arm64.dmg`。源码仓库提供共享工程，Release 还提供带固定离线运行资源的源码 ZIP。

## 运行方式与当前交付

这版应用在设备上运行，**不需要云端后台**。React 界面、固定版本的原 Python 检测引擎和 SQLite 随安装包提供。启动时不下载检测引擎，不启动本地网页服务器，不安装常驻服务或开机启动项。检测直接连接用户配置的模型 API；查看已经保存的站点、设置和报告可以离线进行。

各设备的数据相互独立，可以在“设置 → 本机数据与备份”导出密码加密的备份，再在另一台设备恢复。恢复会替换目标设备的数据、停止任务并关闭监测计划，之后可手动重新开启。原网页项目 `.local/` 的数据不会自动迁移到 App，也不会被 App 的清理工具删除。

| 平台 | 当前状态 | 安装要求 |
| --- | --- | --- |
| macOS | 已发布 Apple Silicon 1.1.1 DMG，安装包完整性与严格签名校验通过 | Apple Silicon Mac，macOS 13.3 或更新版本；个人构建，尚未做 Developer ID 签名和公证 |
| Windows | 共享应用源码、NSIS 安装和卸载配置已加入；尚未生成或验证 `.exe` | 在 Windows 上安装构建依赖后生成安装程序；运行使用系统 WebView2 |
| Android | 共享应用源码和禁止自动备份、设备迁移的规则已加入；尚未生成或验证 APK | 需要 Android SDK、NDK 和 Gradle；运行设备需较新的 Android System WebView |
| iPhone / iPad | 共享应用源码、iOS 16.4 最低版本和私有数据备份排除逻辑已加入；尚未生成或签名 `.ipa` | 完整 Xcode、Apple 账号和签名；需要 iOS / iPadOS 16.4 或更新版本 |

移动端和 Windows 尚未在对应设备验证，不能把手机尺寸的浏览器预览当成真机测试。Pyodide 官方推荐 Safari 16.4、Chrome 112 或以上版本；本项目据此设置 Apple 系统最低版本，Android 应更新系统 WebView。[Pyodide 官方兼容性](https://pyodide.org/en/0.28.3/usage/index.html#supported-browsers)

## Mac 安装与使用

1. 从 Release 下载并打开 `Relay-Desk-1.1.1-macos-arm64.dmg`，将 Relay Desk 拖入“应用程序”。
2. 启动 Relay Desk，在“站点与模型”添加 HTTPS 地址和自己的 Key，再添加检测模型。
3. 设置页可以调整预算和邮件通知、导出加密备份、清理界面缓存或清空本机数据。

最终使用者无需安装 Python、Node、Rust 或这些开发 SDK。当前包使用本地 ad-hoc 签名，没有 Developer ID 签名和 Apple 公证；若复制到其他 Mac 后系统要求批准，应由使用者在系统安全设置中核实并操作。此包只支持 Apple Silicon，Intel Mac 需要在对应目标上另行构建。[Tauri 官方签名说明](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)

建议从 DMG 安装。文稿目录的系统同步服务会给散装 `.app` 添加 Finder 元数据；本次已对 DMG 完整性和挂载后的应用完成严格签名校验。

检测期间会占用运行内存；正常退出会停止检测、保存进度并结束应用进程。强制退出、设备关机或系统杀进程后，下次启动会把中断任务结束，保留已经保存的部分证据。无法确认的请求按预留上限保守计入预算，避免漏记已消耗的请求。

## 从旧版更新与新增功能

更新前在设置导出加密备份，正常退出，再使用 1.1.1 DMG 替换“应用程序”中的旧版本。应用标识与正式数据目录不变；启动时自动应用第 9 个迁移，保留原配置和历史报告。

1.1.1 新增按检测模型筛选、可搜索的模型菜单，以及跨站点、跨分组复制模型配置。复制沿用来源 URL / Key、协议、档位与监测计划；保存不立即检测，继承的已启用监测之后会运行。详细操作见 [使用指南](USAGE.md#跨站点复制模型配置)。

## Windows 开发交接

Release 提供 `Relay-Desk-1.1.1-Windows-development.zip`，包含共享工程、固定检测器与六份基准、离线运行资源、依赖锁、许可证和逐文件 SHA-256 清单。它是开发源码包，尚未包含 Windows EXE。

解压到工程根目录后先运行 `node scripts/verify-handoff.mjs`。构建步骤见 [Windows 开发交接](windows-handoff.md)，可复制的开发任务说明见 [任务示例](windows-codex-prompt.md)，验证范围见 [交接验证记录](windows-handoff-validation.md)。开发依赖仍需另行准备；运行资源离线提供不代表整套开发工具链均可离线安装。

## iPhone 做出来后如何安装

这里说的是原生应用，不是给网页添加一个主屏幕图标。原生版本的检测引擎和数据库在手机内运行。iPhone 必须使用签名构建，不能直接安装未签名 `.ipa`。

### 免费自用测试：Xcode

适合先装到自己的 iPhone。免费 Apple 账号无需购买 Developer Program，但个人测试描述文件有效期为 **7 天**，到期后需要重新构建安装。[Apple 免费账号限制](https://developer.apple.com/help/account/basics/about-your-developer-account/)

1. 在 Mac 安装完整 Xcode，并首次打开完成所需组件安装。Command Line Tools 不能替代完整 Xcode。另需 Tauri 的 Rust iOS 目标和 XcodeGen；具体要求见 [Tauri 官方环境说明](https://v2.tauri.app/start/prerequisites/#ios)。
2. Xcode 的 Settings → Accounts 登录自己的 Apple 账号。账号与签名凭据由使用者在 Xcode 管理，不写入项目、备份或安装包。
3. 在项目根目录运行 `npm run app:ios -- init`，生成 Apple 工程；再运行 `npm run app:ios -- build --open`，保持构建进程运行并在 Xcode 设置签名。生成的工程在 `src-tauri/gen/apple/`。
4. 在 Signing & Capabilities 选择 Personal Team，开启自动签名；若 Bundle ID 已被占用，先在 `src-tauri/tauri.conf.json` 修改为自己的唯一标识，再重新生成工程。改标识会改变应用专属数据目录与卸载规则，需同步调整。
5. 连接并信任 iPhone，在 Xcode 选择这台手机，按系统提示启用 Developer Mode，然后 Build / Run 安装。Developer Mode 涉及设备设置，应由手机使用者完成。[Apple 开发者模式说明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)

为了安装的是带完整本地资源的构建，应使用上述 `build` 路线；`dev` 路线可能依赖开发用的 Mac 前端服务器，不是最终交付包。

### 方便分发测试：TestFlight

需要 Apple Developer Program 会员、App Store Connect 应用记录和上传签名构建。使用者在 iPhone 安装 TestFlight，通过邀请或链接安装；每个构建最多可用 **90 天**，外部测试可能需要 Apple 审核。到期前上传新构建即可继续测试。[Apple TestFlight 流程](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

Apple 官方会员价格为每年 99 美元，当地金额以注册页面为准；测试者不需要自己购买开发者会员。[Apple 会员说明](https://developer.apple.com/programs/)

也可用付费账号注册指定设备后进行 Ad Hoc 分发，或通过审核后在 App Store 正式分发。Ad Hoc 的设备必须包含在描述文件里，可通过 Xcode 或 Apple Configurator 安装。[Apple 指定设备分发](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)

当前发行版没有可直接安装的 iPhone 包；共享工程需由使用者在完整 Xcode 与签名环境中构建。平台状态以本页表格为准。

## 手机运行与后台限制

手机界面保留底部导航，并增加安全区域、较大触摸区域、单列设置与备份操作。电脑使用侧栏和宽布局，功能与网页端保持一致。

**手机检测请保持应用在前台。** 本版进入后台会请求停止当前检测，暂停启动新任务；回到前台后恢复调度。没有实现 iPhone 定时后台执行或 Android 前台常驻服务。自动监测需要应用打开，不能保证锁屏、睡眠或退出后仍按时检测。Apple 的后台任务最早开始时间也不保证在指定时间启动。[Apple 后台调度说明](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate)

电脑退出应用也会停止检测；睡眠期间不会保证监测时间准确。不同设备没有自动同步，跨设备迁移使用加密备份。

## 数据、缓存和卸载

本机 API Key 与邮箱授权码使用随机主密钥加密保存。主密钥与数据库位于同一设备的应用私有目录，依赖操作系统的账号和文件保护，不是抵抗本机恶意软件的独立保险箱。Unix 目录权限为 0700，数据库和密钥文件为 0600；恢复采用可重放记录，避免数据库与解密密钥错配。

备份在导出前使用 PBKDF2-SHA256 和 AES-GCM 再加密，密码至少 10 个字符；密码不会随文件保存，遗忘后无法恢复。保存备份属于主动导出文件，不会随卸载自动删除。

| 操作 | 删除内容 | 保留内容 |
| --- | --- | --- |
| 设置 → 清理缓存 | 专属 WebView 的浏览数据、界面偏好 | SQLite 数据库、站点、Key、报告和邮件设置 |
| 设置 → 清空本机数据 | 停止任务，删除数据库、解密密钥、恢复记录及 WebView 数据 | 用户导出的文件、原网页端和其他项目数据 |
| 构建缓存清理脚本 | 本项目 `.app-build/` 中指定的工具链、下载和临时构建目录；可选 `native-dist/` | `release/`、源码、原 `.local/`、`output/`、`.venv/`、`.vendor/`、`node_modules/` |

### macOS

专属目录包括：

- `~/Library/Application Support/com.relaydesk.local`：数据库、密钥、归属标记、运行锁。
- `~/Library/WebKit/com.relaydesk.local`、`~/Library/Caches/com.relaydesk.local`：系统 WebView 专属缓存。
- `~/Library/Preferences/com.relaydesk.local.plist`、`~/Library/Saved Application State/com.relaydesk.local.savedState`：系统为本应用管理的偏好和窗口状态（存在时）。

卸载前先导出需要保留的备份、退出应用。Release 提供的 `uninstall-macos.command` 与源码中的 `scripts/uninstall-macos.command` 默认只列出范围；进入脚本所在目录后执行：

```bash
chmod +x uninstall-macos.command            # 下载后的脚本需有执行权限
./uninstall-macos.command                         # 仅预览
./uninstall-macos.command --apply                 # 删除专属数据及 /Applications/Relay Desk.app
./uninstall-macos.command --apply --keep-app      # 仅清理本机数据
./uninstall-macos.command --apply --app '/其他位置/Relay Desk.app'
```

脚本校验应用标识和数据归属标记，拒绝符号链接与未登记目录；应用运行时拒绝执行删除。它不需要管理员权限，不会删除共享 WebKit 或其他应用的数据。拖 App 到废纸篓本身不会清除上述专属数据，使用辅助脚本可一并处理。

### Windows

在“设置 → 应用 → 已安装的应用”卸载 Relay Desk。NSIS 卸载钩子会询问是否删除该应用在 `%APPDATA%` 与 `%LOCALAPPDATA%` 下的专属数据。不会卸载其他软件依赖的 Microsoft WebView2。当前这部分尚未在 Windows 安装、卸载验证。

### iPhone

若需要清除配置，先在 App 设置中清空数据，再在系统选择 **“删除 App”**。“卸载 App”会保留文稿与数据。应用的数据库目录设置为排除设备自动备份；这不删除使用者过去的设备备份、Files 中导出的文件或其他应用的数据。[Apple 储存空间说明](https://support.apple.com/zh-cn/108429)

### Android

系统卸载会清理应用沙盒。生成工程时设置 `allowBackup=false`，并为云端备份及设备迁移排除应用数据；不同厂商系统仍需真机验收。下载目录或用户挑选位置保存的备份属于用户文件，需另行管理。[Android 官方备份规则](https://developer.android.com/identity/data/autobackup)

应用只能核验自己可控范围的清理；操作系统诊断记录、外部备份和用户导出文件需要分别管理。

## 构建和清理

开发需要 Node 22+、已准备的原检测器 `.vendor/`、Rust 1.89+ 和各平台工具。首次获取原检测器可运行 `npm run upstream:install`；安装方法见本仓库 README。Git 克隆与 GitHub 自动生成的源码 ZIP 不含离线运行资源，`app:verify` / `app:build` 首次会按锁定清单下载；专门提供的 `native-source.zip` 随附这些资源。Windows 还需 MSVC C++ 构建工具和 WebView2；手机需各自 SDK。[Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/)

```bash
npm ci
npm run upstream:install
npm run app:doctor
npm run app:verify
npm run app:build

npm run app:android -- init
npm run app:android -- build --debug --apk --target aarch64

npm run app:ios -- init
npm run app:ios -- build --open
```

构建脚本将 Cargo、Gradle、Android 用户配置与 npm 下载缓存隔离到项目的 `.app-build/`。Rust 与目标平台 SDK 需要使用者自行准备；脚本不会自动安装系统开发工具。手机工程输出位于被忽略的 `src-tauri/gen/`；需要重新构建时可重新初始化，正式签名材料应单独安全保存。

安装包收集到 `release/`，对应 `build-*.json` 记录文件大小与 SHA-256。确认无需继续构建并退出测试应用、关闭预览服务器后，可清理新增中间文件：

```bash
npm run app:clean                         # 列出目录与大小
npm run app:clean -- --all --apply         # 按清单清理
```

这不会清理原项目开发环境。清理专用 Rust 工具链和 Android SDK 后，再次构建需要重新准备工具；已生成安装包仍可独立运行。

## 验证范围

- 133 项 TypeScript 测试、36 项 Python 测试通过。
- 18 组原版 Python / Pyodide 检测结果对照和 4 组原生协议传输、取消对照通过；未调用真实模型 API。
- 9 项原生 Rust 文件保护、运行锁、恢复记录、Apple 备份排除和导出临时文件清理测试通过。
- 既有 Mac 原生流程验证：启动、设置与模型保存、重启保留、清理缓存保留数据、密码加密备份导出与正常退出通过；虚拟测试 Key 已验证加密与解密，备份文件已解密检查 SQLite 文件头和密钥长度。
- Mac 1.1.1 的 DMG 内应用通过 `codesign --verify --deep --strict`，安装包大小和 SHA-256 已核验。
- Mac 卸载清理脚本此前已在空白测试数据上执行；专属数据库、WebView 缓存和偏好文件已删除，App 安装包与原项目数据保留。
- 窄屏浏览器预览通过；Android、Windows、iPhone 的安装与真机完整检测尚未完成。没有发送真实邮件，没有发布到应用商店。

固定检测器与基准保持原版，仍受上游 PolyForm Noncommercial 1.0.0 许可约束。此交付用于个人非商业使用，第三方署名与许可随包提供。
