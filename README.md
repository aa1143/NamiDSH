<div align="center">

<img src="assets/logo.png" alt="NamiDSH logo" width="120">

# NamiDSH

**迷你版 DeepSeek Harness**<br>
一千来行 TypeScript，看懂 DSH「一切皆插件」的架构：迷你版 Cordis + 迷你版 DSH + 网页端 Agent

[![test](https://github.com/aa1143/NamiDSH/actions/workflows/test.yml/badge.svg)](https://github.com/aa1143/NamiDSH/actions/workflows/test.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.18+-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Code License](https://img.shields.io/badge/Code-MIT-green)](LICENSE)
[![拆机](https://img.shields.io/badge/%E6%8B%86%E6%9C%BA%20DeepSeek%20Harness-namiai.tech-FFD84D)](https://namiai.tech/teardown/deepseek-harness/)
[![GitHub stars](https://img.shields.io/github/stars/aa1143/NamiDSH?style=social)](https://github.com/aa1143/NamiDSH/stargazers)
[![X](https://img.shields.io/badge/@antiAIvo-000000?logo=x&logoColor=white)](https://x.com/antiAIvo)

[一张图看懂 DSH（可视化）](https://namiai.tech/dsh/) · [配套文章](#配套文章) · [快速开始](#快速开始) · [和 DSH 的对应关系](#和-dsh-的对应关系) · [作者 𝕏](https://x.com/antiAIvo)

<img src="assets/demo.gif" alt="一张图看懂 DeepSeek Harness：一次提问「现在几点？」在插件之间怎么流转。左边架构图高亮当前模块，右边同步显示对应的代码行" width="100%">

<sub>一次提问「现在几点？」在插件之间怎么流转：左边是架构图，右边是这一步对应的真实代码</sub>

</div>

DeepSeek Harness（DSH）有一百多万行代码，直接读源码很吃力。但它的骨架其实很清楚：最底下是一块叫 Cordis 的插件「主板」，模型、工具、会话、提示词，连 Agent 循环本身，都是插在上面的卡。

这个项目把这套骨架按原样缩小了一遍：

- **迷你版 Cordis**：约 680 行，文件结构、API、插件写法和真 Cordis 一一对应，DSH 用到的核心功能全部保留：依赖注入、异步加载、错误隔离、热插拔、五种事件
- **和真 Cordis 行为一致**：[14 个测试场景](tests/compat.ts)分别跑在迷你版和 DSH 里的真 Cordis 上，输出逐行一致
- **迷你版 DSH**：11 个包，名字和职责对应 DSH 的同名包，同样是 `class Xxx extends Service` + `static inject` 的写法
- **网页端 Agent**：`npm start` 打开浏览器就能对话，可以接 DeepSeek，没有 API Key 也能离线跑
- **零运行时依赖**：Node.js 22.18 起直接运行 TypeScript，不用编译，也不用装任何框架

读完这个项目，再去读 DSH 的源码，你会发现每个文件都能找到对应。

> 先学 [NamiGPT](https://github.com/aa1143/NamiGPT) 搞懂模型本身，再学 [NamiAgent](https://github.com/aa1143/NamiAgent) 搞懂模型外面那一圈，最后用 NamiDSH 看懂工业级 Agent 是怎么搭起来的。

## 配套文章

架构图上的每一块，都有一篇文章展开讲。可以在网站上读（带可视化），也可以直接读 `docs/` 里的 Markdown。

| 篇 | 文章 | 对应代码 |
|---|---|---|
| 01 | [一切皆插件：DeepSeek Harness 最核心的设计](docs/01-plugin-everything.md) · [网页版](https://namiai.tech/dsh/plugin-everything/) | 全貌 |
| 02 | [插件与 Context：插件拿到的到底是什么](docs/02-context.md) · [网页版](https://namiai.tech/dsh/context/) | `context.ts`、`registry.ts` |
| 03 | [Fiber：一个插件的一生](docs/03-fiber.md) · [网页版](https://namiai.tech/dsh/fiber/) | `fiber.ts` |
| 04 | [服务与依赖注入：ctx.llm 是怎么来的](docs/04-service.md) · [网页版](https://namiai.tech/dsh/service/) | `reflect.ts`、`service.ts` |
| 05 | [事件总线：插件之间怎么说话](docs/05-events.md) · [网页版](https://namiai.tech/dsh/events/) | `events.ts` |
| 06 | [用插件搭一个 Agent：一次提问的完整旅程](docs/06-agent.md) · [网页版](https://namiai.tech/dsh/agent/) | `packages/*` |
| 07 | [和真 Cordis 逐行对照：迷你版省了什么](docs/07-compare.md) · [网页版](https://namiai.tech/dsh/compare/) | `tests/compat.ts` |

## 一棵插件树

整个 Agent 就是挂在根 `Context` 上的一棵插件树。每个插件声明自己依赖哪些服务（`inject`），依赖没到齐就等着，到齐了自动启动；依赖消失了自动停止，换上新的再自动恢复。

<p align="center"><img src="assets/architecture.png" alt="NamiDSH 架构图：上层是对应 DSH packages/* 的插件，下层是对应 DSH Cordis 的框架" width="600"></p>

想看每一块的代码、一步一步看一次提问怎么流转，打开[可交互版本](https://namiai.tech/dsh/)。

入口只有几行（[`apps/web/src/main.ts`](apps/web/src/main.ts)）：

```ts
const app = new Context()
app.plugin(spine, { workspace })                  // 核心套件
app.plugin(apiKey ? deepseek : mock, { apiKey })  // 模型适配器，随时可换
app.plugin(webserver, { port, staticDir })        // 入口
```

## 快速开始

需要 Node.js 22.18 以上（直接运行 TypeScript，不用编译）。

```bash
npm install          # 只是把 packages/* 链接起来，不下载运行时依赖
npm start            # 打开 http://localhost:3000
```

没有设置 API Key 时，会使用离线假模型，可以问「现在几点」「项目里有哪些文件」。接 DeepSeek：

```bash
API_KEY=sk-xxx npm start
# 可选：BASE_URL（默认 https://api.deepseek.com）、MODEL（默认 deepseek-v4-flash）、PORT、WORKSPACE
```

## 和真 Cordis 行为一致

`tests/compat.ts` 里有 14 个场景：依赖等待、拔掉服务、同名冲突、配置热更新、错误隔离、配置校验、Service 类、五种事件、自动取消监听、嵌套卸载、注入检查、可选依赖、异步 effect。

同一份测试分别跑在迷你版和 DSH 仓库里的真 Cordis 上，两边输出（包括每个插件的状态变化顺序）逐行一致：

```bash
node tests/compat.ts                                                        # 迷你版
CORDIS=/path/to/deepseek-harness/vendor/cordis/lib/index.js node tests/compat.ts   # 真 Cordis
```

## 项目结构

```
packages/
  cordis/          迷你版 Cordis 框架
  llm/             抽象模型服务 ctx.llm
  llm-deepseek/    DeepSeek 适配器
  llm-mock/        离线假模型
  session/         会话日志 ctx.sessions
  tools/           工具表 + 执行管线 ctx.tools
  tool-fs/         只读文件工具 read_file / list_dir
  tool-time/       时间工具 get_time
  system-prompt/   系统提示词组装 ctx.systemPrompt
  agent-loop/      Agent 循环 ctx.agentLoop
  agent-spine/     把核心服务组装成一个套件插件
  webserver/       网页服务 + 流式聊天接口
apps/web/          网页端入口 + 聊天页面
tests/             兼容性测试 + Agent 测试
docs/              配套文章（7 篇）
```

## 和 DSH 的对应关系

### 框架：packages/cordis ↔ vendor/cordis

| 文件 | 真 Cordis | 迷你版 | 内容 |
|---|---|---|---|
| fiber.ts | 754 | 329 | 插件实例：六种状态、异步加载、卸载回收、错误隔离、epoch 重启 |
| reflect.ts | 418 | 122 | `ctx.llm` 代理、provide、同名冲突、依赖通知 |
| events.ts | 352 | 107 | emit / parallel / serial / bail / waterfall |
| registry.ts | 337 | 129 | ctx.plugin、ctx.inject、三种插件写法 |
| context.ts | 146 | 89 | Context 本体、子 ctx |
| service.ts | 115 | 27 | Service 基类 |
| logger.ts | 270 | 27 | 日志 |
| utils.ts | 287 | 60 | 工具函数 |

（行数含注释）

**省略的部分**：isolate / intercept、mixin / accessor、once、ctx.set、@Inject 装饰器、生成器形式的 effect、调用栈追踪。这些在 DSH 里基本没有用到。迷你版的 `ctx.on`、`ctx.plugin` 等方法直接写在 Context 上，真 Cordis 是用 mixin 从各个服务上挂过去的，效果相同。

### Agent：packages/* ↔ DSH packages/*

| 迷你版 | DSH | 服务名 |
|---|---|---|
| llm | llm/llm | `ctx.llm` |
| llm-deepseek | llm/llm-deepseek | 适配器 |
| llm-mock | llm/llm-replay | 适配器 |
| session | core/session | `ctx.sessions` |
| tools | core/tools | `ctx.tools` |
| tool-fs | fs/tool-fs | 工具 |
| system-prompt | core/system-prompt | `ctx.systemPrompt` |
| agent-loop | core/agent-loop | `ctx.agentLoop` |
| agent-spine | examples/agent-spine-demo | 套件 |
| webserver | host/webserver | 入口 |

DSH 的分层原则在这里同样成立：**服务定义**（llm、tools）、**服务提供者**（llm-deepseek、tool-fs）和**使用方**（agent-loop、webserver）彼此分开。换模型、加工具、加审批，都只需要挂一个插件，不改已有代码。`tests/agent.ts` 演示了这几种操作。

## 相关项目

- [NamiGPT](https://github.com/aa1143/NamiGPT)：零基础入门大模型，从零手写 GPT-2
- [NamiAgent](https://github.com/aa1143/NamiAgent)：零基础入门 AI Agent，从零手写 Agent
- [拆机 DeepSeek Harness](https://namiai.tech/teardown/deepseek-harness/)：配套图文，一个部件一个部件拆开 DSH

## License

MIT
