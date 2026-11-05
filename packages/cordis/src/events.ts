// 对应真 Cordis：src/events.ts（352 行）
// 事件总线。五种触发方式全部保留：emit / parallel / serial / bail / waterfall。

import type { Context } from './context.ts'

/** 事件类型表。各个包用 declare module 往这里补自己的事件。 */
export interface Events {
  'internal/plugin'(fiber: any): void
  'internal/status'(fiber: any, oldState: number): void
  'internal/service'(name: string, value: any): void
  'internal/dispatch'(mode: DispatchMode, name: string, args: any[], thisArg: any): void
}

export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

export interface EventOptions {
  /** 插到队首，而不是队尾。 */
  prepend?: boolean
}

export interface Hook extends EventOptions {
  ctx: Context
  callback: (...args: any[]) => any
}

/** bail / serial 的「拦截」判定：返回了非空值就算拦下。 */
export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export class EventsService {
  _hooks: Record<string, Hook[]> = Object.create(null)

  /**
   * 取出某个事件的全部监听函数。
   * 第一个参数如果是对象，就当作监听函数里的 this（真 Cordis 同样的约定）。
   */
  dispatch(type: DispatchMode, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string = args.shift()
    if (!name.startsWith('internal/')) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    return (this._hooks[name] || []).map(hook => hook.callback.bind(thisArg))
  }

  /** 广播：所有监听者都调一遍，不管返回值。 */
  emit(...args: any[]) {
    for (const cb of this.dispatch('emit', args)) cb(...args)
  }

  /** 并行：所有监听者一起跑，等全部结束；有失败就一起抛出。 */
  async parallel(...args: any[]) {
    const results = await Promise.allSettled(this.dispatch('parallel', args).map(async cb => cb(...args)))
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(e => e.reason))
  }

  /** 串行：一个一个 await，谁返回了非空值就停下并返回它。 */
  async serial(...args: any[]) {
    for (const cb of this.dispatch('serial', args)) {
      const result = await cb(...args)
      if (isBailed(result)) return result
    }
  }

  /** 同步版 serial。 */
  bail(...args: any[]) {
    for (const cb of this.dispatch('bail', args)) {
      const result = cb(...args)
      if (isBailed(result)) return result
    }
  }

  /**
   * 瀑布（洋葱）：最后一个参数是「最里层的默认实现」。
   * 每个监听者拿到 (...args, next)：调 next() 往里传，不调就是拦截。
   */
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = (): any => {
      const cb = cbs.shift() ?? inner
      return cb(...args)
    }
    args.push(next)
    return next()
  }

  /**
   * 注册监听。注册本身是一个 effect：
   * 记在调用者插件的名下，插件卸载时自动取消，不用手动 off。
   */
  on(ctx: Context, name: string, listener: (...args: any[]) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') options = { prepend: options }
    const { prepend } = options
    ctx.fiber.assertActive()
    const hooks = this._hooks[name] ||= []
    return ctx.fiber.effect(() => {
      hooks[prepend ? 'unshift' : 'push']({ ctx, callback: listener, prepend })
      return () => {
        const index = hooks.findIndex(hook => hook.callback === listener)
        if (index >= 0) hooks.splice(index, 1)
      }
    }, `ctx.on(${JSON.stringify(name)})`)
  }
}
