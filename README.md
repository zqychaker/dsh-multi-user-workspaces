# Multi-User Workspaces for DeepSeek Harness

多用户工作区 — DeepSeek Harness 插件项目

## English

A plugin project for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): let several humans share one `dsh web` deployment. Each user logs in as themselves, works in **private workspaces** only they can see, and collaborates in **shared (public) workspaces** visible to everyone.

The design is one Agent Note (status: proposed, pending implementation):

- [Multi-user login with private and shared workspaces](docs/2026-09-05-multi-user-private-shared-workspaces.md)

Summary of the four planned pieces (all plugin-level, no agent-loop changes):

1. **`dsh-identity-users`** — a durable user registry (`users` storage domain).
2. **`dsh-client-connection`** — identity-carrying browser sessions: cookie v2 with `userId`, per-user signing secrets, `/api/auth/login` and `/api/auth/logout` routes, actor attached to every Host RPC.
3. **`dsh-workspace`** — `ownerId` + `visibility: 'private' | 'shared'` on the workspace entity; actor-scoped listing; owner-gated mutations.
4. **GUI** — login screen (`ui-login`), user chip, private/shared badge in the workspace sidebar.

Known deferred risks (stated in the note): workspace visibility is not file privacy until fs/sandbox policy is per-user; credentials and settings stay per home; LAN deployments need the `trustedHosts` + TLS hardening.

## 中文

面向 [DeepSeek Harness](https://github.com/deepseek-harness) 的插件项目:多人共用一个 `dsh web` 部署。每个用户以本人身份登录,在**私有工作区**里工作(仅本人可见),并在所有人可见的**公有(共享)工作区**中协作。

设计为一份 Agent Note(状态:proposed,待实现):

- [多用户登录与私有/共享工作区](docs/2026-09-05-multi-user-private-shared-workspaces.zh.md)

四块计划内改动(全部在插件层,不动 agent-loop):

1. **`dsh-identity-users`** — 持久化用户注册表(`users` storage domain)。
2. **`dsh-client-connection`** — 携带身份的浏览器会话:cookie v2 带 `userId`、每用户签名密钥、`/api/auth/login` 与 `/api/auth/logout` 路由、每个 Host RPC 附带 actor。
3. **`dsh-workspace`** — 工作区实体增加 `ownerId` 与 `visibility: 'private' | 'shared'`;按 actor 过滤列表;变更操作按 owner 门禁。
4. **GUI** — 登录页(`ui-login`)、用户标识、工作区侧边栏私有/共享徽标。

已明确的推迟风险(见正文):在 fs/sandbox 按用户划定之前,工作区可见性不是文件隐私;凭据与设置保持 home 级;局域网部署需要 `trustedHosts` + TLS 加固。
