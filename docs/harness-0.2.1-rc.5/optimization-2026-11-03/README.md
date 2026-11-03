# rc.5 re-verification after the optimization batch

Date: 2026-11-03 (Asia/Shanghai)

This directory records a real-host subset run of the post-optimization build. It is a regression check for the performance changes, not a new full matrix claim.

- Host: DeepSeek Harness `0.2.1-rc.5`
- Plugin: `@nanmicoder/dsh-agent-teams@0.1.29` (development build)
- Artifact SHA-256: `87dc4769535ded20c07f6f0f2285d4d9796cf9d6417d613bc73db97b50fb0e93`
- Node: `v26.12.1`, darwin arm64
- Exact cohort: 296 DSH packages
- Scenarios run: `lifecycle`, `lifecycle-cold-restore`, `plugin-manager-install`
- Result: **passed**

The three scenarios cover managed activation, FIFO delivery, settlement, cold restore, route/reasoning restore, and the real `dsh plugin add` install path. The remaining eight scenarios from the full matrix were not re-run for this artifact; the full-matrix evidence for the 0.1.29 line remains `../result.json`.

## What changed in this batch

- `/state` now returns a strong ETag; the browser revalidates with `If-None-Match` and skips unchanged payloads on 304.
- Acknowledged non-final mailbox records are compacted into a bounded `inbox/archive/` file. Unread, malformed, and final-report records stay active, and `appendMailboxOnce` still dedupes against the archive.
- Archived team snapshots are cached by `team.json` mtime+size and evicted on change or deletion (256-entry cap).
- Running/archived snapshots omit staging-only member prompts and task descriptions; snapshots carry the newest 50 timeline entries the panel renders.
- `dsh-agent-teams-memory-trace` samples only OS process metadata for #117-style reports.
- Tests share one bounded `removeTestTree` retry helper.
