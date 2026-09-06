# User Identity

English | [中文](identity.zh.md)

[dsh-identity-users](../../packages/identity/users) is the durable user registry (`ctx.users`) for a multi-user `dsh web` home: one record per case-insensitive username, a salted scrypt credential, a display name, and a single owner bit held by the first user created. It is the identity foundation the later multi-user features resolve "who is acting" against — workspace ownership, per-user session cookies, and per-user remote machines all attach to one of these users. The registry is host-side only: it registers no tools, injects no prompts, and writes no session events, so the model, tools, and agent loop never see it. It needs only the storage stack mounted alongside it and takes no configuration of its own; the design it is the first slice of is owned by the [multi-user workspaces Agent Note](../../.agents/notes/proposed/architecture/2026-09-05-multi-user-private-shared-workspaces.md).

Source: [`packages/identity/users/src/index.ts`](../../packages/identity/users/src/index.ts)

## The record

Each user is one row in the `users` storage-domain unit (version 1), keyed by the lowercased username so `Alice` and `alice` collide. The stored record carries a branded `UserId`, the original-casing `username`, a `displayName`, a `passwordHash` (base64 of the 16-byte salt and the 32-byte scrypt key), an `isOwner` bit, and a `createdAt` timestamp. Every read and write projects to a public `User` that omits `passwordHash`, so a caller that lists users never holds a verifiable credential.

## The owner bit

Exactly one user is the owner: the first user ever created takes the bit, and the invariant is re-checked at startup, where a second stored owner fails loud so a corrupted or hand-edited unit is never served as a valid registry. The owner holds the deployment's trust, so removing them rejects `users/owner-removal` until a transfer mechanism exists.

## No timing oracle

`verify` checks a username and password against one stored record. When the username is unknown it still burns one scrypt derivation before rejecting, so "no such user" and "wrong password" cost the same and reject the same `users/bad-credentials` error — the caller cannot tell which happened.

## Durable shape and lifecycle

On start the registry opens the `users` domain, rebuilds its in-memory indexes, and validates the owner bit; a unit stamped at a different version is rejected at open (pre-release stance, no migration). `create` and `remove` serialize on a single operation chain so the check-then-write that owns the owner bit and the key table cannot interleave; a remove of an unknown id is an idempotent no-op.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
