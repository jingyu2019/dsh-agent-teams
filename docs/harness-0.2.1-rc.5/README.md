# Harness 0.2.1-rc.5 compatibility

Date: 2026-10-31 (Asia/Shanghai)

## Result

- Host: `0.2.1-rc.5`
- Plugin: `@nanmicoder/dsh-agent-teams@0.1.28`
- Artifact SHA-256: `1b9dd37f25b998c1a3b9d51f93a2953f374a0a27c0ba6908921cff43f819d0fe`
- Runner: `scripts/harness-runtime-verify.mjs`
- Scenario: `progressive-entry`
- Node: `v26.12.1`, darwin arm64
- Cohort: 296 exact DSH packages
- Result: **passed**

Both required runs passed from the packed artifact:

1. `progressive-entry` — natural, natural-zh, raw-slash, command, profile-command and profile-raw entry cases; all six passed with stable system/tool prefixes.
2. `plugin-manager-install` — the real `dsh plugin add` path installed the exact plugin version.

This directly addresses the rc.5 installation rejection reported in #327/#328. The runtime report is checked in as [`result.json`](./result.json). Only the model is a deterministic fixture; real provider APIs and browser interaction remain outside this check.

## Stability and memory audit

The real DSH `stability` scenario also passes on rc.5 with all 13 checks. The fixture records `process.memoryUsage()` at the start, after each scripted transition and at the end. Over 108 model requests and 15 samples:

- `heapUsed`: 105,416,832 → 106,369,712 bytes (+0.95 MiB, +0.9%)
- `heapTotal`: 149,716,992 → 168,624,128 bytes
- `RSS`: 235,388,928 → 259,899,392 bytes (+24.5 MiB)
- `maxHeapUsed`: 116,684,656 bytes

The heap was bounded in this repeated team lifecycle run; RSS growth is consistent with V8/runtime page retention. The machine-readable summary is [`memory-audit.json`](./memory-audit.json).

## Local desktop install and #117 soak

The final development artifact was installed into the real desktop profile and then copied byte-for-byte into an isolated rc.5 runtime for repeatable testing. The exact installed package passed `stability` (13/13 checks) and a 100-cycle workload with two members and two tasks per cycle. Every cycle was claimed, started, completed, reported and deleted; the fixture forced GC before each memory sample.

- Host control without AgentTeams: `heapUsed` slope **319,707 B/cycle** across 200 ordinary child sessions.
- AgentTeams before the retention repair: **358,803 B/cycle** across 201 sessions.
- AgentTeams after the retention repair: **351,391 B/cycle** across 252 model requests; RSS slope was **−81,465 B/cycle**, `external` rose by 69,716 bytes after startup and then stayed flat at 4,972,409 bytes, and active handles stayed at 25.

The independent heap audit found three plugin-owned unbounded containers: `ancestryCache` (201 entries), `activationRoots` (100) and `activationWorkspaces` (100). The repair bounds the ancestry cache at 256 entries, deletes known session entries during teardown, and adds an explicit activation-context `forgetTeam` path used by team deletion and staged-plan discard. Lifecycle verification now asserts that activation roots/workspaces and pending activation bookkeeping are zero after deletion.

The dominant heap growth is still not plugin-specific. A no-AgentTeams control created and disposed 200 ordinary child sessions and retained the same 128 copies of the large Hindsight skill text (**21,024,768 bytes**) as the AgentTeams run. This points at Harness per-session skill retention rather than the repaired team maps. The soak used a deterministic model and **does not reproduce the reporter’s real-provider OOM**. After unlock, the desktop UI rendered the AgentTeams activity panel for a six-member team and opened the plugin settings page; the session re-locked before the full custom-plugin version list could be scrolled to completion. Full local-install and audit data is in [`local-desktop-memory-audit.json`](./local-desktop-memory-audit.json).
