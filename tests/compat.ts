// 兼容性测试：同一组场景，分别跑在迷你版和真 Cordis 上，对比输出。
//
//   node tests/compat.ts                                  # 跑迷你版
//   CORDIS=/path/to/deepseek-harness/vendor/cordis/lib/index.js node tests/compat.ts   # 跑真 Cordis
//
// 两次输出逐行一致，就说明迷你版的核心行为和真 Cordis 相同。

const lib = await import(process.env.CORDIS || '../packages/cordis/src/index.ts')
const { Context, Service } = lib

const STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
const out: string[] = []
const log = (...args: any[]) => out.push(args.join(' '))

function setup() {
  const app = new Context()
  app.on('internal/status', (fiber: any, old: number) => log(`  [status] ${fiber.name}: ${STATES[old]} -> ${STATES[fiber.state]}`))
  return app
}

const schema = (check: (v: any) => string | undefined) => ({
  '~standard': { version: 1, vendor: 'test', validate: (v: any) => { const m = check(v); return m ? { issues: [{ message: m }] } : { value: v } } },
})

const scenarios: Record<string, () => Promise<void>> = {
  async '01 插件是异步加载的'() {
    const app = setup()
    app.plugin({ name: 'hello', apply: () => { log('  apply 执行') } })
    log('  ctx.plugin() 已返回')
    await tick()
  },

  async '02 依赖等待：先挂消费者，后挂提供者'() {
    const app = setup()
    app.plugin({ name: 'consumer', inject: ['db'], apply: (ctx: any) => { log('  consumer 拿到', ctx.db.name) } })
    await tick()
    app.plugin({ name: 'provider', apply: (ctx: any) => { ctx.provide('db', { name: 'sqlite' }) } })
    await tick()
  },

  async '03 拔掉提供者：消费者先清理（还能用服务），提供者后下线'() {
    const app = setup()
    const p = app.plugin({ name: 'provider', apply: (ctx: any) => { ctx.provide('db', { name: 'sqlite' }) } })
    app.plugin({
      name: 'consumer', inject: ['db'],
      apply: (ctx: any) => { ctx.effect(() => () => log('  consumer 清理时还能用', ctx.db.name)) },
    })
    await tick()
    await p.dispose()
    await tick()
    log('  根上还能取到 db 吗：', app.get('db') === undefined ? '不能' : '能')
  },

  async '04 同名服务冲突：后来的报错进入 FAILED，原来的不受影响'() {
    const app = setup()
    app.plugin({ name: 'a', apply: (ctx: any) => { ctx.provide('db', 'A') } })
    await tick()
    const b = app.plugin({ name: 'b', apply: (ctx: any) => { ctx.provide('db', 'B') } })
    await b.then(() => {}, (e: any) => log('  b:', e.message))
    log('  db =', app.get('db'))
  },

  async '05 更新配置：提供者重启，消费者跟着用新服务重启'() {
    const app = setup()
    const p = app.plugin({ name: 'llm', apply: (ctx: any, config: any) => { ctx.provide('llm', { model: config.model }) } }, { model: 'flash' })
    app.plugin({ name: 'loop', inject: ['llm'], apply: (ctx: any) => { log('  loop 使用', ctx.llm.model) } })
    await tick()
    await p.ctx.fiber.update({ model: 'pro' })
    await tick()
  },

  async '06 错误隔离：apply 抛错只影响自己'() {
    const app = setup()
    const bad = app.plugin({ name: 'bad', async apply() { await tick(1); throw new Error('boom') } })
    app.plugin({ name: 'good', apply: () => { log('  good 正常运行') } })
    await bad.then(() => {}, (e: any) => log('  await 拿到错误:', e.message))
    await tick()
  },

  async '07 配置校验失败'() {
    const app = setup()
    const p = app.plugin({ name: 'cfg', Config: schema(v => v?.port ? undefined : 'port is required'), apply() {} }, {})
    await p.then(() => {}, (e: any) => log('  ', e.name, '|', e.message.split('\n')[1]))
  },

  async '08 Service 类：static inject + Config + 异步 init'() {
    const app = setup()
    class Store extends Service {
      constructor(ctx: any) { super(ctx, 'store') }
    }
    class Loop extends Service {
      static inject = ['store']
      static Config = schema(v => typeof v?.max === 'number' ? undefined : 'max must be number')
      max: number
      constructor(ctx: any, config: any) {
        super(ctx, 'loop')
        this.max = config.max
      }
      async [Service.init]() {
        await tick(1)
        log('  Loop init 完成, max =', this.max)
      }
    }
    app.plugin(Loop, { max: 3 })
    app.plugin(Store)
    await tick(30)
    log('  root 取 loop.max =', app.loop.max)
  },

  async '09 事件：emit / serial / bail / parallel / waterfall'() {
    const app = setup()
    app.plugin({
      name: 'listeners',
      apply(ctx: any) {
        ctx.on('greet', (who: string) => log('  emit 收到', who))
        ctx.on('pick', () => undefined)
        ctx.on('pick', () => 'second')
        ctx.on('pick', () => 'third')
        ctx.on('job', async () => { await tick(1); log('  parallel 完成') })
        ctx.on('exec', (cmd: string, next: () => string) => cmd === 'rm' ? 'blocked' : next())
        ctx.on('exec', (cmd: string, next: () => string) => next().toUpperCase())
      },
    })
    await tick()
    app.emit('greet', 'nami')
    log('  bail =', app.bail('pick'))
    log('  serial =', await app.serial('pick'))
    await app.parallel('job')
    log('  waterfall rm =', app.waterfall('exec', 'rm', (c: string) => 'ran ' + c))
    log('  waterfall ls =', app.waterfall('exec', 'ls', (c: string) => 'ran ' + c))
  },

  async '10 卸载插件：监听自动取消'() {
    const app = setup()
    const p = app.plugin({ name: 'l', apply: (ctx: any) => { ctx.on('ping', () => log('  pong')) } })
    await tick()
    app.emit('ping')
    await p.dispose()
    app.emit('ping')
    log('  卸载后 emit：无输出')
  },

  async '11 嵌套插件：父插件卸载，子插件一起卸载'() {
    const app = setup()
    const p = app.plugin({
      name: 'parent',
      apply(ctx: any) {
        ctx.plugin({ name: 'child', apply: (c: any) => () => log('  child 清理') })
        return () => log('  parent 清理')
      },
    })
    await tick()
    await p.dispose()
    await tick()
  },

  async '12 没 inject 的服务读不到'() {
    const app = setup()
    app.plugin({ name: 'p', apply: (ctx: any) => { ctx.provide('secret', 42) } })
    await tick()
    app.plugin({ name: 'q', apply: (ctx: any) => {
      try { ctx.secret } catch (e: any) { log('  直接读:', e.message.split('\n')[0]) }
      log('  ctx.get 可以:', ctx.get('secret'))
    } })
    await tick()
  },

  async '13 ctx.inject：可选依赖，到了才执行'() {
    const app = setup()
    app.plugin({ name: 'main', apply(ctx: any) {
      ctx.inject(['cache'], (c: any) => { log('  cache 到了:', c.cache) })
    } })
    await tick()
    log('  （cache 还没有）')
    app.plugin({ name: 'cache', apply: (ctx: any) => { ctx.provide('cache', 'redis') } })
    await tick()
  },

  async '14 异步 effect'() {
    const app = setup()
    const p = app.plugin({ name: 'conn', apply(ctx: any) {
      ctx.effect(async () => { await tick(1); log('  连接建立'); return () => log('  连接关闭') })
    } })
    await tick(20)
    await p.dispose()
  },
}

for (const [title, run] of Object.entries(scenarios)) {
  log(`=== ${title}`)
  await run()
  await tick(20)
}
console.log(out.join('\n'))
