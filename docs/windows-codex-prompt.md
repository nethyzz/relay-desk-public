# Windows 开发任务示例

把 Windows 交接 ZIP 完整解压后，打开包含 `package.json` 的目录。可把下面任务交给 Windows 上的开发助手：

```text
请基于这个 Relay Desk 1.1.1 工程制作 Windows 本地软件。

先阅读 docs/windows-handoff.md、docs/windows-handoff-validation.md、LICENSE 和 THIRD_PARTY_NOTICES.md；运行 node scripts/verify-handoff.mjs 校验交接包。公开源码发行版是 1.4.0，应用版本是 1.1.1。

复用本机已有 Node / MSVC / Rust / WebView2，按交接说明安装锁定依赖、执行共享测试和 Windows Rust 原生测试，再构建 NSIS 安装程序。包内已含固定检测器、六份基准和离线运行资源，不含用户配置或开发工具链。

保留按模型筛选、可搜索模型菜单、跨站点复制和全部 9 个迁移。保留 chen-006 及贡献者的原版 meow 4.5.4 内核、算法、固定基准、署名与非商业许可。

在隔离数据目录使用虚拟 Key 和模拟响应，验收安装启动、四种协议、存储重启、复制冲突与重试、预算 / 取消、加密备份、缓存清理、退出和卸载。复制继承监测开关，测试时关闭计划。真实收费检测或真实邮件必须另行取得明确授权。

修复实际发现的 Windows 问题并复验。交付最终 EXE、维护源码、SHA-256、安装 / 卸载说明和真实测试结果；尚未完成的项目如实列出。保留正式用户数据和主动导出文件，清理仅限本项目测试与构建缓存。不要把 Mac 或浏览器测试称为 Windows 原生验证。
```
