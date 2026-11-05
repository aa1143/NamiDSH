# NamiCordis

**对照 DeepSeek Harness 的迷你学习项目。**

DeepSeek Harness（DSH）有一百多万行代码，直接读源码很吃力。但它的骨架其实很清楚：最底下是 Cordis 插件框架，模型、工具、会话、提示词，连 Agent 循环本身，都是插在上面的插件。

这个项目把这套骨架按原样缩小了一遍：

- **迷你版 Cordis**：约 680 行 TypeScript，文件结构、API 和真 Cordis 一一对应，DSH 用到的核心功能全部保留
- **迷你版 DSH**：11 个包，名字和职责都对应 DSH 的同名包，同样是 `class Xxx extends Service` + `static inject` 的写法
- **网页端 Agent**：输入问题，流式返回回答，可以接 DeepSeek，也可以离线运行

读完这个项目，再去读 DSH 的源码，你会发现每个文件都能找到对应。

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
```

整个 Agent 就是一棵插件树，入口只有几行（`apps/web/src/main.ts`）：

```ts
const app = new Context()
app.plugin(spine, { workspace })                  // 核心套件
app.plugin(apiKey ? deepseek : mock, { apiKey })  // 模型适配器，随时可换
app.plugin(webserver, { port, staticDir })        // 入口
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

- 网站：[namiai.tech](https://namiai.tech)
- [NamiGPT](https://github.com/aa1143/NamiGPT)：从零手写大模型
- [NamiAgent](https://github.com/aa1143/NamiAgent)：从零手写 Agent

## License

MIT
