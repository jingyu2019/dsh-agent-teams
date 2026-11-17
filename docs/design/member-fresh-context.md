# 成员上下文刷新（`freshContext`）

## 解决什么问题

一个成员的子会话是**持久**的：任务 N 的完整对话留在任务 N+1 的上下文里。对相关任务这是资产（省掉重复勘察），对无关任务是纯成本（历史越长，每轮输入越贵，也越容易被上一件事的假设带偏）。

`freshContext` 让队长**显式**要求"这条任务在一个干净的会话里跑"，而不让宿主去猜两个任务是否相关。

## 行为

- 任务字段 `freshContext: true`（`create_task` 参数 `fresh_context`；`edit_plan` 的 `update_task` 操作同名字段）。
- 调度器在 `beginTaskAttempt` 之前处理：成员满足条件时，先把旧 child session 退休（`member.id = ''`、`generation + 1`、时间线记 `member.context_reset`），随后正常分配 activation → 新会话从空上下文开始。
- **保留**名册行、路由（provider/model/reasoning）、skills、tool policy、worktree lane。
- **不满足条件就降级**：不重置、照常派发，`logger.warn` 写原因。重置永远为"保住活着的活"让路。

拒绝原因（`freshContextEligibility`，纯函数）：

| reason | 含义 |
| --- | --- |
| `member has no session yet` | 本来就没有会话，无需重置 |
| `member is working` | 有回合在跑 |
| `member is stopping` | 正在停止 |
| `member owns another open attempt` | 还持有别的未终结 attempt |
| `member has an active activation` | 还持有 pending/started/recovering 的租约 |

## 队长判断准则（文档约定，不是代码启发式）

**该开新上下文**：无依赖边 → inScope 与本 generation 已完成任务不相交 → 上一条交付没碰这条要改的文件 → 上一条是只读/分析类。

**不该开**：有依赖边；inScope 相交；是失败任务的修复（需要失败上下文）；成员有 parked attempt。

判据都取自任务图与 `changedPaths`，都是确定性数据；"产品逻辑是否相关"由队长判断，宿主不做语义推断、不额外烧模型调用。

## 与其他手段的关系

| 手段 | 上下文 | 名册行 | 并行 lane | 适用 |
| --- | --- | --- | --- | --- |
| `freshContext` | 新 | 保留 | 不变 | 同一角色接着干无关的活 |
| `agent_teams_reset_member_context` | 新 | 保留 | 不变 | 手动，等成员 idle 时执行 |
| `agent_teams_add_member` | 新 | 新增 | 新增一条 | 真的需要第二个人并行 |

注意：**上下文隔离不是写隔离**。工作区共享，同一时刻两个成员改同一文件仍会互相踩；`freshContext` 不改变这一点，写域串行仍由 `writeScopeConflict` 负责。

## 先量化再自动化

`memberTokenUsage`（P2）已能读出每成员的 token。对比"开新上下文 / 不开"两组的每任务 token 与返工率，再决定默认策略。当前默认是**不开**，只有队长显式标注的任务才开。

## 验证

`npm run verify:fresh-context`（5 例：纯谓词四种拒绝 + 成功重置落盘 + 拒绝时状态不变）。