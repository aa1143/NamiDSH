// 对应真 Cordis：src/registry.ts（337 行）
// 插件登记表：ctx.plugin() 和 ctx.inject() 的实现。

import type { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { DisposableList } from './utils.ts'

/** 依赖声明：数组 ['llm', 'tools']，或对象 { llm: 配置, tools: null }。 */
export type Inject = string[] | Record<string, any>

export const Inject = {
  resolve(inject: Inject | null | undefined) {
    const result: Record<string, any> = Object.create(null)
    if (!inject) return result
    if (Array.isArray(inject)) {
      for (const name of inject) result[name] = null
    } else {
      for (const name of Object.keys(inject)) result[name] = inject[name] ?? null
    }
    return result
  },
}

/** 一个 Standard Schema（zod 等都实现了这个接口）。 */
export interface StandardSchema<T = any> {
  '~standard': {
    validate(value: unknown): { value: T; issues?: undefined } | { issues: readonly { message: string; path?: readonly any[] }[] }
  }
}

/** 插件的三种写法：函数、class、带 apply 方法的对象。 */
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string
    Config?: StandardSchema<T>
    inject?: Inject
    provide?: string
  }
  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }
  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }
  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }
}

/** 同一个插件（不管挂了几份）共享一个 runtime。 */
export interface PluginRuntime {
  name?: string
  callback: Function
  fibers: DisposableList<Fiber>
  Config?: StandardSchema
}

export class RegistryService {
  private _counter = 0
  private _internal = new Map<Function, PluginRuntime>()

  /** 每个插件实例一个递增的 uid。 */
  get counter() {
    return ++this._counter
  }

  /** 插件的「身份」：函数/class 本身，或对象的 apply 方法。 */
  resolve(plugin: Plugin): Function | undefined {
    if (typeof plugin === 'function') return plugin
    if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') return plugin.apply
  }

  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  /** 删除一个插件：它的所有实例都卸载。 */
  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const fiber of runtime.fibers) fiber.dispose()
    return runtime
  }

  values() {
    return this._internal.values()
  }

  /** ctx.inject(['a'], cb)：一个只有依赖声明的匿名子插件。依赖可选时常用。 */
  inject(ctx: Context, inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin(ctx, { inject, apply: callback, name: callback.name })
  }

  /** ctx.plugin()：创建一个 Fiber。返回值可以 await（等它加载完）。 */
  plugin(ctx: Context, plugin: Plugin, config?: any): Fiber & PromiseLike<Fiber> {
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    ctx.fiber.assertActive()
    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }
    const fiber = new Fiber(ctx, config, Inject.resolve(plugin.inject), runtime)
    // 返回值可以 await；其余属性和方法都直接转给 fiber 本身
    return new Proxy(fiber, {
      get: (target, prop) => {
        if (prop === 'then') return (onFulfilled: any, onRejected: any) => fiber.await().then(onFulfilled, onRejected)
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as any
  }
}
