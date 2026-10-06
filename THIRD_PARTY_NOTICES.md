# 原作者与第三方声明 / Third-party notices

## Relay Desk 面板

面板设计、配置管理、任务调度、报告展示、预算、邮件、部署与本地应用适配由 [nethyzz](https://github.com/nethyzz) 维护。Relay Desk 集成原版检测器，不实现替代指纹评分算法。

Required Notice: Copyright 2026 nethyzz. Relay Desk: https://github.com/nethyzz/relay-desk-public

## 原检测内核：meow LLM Detector

**原作者：chen-006 及贡献者。** 当前仓库：[chen-006/meow-llm-detector](https://github.com/chen-006/meow-llm-detector)。本次发布固定原版内核 **4.5.4**，提交 `c56dc0691e53d3a567a7f675ed9a23d878294636`，内核归档与基准校验值见 [runner/upstream.json](runner/upstream.json)。

Relay Desk calls the unmodified meow LLM Detector Python engine by chen-006 and contributors. Detection, fingerprint scoring, and official benchmark authorship belong to their upstream authors. The dashboard adds an execution adapter and user interface without replacing upstream attribution.

上游要求保留的原文声明：

Required Notice: Copyright 2026 chen-006 and contributors. Original project: https://github.com/chen-006/gpt56_api_detector

内核采用 **PolyForm Noncommercial License 1.0.0**。许可证原文保留于 [LICENSES/meow-llm-detector.txt](LICENSES/meow-llm-detector.txt)，上游完整致谢原文保留于 [LICENSES/meow-upstream-NOTICES.md](LICENSES/meow-upstream-NOTICES.md)。该文件包含上游研究参考及实现参考；相关归属仍归其原作者。

项目主体采用同名非商业许可证，见 [LICENSE](LICENSE)。此声明不变更第三方作品的许可证；上游内核的商业授权须向上游权利人取得。

Git 仓库通过安装脚本下载固定提交到被忽略的 `.vendor/`，保留原 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 并验证 SHA-256。本地应用安装包及带离线资源的源码包包含原版引擎与基准，许可与原作者声明随发行版提供；捆绑不会扩大上游的非商业用途许可。

## 主要运行与开发依赖

| 依赖 | 许可证 |
| --- | --- |
| React、React DOM、Vite、Undici | MIT |
| TypeScript | Apache-2.0 |
| Lucide React | ISC |
| Wrangler | MIT OR Apache-2.0 |
| HTTPX | BSD-3-Clause |
| keyring | MIT |
| NumPy | BSD-3-Clause，附带组件另有声明 |

网页开发依赖通过 npm / pip 安装，各包及其传递依赖的完整许可与附带组件声明保留在各自发行包中。最终权威条款以锁定版本发行包内的许可证为准。

## 本地应用随包依赖

本地应用捆绑未修改的 [Pyodide 0.28.3](https://github.com/pyodide/pyodide/tree/0.28.3)（MPL-2.0），其源代码可从此版本链接获取；捆绑的 WASM 与 Python 标准库来自该版本的官方发行包。应用通过锁定清单校验 NumPy 2.2.5、HTTPX 0.28.1、SQLite 与 TLS 扩展。Python wheel 的许可证保留在原始 wheel 中。

| 依赖 | 许可原文 |
| --- | --- |
| Pyodide | [MPL-2.0](LICENSES/pyodide-MPL-2.0.txt) |
| Python 3.13 | [PSF 与历史许可](LICENSES/python-PSF.txt) |
| Pyodide 的 OpenSSL 1.1.1w 扩展 | [OpenSSL / SSLeay](LICENSES/openssl-1.1.1w.txt) |
| React / React DOM | [React MIT](LICENSES/react-MIT.txt)、[React DOM MIT](LICENSES/react-dom-MIT.txt) |
| Lucide | [ISC](LICENSES/lucide.txt) |
| Tauri 2 与官方插件 | [MIT](LICENSES/tauri-MIT.txt) 或 [Apache-2.0](LICENSES/tauri-APACHE-2.0.txt) |
| lettre | [MIT](LICENSES/lettre-MIT.txt) |

原生工程还使用 reqwest、tokio、serde、base64、getrandom、Apple 的 objc2-foundation 等依赖；版本由 [Cargo.lock](src-tauri/Cargo.lock) 固定，各自遵守原许可证。应用安装包与离线源码包的下载、安装要求和平台状态见 [应用指南](docs/cross-platform-apps.md)。本地运行资源不包含 Node.js；新增代码仅为界面、存储、调度与平台适配，检测评分和官方基准保持原版。

锁定 Rust 依赖的原文许可与版权声明集中保留于 [native-dependency-NOTICES.txt](LICENSES/native-dependency-NOTICES.txt)，来源、版本及校验值见 [依赖清单](LICENSES/native-dependency-manifest.json)。清单包含构建及其他平台依赖，不表示全部编入本次 Mac 应用。Release 另附 `THIRD_PARTY_LICENSES.zip`，保留项目许可、原检测器声明、Pyodide / Python / OpenSSL、UI 和原生依赖的许可文本，作为安装包的随附材料。
