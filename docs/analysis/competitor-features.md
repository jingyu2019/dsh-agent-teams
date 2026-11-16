# 同类 DSH 多 Agent 插件能力分析（2026-11-16）

本文只记录**可复核的证据**：仓库真实地址、抓取到的元数据、读过的源码文件。凡是只读到 README、宣传段或 npm 描述的内容，一律标注「文档级验证」；凡是没读到实现的，标注「未验证」。不把营销文案当事实。

- 抓取时间：2026-11-16
- 数据来源：`api.github.com`（元数据 / contents API 取源码 base64）、`registry.npmjs.org`（包描述与 README）
- 说明：本机到 `raw.githubusercontent.com` 的直连不通，源码统一走 contents API 读取；`zhu1090093659/dsh-web` 因仓库体积过大（GitHub 报告 `size` 1,544,170 KB）且 API 限额耗尽，**只做到文档级验证**。

本仓库基线（对照用）：`@nanmicoder/dsh-agent-teams@0.1.33`，2975 stars / 245 forks，`pushed_at` 2026-11-13T03:30:36Z。

---

## 1. limuyang2/agent-team —— 成员即独立 root 会话

- **地址**：https://github.com/limuyang2/agent-team
- **npm**：`@limuyang2/dsh-agent-team@0.1.4`
- **元数据**：52 stars / 8 forks / MIT；`created_at` 2026-08-17，最后提交 `2026-08-26T06:43:15Z`（`merge: release 0.1.4`）——**距今约 3 个月无提交**
- **验证程度**：源码级（`src/domain/schemas.ts`、`src/runtime/team-tools.ts`、`src/runtime/team-runtime.ts` 片段、`src/runtime/scoped-skills.ts`、`src/service/workspace-tracker.ts`、`src/service/workspace-service.ts`、`package.json`、`git/trees`）

### 痛点

原话是「subagent 继承了父会话昂贵的模型、宽工具目录和不断增长的上下文」：一个写 commit message 的小任务也会跑在架构级模型上。它的解法是**不给 subagent，给独立 root agent**。

### 核心机制

| 维度 | 实现 | 证据 |
|---|---|---|
| 会话模型 | 成员是独立 root agent：`ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions: { provider, model }, setup })` 或 `ctx.agents.resume(...)`，随后 `workspace.attachSession(sessionId)` | `src/runtime/team-runtime.ts`（`agents.create` / `agents.resume` / `attachSession` 分支） |
| 成员配置 | `assistantTemplate` 快照：`provider` / `model` / `reasoningEffort` / `agentPresetId` / `permissionPresetId` / `skillAllowlist` / `mcpServers` / `instructions` | `src/domain/schemas.ts` `assistantTemplateSchema` |
| 技能作用域 | 自定义 `SkillProvider` + `ctx.tools.guard`：未在该成员 `skillAllowlist` 内的 `skill` 调用被拒绝 | `src/runtime/scoped-skills.ts`；`team-runtime.ts` 中 `tools.guard` 拒绝逻辑 |
| 文件租约 | `fileScopeLeaseSchema`：`{ slotId, taskId, path, acquiredAt, expiresAt? }` 挂在 `teamAggregate.leases` | `src/domain/schemas.ts` |
| 消息 | `teamMessage`：`sender{user|member|system}` / `recipient{leader|member|broadcast}` / `type` / `deliveryState(queued|delivered|read|failed)` / **`idempotencyKey`** | 同上 `teamMessageSchema` |
| 长操作日志 | `operationSchema`：`kind(dissolve_team|remove_member|sync_member|migrate_records)` + `state` + `stage` + `cursor` + `errorCode` | 同上 `operationSchema` |
| 工具面 | 只有 4 把：`team_get_task_board` / `team_create_task` / `team_update_task` / `team_send_message` | `src/runtime/team-tools.ts` |
| 提示段校验 | 组装后必须同时含 `identitySection` 与 `rosterSection`，否则抛 `PRESET_PROMPT_INCOMPATIBLE` | `team-runtime.ts`（`systemPrompt.assemble` 后校验） |
| UI | React 工作台：多列真实会话并排、浮动 launcher、上下文环（context 用量 / token / cache 命中率）、Git diff 预览 | `src/client/{assistant,team,workbench,workspace}/`（40–49 KB 级组件） |

### 依赖的 DSH host API

`ctx.agents.create/resume`、`ctx.workspaceRegistry.get().attachSession/detachSession`、`ctx.sessionPersistence.list/inspect`、`ctx.sessions.flush`、`ctx.skills.registerProvider`、`ctx.permissionPresets.set`、`ctx.systemPrompt.assemble`、`ctx.tools.register/guard`、`ctx.webServer.register`。peer 依赖把 `@deepseek-ai/dsh-*` **全部锁在 `0.1.1-rc.2`**（`package.json` `peerDependencies`），与本仓库的 `0.2.2-rc.3` 目标差了两个 minor 段。

### 成熟度

- 有 zod 严格 schema、20 个 vitest spec、`scripts/check-architecture.mjs` 架构守卫，工程质量中上。
- 但**已 3 个月无提交**，host 版本停在 `0.1.1-rc.2`；`fileScopeLease` 我只在 schema 与 `leases: {}` 初始化处看到，**是否在领取/派工时强制执行未验证**（明确标注：未验证）。
- 结论：**数据模型可借鉴，运行时不可照搬。**

### 对本项目的可借鉴点

1. **成员配置快照的形状**：`provider/model/reasoningEffort/permissionPresetId/skillAllowlist/mcpServers` 一次性冻结在成员上，编辑模板不热更新已有成员 —— 与本仓库 `agent-library.ts` 的 `AgentPresetV1`（`src/types.ts:566-581`）几乎同构，缺的只是 `permissionPresetId` 与 `mcpServers` 两个维度。
2. **消息 `idempotencyKey` + `deliveryState`**：本仓库 `TeamMessage`（`src/types.ts:498-530`）有 `deliveryClaimedAt` / `deliveredAt` / `readAt` / `discardedAt`，**没有幂等键**，重试路径只能靠 attempt 代际兜底。
3. **`operation` 长操作日志**：本仓库的删除/接管是即时状态机（`docs/usage.md:43`），没有「stage + cursor 可续跑」的中断恢复记录。
4. **不借鉴**：成员作为独立 root agent。见 §7。

---

## 2. weibaohui/experts-management —— 专家市场与「零 token 角色召唤」

- **地址**：https://github.com/weibaohui/experts-management
- **npm**：`@weibaohui/experts-management@0.5.12`
- **元数据**：3 stars / 1 fork / **无 license 文件**；`pushed_at` 2026-11-03T13:17:52Z
- **验证程度**：源码级（`src/index.js` 1345 行，读了 skill provider 注册段与 API 段、`package.json`、README、`git/trees`）

### 痛点

「专家」这类角色资产散落在各格式里，且直接塞进模型目录会污染 token。它的解法是：**专家 = 一个「只允许用户调用、模型不可见」的 skill**。

### 核心机制

| 维度 | 实现 | 证据 |
|---|---|---|
| 召唤方式 | `ctx.skills.registerProvider`，候选带 `invocation: { modelInvocable: false, userInvocable: true }`，名字前缀 `expert-`；用户输入 `/expert-名称` 时宿主 pre-step 确定性注入 `<skill_content>` | `src/index.js:783-846`（`list()` / `get()`） |
| 零 token 原理 | `modelInvocable: false` → 不进模型技能目录；只有用户手势可触发 | 源码注释：「不进模型目录（零 token 污染）」 |
| 专家格式 | WorkBuddy 兼容：`<expert>/.codebuddy-plugin/plugin.json` + `agents/<name>.md`（YAML frontmatter）+ `skills/<x>/SKILL.md` + `avatars/` | README「专家定义格式」 |
| 团队专家 | `expertType: 'team'` → 负责人 + `members[]`，注入时**使用负责人的角色定义** | `src/index.js:160-187`、`1217-1230` |
| 内容来源 | `ntd-resource` 仓库 `experts/` 子树 **git 稀疏检出**（`--depth 1 --filter=blob:none --sparse`，只拉专家目录不拉 400MB 技能库），每日 fetch/reset | README「内置自动同步」 |
| 用户库 | `$DSH_HOME/experts`，另有 `extraSources` 显式扩源 | 同上 |
| HTTP | `/experts-management/api` + `ctx.connection.requestRejection()` 信任栅栏（Host/Origin + 浏览器认证） | `src/index.js:865-880` |
| 分享 | AI 读本机 token → fork → 建分支 → 提交到 `experts/` → 开 PR | README |

### 依赖的 DSH host API

`ctx.skills.registerProvider`、`ctx.webServer.register`、`ctx.connection.requestRejection`、`ctx.agents` / `ctx.sessions` / `ctx.agentDefaultModel`（分享流程静态捕获）、`ctx.settings`。`engines.dsh: ">=0.1.7-rc.2"`，比本仓库目标低。

### 成熟度

- 单文件 1345 行 `src/index.js`（无 TS、无 bundler），`client/bundle.js` 109 KB，测试是 `node --test`（`test/experts.test.mjs` 38 KB + `test/ui.test.mjs` 15 KB），README 版本表记录到 0.5.12 的逐版本回归。
- 有明确踩坑记录（Config 导出 null 炸 `settings.describe()`、volatile 字段物化污染设置），说明经过真实宿主适配。
- **无 license**，star 数极低，属个人项目；作为**格式与手势参考**可用，作为依赖不可用。

### 对本项目的可借鉴点

1. **`userInvocable: true / modelInvocable: false` 的角色召唤手势**：本仓库的 `/agent-teams --profile X`（`src/command.ts:87-119`、`docs/usage.md:125`）是「整队模板」，不是「单个角色」。把 `AgentPresetV1` 也暴露成 `/preset-名称` 手势，是**零模型 token** 的（不违反 `docs/optimization-directions-2026-11-02.md:143-150` 的 token-neutral gate）。
2. **专家目录格式作为导入格式**：`plugin.json + agents/*.md + skills/ + avatars/` 是事实标准（50+ 专家内容已按此格式沉淀）。本仓库 `src/agent-library.ts` 的 `presets.json` 是私有 JSON，加一层目录导入适配即可接入存量内容。
3. **不借鉴**：稀疏检出 + 每日 fetch/reset + 一键分享 PR。需要 git 网络、需要托管 token，运维面远大于收益。

---

## 3. cao123-2024/dsh-cross-session —— root 会话间喊话与「反向求助」

- **地址**：https://github.com/cao123-2024/dsh-cross-session
- **元数据**：**0 stars / 0 forks** / MIT；`created_at` 2026-11-08，`pushed_at` 2026-11-14T06:10:12Z（活跃但极新）
- **验证程度**：源码级（`index.js` 1264 行，读了 `deliver()`、工具名清单、rate-limit 段；`git/trees` 全量；README）

### 痛点

子代理 / 工单体系里的会话在侧边栏看不见、不能插话、不能回问。它的解法：**每个 agent 就是一条真实的 DSH root 对话**。

### 核心机制

| 维度 | 实现 | 证据 |
|---|---|---|
| 投递 | `ctx.sessionController.resolveAgent(id)` 拿 live Agent（冷会话自动 resume）→ `agent.steer(createRelayMessage(...))`；运行中在最近 step 边界收到，空闲则唤醒新 turn | `index.js:564-591` |
| 来源标注 | relay 的 `senderSessionId` 写成可读的 `AI「标题」`，真实 id 放 `senderSessionIdReal` | `index.js:568-585` |
| 工具面 | 14 把：`new_conversation` / `assign_agent_role` / `get_agent_team` / `list_conversations` / `shout` / `ask_master` / `get_chat_info` / `rename_conversation` / `interrupt_conversation` / `archive_conversation` / `list_permission_presets` / `list_models` / `configure_conversation` | `index.js` 各 `name:` 行 |
| 层级 | 2/3/4 层，**靠对话标题前缀**（`队长｜` / `总监｜` / `经理｜` / `worker｜`）+ 客户端图标 | README「团队层级」 |
| 反向求助 | `ask_master` 只给 worker：把阻塞直接交给创建它的主 Agent，不问用户 | README / `index.js:1075` |
| 只读窥视 | `get_chat_info` **只注册在非 worker 作用域**（worker 工具列表里没有），目标完全无感知 | README「主 Agent 专属上下文」 |
| 护栏 | `maxCreatedConversations: 12` / `rateLimitPerMinute: 20` / `maxMessageBytes: 32768` / **`maxShoutChain: 6` 防 AI 乒乓** / 拒绝 subagent 会话 | `index.js:590-620`（`checkRate`）、`cordis.patch.yml` |

### 依赖的 DSH host API

`ctx.sessionController.{list,create,resolveAgent,modelCatalog,selectModel}`、`agent.steer/followup`、`createRelayMessage`、`ctx.sessions.flush`、`ctx.tools.register`。无第三方依赖。

### 成熟度

- **0 star、单作者、11-08 才建仓**，无测试目录，`client.js` 只有 4 KB。
- 但 README 有罕见的**自曝短板**章节（重启后 pending inbox 不自唤醒、只支持 root 会话、工作区不能原地迁移、Super Agent 对比表），可信度高于纯营销 README。
- 结论：**安全护栏值得抄，传输机制不值得**。

### 对本项目的可借鉴点

1. **反乒乓护栏**：`maxShoutChain`（同一对会话交替喊话上限）+ 每分钟限流 + 消息体积上限。本仓库 `TeamMessage` 与 mailbox（`src/mailbox.ts`、`src/state.ts:593-620`）有界但**没有「两个 agent 互相刷屏」的链路计数**；`agent_teams_send_message` 是任意成员→任意成员，理论上可对轰。
2. **`get_chat_info` 式的只读进度窥视**：本仓库有 `agent_teams_status`（`src/tools.ts:3336`）与 1s 快照轮询，但读的是**插件自己的账本**，不是成员会话的 live turn/step/最近工具调用。
3. **不借鉴**：root 会话间 `steer` 传输、标题前缀当角色、`ask_master`。理由见 §7。

---

## 4. 8kugames/dsh-team-bots —— 项目群聊 + 看板 + 写范围并行调度

- **地址**：https://github.com/8kugames/dsh-team-bots
- **npm**：`dsh-team-bots@0.3.70`
- **元数据**：1 star / 0 forks / Apache-2.0；`pushed_at` **2026-11-16T06:25:11Z**（当天仍在推）；491 个 blob
- **验证程度**：源码级偏重（`src/tools.ts` 全量、`src/services/write-scopes.ts` 全量、`src/services/scheduler.ts` 关键闸门段、`src/services/memory.ts` grep、README、`package.json`、`git/trees`）

### 痛点

不是「一个队长带几个手下」，而是「一个工作区长期跑一支机器人团队」：需要群聊、看板、并行、记忆、额度、渠道、审计。

### 核心机制

| 维度 | 实现 | 证据 |
|---|---|---|
| **写范围并行调度** | 任务声明 `write_scopes`（相对项目目录）；**两侧都声明且路径前缀不重叠才并行**；任一未声明 = 保守串行；`package.json` 机械豁免；派单前用 `git check-ignore --no-index` 剔除假声明 | `src/services/write-scopes.ts` 全文件；`scheduler.ts:632-640`（`runningScopes.some(other => writeScopesOverlap(...))` 即跳过） |
| 冲突判定 | `writeScopePathsOverlap`：相等或一方是另一方的目录前缀（按 `/` 分段） | `write-scopes.ts` |
| 任务模型 | 7 态 `backlog/todo/in progress/blocked/in review/done/canceled` + 父子卡 + 优先级 + 写范围 + 时间预算（硬超时中止）+ 卡片级用量 | README「Task board」 |
| 改写围栏 | `team_assign_task` 带可选 `expected_version`，卡片已变则拒写并列出最新变更 | README「Amending a card」 |
| 事件权威 | 状态迁移与 `status` 事件同事务写入，可回放；`task_projection_drift` 只读核对投影漂移 | README「Task status transitions」 |
| 验收 | 强制 subagent 核验台账（当前复审周期内必须有条目）；只读交付（沙箱 read-only）跳过并标注 | README「Acceptance」 |
| 记忆 | `active/frozen/archived` 生命周期，owner 写/审/冻/归档，全 bot 可读；任务验收后**一次性提醒** `team_remember` | `src/services/memory.ts`（`status='archived'` 迁移、memory 事件表） |
| 技能/进化 | 共享技能根 + 项目级技能；改动走 proposal → approve → apply + canary 再全量 | README「Memory, skills, evolution proposals」 |
| 用量/成本 | 按 model / bot / project 拆分，CSV 导出；**额度闸门**：主 provider 耗尽期不领取运行，留 queued | README「Usage and cost」；`scheduler.ts` `INTERNAL_FALLBACK_KINDS` 闸门段 |
| 群聊 | 三种回应模式（Director first / Everyone / Mentioned only）；消息尾窗分级注入（被 @ 的保留全文，其余压成摘要） | README「Group chats and dispatch」 |
| 持久化 | SQLite `team.sqlite` + `memory/` + `messages/` + `secret.key`（密文与密钥需一起备份） | README「Configuration」 |

### 依赖的 DSH host API

以 `dsh` CLI + Web 进程为载体，自带 HTTP API 与 SSE，`src/tools.ts` 向 bot 注册 17 把 `team_*` 工具；渠道侧 vendor 了微信 iLink SDK、`@larksuiteoapi/node-sdk`。**它不走 `ctx.subagents`，而是自己的 run/session 层**（`src/services/runtime/session.ts`、`src/services/runs.ts`）。

### 成熟度

- **本组里工程质量最高的一个**：TypeScript、491 文件、`tests/` 下有成规模套件（`review-auto.test.ts` 48 KB、`approval-auto-allow.test.ts` 42 KB、`session-rollover.test.ts` 34 KB 等），还有 `load-test` / `fault-test` / `backup` / `restore-check` 脚本。
- 版本 `0.3.70`（70 个 patch），当天仍在提交，issue 数为 0（作者自消化），说明高强度单人/小团队维护。
- Apache-2.0 + NOTICE，商业友好。
- 但**体量与产品面远超一个「团队协作插件」**（SQLite、微信、飞书、终端、密文保险箱），我们只应借鉴其中一两个机制。

### 对本项目的可借鉴点

1. **派单时的写范围准入闸**（最有价值，见 §5 对照）。
2. **`expected_version` 改写围栏**：本仓库用 `attempt` + `attemptId`（`src/types.ts:179-200`）拦「迟到写入」，但**拦不住「队长基于陈旧卡片做决定」**这一类（读-改-写竞态）。
3. **只读交付跳过核验**：本仓库 `docs/quality-gates.md` 的质量链是固定五段；对「只读调研型实现」目前没有机械豁免通道。
4. **不借鉴**：群聊 / 微信渠道 / 审批卡 / 密文 secret / 每项目终端 / SQLite 迁移栈。

---

## 5. DandanLLab/dsh-plugin-team-group —— 角色卡 + 导演发言规划器

- **地址**：https://github.com/DandanLLab/dsh-plugin-team-group
- **元数据**：2 stars / 3 forks / MIT；`created_at` 2026-11-10，`pushed_at` 2026-11-10T09:05:31Z（**只有一次提交**）
- **验证程度**：部分源码（`lib/index.js` 1034 行，读了导演规划、成员 followup、会话创建段；`ui/index.html` 16 KB；`git/trees`；README）

### 痛点

多角色「群聊」需要一个东西决定**谁在什么时候说话**，否则要么全员抢话、要么没人接。

### 核心机制

| 维度 | 实现 | 证据 |
|---|---|---|
| 导演规划器 | 独立 director agent 会话，只允许调用 `team_group_plan_submit` 提交 JSON `{ rounds: [[{id, speak, focus}]] }`，最多 `maxRounds`（默认 3） | `lib/index.js:158`（导演 system 文案）、`:309-344`（plan tool）、`:738-770`（规划流程） |
| 执行 | 逐轮逐成员 `followup(带房间上下文)`，成员调 `team_group_speak` 落账 | `lib/index.js:677-699` |
| 失败降级 | 导演超时（90s）→ 全员单轮 `[{speak:true, focus:'回应用户'}]` | `lib/index.js:765-770` |
| 会话 | 每角色一个持久 agent 会话（`agents.create` / `resume` + `followup`）；**渠道会话本身即成员**，resume 复用不另铸 session | `lib/index.js:196`、`:524-546`、`:622` |
| 拉人审批 | `team_group_invite` 写入待审批队列 + 通知管理员会话，`team_group_approve` 后才生效；UI 顶部审批条 | README「拉人审批流」 |
| 工具 | 7 把 `team_group_*`，全会话可见 | README |
| 传输 | SSE `/api/rooms/:id/events` 实时推流 | README「HTTP API」 |
| 持久化 | `~/.dsh/team-group/{cards,rooms}.json` | README「配置」 |

### 依赖的 DSH host API

`ctx.agents.create/resume`、`agent.followup`、`ctx.tools.register`、`ctx.webServer`（iframe 面板 + SSE）、`agentPresets.list()`。构建产物直接是 `lib/index.js`（无 bundler）。

### 成熟度

- **一次提交、无测试、无版本历史**，`ui/index.html` 16 KB 手写。属原型级。
- 架构思路自述对标 [Operit](https://github.com/AAswordman/Operit) 的 group-execution，但只是「思路对标」。
- 结论：**设计可看，代码不可依赖。**

### 对本项目的可借鉴点

1. **「规划器返回结构化 JSON 而不是自然语言」的契约化思路**：本仓库的 staged plan 已经是结构化 DAG（`src/types.ts:646-655`、`agent_teams_edit_plan`），这点我们更强，不需要借鉴。
2. **入队审批流**：成员变更要人批准才生效。本仓库只在 staged 阶段卡人（`docs/usage.md:51`），**运行中 `add_member` 无需二次确认**。
3. **不借鉴**：导演规划器本身（见 §7）。

---

## 6. zhu1090093659/dsh-web（npm `@linxin666/dsh-web-all`）—— 生态级全家桶

- **地址**：https://github.com/zhu1090093659/dsh-web （默认分支 `dev`）
- **npm**：`@linxin666/dsh-web-all@0.4.19`（同日 22 个子包同版本号发版）
- **元数据**：**10451 stars / 632 forks** / Apache-2.0；`pushed_at` 2026-11-16T11:13:12Z；仓库 `size` ≈ 1.5 GB
- **验证程度**：**仅文档级（未读源码）**。API 限额在抓取 tree 时耗尽，改从 `registry.npmjs.org` 读取子包 README：`@linxin666/dsh-agents`（19.5 KB）、`@linxin666/dsh-client-ui-task-board`（51.7 KB）、`@linxin666/dsh-usage`（10 KB）、`@linxin666/dsh-remote-bridge`（65.5 KB）。下述机制均来自**作者自述文档**，未经源码复核。

### 痛点

不是「团队协作」，而是「把 DSH Web GUI 变成工作台」：长程任务、后台调度、手机接入、用量成本、皮肤。

### 与团队协作相关的三个子包

| 子包 | 机制（作者自述） | 对本项目的相关性 |
|---|---|---|
| `dsh-agents`（Squads） | 成员是可复用定义（`preset` / `permission` / `model` / `reasoningEffort` / **`brief`**）；`brief` 通过 **`dsh-agents:member-brief` system-prompt section 在 assemble 时解析**，编辑后下一轮即生效；整队运行把名册与目标作为 `team:squad` **context**（order 125）送达 Lead；**骑在原生 Agent Teams 运行时上**，自己不做协作；10 把 `squads_*` 工具 | 高 |
| `dsh-client-ui-task-board` | Host 权威账本 `$DSH_HOME/task-board/ledger-v2.json`（schema v7，临时文件 + 原子 rename）；五列看板；**父卡自治派发**：跑父卡只开一个会话，会话用 `subagent` 按依赖序派子卡、用 `task_board_manage` 写回结论，未写回的由 Host 幂等回填；`maxSubtaskDepth` 1（默认）→3；5 字段 cron + IANA 时区 + `maxRuns`；**权限确认门**：卡片钉住的权限高于 `sessionDefaultPermission` 就必须人确认，改钉即重新上锁；`spendBudgetTokens` 日 token 上限；8 把 `task_board_*` 工具 | 中 |
| `dsh-usage` | 折叠 `session/event`（`request/header` 路由归属 + `assistant/message` usage）写 `$DSH_HOME/dsh-usage/usage-ledger.json`；按 provider/model/日 分桶；余额、套餐窗口、峰谷计价 | 中 |

### 依赖的 DSH host API（自述）

`SystemPrompt.section`（order 200/220）、`agentTeams.setEnabled(agent, true)`、`agent/created` 事件、`ctx.subagents` 原生派发、`session/event`、`ctx.webServer` 精确 upgrade 路由（`/ios/v1`）、`ctx.connection` 审批瀑布。

### 成熟度

- **star 数与发版纪律（22 包同版本、`0.4.19`、当日提交）说明工程化程度高**，README 里满是 fail-closed、原子写、幂等回填、限额这些硬约束描述。
- 但：① 我只读了文档；② 它是**生态聚合**而非同类团队插件，`dsh-agents` 自己也声明「协作由部署方的 Agent Teams 运行时拥有，本包不挂载任何协作能力」；③ 1.5 GB 仓库、22 个子包，任何借鉴都是**重量级耦合**。
- 结论：**文档级验证；机制值得读，代码不要碰。**

### 对本项目的可借鉴点

1. **`brief` 作为 assemble 时解析的 section**（而非派工时快照的字符串）：本仓库 `executionPrompt` 在 `agent_teams_add_member` 时冻结进 `team.json`（`docs/usage.md:93`），改人设必须换成员。改成 section 解析可让「编辑 → 下一轮生效」，但会削弱审计确定性（见 §5 冲突）。
2. **父卡自治派发**：把子任务树交给「父卡那一个会话」用 `subagent` 自行派发，Host 只做幂等回填。与我们的 captain 中心调度是**两种正交模型**。
3. **权限确认门（fail-closed pin）**：本仓库不管理成员权限预设（`grep permissionPreset src/*.ts` 无命中），这块是空白。
4. **`spendBudgetTokens` 日预算闸门 + usage ledger**：本仓库**完全没有 token/cost 计量**（`grep -n "token" src/*.ts` 只命中 `max-tokens` 截断原因与命令解析变量）。
5. **不借鉴**：22 包生态、手机 App 协议、SSH、皮肤、Token 银行。

---

## 7. 与本仓库的逐项对照

对照基线取自：`README.md:43-52`、`docs/usage.md:9-45`、`docs/quality-gates.md:24-47`、`docs/optimization-directions-2026-11-02.md:143-150`、`src/tool-names.ts`、`src/types.ts`、`src/scheduler.ts`、`src/index.ts:100-140`。

### 7.1 已有（给 file 级证据）

| 能力 | 本仓库现状 | 证据 |
|---|---|---|
| Captain 中心调度 + 依赖 DAG | 有；`pending→claimed→in_progress→completed\|failed\|cancelled`，依赖只认上游 completed | `src/scheduler.ts`；`docs/usage.md:43` |
| staged 计划 + 人工批准 | 有；`phase: 'staged'`，批准前不建成员不派工 | `src/types.ts:646-655`；`docs/usage.md:51` |
| 质量门禁五段合同 | 有；`requirements→implementation→verification→review→integration`，含自动 repair/re-review | `src/quality-gates.ts`（2114 行）；`docs/quality-gates.md` |
| **创建期**范围重叠拒绝 | 有；仅对 `WRITE_KINDS = ['implementation','repair']` 且 `inScope` 非空时，与**开放态**任务比对 `inScopeOverlap` | `src/quality-gates.ts:38-39, 348-368, 456-470` |
| 完成期范围审计 | 有；对照调用方 `changedPaths` 审计（不是 host 写入拦截） | `docs/usage.md:45`；`src/tools.ts:2737` |
| 成员工具策略 | 有；部署方声明 `toolPolicies`，队长只能选 id，不能提交 allow/deny 原始表 | `src/tool-policies.ts:1-40`；`src/profiles.ts:201-231` |
| 成员技能选择 | 有；owner 声明 `skills` 目录，成员按 id 选（≤8），未知 id 持久化前失败 | `src/profiles.ts:21, 201-231`；`src/tools.ts:2059-2062` |
| worktree lane | 有（opt-in）；`createWorktreeLane` 在建成员前建 lane | `src/worktrees.ts:52`；`src/members.ts:1287-1292`；`src/tools.ts:1772` |
| agent preset 库 | 有；`presets.json`，variant 不可变，`revision` 校验 | `src/agent-library.ts`；`src/types.ts:566-581` |
| 成员并发上限 | 有；`maxMembers` / `maxConcurrentWorkers` | `src/index.ts:100-102, 225-226`；`src/scheduler.ts:88, 122-125` |
| attempt 代际围栏 | 有；`attempt` + `attemptId`，转派先废旧代际 | `src/types.ts:179-200` |
| mailbox 有界归档 | 有；ack 后写入 `inbox/archive/<agent>.jsonl` | `src/state.ts:593-620` |
| 快照 ETag / payload 裁剪 | 有；强 ETag + `If-None-Match`；timeline 上限 50 | `docs/optimization-directions-2026-11-02.md:11-16`；`src/snapshot.ts:26` |
| 工具面预算 | 有；full 19 工具 / 20,003 B，core 11 / 15,945 B（20.3% 更小） | `docs/tool-surface-budget.json`；`src/tool-names.ts`；`docs/optimization-directions-2026-11-02.md:16` |
| 会话谱系身份 | 有；fork 沿 `parentSession` 解析队长身份 | `src/lineage.ts:1-20` |

### 7.2 缺口（逐条给落点与成本）

> 成本口径：**S** ≈ 1 个模块 + 既有测试模式，半天到 1 天；**M** ≈ 跨 2–3 个模块 + 新测试面，2–4 天；**L** ≈ 改调度/会话模型，1–2 周且需重跑运行时矩阵。

**G1 · 派单期写范围准入闸（来源：dsh-team-bots）**
- 现状：范围检查只在 `create_task` 时做，且只覆盖 `implementation`/`repair`；`kind=work` 的任务可以并行写同一批文件。`agent_teams_reassign_task` 派单路径（`src/scheduler.ts:1595-1626`）不查 `inScope`。
- 落点：`src/quality-gates.ts` 增 `admissionScopeConflict(team, task)` 纯函数；`src/scheduler.ts` 在领取前比对**在跑**任务的 `inScope`；`src/types.ts` 复用现成 `inScope`，不新增字段；对 `package.json` 类机械改动加豁免名单（team-bots 的 `DSHBOTS-133` 教训）。
- 成本：**M**
- 冲突风险：**中低**。worktree lane 开启时成员各自独立工作树，闸门恒放行即可；未开 lane 时才是真收益。需注意别把「串行化」误伤成「死锁」——必须只在两个任务都声明了范围时判定（team-bots 的保守串行口径）。

**G2 · 任务改写乐观锁 `expected_version`（来源：dsh-team-bots）**
- 现状：`attempt`/`attemptId` 拦的是「旧执行代际写结果」，拦不住「队长读到旧卡片后改写合同」。
- 落点：`src/tools.ts` `agent_teams_amend_task` / `reassign_task` 增可选 `expected_revision`；`src/types.ts` `TeamTask` 已有 `revision` 语义可复用。
- 成本：**S**
- 冲突风险：**低**。纯参数级增量，不改变现有调用方。

**G3 · 消息幂等键 + 反乒乓护栏（来源：limuyang2 + dsh-cross-session）**
- 现状：`TeamMessage`（`src/types.ts:498-530`）有 delivery/read 时间戳，**无 `idempotencyKey`**；`agent_teams_send_message` 无频率/链路上限。
- 落点：`src/types.ts` 加 `idempotencyKey`；`src/mailbox.ts` 写入前去重；`src/tools.ts` `send_message` 加每对成员交替计数（超限拒绝并提示）。
- 成本：**S**
- 冲突风险：**低**。但不加会有一个真实隐患：两个成员互相「收到请回复」时，mailbox 会按 tick 增长。

**G4 · 专家/preset 包导入导出（来源：experts-management）**
- 现状：`src/agent-library.ts` 只有私有 `presets.json`，无法接入存量角色内容。
- 落点：新增 `src/agent-library-import.ts`，识别 `plugin.json + agents/*.md + skills/ + avatars/`，映射到 `AgentPresetV1`（`role`←frontmatter、`executionPrompt`←正文、`skillIds`←skills 清单）。
- 成本：**S/M**（纯适配，无网络依赖）
- 冲突风险：**低**。不触碰调度。注意 `skillIds` 需映射到本仓库 `config.skills` 的 owner 声明 id，不能直接放行未知技能。

**G5 · 角色召唤手势 `/preset-名称`（来源：experts-management）**
- 现状：只有 `/agent-teams --profile X` 整队模板（`src/command.ts:87-119`）。
- 落点：`ctx.skills.registerProvider` 注册 `modelInvocable:false / userInvocable:true` 的候选；**需先验证宿主 0.2.2-rc.3 是否支持该 invocation 组合**（本仓库未使用过该字段，属新增 host 依赖）。
- 成本：**S**（若宿主支持） / **未验证**（若不支持则需换 `ctx.commands` 方案）
- 冲突风险：**低**。零模型 token，符合 token-neutral gate。但**必须先做宿主能力探测**，不能假设。

**G6 · 只读交付跳过核验（来源：dsh-team-bots）**
- 现状：质量链固定，无机械豁免通道（`docs/quality-gates.md` 五段）。
- 落点：`src/quality-gates.ts` 在 `evaluateQualityCompletion` 前判断该 attempt 的有效沙箱是否 read-only，若是则写 `verificationSkipped: 'read-only'` 标记。
- 成本：**S**
- 冲突风险：**中**。这是「放宽门禁」，必须有不可伪造的判定依据（host 的 effective sandbox），否则就是给绕过开门。

**G7 · brief 改为 assemble 时解析（来源：dsh-web/dsh-agents）**
- 现状：`executionPrompt` 在 `add_member` 时冻结（`docs/usage.md:93`）。
- 落点：`src/capabilities.ts` 加一个 section，assemble 时从 `team.json` 读当前 `executionPrompt`。
- 成本：**S**
- 冲突风险：**中高**。会打破「成员人设与合同在批准后冻结」的审计前提；`contractSnapshot` 与 `attempt` 代际的确定性下降。**建议只对 `kind=work` 生效，质量链任务保持冻结。**

**G8 · 成员权限预设（来源：dsh-web/task-board 的 pin + limuyang2 的 `permissionPresetId`）**
- 现状：本仓库不管理成员权限（无 `permissionPreset` 任何引用）。
- 落点：`src/types.ts` `TeamMember` 加 `permissionPresetId`，建成成员后 `ctx.permissionPresets.set(session, preset)`（limuyang2 同款调用）。
- 成本：**M**
- 冲突风险：**中**。需先确认该 API 在 0.2.2-rc.3 的行为；且「成员降权」会改变现有成员能力预期，属产品决策。

**G9 · token / 成本计量（来源：dsh-usage + dsh-team-bots）**
- 现状：**完全没有**。
- 落点：折叠 `session/event` 的 usage 事件到 `stateRoot/usage.jsonl`；面板加一列。
- 成本：**L**（新增持久化 + 事件折叠 + 面板列 + 与 token-neutral gate 的一致性论证）
- 冲突风险：**中**。不增加 prompt token，但引入新的宿主事件依赖；且 `docs/optimization-directions-2026-11-02.md:147` 要求「任何优化新增 footprint 必须为零」，需明确它是纯旁路观测。

### 7.3 明确不借鉴

| 来源 | 不借鉴的能力 | 理由 |
|---|---|---|
| limuyang2/agent-team | **成员 = 独立 root agent**（`ctx.agents.create` + `attachSession`） | 与本仓库架构根本冲突：① 成员是 `startContinuable` durable 子代理，`attempt`/`attemptId` 围栏、`lineage.ts` 的父链身份、`worktree lane` 都建立在「子代理」前提上；② 改成 root 会话要重写 `members.ts`（1507 行）+ `scheduler.ts`（1820 行）并重跑全部运行时矩阵；③ 该仓库自身 3 个月未更新且 host 锁在 `0.1.1-rc.2`。**代价 L、收益不抵** |
| cao123-2024/dsh-cross-session | root 会话间 `steer` 喊话、标题前缀当角色、`ask_master` | ① 0 star、无测试、11-08 才建仓；② 「一个队长一个团队」是本仓库刻意约束（`docs/usage.md:154`），跨 root 会话互喊会直接打穿这条约束；③ 标题前缀作角色是 UI 约定，不是持久身份，与本仓库 `lineage.ts` 的持久谱系相反 |
| DandanLLab/dsh-plugin-team-group | 导演规划器（独立 director 会话 + JSON rounds） | ① 与 captain 规划**功能重复**，两个规划器会互相覆盖；② 每轮一次模型调用，直接违反 `docs/optimization-directions-2026-11-02.md:143-150` 的 token-neutral gate；③ 该仓库只有一次提交、无测试 |
| 8kugames/dsh-team-bots | 群聊三模式、微信/飞书渠道、审批卡、密文 secret 保险箱、每项目终端、SQLite 迁移栈 | 产品面完全不同（它是「团队工作区 OS」，我们是「单会话内的团队协议」）；单是 SQLite + 渠道 vendor（43 KB 微信 SDK + Lark SDK）就会把插件从 2.2 MB 抬到不可接受；且这些能力与 quality gates / tool policy 无交集 |
| zhu1090093659/dsh-web | 22 包生态聚合、手机 App 协议 v1、SSH/SFTP、皮肤、Token 银行、GitHub Issues 同步、Team Hub 租约 | ① 不是团队协作能力，是 GUI 工作台；② 1.5 GB 仓库、22 包同版本发版，任何借鉴都是重量级耦合；③ 本次仅文档级验证，源码未读，不足以支撑立项 |
| experts-management | 稀疏检出 + 每日 fetch/reset + 一键分享 PR | 需要 git 网络与托管 token（本机到 github.com 的 git 连接本就不通）；运维面 >> 收益。只取其**格式**与**手势** |

---

## 8. 汇总表

| 能力 | 来源 | 价值 | 成本 | 冲突风险 | 优先级 |
|---|---|---|---|---|---|
| 派单期写范围准入闸（声明写路径，重叠则串行） | dsh-team-bots | 高：把「创建时不冲突」升级为「运行时真并行」 | M | 中低（与 worktree lane 需互斥判定） | **P0** |
| 任务改写 `expected_version` 乐观锁 | dsh-team-bots | 中高：堵读-改-写竞态 | S | 低 | **P0** |
| 消息 `idempotencyKey` + 反乒乓链路上限 | limuyang2 + cross-session | 中：防重投与互相刷屏 | S | 低 | **P0** |
| 专家/preset 目录格式导入导出 | experts-management | 中高：直接接入存量角色内容 | S/M | 低 | **P1** |
| 角色召唤手势 `/preset-名称`（零 token） | experts-management | 中：零模型 token 的角色复用 | S（**宿主支持性未验证**） | 低 | **P1** |
| 只读交付跳过核验（带不可伪造标记） | dsh-team-bots | 中：减少无意义复审轮次 | S | 中（放宽门禁） | P1 |
| brief 改为 assemble 时解析 | dsh-web / dsh-agents | 中：人设热更新 | S | 中高（破坏冻结前提） | P2 |
| 成员权限预设（`permissionPresetId`） | dsh-web + limuyang2 | 中：最小权限 | M | 中（产品决策 + host API 待验） | P2 |
| 长操作日志（stage + cursor 可续跑） | limuyang2 | 中低：中断恢复可观测 | M | 中（与即时状态机并存） | P2 |
| token / 成本计量 + 日预算闸门 | dsh-usage + dsh-team-bots | 中：成本可见 | L | 中（新宿主事件依赖） | P3 |
| 父卡自治派发（子任务树交给父卡会话） | dsh-web / task-board | 低（对我方） | L | **高**（与 captain 调度重复） | 不做 |
| 群聊式发言调度（Director rounds） | team-group | 低 | M | **高**（重复规划 + 破 token 门） | 不做 |
| 成员改独立 root 会话 | limuyang2 | 低 | L | **极高**（推翻 attempt/lineage/lane） | 不做 |
| root 会话间互喊 + 标题前缀角色 | cross-session | 低 | M | **高**（打穿一队长一团队） | 不做 |

---

## 9. 结论：最值得借鉴的三个能力

1. **派单期写范围准入闸**（dsh-team-bots）——唯一一个能同时提升「并行度」和「正确性」的机制，且本仓库已有 `inScope` / `inScopeOverlap` / `WRITE_KINDS` 三块现成积木，属于低成本高确定性。它填的正是 `docs/quality-gates.md` 里「完成时审计」到「派单时准入」的那段空白。
2. **`expected_version` + `idempotencyKey` 两个小围栏**（dsh-team-bots + limuyang2）——各约一次参数级改动，但补的是本仓库 `attempt` 代际模型**管不到的两类竞态**：陈旧读改写、重复投递。S 成本、低风险、可立即并入 `pnpm verify`。
3. **专家目录格式导入 + 零 token 角色召唤**（experts-management）——本仓库的 `agent-library.ts` 是空的内容池，而 `plugin.json + agents/*.md + skills/` 已是事实标准格式，导入即得内容；`modelInvocable:false` 的手势不增加任何模型 token，天然通过 token-neutral gate。**唯一前置动作是先验证宿主 0.2.2-rc.3 对 `userInvocable` 的支持，未验证前不得立项。**

---

## 附：可复现的抓取命令

```bash
# 元数据
curl -sS https://api.github.com/repos/<owner>/<repo>

# 源码（raw 直连不通时改用 contents API）
curl -sS https://api.github.com/repos/<owner>/<repo>/contents/<path> \
  | python3 -c "import json,sys,base64;print(base64.b64decode(json.load(sys.stdin)['content']).decode())"

# 文档级兜底
curl -sS https://registry.npmjs.org/@linxin666%2Fdsh-agents \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['readme'])"
```
