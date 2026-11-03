# AgentTeams optimization directions — 2026-11-02

This document records the next evidence-backed optimization opportunities after the rc.5 / 0.1.29 baseline work. It is deliberately separate from the release candidate: none of these items changes the current verified artifact.

## Implementation status (2026-11-03)

Implemented in this fork, each with a focused regression suite in `pnpm verify`:

| Direction | Change | Evidence |
|---|---|---|
| P0 memory | `dsh-agent-teams-memory-trace` samples only OS process metadata (PID, RSS, elapsed time) | `scripts/memory-trace.test.mjs` |
| P0 polling I/O | `/state` returns a strong ETag; the browser sends `If-None-Match` and skips replacing unchanged JSON on 304 | `scripts/activity-etag.test.mjs` |
| P1 mailbox | Acknowledged non-final records are compacted into `inbox/archive/<agent>.jsonl`; unread, malformed and final-report records stay active | `scripts/mailbox-compaction.test.mjs` |
| P1 archive | Archived snapshots are cached by `team.json` mtime+size, evicted on change/delete, capped at 256 entries | `scripts/activity-archive-cache.test.mjs` |
| P1 payload | Running/archived snapshots omit staging-only prompts and task descriptions; timeline capped to the 50 rendered entries | `scripts/snapshot-payload.test.mjs` |
| P2 tool surface | `scripts/tool-surface-budget.mjs` measures the real registered definitions: full captain 19 tools / 20,003 B, core 11 tools / 15,945 B, 20.3% smaller | `scripts/tool-surface-budget.test.mjs`, `docs/tool-surface-budget.json` |

Still open from this document: cross-platform rc.5 archive, exact-cohort install preflight, and a shared bounded test-cleanup helper.

## Evidence baseline

- Plugin: `@nanmicoder/dsh-agent-teams@0.1.29`
- Host: DeepSeek Harness `0.2.1-rc.5`
- Current verification: `pnpm verify`, 11/11 real rc.5 runtime scenarios, exact 296-package cohort, desktop 0.1.29 smoke.
- The plugin is no longer the dominant source of the 100-cycle residual heap growth. A no-plugin control retains the same 128 copies of a 21 MiB Hindsight skill string.

## P0 — host memory / skill retention

**Evidence:** `docs/harness-0.2.1-rc.5/local-desktop-memory-audit.json` records the plugin and no-plugin control retaining the same skill text instances. The plugin-owned `ancestryCache`, `activationRoots` and `activationWorkspaces` are fixed and bounded.

**Direction:** treat this as a Harness-side per-session skill projection/cache issue, not a team-lock leak. Add a user-runnable memory trace that samples RSS, heapUsed, heapTotal, external, arrayBuffers and active handles while recording session counts. The trace should be safe for a user to attach to #117 without credentials or conversation contents.

**Expected gain:** gives upstream maintainers a reproducible ownership histogram and prevents further speculative plugin fixes.

## P0 — activity panel polling I/O

**Evidence:** `src/client/activity-monitor.ts` polls every 1,000 ms for live targets and every 5,000 ms for cardless discovery. `src/snapshot.ts` scans all team directories and reads every team plus each member mailbox on a live request; the archived path scans every archive.

**Direction:** add an ETag/digest or `Last-Modified` response to `/plugins/dsh-agent-teams/state`, and let the browser skip JSON replacement when unchanged. A later step can add a targeted cursor or SSE stream. Keep polling as the compatibility fallback.

**Expected gain:** less filesystem I/O and JSON allocation for idle or large workspaces, especially with many teams and archived histories.

## P1 — mailbox growth and read amplification

**Evidence:** `src/state.ts` `readMailbox` reads the complete JSONL file; acknowledged messages remain in the file. Snapshot assembly reads unread messages for every member and the captain on polling.

**Direction:** compact acknowledged/discarded records into a bounded archive, or split an active inbox from a durable audit log. Preserve diagnostic malformed lines and existing message IDs during migration.

**Expected gain:** bounded parse time and memory as long-running teams exchange many messages.

## P1 — archive index and lazy detail

**Evidence:** `collectArchivedTeamsActivity` calls `listArchivedTeamIds` and reads the full team record for every archive. The activity panel may only need summary rows for most archived teams.

**Direction:** maintain a bounded archive index (`id`, `name`, `mtime`, member/task counts, phase), then load full archived snapshots only when a user expands a team.

**Expected gain:** faster panel startup and less memory pressure after many completed teams.

## P1 — snapshot payload budget

**Evidence:** live snapshots carry member `executionPrompt`, task descriptions, unread inbox content, attachment metadata and up to 200 timeline entries per team.

**Direction:** split the snapshot into a lightweight list payload and a detail payload keyed by `teamId`; keep timeline/message bodies on demand.

**Expected gain:** smaller browser messages and fewer retained JS objects while the panel is open.

## P2 — prompt and tool-surface budget

**Evidence:** the stable captain surface has 23 tools; `toolSurface: core` exposes an 11-tool subset. The full surface is still the default.

**Direction:** measure rendered schema bytes and token estimates for both surfaces, then decide whether core should be recommended for normal sessions. Do not change the default without a paired quality/capability evaluation.

**Expected gain:** lower prompt overhead and fewer wrong-tool choices in ordinary sessions.

## P2 — cross-platform runtime evidence

**Evidence:** the repository has an Ubuntu/Windows CI matrix, but this fork currently archives only darwin/arm64 runtime evidence. The desktop smoke is separate from the headless runtime suite.

**Direction:** archive CI results for rc.5 on Ubuntu and Windows, including plugin-manager install and the 11 runtime scenarios. Keep platform evidence distinct from the desktop UI smoke.

**Expected gain:** release claims become platform-specific and auditable.

## P2 — exact-cohort install latency

**Evidence:** the rc.5 candidate installs a 296-package exact cohort; the desktop profile uses pnpm 11 and a local file artifact. The tarball is about 2.2 MiB.

**Direction:** cache the exact cohort by lockfile digest, preserve the artifact SHA in doctor output, and add a preflight that distinguishes “already installed” from “registry fetch required”.

**Expected gain:** faster upgrades and fewer timeout-driven partial installs.

## P2 — shared test cleanup helper

**Evidence:** `issue-76` and `issue-272` exposed `ENOTEMPTY` cleanup races because background writes can publish just after a scheduler kick returns. Both now use recursive-remove retries.

**Direction:** centralize a test cleanup helper with bounded recursive retry and use it for scheduler/inbox fixtures. Do not hide non-cleanup errors.

**Expected gain:** removes recurring full-suite flakes without weakening assertions.

## Recommended order

1. Add a credential-free memory trace and classify host skill retention.
2. Add state-route digest/ETag and skip unchanged polling updates.
3. Bound active mailbox files and add an archive index.
4. Split live snapshots into summary/detail payloads.
5. Measure and evaluate a core-by-default tool surface.
6. Archive Ubuntu/Windows rc.5 evidence.
Updated 2026-11-03 after implementation:

- P0 memory trace: shipped as `dsh-agent-teams-memory-trace` (OS metadata only).
- P0 polling: strong ETag plus `If-None-Match` revalidation.
- P1 mailbox: bounded acknowledged archive; unread/malformed/final stay active.
- P1 archive: mtime+size snapshot cache, 256-entry bound.
- P1 payload: staging-only fields removed from running/archived snapshots; timeline capped at 50.
- P2 tool surface: reproducible budget measurement (19 tools / 20,003 B vs 11 / 15,945 B).
- P2 test cleanup: shared bounded retry helper replaces two local copies.
- P2 install latency: `dsh-agent-teams-install-preflight` reports the declared spec, installed version, local artifact SHA-256, exact-cohort presence, and whether an upgrade needs a registry fetch.
- rc.5 full matrix re-run on the optimized artifact: 11/11 scenarios, 296-package cohort, `docs/harness-0.2.1-rc.5/optimization-2026-11-03/`.

Still requiring another machine/registry path: Ubuntu and Windows rc.5 archive evidence, and an exact-cohort install preflight that distinguishes cached from registry fetch.

## Upstream deltas after 2026-10-30

The upstream tracker gained issues after the original backlog audit. Status in this fork:

| Issue | Decision | Evidence |
|---|---|---|
| #330 `/state` resends full snapshots every second | fixed | ETag/304, session scoping, workspace-root dedupe, hidden-page cadence, trimmed payloads; `scripts/issue-330.test.mjs`, `scripts/activity-etag.test.mjs`, `scripts/snapshot-payload.test.mjs` |
| #333 deleting a team leaves member host sessions | fixed, opt-in | `agent_teams_delete({ archive_member_sessions: true })` archives each durable member session through `workspaceRegistry.archiveSession`; default unchanged; `scripts/issue-333.test.mjs` |
| #335 Windows desktop reports "invalid plugin ... received object" | fixed | the package now exports an applicable default plugin object in addition to named exports; `scripts/issue-335.test.mjs` |
| #331 a forked session cannot create its own team | needs evidence | no host version, profile composition, or error trace in the report; the plugin resolves the captain by session lineage, so a fork of a captain may legitimately be treated as the same team |
| #329/#328/#327/#326/#325/#323/#322 | duplicate of #327 | same rc.5 compatibility rejection |
| #324 GUI team-size config / delegation skill | out of scope | changes the product surface and needs its own design review; the underlying `maxMembers` setting already exists in config |
| #319 claim_task assignee and host depth messaging | duplicate of the #96/#244 line | already addressed by the optional-parameter and tool-policy work in this fork |
