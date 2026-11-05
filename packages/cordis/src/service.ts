// 对应真 Cordis：src/service.ts（115 行）
// 服务基类。DSH 里 62 个服务都是这么写的：
//
//   class AgentLoop extends Service {
//     static inject = ['llm', 'tools']
//     constructor(ctx, config) { super(ctx, 'agentLoop') }
//   }

import type { Context } from './context.ts'
import { symbols } from './utils.ts'

export abstract class Service {
  /** 可选的异步启动钩子：async [Service.init]() { ... }，框架会等它完成。 */
  static readonly init: typeof symbols.init = symbols.init
  static readonly config: typeof symbols.config = symbols.config

  ctx: Context
  name: string

  constructor(ctx: Context, name?: string) {
    name ??= (this.constructor as any).provide as string
    this.ctx = ctx
    this.name = name
    // 构造时就把自己注册成服务；所在插件停止时自动下线
    ctx.provide(name, this)
  }
}
