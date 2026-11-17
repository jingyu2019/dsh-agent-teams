# 独立校验报告（2026-11-17）

对象：`docs/requirements/requirements-inventory-2026-11-17.md`（16 项需求清单）与 `README.md`（t14 更新）。
执行者：队长（captain）。**说明**：原计划由成员 event-stream 执行，但其连续两次被上游 `429 bili_throttle_hold` 打断（窗口 07:10Z），为避免继续烧额度，改由队长执行；因此本报告的独立性来自「命令可复跑 + 证据逐条列出」，而非执行者身份分离——读者可用下面的命令自行重跑。

## §1 命令与退出码

| # | 命令 | 退出码 | 证据 |
|---|---|---|---|
| 1 | `node scripts/git-artifacts.mjs` | 0 | `Git artifacts match source and build settings.` |
| 2 | `npm run --silent verify:harness-contract` | 0 | node:test 全绿，duration 119.8ms |
| 3 | `npm run --silent verify:issue-regressions` | 0 | duration 2850.4ms |
| 4 | `npm run --silent verify:capabilities` | 0 | duration 403.8ms |
| 5 | `npm run --silent verify:tool-surface-budget` | 0 | duration 135.7ms |
| 6 | `npm run --silent verify:readme` | 0 | duration 55.6ms（针对**改动后的** README 通过） |
| 7 | `node --test` × 11 个用例文件（fresh-context、dispatch-write-scope、m1-dispatch-wiring、m1-dispatch-diagnostics、m1-plan-member-schema、member-route-control、p1-4-agent-catalog、p0-5-idempotency、p0-4-task-revision、p2-readonly-delivery-token-metering、r4-dead-session-recovery） | 0 | `tests 77 / pass 77 / fail 0` |

未执行：`npm run verify` 整链——本机无 pnpm，链内 `pnpm` 调用会断（见 §4）。

## §2 清单 citation 抽查（6 条，全部命中）

| 声明 | 实际输出 |
|---|---|
| `src/tools.ts:564` `export const planMemberSchema` | 命中，行文一致 |
| `src/tools.ts:543` `export function requireStagedTeam(team: TeamState, operation: string)` | 命中，签名一致 |
| `src/quality-gates.ts:401` `export function writeScopeConflict(` | 命中 |
| `src/task-revision.ts:28` `export function expectedRevisionError(task: TeamTask, expected: number \| undefined): string \| undefined` | 命中，签名一致 |
| `scripts/harness-runtime-cohort.mjs:15` `export function inspectRuntimeCohort(runtime, version, { platform = process.platform, arch = process.arch } = {})` | 命中，默认参数一致 |
| `src/members.ts:1471` `export function freshContextEligibility(` | 命中 |

提交归属抽查（`git show --stat` 中是否真含该文件）：`754e5c7:src/quality-gates.ts`、`5fbf693:src/task-revision.ts`、`4d801de:src/agent-library.ts`、`784d978:src/tools.ts`、`9120b17:src/quality-gates.ts`、`f30ec3d:src/members.ts` —— 6/6 均命中。

## §3 README 名字核对

- 工具数：`node -e require('./lib/tool-names.js')` → `TEAM_TOOL_NAMES 24`、`CAPTAIN_TOOL_NAMES 20`、`CORE_CAPTAIN_TOOL_NAMES 11`、`MEMBER_TOOL_NAMES 4`，与 README 写的「24 team tools」「Members receive four team tools」一致。
- `agent_teams_agent_catalog`：`src/tool-names.ts:9` 存在，README 表述与 `src/agent-library.ts:418` 行为一致（目录约定、冲突报告、拒绝路径逃逸）。
- `idempotency_key` / ping-pong：README 的 24h、512 键、10 分钟 12 条、`AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT` 与 `src/tools.ts:1050` 及 P0-5 用例一致。
- `expected_revision` 三入口：README 写「update_task / reassign_task / edit_plan operation」，与 `src/tools.ts:3222`、`:2912`、`:1280` 三处一致。
- `fresh_context` 与 5 条拒绝原因：README 列出的 5 条与 `src/members.ts:1471` 的 `FreshContextSkipReason` 联合类型逐字对应。
- `AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT` 默认 3、status 显示 `spawn_failures` / `spawn_error`：与 `src/tools.ts:462` 及 status 渲染一致。
- 未发现 README 中出现不存在或不匹配的工具名/参数名。

## §4 未覆盖与阻塞

1. **`npm run verify` 整链不可跑**：本机 `pnpm` 不在 PATH，链内调用会中断；已逐项跑 6 个 verify 子项 + 77 条用例替代，覆盖率不等于整链。
2. **P1-2 的 workflow 门只在结构层验证**：`npm run verify:release` 检查 job/脚本结构，真实 GitHub Actions 行为未在本机执行。
3. **`/expert-name` 零 token 手势未实现**：依赖宿主 userInvocable 能力，本机未验证 `0.2.2-rc.3` 是否提供，清单已如实标注「未开始」。
4. **README 三处存疑未改**（已拍板）：Releases 段落中 v0.1.33 的 23 工具/42 段 verify 属已发布包存档证据，不改写；`README_ZH.md` 未同步；`docs/optimization-directions-2026-11-02.md:69` 的 23/11 工具数为日期化快照。
5. 成员执行路径本次未能完成：t13/t14/t15 均因 429 中断，最终由队长补齐。

## 结论

清单 16 项中 15 项有代码落点 + 用例 + 可复跑命令，1 项（`/expert-name`）如实标注未开始；README 与实现一致且 `verify:readme` 通过；77 条用例与 6 项 verify 全绿。**建议接受，附带 §4 的 5 条限制说明。**
---

## §0 更正（2026-11-17 16:28）

本报告写于 15:14，其「结论」段依据的是初版清单的「15/16 已交付」。随后成员 dispatch-gate 提交了独立复核（[`requirements-inventory-2026-11-17-status-review.md`](./requirements-inventory-2026-11-17-status-review.md)），队长逐条 grep 复核后确认 **6 处 PRD 明确要求但代码确实没做**（P0-3 reassign 路径、P0-4 amend_task、P0-1 budget json、R1 TTL、P1-1 断言、P1-2 无用例），清单已改判为「完整 7 / 部分 8 / 未开始 1」。

因此：
- §1 的命令与退出码、§2 的 citation 抽查、§3 的 README 名字核对 **仍然有效**（它们验证的是「写下的路径/名字是真的」，不是「需求做全了」）。
- §4 第 4 条与「结论」中「15 项有代码落点」的措辞 **失效**，以清单的改判与 `§裁定` 为准。
- 本报告自身也暴露了校验方法的边界：**校验「引用真实」不等于校验「需求完整」**——前者可以靠 grep 通过，后者必须逐条对照 PRD 的要诀，这正是独立复核抓到的部分。
