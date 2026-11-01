# Harness 0.2.1-rc.5 compatibility

Date: 2026-11-01 (Asia/Shanghai)

## Result

- Host: `0.2.1-rc.5`
- Plugin: `@nanmicoder/dsh-agent-teams@0.1.29`
- Artifact SHA-256: `3fa113d5961b34c83806775b601eaf422b2b10877ea4c01fab99f7f6abcb6a02`
- Runner: `scripts/harness-runtime-verify.mjs`
- Scenario: full runtime matrix
- Node: `v26.12.1`, darwin arm64
- Cohort: 296 exact DSH packages
- Result: **passed**

All 11 packed-artifact scenarios passed on rc.5:

1. `lifecycle` and `lifecycle-cold-restore` — managed activation, delegation, FIFO delivery, settlement and cold recovery.
2. `fallback` and `fallback-cold-restore` — route rotation, reasoning reset and restored route.
3. `failure` — permanent provider failure becomes a failed task with no false retry storm.
4. `captain-idle-wakeup` — idle captain receives a member report instead of busy polling.
5. `progressive-entry` — natural, Chinese, raw slash, command and profile entry cases with stable prefixes.
6. `web-approval` — staging, HTTP approval, member release and report wake.
7. `protocol-compatibility` — legacy allowlists, PTC discard, pruning, compaction and existing-plan revision.
8. `stability` — 13 lifecycle/HMR/steering/archive/report checks.
9. `plugin-manager-install` — the real `dsh plugin add` path installed the exact `0.1.29` version.

The failure fixture now derives progress from durable team state rather than the compacted conversation history, preventing rc.5 compaction from causing duplicate setup tasks. The runtime report is checked in as [`result.json`](./result.json). Only the model is a deterministic fixture; real provider APIs and browser interaction remain outside this check.

## Stability and memory audit

The real DSH `stability` scenario also passes on rc.5 with all 13 checks. The fixture records `process.memoryUsage()` at the start, after each scripted transition and at the end. Over 108 model requests and 15 samples:

- `heapUsed`: 103,746,232 → 119,599,776 bytes (+15.12 MiB)
- `heapTotal`: 152,879,104 → 171,229,184 bytes
- `RSS`: 252,248,064 → 201,310,208 bytes (−48.58 MiB)
- `maxHeapUsed`: 127,949,752 bytes

The heap was bounded in this repeated team lifecycle run. RSS decreased in this trace; the step changes are consistent with runtime allocation and page-retention behavior rather than monotonic native growth. The machine-readable summary is [`memory-audit.json`](./memory-audit.json).

## Local desktop install and #117 soak

The final `0.1.29` development artifact was installed into the real desktop profile and then copied byte-for-byte into an isolated rc.5 runtime for repeatable testing. The exact installed package passed `stability` (13/13 checks) and a 100-cycle workload with two members and two tasks per cycle. Every cycle was claimed, started, completed, reported and deleted; the fixture forced GC before each memory sample.

- Host control without AgentTeams: `heapUsed` slope **319,908 B/cycle** across 200 ordinary child sessions.
- AgentTeams before the retention repair: **358,803 B/cycle** across 201 sessions.
- AgentTeams `0.1.29` after the retention repair: **347,910 B/cycle** across 249 model requests; RSS slope was **162,628 B/cycle**, `external` rose by 69,716 bytes after startup and then stayed flat at 4,972,409 bytes, and active handles stayed at 25.

The independent heap audit found three plugin-owned unbounded containers: `ancestryCache` (201 entries), `activationRoots` (100) and `activationWorkspaces` (100). The repair bounds the ancestry cache at 256 entries, deletes known session entries during teardown, and adds an explicit activation-context `forgetTeam` path used by team deletion and staged-plan discard. Lifecycle verification now asserts that activation roots/workspaces and pending activation bookkeeping are zero after deletion.

The dominant heap growth is still not plugin-specific. A no-AgentTeams control created and disposed 200 ordinary child sessions and retained the same 128 copies of the large Hindsight skill text (**21,024,768 bytes**) as the AgentTeams run. This points at Harness per-session skill retention rather than the repaired team maps. The soak used a deterministic model and **does not reproduce the reporter’s real-provider OOM**. The 0.1.29 artifact was installed into the desktop profile and its extracted tree matched byte-for-byte. An unlocked 0.1.28 smoke test had already rendered the AgentTeams activity panel and plugin settings page; the running host still held 0.1.28 and macOS was locked at the 0.1.29 capture time, so the fresh 0.1.29 UI smoke test remains pending until the next unlock/restart. Full local-install and audit data is in [`local-desktop-memory-audit.json`](./local-desktop-memory-audit.json).
