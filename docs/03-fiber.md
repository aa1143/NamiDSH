# Fiber：一个插件的一生

> 上一篇说，每挂载一次插件，框架就创建一个 Fiber。这一篇跟着一个 Fiber 走完它的一生：它会处于哪几种状态，什么时候启动、什么时候停下，出错了怎么办，卸载时又是怎么清理干净的。
>
> 对应 NamiDSH 的 `packages/cordis/src/fiber.ts`（329 行），对应 DSH 的 `vendor/cordis/src/fiber.ts`（754 行），是整个框架最核心的文件。

## 01 六种状态

一个 Fiber 在任意时刻，都处于下面六种状态之一。数值和真 Cordis 完全一样：

```ts
export const FiberState = {
  PENDING: 0,   // 依赖没到齐，等着
  LOADING: 1,   // 正在执行 apply（可能是异步的）
  ACTIVE: 2,    // 运行中
  FAILED: 3,    // apply 出错了，被隔离，不影响别人
  DISPOSED: 4,  // 已卸载
  UNLOADING: 5, // 正在执行清理
} as const
```

正常的一生是这样的：

```text
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
```

但它不一定一路走到底。依赖消失了，它会从 ACTIVE 退回 PENDING，等依赖回来再重新启动；`apply` 抛错了，它会停在 FAILED。DSH 里有 59 处代码读取 `FiberState`，主要用在调试工具和遥测上：有了这些状态，就能知道整棵插件树上每个插件此刻在干什么。

[可视化页面](https://namiai.tech/dsh/)右下角的状态面板，显示的就是这些状态。

## 02 effect：可撤销的注册

在讲状态怎么流转之前，先看 Fiber 最重要的能力：**记账**。

插件做的每一件「会留下痕迹」的事，都要通过 `ctx.effect` 来做：

```ts
ctx.effect(() => {
  const timer = setInterval(tick, 1000)   // 做一件事
  return () => clearInterval(timer)       // 返回怎么撤销它
})
```

`effect` 接收一个函数，这个函数做一次注册，然后**返回撤销函数**。Fiber 把撤销函数记在自己的账本 `_disposables` 里：

```ts
// packages/cordis/src/fiber.ts（简化）
effect(execute, label = 'anonymous') {
  const dispose = () => { /* 调用撤销函数，并把自己从账本里删掉 */ }
  const remove = this._disposables.push(dispose)   // 先占位
  const result = execute()                          // 再执行
  if (typeof result === 'function') cleanup = result
  else if (isObject(result) && 'then' in result) { /* 异步 effect：等它返回撤销函数 */ }
  else if (!isNullable(result)) throw new TypeError('Invalid effect')
  return dispose
}
```

关键在于：**提供服务、监听事件、挂载子插件，在框架内部全都是用 effect 实现的**。所以插件根本不用自己调 `effect` 去管这些，只要是通过 ctx 做的注册，自动入账。

DSH 里 `ctx.effect` 出现了 130 次，都是插件自己需要清理的事：登记工具、开定时器、建连接。比如 Agent 循环把自己登记成 Agent 工厂：

```ts
ctx.effect(() => ctx.agents.setFactory(this))
```

`setFactory` 返回一个撤销函数，Agent 循环卸载时，工厂登记自动撤掉。

账本还有一个细节：**后注册的先撤销**。

```ts
// packages/cordis/src/utils.ts
clear() {
  const values = [...this.map.values()]
  this.map.clear()
  return values.reverse()
}
```

先开连接再在连接上开订阅，卸载时就得先关订阅再关连接。倒序撤销保证了这个顺序。

## 03 加载与卸载

现在看状态怎么流转。核心是两个异步方法：`_reload`（加载）和 `_unload`（卸载）。

**加载**：

```ts
// packages/cordis/src/fiber.ts（简化）
private async _reload() {
  this.store = { ...this._store }   // 拍一张依赖的快照
  try {
    await Promise.resolve()          // 让出一拍：ctx.plugin() 先返回
    this.config = resolveConfig(this.runtime, this._config)   // 校验配置
    await this._execute()            // 执行插件本体：class 就 new，函数就调用
    this._error = undefined
  } catch (reason) {
    this.ctx.logger.error(reason)
    this._error = reason             // 记下错误，状态会变成 FAILED
  }
  // ...根据最新的依赖情况，决定是进入 ACTIVE，还是马上再卸载
}
```

`await Promise.resolve()` 这一行就是上一篇看到的「`ctx.plugin()` 已返回，`apply` 才执行」的原因。

`_execute` 执行插件本体。如果插件是一个 Service 类，并且定义了 `[Service.init]()` 方法，框架会等它跑完才算加载完成。DSH 里有 11 个服务用了这个钩子，做的都是异步的初始化工作。

**卸载**：

```ts
// packages/cordis/src/fiber.ts（简化）
private async _unload() {
  await Promise.all(this._disposables.clear().map(async (dispose) => {
    try { await dispose() } catch (reason) { this.ctx.logger.error(reason) }
  }))
  this.store = undefined
  // ...如果这期间依赖又到齐了，马上重新加载
}
```

把账本里的撤销函数全部执行一遍。某一个撤销函数出错，只记一条日志，不影响其他撤销函数继续执行。

还有一个容易忽略的设计：加载和卸载**不会同时进行**。Fiber 用一个叫 `inertia` 的字段记住「当前正在进行的切换」，新的状态变化要等当前切换结束后才处理。这样，即使依赖在一瞬间来回变化好几次，插件也不会被同时加载两份。

## 04 错误隔离

`_reload` 里的 `try/catch` 带来了 Cordis 的一个重要性质：**一个插件出错，只影响它自己**。

```ts
const bad = app.plugin({ name: 'bad', async apply() { await tick(1); throw new Error('boom') } })
app.plugin({ name: 'good', apply: () => { log('  good 正常运行') } })
```

```text
=== 06 错误隔离：apply 抛错只影响自己
  [status] bad: PENDING -> LOADING
  [status] good: PENDING -> LOADING
  good 正常运行
  [status] good: LOADING -> ACTIVE
  [status] bad: LOADING -> UNLOADING
  [status] bad: UNLOADING -> FAILED
  await 拿到错误: boom
```

`bad` 出错后，先进入 UNLOADING，把它在出错之前已经做过的注册清理掉，然后停在 FAILED。`good` 完全不受影响。如果你 `await` 了 `bad`，能拿到它的错误；不 await，错误只会记一条日志。

配置写错也是同样的处理。插件可以用 `static Config` 声明配置格式（DSH 用的是自家的 schemastery，写法和 zod 类似；真 Cordis 和迷你版都按 Standard Schema 接口校验，所以 zod 这类库也能直接用）。配置校验不通过，插件直接进入 FAILED：

```text
=== 07 配置校验失败
  [status] cfg: PENDING -> LOADING
  [status] cfg: LOADING -> UNLOADING
  [status] cfg: UNLOADING -> FAILED
   ValidationError |   - port is required
```

对一个由几百个插件组成的系统来说，这一点非常重要：某个第三方插件写坏了，整个 Agent 照样能启动，只是少了这一个功能。

## 05 epoch：依赖换了，插件自动重启

最后一个机制，也是最精巧的一个。

一个插件声明了 `inject: ['llm']`，框架要回答两个问题：llm 到齐了没有？到齐的是哪一个？

Fiber 用一个字符串同时回答这两个问题，叫 **epoch**：

```ts
// packages/cordis/src/fiber.ts
_refresh() {
  let epoch = ''
  for (const name of Object.keys(this.inject)) {
    const impl = this._store[name]
    if (!impl) {
      epoch = INACTIVE   // 有一个依赖不在，就是「未就绪」
      break
    }
    epoch += ':' + impl.fiber.uid   // 拼上每个依赖的提供者编号
  }
  this._setEpoch(epoch)
}
```

每个 Fiber 都有一个唯一编号 `uid`。epoch 就是「所有依赖的提供者编号」拼起来的字符串，比如 `:3:7`。

- 依赖不齐：epoch 是 `INACTIVE`，插件停在 PENDING。
- 依赖到齐：epoch 从 `INACTIVE` 变成 `:3:7`，插件开始加载。
- **提供者换了**：哪怕服务名一样，只要提供者的 Fiber 变了，epoch 就会变成 `:5:7`，插件会先卸载再重新加载，拿到新的服务。

看一个例子：llm 插件改了配置，从 flash 换成 pro。改配置会让 llm 插件重启，依赖它的 loop 插件跟着重启：

```text
=== 05 更新配置：提供者重启，消费者跟着用新服务重启
  loop 使用 flash
  [status] llm: ACTIVE -> UNLOADING
  [status] loop: ACTIVE -> UNLOADING
  [status] loop: UNLOADING -> PENDING
  [status] llm: UNLOADING -> LOADING
  [status] llm: LOADING -> ACTIVE
  [status] loop: PENDING -> LOADING
  loop 使用 pro
  [status] loop: LOADING -> ACTIVE
```

没有任何地方写着「模型换了，请重启循环」。这个连锁反应完全来自两条规则：**依赖不齐就停下，依赖到齐就启动**。

在[拆机 DSH 第 2 篇](https://namiai.tech/teardown/deepseek-harness/cordis/)里，我手写的 150 行迷你主板有一个 bug：同名服务被悄悄覆盖后，Agent 循环手里还拿着旧的模型。epoch 正是真 Cordis 解决这个问题的办法：依赖关心的不只是「有没有」，还有「是哪一个」。

## 小结

- Fiber 有六种状态，数值和真 Cordis 一致。
- 插件的每一次注册都通过 effect 记账，卸载时倒序撤销，插件自己不用写清理代码。
- 加载和卸载是异步的、串行的；`apply` 出错只影响自己，停在 FAILED。
- epoch 把「依赖齐不齐」和「依赖是谁」合成一个字符串，提供者一换，插件自动重启。

下一篇讲 Fiber 的依赖是怎么来的：服务怎么提供，`ctx.llm` 怎么取到，没声明的服务为什么取不到。
