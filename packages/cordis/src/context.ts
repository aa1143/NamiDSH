// 对应真 Cordis：src/context.ts（146 行）
// Context：插件看到的「世界」。根 ctx 是一个 Proxy，每个插件拿到一个继承自父 ctx 的子 ctx。

import { EventsService, type EventOptions } from './events.ts'
import { Fiber } from './fiber.ts'
import { createLogger, type Logger } from './logger.ts'
import { ReflectService } from './reflect.ts'
import { type Inject, type Plugin, RegistryService } from './registry.ts'

export class Context {
  root!: this
  fiber!: Fiber
  events!: EventsService
  reflect!: ReflectService
  registry!: RegistryService
  logger!: Logger

  /** 创建根 ctx，装好四个内置服务。 */
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

  /** 子 ctx：原型继承当前 ctx，再加上自己的属性（比如 fiber）。父 ctx 不受影响。 */
  extend(meta: object = {}): this {
    const self = Object.create(this)
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
    }
    return self
  }

  // ---------- 下面这些，真 Cordis 是用 mixin 从各个服务上「借」过来的，这里直接写成方法 ----------

  /** 挂载插件。 */
  plugin(plugin: Plugin, config?: any) {
    return this.registry.plugin(this, plugin, config)
  }

  /** 声明依赖并在依赖到齐后执行 callback（一个匿名子插件）。 */
  inject(deps: Inject, callback: Plugin.Function<void>) {
    return this.registry.inject(this, deps, callback)
  }

  /** 提供服务。 */
  provide(name: string, value?: any) {
    return this.reflect.provide(this, name, value)
  }

  /** 按名字取服务（不需要 inject，取不到返回 undefined）。适合可选依赖。 */
  get(name: string): any {
    return this.reflect.get(name)
  }

  /** 注册副作用。 */
  effect(execute: () => any, label?: string) {
    return this.fiber.effect(execute, label)
  }

  on(name: string, listener: (...args: any[]) => any, options?: boolean | EventOptions) {
    return this.events.on(this, name, listener, options)
  }

  emit(...args: any[]): void {
    return this.events.emit(...args)
  }

  parallel(...args: any[]): Promise<void> {
    return this.events.parallel(...args)
  }

  serial(...args: any[]): Promise<any> {
    return this.events.serial(...args)
  }

  bail(...args: any[]): any {
    return this.events.bail(...args)
  }

  waterfall(...args: any[]): any {
    return this.events.waterfall(...args)
  }
}
