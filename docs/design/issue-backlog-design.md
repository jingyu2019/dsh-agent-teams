# DSH Agent Teams accepted-issue technical design

Status: design-only revision 5; implementation-ready for W0/W1 event semantics and task-decomposable for W2-W7  
Baseline: content-matched `c059636` / package `0.1.27`, local synthetic commit `0e624af`  
Target repository for all implementation: `jingyu2019/dsh-agent-teams` only  
Design owner: `arch` (t5 initial; t7, t9, t11, and t13 revisions)  
Date: 2026-10-30 (Asia/Shanghai)

## 1. Scope and evidence

This document designs the 24 issues accepted in `.agent-teams/inputs/triage-synthesis.md` and deliberately keeps all evidence-gated, duplicate, already-fixed, and out-of-scope issues outside the implementation backlog. It does not modify source, tests, package metadata, or GitHub.

Sources used:

- `.agent-teams/inputs/triage-synthesis.md`
- `.agent-teams/inputs/reports/t1.md`, `t2.md`, `t3.md`
- Current source/test/doc tree at the synthetic `c059636` baseline
- Open PR views fetched read-only on 2026-10-30: #197, #303, #307, #301, #318, #67, #48, #294

PR reuse decisions:

| PR | Related work | Decision |
|---:|---|---|
| #318 | #316 | Reuse after review/rebase; regenerate peers from `compatibility.json`, then run the real-host matrix against the release tarball. |
| #307 | #305 | Rebase and reuse the guard plus regression tests; add non-string runtime cases missing from the patch. |
| #303 | #259 part 1 | Reuse only the ordered flag de-duplication. It does not solve settlement identity. |
| #301 | #272 | Use as a test/behavior reference, but revise its process-local marker assumptions and unify the notice with W1.1/W1.3. |
| #197 | #165 | Rebase and replace hard-coded `0.1.20` metadata with release-derived validation. |
| #67 | #121 | Do not merge as-is. Reuse the local-artifact ideas only; v1 rejects remote avatar fetching and uses the narrower policy in W5.4. |
| #48 | #62 | Do not merge. It changes prompts and same-response task creation without proving lifecycle safety. |
| #294 | rc.3 duplicate family | Stale; superseded by the rc.4 declaration work. Do not merge. |

## 2. Non-negotiable design rules

1. `team.json` and mailbox JSONL remain the durable truth. Host session events are projections, never required for correctness.
2. Every state transition that can race executes under `withTeamLock`.
3. An attempt capability is immutable until an explicit transition rotates it. Idle status, running status, polling, reads, and native settlement notices never rotate it.
4. Settlement and notice suppression bind to `(taskId, attempt, attemptId, memberId)`, never to wall-clock order alone.
5. New durable fields are optional and additive. Old teams load unchanged; old binaries ignore new fields. No mandatory migration rewrite occurs on read.
6. Security defaults are deny-by-default: no remote fetch, no absolute user paths, no symlink escape, no unauthenticated route, no destructive worktree cleanup.
7. New expensive or behavior-changing runtime features are opt-in where compatibility matters. Conservative fallbacks are always preferred over silently dropping work.
8. A visible failed task is better than an invisible permanent `in_progress` task.

## 3. Accepted backlog: one primary slice per issue

Exactly the 24 accepted issues are assigned one primary slice below. Cross-slice implementation dependencies are named explicitly but do not create a second backlog entry.

| Primary slice | Issues | Priority | Main outcome |
|---|---|---:|---|
| W0-COMPAT | #316, #305, #260, #165 | P0/P1 | Install, validation, schema clarity, release manifest |
| W1-LIFECYCLE | #308, #272, #103, #259 | P0/P1 | Exact-attempt settlement, parking, race safety, report identity |
| W2-AVAILABILITY | #97, #76, #62 | P1/P2 | Concurrency, fallback/recovery, optional parallel emission |
| W3-CONTEXT | #114 | P1 | Host-owned compaction continuity and degraded-mode proof; the sparse-probe half of #62 is a cross-slice dependency |
| W4-COLLAB | #195, #238, #244, #243 | P2 | Collect barrier, direct profile invocation, skills, safe route changes |
| W5-UI | #263, #58, #70, #121, #279 | P2 | Timeline, status renderer, attachments, avatars, customization |
| W6-EVIDENCE | #211 | P2 | Reproducible paired evaluation harness and report validator |
| W7-PLATFORM | #315, #287 | P3 | Immutable reusable agent library, opt-in worktree isolation |

Cross-slice dependencies:

- #259 has a small ordered-flag utility that belongs with W0 compatibility, but its primary issue remains W1 because settlement identity is the substantive risk.
- #62 has a probe half in W3 and a parallel-emission half in W2. Its primary slice is W2.
- #211 supplies measurement practice used by later token/context work, but evidence-gated issues are not implementation dependencies.
- #279 and #315 share a preset picker/service boundary; #279 consumes the W7 library API only after the staged-creation path is stable.
- #121 consumes the same authenticated local-artifact primitive as #70, but avatar and mailbox attachment retention have separate policies.

## 4. Explicitly excluded from implementation

### 4.1 Needs evidence: 9 issues

These are **not immediate implementation items**. They remain in an evidence queue and may be reopened only after their gate is satisfied.

| Issue | Evidence gate | Implementation status |
|---:|---|---|
| #317 | Matched 3-5 run token/tool/schema ledger, split captain/member, same model and task set | Excluded; no optimization code until measured. |
| #314 | Exact installed versions, full installer/`pnpm.log`, clean exact-version retry | Excluded; may be support/config, not code. |
| #162 | Long-context trace with turn/token/compaction evidence on a supported host | Excluded; overlaps #114. |
| #117 | 20+ cycle RSS/heapUsed/external/handles trace and heap ownership diff | Excluded; cannot infer a plugin leak from the issue. |
| #151 | Package identity, host version, attributable request/tool trace, spend cap | Excluded; screenshots alone are insufficient. |
| #96 | Measured tool-schema/system-prompt cost and a stable-prefix product decision | Excluded; lazy visibility conflicts with the cache/tool-prefix design. |
| #223 | Split archived-delete contract; route model switch to #243; prove any missing preset picker | Excluded as a unit. Do not implement archive purge from this issue. |
| #241 | Supported host, exact settings, compaction event/reproduction | Excluded; host ownership is unresolved. |
| #190 | Supported host/version and exact compat/compaction behavior | Excluded; overlaps #114/#241. |

### 4.2 Duplicate: 3 issues

- #311 — duplicate compatibility report covered by already-fixed #313.
- #312 — duplicate compatibility report covered by already-fixed #313.
- #237 — duplicate of direct invocation (#238) and reusable capability binding (#244).

No code is scheduled for these numbers.

### 4.3 Already fixed: 3 issues

- #313 — 0.1.27 declares rc.3 support. Close with a reproducible compatibility check; no new implementation.
- #270 — `.dagViewport` already has `overflow-x: auto`. Keep visual regression coverage only.
- #208 — owner-declared tool policies/per-member filtering already shipped. The separate malformed upstream schema case is not this issue.

### 4.4 Out of scope: 3 issues

- #71 — requires a newer host multi-command registry/localization contract.
- #268 — references an external memory plugin; no AgentTeams contract.
- #269 — external awesome-list submission, not this repository.

No upstream issue or PR will be edited by this delivery.

## 5. W0-COMPAT — direct implementation design

### 5.1 W0.1 — #316 DSH 0.2.1-rc.4 declaration

Files: `compatibility.json`, `package.json`, `scripts/compatibility.test.mjs`, harness compatibility docs, generated peer block.

Contract:

- Add `0.2.1-rc.4` as an exact supported `preview` host in `compatibility.json`.
- Keep `recommendedHost = 0.2.1-rc.2` and the development cohort on rc.2 until the release owner promotes rc.4.
- Regenerate, never hand-edit, all 21 `@deepseek-ai/dsh-*` peer ranges. Every range begins with rc.4 then retains rc.3 and all previously supported versions.
- No host check bypass, `--force`, or plugin-manager override.

Type/utility signatures:

```ts
export interface SupportedHostPolicy {
  version: string
  track: 'recommended' | 'preview' | 'legacy'
  platforms?: string[]
}

export function supportedHostVersions(policy: CompatibilityPolicy): string[]
export function assertPeerRangesInclude(pkg: PackageJson, hosts: readonly string[]): void
```

Acceptance and TDD:

1. `sync:compatibility --check` is clean.
2. `node scripts/compatibility.mjs` and `node --test scripts/compatibility.test.mjs` assert rc.4 appears exactly once and the generated ranges include it.
3. Build one tarball; install the same tarball on clean rc.2/rc.3/rc.4 profiles with compatibility checks enabled.
4. `harness-runtime-verify.mjs` passes ten scenarios on all three hosts.
5. Removing rc.4 from `supportedHosts` or from one peer makes the test fail.
6. Mutation checks: remove rc.4 only from one peer -> fail; add rc.4 while leaving recommendedHost changed -> fail; bypass compatibility -> rejected.

Defaults/rollback: declaration-only; rollback by reverting the compatibility commit. Existing hosts remain supported.

### 5.2 W0.2 — #305 non-empty running-team subject

Files: `src/quality-gates.ts`, tests, generated `lib/quality-gates.js`.

Signature:

```ts
export interface CreateTaskInput {
  subject: unknown // runtime input may be non-string despite the public schema
  // ...
}

export function validateCreateTask(team: TeamState, input: CreateTaskInput): ValidateCreateTaskResult
```

Implementation rule:

```ts
if (typeof input.subject !== 'string' || input.subject.trim() === '') {
  return { ok: false, error: 'task subject must not be empty' }
}
```

The guard must be the first task-body validation, before quality-kind checks, dependency checks, resume-side effects, counter increments, or task creation. The accepted subject is stored verbatim; trimming is validation-only. An error leaves `tasks` and `taskSeq` byte-equivalent.

TDD matrix:

| Input | Expected |
|---|---|
| `''` | `ok:false`, exact error |
| `'   '`, `'\t\n'` | `ok:false` |
| `undefined`, `null`, `42`, `{}` | `ok:false` |
| `'  valid title  '` | `ok:true`, subject preserved exactly |
| valid running-team integration | exactly one increment of `taskSeq` |

Mutation: remove the guard -> each blank/non-string case must fail; trim instead of preserve -> verbatim test must fail.

### 5.3 W0.3 — #260 schema clarity for `tool_policy`

Files: `src/tools.ts`, schema snapshot/regression test.

Public contract:

- Both `agent_teams_create.plan.members[].tool_policy` and `agent_teams_add_member.tool_policy` are not in the schema `required` array.
- Description text says: “Optional owner-declared tool-policy id. Omit when no policy is needed. Never invent an id; an unknown non-empty id is rejected atomically.”
- Usage prompt repeats the same rule once.
- `undefined`, missing, `''`, and whitespace-only normalize to “no policy”. Unknown non-empty values fail before state mutation.

No new tool-policy type is needed. A pure normalization helper is sufficient:

```ts
export function optionalToolPolicyId(value: unknown): string | undefined
```

TDD:

1. Serialize registered tool schemas; assert `required` excludes `tool_policy` for both paths.
2. Description snapshot contains “Omit” and “Never invent”.
3. Handler tests: omitted, `undefined`, `''`, `'  '` -> no policy; `'researcher-safe'` -> selected; `'missing'` -> no team/member file mutation.
4. Opt-in GPT-family smoke creates a staged plan with no `tool_policy` and verifies no guessed policy appears.

Mutation: make the field required -> schema test fails; keep blank as a literal policy id -> handler test fails; mutate invalid-id call to partially write -> atomicity test fails.

### 5.4 W0.4 — #165 `dsh-plugin.json`

Files: root `dsh-plugin.json`, `package.json.files`, release test.

Decision: ship a static manifest, but generate/validate volatile values from `package.json` in verification so the version cannot drift. Do not hand-maintain a second version string in the release artifact.

```ts
export interface DshPluginManifestV015 {
  manifestVersion: '0.15'
  id: 'com.nanmicoder.agent-teams'
  name: string
  version: string
  license: string
  source: string
  facets: { host: { entry: string; apiVersion: 'v1alpha1' } }
  requires: { contracts: Array<{ apiVersion: string; kind: string }> }
  permissions: Array<{ name: string; scope: string; reason: string }>
  contributions?: unknown
  subscriptions: []
}

export function assertManifestMatchesPackage(manifest: DshPluginManifestV015, pkg: PackageJson): string[]
```

Acceptance:

1. `npm pack` / `pnpm pack` contains root `dsh-plugin.json`.
2. Manifest `name`, `version`, `license`, `facets.host.entry`, and `source` agree with `package.json`.
3. Manifest validates against the v0.15 schema used by the admission fixture.
4. `manifestFound=true` on a supported admission host.
5. Removing the `files` entry or changing one version makes release verification fail.
6. Runtime loading remains cordis-only; the manifest is metadata.

Rollout: low-risk, always enabled. Rollback: remove the file/files entry and revert tests; no durable state impact.

### 5.5 W0.5 — #259 part 1 ordered flag de-duplication

Files: `src/tools.ts`, a pure utility module if preferred.

```ts
export function orderedUniqueStrings(values: readonly (string | undefined)[]): string[]
```

Rule: drop `undefined`, preserve first occurrence byte-for-byte, retain distinct order. Render `deliverable` exactly once when `team.deliverable === true` and `loop_state === 'deliverable'`.

TDD/mutation:

- `[halted, escalated, deliverable, blocked]` renders all four in order.
- `[deliverable, deliverable]` renders one.
- Duplicate suppression must not sort or case-fold.
- Removing `Set/indexOf` check -> duplicate test fails.

This utility is merged before W1.4, but #259 remains primarily a W1 lifecycle issue because timestamp-only settlement suppression is the higher-risk contract.

## 6. W1-LIFECYCLE — direct implementation design, revision 5

This revision replaces Revision 2's invalid cold-resume assumption. On rc.2, `startActivation({childId})` reserves a **new** child and rejects an existing persisted child with `DUPLICATE_CHILD`. Existing children cold-resume through `sendMessage`/`queuePrompt`/`steerPrompt`, which returns only a `MessageId`. Therefore the canonical settlement for both new and resumed runs is the public `subagent/start` / `subagent/end` lifecycle pair keyed by `runId`, not a result promise available only for new children.

Revision 5 closes BOUNDARY4-001 in addition to RESERVE3-001, CRASH3-001, and DIAG3-001. The pre-dispatch boundary is an inclusive half-open snapshot start: on rc.2 `Session.seq` is already the next event offset/log length, so live children store exactly `SessionLogOffset(session.seq)` and persisted observations store `events.length`/next offset. Recovery reads from that offset inclusively.

### 6.1 Host contract split: new child versus resumed child

| Path | Host API | Accept receipt | Canonical terminal signal |
|---|---|---|---|
| New child | plugin-reserved/durably checked `childId` passed to `startActivation` | returned `messageId`, `result`, `dispose` | `subagent/end`; `result` is a diagnostic/dedupe fallback |
| Existing/cold-resume child | `sendMessage` -> `queuePrompt`/`steerPrompt` -> `coldResume` | returned `MessageId` | `subagent/end` |
| Bootstrap child | plugin-reserved/durably checked `childId` passed to `startActivation` | same as new child | `subagent/end` |
| Cancellation | `dispose` for owned new activation; exact `drainChildren` for resumed child | drain/dispose promise | exact `subagent/end`, or exact drain/dispose completion |

No code path calls `startActivation` with an existing/persisted child id. A new child id is reserved by the plugin and proven absent before the call.

### 6.2 Durable activation/run model

```ts
export type ActivationPurpose = 'bootstrap' | 'task' | 'mailbox'

export type ActivationState =
  | 'pending'     // durable intent, before host delivery
  | 'started'     // subagent/start bound this lease to a host runId
  | 'ended'       // subagent/end observed; task decision applied
  | 'rejected'    // host delivery rejected before publication
  | 'recovering'  // restart lost the live event, task/permit still unresolved
  | 'orphaned'    // restart without an observable end/drain
  | 'released'    // permit and lease closed

export interface ActivationLease {
  activationId: string       // plugin UUID embedded in the task prompt
  dispatchToken: string      // opaque correlation token embedded in prompt
  teamId: string
  memberId: string
  memberGeneration: number
  activationEpoch: number    // monotonic per team
  purpose: ActivationPurpose
  taskId?: string
  attempt?: number
  attemptId?: string
  hostRunId?: string         // SubagentRunInfo.runId from subagent/start
  hostMessageId?: string     // MessageId returned by sendMessage, if any
  preDispatchSessionSeq: number // inclusive half-open snapshot start; rc.2 Session.seq/events.length before delivery
  startObserved: boolean      // durable subagent/start marker
  endObserved: boolean        // durable subagent/end marker
  turnEndObserved?: { reason: string; seq?: number }
  recoveryDecision?: 'none' | 'rolled_back' | 'synthesized_end' | 'orphaned_parked'
  state: ActivationState
  permitHeld: boolean
  createdAt: number
  startedAt?: number
  endedAt?: number
  releasedAt?: number
  stopReason?: 'completed' | 'max-tokens' | 'aborted' | 'error' | 'refusal' | 'unknown'
  lastAssistantMessage?: string // bounded preview, never raw full transcript
  diagnostic?: string          // bounded, from request-error/agent/error/result
}

export interface TeamState {
  activationSeq: number
  activations: ActivationLease[] // active + bounded recent history
  notificationSeq: number
  notifications: NotificationLedgerEntry[]
}

export interface TeamMember {
  generation?: number
  currentActivationId?: string
  lastActivationEpoch?: number
}

export interface TeamTask {
  attemptMemberId?: string
  attemptGeneration?: number
  attemptActivationId?: string
  attemptActivationEpoch?: number
}
```

All fields are optional/additive for legacy teams. Old members normalize to generation 1. No read-time rewrite occurs.

### 6.3 Process-local mappings and event-lane serialization

The host events expose objects, not durable activation ids. The runtime therefore owns a non-durable correlation index:

```ts
interface AgentRunBinding {
  teamId: string
  activationId: string
  hostRunId: string
  memberId: string
  memberGeneration: number
  activationEpoch: number
}

const agentRuns = new WeakMap<Agent, AgentRunBinding>()
const runToActivation = new Map<string, { teamId: string; activationId: string }>()
const pendingByChild = new Map<string, { teamId: string; activationId: string }>()
const childLifecycleLane = new Map<string, Promise<unknown>>()
const failureByRunId = new Map<string, { code: string; detail: string; at: number }>()
// Each process map is bounded/cleaned when the corresponding run is released.
```

Rules:

- For a brand-new member, reserve `SessionId(randomUUID())` as `member.id`/childId, prove it absent through the host persistence service, set `pendingByChild`, and then call `startActivation({ childId })`. Never call a new-child start without a durable childId.
- `subagent/start` binds exactly one pending lease for `info.id` to `info.runId`; if zero or more than one pending lease exists, quarantine the event, keep the permit held, and emit a diagnostic notice.
- The exact live Agent is resolved with `ctx.agents.get(info.id)` during the start notification and stored in `agentRuns`.
- All `subagent/start`/`subagent/end` work is serialized per `info.id` with `childLifecycleLane`. This prevents an asynchronous start handler from being overwritten by a fast end handler.
- `agent/status`, `agent/request-error`, and `agent/error` use `agentRuns.get(payload.agent)`; they never infer a run from member name or the durable latest attempt.

### 6.4 New-child protocol

1. Under `withTeamLock`, verify the exact member generation/task attempt. Generate `reservedChildId = SessionId(randomUUID())`, set `member.id = reservedChildId`, check `sessionPersistence.stat(reservedChildId)` is absent, reserve one activation permit, allocate `activationId`/`activationEpoch`/`dispatchToken`, persist a `pending` lease with `preDispatchSessionSeq = 0`, and bind the task attempt to `attemptMemberId = reservedChildId`. Write `team.json`.
2. Call `startActivation` with the reserved `childId`. `subagent/start` fires during materialization; because `pendingByChild[reservedChildId]` already exists, it binds `hostRunId` deterministically. A `DUPLICATE_CHILD` or any concurrent reservation conflict marks the member spawn failed; never reuse a persisted id.
3. Await the returned activation. Record `messageId`, `result`, and `dispose` in the process cache, then reconcile:
   - if the exact run already ended, keep `ended` and only record the message id;
   - if the lease is still `started`, keep it current;
   - if `startActivation` rejects before start, mark `rejected`, release the permit, and roll back the exact pending task attempt.
4. Register a `result` handler as a durability/dedupe fallback. For new children, `result` is not the authority when `end` already arrived. A result for a run already `ended` only fills missing bounded diagnostic/output.
5. If `result` resolves but the matching end is missing, call `dispose()` for that exact activation and apply the same exact-run reconciliation after disposal. Never release on a guessed idle state.
6. Two concurrent new children use independent random child ids; each pending lease is keyed by its own reserved id. No host-allocated childId is needed for first-start correlation, and lane buffers are removed after release.

### 6.5 Existing-child/cold-resume protocol

1. Persist the `pending` lease and task attempt exactly as above. Set `preDispatchSessionSeq` to the inclusive half-open snapshot start before calling the host. For a live child store exactly `SessionLogOffset(session.seq)`; rc.2 `Session.seq` is already the next event offset/log length. For an observed persisted session store `events.length`/the query-returned next offset. Never add one.
2. Deliver with `sendMessage` through the existing `deliverToMember` seam. `subagent/start` fires before or while the send promise resolves. The start handler stores `hostRunId` and the exact live Agent in the WeakMap.
3. The send promise returns a `MessageId`; persist it as `hostMessageId` without changing a run that already ended. A fast end before this await is valid and must not be overwritten.
4. The end handler is the canonical settlement. It is idempotent by `(hostRunId, childId, activationId)`.
5. If send rejects after `subagent/start`, run the exact drain path for the child; wait for end or drain completion, then release once. If send rejects before start, mark `rejected` and roll back.
6. Do not call `startActivation({childId})` for an existing child. There is no result/dispose promise on this path.

### 6.6 `subagent/start` and `subagent/end` handlers

```ts
ctx.on('subagent/start', (info: SubagentRunInfo) => {
  // lane by info.id; read pendingByChild; persist hostRunId; map live Agent
})

ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
  // lane by info.id; resolve by runId; persist stopReason/output;
  // release permit; apply task/route/notification decision exactly once
})
```

Start handler requirements:

- Match `info.id` to the reserved/known member child id and require exactly one pending lease for that child. For a new child the reserved id closes the pre-return start-event gap.
- Persist `hostRunId=info.runId`, `state='started'`, `startedAt`.
- Resolve the live Agent from `ctx.agents.get(info.id)`; set `agentRuns` and `runToActivation`.
- If the Agent is not live, mark the lease `recovering` and keep the permit; do not release on a stale event.

End handler requirements:

- Resolve the lease by `hostRunId`; `runId` is the dedupe key, not `childId` alone.
- Mark `state='ended'`, `endedAt`, `endObserved=true`, `stopReason`, bounded `lastAssistantMessage`, and an optional diagnostic.
- `subagent/end.stopReason` is the sole success/failure authority. `completed` with no diagnostic is a valid completed settlement. A non-completed stop reason follows task/route failure handling whether or not a diagnostic exists. Only a missing/unknown stopReason becomes `settlement_unknown` and fails closed. `agent/request-error`/`agent/error` are optional diagnostic sources mapped through the same exact-Agent WeakMap.
- Release the activation permit exactly once after the end event. On rc.2, the end event is emitted after teardown; therefore end is the exact quiescence signal for both new and resumed runs.
- Apply task semantics only to the exact `(taskId, attemptId, memberId, generation, hostRunId, activationId)`:
  - exact completed end + open task -> park/notice;
  - route-recoverable failure -> leave the same attempt waiting for the next route activation;
  - terminal failure/unknown -> fail exact attempt and notify once;
  - already terminal -> audit only; no task mutation.
- Duplicate end is ignored after the first exact transition.
- An old runId end arriving after reassignment is audit-only and cannot fail the new attempt.

Fast-end reconciliation:

- `subagent/start` may bind a lease and `subagent/end` may arrive before `sendMessage` resolves or before `startActivation` returns. The start/end handlers are lane-serialized; the send/start await only records the `MessageId`/result/dispose afterward. It never resets an `ended` lease.
- During live execution, lifecycle `runId` is the settlement authority; prompt tokens are diagnostics. Restart recovery may use the exact dispatch token only to locate the post-boundary prompt/turn. The task outcome still comes from `subagent/end` or a valid `turn/end`, otherwise orphan/park/fail closed; token presence alone cannot declare success.

### 6.7 Restart recovery and stale Agents — CRASH3-001 / CONC2-001 / RACE2-001

`agent/status` payload has no runId. Display and parking decisions therefore resolve through the exact Agent object:

```ts
export function classifyStatusEdge(
  agent: Agent,
  binding: AgentRunBinding | undefined,
  current: Pick<TeamMember, 'currentActivationId'>,
  lease: Pick<ActivationLease, 'hostRunId' | 'state' | 'permitHeld'> | undefined,
): 'current' | 'stale'
```

- `agentRuns.get(payload.agent)` must match the current lease's `hostRunId` and activation id; otherwise ignore the edge.
- An old Agent's delayed idle edge has no current WeakMap entry or points to an ended/released run -> stale. It cannot park a new attempt or overwrite display.
- Status is never the authority for terminalization or permit release.

#### Durable pre-dispatch boundary

Before every new or resumed delivery, the pending lease stores:

```ts
interface ActivationRecoveryMarkers {
  preDispatchSessionSeq: number // inclusive half-open snapshot start (next absolute event offset/log length)
  dispatchToken: string         // appears in the exact task prompt
  startObserved: boolean
  endObserved: boolean
  promptCommittedAt?: number
  turnStartObservedSeq?: number
  turnEndObserved?: { reason: string; seq?: number }
  recoveryDecision?: 'none' | 'rolled_back' | 'synthesized_end' | 'orphaned_parked'
}
```

For a new child the boundary is `0`. For an existing live child store exactly `SessionLogOffset(session.seq)`; rc.2 `Session.seq` is already the next event offset (`always the log length`), not the last sequence. For a persisted/observed session store `events.length` or the query-returned next offset. The boundary is an inclusive half-open snapshot start; never add one.

`subagent/start` sets `startObserved=true` and persists `hostRunId`; `subagent/end` sets `endObserved=true` and persists `stopReason`. `agent/status` and `agent/end` never rely on these process maps alone. The maps are cleaned after release, bounded by active/run history.

#### Restart procedure

On plugin mount and after a crash, `recoverActivationLedger` takes the per-child lifecycle lane, loads the durable lease, and reads child-owned events from `preDispatchSessionSeq` inclusively through `snapshotEvents(preDispatchSessionSeq)` or the equivalent inclusive query slice. It applies the inherited-seed prefix separately and never treats seed events as dispatch evidence. It compares-and-sets by `(activationId, hostRunId?)`; an event for another run is ignored.

The branch matrix is mandatory:

| Observation from boundary inclusive | Decision |
|---|---|
| No `startObserved`, no `endObserved`, no `hostMessageId`, no matching `user/message`, no `turn/start`, and no admission record after boundary; setup/descriptor/system-only events do not count | No accepted prompt: roll back exact task/member state and release permit. |
| `endObserved` is true with a valid persisted `stopReason` | Synthesize/apply the exact end outcome once if not already applied, then release. Diagnostic is optional. |
| Exactly one matching prompt and committed `turn/end` with valid reason | Synthesize one exact outcome from the turn-end reason, set `turnEndObserved`, apply task/route/parking policy, then release. |
| Matching prompt/`turn/start` or `startObserved`/`hostMessageId`, but no committed `turn/end` | Mark orphaned, park the exact attempt, write the ledger notice first, then release; if the live Agent is still running, keep `recovering` and do not release. |
| Any post-boundary prompt/turn event that cannot be tied to exactly one activation token | Ambiguous: orphaned/park/notice; never silent release. |
| Multiple matching turn/end records or two runIds for one lease | Ambiguous: orphaned/park/notice; never pick by timestamp. |
| Child live and running without committed end | Keep `recovering`/permit; wait for exact end or explicit drain. |
| Child idle/absent without end | Exact `drainChildren(captain, [childId])`; after drain completion, rescan once. If still no committed end, orphan/park/notice before release. |
| Task is already terminal for the same attempt | Record recovery/end audit only; never reopen/rotate; release after the corresponding exact end/recovery decision. |

Outcome synthesis maps the durable turn-end reason to the exact `stopReason`:

- `completed` -> `completed` (success even with no diagnostic);
- `max-tokens` -> `max-tokens`;
- `aborted` -> `aborted`;
- `error`/`blocked` -> `error`, diagnostic from `turn/end.error` when present;
- `interrupted`/`forked`/unknown extension -> `unknown`/parked recovery, never success.

Every synthesized outcome carries a deterministic `synthesized_outcome:<activationId>` CAS marker, so a late `subagent/end` or repeated restart cannot apply a second task transition or second notice. A persisted `endObserved` always wins over turn-log synthesis.

No path releases a permit before the task decision is durably represented:

- rollback -> exact pre-dispatch state;
- synthesized end -> task/route/parking decision committed;
- orphan -> parked exact attempt plus ledger notice pending;
- live running -> permit retained.

This is the CRASH3-001 barrier that prevents a released permit with a zombie open task.

Permit release is exactly one of:

- exact `subagent/end` after teardown;
- exact `dispose()` of a new activation;
- exact `drainChildren` completion for a resumed child;
- reject/rollback before publication;
- restart-recovery decision after the durable state transition and notice obligation are committed.

No release occurs on task completion, idle, timeout alone, or member-name match.

### 6.8 Notification ledger, parking, and report grace

The durable notification outbox from Revision 2 remains valid: `NotificationLedgerEntry` has deterministic id/message id, `Pending -> appended -> delivered/read/superseded` states, `noticeDueAt`, and crash-recovery append/adopt. Parking and terminal-failure notifications use one outcome key per exact attempt/run; pending notices can be promoted/superseded before append.

`TaskParking` remains exact to member generation/activation/attempt and carries `noticeDueAt`. A completed end with an open task creates a parked-notice obligation; terminal update/reassign/cancel clears or supersedes it. Recovery appends at most one deterministic mailbox row.

Final-report settlement handling:

- `reportKind`/`sourceMemberId`/`sourceMemberGeneration`/`sourceActivationId`/`sourceActivationEpoch` remain durable.
- `isReadableSourceMail` remains independent of `sourceTaskStatus`; a final sent while `in_progress` stays readable after `completed`.
- `isFinalReportForSettlement` remains exact to task, attempt, member generation, activation epoch, and final kind.
- `FINAL_REPORT_GRACE_MS` is a bounded best-effort hold (default 500ms, max 2s) in `agent/pre-step` for a native success settlement. During the hold, re-read the exact mailbox and suppress the native wake if the matching final arrives.
- If the native settlement was already admitted before the final arrived, the final may cause one conservative duplicate wake. This is an explicit best-effort limitation, not an exactly-once claim beyond the grace window.
- NATIVE settlement pre-step before final is tested; the implementation must never discard an already admitted user message.
- Progress reports never suppress; failed/aborted endings never suppress.

### 6.9 TDD, race, crash, and diagnostic matrix

RESERVE3-001:

1. Reserve a random durable `SessionId`, persist it on the member/pending lease, and prove persistence `.stat(id)` is absent before `startActivation({childId})`.
2. `subagent/start` fires before `startActivation` resolves and binds through the already-known reserved child id.
3. Two concurrent new children receive distinct ids; their start/end lanes do not cross-bind.
4. A pre-existing persisted child id -> `DUPLICATE_CHILD`/fail closed; never reuse or overwrite.
5. Fast end before `startActivation` resolves preserves the end and does not orphan a valid new child.
6. Start-event/result/end duplicate for the same runId is idempotent; lane-buffer entries are cleaned.

ACT2-001:

1. Existing child uses `sendMessage`; no `startActivation({childId})` call is used for resume.
2. `subagent/end` may fire before `sendMessage` resolves; final state remains `ended`.
3. `subagent/end` may fire before `startActivation` resolves; result handler only dedupes by `runId`.
4. Missing end after result/dispose -> exact fallback transition.
5. Duplicate end, old runId, old Agent, process restart, max-tokens, completed-without-diagnostic.

CRASH3-001:

1. Crash after pending lease before delivery and no prompt/turn/admission evidence after boundary (setup/system events ignored) -> rollback exact pre-dispatch state and release.
2. Crash after prompt commit but before start bookkeeping -> boundary scan finds matching token/turn start; do not rollback committed work.
3. Crash after start event but before startObserved persistence -> boundary/lifecycle reconciliation binds or parks, not silent release.
4. Crash after committed `turn/end` but before end handler -> synthesize from turn-end reason once and apply task/route/parking policy.
5. Crash after endObserved/task terminal but before release -> repeat recovery is CAS-idempotent and releases once.
6. Accepted/running with no end and no committed turn/end -> orphaned, park exact attempt, write notice ledger first, then release.
7. Two matching prompts/turn ends or unknown activation token -> fail closed, park/notice, never pick by timestamp.
8. Boundary regression: first post-boundary event is matching `user/message` at exactly `preDispatchSessionSeq` -> included.
9. Boundary regression: first post-boundary event is `turn/start` at exactly `preDispatchSessionSeq` -> included.
10. Empty post-boundary log -> no accepted prompt, rollback only with all other markers absent.
11. Child with inherited seed prefix -> seed events are excluded by the boundary and never count as evidence.
12. Only one post-boundary `turn/end` -> synthesizes exactly one exact outcome, not a rollback.

RACE2-001:

- Old Agent idle after new Agent start -> WeakMap miss/stale; no park or display overwrite.
- End then delayed idle old Agent -> ignored.
- Current Agent idle -> display-only; no task mutation.

CONC2-001:

- Task activation, mailbox cold resume, and bootstrap each acquire a permit.
- End before send resolution releases exactly once after teardown.
- Cancel/drain releases only after exact drain.
- Restart with a live running child keeps recovering/permit; idle/absent takes exact drain/release; no event replay leak.

FALL2-001:

- `agent/request-error` resolves the exact run through `agentRuns`; route failure stored on that run.
- Route-owned failure returns `undefined` (does not call `next()`), suppressing host retry.
- `retryPolicy=always` still causes exactly one current activation end; next activation starts only from persisted RouteCursor.
- Old Agent error, end-before-error, crash at every route transition.

REPORT2-001:

- final inside grace suppresses native settlement;
- final after grace may cause one documented duplicate wake;
- final-before-update, live steer then complete, restart/read, old attempt/member all correct;
- progress-only and failed ending never suppress.

DIAG3-001:

1. `stopReason='completed'` with no diagnostic -> valid success, completed task/parking as applicable.
2. `stopReason='max-tokens'` with no diagnostic -> failure/park according to task policy.
3. Missing or unknown `stopReason` -> `settlement_unknown` fail closed.
4. A diagnostic without a stopReason cannot establish success or failure.
5. Turn-log synthesis with a valid `turn/end.reason` follows the same precedence.

Mutation checks (restore byte-for-byte):

1. Call new-child `startActivation` without a reserved child id -> RESERVE3 tests fail.
2. Use host-allocated childId for first-start binding -> fast-start/concurrent-new-child tests fail.
3. Drop `preDispatchSessionSeq` -> CRASH3 committed/rollback classification fails.
4. Store `session.seq + 1` instead of `session.seq` -> BOUNDARY4 first-event tests fail.
5. Release permit before orphan notice/task decision -> CRASH3/CRASH3 zombie test fails.
6. Treat missing diagnostic as failure -> completed-without-diagnostic test fails.
7. Treat missing stopReason as completed -> DIAG3 unknown test fails.
8. Use `startActivation({childId})` for resume -> duplicate-child test fails.
9. Treat sendMessage as terminal -> missing-end test fails.
10. Release permit on idle -> CONC2 quiescence test fails.
11. Resolve request-error by member name -> old-Agent test fails.
12. Call `next()` on route-owned failure -> retry-policy desync test fails.
13. Replace grace with timestamp-only suppression -> REPORT2 final-after-grace/failed-ending tests fail.

### 6.10 Defaults, compatibility, rollback

- New children and resumed children both use lifecycle events in the first implementation.
- `stopReason` is required authority. `completed` without diagnostic is successful; non-completed without diagnostic still follows that stopReason. Only missing/unknown `stopReason` becomes `settlement_unknown` and fails closed.
- Legacy teams without lease fields load as generation 1; the next exact start/end creates the new fields. No automatic task migration is invented.
- `FINAL_REPORT_GRACE_MS=500` is bounded best-effort; no unbounded mailbox wait.
- Rollback removes lifecycle handlers and returns to prior behavior; no orphan lease is rewritten as success. Worktrees/notifications remain independently recoverable.

## 7. W2-AVAILABILITY — implementation decomposition, revision 4

This revision preserves CONC2-001/FALL2-001 closure and applies the CRASH3-001 restart barrier: a permit is never released until restart recovery has rolled back, synthesized an exact end, or parked/noticed an unresolved attempt.

### 7.1 W2.1 — #97 recoverable activation permits — CONC2-001

`maxConcurrentWorkers` is a cap on simultaneous activation leases, including bootstrap, task, mailbox, and cold-resume runs. The permit is held by `ActivationLease.permitHeld`; no separate task counter is authoritative.

```ts
export type PermitState = 'held' | 'recovering' | 'released'

export interface ActivationPermit {
  id: string
  activationId: string
  hostRunId?: string
  memberId: string
  purpose: ActivationPurpose
  state: PermitState
  acquiredAt: number
  releasedAt?: number
}
```

Acquisition/release:

1. Persist a `pending` lease with `permitHeld=true` under `withTeamLock` before `startActivation`, `sendMessage`, queue, or steer.
2. A running task activation may receive a mailbox steer without a second permit. An idle mailbox wake, bootstrap, new task, or cold resume acquires one.
3. Release only after exact `subagent/end` (post-teardown), exact `dispose()` of a new activation, exact `drainChildren` completion, or a CRASH3 recovery decision whose task/route/parking state is already durable. Never release on task terminal status, idle, member name, or timeout alone.
4. End before send resolution is normal: the end handler releases once, and the subsequent send return only records `hostMessageId`.
5. Any exact send/start rejection before publication rolls back the pending lease and releases once.
6. A stale/duplicate end has no permit effect after the first release.

Restart recovery uses §6.7's persisted `preDispatchSessionSeq` and markers:

```text
no accepted-prompt evidence after boundary (setup/system events ignored) -> rollback then release
committed turn/end -> synthesize exact outcome once, apply task/route/parking, then release
accepted/started/running but no end -> orphaned, park exact attempt, write ledger notice, then release
live Agent still running -> keep recovering/permit; wait for end or exact drain
ambiguous post-boundary evidence -> orphan/park/notice; never silent release
ended/released -> no permit and no replay
```

`recoverActivationLedger()` is idempotent and lane-serialized per child. It must not invent a success from a missing end.

Required tests: mailbox cold resume permit; task + mailbox cap; end before send resolve; cancel/drain; crash after pending/start/end/task-terminal; restart after prompt commit with/without turn/end; live Agent recovering; orphan notice before release; no duplicate release.

### 7.2 W2.2 — #76 deterministic route recovery — FALL2-001

The route cursor remains per task attempt:

```ts
export interface RouteCursor {
  routeGeneration: number
  currentRouteIndex: number
  routeAttempts: number[]
  cooldowns: Array<{ routeIndex: number; until: number; reason: string }>
  state: 'ready' | 'waiting' | 'exhausted'
  nextActionAt?: number
  lastFailure?: {
    activationId: string
    hostRunId: string
    code: string
    class: 'transient' | 'permanent' | 'unknown'
    at: number
  }
}
```

`agent/request-error` has no activation id. The listener uses the exact Agent object:

```ts
const binding = agentRuns.get(payload.agent)
if (binding === undefined) return next() // not a current AgentTeams run
recordRouteFailure(binding, payload.failure.code)
return undefined // do not call next(); suppress host retry for route-owned failure
```

The route-owned return value is `undefined`, not `{kind:'retry'}` and not `next()`. This ensures the current activation ends instead of continuing under a host retry policy while durable state says waiting. The exact run's `subagent/end` then advances the RouteCursor.

A route cursor on a task attempt is not newly allocated for each activation. The primary+fallback order is fixed at member creation; each route gets at most three activation-level attempts for transient failures. The transitions are:

| Failure/class | Durable action |
|---|---|
| 429/RATE_LIMIT, attempts < 3 | remain same route, `waiting`, cooldown 1s then 2s then 4s (cap 30s), release old permit after end |
| 429, attempts reaches 3 | advance route index if available, reset per-route count, cooldown 1s, increment routeGeneration |
| AUTH / MISSING_CREDENTIAL / NO_ADAPTER / insufficient_quota | never retry same route; advance immediately or terminal-fail after last route |
| unknown/error/refusal/max-tokens without recoverable route failure | fail closed, terminal task failure, one notice |
| completed | cursor clears; no retry |
| budget/time exhausted | terminal failure with actionable `increase_budget_or_transfer`; no retained permit |
| exact new end after cooldown | next activation created from persisted route cursor; no host-selected retry |

There is no `paused` task status. A waiting route holds no activation permit and cannot be dispatched until `nextActionAt`. The task stays `claimed`/`in_progress` with `attemptRoute.state='waiting'`, visible to status; it cannot silently occupy a worker slot.

Restart rules: `ready` resumes from the persisted route index; `waiting` waits until `nextActionAt`; `exhausted` remains failed. The old Agent's late error cannot mutate a new run because `agentRuns` misses or mismatches its runId.

Fake-clock/crash TDD:

- `retryPolicy=always` plus three 429s yields exactly three ended activations, not host-internal retries.
- `agent/request-error` before end, after end, old Agent, and duplicate error.
- crash after failure record, after route advance, after cooldown expiry, after pending lease, and after start.
- all routes permanent -> one terminal failure; unknown -> no loop; budget -> no permit held after teardown.

### 7.3 W2.3 — #62 parallel-emission half

`Config.parallelToolCalls` remains `false` by default and affects prompt guidance only. It never changes activation permits, route state, task dependencies, or same-response validation.

## 8. W3-CONTEXT — implementation decomposition, revision 3

### 8.1 W3.1 — #114 observable host compaction capability — CTX-001

The capability detector must observe composition/session events, not the subagent service surface. It has three honest states:

```ts
export type ContextLifecycleState = 'observed' | 'unavailable' | 'unproven'

export interface ContextLifecycleCapability {
  state: ContextLifecycleState
  hostVersion?: string
  composition?: 'standard' | 'minimal' | 'unknown'
  observedEvent?: 'compaction/start' | 'compaction/end'
  observedAt?: number
  lastCompactionError?: string
  source: 'session-event' | 'verified-matrix' | 'none'
  notes?: string
}
```

Detection inputs:

- supported host version from the compatibility policy;
- composition marker(s) available from the mounted services/session header;
- actual child session events whose type starts `compaction/`, observed with the member id and epoch;
- the repository's verified composition matrix as a static fallback, never as proof of the current run.

Rules:

- No observed compaction event -> `unproven`, not success.
- Verified minimal composition with no compactor -> `unavailable`.
- `compaction/start` on the exact child session -> still `unproven` until a successful `compaction/end`.
- A successful `compaction/end` on the exact child session -> `observed`; record event and timestamp.
- `compaction/end.error` (the host field, not a `compaction/error` event) -> `unavailable`, record the bounded error; never report success.
- `unavailable`/`unproven` is visible in member/team status and task assignment guidance.
- Cold restore and task completion are tested only after an observed event. A missing event cannot be reported as “compaction passed.”
- No plugin compactor or transcript rollover is introduced.

TDD:

1. Standard composition before threshold -> `unproven`.
2. Minimal composition -> `unavailable`.
3. Injected `compaction/start` + `compaction/end` -> `observed`, same child id/task/attempt/mailbox.
4. Compaction event followed by task completion and cold restore -> passes.
5. `compaction/end.error` -> `unavailable`, visible degraded status, not success.
6. Reload without an event -> remains `unproven`; no sticky false success.

### 8.2 W3.2 — #62 probe half

Persist `TaskProbe` on the exact activation/attempt as previously specified, but arm it only when a permit-bearing activation is active. A probe never creates a second concurrent activation and never rotates an attempt. One team-level fake-clock timer is sufficient. If the exact activation is parked/orphaned, probe only flushes the durable notification ledger; it does not wake a model. Default remains off (`probeIntervalMs = 0`), with a minimum 5s and max 10m when enabled.

## 9. W4-COLLAB — implementation decomposition

### 9.1 W4.1 — #238 direct profile invocation

New captain-only tool `agent_teams_invoke_profile` (or a name approved during API review) with:

```ts
export interface InvokeProfileInput {
  profile: string
  members: string[]
  prompt: string
  timeoutMs?: number
  concurrency?: number
}

export interface InvokeProfileResult {
  results: Array<{
    member: string
    status: 'completed' | 'failed' | 'timeout' | 'cancelled'
    output: string
    stopReason: string
    diagnostic?: string
  }>
}
```

Rules: validate profile/member names and all selected settings before any child start; start only explicitly named members; run up to a small bounded concurrency (default 2, max 4); key results by member; dispose all activations in `finally`; create no team directory/task/DAG/session-state files. Existing provider/model/reasoning/persona/tool policy are reused exactly. Invalid input produces zero model calls.

Tests: five-member fake profile, invoke two, assert two child sessions, zero team dirs, keyed stable results, unused members have zero requests, failure/cancel cleanup.

### 9.2 W4.2 — #244 owner-declared member skills

Add owner-declared skill snippets in config; do not accept raw skill bundles from the captain model:

```ts
export interface SkillBindingConfig {
  version: string
  prompt: string
  toolPolicy?: string
}

export interface Config {
  skills?: Record<string, SkillBindingConfig>
}

export interface TeamProfileMemberConfig {
  skills?: string[] // ids only; max 8, unique, non-empty
}

export interface TeamMember {
  skills?: string[]
  skillPromptSha256?: string
}
```

Resolution occurs before persistence/spawn. Include resolved prompts exactly once in the member persona; persist IDs/hash; cold resume restores the same resolved persona. Unknown/blank/duplicate IDs fail before member persistence and before child creation. MCP/tool visibility remains the existing `tool_policy` boundary; do not introduce a second raw MCP list. Tests: two members with disjoint skills, unknown-ID atomic failure, mutation/restart reapply, captain tool visibility unchanged.

### 9.3 W4.3 — #243 idle member route change

Extend `agent_teams_edit_plan` with an idle-only `update_member_route` operation or a dedicated captain tool, but use one service function:

```ts
export interface UpdateMemberRouteInput {
  memberName: string
  provider?: string
  model?: string
  reasoningEffort?: string | 'default'
}

export async function updateIdleMemberRoute(...): Promise<{ memberName: string; route: ResolvedModelRoute }>
```

Rules:

- Reject while staged, halted, removed, `stopping`, live running, or owning an open attempt.
- Set `member.stopping = true` under the team lock, resolve/validate the route, then call the host release seam `drainChildren(captain, [member.id])` outside the lock.
- On success, atomically persist the new primary route, clear `activeProvider/activeModel/fallbackActive`, clear route history/cooldown, set `stopping=false`, and kick the scheduler.
- On failure, restore the old member record, clear `stopping`, record `spawnError`, and expose the error.
- Next turn cold-resumes with the new route; task/attempt ids are unchanged because no open attempt was allowed.
- UI enables the control only for idle members with no open task and shows the effective route after confirmation.

Tests: two-turn request log, first old/next new, cold-resume persistence, active/owned rejection, invalid route atomicity.

### 9.4 W4.4 — #195 deterministic collect and join barrier

Add captain-only `agent_teams_collect`:

```ts
export interface CollectInput {
  taskIds?: string[]        // ordered; omitted means all tasks at registration time
  partial?: boolean         // default false
  digest?: 'none' | 'extractive' // default none
}

export interface CollectResult {
  ok: boolean
  tasks: Array<{
    id: string
    subject: string
    status: TaskStatus
    assignee?: string
    attempt?: number
    attemptId?: string
    output?: string
    verdict?: string
    blockers: string[]
  }>
  partial: boolean
  digest?: string
}
```

Register a durable `joinBarrier` on first collect (`taskIds`, `digest`, `key`, `notifiedAt`, `messageId`). Default output order is stable task-id order; explicit input preserves the requested order. `partial=false` fails closed if any required task is non-terminal. A failed/cancelled required task yields `ok:false` and no success digest. The barrier notification is a mailbox row with stable key `join-ready:<taskIds hash>`; repeated polls cannot duplicate it. `digest:'extractive'` is deterministic concatenation of subjects/statuses/output excerpts and is not a model call.

Tests: three-task DAG success/pending/failure, repeated polling, deterministic JSON, one idempotent notice, partial mode behavior, no synthesis call.

## 10. W5-UI — implementation decomposition, revision 2

This section closes AUTH-001 and ATT-001. It preserves #263, #58, #70, #121, and #279.

### 10.1 Web trust-domain decision — AUTH-001

The current host does not expose a request principal and `authenticatedWebRoutes` only returns a connection-level rejection decision. Therefore the design may not claim “the caller leads this team.”

```ts
export type WebTrustMode = 'session-team' | 'workspace-single-user' | 'unavailable'

export interface WebPrincipalCapability {
  mode: WebTrustMode
  principalId?: string       // only when the host supplies a verified principal
  workspaceId?: string
  sessionId?: string
  teamId?: string
  expiresAt?: number
  source: 'host-principal' | 'single-user-gate' | 'none'
}
```

Rules for the baseline `0.1.27` host:

- `authenticatedWebRoutes` provides only **workspace-single-user** trust after `requestRejection` passes.
- Attachment/avatar reads and archive/live snapshot routes may use this trust domain. A body/query `sessionId` or `teamId` is a lookup key, never an authorization claim.
- Cross-team access inside the same authenticated single-user workspace is explicitly allowed by policy, not silently claimed as per-team isolation.
- If `requestRejection` is unavailable, all routes return `503`/`401`; there is no fallback to unauthenticated serving.
- Manual create/approve needs an owner session. For a first team, the authenticated route enumerates live eligible captain sessions through `ctx.agents` in the same workspace; if exactly one exists it binds that session, and if several exist it returns opaque server-issued choices. The server then mints a short-lived opaque action capability (stored server-side with nonce, live captain session id, workspace id, expiry, and allowed operation). The request carries the nonce, never a trusted `sessionId`. A body `sessionId` cannot select a different owner. Expired/revoked/non-matching nonces fail before mutation.
- When the host later supplies a verified `session-team` capability, the same service accepts it and enforces exact team ownership. No route reads a request-body team identity as proof.

Tests: unauthenticated 401/503; forged body sessionId; valid/invalid/expired action nonce; duplicate/revoked capability; workspace-single-user cross-team access is documented and does not become a per-team claim. The implementation must expose the active trust mode in diagnostics.

### 10.2 W5.1 — #263 durable bounded activity timeline

Add to `TeamState`:

```ts
export type TimelineAction =
  | 'team.created' | 'member.added' | 'member.removed' | 'member.renamed'
  | 'task.created' | 'task.claimed' | 'task.started' | 'task.completed'
  | 'task.failed' | 'task.cancelled' | 'task.reassigned' | 'task.amended'
  | 'message.sent' | 'message.delivered' | 'message.read'

export interface TimelineEntry {
  id: string
  at: number
  actor: string
  action: TimelineAction
  taskId?: string
  attemptId?: string
  result?: string
  verdict?: string
  from?: string
  to?: string
}

TeamState.timeline?: TimelineEntry[] // newest at end, cap 500
```

Every mutation appends inside the same `withTeamLock` and before one `writeTeam`. Snapshot projects the latest 200 entries. Archived teams retain the array. Polling never mutates the timeline. Host session event vocabulary is not required.

Tests: claim -> in_progress -> completed/failed, stable IDs/order, repeated reads no duplicates, reload/archive, cap eviction, absent host event vocabulary.

### 10.3 W5.2 — #58 pluggable status renderer

```ts
export type SemanticAgentStatus =
  | 'idle' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export interface StatusPresentation {
  semantic: SemanticAgentStatus
  labelKey: string
  ariaLabelKey: string
  motion: 'none' | 'pulse'
  tone: 'neutral' | 'active' | 'success' | 'danger'
}

export interface StatusRenderer {
  render(presentation: StatusPresentation): React.ReactNode
}
```

Mapping remains independent of avatar/role art. The default covers all states with text equivalents. Animation pauses when hidden/collapsed, stops on unmount, and honors `prefers-reduced-motion`. It consumes the existing snapshot; no new polling loop.

### 10.4 W5.3 — #70 scoped mailbox attachments — ATT-001

An attachment is a delivery from the sender's current task, not a general workspace file-read capability.

```ts
export interface ArtifactRootConfig {
  id: string
  path: string                  // canonical absolute path, owner-configured
  allowRead: boolean
  allowTeamIds?: string[]       // absent means all teams in the single-user workspace domain
}

Config.artifactRoots?: ArtifactRootConfig[]

export interface AttachmentSourceDescriptor {
  workspaceId: string
  sourcePath: string          // normalized workspace-relative path
  sourceRealpathHash: string  // hash of canonical path, never expose absolute path
  device: string
  inode: string
  size: number
  mtimeMs: number
  sha256: string
}

export interface MessageAttachment {
  id: string
  name: string
  mime: string
  bytes: number
  sha256: string
  storageRef: `attachments/${string}`
  source: AttachmentSourceDescriptor
}

TeamMessage.attachments?: MessageAttachment[]
```

Allowed source policy:

1. A member may attach only a path that matches the current open task's `deliverables` or `inScope` using the existing normalized path matcher.
2. A captain may attach a path from an explicit owner-managed artifact root (`Config.artifactRoots`), or a path in the current user's explicit delivery selection; not arbitrary workspace files.
3. Cross-scope access requires a captain/user capability recorded in the team action log. It is never the default.
4. `.agent-teams/**`, other teams' state, dependencies, secrets, and files outside the permitted scope are rejected even if they are workspace-relative. A broad “whole workspace” read requires an explicit opt-in file-read capability and is not part of #70.

Safe-copy protocol closes realpath/open TOCTOU:

1. Normalize path and reject absolute, `..`, NUL, drive, empty, and symlink components.
2. `lstat` the candidate; reject non-regular files and symlinks.
3. `realpath` the candidate and verify it is inside the canonical workspace/allowed artifact root.
4. Open with read-only and no-follow semantics where available; `fstat` the descriptor.
5. Compare the opened descriptor's device/inode/size with the pre-open `lstat` result; if it changed, fail.
6. Reject any source with `nlink !== 1` before open and after `fstat`. This blocks a hardlink from an allowed scope to a protected inode (for example `.env` or another team's state) even when path/device/inode checks otherwise agree. If the platform/filesystem cannot report a finite reliable link count, fail closed for member attachments (`LINK_COUNT_UNAVAILABLE`); an owner-managed artifact root may opt into a protected-inode registry but that is not part of the default.
7. Read only from the descriptor with hard per-file and total byte caps; hash while copying.
8. Store a content-addressed copy under the team's `attachments/` directory. Persist the descriptor and hash; never re-read the source at render time.
9. Serve only through `authenticatedWebRoutes`; the baseline host uses workspace-single-user trust. Use `nosniff`, an escaped filename, and `Content-Disposition: attachment` for PDF/ZIP/text; only approved raster images may be inline.
10. Remote URLs are rejected in v1. A later remote feature must DNS-pin, block loopback/private/link-local/metadata, revalidate redirects, and cap bytes.

Limits: max 5 files, 10 MiB each, 25 MiB total; allowed types PNG/JPEG/WebP/text/Markdown/JSON/CSV/PDF/ZIP. HTML, SVG, scripts, and unknown active content are rejected. Text-only `send_message` remains compatible.

Tests: allowed deliverable/inScope attachment; `.env` denial; another team's `team.json` denial; owner-root allowance; traversal/symlink; hardlink with `nlink>1` denial; TOCTOU substitution; unreliable link-count fail-closed; oversize/wrong MIME; unauthenticated request; single-user cross-team policy; forged body identity; restart/archive bytes and metadata.

### 10.5 W5.4 — #121 local-only avatar overrides

```ts
export type AvatarRef =
  | { kind: 'builtin'; role: string }
  | { kind: 'managed'; sha256: string; ext: 'png' | 'jpg' | 'webp' }

TeamState.memberAvatars?: Record<string, AvatarRef>
TeamState.roleAvatars?: Record<string, AvatarRef>
```

Priority: captain/member override -> role override -> packaged role art -> initial-letter fallback. Upload is enabled only under the documented Web trust mode (baseline workspace-single-user), max 2 MiB, verified raster signature/MIME, stored content-addressed under the owning team's `avatars/` directory. No user filename is used in a path. Restore removes the reference. Remote HTTP(S) is not supported in v1; PR #67’s remote proxy is not accepted without the SSRF and principal design above.

Tests: default/override/fallback goldens, cold restore, old teams unchanged, traversal/symlink, wrong signature/MIME, >2 MiB, unauthenticated request, forged body identity, remote URL rejection.

### 10.6 W5.5 — #279 three independent UI tasks

**W5.5a staged rename:** add `new_name` to a staged-only `update_member`. Validate non-empty, reserved `captain`, and `sanitizeKey` collision. Under one team lock update member name, task assignees, required-reviewer references, staged mailbox keys/messages, and references; historical timeline entries are not rewritten. Running rename remains rejected. Test collision/missing/rollback/reload/running rejection.

**W5.5b font scale:** `uiScale: 'host' | '100' | '125' | '150'`, default `'host'`. Use one `--agent-teams-font-scale` variable, replace sub-11px hard-coded sizes with scale-aware values, persist explicit user preference, and test three scales at narrow/wide widths without clipping.

**W5.5c manual team creation:** authenticated Web route/service `createStagedTeam` writes the same persisted plan as `agent_teams_create`, never client-side files. The action nonce from §10.1 binds the live captain/session and allowed operation; a first-team flow uses the server-selected/opaque live-session choice, never a body-supplied session id. Approve reuses `approveStagedTeam` and the same lifecycle. With no live session or no valid capability, the route is disabled. Test auth, forged session, expiry, duplicate names, approval parity, and no alternate storage.

## 11. W6-EVIDENCE — implementation decomposition

### 11.1 W6.1 — #211 paired evaluation harness

Add `scripts/agent-teams-eval.mjs`, `scripts/agent-teams-eval-validate.mjs`, and a versioned JSONL task suite/report schema. Deterministic unit tests run in `pnpm verify`; real model trials are opt-in.

```ts
export type EvalMode = 'single-agent' | 'ordinary-subagent' | 'agent-teams'
export interface EvalTrial {
  trialId: string
  pairId: string
  mode: EvalMode
  taskHash: string
  model: string
  provider: string
  budgets: { tools: number; wallMs: number; retries: number }
  outcome: 'pass' | 'fail' | 'timeout' | 'error'
  wallMs: number
  tokens: { captain: number; members: number; total: number; source: 'host' | 'unavailable' }
  judge: { rubric: string; verdict: string }
}
```

Rules: retain every trial including failures/timeouts; pair IDs and task hashes are mandatory; the same model/tool/time/retry budgets are checked; the validator recomputes metrics and rejects summaries that omit failures. Report pass rate, wall time, token/cost, timeout/error rate, trial count, and limitations. Include at least one negative/overhead case. Do not claim statistical significance for small N.

Tests: validator rejects missing modes/failed trials/unequal budgets; recomputed totals match; no cherry-picking; no network in normal verify; report explicitly states limitations.

## 12. W7-PLATFORM — implementation decomposition

### 12.1 W7.1 — #315 immutable global agent library

Define a plugin-owned, versioned library, not a live cross-team session:

```ts
export interface AgentPresetV1 {
  schemaVersion: 1
  id: string
  revision: number
  name: string
  role: string
  provider?: string
  model?: string
  reasoningEffort?: string
  executionPrompt: string
  skillIds: string[]
  toolPolicy?: string
  avatar?: AvatarRef
  createdAt: number
  updatedAt: number
}
```

CRUD/listing can be exposed through captain tools and one authenticated UI service. A new team copies the selected preset revision into its `TeamMember`; mutable settings never leak into a running team. Preset updates affect future teams only. Deleting a preset does not touch teams. Validate provider/model/skill/tool policy before persistence; fail with no partial write. Library storage lives in a dedicated state directory with atomic JSON writes and a bounded count; do not create a live session per preset. Feature is opt-in (`agentLibrary.enabled=false` initially).

Tests: restart persistence, two teams distinct child ids but equal immutable settings, preset mutation does not alter old team, missing/disabled skill/policy rejects before spawn, selection parity between captain and UI, no cross-team session sharing.

### 12.2 W7.2 — #287 opt-in member-lane worktree isolation — WT-001

A worktree is a **member-lane resource**, not a task-directory that changes under a resident child. A continuable child's session cwd is immutable; therefore one lane owns one worktree path/branch/base for its whole lifetime, and all serialized tasks handled by that member reference the same lane.

```ts
export interface WorktreeLane {
  laneId: string
  teamId: string
  memberId: string
  repoRoot: string           // canonical absolute path
  worktreePath: string       // canonical absolute path, outside repoRoot
  branch: string             // generated, unique for this lane
  baseRef: string
  state: 'preparing' | 'ready' | 'integrating' | 'cleaned' | 'failed' | 'preserved'
  createdAt: number
  commit?: string
  dirty?: boolean
  error?: string
}

TeamState.worktreeLanes?: WorktreeLane[]

TeamMember.worktreeLaneId?: string

TeamTask.worktreeLaneId?: string
TeamTask.workspace?: {
  kind: 'member_lane'
  laneId: string
  worktreePath: string
  branch: string
  baseRef: string
}
```

Rules:

- Assigning a task to a member with a lane requires the task to reference that exact lane id. A task without a lane may use the shared workspace only if the feature is disabled or the task is read-only and explicitly marked `shared`.
- Create the lane once, before the member's first child start. Path shape is `<configuredRoot>/<teamId>/<laneId>/<repoKey>`; there is no `<taskId>` in the path. Branch shape is `agent-teams/<teamId>/<laneId>` and is persisted.
- Start/resume the member with `cwd = lane.worktreePath`. The same child session always sees that cwd; subsequent tasks in the lane do not change it.
- Branch/path collision checks are against all active lanes and `git worktree list`. Two lanes cannot use the same path or branch. The configured root must be outside `repoRoot`, canonicalized, and symlink-free at the lane root.
- A lane may process one active task at a time. After failure/cancellation, the next task remains in the same lane and same cwd; dirty files are preserved and reported. It never silently switches to another lane.
- Worktree creation, integration, and cleanup are separate phases. Integration/cleanup require explicit captain approval. Cleanup refuses a dirty/unmerged worktree and never uses `--force`, `git worktree prune`, or broad deletion. Archive/cancel defaults to `preserved`.
- Use `execFile('git', [...])`, never a shell. Verify the repo root and base commit with `git rev-parse`; branch text is generated, not user shell input.
- The task's completion records the lane commit, changed paths, and dirty state. Dependent work waits for the lane integration boundary.

TDD:

1. Member lane with two serialized tasks: both run in the same path and branch; cwd is identical after the first task.
2. Failure of task 1, task 2 retry/next task: same lane/path/cwd, dirty work preserved.
3. Cold resume: same child id/cwd/lane; no new task-id directory.
4. Duplicate path/branch across lanes rejected.
5. Base mismatch, worktree create failure, dirty cleanup refusal, integration failure visible.
6. Archive/cancel preserves the lane and reports its state.

## 13. Decisions for the seven ambiguities, revision 3

### Ambiguity 1 — #308 activation result consumption

Decision: one task attempt per activation, with a durable `pending -> started -> ended/released` lease. New children receive a plugin-reserved childId that is persisted and proven absent before `startActivation({childId})`; existing children use `sendMessage`/queue/steer cold-resume and return only `MessageId`. Persist the pending lease and pre-dispatch session boundary before delivery. Bind `subagent/start.runId` to that lease using the already-known child id and live Agent object, and use `subagent/end` as the canonical terminal outcome. `startActivation.result` is a new-child dedupe/diagnostic fallback, never a resumed-run authority. Fast end before send/start resolves is reconciled by runId. On restart, session events after the boundary plus CAS markers roll back, synthesize one exact end, or orphan/park/notify; they never silently release an open task.

Rejected: mutable `lastDeliveredAttemptId`; a single resident activation covering multiple task turns; unconditional latest-open-task matching; treating a native settlement as authoritative success.

### Ambiguity 2 — #259 final versus progress

Decision: explicit durable `reportKind`, plus `sourceMemberId`, member generation, activation id/epoch, task id, and attempt id. Mailbox readability and native-settlement suppression are separate predicates. A final remains readable across the `in_progress -> completed` transition. Native settlement suppression uses a bounded exact-attempt grace (default 500ms, max 2s); a final arriving after an already admitted settlement may cause one documented conservative duplicate. Omission means progress.

Rejected: timestamp ordering; task-only matching; treating any latest report as final; requiring a terminal source status when the report is sent.

### Ambiguity 3 — context compaction versus plugin rollover

Decision: host/session compaction is authoritative. Capability is `observed`, `unavailable`, or `unproven`; a successful `compaction/end` from the exact child session is required for `observed`. `compaction/start` alone is `unproven`; `compaction/end.error` is `unavailable`. There is no `compaction/error` event. No plugin compactor, truncation, or silent rollover.

Rejected: `detectContextLifecycle` on the subagent service as proof; treating no signal as success; plugin-managed transcript deletion.

### Ambiguity 4 — concurrency permits and fallback semantics

Decision: durable activation permits cover task, mailbox, bootstrap, and cold-resume work. Occupancy is the active activation ledger, not the open-task count. A permit is released only after exact `subagent/end`, exact new-activation dispose, or exact drain; task terminalization/idle does not release it. Fallback uses an ordered route cursor with per-route attempt caps, per-route cooldowns, route generation, and deterministic retry/fallback/terminal transitions. `agent/request-error` is mapped through the exact Agent WeakMap and route-owned failures return `undefined`, not `next()`, suppressing host retry. Cooldown holds no permit. Budget exhaustion is a terminal actionable failure. Parallel Emission remains prompt-only, opt-in, and false by default.

Rejected: task rows as permits; mailbox bypass; immediate release on task completion; member-level single cooldown; infinite same-route retries; unknown errors retried indefinitely.

### Ambiguity 5 — worktree ownership/integration/cleanup

Decision: one member owns one lane with one immutable cwd/path/branch/base. Tasks serialize within that lane and reference the lane id. Creation, integration, and cleanup are separate; cleanup and integration require explicit approval; dirty/unmerged work is preserved; no automatic prune or force removal.

Rejected: `<taskId>` cwd swapping under one continuable child; shared workspace fallback; in-repo `.worktrees`; automatic cleanup; live worktree sharing across members.

### Ambiguity 6 — global presets and manual creation

Decision: reusable presets are immutable snapshots for future teams; no live session sharing. Manual creation uses the same staged server-side pipeline and the Web trust policy from §10.1. In the baseline host, the Web trust mode is workspace-single-user plus a server-minted action nonce; future host principals must be consumed rather than fabricated from body fields.

Rejected: per-team authorization claims unsupported by the host; a second client-only state owner; live global sessions; preset edits changing running teams.

### Ambiguity 7 — attachments and avatars

Decision: local-only artifact policy in v1. Members attach only task deliverables/inScope or an owner-managed artifact root; social/secret/state files are denied. Canonical path, pre-open lstat, realpath containment, fd fstat device/inode check, `nlink===1` hardlink rejection (or fail closed if link count is unreliable), bounded streaming copy, content-addressed storage, authenticated read. Remote URLs are rejected. Avatar uploads use the same local raster policy and workspace trust mode.

Rejected: arbitrary workspace reads; HTML/SVG serving; unsigned remote URLs; proxy redirects without revalidation; unauthenticated static files; per-team authorization claims the host cannot support.

## 14. Rollout, flags, defaults, and rollback

| Slice | Default | Rollout gate | Rollback |
|---|---|---|---|
| W0 | enabled | typecheck, compatibility, release/tarball checks | revert commit; no durable state |
| W1 settlement | one attempt per activation; new child gets a reserved/absent-checked childId then startActivation; existing child uses sendMessage plus subagent/start/end runId; restart scans pre-dispatch session boundary | concurrent-new-child, fast-end, crash-after-prompt/start/end/task-terminal, permit release, notification-ledger fixtures on rc.2/rc.3/rc.4 | revert; old binary ignores optional fields |
| W1 report_kind | progress when absent; 500ms bounded final-report grace | mailbox matrix incl. final-after-grace duplicate guarantee | omit field; native wake remains conservative |
| W2 activation cap | `maxMembers` (compatibility), docs recommend 2-4; applies to task/mailbox/bootstrap/cold-resume activations | permit crash-recovery, quiescence, fairness, and mailbox tests | restore prior admission behavior; never release an active permit early |
| W2 fallback | singular legacy normalized to one route | fault-injection matrix | keep old singular field path |
| W2 Parallel Emission | false | prompt golden + dependency-safety tests | remove prompt text |
| W3 compaction | host-managed; successful compaction/end=observed, end.error=unavailable, start-only=unproven | standard/minimal host matrix | report unavailable/unproven; never synthesize compaction |
| W3 probes | disabled (`probeIntervalMs=0`) | fake-clock and restart tests | disable timer; durable due fields inert |
| W4 direct invocation | explicit call only | zero-team-dir/zero-unused-member tests | hide tool; no durable state |
| W4 skills | owner config only | unknown-ID atomicity | remove binding, old members unchanged |
| W4 route change | idle/no-open-attempt only | two-turn/cold-resume tests | keep stored primary route; drain is reversible |
| W4 collect | no synthesis, partial false | deterministic/idempotent notification | ignore joinBarrier; status remains available |
| W5 timeline | enabled, 500 entries | reload/archive/cap tests | optional field can be ignored |
| W5 attachments/avatars | local-only; baseline Web mode is authenticated workspace-single-user | auth/trust-mode/scope/descriptor/size/SSRF matrix | reject new uploads; existing copied artifacts remain readable |
| W5 manual creation | staged only | route auth and parity tests | hide entry point; staging persists |
| W6 eval | opt-in real trials; deterministic validator in CI | validator + negative case | remove harness from release gate |
| W7 library | disabled | persistence/immutability tests | hide UI/tools; teams keep snapshots |
| W7 worktree lanes | disabled | same-lane consecutive-task, cold-resume, collision, dirty-cleanup matrix | preserve all lanes/worktrees; disable creation/cleanup |

No implementation may claim “completed” without the relevant commands and acceptance evidence recorded through `team_update_task`. The implementation phase must run targeted tests in the author worktree and one full gate before merge; the captain does not use full-suite runs as a monitoring loop.

## 15. Unresolved risks and dependency checkpoints

1. **Host lifecycle/session semantics remain version-sensitive.** The rc.2/rc.3/rc.4 fixtures must prove reserved-childId acceptance, `subagent/start`/`subagent/end` ordering, runId stability, fast-end behavior, cold-resume delivery, and the exact `preDispatchSessionSeq` scan. `startActivation` is never used with a persisted childId; the protocol remains one attempt per activation.
2. **Host compaction API is not uniform.** W3.1 is an observation/adaptation task, not permission to build a compactor. Until an exact child compaction event is observed, report `unproven`; known minimal composition reports `unavailable`.
3. **Worktree cwd is immutable in a continuable child.** Worktree ownership is therefore a member-lane resource with one immutable path/branch/base. True spawn-per-task cwd switching is a separate rejected design.
4. **Skill semantics vary by host.** The design deliberately calls them owner-declared snippets; a future formal registry adapter must not weaken the no-raw-bundle rule.
5. **Filesystem descriptor behavior is platform-sensitive.** `O_NOFOLLOW` and fd-based verification must be tested on macOS/Ubuntu/Windows; if a platform cannot provide the required descriptor identity, attachment/source access fails closed.
6. **Web per-team authorization is absent on the baseline host.** W5 uses authenticated workspace-single-user trust and a server-minted action nonce for owner-bound manual operations. Do not advertise per-team isolation until the host supplies a verified principal capability.
7. **Remote avatar/attachment retrieval is out of scope for v1.** PR #67’s proxy may be reconsidered only after SSRF, DNS pinning, redirect, CSP, and principal tests pass.
8. **#316’s real-host validation must use a built release tarball**, not a source checkout or plugin-manager bypass.
9. **Worktree integration is intentionally later than lane binding.** W7.2a can ship only after same-lane cwd/cold-resume tests; merge/cleanup stay disabled until their separate gates pass.

## 16. Implementation task decomposition summary

- W0.1 rc.4 declarations and host matrix.
- W0.2 subject guard + direct/integration tests.
- W0.3 tool-policy schema clarity + GPT smoke.
- W0.4 shipping manifest + release validation.
- W0.5 ordered flag utility (feeds W1.4).
- W1.1 reserved-childId new start plus existing-child sendMessage, subagent/start/end runId binding, fast-end reconciliation, and exact-generation tests.
- W1.2 pre-dispatch session-boundary recovery, durable parking notice/outbox, bounded final-report grace, and restart/read dedupe.
- W1.3 Agent WeakMap stale-status filtering and exact drain/recovery split.
- W1.4 report_kind + exact settlement suppression.
- W2.1 durable activation-permit admission released only on exact end/dispose/drain, with crash recovery and fairness.
- W2.2 Agent-weak-map request-error attribution, host-retry suppression, ordered fallback/cooldown/quota/budget.
- W2.3 optional Parallel Emission prompt setting.
- W3.1 observable compaction/start/end capability with compaction/end.error handling and continuity.
- W3.2 persisted sparse probes (depends on W1.3).
- W4.1 direct profile invocation.
- W4.2 owner-declared skills.
- W4.3 idle route change with drain/cold resume.
- W4.4 deterministic collect/join barrier.
- W5.1 timeline.
- W5.2 status renderer.
- W5.3 scoped attachment store, descriptor checks, and trust-mode-aware delivery.
- W5.4 local avatar overrides.
- W5.5a staged rename; W5.5b font scale; W5.5c manual staged creation.
- W6.1 paired evaluation harness/validator.
- W7.1 immutable agent library.
- W7.2a member-lane binding/create; W7.2b explicit integration; W7.2c explicit cleanup.

Each implementation task must carry the five required task-book elements: baseline counts, write allow/deny lists, falsifiable acceptance, independently hand-calculated expected values, and shared-environment warnings. Evidence-gated issues remain outside this task list.

## 17. Finding closure matrix

### 17.1 t6 findings carried forward

The second review re-opened lifecycle-related findings because Revision 2 used an invalid cold-resume API. They are re-closed below against Revision 3's `subagent/start`/`subagent/end` protocol.

| Finding | Severity | Current closure | Evidence |
|---|---|---|---|
| ACT-001 | blocker | Re-closed under ACT2-001: new-child `startActivation` and existing-child `sendMessage` are split; runId lifecycle events are canonical. | §6, §17.2 |
| RACE-001 | high | Re-closed under RACE2-001: exact Agent WeakMap replaces status/epoch guessing. | §6.7, §17.2 |
| REPORT-001 | high | Re-closed under REPORT2-001: final currentness fixed, bounded grace handles native-settlement ordering. | §6.8, §17.2 |
| PARK-001 | high | Closed: noticeDueAt, durable notification ledger, deterministic ids, transition and crash table remain. | §6.8 |
| CONC-001 | high | Re-closed under CONC2-001: permit released on exact end/dispose/drain. | §7.1, §17.2 |
| FALL-001 | high | Re-closed under FALL2-001: request-error mapped through Agent WeakMap; route-owned failure does not call next. | §7.2, §17.2 |
| AUTH-001 | high | Closed: authenticated workspace-single-user trust plus server-minted action nonce. | §10.1 |
| ATT-001 | high | Re-closed under ATT2-001: hardlink/link-count denial closes the residual inode bypass. | §10.4, §17.2 |
| WT-001 | high | Closed: one member lane owns one immutable worktree path/branch/base/cwd. | §12.2 |
| CTX-001 | medium | Re-closed under CTX2-001: real `compaction/end.error` event field. | §8.1, §17.2 |

### 17.2 t8 findings

All seven t8 findings are explicitly closed. No high or blocker remains unresolved.

| Finding | Severity | Closure decision | Revised evidence | Required tests |
|---|---|---|---|---|
| ACT2-001 | blocker | Re-closed under RESERVE3-001: a durable reserved childId now exists before the first subagent/start. The rc.2 split remains: `startActivation` only creates new children; `sendMessage` cold-resumes existing children. Persist pending lease before delivery; bind `subagent/start.runId`; make `subagent/end` canonical and idempotent; reconcile fast end before send/start resolution; cap diagnostic from request/agent error; unknown/missing outcome fails closed. | §6.1-§6.6, §6.9 | new child, existing cold resume, fast end before send, duplicate/missing end, old runId, process restart, max-tokens |
| CONC2-001 | high | Re-closed with CRASH3-001: permit release is bound to exact `subagent/end`, exact new-activation dispose, exact drain, or a durable recovery decision with task/parking state committed. End-before-send is idempotent; restart recovery keeps live runs in `recovering` rather than leaking or releasing on idle. | §6.7, §7.1, §6.9 | mailbox cold resume, end before send return, cancel/drain, restart without replayable end |
| FALL2-001 | high | Closed by exact Agent -> runId WeakMap attribution for `agent/request-error`; route-owned failures persist the failure and return `undefined` without calling `next()`, suppressing host retry; RouteCursor starts the next activation only after cooldown. | §6.3, §7.2, §6.9 | retryPolicy=always, error before/after end, old Agent, crash at every route transition |
| RACE2-001 | high | Closed by `subagent/start` populating a WeakMap from the exact live Agent to runId/activation; status handlers ignore stale/missing Agent mappings; old Agent idle cannot park/overwrite a new attempt. | §6.3, §6.7, §6.9 | old Agent idle after new start, delayed idle, current idle display-only, reassignment |
| REPORT2-001 | medium | Closed by bounded exact-attempt final grace (default 500ms, max 2s). Final inside grace suppresses native settlement; final after admission explicitly permits one conservative duplicate. No absolute one-wake claim remains. | §6.8, §6.9 | settlement pre-step before final, final inside/outside grace, progress-only, failed ending |
| ATT2-001 | medium | Closed by rejecting `nlink !== 1` before open and after fstat, and fail-closed `LINK_COUNT_UNAVAILABLE` where link count is unreliable. This blocks protected-inode hardlinks inside an allowed scope. | §10.4, §17.2 | hardlink to protected inode, nlink>1, unreliable link count, owner root |
| CTX2-001 | medium | Closed by using `compaction/end.error`; no `compaction/error` event exists. Successful end=observed, start-only=unproven, end.error=unavailable. | §8.1, §13 Ambiguity 3 | start-only, successful end, end.error, minimal composition, reload |

Reviewer acceptance mapping:

- ACT2-001 is blocker-closed by a direct match to the rc.2 `startActivation`-new-child and `sendMessage`-cold-resume contract.
- CONC2 and FALL2 use the same exact Agent/runId mapping and cannot independently drift.
- RACE2 keeps status display-only and result/end as task authority.
- REPORT2 removes the impossible universal no-duplicate guarantee and states a bounded best-effort with an explicit duplicate consequence.
- ATT2 and CTX2 close the residual medium findings.
- No production file or GitHub object is changed by this revision.

### 17.3 t10 findings

All three t10 findings are explicitly closed. No high or blocker remains unresolved.

| Finding | Severity | Closure decision | Revised evidence | Required tests |
|---|---|---|---|---|
| RESERVE3-001 | blocker | Closed by plugin-minted durable childId reservation: generate `SessionId(randomUUID())`, set it on the member/pending lease, prove absence through host persistence, then pass it to `startActivation`. `subagent/start` can now bind before the Promise resolves. Duplicate/persisted id fails closed; concurrent new children have distinct keys; fast end remains buffered only by the already-known child lane. | §6.1-§6.4, §6.9 | persisted-child duplicate, start before Promise, fast end before Promise, two concurrent new children, lane cleanup |
| CRASH3-001 | high | Closed by durable `preDispatchSessionSeq`/dispatch token before delivery and restart scanning of child-owned events from the boundary inclusive. Branch matrix: no accepted prompt -> rollback; committed turn/end -> synthesize once; accepted/running without end -> orphan/park/notice before release; ambiguity -> fail closed. `startObserved`/`endObserved` and activationId/runId CAS markers are durable. | §6.7, §7.1, §6.9 | crash after prompt commit/start/end/task terminal; turn/end synthesis; no-end orphan; ambiguous scan; live running recovery |
| DIAG3-001 | high | Closed by making `subagent/end.stopReason` the sole authority. `completed` with no diagnostic is success; non-completed follows its stopReason; only missing/unknown stopReason becomes settlement_unknown. Diagnostic is optional. | §6.6, §6.9-§6.10 | completed-no-diagnostic, max-tokens-no-diagnostic, unknown/missing stopReason, turn-end synthesis |

Reviewer acceptance mapping:

- RESERVE3-001 is blocked no longer: the first new-child `subagent/start` has a pre-existing child id and pending lease.
- CRASH3-001 cannot silently release: every restart branch commits a task/route/parking decision or a ledger notice before permit release.
- DIAG3-001 cannot turn ordinary completed runs into failures because diagnostic is no longer a success predicate.
- 24/24 accepted coverage and 9/9 evidence-gated exclusions remain unchanged.

### 17.4 t12 finding

| Finding | Severity | Closure decision | Revised evidence | Required tests |
|---|---|---|---|---|
| BOUNDARY4-001 | high | Closed by defining `preDispatchSessionSeq` as an inclusive half-open snapshot start. On rc.2 `Session.seq` is already the next event offset/log length: live child stores `SessionLogOffset(session.seq)` with no increment; observed persisted session stores `events.length`/query-returned next offset. Recovery calls `snapshotEvents(preDispatchSessionSeq)` or the equivalent inclusive slice. | §6.5, §6.7, §6.9 | first event `user/message`; first event `turn/start`; empty post-boundary log; inherited seed prefix; single turn/end synthesis |

Closure rationale:

- The first matching event at exactly `preDispatchSessionSeq` is included.
- The design no longer contains `session.seq + 1` for a live boundary.
- Empty post-boundary evidence is treated as no accepted prompt only when all other markers are absent.
- Inherited seed events are outside the persisted own-event slice and never count as dispatch evidence.
- A single post-boundary `turn/end` synthesizes exactly one outcome rather than triggering rollback.

## 18. Self-check record

The final validation command and results are recorded below after the design document is written. The design intentionally contains no product-file modifications and no GitHub mutation.

- accepted primary-slice coverage: **24/24**, exact set, no duplicate primary slice
- needs-evidence exclusion: **9/9** present under the excluded evidence queue and not scheduled
- duplicate: **3/3**; already-fixed: **3/3**; out-of-scope: **3/3**
- W0/W1 signatures, state invariants, compatibility notes, TDD matrices, and mutation checks: present
- t6 carry-forward: **10/10** re-opened findings addressed in Revision 3
- t8 finding closure: **7/7**; ACT2-001 blocker closed; CONC2-001, FALL2-001, RACE2-001 high findings closed; REPORT2-001, ATT2-001, CTX2-001 medium findings closed
- activation protocol: new child via startActivation; existing child via sendMessage; durable pending lease before delivery; subagent/start runId binding; subagent/end canonical settlement; fast-end reconciliation; exact Agent WeakMap
- W2 permit/routing: permits released only on exact end/dispose/drain; request-error route-owned failures do not call host `next()`; deterministic cooldowns and restart recovery
- W5/W7 boundaries: authenticated workspace-single-user trust plus server-minted action nonce; attachment scope/descriptor plus hardlink denial; member-lane worktree identity
- t10 finding closure: **3/3**; RESERVE3-001 blocker closed; CRASH3-001 and DIAG3-001 high findings closed
- new-child correlation: durable reserved/absent-checked childId before startActivation; concurrent and fast-end test coverage specified
- restart recovery: durable pre-dispatch session boundary, startObserved/endObserved markers, turn/end synthesis, orphan/park/notice-before-release
- boundary semantics: BOUNDARY4-001 closed with inclusive half-open `preDispatchSessionSeq`; live child stores `session.seq` exactly, persisted session stores `events.length`, recovery starts inclusive
- settlement authority: stopReason is sole authority; completed-without-diagnostic succeeds; only missing/unknown stopReason fails closed
- context observation: `compaction/end` success=observed, start-only=unproven, `compaction/end.error`=unavailable
- ambiguities: **7/7** with decisions and rejected alternatives
- security terms and boundaries for #70/#121/#287: canonical path containment, local-only default, authenticated delivery, SSRF denial, cleanup preservation
- `git status --short -- src scripts lib docs package.json pnpm-lock.yaml`: empty
- design file: `.agent-teams/inputs/design/issue-backlog-design.md`
