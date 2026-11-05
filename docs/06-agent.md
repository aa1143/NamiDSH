# 用插件搭一个 Agent：一次提问的完整旅程

> 前四篇讲完了框架。这一篇把它用起来：照着 DeepSeek Harness 的包结构，用 11 个插件搭出一个能在浏览器里对话的 Agent，然后跟着一次提问「现在几点？」走一遍全程。
>
> 这一篇和[可视化页面](https://namiai.tech/dsh/)是一一对应的，建议左右对照着看。

## 01 一棵插件树

整个 Agent 的入口只有几行：

```ts
// apps/web/src/main.ts
const app = new Context()

// 1. 核心套件：llm、sessions、tools、systemPrompt、agentLoop，外加两个工具插件
app.plugin(spine, { workspace: env.WORKSPACE ?? process.cwd() })

// 2. 模型适配器：有 API Key 就接 DeepSeek，没有就用离线假模型
if (apiKey) app.plugin(deepseek, { apiKey, baseURL: env.BASE_URL, model: env.MODEL })
else app.plugin(mock)

// 3. 入口：网页服务
app.plugin(webserver, { port: Number(env.PORT ?? 3000), staticDir })
```

`spine` 是一个「套件插件」，它在自己的 `apply` 里一口气挂上核心插件：

```ts
// packages/agent-spine/src/index.ts
export function apply(ctx: Context, config: Config) {
  ctx.plugin(LlmRuntime)
  ctx.plugin(SessionStore)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SystemPrompt, { persona: config.persona })
  ctx.plugin(toolTime)
  ctx.plugin(toolFs, { root: config.workspace })
  ctx.plugin(AgentLoop, config.agent)
}
```

这完全照搬了 DSH 的做法。DSH 有一个 `agent-spine-demo` 包，它的说明里写得很清楚：套件只装「每个 Agent 都需要的东西」，**连哪家模型、用什么入口（命令行、网页、IDE 插件）故意留在外面**，由使用方决定。所以同一套核心，DSH 可以组装成命令行工具、网页应用、编辑器插件好几种产品。

迷你版的 11 个包，每一个都对应 DSH 里的一个同名包：

| 迷你版 | DSH | 提供的服务 | 依赖 |
|---|---|---|---|
| llm | llm/llm | `ctx.llm` | 无 |
| llm-deepseek | llm/llm-deepseek | 无（往 llm 注册适配器） | llm |
| llm-mock | llm/llm-replay | 无（往 llm 注册适配器） | llm |
| session | core/session | `ctx.sessions` | 无 |
| tools | core/tools | `ctx.tools` | 无 |
| tool-fs、tool-time | fs/tool-fs 等 | 无（往 tools 登记工具） | tools |
| system-prompt | core/system-prompt | `ctx.systemPrompt` | 无 |
| agent-loop | core/agent-loop | `ctx.agentLoop` | llm、tools、sessions、systemPrompt |
| agent-spine | examples/agent-spine-demo | 无（套件） | 无 |
| webserver | host/webserver | 无 | agentLoop、sessions |

## 02 定义、提供、使用：三种角色

看上面这张表，插件可以分成三种角色。DSH 的设计文档把它叫做 Service Definition / Service Provider / Consumer：

- **定义服务**：`llm`、`tools` 只定义「模型调用长什么样」「工具长什么样」，自己不连任何模型，也不包含任何工具。
- **提供实现**：`llm-deepseek`、`tool-fs` 往这些服务里注册具体的实现。
- **使用服务**：`agent-loop`、`webserver` 只认服务名，用就行。

拿模型来说，`llm` 服务的核心只有两个方法：

```ts
// packages/llm/src/index.ts
registerAdapter(provider: string, adapter: LlmAdapter) {
  this.adapters.set(provider, adapter)
  this.ctx.emit('llm/adapters-updated')
  return () => { this.adapters.delete(provider); this.ctx.emit('llm/adapters-updated') }
}

stream(options) {
  const adapter = this.adapters.get(options.provider ?? this.providers()[0])
  return this.ctx.waterfall('llm/stream', options, () => adapter.stream(options))
}
```

DeepSeek 适配器只做一件事：用 `ctx.effect` 把自己注册进去。

```ts
// packages/llm-deepseek/src/index.ts
export const inject = ['llm']
export function apply(ctx: Context, config: Config) {
  ctx.effect(() => ctx.llm.registerAdapter('deepseek', new DeepSeekAdapter(config)))
}
```

`registerAdapter` 返回撤销函数，放进 effect，适配器插件卸载时自动注销。工具插件往 `tools` 里登记工具，是一模一样的写法。

## 03 一次提问的完整旅程

现在在网页上问一句「现在几点？」。下面每一步，都可以在[可视化页面](https://namiai.tech/dsh/)里点到对应的位置。

**第 1 到 4 步：请求进来。** 浏览器把问题 POST 到 `/api/chat`。webserver 插件用 `ctx.sessions` 找到这次对话的会话（`ctx.sessions` 能读到，是因为它声明了 `inject: ['agentLoop', 'sessions']`，见第 4 篇），然后在事件总线上挂两个监听：`agent/text-delta` 和 `agent/tool-call`。

```ts
// packages/webserver/src/index.ts
const disposers = [
  ctx.on('agent/text-delta', (s, text) => { if (s === session) send('delta', { text }) }),
  ctx.on('agent/tool-call', (s, call) => { if (s === session) send('tool', { name: call.name }) }),
]
```

webserver 不知道谁会发这两个事件，它只管听。

**第 5 到 7 步：进入 Agent 循环。** `ctx.agentLoop.run()` 先把用户消息写进会话日志（会话是一条只追加的事件日志，每写一条广播一次 `session/event`），再拼装系统提示词。提示词不是写死的字符串，而是各个插件贡献的段落按顺序拼起来的。

**第 8 到 10 步：调用模型。** 循环调 `ctx.llm.stream()`，经过 `llm/stream` 瀑布，到达适配器。适配器看到「几点」，又发现工具表里有 `get_time`，于是返回一个工具调用，而不是文字。

**第 11 到 13 步：执行工具。** 循环把工具调用交给 `ctx.tools.execute()`，过三道瀑布（见第 5 篇），最后执行 tool-time 插件登记的 `get_time`，结果写回会话日志。

```ts
// packages/agent-loop/src/index.ts
for (const call of calls) {
  this.ctx.emit('agent/tool-call', session, call)
  const result = await tools.execute({ name: call.name, args, sessionId: session.id })
  session.append({ type: 'tool-result', toolCallId: call.id, name: call.name, content: result.content })
}
```

**第 14 到 16 步：回答流回浏览器。** 带着工具结果进入第二轮。这次模型给出文字，循环每收到一小段就广播一次 `agent/text-delta`。第 1 步挂好的监听收到后，转成 SSE 推给浏览器，文字就一个字一个字地出现了。最后撤销这两个监听，关闭响应。

整个过程中，webserver、agent-loop、llm、tools、tool-time 互相都没有 import 对方，全靠服务名和事件名连在一起。

## 04 热插拔：运行中换零件

插件化最直观的好处，是运行中可以随时换零件。`tests/agent.ts` 演示了四种操作：

```text
✓ 调用工具 get_time
✓ 审批插件拦截了 get_time
✓ 卸载审批插件后恢复
✓ 拔掉 tool-time 后，工具表里没有 get_time 了
✓ 拔掉 llm 服务后，agentLoop 自动停止
```

- **加审批**：挂一个监听 `tools/pre-execute` 的插件，工具调用就被拦下。卸载它，立刻恢复。
- **拔工具**：`app.registry.delete(toolTime)`，`get_time` 从工具表里消失，模型就不会再调用它。Agent 循环一行代码没改，只是少了一个能力。
- **拔模型**：把 `llm` 服务所在的插件卸掉，依赖它的 `agentLoop` 自动停止，依赖 `agentLoop` 的 `webserver` 也跟着停。再挂回来，全部自动恢复。

这些都不是专门写的「热更新」功能，而是第 3、4 篇那几条规则自然的结果：注册即入账、依赖不齐就停、依赖到齐就启动。

## 05 接上真的 DeepSeek

离线假模型只是为了演示。设置 API Key，就会改用 DeepSeek：

```bash
API_KEY=sk-xxx npm start
```

DeepSeek 适配器只有 90 来行，做两件事：把统一的消息格式翻译成 OpenAI 兼容格式；解析流式返回的 SSE。其中值得一看的是工具调用的拼接，模型返回的工具调用是分片到达的：

```ts
// packages/llm-deepseek/src/index.ts
for (const part of delta.tool_calls ?? []) {
  const call = calls[part.index] ??= { id: '', name: '', arguments: '' }
  if (part.id) call.id = part.id
  if (part.function?.name) call.name += part.function.name
  if (part.function?.arguments) call.arguments += part.function.arguments
}
```

按 `index` 把碎片拼起来，等流结束后再一起交给循环。其他模型只要提供 OpenAI 兼容接口，改 `BASE_URL` 和 `MODEL` 两个环境变量就能用。想接一家接口格式不同的模型，就照着它再写一个适配器插件。

## 小结

- 整个 Agent 是一棵插件树：一个核心套件，加一个模型适配器，加一个入口。
- 插件分三种角色：定义服务、提供实现、使用服务，DSH 的整个架构都建立在这种分工上。
- 一次提问要经过 webserver、agent-loop、session、system-prompt、llm、适配器、tools、工具插件，彼此之间只靠服务名和事件连接。
- 热插拔不是额外的功能，而是框架规则自然的结果。

最后一篇回到真实的 DSH：迷你版和真 Cordis 到底一样到什么程度，省掉的那两千行在做什么。
