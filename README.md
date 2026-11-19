# dsh-deep-loop

DeepSeek Harness 插件：`/deep <任务>` 进入深度模式——主 Agent 先分析、自己实现、流式输出；子 Agent 只在需要时被叫去调研或检查。

- 命令：`/deep <任务>`、`/deep-status`、`/deep-exit`
- 工具：`deep_research`（采购台账）、`deep_critique`（挑刺 + 遗漏追问 + 把握盘点）、`deep_finish`（交付门禁）
- 结构：`index.js`（命令、收尾守卫、注册）· `lib/tools.js`（三个工具）· `lib/state.js`（状态与门禁）· `lib/store.js`（内存 + 重载回填）· `lib/fingerprint.js`（工作目录指纹）· `lib/agents.js`（子 Agent 启动）· `lib/prompts.js`（提示词）· `lib/report.js`（解析与渲染）· `lib/journal.js`（持久化）
- 安装：Plugins > Add plugin 选本目录，或 `plugin_manager` 的 `install_bundle`
- 测试：`node --test test/state.test.mjs test/report.test.mjs test/fingerprint.test.mjs test/store.test.mjs`

功能、门禁与限制见 [docs/DETAIL.md](docs/DETAIL.md)。
