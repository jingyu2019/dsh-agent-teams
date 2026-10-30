# DSH Agent Teams — Open Issue Triage Synthesis

Date: 2026-10-30 (Asia/Shanghai)

## 2026-10-31 delta

Two new installation reports arrived after the original audit:

| # | Decision | Evidence | Slice |
|---:|---|---|---|
| 322 | duplicate root cause of #327 | Same rc.5 compatibility rejection | W0-COMPAT |
| 323 | duplicate root cause of #327 | Same rc.5 compatibility rejection | W0-COMPAT |
| 325 | duplicate root cause of #327 | Same rc.5 compatibility rejection | W0-COMPAT |
| 326 | duplicate root cause of #327 | Same rc.5 compatibility rejection | W0-COMPAT |
| 327 | accepted, fixed in this fork | DSH `0.2.1-rc.5` rejects `@latest`; exact host install reproduced and passed from the packed artifact | W0-COMPAT |
| 328 | duplicate root cause of #327 | Same rc.5 compatibility rejection on Windows | W0-COMPAT |

Additional items resolved after the original audit:

- **#314** already fixed by the 0.1.28 `engines.dsh` minimum-version declaration.
- **#223** resolved: preset picker, next-turn model routing and confirmed archived-team deletion.
- **#96** resolved with opt-in `toolSurface: core`, which keeps a stable compact captain surface.
- **#117** plugin-side lock-table growth was fixed in the 0.1.16 line; the remaining host-side memory question still needs RSS/heapUsed samples.
- **#162 / #241** provide an explicit context reset for idle members; host-driven automatic compaction remains a separate host capability.
- **#317** is a duplicate token-complaint root cause addressed by #96, per-member model routing, and the lighter invoke-profile path.

Current open non-PR state (2026-10-31): **48 issues** — 29 accepted/fixed in this fork, 9 duplicate, 4 already fixed, 3 out of scope, and 3 still evidence-gated (`#117`, `#151`, `#190`). The evidence-gated three require host memory samples, package identity, or compact traces respectively.

`compatibility.json` now includes exact rc.4 and rc.5 targets. The real `plugin-manager-install` and `progressive-entry` checks pass on rc.5; evidence is in [`docs/harness-0.2.1-rc.5/`](./harness-0.2.1-rc.5/README.md).

## Baseline

- Fork: `jingyu2019/dsh-agent-teams`
- Upstream: `NanmiCoder/dsh-agent-teams`
- Audited main: `c059636e541f9af644bded8a5e46cca0420c7451` (`0.1.27`)
- Local synthetic baseline commit: `0e624af` (content-matched to the upstream tree; upstream object history is not present locally)
- Node: `v26.12.1`
- pnpm: `11.25.0`
- `pnpm typecheck`: passed
- `pnpm verify`: exit 0; 690 custom `PASS` lines + 301 Node test checkmarks, 0 observed failure lines. The repository uses a composite verifier, so this is not a single test-count number.
- Dependencies installed with `pnpm install --frozen-lockfile`.
- No product source/test/doc files were modified by the three audit members.

## Decisions

| Decision | Count | Issues |
|---|---:|---|
| Accepted into development backlog | 24 | 316, 305, 260, 259, 308, 272, 103, 97, 76, 114, 62, 165, 121, 58, 70, 263, 244, 243, 238, 211, 195, 279, 315, 287 |
| Needs evidence / design decision before coding | 9 | 317, 314, 162, 117, 151, 96, 223, 241, 190 |
| Duplicate | 3 | 311, 312, 237 |
| Already fixed on audited main | 3 | 313, 270, 208 |
| Out of scope for this fork | 3 | 71, 268, 269 |

All 42 open non-PR issues appear exactly once below.

## Decision Matrix

| # | Decision | Evidence / reason | Slice | Priority | Related PR |
|---:|---|---|---|---|---|
| 317 | needs-evidence | No version/workload/token ledger; broad optimization is unverifiable | EVAL-TOKEN | P2 | #48 historical only |
| 316 | accepted | 0.1.27 peers stop at rc.3; clean rc.4 install is rejected | W0-COMPAT | P0 | #318 |
| 315 | accepted, design split | Reusable global agent presets vs live cross-team sessions are different products | W7-AGENT-LIBRARY | P3 | none |
| 314 | needs-evidence | Installer failure lacks version and `pnpm.log`; cannot distinguish network/mirror/version issue | EVAL-INSTALL | P2 | none |
| 313 | already-fixed | 0.1.27 declares rc.3 support; bare `@latest` can lag 24h | W0-COMPAT | P3 | #294 stale |
| 312 | duplicate | Same rc.3/0.1.26 compatibility rejection as #313/#311 | W0-COMPAT | P3 | #294 stale |
| 311 | duplicate | Same rc.3/0.1.26 compatibility rejection as #313/#312 | W0-COMPAT | P3 | #294 stale |
| 308 | accepted | `activation.result` stopReason is discarded; non-completed turn leaves open attempt forever | W1-LIFECYCLE | P0 | #301 partial |
| 305 | accepted | Running-team create accepts blank/whitespace subject; independently reproduced | W0-COMPAT | P0 | #307 |
| 287 | accepted, multi-phase | No task/member working-directory/worktree binding | W7-WORKTREE | P3 | none |
| 279 | accepted, split | Three independent UI requests: staged rename, font scale, manual team creation | W5-UI | P2 | none |
| 272 | accepted | Idle member with open attempt is parked silently; captain is not notified | W1-LIFECYCLE | P0 | #301 |
| 270 | already-fixed | `.dagViewport` already has `overflow-x:auto`; keep visual regression only | W5-UI | P3 | none |
| 269 | out-of-scope | External awesome-list PR, not this repository | EXTERNAL | P3 | none |
| 268 | out-of-scope | Reference/discussion about an external memory plugin; no concrete AgentTeams contract | EXTERNAL | P3 | none |
| 263 | accepted | Snapshot has current state only; no durable transition timeline | W5-UI | P2 | none |
| 260 | accepted | `tool_policy` is optional but GPT-family models interpret it as required | W0-COMPAT | P1 | none |
| 259 | accepted | Duplicate status flag; settlement suppression is timestamp-only and not task/attempt-bound | W0-COMPAT (part 1), W1-LIFECYCLE (part 2) | P1 | #303 partial |
| 244 | accepted, narrowed | Profiles and tool policies exist; per-member owner-declared skill binding is absent | W4-COLLAB | P2 | none |
| 243 | accepted | No manual model switch for an idle running member; safe apply-on-next-turn contract needed | W4-COLLAB | P2 | overlaps #223 |
| 241 | needs-evidence | No host/version/reproduction; member compaction may be host-owned | EVAL-CONTEXT | P2 | overlaps #190 |
| 238 | accepted | Profiles cannot be invoked directly without a Team/DAG | W4-COLLAB | P2 | none |
| 237 | duplicate | Overlaps #238 direct invocation and #244 reusable member capability binding | W4-COLLAB | P3 | none |
| 223 | needs-evidence / split | Contains preset UI, runtime model switch, and destructive archive delete; only archive delete is distinct | EVAL-UI | P2 | #243 overlap |
| 211 | accepted as evaluation | No paired success/efficiency evidence against single-agent and ordinary subagents | W6-EVIDENCE | P2 | none |
| 208 | already-fixed, core scope | Owner-declared tool policies and per-member filters shipped; upstream malformed-schema issue remains separate | W0-COMPAT | P3 | delivered #59 |
| 195 | accepted | No deterministic join/collect primitive; captain must poll and stitch | W4-COLLAB | P2 | none |
| 190 | needs-evidence | Screenshots only; compat/compaction behavior and exact host settings are unspecified | EVAL-CONTEXT | P2 | overlaps #241/#114 |
| 165 | accepted | No `dsh-plugin.json` or package entry; admission-aware hosts report missing manifest | W0-COMPAT | P1 | #197 reported |
| 162 | needs-evidence | No token trace; durable-member reuse can grow context, but threshold semantics are unagreed | EVAL-CONTEXT | P2 | overlaps #114 |
| 151 | needs-evidence | Screenshots only; ownership/package not established | EVAL-INCIDENT | P2 | none |
| 121 | accepted | Artwork is a hard-coded allowlist; no safe captain/member/role override | W5-UI | P2 | #67 needs rework |
| 117 | needs-evidence | One plugin lock leak was fixed; OOM is not proven and may be host-side retention | EVAL-MEMORY | P2 | #143 partial |
| 114 | accepted | Durable members have no AgentTeams-level compaction continuity proof | W3-CONTEXT | P1 | none |
| 103 | accepted | Remaining idle→running interleaving can rotate a legitimate attempt | W1-LIFECYCLE | P0 | original #86/#135 partial |
| 97 | accepted | All ready members can dispatch at once; no global concurrency budget | W2-AVAILABILITY | P1 | #144 |
| 96 | needs-evidence | No measured tool/schema token overhead; lazy visibility conflicts with stable-prefix design | EVAL-TOKEN | P2 | #48 related only |
| 76 | accepted, remaining scope | Single-hop fallback exists; ordered chain/cooldown/quota/budget visibility remains | W2-AVAILABILITY | P1 | partial fixes merged |
| 71 | out-of-scope | Multi-command dispatch and command metadata localization require a newer host contract | EXTERNAL-HOST | P3 | none |
| 70 | accepted | Mailbox messages are text-only; complete attachment persistence/security/UI contract needed | W5-UI | P2 | none |
| 62 | accepted, split | Event-driven scheduler exists; persistent probes and opt-in Parallel Emission are absent | W3-CONTEXT (probes), W2-AVAILABILITY (parallel emission) | P2 | #48 unsafe as-is, #147 partial |
| 58 | accepted, narrow | Basic art/text/reduced motion exists; reusable status renderer contract is absent | W5-UI | P2 | none |

## Development Slices (dependency order)

### W0-COMPAT — Distribution and low-risk integrity

Issues: **316, 305, 260, 259 (part 1), 165**; verification-only: **313/311/312, 270, 208**.

Acceptance:
- rc.4 is an exact supported preview target with all 21 DSH peers regenerated; rc.2 remains recommended.
- Blank/whitespace/non-string task subject is rejected before state mutation; valid subject is preserved verbatim.
- `tool_policy` schemas are visibly optional and blank means omitted; unknown non-empty IDs still fail atomically.
- Status flags are deduplicated while preserving first-occurrence order.
- `dsh-plugin.json` is generated/validated from package metadata and shipped in the tarball.
- Already-fixed items get reproducible closure evidence; they do not consume implementation time.

### W1-LIFECYCLE — Stuck, parked, and stale attempts

Issues: **308, 272, 103, 259 (part 2)**.

Acceptance:
- Non-completed activation settlement fails only the exact still-open attempt, not a later generation.
- A parked idle attempt produces exactly one durable captain notice with member/task/attempt and recovery guidance.
- The idle→running interleaving cannot rotate or invalidate a legitimate attempt.
- Completion settlement suppression is bound to task + attempt + explicit final/progress kind, never timestamp alone.
- Completed results, normal long-lived turns, reassignments, and late results are covered by regression tests.

### W2-AVAILABILITY — Concurrency, fallback, and bounded recovery

Issues: **97, 76, 62 (Parallel Emission half)**.

Acceptance:
- `maxConcurrentWorkers` caps active member turns; every success/failure/cancel/halt releases the permit exactly once.
- Ordered fallback chains, cooldown, permanent-quota handling, and actionable failure history are durable.
- 429 recovery is bounded and fake-clock testable; permanent quota failure is not retried forever.
- Parallel Emission is opt-in, defaults off, and does not weaken dependency validation.

### W3-CONTEXT — Context lifecycle and sparse probes

Issues: **114, 62 (probe half)**; evidence gates: **162, 190, 241, 117, 96, 317**.

Acceptance:
- Host compaction is exercised on a durable member and preserves member identity, task, attempt, mailbox, and cold restore.
- Minimal presets degrade explicitly when compaction is unavailable.
- `nextProbeAt` is persisted, fake-clock tested, idempotent, and never rotates a parked attempt.
- Evidence-gated issues remain out of implementation until the requested measurements/reproductions arrive.

### W4-COLLAB — Direct invocation, member route changes, and aggregation

Issues: **195, 238, 244, 243**; **211** supplies evaluation evidence.

Acceptance:
- Direct profile-member invocation creates no Team/DAG/task directories and starts only requested members.
- Running idle member route changes apply on the next turn and preserve attempt continuity.
- Per-member owner-declared skill sets are validated before spawn and re-applied on cold resume.
- Deterministic join/collect returns stable ordered task outputs and emits one idempotent all-terminal notice.
- Paired evaluation evidence compares single-agent, ordinary subagent, and AgentTeams modes.

### W5-UI — Timeline, status renderer, safe attachments, and customization

Issues: **263, 58, 70, 121, 279**; visual regression: **270**.

Acceptance:
- Durable bounded activity timeline survives reload/archive and does not duplicate on polling.
- Status renderer covers idle/working/waiting/completed/failed/cancelled with accessible text and reduced motion.
- Attachments are workspace-scoped, canonicalized, MIME/size limited, persist in mailbox, and render through an authenticated path.
- Avatar overrides have strict fallback and no traversal/SSRF.
- Staged-member rename is atomic; font scale follows host or an explicit preference; manual team creation reuses the staged pipeline.
- Dependency DAG horizontal scroll remains visually regression-tested.

### W6-EVIDENCE — Controlled efficiency and reliability evaluation

Issues: **211**; framework for **317/96**.

Acceptance:
- Same task suite is run under single-agent, ordinary-subagent, and AgentTeams modes with identical model/tool/time/retry budgets.
- Raw trials, failures, timeouts, paired IDs, pass rate, wall time, token/cost, and judge criteria are retained.
- Validation recomputes metrics and rejects cherry-picked or incomplete summaries.

### W7-PLATFORM — Reusable agent library and worktree isolation

Issues: **315, 287**; split-out archive deletion from **223** only after its destructive contract is approved.

Acceptance:
- Global reusable agent presets are immutable snapshots for new teams; no live session is silently shared across teams.
- Task-level worktree binding records path/branch/base, prevents collisions, propagates cwd, and exposes cleanup/integration failures.
- Both features are opt-in and preserve current behavior by default.

## Evidence Queue

- **314:** exact installed version + `pnpm.log` + clean rc.3 exact-0.1.27 retry.
- **317:** matched token/tool/schema baseline across 3–5 runs; split captain/member cost.
- **117:** 20+ cycles with RSS/heapUsed/external/handles and heap ownership diff.
- **151:** package identity, host version, request/tool trace, spend cap.
- **162/190/241:** supported-host long-context trace; compaction event presence/absence; intended host vs plugin behavior.
- **314/others:** installer logs must distinguish mirror timeout from compatibility rejection.

## Out-of-scope / duplicate handling

- **311/312:** duplicate of #313; current 0.1.27 supports rc.3.
- **237:** duplicate of #238/#244.
- **268:** external memory-plugin reference, not an AgentTeams contract.
- **269:** external awesome-list submission.
- **71:** blocked by host command registry/locale contract.
- No upstream issue/PR will be modified; all code changes stay in `jingyu2019/dsh-agent-teams`.

## Ambiguities requiring design decisions, not code guesses

1. #308: consume `activation.result` unconditionally vs only for managed activations; must avoid failing a later open attempt from an earlier result.
2. #259: explicit final vs progress marker; task/attempt binding is mandatory.
3. #114/#162/#190/#241: host compaction vs plugin-managed rollover; do not create a competing compactor.
4. #97/#76: whether concurrency permits are scheduler-local or persisted; fallback chain schema and cooldown defaults.
5. #287: worktree ownership/integration/cleanup semantics; destructive operations need explicit approval.
6. #315/#279: preset library vs live global session; manual-team creation surface and staged/tool parity.
7. #70/#121: local-only artifact policy vs remote URL support; default must be local-only and deny SSRF.
