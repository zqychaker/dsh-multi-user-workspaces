# Agent Note: Multi-user login with private and shared workspaces

Status: proposed

English | [中文](2026-09-05-multi-user-private-shared-workspaces.zh.md)

## Problem

One Harness home (`$DSH_HOME`) has exactly one owner. Browser authentication ([`dsh-client-connection`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)) mints one process launch token and one owner-scoped cookie signing secret (`client-connection/browser-session` grant record); every browser that holds the token or cookie authenticates as that same owner — the request check is a boolean (`BrowserAuth.isAuthenticated`) that establishes trust but never an identity. Everything downstream is owner-global: the workspace registry ([`dsh-workspace`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/README.md), `ctx.workspaceRegistry`) has no owner field on `Workspace` and no visibility attribute, the session controller's list/search see every persisted session in the home, and credentials/settings are one document per home.

The need: several humans share one `dsh web` deployment. Each logs in as themselves, works in private workspaces only they can see, and collaborates in public (shared) workspaces visible to everyone.

## Proposal

Four coordinated pieces, all plugin-level (no agent-loop changes):

### 1. `dsh-identity-users`: a durable user registry

New package in the `identity/` group, `ctx.users` service, backed by a new `users` storage-domain unit (`users` table): `id` (branded `UserId`), `username` (unique, case-insensitive), `displayName`, a per-user salted password hash, `createdAt`, and an `isOwner` bit set on the first created user (the owner keeps the existing owner-scoped records' meaning). Operations: `create`, `verify(username, secret)`, `list`, `get`. Pre-release stance applies: the domain unit version starts at `1` and backends reject old formats; there is no anonymous fallback — a home with the users plugin mounted has no unauthenticated actor.

### 2. `dsh-client-connection`: identity-carrying browser sessions

- Cookie payload `v2` adds `userId`. Signing secrets become per-user credential records at `client-connection/browser-session/<username>`; deleting a user revokes all of their cookies. The owner's record stays at the existing owner-scoped key.
- Two new exact Fetch routes on the Host carrier: `POST /api/auth/login` (`{ username, password }` → user cookie + redirect) and `POST /api/auth/logout` (clears the cookie). Login is a carrier route, not a session-bound flow.
- `BrowserAuth.isAuthenticated` returns the decoded `userId` (or `undefined`); the single check point in `rpc-host.ts` becomes "unauthenticated → 401, otherwise attach the actor", so every Host RPC dispatch and `$events` stream carries the acting user. The trust fence (`api-request-trust.ts`) is unchanged: Host/Origin checks still only defend reachability.

### 3. `dsh-workspace`: ownership and visibility on the entity

`Workspace` gains `ownerId: UserId` and `visibility: 'private' | 'shared'` (`create(actor, path, { title?, visibility? })`; default `private`). `list(actor)` returns the actor's private workspaces plus all shared ones, in registry order; `get`/`resolveByPath` stay unfiltered so enforcement lives in the controllers (the operation that makes the decision enforces it). Mutation rules: the owner alone renames/deletes a private workspace; on a shared workspace the creating user manages it and every user may use it. Session membership semantics (cwd-validated attach) are untouched. The `workspaces` table moves to version `2` with the two new columns.

### 4. `dsh-api-session-controller` + GUI: actor-scoped visibility

List/search scope to the actor's accessible workspaces (their private ones, every shared one, plus their own Ungrouped sessions); a session in a shared workspace is visible to every user of that workspace. The GUI adds a login screen (`ui-login`, shown when the index 401s), a user chip, and a private/shared badge in the workspace sidebar (`ui-workspace`).

## Alternatives considered

- **One home per user behind a reverse proxy.** Zero code, but homes are fully isolated — there is no shared workspace — and login is outsourced to the proxy.
- **Reuse the authorization seam for login.** [`dsh-credentials/authorization`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/authorization/README.md) sign-in flows are session-bound (attempts live in the process and talk to a session that does not exist yet before login). It stays the right home for provider sign-ins; user login is a carrier route instead.
- **Multi-tenant storage backends** (`storage.backend.<user>`). A medium split buys nothing here: visibility is a data-level attribute on workspace rows, and session logs must remain one store.

## Acceptance criteria

1. Two browsers with two different users are logged in simultaneously; each sees only their private workspaces and sessions plus all shared ones.
2. A workspace created as shared by user A appears for user B; B can start sessions in it; B cannot rename or delete it; A can.
3. A cookie issued for user A cannot list user B's private workspaces; a deleted user's cookie 401s.
4. The pre-login UI is the login screen, not the GUI shell; logout returns to it.
5. Old on-disk `users`/`workspaces` formats fail loud as version mismatches (pre-release stance).

## Risks

- **Workspace privacy is not file privacy.** Until fs/sandbox policy is scoped per user, user A's agent can `cat` files under user B's private workspace path via bash. This note defers per-user fs scoping and says so; the visibility model is a first step, not a hard boundary.
- **Credentials and settings stay per home.** All users share the home's API keys and configuration document; per-user credential scoping is deferred work.
- **Exposure hardening is required for real multi-user deployments.** The shipped server is loopback HTTP with an unmarked-`Secure` cookie, and `dsh web --host 0.0.0.0` is currently unsupported; a LAN-shared deployment needs the `trustedHosts` + TLS story settled alongside this note.
