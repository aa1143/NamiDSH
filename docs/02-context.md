# 插件与 Context：插件拿到的到底是什么

> 上一篇说，DeepSeek Harness 里一切都是插件。这一篇从最底层开始：一个插件长什么样，`ctx.plugin()` 那一瞬间发生了什么，插件拿到的 `ctx` 又是什么。
>
> 对应 NamiDSH 的 `packages/cordis/src/context.ts` 和 `registry.ts`，对应 DSH 的 `vendor/cordis/src` 里的同名文件。

## 01 插件的三种写法

在 Cordis 里，插件可以写成三种形式，框架都认：

```ts
// 1. 函数
function hello(ctx: Context, config: Config) { /* ... */ }

// 2. 带 apply 方法的对象（或者一个模块）
const hello = { name: 'hello', inject: ['llm'], apply(ctx, config) { /* ... */ } }

// 3. class，通常继承 Service
class AgentLoop extends Service {
  static inject = ['llm', 'tools']
  constructor(ctx: Context, config: Config) { super(ctx, 'agentLoop') }
}
```

DSH 里三种都有，最常见的是后两种：服务写成 class（DSH 里有 62 个），小插件写成一个模块，用 `export const name`、`export const inject`、`export function apply` 导出，挂载时直接 `ctx.plugin(模块)`。

框架怎么认出这三种写法？只看一件事：能不能拿到一个「可调用的东西」。

```ts
// packages/cordis/src/registry.ts
resolve(plugin: Plugin): Function | undefined {
  if (typeof plugin === 'function') return plugin
  if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') return plugin.apply
}
```

函数和 class 本身就是函数；对象就取它的 `apply`。这个函数同时也是插件的「身份」：同一个插件挂多少次，都共享一个身份，框架用它来记录这个插件有几个实例。

## 02 ctx.plugin() 做了什么

挂载一个插件，只有一行：

```ts
app.plugin(hello, { name: 'nami' })
```

框架内部做了三件事：

```ts
// packages/cordis/src/registry.ts（简化）
plugin(ctx, plugin, config) {
  const callback = this.resolve(plugin)
  let runtime = this._internal.get(callback)        // 1. 找到或创建这个插件的登记项
  if (!runtime) { /* 新建，记下名字和配置校验规则 */ }
  const fiber = new Fiber(ctx, config, Inject.resolve(plugin.inject), runtime)  // 2. 创建一个插件实例
  return /* fiber，外面包一层，让它可以被 await */                            // 3. 返回
}
```

这里出现了一个新名字：**Fiber**。一个插件挂一次，就产生一个 Fiber，它代表「这个插件的这一次运行」：它现在是什么状态、依赖到齐没有、做过哪些注册。下一篇整篇都讲它。

注意第 3 步：返回值可以 `await`。为什么要 await？因为**插件不是在 `ctx.plugin()` 里同步执行的**。

兼容性测试的第一个场景就验证了这一点，迷你版和真 Cordis 输出完全一样：

```text
=== 01 插件是异步加载的
  [status] hello: PENDING -> LOADING
  ctx.plugin() 已返回
  apply 执行
  [status] hello: LOADING -> ACTIVE
```

`ctx.plugin()` 已经返回了，`apply` 才执行。这样设计有两个好处：一是插件的 `apply` 可以是异步的（连数据库、读配置）；二是一个插件出错，异常不会冒到挂载它的地方，把后面的插件都拖垮。第 3 篇讲错误隔离时会再看到它。

如果你确实想等插件加载完：

```ts
await app.plugin(hello)   // 加载失败时，这里会抛出插件的错误
```

## 03 每个插件拿到一个自己的 ctx

插件的 `apply(ctx)` 拿到的 `ctx`，不是全局那个根 ctx，而是专门为它造的**子 ctx**：

```ts
// packages/cordis/src/fiber.ts（Fiber 的构造函数里）
this.ctx = parent.extend({ fiber: this })
```

```ts
// packages/cordis/src/context.ts
extend(meta: object = {}): this {
  const self = Object.create(this)
  for (const prop of Reflect.ownKeys(meta)) {
    Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
  }
  return self
}
```

`Object.create(this)` 让子 ctx 原型继承父 ctx：父 ctx 上有的方法（`plugin`、`on`、`provide`……）子 ctx 都能用。子 ctx 只多了一个自己的属性：`fiber`，指向这个插件实例。

为什么要多此一举？看 `ctx.on` 是怎么实现的：

```ts
// packages/cordis/src/context.ts
on(name: string, listener: (...args: any[]) => any, options?: boolean | EventOptions) {
  return this.events.on(this, name, listener, options)
}
```

它把 `this`（也就是调用它的那个 ctx）传给了事件服务。事件服务再通过 `ctx.fiber` 知道：**这个监听是哪个插件注册的**，于是把「撤销这个监听」记在那个插件名下。

插件卸载时，框架只要把这个插件名下记的东西全部撤销，就清理干净了。插件自己不用写一行清理代码。

这就是子 ctx 的意义：**让每一次注册都知道自己属于谁**。这是 Cordis 能做到干净热插拔的根基。

## 04 根 ctx：一切的起点

整个应用从一个根 ctx 开始：

```ts
// packages/cordis/src/context.ts
constructor() {
  const self = new Proxy<this>(this, ReflectService.handler)
  this.root = self
  this.logger = createLogger()
  this.fiber = new Fiber(self, {}, Object.create(null), null)
  this.reflect = new ReflectService(self)
  this.registry = new RegistryService()
  this.events = new EventsService()
  return self
}
```

构造函数做了三件事：

- **包一层 Proxy**。以后读 `ctx.llm`、`ctx.tools` 这种属性，都会经过这个 Proxy 去服务表里找。第 4 篇专门讲它。
- **创建根 Fiber**。根 Fiber 一出生就是运行状态，所有插件都挂在它下面，形成一棵树。
- **装上四个内置服务**：`reflect`（服务表）、`registry`（插件登记）、`events`（事件总线）、`logger`（日志）。

真 Cordis 的构造函数几乎一样，也是这四个服务。区别在于，真 Cordis 用 `mixin` 把 `ctx.on`、`ctx.plugin` 这些方法从各个服务上「借」到 ctx 上；迷你版直接把它们写成 Context 的方法。效果相同，读起来更直接。

## 05 插件树

有了子 ctx，插件里还可以再挂插件：

```ts
app.plugin({
  name: 'parent',
  apply(ctx) {
    ctx.plugin({ name: 'child', apply: () => () => console.log('child 清理') })
    return () => console.log('parent 清理')
  },
})
```

子插件挂在父插件的 ctx 上。父插件卸载时，子插件跟着一起卸载：

```text
=== 11 嵌套插件：父插件卸载，子插件一起卸载
  [status] parent: ACTIVE -> UNLOADING
  parent 清理
  [status] child: ACTIVE -> UNLOADING
  child 清理
  [status] child: UNLOADING -> DISPOSED
  [status] parent: UNLOADING -> DISPOSED
```

原因很简单：「挂载一个子插件」本身也是父插件做的一次注册，记在父插件名下。父插件清理时，顺手就把子插件卸了。

DSH 正是靠这一点组装出整个 Agent 的：它有一个叫 `agent-spine` 的「套件插件」，在自己的 `apply` 里一口气挂上二十多个核心插件。整个 Agent 就是一棵插件树，根在 `new Context()`。第 6 篇会用迷你版搭一棵这样的树。

## 小结

- 插件有三种写法：函数、带 `apply` 的对象、class。框架只认「可调用的东西」。
- `ctx.plugin()` 为插件创建一个 Fiber，插件的 `apply` 是异步执行的。
- 每个插件拿到自己的子 ctx，所以它做的每一次注册都知道属于谁，卸载时能清理干净。
- 插件里可以再挂插件，整个应用是一棵插件树。

下一篇讲 Fiber：一个插件从挂载到卸载，中间会经历哪几种状态，框架又是怎么替它记账的。
