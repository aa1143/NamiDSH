# 服务与依赖注入：ctx.llm 是怎么来的

> DeepSeek Harness 的 Agent 循环里写着 `ctx.llm`、`ctx.tools`，却没有 import 任何模型或工具的代码。这一篇讲这背后的机制：服务怎么提供，依赖怎么声明，`ctx.llm` 这一个属性读取背后发生了什么。
>
> 对应 NamiCordis 的 `packages/cordis/src/reflect.ts` 和 `service.ts`，对应 DSH 的 `vendor/cordis/src` 里的同名文件。

## 01 提供服务：provide

一个插件想把自己的能力给别人用，就提供一个服务：

```ts
ctx.provide('db', { name: 'sqlite' })
```

或者写成 Service 类，构造时自动提供：

```ts
// packages/cordis/src/service.ts
export abstract class Service {
  constructor(ctx: Context, name?: string) {
    this.ctx = ctx
    this.name = name
    ctx.provide(name, this)   // 构造时就把自己注册成服务；所在插件停止时自动下线
  }
}
```

DSH 里的核心能力几乎都是这么写的：`LlmRuntime` 提供 `llm`，`ToolRuntime` 提供 `tools`，`SessionStore` 提供 `sessions`，`AgentLoop` 提供 `agentLoop`。

`provide` 的实现：

```ts
// packages/cordis/src/reflect.ts
provide(ctx: Context, name: string, value?: any) {
  return ctx.fiber.effect(() => {
    if (this.store[name]) {
      throw new Error(`service "${name}" has been registered at <${this.store[name].fiber.name}>`)
    }
    const impl: Impl = { name, value, fiber: ctx.fiber }
    this.store[name] = impl
    ctx.fiber.store![name] = impl
    if (ctx.fiber.state === FiberState.ACTIVE) this.notify([name])
    return async () => { /* 下线：见第 04 节 */ }
  }, `ctx.provide(${JSON.stringify(name)})`)
}
```

三个要点：

- **它是一个 effect**。所以服务会随插件一起下线，不用手动注销。
- **服务表里记的不只是值，还有提供者是哪个 Fiber**。上一篇的 epoch 就靠这一点。
- **一个名字只能有一个提供者**。第二个插件再提供同名服务，直接报错，进入 FAILED，原来的服务不受影响：

```text
=== 04 同名服务冲突：后来的报错进入 FAILED，原来的不受影响
  [status] b: LOADING -> UNLOADING
  [status] b: UNLOADING -> FAILED
  b: service "db" has been registered at <a>
  db = A
```

这是一个「宁可报错，不要猜」的设计。悄悄覆盖看起来更方便，但会出现两个「真相」：服务表里是新的，已经拿到旧服务的插件手里还是旧的。

## 02 声明依赖：inject

用服务的一方，要先声明自己依赖什么：

```ts
const consumer = {
  name: 'consumer',
  inject: ['db'],
  apply(ctx) { console.log(ctx.db.name) },
}
```

`inject` 是 DSH 里出现最多的写法，一共 395 处。它告诉框架两件事：这个插件需要 `db`；在 `db` 到齐之前，别启动我。

所以挂载顺序无所谓。先挂消费者也没关系，它会停在 PENDING 等着：

```text
=== 02 依赖等待：先挂消费者，后挂提供者
  [status] provider: PENDING -> LOADING
  [status] provider: LOADING -> ACTIVE
  [status] consumer: PENDING -> LOADING
  consumer 拿到 sqlite
  [status] consumer: LOADING -> ACTIVE
```

consumer 一直在等。provider 一变成 ACTIVE，consumer 自动启动。

框架怎么知道「provider 好了，该通知 consumer」？靠 `notify`：

```ts
// packages/cordis/src/reflect.ts（简化）
notify(names: string[]) {
  for (const runtime of this.root.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (!names.some(name => name in fiber.inject)) continue
      for (const name of names) fiber._checkImpl(name)   // 重新看看这个依赖现在由谁提供
      fiber._refresh()                                    // 重新算 epoch
    }
  }
}
```

服务一有变化（上线、下线、提供者从 LOADING 变成 ACTIVE），就把所有 inject 了它的插件挨个叫醒，让它们重新检查依赖。这里有一个细节：`_checkImpl` 只认**状态是 ACTIVE 的提供者**。提供者还在加载中，它提供的服务就不算数，避免消费者拿到一个没初始化完的服务。

## 03 ctx.llm：一次属性读取背后的事

声明了依赖，插件里就可以直接写 `ctx.db`。这不是普通的属性，`ctx` 是一个 Proxy：

```ts
// packages/cordis/src/reflect.ts
get(target, prop, ctx: Context) {
  if (isSpecialProperty(prop) || Reflect.has(target, prop)) {
    return Reflect.get(target, prop, ctx)       // 1. Context 自己有的（plugin、on……）
  }
  if (!ctx.fiber.runtime) return target.reflect.get(prop, false)   // 2. 根 ctx 不受限制
  let fiber = ctx.fiber
  while (true) {                                // 3. 沿着插件树往上找
    const impl = fiber.store?.[prop]
    if (impl) return impl.value
    if (prop in fiber.inject) {
      throw new Error(`cannot get required service "${prop}" in inactive context`)
    }
    if (!fiber.runtime) throw new Error(`cannot get property "${prop}" without inject`)
    fiber = fiber.parent.fiber
  }
}
```

读 `ctx.db` 时，框架从当前插件的 Fiber 开始，看它的 `store` 里有没有 `db`；没有就往父插件找，一直找到根。`store` 是插件加载时拍下的依赖快照，加上这个插件自己提供的服务。

**没声明的服务，读不到**。哪怕服务表里明明有：

```text
=== 12 没 inject 的服务读不到
  直接读: cannot get property "secret" without inject
  ctx.get 可以: 42
```

这条规则看起来有点严格，但它保证了一件事：**插件依赖什么，看它的 inject 就全知道了**。框架也正是根据 inject 来决定启动顺序、什么时候重启。如果允许偷偷读一个没声明的服务，这个服务下线时，框架根本不知道该通知谁。

真的需要「有就用、没有也行」的服务，有两个办法：

- `ctx.get('name')`：直接查服务表，查不到返回 undefined。DSH 里用了 178 次，比如 Agent 循环里 `ctx.get('sessionPersistence')`：有持久化就用，没有就算了。
- `ctx.inject(['name'], callback)`：等这个服务到了再执行 callback，服务走了 callback 里做的注册自动撤销。DSH 里用了 39 次。

```text
=== 13 ctx.inject：可选依赖，到了才执行
  （cache 还没有）
  [status] cache: LOADING -> ACTIVE
  [status] main: PENDING -> LOADING
  cache 到了: redis
```

`ctx.inject` 其实就是挂了一个只有依赖声明的匿名子插件，用的全是前面讲过的机制。

## 04 拔掉提供者：先存盘，再拔电源

服务下线时，顺序很讲究。看 `provide` 返回的那个撤销函数：

```ts
// packages/cordis/src/reflect.ts
return async () => {
  delete this.store[name]                                  // 1. 从服务表删掉
  const fibers = this.notify([name])                        // 2. 通知依赖方
  await Promise.allSettled(fibers.map(fiber => fiber.await()))   // 3. 等依赖方清理完
  if (ctx.fiber.store) delete ctx.fiber.store[name]         // 4. 最后才从自己的快照里删掉
}
```

第 3 步是关键：**提供者要等所有依赖方清理完，才真正下线**。依赖方清理时读的是自己的快照，所以还能用这个服务，比如关闭前最后写一次日志、存一次盘：

```text
=== 03 拔掉提供者：消费者先清理（还能用服务），提供者后下线
  [status] provider: ACTIVE -> UNLOADING
  [status] consumer: ACTIVE -> UNLOADING
  consumer 清理时还能用 sqlite
  [status] consumer: UNLOADING -> PENDING
  [status] provider: UNLOADING -> DISPOSED
```

consumer 清理完、退回 PENDING 之后，provider 才变成 DISPOSED。在拆机 DSH 第 2 篇的迷你主板里，这个顺序是反的：先删服务、再通知循环停止，循环收尾时就报错了。这就像先拔电源，再让电脑保存文件。

## 05 类型：declare module

最后一个问题：`ctx.llm` 在 TypeScript 里是什么类型？Context 类上并没有 `llm` 这个字段。

答案是声明合并。提供服务的包，顺手给 Context 补一个类型声明：

```ts
// packages/llm/src/index.ts
declare module '@nami/cordis' {
  interface Context {
    llm: LlmRuntime
  }
}
```

DSH 的每个服务包都这么做（`declare module '@deepseek-ai/cordis'`）。于是，只要 import 了这个包，所有插件里的 `ctx.llm` 都有完整的类型提示，但运行时依然只靠服务名，彼此没有代码上的依赖。

## 小结

- `provide` 是一个 effect，服务随插件上线下线；一个名字只能有一个提供者。
- `inject` 声明依赖，挂载顺序随意，依赖到齐自动启动；DSH 里用了 395 次。
- `ctx.xxx` 是 Proxy，沿插件树查找；没 inject 的读不到，可选依赖用 `ctx.get` 或 `ctx.inject`。
- 服务下线时，先等依赖方清理完，再真正删除。

下一篇讲插件之间的另一种联系方式：事件。服务是「我要用你」，事件是「我广播一下，谁感兴趣谁来」。
