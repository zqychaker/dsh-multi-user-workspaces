# Combining with dsh-remote: per-user remote workspaces

[中文](remote-workspaces-integration.zh.md)

## What dsh-remote already gives us

[dsh-remote](https://github.com/flymysql/dsh-remote) (v0.8.x, npm `dsh-remote`) is a remote-work assistant plugin: a multi-machine SSH registry in Settings, a two-tab workspace picker (local / remote), and 21 `rw_*` model tools. Confirming a remote pick creates a **real local mirror** under `$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<base>` that passes `fs.realpath`, so the harness adopts it as an ordinary workspace — `dsh-workspace` and the harness core stay unmodified.

## Target scenario

One central `dsh web` deployment (a home server, reached over Tailscale/nginx). Several users log in from **their own computers** as themselves (the [multi-user note](2026-09-05-multi-user-private-shared-workspaces.md)). Each user registers their own computer as an SSH machine, creates a **remote workspace that lives on their own machine**, and the agent works there through the mirror and `rw_*` tools. Private by default: user A's machine and its workspaces are invisible to user B.

## The gaps: dsh-remote is home-global, not user-scoped

1. **Machine registry is one global list.** Saved machines, the "current machine", and SSH credentials (password/key records) are shared by every browser on the deployment. → Scope the registry by `userId` (note §1's `ctx.users`): per-user machine rows, per-user credentials. The OS keychain does not separate login users on a shared server, so per-user file-backed credential records are the default there.
2. **The mirror root is global.** `$DSH_HOME/remote-workspaces/<host>-...` collides when two users mirror the same host, and (sharper) makes user A's private project files readable on the server by user B's agent. → Per-user mirror root `$DSH_HOME/remote-workspaces/<userId>/<host>-...`.
3. **Workspaces have no visibility.** Remote mirrors are adopted as plain workspaces. → Adopt them through the actor-scoped `create` with `visibility: 'private'` (note §3), so a user's remote workspace only appears in their sidebar. A workspace on a machine the owner exposes (e.g. the central server itself) can be marked `shared`.
4. **The picker is global.** The Settings → 远程工作区 machine list and the remote tab of the picker show every saved machine. → Filter by the logged-in user (the picker already runs in the browser session that carries the actor after note §2).
5. **`rw_*` tools need nothing new.** They are already session-scoped; the acting user rides the session from note §2, so a user's session can only `rw_connect` to machines on their own registry rows.

## Project shape

One combined plugin project, delivered as two layers:

- **Core layer** — the four pieces of the [multi-user note](2026-09-05-multi-user-private-shared-workspaces.md): user registry, identity-carrying browser sessions, workspace ownership/visibility, actor-scoped GUI.
- **Remote layer** — a `dsh-remote` user-scope extension: consume `ctx.users` when mounted (fall back to a single implicit owner when it is not), keying the machine registry, mirror root, and picker by the acting user. Upstream this as an optional seam in `dsh-remote` if the maintainer accepts it; otherwise bundle the fork in this project.

## Acceptance criteria (increment over the multi-user note)

1. User A on laptop A registers laptop A as a machine and creates a remote workspace on it; the agent edits files on A through the mirror.
2. User B sees none of A's machines or remote workspaces; B's `rw_connect` to A's host fails as unknown to B's registry.
3. A shared workspace on the central server is visible to both; sessions in it are visible to both (multi-user note §4).
4. Deleting user A removes A's machine rows, credentials, and mirrors without touching B's.
