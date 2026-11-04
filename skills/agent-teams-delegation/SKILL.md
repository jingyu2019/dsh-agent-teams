---
name: agent-teams-delegation
description: 派活与项目归属的执行规则。当非平凡任务需要分派给专员、需要维护项目归属表、或团队名额已满时先读本 skill：给出派活判据（>2 个文件 / 改代码 / 跨仓库 / 调研上游）、一项目一专员的归属维护方法、名额满时的处理顺序。
metadata:
  version: "1.0.0"
  date: "2026-10-30"
  reference: "https://github.com/NanmiCoder/dsh-agent-teams"
---

# 派活与项目归属

> 本 skill 是队长（Lead）的常驻派活规则。两条规则的优先级高于「自己动手更快」的默认习惯：非平凡任务先派专员；同一项目固定一个专员，不因新需求新开一个人。

## 1. 派活优先（Delegate first）

### 必须先派

判断「非平凡」只看下面任一条是否命中；命中就派：

- 要读超过 2 个文件：跨文件理解、审计、重构；
- 要改代码、配置或脚本；
- 要跨仓库或跨设备；
- 要调研上游实现、版本、npm、GitHub 或官方文档；
- 要多轮验证，如测试、构建、复现、打包或真机挂载。

### 可以不派

- 单文件、单命令能完成的小修或查询；
- 纯问答，读一个文件就能回答；
- 用户明确要求你亲自做或已指定执行者；
- 派活协调成本大于任务本身。

先判断是否非平凡，再查是否已有对口专员；两项都满足时，派给现有专员。

派活消息须包含仓库绝对路径、明确目标、已知事实、禁止修改范围、push/PR/发布授权边界，以及分支和提交 SHA、改动文件、验证命令与结果、未验证事项等回报格式。派出后不要重复做同一件事；Lead 必须独立复跑关键验证并审查 diff。返工时唤醒原专员，不要另开新人重做。

## 2. 一个专员负责一个项目

项目身份按注册表 id 或仓库 remote 判断，不按目录名判断。将归属表放在团队指令、工作区 `AGENTS.local.md` 或 `docs/delegation-ownership.md`，至少包含项目 id、仓库/路径、负责专员、状态。

- 新需求先查表；已有 active 负责人时唤醒该专员，不新建。
- 新项目登记一个专员，名字使用 `<项目>-<职责>` kebab-case。
- 交接只改负责人列并保留历史记录；归档或合并时标为 retired，不删除。
- 每个项目同时只能有一个 active 写入负责人。并行工作要划分互不重叠的写入范围。
- 定期核对 active 专员真实存在，retired 专员不再接新任务。

## 3. 名额满时的处理顺序

`maxMembers` 默认 8，可在 Plugins → AgentTeams 配置页或 profile `config` 中设置任意正整数；它限制成员数量，不代表并发预算。遇到成员上限：

1. 用 `agent_teams_status` 查看成员、状态和未完成任务。
2. 优先通过 `agent_teams_send_message` 唤醒已有 inactive 专员。
3. 确实需要新人时，先收尾并用 `agent_teams_remove_member` 移除 idle 且无未完成任务的成员，再添加成员。
4. 仍然满员就按项目排队，向用户说明阻塞和需要的决策；不要静默丢任务。
5. 不要用普通 `subagent` 绕过名额；它不在团队面板内，也无法由 Lead 干预。

## 4. AgentTeams 工具映射

- 派活：`agent_teams_add_member`、`agent_teams_send_message`
- 查看状态：`agent_teams_status`
- 移除成员：`agent_teams_remove_member`
- 任务：`agent_teams_create_task`、`agent_teams_reassign_task`、`agent_teams_update_task`
- 结束团队：`agent_teams_delete`
