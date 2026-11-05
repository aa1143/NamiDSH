// 对应真 Cordis：src/reflect.ts（418 行）
// 服务的注册与查找。ctx.llm 这种写法，就是这里的 Proxy 实现的。

import type { Context } from './context.ts'
import { type Fiber, FiberState } from './fiber.ts'

/** 一个服务实现：名字、值、由哪个插件提供。 */
export interface Impl {
  name: string
  value: any
  fiber: Fiber
}

/** 这些属性名不走服务查找。 */
function isSpecialProperty(prop: string | symbol): prop is symbol {
  return typeof prop === 'symbol' || prop === 'then' || prop === 'prototype' || prop.startsWith('_')
}

export class ReflectService {
  /**
   * Context 的 Proxy 规则。读 ctx.xxx 时：
   * 1. Context 自己有的（plugin、on、fiber……）直接返回；
   * 2. 否则当作服务名，沿着插件树往上找。没 inject 的服务读不到，直接报错。
   */
  static handler: ProxyHandler<Context> = {
    get(target, prop, ctx: Context) {
      if (isSpecialProperty(prop) || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, ctx)
      }
      // 根 ctx 不受限制，可以直接取任何服务
      if (!ctx.fiber.runtime) return target.reflect.get(prop, false)
      let fiber = ctx.fiber
      while (true) {
        const impl = fiber.store?.[prop]
        if (impl) return impl.value
        if (prop in fiber.inject) {
          throw new Error(`cannot get required service "${prop}" in inactive context`)
        }
        if (!fiber.runtime) throw new Error(`cannot get property "${prop}" without inject`)
        fiber = fiber.parent.fiber
      }
    },
    set(target, prop, value, ctx: Context) {
      if (isSpecialProperty(prop) || !ctx.fiber?.runtime) {
        return Reflect.set(target, prop, value, ctx)
      }
      throw new Error(`cannot set property "${String(prop)}" without provide`)
    },
    has(target, prop) {
      if (Reflect.has(target, prop)) return true
      return typeof prop === 'string' && prop in target.reflect.props
    },
  }

  /** 全局服务表：名字 → 实现。一个名字同时只能有一个提供者。 */
  store: Record<string, Impl> = Object.create(null)
  /** 出现过的服务名。 */
  props: Record<string, true> = Object.create(null)
  root: Context

  constructor(root: Context) {
    this.root = root
  }

  /** 按名字取服务。strict 时只返回 ACTIVE 插件提供的。 */
  get(name: string, strict = true) {
    return this._getImpl(name, strict)?.value
  }

  _getImpl(name: string, strict = true) {
    const impl = this.store[name]
    if (!impl) return
    if (strict && impl.fiber.state !== FiberState.ACTIVE) return
    return impl
  }

  /**
   * 提供服务。也是一个 effect：插件停止时服务自动下线。
   * 下线时先通知依赖方、等它们清理完，再把自己从快照里删掉——
   * 所以依赖方在清理时还能用这个服务（先存盘，再拔电源）。
   */
  provide(ctx: Context, name: string, value?: any) {
    return ctx.fiber.effect(() => {
      this.props[name] = true
      if (this.store[name]) {
        throw new Error(`service "${name}" has been registered at <${this.store[name].fiber.name}>`)
      }
      const impl: Impl = { name, value, fiber: ctx.fiber }
      this.store[name] = impl
      ctx.fiber.store![name] = impl
      if (ctx.fiber.state === FiberState.ACTIVE) this.notify([name])
      return async () => {
        delete this.store[name]
        const fibers = this.notify([name])
        await Promise.allSettled(fibers.map(fiber => fiber.await()))
        if (ctx.fiber.store) delete ctx.fiber.store[name]
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  /** 服务变了：让所有 inject 了它的插件重新检查依赖。返回受影响的插件。 */
  notify(names: string[]) {
    const fibers: Fiber[] = []
    for (const runtime of this.root.registry.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false
        for (const name of names) {
          if (!(name in fiber.inject)) continue
          hasUpdate = true
          fiber._checkImpl(name)
        }
        if (!hasUpdate) continue
        fiber._refresh()
        fibers.push(fiber)
      }
    }
    for (const name of names) {
      this.root.emit(this.root, 'internal/service', name, this._getImpl(name, false)?.value)
    }
    return fibers
  }
}
