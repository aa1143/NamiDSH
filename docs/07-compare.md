# 和真 Cordis 逐行对照：迷你版省了什么

> 前六篇一直在说「迷你版和真 Cordis 行为一致」。这一篇把证据摆出来：怎么验证的，哪里一样，哪里不一样，省掉的两千行在做什么，以及读完这个系列之后，怎么去读 DeepSeek Harness 的真实源码。

## 01 文件对照

迷你版的文件结构和 DSH 仓库里的 `vendor/cordis/src` 一一对应：

| 文件 | 真 Cordis | 迷你版 | 内容 |
|---|---|---|---|
| fiber.ts | 754 | 329 | 插件实例：六种状态、异步加载、卸载回收、错误隔离、epoch |
| reflect.ts | 418 | 122 | `ctx.llm` 代理、provide、同名冲突、依赖通知 |
| events.ts | 352 | 107 | emit、parallel、serial、bail、waterfall |
| registry.ts | 337 | 129 | ctx.plugin、ctx.inject、三种插件写法 |
| utils.ts | 287 | 60 | 工具函数 |
| logger.ts | 270 | 27 | 日志 |
| context.ts | 146 | 89 | Context 本体、子 ctx |
| service.ts | 115 | 27 | Service 基类 |
| **合计** | **2693** | **约 900** | |

迷你版的行数含注释，去掉注释和空行是 679 行。真 Cordis 的行数也含注释（它的注释写得很详细）。

## 02 怎么验证「行为一致」

光说一致没有说服力。我写了一份兼容性测试 `tests/compat.ts`，覆盖 14 个场景：

1. 插件是异步加载的
2. 依赖等待：先挂消费者，后挂提供者
3. 拔掉提供者：消费者先清理，提供者后下线
4. 同名服务冲突
5. 更新配置：提供者重启，消费者跟着重启
6. 错误隔离
7. 配置校验失败
8. Service 类：static inject + Config + 异步 init
9. 五种事件触发方式
10. 卸载插件，监听自动取消
11. 嵌套插件级联卸载
12. 没 inject 的服务读不到
13. ctx.inject 可选依赖
14. 异步 effect

关键在于：**测试代码不 import 任何一边，而是在运行时决定加载哪个实现**：

```ts
// tests/compat.ts
const lib = await import(process.env.CORDIS || '../packages/cordis/src/index.ts')
const { Context, Service } = lib
```

不设环境变量，跑的是迷你版；把 `CORDIS` 指向 DSH 仓库里编译好的真 Cordis，跑的就是真 Cordis。每个场景都用 `internal/status` 事件记录下每个插件的每一次状态变化，最后输出成文本：

```bash
node tests/compat.ts > mini.txt
CORDIS=/path/to/deepseek-harness/vendor/cordis/lib/index.js node tests/compat.ts > real.txt
diff mini.txt real.txt
```

结果是 114 行输出逐行一致。注意比的不只是最终结果，还有**状态变化的先后顺序**，比如第 3 个场景里「消费者先进入 UNLOADING、清理完退回 PENDING，提供者才变成 DISPOSED」，两边一步不差。

这个过程也帮迷你版改掉了一个差异。最初的迷你版允许插件的 `apply` 返回任意值，而真 Cordis 规定只能返回清理函数或者什么都不返回，返回别的值会被当成写错了，插件直接进入 FAILED。对照测试一跑就发现了，我把迷你版改成了和真 Cordis 一样严格。

## 03 一处有意保留的差异

只有一个地方，两边行为不同。

`ctx.plugin()` 的返回值可以 await。真 Cordis 的实现是用 `Object.create(fiber)` 造一个包装对象，再给它加一个 `then` 方法。如果在这个包装对象上调用 `update(config)` 改配置，方法里的 `this` 是包装对象，状态会被写到包装对象上，而不是真正的 Fiber 上。依赖它的插件在检查时读的是真正 Fiber 的旧状态，于是重启顺序会和预期不一样。

迷你版用 Proxy 做包装，把所有方法都绑定回真正的 Fiber，所以没有这个问题。测试里改成通过 `ctx.fiber.update()` 改配置，绕开这个差异，两边就一致了。

## 04 省掉的两千行在做什么

迷你版没有实现的功能，以及它们在 DSH 里用得多不多（统计范围是 DSH 仓库里 import 了 Cordis 的 519 个文件）：

| 功能 | 真 Cordis 里做什么 | DSH 里的用量 |
|---|---|---|
| `isolate` / `intercept` | 让某个子树拥有独立的同名服务；给某个服务注入额外配置 | 0 / 0 |
| `once` | 只触发一次的监听 | 0 |
| `ctx.set` | 修改已提供的服务的值 | 0 |
| `@Inject` 装饰器 | 用装饰器语法声明依赖 | 0 |
| `mixin` / `accessor` | 把服务的方法挂到 ctx 上 | 1 / 1 |
| 生成器形式的 effect | 一个 effect 里 yield 多个撤销函数 | 框架内部 |
| 调用栈追踪 | 插件出错时，报错信息里带上「是在哪里挂载的」 | 框架内部 |
| 可调用服务、可追踪对象 | 让 `service.ctx` 指向调用方的 ctx | 框架内部 |
| 完整的 logger 服务 | 分级、分模块、可导出的日志 | 广泛使用，迷你版只做了薄门面 |

可以看到，DSH 业务代码里几乎用不到的功能，迷你版都没做；DSH 里用得多的，迷你版全都保留了：

| 功能 | DSH 里的用量 | 迷你版 |
|---|---|---|
| `inject` | 395 | 有 |
| `Config` 配置校验 | 187 | 有 |
| `ctx.on` | 183 | 有 |
| `ctx.get` | 178 | 有 |
| `ctx.effect` | 130 | 有 |
| `extends Service` | 62 | 有 |
| `FiberState` | 59 | 有，数值一致 |
| `internal/*` 事件 | 58 | 有 4 个 |
| `ctx.plugin` | 47 | 有 |
| `ctx.inject` | 39 | 有 |
| `ctx.emit` | 24 | 有 |
| `ctx.provide` | 16 | 有 |
| `waterfall` | 13 | 有 |
| `fiber.update` | 10 | 有 |

剩下的两千行，大部分花在三件事上：

- **更强的 effect**：支持生成器、异步迭代器，支持在 effect 执行到一半时被取消，并且保证取消和完成之间不会出现竞态。真 Cordis 的 `effect` 方法一个就有一百多行。
- **更好的报错**：插件出错时能告诉你它是在哪一行被挂载的，这对一个由几百个插件组成的系统非常重要。
- **作用域隔离**：`isolate` 和 `intercept`，以及支撑它们的「可追踪对象」机制。

这些都是工程上必须的，但不影响理解核心原理。

## 05 接下来怎么读 DSH 源码

读完这个系列，再打开 DSH 仓库，建议按这个顺序：

1. **`vendor/cordis/src/fiber.ts`**：先找 `_reload`、`_unload`、`_refresh`、`_setEpoch` 四个方法，它们和迷你版几乎一样。看懂后再去读完整的 `effect`。
2. **`vendor/cordis/src/reflect.ts`**：找 `handler.get`、`provide`、`notify`，和第 4 篇对照着看。会多出 `isolate` 相关的逻辑，先跳过。
3. **`packages/examples/agent-spine-demo`**：这是 DSH 的「装机清单」。它的 README 列出了套件里挂了哪二十多个插件，每个插件是干什么的。
4. **`packages/core/agent-loop`**：真正的 Agent 循环。有了前面的基础，开头的 `static inject` 和 `ctx.effect` 都不陌生了，可以把注意力放在循环本身的逻辑上：收件箱、中断、并行工具调用。
5. **`packages/core/tools`**：工具执行管线。迷你版只有三道瀑布，真实版本还有调度、超时、结果呈现等环节。

更细的拆解，见[拆机 DeepSeek Harness](https://namiai.tech/teardown/deepseek-harness/) 系列：它沿着 DSH 的真实源码，一个部件一个部件往下拆。

## 结语

DeepSeek Harness 一百多万行代码，真正撑起整个系统的，是 Cordis 这两千多行，而 Cordis 的核心，又可以浓缩成五条规则：

- 一切都是插件，每个插件拿到自己的 ctx；
- 插件做的每一次注册都记在自己名下，卸载时倒序撤销；
- 插件用服务名提供和使用能力，依赖不齐就等着，到齐就启动，换人就重启；
- 插件之间用事件广播，waterfall 让任何环节都能被插手；
- 一个插件出错，只影响它自己。

这五条规则，用 680 行就能写出来，跑出来的行为和真 Cordis 一样。剩下的，都是在把这五条规则做得更稳。

代码在 [GitHub · NamiDSH](https://github.com/aa1143/NamiDSH)，可视化在[一张图看懂 DeepSeek Harness](https://namiai.tech/dsh/)。欢迎 clone 下来，把测试跑一遍，再去读 DSH 的源码。
