---
description: "Durable user registry (ctx.users) for multi-user DeepSeek Harness deployments: case-insensitive usernames, scrypt credentials, and a single owner bit."
kind: "package-reference"
---

# @deepseek-ai/dsh-identity-users

English | [中文](README.zh.md)

## Summary

`dsh-identity-users` gives a host a durable registry of the humans that may log in: one record per case-insensitive username, a salted scrypt credential, a display name, and a single owner bit held by the first user created. With it, a deployment can let several people share one `dsh web` home — each verifies their own credentials and is addressed by a stable branded id that other packages (workspace ownership, per-user session cookies) attach to their records. The package is host-side only: the model, tools, and agent loop never see it, so it adds no tokens, prompts, or request context. It needs only the storage stack mounted alongside it; there is no configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package to give a deployment a list of named users it can authenticate against. It is the identity foundation for a multi-user home: every other multi-user feature resolves "who is acting" to one of these users.

### When to use it

Use it when more than one human logs into the same home and their work must be told apart — private versus shared workspaces, per-user cookies, per-user remote machines. It is invisible to the model, so it adds no token or request cost. A single-owner home that never verifies credentials can omit it entirely.

### Setting up

The package takes no configuration of its own; it needs the storage rows that keep its records. A minimal composition:

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-identity-users'
```

With these rows mounted, a created user shows up in the list immediately and survives a restart. The first user ever created takes the owner bit; later users do not.

### Creating, verifying, and reading users

Create a user from a username and password; the username is unique ignoring case and the password is salted and hashed before it is stored. Verify credentials to resolve a user, and read one user by id or username or list every user in creation order:

```text
// Host consumer code, after the composition above is loaded:
const owner = await ctx.users.create({ username: 'Alice', password: 'correct-horse' })
owner.isOwner // true for the first user created
const who = await ctx.users.verify('alice', 'correct-horse')
ctx.users.list() // every user, creation order, without password hashes
```

A verify that names an unknown username or supplies a wrong password rejects the same `users/bad-credentials` error, so the two cases cannot be told apart by the caller.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the feature and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One record per canonical username.** The lowercased username is the durable key, so `Alice` and `alice` collide; the original casing is stored for display.
- **The hash never leaves the record.** `create`, `verify`, `get`, and `list` all project to a public `User` that omits `passwordHash`, so a listing reader never holds a verifiable credential.
- **A single owner bit.** Exactly one user is the owner, set at create when no user exists yet; the invariant is re-checked at startup and a second owner fails loud.
- **No timing oracle.** A verify for a missing username still burns one scrypt derivation before rejecting, so presence and wrong-password cost the same.

### API behavior

The API is one small family with a single owner, the `UsersService` (`ctx.users`): `create` and `remove` mutate the durable record, `verify` checks a credential, and `get`/`list` read. Per-method contracts live in the code — see [src/index.ts](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `UsersService` service, scrypt helpers, owner-bit validation, operation serialization |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: the record schema and the `users` `defineDomain` spec (version 1) |
| [`src/types.ts`](src/types.ts) | The public `User` interface and the `UserId` brand |

### Durable shape

The registry opens the `users` domain (version 1): a single `users` table keyed by the lowercased username. Each record holds `id` (branded `UserId`), `username` (original casing), `displayName`, `passwordHash` (base64 of salt and scrypt hash), `isOwner`, and `createdAt`. Pre-release stance applies: backends reject a stored file stamped with a different version, so a version-0 unit fails loud on open.

### Lifecycle

On start, the registry opens the domain, rebuilds its in-memory indexes, and validates that at most one stored user holds the owner bit. Writes (`create`, `remove`) serialize on a single operation chain so the check-then-write that owns the owner bit and the key table cannot interleave.

### Failure and recovery

A create whose record write fails leaves no cache entry and no owner change; a remove is idempotent for an unknown id. A startup that finds two owners, or a domain stamped at the wrong version, rejects the whole plugin so a corrupted or old unit is never served as a valid registry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when this package's view is not enough:

- [Multi-user login with private and shared workspaces](../../../.agents/notes/proposed/architecture/2026-09-05-multi-user-private-shared-workspaces.md) — the design this registry is the foundation of, and why login is a carrier route rather than a session-bound flow.
- [identity package group](../README.md) — the group's packages and this package's repository position.
- [domain data form](../../storage/storage-domain/README.md) — the schema-validated KV domains the registry is built on.

-----

<a id="model-experience"></a>
## Model Experience

### User identity records

#### What the model sees

Nothing. `ctx.users` serves the durable user registry to host-side consumers only: the package registers no tools, injects no prompts, and writes no session events, so no request field ever carries this package's data.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the user registry is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No anonymous fallback** — when the registry is mounted, every authenticated actor must resolve to a stored user; there is no unauthenticated default to fall back to.
- **Removal is not revocation by itself** — `remove` deletes the user's record but does not delete their workspaces or sessions, and it does not clear the per-user cookie secrets those records point at; a later phase owns that cleanup.
- **The owner cannot be removed in v1** — the owner holds the deployment's trust, so removing them fails loud until a transfer mechanism exists.
- **Credentials are per home** — the registry verifies a username and password but does not own where the password came from or rotate the signing material; per-user credentials and settings remain a separate, deferred concern.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Open: the owner bootstrap

The first created user takes the owner bit, but how a deployment names that first user (first login on the machine, or a setup token) is left to the deployment until the login route lands in a later phase.

</details>
