# dsh-research-then-build — 先调研，再建

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一道流程：**输入 `/research` 进入「先调研后建」模式**，AI 不许上来就写，得先把问题分析清楚；要造轮子之前先查现成方案；写完之后由一个独立上下文的 Agent 挑刺，过不了不许交付。

一句话：**治 AI 乱写代码、重复造轮子、不做调研、不看开源项目的毛病。** 名字就是规矩：先调研，再建。

## 它治的四个病

### 1. 上来就写，不调研

**AI 的典型表现**：你说"给这个项目加个登录"，它直接手写 session 表、base64 拼 token、自己写校验，全程没提过 Auth.js、Lucia、Clerk 这些现成方案——不是不会用，是压根没去查。

**这个插件怎么拦**：进入模式后，第一步是把问题拆开、把判断和不确定的地方写给用户看，然后才动手。一旦它打算引入依赖、或者打算自己写一个本该存在的轮子，就必须先调 `research_survey` 产出**调研台账**：候选方案、官方地址、许可证、维护状态、适配判断。

### 2. 重复造轮子（自研）

**AI 的典型表现**：明明有成熟库，它自己写一遍，还写不全——没做过期、没验签名、没限流、没并发保护，然后告诉你"已实现"。

**这个插件怎么拦**：台账的结论必须二选一——**采用某个现成方案**，或者**自研**且落在三种例外之一（现成方案与需求本质不匹配 / 许可证或合规不允许 / 集成成本可证明高于自研），并写明理由。凭空自研会在交付门禁那一步被拒。

### 3. 不看开源项目，闭门造车

**AI 的典型表现**：不问"别人怎么解决的"，直接从零写，写完还不知道行业里早有标准做法。

**这个插件怎么拦**：`research_survey` 强制检索 npm 包、官方 SDK、托管服务、可复用的开源项目与模板仓库，并**禁止凭记忆填 URL 或版本号**——每个链接必须来自本轮真实检索结果，不确定的写"未验证"。检查 Agent 还会专门核一遍"**假证据**"：台账里的包名、版本、许可证是不是编的。

### 4. 自己说没问题

**AI 的典型表现**：写完自己看一遍，"检查过了，没问题"。同一个上下文里自评等于自证——它知道自己当初为什么这么写。

**这个插件怎么拦**：`research_challenge` 派一个**全新上下文**的 Agent，拿不到实现者的推理过程，自己跑 `git status` / `git diff`、读代码，按五个维度挑刺：绕开台账 / 假证据 / 功能遗漏 / 未验证 / 过度设计。然后追问两个**分开问**的问题：还有哪些地方没被覆盖、哪些判断你有把握。

### 补一刀：改完就想跑

检查之后又偷偷改了几行，检查结论已经过期。`research_finish` 会比对工作目录指纹，**检查后改过代码就拒绝交付**；没交付就想收尾，回合会被提醒继续。

## 一次 `/research` 长什么样

```
/research 给这个项目加上用户登录
   ↓
主 Agent 先分析：拆能力点、说判断、说哪里不确定（流式可见）
   ↓
需要外部事实 → research_survey   → 调研台账（候选/许可/维护/结论/证据）
   ↓
主 Agent 自己实现（不甩给子 Agent）
   ↓
research_challenge → 独立 Agent 挑刺 + 遗漏追问 + 把握盘点
   ↓
有严重问题就修 → 再审；收敛或到上限 → research_finish 交付
```

子 Agent 是按需调用的，不是开场就跑；每一步在对话里都留一张工具卡片，进度看得见。

## 实测效果

用它审查它自己：4 轮独立检查抓出 4 个真 bug，其中 1 个是我自己写进文档的**错误结论**（"DSH 没有拦截最终答复的 seam"——其实有，就是 `agent/turn-stopping`）。

35 条单元测试覆盖门禁、指纹、解析、状态机。

## 安装

### 从 npm 装（推荐）

```bash
dsh plugin --profile <你的 profile> add dsh-research-then-build@latest --registry=https://registry.npmjs.org/
```

或者在 DSH 的 **Plugins** 面板里按包名添加 `dsh-research-then-build`。如果 npm 上还搜不到，用下面的源码方式装。

### 从源码装

```bash
git clone https://github.com/Astonmy/dsh-research-then-build
```

然后在 **Plugins → Add plugin** 里选克隆下来的目录；或用 `plugin_manager` 的 `install_bundle` 指向该目录。

装完在新会话里输入 `/research 你的任务` 验证。

## 用法

| 输入 | 作用 |
|---|---|
| `/research <任务>` | 进入「先调研后建」模式 |
| `/research-status` | 看当前到哪一步、台账有没有、检查了几轮 |
| `/research-exit` | 退出，不交付 |

## 三道门

1. **没有台账不许交付** —— 台账必须有「能力点」和「结论：」，结论要么采用现成方案，要么自研且落在三种例外之一。
2. **没有独立检查不许交付** —— 检查者必须是全新上下文、自己取证。
3. **有严重问题不许交付** —— 最后一轮仍有 severe 且轮次没用尽时退回重做。

## 兼容性与限制（老实写）

- 需要 DeepSeek Harness `0.2.2-rc.3` 这一代；它用了 `agent/turn-stopping`、`agent.ctx.tools.register` 等 seam，装到老版本会**静默失效**而不是报错。
- 会话级工具注册有自动回退：环境不支持时退到全局注册，行为不变，只是不再省 token。
- 检查者不是严格只读（只禁了 `write`/`edit`，shell 仍可能改文件），与宿主权限模型一致。
- 实现落在当前工作目录，没有 worktree 隔离。
- **两个关键机制尚未在真实回合里验证**：`turn-stopping` 收尾守卫是否真的触发、会话级工具注册是否真的让工具只在模式内可见。

## What it solves (English)

Research before you build. A research-before-build mode for DeepSeek Harness: type `/research` and the agent must analyse first, survey existing solutions before building anything itself, implement in the open, then have a fresh-context agent attack the result. Delivery is blocked without a survey ledger, without an independent review, or while severe findings remain.

It targets four common LLM coding failures: writing before researching, **reinventing the wheel instead of using existing open-source libraries**, never looking at prior art, and self-certifying its own work.

## License

MIT
