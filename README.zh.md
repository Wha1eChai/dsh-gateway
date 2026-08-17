# dsh-gateway

[English](README.md) | 中文

围绕 CLIProxyAPI 做的、长在 DSH 里的 AI 网关和运维 App。

`dsh-gateway` 是一个普通的树外 DeepSeek Harness Bundle。它把现有的 DSH `llm-pi-ai` 供应商接到托管或外部的 CLIProxyAPI，凭据和行政管理留在 Host 一侧，并通过 [dsh-webpage](https://github.com/dshapps/dsh-webpage) 贡献一个原生 App。

## v0.1 目标

- 初始化并监督一份钉死、按平台区分的 CLIProxyAPI 二进制；
- 不装 runtime 包也能接已有的外部 CLIProxyAPI；
- 发现模型，并显式把具备视觉能力的模型纳入图像输入；
- 支持 Codex device login；只有 DSH 提供可信的、由服务端推导的 request-origin 缝时，才启用 localhost callback login；
- 提供走完整 `ctx.llm` 路径的 DSH 原生 Playground；
- 提供请求、token、费用、延迟、账户健康和配额分析；
- 用一个普通 DSH Pack 装完整验。

浏览器永远收不到代理密钥、管理密钥、OAuth token、auth 文件或 Management API 原文。Playground 内容只走请求客户端的类型化 `gateway.probe` 请求/响应；提示词、附件内容和模型输出不会写入运维 remotes、分析、日志或持久存储。托管模式只绑 loopback。首发继承 DSH `0.1.0-rc.6` 的可信单用户 Web 边界，不声称多用户 ACL 安全。

## 架构边界

- 安装、信任、依赖和生命周期单位仍然只有 DSH Plugin。
- 模型传输仍然只有 `llm-pi-ai`；本项目不注册、也不静默回退到自定义 LLM 适配器。兼容性门失败就停这一阶段，需要新的公开架构决定。
- 供应商登录、账户选择、刷新和故障转移由 CLIProxyAPI 负责。
- Gateway 只向 App 暴露生成的、允许列表里的 Typert remotes。
- runtime 和分析是可独立安装的伴生，不是嵌进 dsh-webpage 的功能。旗舰一装即用的 Pack 把两者都列为必需依赖；手工的外部模式组合可以省略其中任一。
- 预览阶段不往 npm 发任何包。

原生 App 的地址是 `/apps/dshapps.gateway`。总览页承担托管模式下的首次设置和仪表盘；其余子路由是账户、模型、请求、Playground 和设置。

## 预览安装

`v0.1.0` GitHub prerelease 可用之后，把这个普通 Pack 装进单独的 DSH profile：

```text
dsh plugin --profile gateway-preview add https://github.com/dshapps/dsh-gateway/releases/download/v0.1.0/dshapps-dsh-gateway-pack-0.1.0.tgz --ignore-scripts --config.block-exotic-subdeps=false
dsh --profile gateway-preview web
```

DSH 会为 Plugin profile 打开 pnpm 的 `blockExoticSubdeps` 保护。上面这条带范围的选择加入是必需的，因为这个 Pack 把它固定的 GitHub Release tarball 当作 URL 子依赖。精确 URL 和 SHA-256 写在附带的 `release-manifest.json` 里；安装脚本不会跑。

首个预览只支持根路径部署，例如 `https://host/apps/dshapps.gateway`；反向代理子路径如 `/dsh/apps/...` 不支持。把 DSH Web 端点留在 loopback，或放在可信隧道后面，因为 v0.1 继承 DSH rc.6 的单用户信任模型。

## 冻结的兼容目标

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.6` |
| `@dshapps/webpage` | `0.2.0` |
| CLIProxyAPI | `7.2.131` |
| CPA-Manager-Plus 参考 | `1.12.0-rc.2` |
| Node.js | `^22.19.0 || >=24.0.0` |
| pnpm | `11.7.0` |

## 文档

- [架构](./docs/design/architecture.md)
- [安全模型](./docs/design/security.md)
- [分析数据模型](./docs/design/analytics-data-model.md)
- [包拓扑](./docs/design/package-topology.md)
- [依赖图](./docs/design/dependency-map.md)
- [v0.1 执行计划](./docs/plan/phase-0.1-gateway.md)
- [测试策略](./docs/testing.md)
- [Phase 1 证据](./docs/evidence/phase-1.md)
- [Phase 2A 证据](./docs/evidence/phase-2a.md)
- [Phase 2B 证据](./docs/evidence/phase-2b.md)
- [Phase 3 证据](./docs/evidence/phase-3.md)
- [Phase 4 证据](./docs/evidence/phase-4.md)
- [Phase 5 证据](./docs/evidence/phase-5.md)
- [Phase 6 证据](./docs/evidence/phase-6.md)
- [当前交接](./HANDOFF.md)

## 当前状态

Phase 0–6 已完成 / GO。官方 rc.6 的 `llm-pi-ai` 路径、托管/外部 runtime、供应商桥、device OAuth、可选且故障隔离的 SQLite 分析、原生六路由 App、打包 Browser、HMR、安全、真实 CPA、干净 checkout 和公开 URL 安装门都已通过。[v0.1.0 预览](https://github.com/dshapps/dsh-gateway/releases/tag/v0.1.0) 已公开；反馈记在[项目 Discussion](https://github.com/dshapps/dsh-gateway/discussions/1) 和 [DeepSeek Harness showcase](https://github.com/deepseek-ai/deepseek-harness/discussions/1480)。npm 发布仍不在范围内。

## v0.1 不做

联邦、多用户 ACL、CRDT 协作、账户轮换策略、自动冷却/重置动作、RESP usage 摄入、动态上游插件、上游面板自动更新、远程 callback OAuth，以及 npm 发布，都不在 v0.1 里。

使用 [MIT License](LICENSE)。
