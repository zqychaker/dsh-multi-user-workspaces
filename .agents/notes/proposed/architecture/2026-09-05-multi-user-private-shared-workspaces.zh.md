# Agent Note: 多用户登录与私有/共享工作区

Status: proposed

[English](2026-09-05-multi-user-private-shared-workspaces.md) | 中文

## 问题

一个 Harness home(`$DSH_HOME`)只有一个 owner。浏览器认证([`dsh-client-connection`](../../../../packages/client/connection/README.zh.md))每次启动铸造一个进程 launch token 和一个 owner 级 cookie 签名密钥(`client-connection/browser-session` grant 记录);持有该 token 或 cookie 的浏览器全部以同一个 owner 身份通过认证——请求检查是一个布尔值(`BrowserAuth.isAuthenticated`),只建立信任、从不建立身份。下游一切也都是 owner 全局的:工作区注册表([`dsh-workspace`](../../../../packages/workspace/README.zh.md),`ctx.workspaceRegistry`)的 `Workspace` 实体没有 owner 字段、没有可见性属性;session 控制器的 list/search 能看到 home 内所有持久化会话;凭据/设置每个 home 只有一份文档。

需求:多人共用一个 `dsh web` 部署。每个人以本人身份登录,在只有自己能看到的私有工作区里工作,同时在所有人可见的公有(共享)工作区协作。

## 方案

四块相互配合的改动,全部在插件层(不动 agent-loop):

### 1. `dsh-identity-users`:持久化用户注册表

`identity/` 组下新包,`ctx.users` 服务,落在新的 `users` storage-domain unit(`users` 表):`id`(branded `UserId`)、`username`(唯一、大小写不敏感)、`displayName`、每用户加盐密码哈希、`createdAt`,以及 `isOwner` 位——第一个创建的用户是 owner(owner 保留现有 owner 级记录的含义)。操作:`create`、`verify(username, secret)`、`list`、`get`。按 pre-release stance:domain unit 版本从 `1` 起,后端拒绝旧格式;没有匿名回退——挂载了 users 插件的 home 不存在未认证 actor。

### 2. `dsh-client-connection`:携带身份的浏览器会话

- Cookie payload `v2` 增加 `userId`。签名密钥改为每用户一条凭据记录,键为 `client-connection/browser-session/<username>`;删除用户即吊销其全部 cookie。owner 的记录保留在现有 owner 级键上。
- Host carrier 上两条新的 exact Fetch 路由:`POST /api/auth/login`(`{ username, password }` → 用户 cookie + 跳转)与 `POST /api/auth/logout`(清除 cookie)。登录是 carrier 路由,不是 session-bound 流程。
- `BrowserAuth.isAuthenticated` 返回解码出的 `userId`(或 `undefined`);`rpc-host.ts` 中唯一的检查点变为"未认证 → 401,否则附带 actor",于是每个 Host RPC 派发与 `$events` 流都携带当前操作用户。信任栅栏(`api-request-trust.ts`)不变:Host/Origin 检查仍只管可达性。

### 3. `dsh-workspace`:实体上的所有权与可见性

`Workspace` 增加 `ownerId: UserId` 与 `visibility: 'private' | 'shared'`(`create(actor, path, { title?, visibility? })`;默认 `private`)。`list(actor)` 按注册表顺序返回该 actor 的私有工作区加所有共享工作区;`get`/`resolveByPath` 保持不过滤,把强制点留在 controller(做决定的操作负责执行)。变更规则:私有工作区仅 owner 可改名/删除;共享工作区由创建者管理、所有用户可用。会话成员语义(cwd 校验的 attach)不变。`workspaces` 表升到版本 `2`,新增两列。

### 4. `dsh-api-session-controller` + GUI:按 actor 限定可见性

list/search 限定为 actor 可访问的工作区(其私有工作区、全部共享工作区、以及其本人的 Ungrouped 会话);共享工作区内的会话对该工作区的每个用户可见。GUI 增加登录页(`ui-login`,index 401 时显示)、用户标识,以及工作区侧边栏的私有/共享徽标(`ui-workspace`)。

## 备选方案

- **反向代理后每用户一个 home。** 零代码,但 home 之间完全隔离——没有共享工作区——且登录被外包给代理。
- **复用 authorization seam 做登录。** [`dsh-credentials/authorization`](../../../../packages/credentials/authorization/README.zh.md) 的 sign-in 流程是 session-bound 的(尝试存活于进程内,而登录时会话尚不存在)。它仍适合提供方登录;用户登录改用 carrier 路由。
- **多租户存储后端**(`storage.backend.<user>`)。介质层切分在此买不到任何好处:可见性本就是工作区行上的数据级属性,且会话日志必须保持单一存储。

## 验收标准

1. 两个浏览器以两个不同用户同时登录;各自只能看到自己的私有工作区与会话,以及全部共享工作区。
2. 用户 A 创建的共享工作区出现在用户 B 的列表里;B 可在其中发起会话;B 不能改名或删除它,A 可以。
3. 发给用户 A 的 cookie 列不出用户 B 的私有工作区;已删除用户的 cookie 得到 401。
4. 登录前 UI 是登录页而不是 GUI 外壳;登出后回到登录页。
5. 旧格式的 `users`/`workspaces` 磁盘数据按版本不匹配响亮失败(pre-release stance)。

## 风险

- **工作区隐私不是文件隐私。** 在 fs/sandbox 策略按用户划定之前,用户 A 的 agent 可以借 bash `cat` 用户 B 私有工作区路径下的文件。本 note 推迟每用户 fs 划定并明示;可见性模型是第一步,不是硬边界。
- **凭据与设置保持 home 级。** 所有用户共享 home 的 API key 与配置文档;每用户凭据划定是后续工作。
- **真正的多用户部署需要配套加固。** 出厂服务器是 loopback HTTP、cookie 未标 `Secure`,且 `dsh web --host 0.0.0.0` 目前不支持;局域网共享部署需要与本 note 一并敲定 `trustedHosts` + TLS 方案。
