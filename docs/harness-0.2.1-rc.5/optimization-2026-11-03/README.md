# rc.5 full-matrix re-verification after the optimization batch

Date: 2026-11-03 (Asia/Shanghai)

This directory records a real-host **full matrix** run of the post-optimization build. It replaces the earlier three-scenario subset in this folder.

- Host: DeepSeek Harness `0.2.1-rc.5`
- Plugin: `@nanmicoder/dsh-agent-teams@0.1.29` (development build)
- Artifact SHA-256: `facfe4cebd1a7c61a09c8501ffe1c3f879b356a10754f33170a8517b593b0283`
- Node: `v26.12.1`, darwin arm64
- Exact cohort: 296 DSH packages
- Network: npm registry (`registry.npmjs.org`) reachable; real `dsh plugin add` install path
- Result: **passed, 11/11 scenarios**

Scenarios: `lifecycle`, `lifecycle-cold-restore`, `fallback`, `fallback-cold-restore`, `failure`, `captain-idle-wakeup`, `progressive-entry`, `web-approval`, `protocol-compatibility`, `stability`, `plugin-manager-install`.

Only the model is a deterministic fixture; real provider APIs and browser interaction remain outside this check.

## What changed in this batch

- `/state` returns a strong ETag; the browser revalidates with `If-None-Match` and skips unchanged payloads on 304.
- Acknowledged non-final mailbox records are compacted into a bounded `inbox/archive/` file. Unread, malformed, and final-report records stay active, and `appendMailboxOnce` still dedupes against the archive.
- Archived team snapshots are cached by `team.json` mtime+size and evicted on change or deletion (256-entry cap).
- Running/archived snapshots omit staging-only member prompts and task descriptions; snapshots carry the newest 50 timeline entries the panel renders.
- `dsh-agent-teams-memory-trace` samples only OS process metadata for #117-style reports.
- Tests share one bounded `removeTestTree` retry helper.
- The package exports an applicable default plugin object so a loader using `exports.default ?? exports` resolves `apply` (#335).
- `agent_teams_delete` can opt in to archiving member host sessions (#333).

## Desktop profile install

The same artifact was installed with `dsh plugin --profile desktop add file:...`. The installed tree's `lib/index.js`, `lib/member-sessions.js` and `lib/snapshot.js`, `lib/state.js`, `lib/web-routes.js`, `lib/client/activity-monitor.js` and `lib/index.js` are byte-identical to this workspace build. The pre-existing `@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3` incompatibility warning is a third-party package issue already documented in `../README.md`.

## Platform coverage

Still darwin/arm64 only. GitHub Actions is disabled on `jingyu2019/dsh-agent-teams` (the REST dispatch endpoint returns 422 "Actions has been disabled for this repository"), so the repository's Ubuntu/Windows matrix cannot be executed there. That remains an external blocker for cross-platform evidence.
