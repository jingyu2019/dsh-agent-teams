# PRD 卡片：代码需求（Part A）

> 版本基线 `@nanmicoder/dsh-agent-teams` 0.1.33 · HEAD `e000f8a`（`e000f8af1062f23d8612fc40fdb3c6672010fa38`）· date: 2026-11-16
> 编号规则：`P0`/`P1`/`P2` 为优先级，后缀为该优先级内序号；编号与标题一经立项不改，降级只改前缀。合卡记一个编号（见 P2）。
> 证据口径：全部 `file:line` 均在本 HEAD 打开确认，只描述当前工作树；未验证项显式标注「未验证」。
> 成本口径：S ≈ 单模块 + 既有测试模式（0.5–1 天）；M ≈ 跨 2–3 模块 + 新测试面（2–4 天）；L ≈ 改调度/会话模型（1–2 周）。
> 范围：本文只写需求与验收，不含实现代码；`src/` 改动一律另起实现 PR。

### P0-1 `plan.members[]` 补 `executionPrompt` 字段

- **问题**：`agent_teams_create` 的 `plan.members[]` 走 `additionalProperties: false` 的对象 schema，但属性表里没有 `executionPrompt`，模型传入的该字段在工具网关层被静默丢弃；同一次调用若只依赖 `preset_id` 则正常，显式覆盖人设则失效，且不报错。用户可见后果：队长以为已给成员设定专属执行提示，实际成员按默认人设启动。
- **证据**：`src/tools.ts:1202-1208`（members items，属性只有 name/role/provider/model/reasoning_effort/tool_policy/skills/preset_id）；`src/tools.ts:3689` 消费端读 `member.executionPrompt ?? preset?.executionPrompt`；`src/tools.ts:186` `ManualStagedTeamInput.members[]` 已声明 `executionPrompt?`，说明 Web 暂存路径能带值、模型工具路径被截断；对照 `src/tools.ts:1997`（`add_member` 有 `execution_prompt`）、`:2072`（写入）。
- **方案要点**：
  1. 在 `plan.members.items.properties` 增 `executionPrompt: { type: 'string', description: … }`，保持 `additionalProperties: false` 不放宽。
  2. 只增驼峰 `executionPrompt`，不并行收 `execution_prompt`——`src/profiles.ts:28` 的 `MEMBER_KEYS` 已只认驼峰。
  3. 空串当省略，复用 `src/tools.ts:3676-3693` 已有的 `trimmedOptional` 归一化，不新增分支。
- **验收标准**：① 传 `plan.members[0].executionPrompt='X'` 后落盘成员 `executionPrompt==='X'`；② 只传 `preset_id` 时成员取 preset 的值、不被空串覆盖；③ 传未知键仍被拒（证明 `additionalProperties:false` 未松）；④ `docs/tool-surface-budget.json` 重算并把增量写进 PR 描述。
- **成本**：S
- **风险与回滚**：schema 增字段会加工具面 token，可能触发 token-neutral gate（`docs/optimization-directions-2026-11-02.md:143-150`），需先算增量再合。回滚：删该属性行 + 回滚回归用例，无数据迁移。
- **依赖**：无。与 P0-2 互不关联。

### P0-2 `requireStagedTeam` 错误文案按工具区分

- **问题**：`requireStagedTeam` 固定抛「team X is already running; its plan can no longer be edited」，语义是「整队上锁」。但该函数只挂在 5 个计划评审入口上；`add_member` / `create_task` / `reassign_task` 在运行中团队完全可用。用户可见后果：在 Web 计划评审按钮上被告知整队不可编辑，随后却能加成员建任务，形成自相矛盾的提示。
- **证据**：`src/tools.ts:343-348`（定义，`:345` 为抛错行）；调用点 5 处 `:879`（`updatePlanBatch`，`allowPendingEdits=true` 时跳过）、`:1073`、`:1120`、`:1144`、`:1160`；`edit_plan` 于 `src/tools.ts:1942` 传 `allowPendingEdits=true` 故永不触发；`add_member` `:2025-2105`、`create_task` `:2355` 起、`reassign_task` `:2481` 起均不调用；浏览器入口 `src/tools.ts:1018-1020`。全仓仅 `src/tools.ts:345` 产出该串，`src/client/` 无字符串匹配。
- **方案要点**：
  1. 签名改 `requireStagedTeam(team, surface)`，`surface` 是面向用户的动作名（approve / continue / discard / edit staged plan）。
  2. 文案改为 `team "X" is running; <surface> is only available for a staged plan awaiting review`，保留 team 名。
  3. 只改文案与形参，不改「是否抛出」的条件；5 个调用点各自传参。
- **验收标准**：① 运行中团队调 approve 路径，错误含 `approve` 且不含 `its plan can no longer be edited`；② 同一团队 `add_member` 仍成功（断言不被该错误拒绝）；③ 断言旧串的测试改为按 surface 匹配；④ `grep -rn "its plan can no longer be edited" src/` 只剩 0 命中。
- **成本**：S
- **风险与回滚**：低。风险仅在于前端若按文案匹配渲染会失配，已确认 `src/client/` 无该串。回滚：单文件 revert。
- **依赖**：无。

### P0-3 派单期写范围准入闸

- **问题**：范围互斥只在 `create_task`（及 `edit_plan` 的 `update_task` 复验）时检查，且只覆盖 `implementation`/`repair`。真派单时，两个已声明重叠 `inScope` 的任务会被同时发给两个成员，并写同一批文件。用户可见后果：并行成员互相覆盖，回滚后才发现冲突，质量链的 inScope 审计只能事后追责、不能事前阻止。
- **证据**：`src/quality-gates.ts:38`（`WRITE_KINDS`）、`:348`（`inScopeOverlap`）；唯一任务侧调用在 `:456-470`，位于 `validateCreateTask`（`:390`）内；`src/tools.ts:2357` 与 `:992` 是仅有的两个校验入口。派单路径 `src/scheduler.ts:1471`（取锁）→ `:1534-1536`（`nextReadyTask` 选任务）→ `:1554`（`beginTaskAttempt`）无任何 `inScope` 检查；`reassign_task` `src/tools.ts:2481-2530` 同样没有。
- **方案要点**：
  1. `src/quality-gates.ts` 增纯函数 `admissionScopeConflict(team, task)`，返回与「在跑（`OPEN_STATUSES`）且 `WRITE_KINDS`」任务的重叠列表；两个任务都显式声明 `inScope` 才判定。
  2. `src/scheduler.ts` 在 `:1534` 选到 task 后、`:1554` `beginTaskAttempt` 前调用；命中则本轮不派单、成员留 idle 并记 warn，靠后续 kick 重试（= 串行化，不改 DAG、不改任务状态）。
  3. 防饥饿：若本轮所有候选都被闸住，按进队顺序放行最早的一个，避免两个无依赖但互斥的任务永久互相等待。
  4. worktree lane 生效时（`task.workspace?.kind === 'member_lane'`）直接放行；`reassign_task` 复用同一函数拒绝并给出两个 task id。
- **验收标准**：① A、B 均为 `implementation`、`inScope=['src/a.ts']`、无依赖，A 在跑时 kick 不派 B（`beginTaskAttempt` 未被调用）；② A 完成后 B 正常派单；③ 仅一方声明 `inScope` 时不判定（保守口径）；④ `reassign_task` 到同范围成员被拒，错误含两个 task id；⑤ 现有并行用例不回归。
- **成本**：M
- **风险与回滚**：中低。串行化误伤会降低并行度，故加 ③④ 两条保守口径与第 3 点防饥饿；`kind=work` 默认不参与判定。回滚：删纯函数 + 还原 `:1534` 附近调用点。
- **依赖**：需先定产品口径（拒绝 or 串行），建议默认串行；与 P0-4 可并行开发但同改 `src/tools.ts`，需约好 rebase 顺序。

### P0-4 任务改写 `expected_revision` 乐观锁

- **问题**：`attempt`/`attemptId` 只拦「旧执行代际写结果」，拦不住「队长读到旧卡片后改写合同」。队长两次 `amend_task` 之间若有另一处修改（包括另一次 amend），后写者静默覆盖，revisions 台账里两次修订都「成功」。用户可见后果：合同字段被按过期判断改写，成员按错误契约执行。
- **证据**：`src/tools.ts:2962`（`amend_task` 工具）、`:2964-2972`（参数表，无 `expected_revision`）、`:2990-3025`（执行体，锁在 `:2995`，`amendTaskContract` 在 `:3005`）；`src/types.ts:264`（`revisions?: TaskRevision[]`）、`:138-149`（`TaskRevision`）；`src/quality-gates.ts:749` `amendTaskContract`、`:810-823` 追加 revision。全 `src/` grep `expected_revision` 无命中。
- **方案要点**：
  1. `amend_task` 增可选 `expected_revision: number`；实现里以 `task.revisions?.length ?? 0` 为当前版本，给了值且不等即拒绝，错误同时给出 `current` 与实际计数。
  2. 同一可选参数加到 `reassign_task`；`edit_plan` 的 `update_task` 可第二批。
  3. 拒绝发生在锁内、写盘与 `appendTimeline` 之前，保证不产生半写。
  4. 非安全整数视为省略（与现有 optional 参数归一化一致），不因类型噪声误拒。
- **验收标准**：① revision=0 时传 `expected_revision=1` 被拒，错误含 `0`，`team.json` 字节不变；② 传 `0` 成功且 `revision_count` 变 1；③ 不传时行为与今天一致；④ 并发两次 amend（读到同一 revision）第二次必被拒。
- **成本**：S
- **风险与回滚**：低，纯可选参数、不改既有调用方。风险是调用方习惯性传字符串导致误判，故有第 4 点。回滚：移除参数与校验分支。
- **依赖**：无。与 P0-3 同改 `src/tools.ts`，注意冲突面。

### P0-5 消息 `idempotencyKey` + A↔B 反乒乓上限

- **问题**：现状只有「内容完全相等」式去重，且要求 task/attempt 身份一致；调用方无法主动声明「这是我这次投递的同一件事」。更关键的是两个成员互发「收到请回复」时没有任何链路上限，mailbox 会按 tick 单调增长，直到人介入。用户可见后果：重试或崩溃恢复后重复投递无法按语义去重；对刷会持续烧 token 并挤占成员上下文。
- **证据**：`src/types.ts:498-530`（`TeamMessage` 无 `idempotencyKey`）；内容式去重 `src/tools.ts:3118-3126`，`delivered:'duplicate'` 在 `:3063` 声明、`:3182` 返回；`send_message` 定义 `:3044`；`src/mailbox.ts` 全文无 rate/ping-pong 逻辑。
- **方案要点**：
  1. `TeamMessage` 增 `idempotencyKey?: string`；`send_message` 增同名可选参数，按 `(teamId, to, from, key)` 判重，命中直接回既有 message id + `delivered:'duplicate'`。
  2. 反乒乓：`src/mailbox.ts` 增纯函数统计窗口内同一对 `(from,to)` 的往返数，超阈值（默认 8）拒绝并提示改走任务契约或 `collect`。
  3. 新 key 判重先于既有内容判重，不改现有路径；窗口与阈值进 config（参照 `src/index.ts:222` 的 zod 形状）。
- **验收标准**：① 同 key 连发两次 → 第二次 `delivered:'duplicate'`，mailbox 仅 1 条；② 不同 key 同内容 → 2 条（现有行为不回归）；③ A→B/B→A 各 5 轮后第 9 条起被拒，错误含阈值与当前计数；④ 阈值置 0 可关闭该闸。
- **成本**：S
- **风险与回滚**：低-中。阈值会误伤正常长对话，故默认值放宽且可配置关闭。回滚：配置置 0；字段为可选，旧 `team.json` 不需迁移。
- **依赖**：无。建议与 P0-4 同一实现批次，共用可选参数归一化。

### P1-1 平台 optional 包 cohort 校验

- **问题**：`verifyCohort()` 遍历 lock 里每个 `@deepseek-ai/dsh*` 条目并直接读盘。npm 会把其他平台的 optional 包写进 lock 但不落盘，于是 macOS/arm64 上遇到 linux-only 条目直接 ENOENT 抛错，运行时验证在非目标平台无法开跑。用户可见后果：CI/本地验证假红，且报错指向「缺包」而非「平台不适用」。
- **证据**：`scripts/harness-runtime-verify.mjs:112-127`（`verifyCohort`，`:117` 为无平台判定的 `readFileSync`，`:119` 抛 `Mixed host cohort`，`:123` 抛 `No actual Harness installation`）；`scripts/harness-runtime-cohort.mjs` 不存在，`optional-platform` / `skipped` / `inspectRuntimeCohort` 全仓无命中；`scripts/harness-runtime-platform.test.mjs` 仅 31 行 2 个用例（`:8`、`:23`），主体是 `linkDirectory`（`:16/19/29`），与 cohort 无关。
- **方案要点**：
  1. 新增 `scripts/harness-runtime-cohort.mjs`，导出 `inspectRuntimeCohort(runtime, version, {platform, arch})`：按 lock 条目的 `os`/`cpu` 约束判定，非本平台的 optional 包归入 `skipped[{reason:'optional-platform'}]` 而不是读盘。
  2. `verifyCohort()` 改为调用它，保留 `cohort`/`lockSha256` 输出形状；非 optional 的缺盘条目仍必须抛错。
  3. 不改 `src/`，不引入网络依赖。
- **验收标准**：① 新增用例构造含 darwin/arm64 与 linux/x64 两条 optional 条目的 lock，`inspectRuntimeCohort(..., {platform:'darwin', arch:'arm64'})` 的 `skipped[].reason` **严格等于** `'optional-platform'`；② `cohort` 只含本机包；③ 负向：非 optional 条目缺盘仍抛错；④ `node --test scripts/harness-runtime-cohort.test.mjs` 通过；⑤ `grep -n inspectRuntimeCohort scripts/harness-runtime-verify.mjs` 有命中。
- **成本**：S（上游口径 4 文件 +81/−13）
- **风险与回滚**：低，纯脚本。注意现有 `harness-runtime-platform.test.mjs` 今天即通过，**不得**当本卡验收。回滚：删新文件 + 还原 `verifyCohort`。
- **依赖**：无，不碰 `src/`。

### P1-2 `.github/workflows/publish.yml` consumer-resolution 守卫

- **问题**：`consumer-resolution` 只声明 `needs: publish`，缺 `if`。`needs` 只保证顺序，不保证成功即执行语义；publish 失败或 workflow 被取消时该 job 仍会进入并跑满 6 分钟超时，产出无意义的 channel 报告，还可能让 `release` 读到不一致的 readiness。用户可见后果：失败发版上出现「桌面渠道未就绪」的噪声结论。
- **证据**：`.github/workflows/publish.yml:164-171`（job 头，`:166` 为 `needs: publish`，无 `if`）；同文件已有 `if` 的 job：`:31` `verify`、`:35-39` `publish`、`:218` `release`（用的是 `always() && needs.publish.result == 'success'`）。
- **方案要点**：
  1. 在 `needs:` 之后加 `if: ${{ !cancelled() && needs.publish.result == 'success' }}`。
  2. 不动 `release` 的既有条件：它以 `needs.consumer-resolution.outputs.ready` 取值，缺失时 `:233` 已有 `'unknown'` 兜底。
  3. job 内 step 不改。
- **验收标准**：① 解析 workflow 断言 `jobs.consumer-resolution.if` 含 `needs.publish.result == 'success'` 与 `!cancelled()`；② publish 失败/取消场景下该 job 为 skipped 而非 failed（PR 附一次失败运行截图）；③ diff 仅新增 1 行，`release` 的 `if` 行未变。
- **成本**：S（1 行）
- **风险与回滚**：低。风险是与同文件 `release` 用 `always()` 的口径不一致，评审时需说明「consumer-resolution 是测量而非发布，取消即无意义」。回滚：删该行。
- **依赖**：无。

### P1-3 `ownEvents()` 改范围读

- **问题**：`sessionOwnEvents` 每次调用都取整份会话日志再交给调用方。长会话（数万事件）下，邮件投递判定这条路每 tick 都要构造一个全量数组，内存与 GC 随会话长度线性上涨，且 4 个调用点都会被放大。
- **证据**：`src/harness-compat.ts:346-353`（`:349` 调 `session.ownEvents()` 返回全量，`:351-352` 旧宿主回退 `events.slice(seedLength)`）；调用点 4 处：`src/mailbox.ts:217`、`src/members.ts:889`、`:1118`、`:1457`；正确范式 `src/scheduler.ts:1151-1163`（`:1153-1154` `snapshotEvents(SessionLogOffset(from))`），`SessionLogOffset` 来自 `@deepseek-ai/dsh-session`（`src/scheduler.ts:17`）；现有契约测试 `scripts/harness-compat-tdd.mjs:233-241` 断言全量读行为。
- **方案要点**：
  1. 签名改 `sessionOwnEvents(session, from = 0)`：有 `snapshotEvents` 时走 `SessionLogOffset(from)`，否则沿用 `ownEvents()`/`events` 并在 JS 侧 `slice(from)`；legacy 的 `seedLength` 剥离语义必须保留。
  2. 4 个调用点各带自己的 `from`：`mailbox.ts:217` 只需当前 turn 尾部（`payload.turn`）；`members.ts` 三处只读会话头部的 descriptor，可传 `0` 但需只读一次并复用。
  3. 先做一次宿主探针，确认能否由 turn 反查 offset；拿不到就退化为「按 turn/start 定位后再 snapshot」，不留全量回退。
- **验收标准**：① 伪造 session 断言 `snapshotEvents` 收到 `SessionLogOffset(100)`；② 无 `snapshotEvents` 的旧 session（`events.length=1000`, `seedLength=10`）传 `from=500` 返回 490 条；③ `node --test scripts/harness-compat-tdd.mjs` 更新后通过；④ 长会话下 `mailbox.ts:217` 返回数组长度 ≤ 当前 turn 事件数。
- **成本**：M
- **风险与回滚**：中。`mailbox.ts:216-224` 的「拒绝只有过期邮件的 turn」判定依赖这里的事件序列，改错会让去重判定失效；且该处处于同步 hook 内，offset 来源未验证。回滚：还原签名与 4 个调用点，单 commit 可逆。
- **依赖**：宿主是否暴露 turn→offset 属未验证项，实现前必须先探针。

### P1-4 专家目录导入

- **问题**：专家库只有私有 `presets.json`，既不认 `plugin.json + agents/*.md + skills/ + avatars/` 这一事实格式，也没有任何导入入口。用户可见后果：存量专家内容只能逐条手抄成 `save_agent_preset` 调用，迁移成本高且易漏 skill 映射。
- **证据**：`src/agent-library.ts:7`（`AGENT_LIBRARY_FILE`）、`:8`（上限 100）、`:21-32`（`isPreset` 校验）、`:34`（load）、`:72-104`（`saveAgentPreset`）、`:106`（delete）、`:58-69`（`AgentPresetInput` 必填 name/role/executionPrompt/skillIds）；`AgentPresetV1` 在 `src/types.ts:566-581`；全文件无 import/export 解析；工具面 `src/tools.ts:1668`/`:1703`，Web 路由 `src/index.ts:715`，默认关 `src/index.ts:222`。
- **方案要点**：
  1. 新增 `src/agent-library-import.ts`，导出 `importExpertDirectory(dir, {knownSkillIds})`：`plugin.json` 定包元数据，`agents/*.md` 的 frontmatter → `role`/`model`、正文 → `executionPrompt`。
  2. `skills/` 目录名 → `skillIds`，**必须**命中 `config.skills` 的 owner 声明，未知 id 直接拒绝（沿用 `saveAgentPreset` 的 fail-closed 口径）。
  3. 写入复用 `saveAgentPreset`，保持 revision 递增、同名冲突与 100 条上限语义；产出必须是合法 `AgentPresetV1`。
  4. 入口先做 CLI（`scripts/import-experts.mjs`），不加工具面参数，避免触发 token-neutral gate；`avatars/` → `AgentPresetV1.avatar` 的映射形态在实现期确认（`AvatarRef` 是引用还是路径未验证）。
- **验收标准**：① 造 `plugin.json + agents/a.md + skills/x/` 后导入，`loadAgentLibrary` 得 1 条且 `revision` 合法；② `agents/a.md` 正文（含换行）原样成为 `executionPrompt`；③ 负向：未在 `config.skills` 声明的 skill 目录 → 抛错且库不变；④ 负向：超 100 条 → 抛 cap 错误；⑤ 同目录导入两次，presets 数量不变。
- **成本**：M（下限 S：若只支持单个 `agents/*.md`、不解析 skills/avatars）
- **风险与回滚**：低，不碰调度；主要风险是 skill id 映射错会让成员带上未声明技能，故 fail-closed。回滚：删新文件，无 schema 变更、无数据回滚。
- **依赖**：无。召唤手势（见 P2）依赖本卡的产物，但本卡不依赖它。

### P2 三条设计项合并：token/成本计量、`/expert-name` 零 token 召唤手势、只读交付免核验

- **问题**：三项都缺，但都不是能直接进实现的确定需求。① token 账本：`agent_teams_status` 不返回任何用量，队长无法判断哪个成员在烧预算。② 召唤手势：只有 `/agent-teams --profile X` 整队模板，没有「按名字召唤单个专家」的零模型 token 入口。③ 只读免核验：质量链固定，纯只读交付也要跑完整验证段。
- **证据**：① `byRole` 全 `src/` 无命中（`docs/analysis/current-capability-map.md` 记录它只在未合并分支 `128e29d`）。② `userInvocable`/`modelInvocable` 全 `src/` 无命中；现有入口是 `src/command.ts:87` `registerAgentTeamsCommand`，`:25` `profileCommandName` 按 profile 名生成命令，与 preset 无关。③ `src/quality-gates.ts:551` `evaluateQualityCompletion` 无 read-only 分支。
- **方案要点**：
  1. 三项只出 RFC，落 `docs/design/`，不合入实现；每节写落点、成本、以及「不做」的判据。
  2. token 账本先做只读聚合（以 attempt/session 为键），不参与任何调度决策，且不得增加 prompt/tool/schema 足迹。
  3. 召唤手势必须先做宿主探针：确认 `0.2.2-rc.3` 是否支持 `userInvocable:true` + `modelInvocable:false`；不支持则改 `ctx.commands.register` 方案，不得假设。
  4. 只读免核验必须以不可伪造的 host effective sandbox 为依据，否则维持固定质量链（宁可慢，不可放闸）。
- **验收标准**：① RFC 三节各有可复核 `file:line` 落点与成本；② 每节至少一条可转成测试的断言草案；③ 账本节明确写出「零足迹」论证；④ 手势节给出宿主探针三态结论之一（支持/不支持/未验证），未验证不得进入实现。
- **成本**：L（账本 L + 手势 S + 只读 S）
- **风险与回滚**：中。账本会触碰每轮请求路径，易破 token-neutral；只读免核验属放宽门禁，判定依据可被伪造即等于开门。本卡只产文档，无代码回滚面。
- **依赖**：与 backlog `#317`（token-neutral 决议）、`#223`、`#315` 重叠，立项时合并引用；手势项依赖 P1-4 的 preset 产物与宿主探针结论。
