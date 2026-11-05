// 对应 DSH：packages/llm/llm
// 抽象的 LLM 服务。它自己不连任何模型，只定义「消息长什么样」和「怎么调用」；
// 具体连哪家，由 llm-deepseek、llm-mock 这样的适配器插件注册进来。

import { type Context, Service } from '@nami/cordis'

declare module '@nami/cordis' {
  interface Context {
    llm: LlmRuntime
  }
}

export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串。 */
  arguments: string
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string }

/** 告诉模型「有哪些工具可以用」。parameters 是 JSON Schema。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: object
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }

export interface GenerateOptions {
  messages: Message[]
  tools?: ToolSchema[]
  model?: string
  signal?: AbortSignal
}

/** 适配器：把统一的调用翻译成某一家模型的 API。 */
export interface LlmAdapter {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export class LlmRuntime extends Service {
  private adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** 适配器插件调用它注册自己。返回撤销函数，适配器插件卸载时自动注销。 */
  registerAdapter(provider: string, adapter: LlmAdapter) {
    if (this.adapters.has(provider)) throw new Error(`llm provider "${provider}" already registered`)
    this.adapters.set(provider, adapter)
    this.ctx.emit('llm/adapters-updated')
    return () => {
      this.adapters.delete(provider)
      this.ctx.emit('llm/adapters-updated')
    }
  }

  providers() {
    return [...this.adapters.keys()]
  }

  /**
   * 流式调用。外面包了一层 waterfall('llm/stream')：
   * 别的插件可以在这里加重试、日志、改写请求，不用改这里的代码。
   */
  stream(options: GenerateOptions & { provider?: string }): AsyncIterable<StreamChunk> {
    const provider = options.provider ?? this.providers()[0]
    const adapter = provider && this.adapters.get(provider)
    if (!adapter) throw new Error('no llm adapter registered')
    return this.ctx.waterfall('llm/stream', options, () => adapter.stream(options))
  }
}

export default LlmRuntime
