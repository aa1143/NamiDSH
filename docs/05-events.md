# 事件总线：插件之间怎么说话

> 上一篇讲服务：一个插件提供能力，另一个插件声明依赖、拿来就用。但插件之间还有另一种联系：我不知道谁会关心这件事，但我把它广播出去。这就是事件。
>
> DeepSeek Harness 里，工具执行前的审批、模型请求的重试、会话的持久化，都是靠事件挂上去的。对应 NamiCordis 的 `packages/cordis/src/events.ts`。

## 01 on 和 emit

最基本的用法，一个插件监听，另一个插件触发：

```ts
// 插件 A：只管听
ctx.on('greet', (who) => console.log('收到', who))

// 插件 B：只管说，它不知道 A 的存在
ctx.emit('greet', 'nami')
```

和服务不同，事件不需要 inject。说的一方不知道谁在听，听的一方也不知道谁会说，两边只约定一个事件名。

监听也是一次注册，所以同样记在插件的账本上：

```ts
// packages/cordis/src/events.ts
on(ctx: Context, name: string, listener, options) {
  const hooks = this._hooks[name] ||= []
  return ctx.fiber.effect(() => {
    hooks[prepend ? 'unshift' : 'push']({ ctx, callback: listener, prepend })
    return () => {
      const index = hooks.findIndex(hook => hook.callback === listener)
      if (index >= 0) hooks.splice(index, 1)
    }
  }, `ctx.on(${JSON.stringify(name)})`)
}
```

插件卸载，它挂的监听自动摘掉：

```text
=== 10 卸载插件：监听自动取消
  pong
  [status] l: ACTIVE -> UNLOADING
  [status] l: UNLOADING -> DISPOSED
  卸载后 emit：无输出
```

DSH 里 `ctx.on` 出现了 183 次，是除了 inject 之外用得最多的 API。

## 02 五种触发方式

「触发一个事件」听起来只有一种做法，但 Cordis 提供了五种，区别在于**怎么处理监听者的返回值**：

| 方法 | 怎么调用监听者 | 返回什么 | DSH 里的用量 |
|---|---|---|---|
| `emit` | 同步，全部调用 | 什么都不返回 | 24 |
| `parallel` | 异步，一起跑 | 等全部完成，有失败就一起抛出 | 1 |
| `serial` | 异步，一个一个 await | 第一个非空返回值 | 0 |
| `bail` | 同步，一个一个调用 | 第一个非空返回值 | 3 |
| `waterfall` | 洋葱式，每层拿到 `next` | 最终结果 | 13 |

五种方式的实现都很短，核心是同一个 `dispatch`：取出这个事件的所有监听函数。

```ts
// packages/cordis/src/events.ts
bail(...args: any[]) {
  for (const cb of this.dispatch('bail', args)) {
    const result = cb(...args)
    if (isBailed(result)) return result   // 有人「接手」了，就停
  }
}
```

`bail` 适合「找一个能处理的人」：比如有好几个插件都能解析某种文件，谁先认领就用谁的。

用三个监听者试一下（第一个返回 undefined，第二个返回 `'second'`，第三个返回 `'third'`）：

```text
=== 09 事件：emit / serial / bail / parallel / waterfall
  emit 收到 nami
  bail = second
  serial = second
  parallel 完成
  waterfall rm = blocked
  waterfall ls = RAN LS
```

`bail` 和 `serial` 都停在了第一个非空的返回值 `second`，第三个监听者根本没被调用。

## 03 waterfall：留给别人插手的口子

五种方式里，`waterfall` 最值得细看。它是 DSH 能做到「不改核心代码就能改行为」的关键。

```ts
// packages/cordis/src/events.ts
waterfall(...args: any[]) {
  const cbs = this.dispatch('waterfall', args)
  const inner = args.pop()          // 最后一个参数：最里层的默认实现
  const next = (): any => {
    const cb = cbs.shift() ?? inner
    return cb(...args)
  }
  args.push(next)
  return next()
}
```

它像一个洋葱。触发方把「默认怎么做」作为最后一个参数传进来；每个监听者拿到 `next`，可以：

- **放行**：调 `next()`，交给下一层；
- **拦截**：不调 `next()`，直接返回自己的结果；
- **改写**：改一下参数再调 `next()`，或者调完 `next()` 改一下结果。

看迷你版 tools 服务里的工具执行：

```ts
// packages/tools/src/index.ts（简化）
async execute(exec) {
  const decision = await this.ctx.waterfall('tools/pre-execute', exec, async () => ({ allow: true }))
  if (!decision.allow) return { content: `已拦截：${decision.reason}`, isError: true }
  let result = await this.ctx.waterfall('tools/execute', exec, async () => {
    return { content: await this.tools.get(exec.name).execute(exec.args, exec) }
  })
  result = await this.ctx.waterfall('tools/post-execute', exec, result, async () => result)
  this.ctx.emit('tools/result', exec, result)
  return result
}
```

每次工具调用都要过三道瀑布。没人监听时，三道瀑布都直接执行默认实现，就是普通的工具调用。想加一道审批？写一个插件挂在 `tools/pre-execute` 上：

```ts
app.plugin({
  name: 'guard',
  apply(ctx) {
    ctx.on('tools/pre-execute', (exec, next) => {
      return exec.name === 'get_time' ? { allow: false, reason: '演示拦截' } : next()
    })
  },
})
```

工具和 Agent 循环一行没改，审批就生效了；卸载这个插件，审批随之消失。DSH 真实的 tools 包同样定义了 `tools/pre-execute`、`tools/execute`、`tools/post-execute` 这几个瀑布事件，在 DSH 的核心代码里分别出现了 49、35、55 次，审批、沙箱这类能力就是通过它们接进工具执行流程的。

模型调用也一样。迷你版的 `ctx.llm.stream()` 不直接调适配器，而是套了一层 `waterfall('llm/stream')`，重试、日志、改写请求都可以从这里插进去。DSH 的 llm 包里有同名的 `llm/stream` 事件。

## 04 监听者里的 this

事件还有一个小约定：**如果第一个参数是对象，它会变成监听函数里的 `this`**。

```ts
// packages/cordis/src/events.ts
dispatch(type, args) {
  const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
  const name: string = args.shift()
  if (!name.startsWith('internal/')) {
    this.emit('internal/dispatch', type, name, args, thisArg)
  }
  return (this._hooks[name] || []).map(hook => hook.callback.bind(thisArg))
}
```

DSH 的事件类型声明里经常能看到 `this: Scoped<ToolRuntime>` 这样的写法，就是这个约定：触发方把自己作为第一个参数传进来，监听者就能通过 `this` 拿到它。

## 05 框架自己的事件：internal/*

`dispatch` 里还有一行值得注意：每触发一个普通事件，框架都会顺带发一个 `internal/dispatch`。

框架自己也通过事件对外报告发生了什么。迷你版保留了四个：

| 事件 | 什么时候触发 | DSH 里的用量 |
|---|---|---|
| `internal/dispatch` | 任何业务事件被触发时 | 23 |
| `internal/plugin` | 插件挂载、卸载时 | 8 |
| `internal/service` | 服务上线、下线时 | 2 |
| `internal/status` | 插件状态变化时 | 1 |

DSH 用 `internal/dispatch` 做遥测和调试：挂一个监听，就能看到整个系统里所有事件的流动。本系列兼容性测试里打印的每一行 `[status] xxx: PENDING -> LOADING`，用的就是 `internal/status`：

```ts
app.on('internal/status', (fiber, old) => log(`  [status] ${fiber.name}: ${STATES[old]} -> ${STATES[fiber.state]}`))
```

[可视化页面](https://namiai.tech/dsh/)里的状态面板，背后也是这个思路。

## 小结

- 事件不需要 inject，说的一方和听的一方只约定一个名字；监听随插件卸载自动摘除。
- 五种触发方式：emit、parallel、serial、bail、waterfall，区别在于怎么处理返回值。
- waterfall 是洋葱式的扩展点，DSH 的审批、沙箱、重试都挂在上面，不用改核心代码。
- 框架自己也通过 `internal/*` 事件报告插件和服务的变化，这是调试和可视化的基础。

到这里，框架的四块（Context、Fiber、服务、事件）都讲完了。下一篇把它们用起来：用 11 个插件搭出一个能在浏览器里对话的 Agent。
