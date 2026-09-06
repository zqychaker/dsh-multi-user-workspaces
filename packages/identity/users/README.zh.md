---
description: "面向多用户 DeepSeek Harness 部署的持久用户注册表（ctx.users）:大小写不敏感的用户名、scrypt 凭据与单一 owner 位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-identity-users

[English](README.md) | 中文

## 概述

`dsh-identity-users` 为宿主提供一份可登录人类的持久注册表:每个大小写不敏感的用户名一条记录,含加盐 scrypt 凭据、显示名,以及由第一个创建的用户持有的单一 owner 位。有了它,一个部署就能让多人共用同一个 `dsh web` home——每人验证自己的凭据,并由一个稳定的带品牌 id 标识,其他包(工作区归属、每用户会话 cookie)把自己的记录挂到该 id 上。此包只面向宿主侧:模型、工具与 agent loop 永远不会看到它,因此不会增加任何 token、提示词或请求上下文。它只需要一并挂载存储栈;没有配置项。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用本包为部署提供一份可供认证的用户名单。它是多用户 home 的身份基础:其他多用户功能把"谁在操作"解析为这些用户之一。

### 何时使用

当同一个 home 有多个人类登录、且他们的工作需要区分时(私有 vs 共享工作区、每用户 cookie、每用户远程机器)使用它。它对模型不可见,因此不增加 token 或请求开销。从不验证凭据的单一 owner home 可以完全省略它。

### 设置

本包没有自己的配置;它需要保存其记录的存储行。最小组合:

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-identity-users'
```

挂载这些行后,创建的用户会立即出现在列表中并在重启后保留。第一个创建的用户获得 owner 位;后续用户不会。

### 创建、验证与读取用户

从用户名和密码创建用户;用户名忽略大小写唯一,密码在存储前加盐并哈希。验证凭据以解析用户,按 id 或用户名读取单个用户,或按创建顺序列出所有用户:

```text
// Host consumer code, after the composition above is loaded:
const owner = await ctx.users.create({ username: 'Alice', password: 'correct-horse' })
owner.isOwner // true for the first user created
const who = await ctx.users.verify('alice', 'correct-horse')
ctx.users.list() // every user, creation order, without password hashes
```

命名了未知用户名或提供错误密码的 verify 都拒绝同一个 `users/bad-credentials` 错误,因此调用方无法区分这两种情况。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释该功能背后的设计决策,并指出实现它们的代码;可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计哲学

- **每个规范用户名一条记录。** 小写用户名是持久键,因此 `Alice` 与 `alice` 冲突;原始大小写被存储用于展示。
- **哈希永不离开记录。** `create`、`verify`、`get` 与 `list` 都投影到省略 `passwordHash` 的公共 `User`,因此列表读取方从不持有可验证的凭据。
- **单一 owner 位。** 恰好一个用户是 owner,在创建时若无用户则设置;该不变量在启动时重新检查,出现第二个 owner 会大声失败。
- **无时序旁路。** 对缺失用户名的 verify 在拒绝前仍会烧掉一次 scrypt 派生,因此"用户名不存在"与"密码错误"开销相同。

### API 行为

API 是一个小家族,由单一 owner(`ctx.users` 的 `UsersService`)拥有:`create` 与 `remove` 修改持久记录,`verify` 检查凭据,`get`/`list` 读取。逐方法契约在代码中——见 [src/index.ts](src/index.ts)。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口:`UsersService` 服务、scrypt 辅助函数、owner 位校验、操作串行化 |
| [`src/spec.ts`](src/spec.ts) | 域声明:记录 schema 与 `users` `defineDomain` spec(版本 1) |
| [`src/types.ts`](src/types.ts) | 公共 `User` 接口与 `UserId` 品牌 |

### 持久形态

注册表打开 `users` 域(版本 1):一张以小写用户名为键的 `users` 表。每条记录持有 `id`(带品牌 `UserId`)、`username`(原始大小写)、`displayName`、`passwordHash`(salt 与 scrypt 哈希的 base64)、`isOwner` 与 `createdAt`。适用预发布立场:后端拒绝以不同版本打戳的存储文件,因此版本 0 的单元在打开时大声失败。

### 生命周期

启动时,注册表打开域、重建其内存索引,并校验至多一个存储用户持有 owner 位。写操作(`create`、`remove`)在单一操作链上串行,使拥有 owner 位与键表的"检查后写"不会交错。

### 失败与恢复

记录写入失败的 create 不留下缓存条目也不改变 owner;remove 对未知 id 幂等。发现两个 owner 的启动、或以错误版本打戳的域,会拒绝整个插件,使损坏或过时的单元从不被当作有效注册表服务。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本包的视图不够时,阅读这些页面:

- [带私有与共享工作区的多用户登录](../../../.agents/notes/proposed/architecture/2026-09-05-multi-user-private-shared-workspaces.zh.md)——本注册表是其基础的该设计,以及为何登录是载体路由而非会话绑定流程。
- [identity 包组](../README.zh.md)——该组的包与本包的仓库位置。
- [domain 数据形态](../../storage/storage-domain/README.zh.md)——注册表所基于的 schema 校验 KV 域。

-----

<a id="model-experience"></a>
## 模型体验

### 用户身份记录

#### 模型看到什么

什么都没有。`ctx.users` 只把持久用户注册表服务给宿主侧消费方:本包不注册工具、不注入提示词、不写会话事件,因此没有任何请求字段携带本包的数据。

#### Token 影响

每个请求零直接 token。

#### KV 缓存影响

与活动请求无关:本包从不触碰请求前缀,因此无法使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了用户注册表何时不适合或需要特别的运维注意。它们是当前的包约束,而非任务 backlog。

- **无匿名回退**——挂载注册表后,每个已认证 actor 必须解析到一个存储用户;没有可回退的未认证默认值。
- **移除本身不是吊销**——`remove` 删除用户的记录,但不删除其工作区或会话,也不清除这些记录指向的每用户 cookie 密钥;该清理由后续阶段负责。
- **owner 在 v1 中不可移除**——owner 持有部署的信任,因此在存在转移机制之前移除他们会大声失败。
- **凭据是每 home 的**——注册表验证用户名与密码,但不拥有密码的来源、也不轮转签名材料;每用户凭据与设置是另一项延期的关注点。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是面向维护者的工作上下文:未决的开放问题与方向。它显式地非权威——已发布行为、限制与被接受的 rationale 存于上述各节、包代码与所链 Agent Note 中。

#### 未决:owner 引导

第一个创建的用户获得 owner 位,但部署如何命名该第一个用户(机器上的首次登录,或一个 setup token)留待部署决定,直到后续阶段的登录路由落地。

</details>
