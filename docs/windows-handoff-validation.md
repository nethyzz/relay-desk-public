# Windows 交接包验证记录

验证日期 2026-10-07；公开源码版本 1.4.0，应用版本 1.1.1，固定 meow 内核 4.5.4。

## 共享源码与运行资源

在 macOS、Node 22.22.2 与 Python 3.12 环境验证：

- 133 项 TypeScript 行为测试、36 项 Python 适配 / 原内核对照测试通过。
- 18 组 CPython / Pyodide 检测结果、4 组原生传输 / 取消对照通过，SQLite 初始化与保存恢复通过。
- 类型检查、网页生产构建及应用前端构建通过。
- 离线运行资源锁定 Pyodide 0.28.3；六份基准按 `runner/upstream.json` 的 SHA-256 核验，`engine.json` 包含全部 9 个迁移。
- 交接 ZIP 的 CRC、逐文件大小与 SHA-256 验证通过，包含本项目、原检测器及依赖许可。

所有对照使用合成响应，没有调用真实模型 API 或发送真实邮件。交接清单记录打包时快照；修改源码后原清单不再匹配。

## Mac 软件与平台边界

Mac 1.1.1 DMG 已完成镜像完整性校验、挂载后 `codesign --verify --deep --strict` 和版本核对。软件面向 Apple Silicon、macOS 13.3+，采用 ad-hoc 签名，尚未完成 Apple 公证。

GitHub CI 对本次公开提交执行共享测试和 macOS Rust 原生测试，结果可在 [Actions](https://github.com/nethyzz/relay-desk-public/actions/workflows/ci.yml) 查看。

**Windows 交接包仍为开发源码。** 未在 Windows MSVC / WebView2 环境编译、安装、运行或卸载；没有可直接安装的 EXE。Android / iPhone 也尚未完成安装包和真机验证。开发步骤与验收要求见 [Windows 开发交接](windows-handoff.md)。
