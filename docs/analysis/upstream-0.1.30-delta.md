# 上游 NanmiCoder/dsh-agent-teams v0.1.30 差异清单（对比本线 0.1.33）

> 生成时间：2026-11-16 · 方法：本地 git 对象比对（`git log/diff v0.1.29..upstream/main`），未做 `git fetch`（本机到 github.com 的 git 连接超时），依赖本地已有的 `upstream/main` = `4354b0f`。

## 0. 结论先行

**v0.1.30 没有需要"合并"的运行时功能。** 它是一次 Harness `0.2.2-rc.2` 兼容性补丁；本线（0.1.33，适配 `0.2.2-rc.3`）在能力上是它的**超集**，四条 release note 全部已有实现（见 §2）。

真正值得拿过来的是 **0.1.30 之后**（`v0.1.29..upstream/main` 区间内、tag 外）的两个工程性修复：

| 优先级 | 来源 | 内容 | 本线现状 | 动作 | 成本 |
|---|---|---|---|---|---|
| P1 | `2ee0409` | 校验平台相关的 optional Harness 包（`scripts/harness-runtime-cohort.mjs`） | **缺失** | 直接照搬 + 接进 `harness-runtime-verify.mjs` | S（~30 行 + 1 处调用） |
| P1 | `1f1977b` | `publish.yml` 的 `consumer-resolution` job 增加 `if: ${{ !cancelled() && needs.publish.result == 'success' }}` | **缺失**（`.github/workflows/publish.yml:164-168` 无 `if`） | 加一行 | S |
| P2 | `2ee0409` | `docs/harness-0.2.2-rc.2/` 运行时基线证据包（baseline/runtime JSON + README） | 无对应目录（本线用 `docs/alpha2-*.md`） | 可选：作为 rc.3 证据模板 | M |
| — | 全部 | v0.1.30 四条 release note | 已实现 | 无需动作 | — |

## 1. 提交区间

```
4354b0f Merge pull request #355 from NanmiCoder/codex/harness-022-rc2-compat
2ee0409 fix: validate platform-specific optional Harness packages        ← 0.1.30 之后
78e24f9 fix: support Harness 0.2.2-rc.2 and prepare v0.1.30             ← v0.1.30 本体
369c278 Merge pull request #344 from .../release-channel-probe-after-reuse
1f1977b fix: run desktop channel probe after reused candidate publish   ← 0.1.30 之后
```

`v0.1.29..upstream/main` 变更面：23 文件 +1198/-242，其中 `src/harness-compat.ts` +157、`lib/harness-compat.js` +124（构建产物）、`lib/client.js` 重写 354 行（构建产物）、`compatibility.json` +4、`src/mailbox.ts` +8/-8、`release-notes/v0.1.30.md` 新增。

## 2. v0.1.30 四条 release note 在本线的落点

| 上游宣称 | 本线证据 | 判定 |
|---|---|---|
| 恢复 `0.2.2-rc.2` 上的插件激活（子代理运行时移除了旧的 host 投递入口） | `src/harness-compat.ts:203-225`：注释明确记录 `0.2.2-rc.2 retired the process-stable deliverPrompt symbol`，改为 `manager.deliverPrompt(childId, content, {source, signal, delivery})`，无该函数时 `unsupported('missing 0.2.2 host FIFO delivery')` | 已实现 |
| 适配成员创建 / 排队的任务分配 / 步边界消息 / 冷恢复，保留模型、推理力度、工具限制 | 同上 + 本线 `codex/dsh-0.2.2-rc2` / `rc3` 分支的适配提交（`29d1364`、`8e737dc`）；`scripts/model-selection-compat.test.mjs` 覆盖模型选择兼容 | 已实现 |
| 停止选定成员及其后代，不影响无关兄弟与队长；已退役成员经模型或网页消息都不能重新启动 | `src/harness-compat.ts:482-542`（`install complete retired-member guard`，`SubagentError('NOT_RESUMABLE')`）+ `src/members.ts:1442 installRetiredMemberGuard`，`readRetiredMemberIds` 落盘（`src/state.ts`） | 已实现，且比上游更严 |
| 成员已回报完成后不再二次唤醒队长；结构化 stop reason 仍保留失败/缺失回报通知 | `src/mailbox.ts` 的 `isFinalReportForSettlement()` + `FINAL_REPORT_GRACE_MS` / `AGENT_TEAMS_FINAL_REPORT_GRACE_MS`（上限 2s）；`stopReason` 出现在 3 个源文件 | 已实现（实现路径不同） |

**实现路径差异（不需要跟进）**：上游在 `src/mailbox.ts` 引入 `successfulSubagentSettlement`（本线无此符号），并**简化**了 `isCurrentMail` 的终态校验（上游把 `TERMINAL_TASK_STATUSES` 换成内联数组）。本线保留更完整的 attempt/activation 绑定校验，属更严格实现，不回退。

## 3. 可直接搬运的两处工程修复

### 3.1 `2ee0409` 平台相关 optional 包校验（P1）

问题：`npm` 会为「其他平台」的 optional 包写进 lock 但不落盘。上游原 `verifyCohort()` 对 lock 里每个 `@deepseek-ai/dsh*` 直接 `readFileSync(package.json)`，在 macOS/arm64 上遇到 linux-only optional 包会抛 `Missing host package ... on darwin/arm64`。

上游解法：抽出 `scripts/harness-runtime-cohort.mjs` 的 `inspectRuntimeCohort(runtime, version, {platform, arch})`，按 `os`/`cpu` 约束判定，命中则归入 `skipped[{reason:'optional-platform'}]` 而不是抛错；同时把 `lockSha256` 一并产出。

本线现状：`grep -rn "optional-platform\|skipped" scripts/harness-runtime*.mjs` 无命中 → 未修。

落点：新增 `scripts/harness-runtime-cohort.mjs`；`scripts/harness-runtime-verify.mjs` 的 `verifyCohort()` 改为调用它；新增 `scripts/harness-runtime-platform.test.mjs`（上游 41 行，覆盖 darwin/win32/linux × arm64/x64 与 `!pkg` 负向约束）。

验收：`node --test scripts/harness-runtime-platform.test.mjs` 通过；在 macOS/arm64 跑 `node scripts/harness-runtime-verify.mjs --prepare-only` 不再因 optional 包缺失抛错。

### 3.2 `1f1977b` 发布流水线 job 守卫（P1）

`.github/workflows/publish.yml:164` 的 `consumer-resolution` 仅声明 `needs: publish`；`needs` 默认在依赖失败时跳过该 job —— 但上游发现「candidate publish 复用」路径下 job 仍会跑并报错，故加 `if: ${{ !cancelled() && needs.publish.result == 'success' }}`。

本线现状：`:164-168` 无 `if` 行 → 未修。

验收：`grep -n "consumer-resolution" -A4 .github/workflows/publish.yml` 能看到该 `if`。

## 4. 明确不需要的

- `lib/*.js`（构建产物）、`lib/client.js` 的 354 行重写：上游是对其自身 `src/client/ActivityPanel.tsx` 的旧版构建；本线 client 已重写并带 `docs/activity-etag`、`docs/snapshot-payload` 等验证，不合并。
- `compatibility.json`：上游把 recommended 回到 `0.2.1-rc.2` 并把 `0.2.2-rc.2` 降为 preview；本线 `recommendedHost: 0.2.2-rc.3` 是本线目标，不跟随。
- `package.json` 的 `verify` 聚合脚本收缩：上游 0.1.30 的 `verify` 比本线**少** 20+ 个子验证（本线多出 `verify:issue-333/335/330`、`memory-trace`、`tool-surface-budget`、`install-preflight` 等），不跟随。

## 5. 未验证项

- 上游是否存在 `v0.1.30` 之后的 `v0.1.31+` tag：本地 `git tag --list 'v0.1.2*'` 只到 `v0.1.29`，`git fetch upstream --tags` 因网络失败，**未验证**。
- 上游 issue 侧结论见 `docs/analysis/upstream-issues-triage.md`（另一份报告）。
