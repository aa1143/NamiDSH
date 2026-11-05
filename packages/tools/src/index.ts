// 对应 DSH：packages/core/tools
// 工具表 + 执行管线。每次工具调用都要经过三道 waterfall：
//   tools/pre-execute  → 执行前：审批、拦截（返回 { allow: false } 就不执行）
//   tools/execute      → 执行：可以包一层超时、沙箱
//   tools/post-execute → 执行后：可以改写结果
// 这三道都是事件，想加功能就挂监听，不用改这里的代码。

import { type Context, Service } from '@nami/cordis'
import type { ToolSchema } from '@nami/dsh-llm'

declare module '@nami/cordis' {
  interface Context {
    tools: ToolRuntime
  }
}

export interface ToolDefinition extends ToolSchema {
  execute(args: any, exec: ToolExecution): Promise<string> | string
}

export interface ToolExecution {
  name: string
  args: any
  sessionId?: string
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export class ToolRuntime extends Service {
  private tools = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** 工具插件调用它登记自己。返回撤销函数，放进 ctx.effect 就能随插件自动注销。 */
  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" already registered`)
    this.tools.set(tool.name, tool)
    this.ctx.emit('tools/change')
    return () => {
      this.tools.delete(tool.name)
      this.ctx.emit('tools/change')
    }
  }

  /** 给模型看的工具清单。 */
  list(): ToolSchema[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  async execute(exec: ToolExecution): Promise<ToolResult> {
    const decision = await this.ctx.waterfall('tools/pre-execute', exec, async () => ({ allow: true }))
    let result: ToolResult
    if (!decision.allow) {
      result = { content: `已拦截：${decision.reason ?? '不允许调用'} ${exec.name}`, isError: true }
    } else {
      result = await this.ctx.waterfall('tools/execute', exec, async () => {
        const tool = this.tools.get(exec.name)
        if (!tool) return { content: `没有这个工具：${exec.name}`, isError: true }
        try {
          return { content: await tool.execute(exec.args, exec) }
        } catch (error: any) {
          return { content: `工具出错：${error.message}`, isError: true }
        }
      })
    }
    result = await this.ctx.waterfall('tools/post-execute', exec, result, async () => result)
    this.ctx.emit('tools/result', exec, result)
    return result
  }
}

export default ToolRuntime
