// 对应真 Cordis：src/fiber.ts（754 行）
// Fiber = 一个插件实例。框架最核心的部分：状态机、依赖检查、异步加载、卸载回收、错误隔离。

import type { Context } from './context.ts'
import type { PluginRuntime } from './registry.ts'
import type { Impl } from './reflect.ts'
import { DisposableList, isConstructor, isNullable, isObject, symbols } from './utils.ts'

/** 六种状态，数值和真 Cordis 完全一致。 */
export const FiberState = {
  PENDING: 0, // 依赖没到齐，等着
  LOADING: 1, // 正在执行 apply（可能是异步的）
  ACTIVE: 2, // 运行中
  FAILED: 3, // apply 出错了，被隔离，不影响别人
  DISPOSED: 4, // 已卸载
  UNLOADING: 5, // 正在执行清理
} as const
export type FiberState = (typeof FiberState)[keyof typeof FiberState]

export type Disposable<T = any> = () => T

/** 配置校验失败。配置用 Standard Schema 接口校验，zod、valibot 都能直接用。 */
export class ValidationError extends TypeError {
  name = 'ValidationError'
  constructor(issues: readonly { message: string; path?: readonly any[] }[]) {
    super('invalid config:\n' + issues.map(i => `  - ${i.message}${i.path ? ` (at ${i.path.join('.')})` : ''}`).join('\n'))
  }
}

export function resolveConfig(runtime: PluginRuntime, config: any) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new ValidationError(result.issues)
  return result.value
}

export class CordisError extends Error {
  code: string
  constructor(code: 'INACTIVE_EFFECT') {
    super('cannot create effect on inactive context')
    this.code = code
  }
}

/** epoch 的特殊值：依赖不齐。 */
const INACTIVE = '__INACTIVE__'

export class Fiber {
  uid: number | null
  ctx: Context
  parent: Context
  inject: Record<string, any>
  runtime: PluginRuntime | null
  config: any
  _config: any
  state: FiberState = FiberState.PENDING
  dispose: () => any
  /** 运行期间能看到的服务快照：注入的 + 自己提供的。 */
  store: Record<string, Impl> | undefined
  /** 正在进行的状态切换（加载或卸载）。同一时刻只有一个，切换是串行的。 */
  inertia: Promise<void> | undefined
  /** 这个插件做过的所有注册（服务、监听、子插件……），每项都是一个撤销函数。 */
  _disposables = new DisposableList<Disposable>()
  _error: any
  /**
   * epoch = 所依赖服务的「提供者 uid」拼起来的字符串。
   * 依赖不齐时是 INACTIVE；依赖换了提供者，epoch 就变，插件自动重启。
   */
  _epoch = INACTIVE
  /** 依赖检查的结果：服务名 → 当前提供者。 */
  _store: Record<string, Impl> = Object.create(null)

  constructor(parent: Context, config: any, inject: Record<string, any>, runtime: PluginRuntime | null) {
    this.parent = parent
    this._config = config
    this.inject = inject
    this.runtime = runtime

    if (!runtime) {
      // 根 fiber：一出生就是 ACTIVE
      this.uid = 0
      this.ctx = parent
      this.state = FiberState.ACTIVE
      this.store = Object.create(null)
      this._epoch = ''
      this.dispose = () => this.restart()
      return
    }

    this.uid = parent.registry.counter
    // 每个插件拿到自己的子 ctx，它做的注册都能记在自己名下
    this.ctx = parent.extend({ fiber: this })

    // 「挂载」本身也是父插件的一个 effect：父插件卸载时，子插件跟着卸载
    this.dispose = parent.fiber.effect(() => {
      const remove = runtime.fibers.push(this)
      return async () => {
        this.uid = null
        this.ctx.emit('internal/plugin', this)
        if (this.ctx.registry.has(runtime.callback)) {
          remove()
          if (!runtime.fibers.length) this.ctx.registry.delete(runtime.callback)
        }
        this._setEpoch(INACTIVE)
        if (!this.inertia) {
          this._updateState(() => {
            this.inertia = this._unload()
            return FiberState.UNLOADING
          })
        }
        while (this.inertia) await this.inertia
      }
    }, 'ctx.plugin()')

    this.ctx.emit('internal/plugin', this)
    if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
      for (const name of Object.keys(this.inject)) this._checkImpl(name)
      this._refresh()
    }
  }

  get name(): string {
    let fiber: Fiber = this
    do {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    } while (fiber !== fiber.parent.fiber)
    return 'root'
  }

  assertActive() {
    if (this.uid === null) throw new CordisError('INACTIVE_EFFECT')
  }

  /**
   * 副作用：execute 做一件注册，返回撤销函数（也可以返回 Promise<撤销函数>）。
   * 撤销函数记在本插件名下；插件停止时自动执行。返回值可以手动提前撤销。
   */
  effect(execute: () => any, label = 'anonymous'): Disposable & PromiseLike<Disposable> {
    this.assertActive()
    if (this.state === FiberState.UNLOADING) throw new CordisError('INACTIVE_EFFECT')

    let cleanup: Disposable | undefined
    let task: Promise<void> | undefined
    let disposed = false
    const dispose: any = () => {
      if (disposed) return
      disposed = true
      remove()
      return task ? task.then(() => cleanup?.()) : cleanup?.()
    }
    dispose.label = label
    // 先占位，再执行：后注册的先撤销
    const remove = this._disposables.push(dispose)
    let result: any
    try {
      result = execute()
    } catch (error) {
      remove()
      throw error
    }
    if (typeof result === 'function') {
      cleanup = result
    } else if (isObject(result) && 'then' in result) {
      task = Promise.resolve(result).then((value: any) => { cleanup = value }, (reason) => {
        disposed = true
        remove()
        this.ctx.logger.error(reason)
      })
    } else if (!isNullable(result)) {
      remove()
      throw new TypeError('Invalid effect')
    }
    dispose.then = (onFulfilled: any, onRejected: any) => {
      return Promise.resolve(task).then(() => () => dispose()).then(onFulfilled, onRejected)
    }
    return dispose
  }

  // ---------- 状态机 ----------

  private _getState(): FiberState {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  private _updateState(callback: () => void | FiberState) {
    const oldState = this.state
    this.state = callback() ?? this._getState()
    if (oldState === this.state) return
    this.ctx.emit('internal/status', this, oldState)
    // 进入或离开 ACTIVE 时，通知依赖本插件服务的其他插件
    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) return
    for (const impl of Object.values(this.ctx.reflect.store)) {
      if (impl.fiber === this) this.ctx.reflect.notify([impl.name])
    }
  }

  /** 检查某个依赖现在由谁提供（只认 ACTIVE 的提供者）。 */
  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name)
    if (impl) this._store[name] = impl
    else delete this._store[name]
  }

  /** 重新计算 epoch：依赖齐了吗？提供者换了吗？ */
  _refresh() {
    let epoch = ''
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.fiber.uid
    }
    this._setEpoch(epoch)
  }

  private _setEpoch(epoch: string) {
    const oldEpoch = this._epoch
    if (epoch === oldEpoch) return
    this._epoch = epoch
    // 正在切换中：等当前切换结束后，它自己会对照最新 epoch 再决定下一步
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  /** 执行插件本体：class 就 new，函数就调用。返回函数则当作清理函数。 */
  private async _execute() {
    const callback: any = this.runtime!.callback
    let result: any
    if (isConstructor(callback)) {
      const instance = new callback(this.ctx, this.config)
      result = instance?.[symbols.init]?.()
    } else {
      result = callback(this.ctx, this.config)
    }
    // 和 effect 一样：返回值只能是清理函数或空，其他值视为写错了
    result = await result
    if (typeof result === 'function') this._disposables.push(result)
    else if (!isNullable(result)) throw new TypeError('Invalid effect')
  }

  /** 加载：异步执行 apply。出错就进入 FAILED，错误只记日志，不往外抛——这就是错误隔离。 */
  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._epoch
    try {
      await Promise.resolve()
      if (this._epoch === oldEpoch) {
        this.config = this.runtime ? resolveConfig(this.runtime, this._config) : this._config
        await this._execute()
        this._error = undefined
      }
    } catch (reason) {
      this.ctx.logger.error(reason)
      this._error = reason
      this._epoch = INACTIVE
    }
    this._updateState(() => {
      if (this._epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  /** 卸载：执行全部撤销函数（后注册的先撤销），之后按需重新加载。 */
  private async _unload() {
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await Promise.resolve()
        await dispose()
      } catch (reason) {
        this.ctx.logger.error(reason)
      }
    }))
    this.store = undefined
    this._updateState(() => {
      if (this._epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  /** 等待所有状态切换结束。插件加载失败时抛出它的错误。 */
  async await() {
    while (this.inertia) await this.inertia
    if (this._error) throw this._error
    return this
  }

  async restart() {
    this.assertActive()
    this._setEpoch(INACTIVE)
    this._refresh()
    await this.await()
  }

  /** 更新配置：插件用新配置重启。 */
  update(config: any) {
    this.assertActive()
    this._config = config
    this._error = undefined
    if (this.state !== FiberState.ACTIVE) {
      this._setEpoch(INACTIVE)
      this._refresh()
      return
    }
    return this.restart()
  }
}
