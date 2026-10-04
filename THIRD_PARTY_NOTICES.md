# 原作者与第三方声明 / Third-party notices

## Relay Desk 面板

面板设计、配置管理、任务调度、报告展示、预算、邮件与部署适配由 [nethyzz](https://github.com/nethyzz) 维护。Relay Desk 集成原版检测器，不实现替代指纹评分算法。

Required Notice: Copyright 2026 nethyzz. Relay Desk: https://github.com/nethyzz/relay-desk-public

## 原检测内核：meow LLM Detector

**原作者：chen-006 及贡献者。** 当前仓库：[chen-006/meow-llm-detector](https://github.com/chen-006/meow-llm-detector)。本次发布固定原版内核 **4.5.4**，提交 `c56dc0691e53d3a567a7f675ed9a23d878294636`，内核归档与基准校验值见 [runner/upstream.json](runner/upstream.json)。

Relay Desk calls the unmodified meow LLM Detector Python engine by chen-006 and contributors. Detection, fingerprint scoring, and official benchmark authorship belong to their upstream authors. The dashboard adds an execution adapter and user interface without replacing upstream attribution.

上游要求保留的原文声明：

Required Notice: Copyright 2026 chen-006 and contributors. Original project: https://github.com/chen-006/gpt56_api_detector

内核采用 **PolyForm Noncommercial License 1.0.0**。许可证原文保留于 [LICENSES/meow-llm-detector.txt](LICENSES/meow-llm-detector.txt)，上游完整致谢原文保留于 [LICENSES/meow-upstream-NOTICES.md](LICENSES/meow-upstream-NOTICES.md)。该文件包含上游研究参考及实现参考；相关归属仍归其原作者。

项目主体采用同名非商业许可证，见 [LICENSE](LICENSE)。此声明不变更第三方作品的许可证；上游内核的商业授权须向上游权利人取得。

源码与基准不提交到本仓库：安装脚本下载固定提交到被 Git 忽略的 `.vendor/`，保留原 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 并验证 SHA-256。

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

依赖通过 npm / pip 安装，各包及其传递依赖的完整许可与附带组件声明保留在各自发行包中。本仓库不捆绑 Python、Node.js 或其依赖二进制。最终权威条款以锁定版本发行包内的许可证为准。
