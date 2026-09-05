# AGENTS.md — dsh-multi-user-workspaces

Design-first plugin project for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH): multi-user login on one `dsh web` deployment, private + shared
workspaces, and per-user remote workspaces on top of
[dsh-remote](https://github.com/flymysql/dsh-remote). Nothing here is implemented
yet — the work product of phase N is code in the DSH checkout (and optionally in
a `dsh-remote` fork), not in this repo.

## Standing orders

1. **Read [DESIGN.md](DESIGN.md) before doing anything.** It is the authoritative
   design: target (§1), verified current-state facts with file citations (§2 —
   do not re-derive, verify on disagreement), component contracts C1–C5 (§4),
   storage schema (§5), phased plan P1–P5 with per-phase acceptance (§6),
   global acceptance (§7), risks (§8), and the reference deployment
   environment (§9).
2. **Work in phases, one PR per phase**, in order P1 → P5 (§6). A phase is done
   only when every listed acceptance criterion passes. Do not skip ahead to
   polish a later phase.
3. **DSH conventions bind** for code that lands in the DSH checkout at
   `/home/duty/deepseek-harness`: read that root `AGENTS.md` before the first
   phase — package layout (`packages/<group>/<pkg>/`, `@deepseek-ai/dsh-<name>`),
   ESM + `.ts` relative imports, `ctx.effect()` registrations, Agent Note in the
   same PR, README + JSDoc updated together, locale-owned UI copy, snapshot
   updates for model/user-visible changes.
4. **Plugin-level only, until a phase says otherwise.** No agent-loop changes,
   no new model-visible inputs (no new session events). If a phase needs one,
   record it in an Agent Note first.
5. **Pre-release stance**: DSH has no compatibility promises — bump domain-unit
   versions instead of writing migrations; the single deliberate exception is
   C2's v1-cookie read-back (DESIGN.md §4/C2).
6. **The reference deployment is live** (DESIGN.md §9): `dsh-web.service` serves
   real users over Tailscale. Stop the service to test only when the phase
   requires it, and start it back before finishing the work item.
7. **This repo** holds design + decisions only (docs, notes, later the dsh-remote
   fork). Code changes here are doc changes — keep `docs/` and DESIGN.md in sync
   when a contract moves.

## Layout

```
DESIGN.md      authoritative design document (start here)
AGENTS.md      this file
README.md      human-facing project summary (EN/ZH)
docs/          the two source Agent Notes (EN/ZH pairs) that DESIGN.md supersedes
               in case of conflict — DESIGN.md wins, then update the notes
```

## Verification commands (on the reference deployment)

```sh
cd /home/duty/deepseek-harness
pnpm run test:gui     # client-side work (P4)
pnpm run test         # unit tests
pnpm run test:docs    # after doc changes
pnpm run typecheck
```
