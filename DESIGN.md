# DESIGN.md — dsh-multi-user-workspaces

> A project design document written for AI coding agents. It states the target,
> the current-state facts you must not re-derive, exact contracts for every
> component, the storage schema, and a phased implementation plan with
> per-phase acceptance criteria. Human-readable summaries live in
> [README.md](README.md) and `docs/`.

Status: **proposed** (no component implemented yet)
Upstream: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, checked out and running on the target deployment)
Combines with: [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) v0.8.x (npm `dsh-remote`)

---

## 1. Target

One central `dsh web` deployment (a home server, reached over Tailscale + nginx).
Several humans log in from **their own computers** as themselves. After login, a
user can:

1. work in **private workspaces** — visible and mutable only to that user;
2. work in **shared (public) workspaces** — visible and usable to every logged-in
   user, managed by the workspace creator;
3. register their own computer as an SSH machine (via `dsh-remote`) and create
   **remote workspaces that live on their own machine** — private by default,
   operated through the local mirror and the `rw_*` model tools.

Non-goals (explicitly deferred, stated so an agent does not "fix" them):

- Per-user fs/sandbox scoping (workspace visibility is not yet file privacy).
- Per-user credentials/settings (API keys and the settings document stay per home).
- OAuth/SSO login (first release: username + password; the seam stays open).
- TLS hardening for LAN exposure (needed for real deployments; tracked separately).

---

## 2. Current-state facts (verified against the running DSH checkout)

These are load-bearing. Do not re-derive them; verify against the cited files if
they look wrong.

1. **One home = one owner.** `$DSH_HOME` holds all state. Browser authentication
   (`packages/client/connection/src/browser-auth.ts`, class `BrowserAuth`) mints one
   process launch token per process and one **owner-scoped** cookie signing secret
   (credential record key `client-connection/browser-session`, stored by
   `credentials-local` in `$DSH_HOME/.credentials.yaml`). The cookie payload is
   `{version: 1, authority, issuedAt, expiresAt}` — **no user identity**.
2. **The single auth check point** is `packages/client/connection/src/rpc-host.ts`
   (~line 98): `this.browserAuth.isAuthenticated(request) ? undefined : 401`.
   `isAuthenticated` returns a **boolean**. The Host/Origin trust fence
   (`api-request-trust.ts`) runs before it and only defends reachability, never
   identity.
3. **Workspaces are global and ownership-free.** `dsh-workspace`
   (`packages/workspace/workspace/`) exposes `ctx.workspaceRegistry`; the
   `Workspace` entity (`src/types.ts`) is `{id, path, title, createdAt, updatedAt,
   sessionIds, …}` — no owner, no visibility. Stored in storage-domain unit
   `workspace` (tables `workspaces` + durable order), current version **2**
   (`$DSH_HOME/storages/workspace.json`).
4. **Session membership is cwd-derived and immutable.** A session belongs to a
   workspace iff its id is in the workspace's `sessionIds` **and** the immutable
   `SessionHeader.cwd` (first log line, canonicalized via `fs.realpath`) equals the
   workspace path. Attach happens once, at session create time, by the API gateway.
5. **Sessions are listed without user scoping.** `dsh-api-session-controller`
   (`packages/api/session-controller/`) serves list/search over all persisted
   sessions of the home.
6. **dsh-remote is home-global.** Installed as npm `dsh-remote` in the profile
   (`$DSH_HOME/profiles/web/node_modules/dsh-remote`). It keeps one machine
   registry (hosts + credentials + "current machine"), one mirror root
   `$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<base>`, and a Settings panel
   + workspace picker with no user dimension. Confirming a remote pick creates the
   local mirror, which the harness adopts as an ordinary workspace — DSH core
   stays unmodified. 21 `rw_*` model tools are **session-scoped** already.
7. **Pre-release stance.** DSH has no compatibility promises: backends reject
   old on-disk formats; domain units carry a `version` and a mismatch fails loud.
   New columns/tables = bump the unit version.

---

## 3. Component overview

```
C1 dsh-identity-users      durable user registry        (new package, identity/ group)
C2 connection v2           identity-carrying sessions   (extend dsh-client-connection)
C3 workspace v3            owner + visibility           (extend dsh-workspace)
C4 actor-scoped surfaces   list/search + login UI       (extend session-controller, ui-login, ui-workspace)
C5 dsh-remote user-scope   per-user machines & mirrors  (extend/bundle dsh-remote)
```

Dependency order: **C1 → C2 → C3 → C4 → C5**. C5 consumes C1+C2+C3; nothing in
C1–C4 knows about dsh-remote. All changes are plugin-level: **no agent-loop
changes, no new model-visible inputs** (no new session events) unless a phase says
otherwise.

---

## 4. Component contracts

### C1 — `dsh-identity-users` (new package)

Location: `packages/identity/users/` in DSH (or this repo's first phase package),
service at `ctx.users`.

Storage: new storage-domain unit **`users`**, version `1`.

```
unit: users
tables:
  users:
    <usernameLowercase>:            # username, unique, case-insensitive, ^[a-z0-9][a-z0-9._-]{0,31}$
      {
        id: UserId,                 # branded uuid (Branded<'UserId'>)
        username: string,           # original casing
        displayName: string,
        passwordHash: string,       # scrypt(N=16384, r=8, p=1), base64(salt || hash)
        isOwner: boolean,           # exactly one true; set on first user created
        createdAt: string           # ISO-8601
      }
```

Service API (the complete public surface):

```ts
interface UserService {
  /** Create a user; rejects `users/username-taken` (case-insensitive).
   *  The first ever user gets isOwner=true and must pass the owner bootstrap
   *  (deployment decides: first login on the machine, or a setup token). */
  create(input: { username: string; password: string; displayName?: string }): Promise<User>
  /** Verify credentials. Resolves the user, rejects `users/bad-credentials`
   *  (one error for unknown username AND wrong password — no timing oracle). */
  verify(username: string, password: string): Promise<User>
  /** Synchronous read of one user by id or username. */
  get(idOrUsername: string): User | undefined
  /** All users, creation order. */
  list(): readonly User[]
  /** Remove user + all derived rows (see C5 for machine rows; C2 revokes cookies
   *  via the credential record). Does not touch workspaces or sessions. */
  remove(userId: UserId): Promise<void>
}
```

Semantics an agent must get right:

- **No anonymous fallback.** When the plugin is mounted, every Host RPC must
  carry an actor; boot fails loud if C1 is mounted without C2.
- Password minimum length: 8. scrypt params are fixed protocol constants, not
  config.
- `remove` is not expected in v1 beyond revocation correctness; keep it simple.

### C2 — identity-carrying browser sessions (extend `dsh-client-connection`)

1. **Cookie payload v2** — add `userId`; keep `authority`, `issuedAt`, `expiresAt`.
   Old v1 cookies remain valid (they authenticate as the owner: map a v1 cookie to
   the `isOwner` user) so a deployment upgrade does not log everyone out.
   `COOKIE_PAYLOAD_VERSION = 2`.
2. **Per-user signing secrets** — credential records at
   `client-connection/browser-session/<username>` (same record shape as today:
   `{version: 1, secret}`). The owner keeps the existing owner-scoped key
   `client-connection/browser-session` (record for the owner user lives there; do
   not move it — other packages reference that key). Deleting a user's record
   revokes all of that user's cookies. Secrets are loaded at Connection activation
   and retained in memory (today's model), now keyed by `userId`.
3. **Login routes** — two new exact Fetch routes on the Host carrier (same
   registration mechanism as the session-log download route):
   - `POST /api/auth/login` — body `{username, password}`; success → `303` to `/`
     with the user's cookie (same attributes as today: `HttpOnly; SameSite=Strict;
     Path=/`, no `Secure`, `Max-Age` = `cookieMaxAgeDays`); failure → `401` with
     the C1 error text.
   - `POST /api/auth/logout` — `Set-Cookie` empty with past `Expires`; `204`.
   Both require the Host/Origin trust fence to have passed (reuse the existing
   pre-auth pipeline).
4. **Actor on every dispatch** — `BrowserAuth.isAuthenticated` returns
   `{ userId: UserId } | undefined` (rename to `authenticate` if you prefer; keep
   one method). `rpc-host` attaches it to the per-request context so:
   - every Host RPC dispatch carries the acting user;
   - the `$events` stream's `ready` item gains `userId`.
   The Client half (`ctx.connection`) publishes the active user so client plugins
   (C4, C5 UI) can read it without extra RPCs.

Do not touch: `api-request-trust.ts` (reachability only), launch-token exchange
for the **first** owner (the printed `?token=` URL still bootstraps the owner's
cookie when no users exist yet).

### C3 — workspace ownership and visibility (extend `dsh-workspace`)

Entity (storage-domain unit `workspace`, tables `workspaces`, **version → 3**):

```
workspaces.<workspaceId>:
  { …existing fields…,
    ownerId: UserId,                        # creator; branded id
    visibility: 'private' | 'shared' }      # default 'private'
```

Registry API additions (keep all existing methods; old call sites keep working by
resolving the actor from context):

```ts
/** Existing create, gained actor + visibility:
 *  create(actor: UserId, path: string, opts?: { title?: string; visibility?: WorkspaceVisibility })
 *  Idempotence unchanged: same canonical path → same entity, title/visibility untouched. */

/** Actor-scoped projection: the actor's private workspaces + all shared ones,
 *  in registry order. `list()` with no argument stays for host-internal callers
 *  (bootstrap, invariants) and returns everything. */
list(actor?: UserId): Workspace[]
```

Mutation rules (enforced **in the controller**, not the registry — the registry
stays trustless, the operation that makes the decision enforces it):

| op            | private workspace | shared workspace |
|---------------|-------------------|------------------|
| use (sessions)| owner only        | every user       |
| rename        | owner only        | creator (ownerId) only |
| delete        | owner only        | creator (ownerId) only |
| set visibility| owner (private→shared or back) | creator |
| reorder       | owner             | creator          |

Session membership is **untouched** (cwd-validated attach, immutable header).

### C4 — actor-scoped surfaces (session controller + GUI)

1. `dsh-api-session-controller`: list/search scope to the actor's accessible
   workspaces = (private workspaces where `ownerId === actor`) ∪ (all shared
   workspaces) ∪ (the actor's own Ungrouped sessions — sessions whose header cwd
   matches no workspace). All other operations (prompt, follow, rename…) keep
   working per-session: a user can act on a session they can see.
2. New client plugin `ui-login` (`packages/client/ui-login/`):
   - rendered when the index exchange 401s (no cookie): username + password form
     against `/api/auth/login`;
   - standard client-plugin checklist applies (four props shares, locale-owned
     copy via `t`, `defineStore` if state is needed — it isn't; plain form state).
3. `ui-workspace` sidebar: private/shared badge per workspace row; the shared
   badge doubles as "not yours" (disable rename/delete for non-creators).
4. Header user chip: username + logout (calls `/api/auth/logout`, then reloads).

### C5 — dsh-remote user-scope layer

Consumes `ctx.users` when mounted; falls back to one implicit owner (the current
single-user behavior) when C1 is not mounted — so `dsh-remote` stays usable
standalone.

1. **Machine registry keyed by user.** Today's single machine list becomes
   `machines[userId] = Machine[]` (same `Machine` record: host/port/user/
   credential refs/hostKeyMode/…). "Current machine" stays session-scoped (it
   already is), but `rw_connect` resolves the machine **within the acting
   user's list**; a host unknown to that user fails `rw/machine-not-found` for
   that user while staying reachable to the owner.
2. **Per-user mirror root** — `$DSH_HOME/remote-workspaces/<userId>/<host>-<user>-<port>/<base>`.
   The mirror still passes `fs.realpath` and is adopted as an ordinary workspace,
   now via C3's `create(actor, path, { visibility: 'private' })`.
3. **Picker + Settings filtering** — the Settings → remote-workspaces panel and
   the remote tab of the workspace picker read the acting user from
   `ctx.connection` (C2) and show only that user's machines.
4. **Credential isolation** — SSH passwords/keys per machine are per-user records
   (the OS keychain cannot separate login users on a shared server; the file-backed
   local credential store is the default there).
5. **`rw_*` tools: no schema changes.** They are session-scoped; the acting user
   rides the session.

Upstream strategy: propose C5 as an optional `ctx.users` seam in `dsh-remote`
(itself the polite path, per its "no core modified" design); bundle the fork in
this project if the maintainer does not take it.

---

## 5. Storage & on-disk impact (summary)

| location | change |
|---|---|
| `$DSH_HOME/storages/` new unit `users.json` (or sqlite unit) | new, version 1 |
| `$DSH_HOME/storages/workspace.json` | unit `workspace` version 2 → 3 (two new columns) |
| `$DSH_HOME/.credentials.yaml` | new records `client-connection/browser-session/<username>` per user |
| `$DSH_HOME/remote-workspaces/<userId>/…` | mirrors move under the user key |

Version mismatches fail loud (pre-release stance) — no migration code, but C2's
v1-cookie exception above is the single deliberate read-back compatibility.

---

## 6. Implementation plan (one PR per phase)

| phase | deliverable | acceptance (must all pass) |
|---|---|---|
| **P1** | C1 `dsh-identity-users` | unit tests: create/verify/list/remove incl. case-insensitive duplicate, bad-credentials, owner bit; REAL-composition boot test; version-mismatch rejection of a v0 unit file |
| **P2** | C2 (cookie v2, per-user secrets, login/logout routes, actor on dispatch) | owner still logs in via printed token; two users logged in simultaneously with distinct cookies; v1 cookie still authenticates as owner; deleted user's cookie 401s; `ready` item carries `userId` |
| **P3** | C3 (entity + registry actor listing) | `list(actor)` returns own-private + all-shared; old call sites unchanged; workspace.json v2 → v3 rejects old file |
| **P4** | C4 (session scoping, ui-login, badges, user chip) | two-browser scenario from §1: A's private invisible to B; shared visible to both; login screen before cookie; logout returns to it; `test:gui` + `DSH_SNAPSHOT=replay test:web` green |
| **P5** | C5 (dsh-remote user-scope) | A registers laptop A, creates a remote workspace on it, agent edits files there via mirror; B sees none of A's machines/workspaces; B's `rw_connect` to A's host → `rw/machine-not-found`; deleting A removes A's machines/credentials/mirrors |

Per-repo hygiene for each phase (this is DSH's bar): Agent Note in the same PR,
package README + JSDoc updated together, locale-owned UI copy, snapshot updates
for any model/user-visible change, `pnpm run test:gui` (client) / `pnpm run
test:coverage` (host) as applicable.

---

## 7. Global acceptance criteria

1. Two browsers, two different users, simultaneously: each sees only their
   private workspaces/sessions plus all shared ones.
2. A shared workspace created by A is usable by B; only A renames/deletes it.
3. A cookie issued for A cannot list B's private workspaces; a deleted user's
   cookie 401s.
4. Before login the UI is the login screen, not the GUI shell; logout returns to
   it.
5. A remote workspace on user A's own machine is private to A and fully
   operational (agent edits files on A's computer through the mirror).
6. Old on-disk formats fail loud as version mismatches — except the deliberate
   v1-cookie read-back.

---

## 8. Risks & deferred work

- **Workspace privacy ≠ file privacy** until fs/sandbox is per-user (A's agent
  can `cat` B's files via bash). Accepted for v1; stated in the UI docs.
- **Shared API keys**: all users spend the home's credits; per-user credentials
  are deferred.
- **Exposure**: shipped server is loopback HTTP, cookie unmarked-`Secure`,
  `dsh web --host 0.0.0.0` unsupported; LAN deployment needs `trustedHosts` +
  TLS before trusting the login form over the wire (basic-auth nginx is the
  stopgap on the reference deployment).
- **dsh-remote fork risk**: if upstream evolves, the C5 fork must re-merge;
  the `ctx.users` seam proposal is the mitigation.
- **Single owner bootstrap**: exactly one user has `isOwner`; the owner holds the
  legacy owner-scoped cookie secret and the deployment's trust. Owner deletion
  is disallowed in v1 (fail loud).
