# 用户身份

[English](identity.md) | 中文

[dsh-identity-users](../../packages/identity/users) 是面向多用户 `dsh web` home 的持久用户注册表（`ctx.users`）：每个大小写不敏感的用户名一条记录，含加盐 scrypt 凭据、显示名，以及由第一个创建的用户持有的单一 owner 位。它是后续多用户功能解析"谁在操作"的身份基础——工作区归属、每用户会话 cookie、每用户远程机器都挂到这些用户之一。注册表只面向宿主侧：不注册工具、不注入提示词、不写会话事件，因此模型、工具与 agent loop 永远不会看到它。它只需要一并挂载存储栈，没有自己的配置项；它是其所属设计的第一个切片，该设计由[多用户工作区 Agent Note](../../.agents/notes/proposed/architecture/2026-09-05-multi-user-private-shared-workspaces.zh.md)拥有。

源码：[`packages/identity/users/src/index.ts`](../../packages/identity/users/src/index.ts)

## 记录

每个用户是 `users` 存储域单元（版本 1）中的一行，以小写用户名为键，因此 `Alice` 与 `alice` 冲突。存储的记录携带带品牌的 `UserId`、原始大小写的 `username`、`displayName`、`passwordHash`（16 字节 salt 与 32 字节 scrypt 密钥的 base64）、`isOwner` 位，以及 `createdAt` 时间戳。每次读写都投影到省略 `passwordHash` 的公共 `User`，因此列出用户的调用方从不持有可验证的凭据。

## owner 位

恰好一个用户是 owner：第一个创建的用户获得该位，且该不变量在启动时重新检查，出现第二个存储 owner 会大声失败，使损坏或被手工编辑的单元从不被当作有效注册表服务。owner 持有部署的信任，因此在存在转移机制之前移除他们会拒绝 `users/owner-removal`。

## 无时序旁路

`verify` 将用户名与密码对照一条存储记录校验。当用户名未知时，它仍会先烧掉一次 scrypt 派生再拒绝，因此"没有该用户"与"密码错误"开销相同，并拒绝同一个 `users/bad-credentials` 错误——调用方无法分辨哪种情况发生。

## 持久形态与生命周期

启动时注册表打开 `users` 域、重建其内存索引，并校验 owner 位；以不同版本打戳的单元在打开时被拒绝（预发布立场，不做迁移）。`create` 与 `remove` 在单一操作链上串行，使拥有 owner 位与键表的"检查后写"不会交错；对未知 id 的 remove 是幂等的 no-op。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxusers--usersservice"></a>

### `ctx.users` — `UsersService`

Durable user registry. Startup opens the `users` domain, rebuilds the in-memory indexes, and validates that at most one user holds the owner bit. The dependency is the domain form alone; no session or persistence peer is needed.

```ts cordis-catalog
/**
 * Create a user. Rejects an out-of-grammar username (`users/invalid-username`),
 * a short password (`users/short-password`), and a case-insensitive username
 * collision (`users/username-taken`). The first user ever created takes the
 * owner bit.
 * @param input - The username, password, and optional display name.
 * @returns the created user, projected without its password hash.
 */
async create(input: { username: string; password: string; displayName?: string }): Promise<User>

/**
 * Verify credentials and resolve the user. Both an unknown username and a
 * wrong password reject `users/bad-credentials` (one error, no timing
 * oracle): a missing user still burns one scrypt derivation.
 * @param username - The username, in any casing.
 * @param password - The clear-text password.
 * @returns the resolved user, projected without its password hash.
 */
async verify(username: string, password: string): Promise<User>

/**
 * Read one user by id or username, synchronously.
 * @param idOrUsername - A user id or a username in any casing.
 * @returns the user, or `undefined` when neither names a stored user.
 */
get(idOrUsername: string): User | undefined

/**
 * Every user, in creation order (by `createdAt`, ties broken by username).
 * @returns a fresh ordered array of users, projected without password hashes.
 */
list(): readonly User[]

/**
 * Remove a user and its record. An unknown id is an idempotent no-op; the
 * owner rejects `users/owner-removal`. Workspaces and sessions are untouched.
 * @param userId - The user to remove.
 * @returns resolution after durability.
 */
async remove(userId: UserId): Promise<void>
```

Source: [`packages/identity/users/src/index.ts`](../../packages/identity/users/src/index.ts)
<!-- END GENERATED cordis-surface -->
