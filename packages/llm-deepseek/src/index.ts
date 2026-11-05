// 对应 DSH：packages/llm/llm-deepseek
// DeepSeek 适配器：把统一的 GenerateOptions 翻译成 OpenAI 兼容的 /chat/completions 流式请求。

import type { Context } from '@nami/cordis'
import type { GenerateOptions, LlmAdapter, Message, StreamChunk, ToolCall } from '@nami/dsh-llm'

export interface Config {
  apiKey: string
  baseURL?: string
  model?: string
}

export const name = 'llm-deepseek'
export const inject = ['llm']

/** 统一消息格式 → OpenAI 格式。 */
function toWire(message: Message) {
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    }
  }
  return { role: message.role, content: message.content }
}

/** 解析 SSE：一行一个 `data: {...}`，最后是 `data: [DONE]`。 */
async function* readSSE(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body as any) {
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      yield JSON.parse(data)
    }
  }
}

export class DeepSeekAdapter implements LlmAdapter {
  config: Required<Config>

  constructor(config: Config) {
    this.config = {
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.deepseek.com',
      model: config.model ?? 'deepseek-v4-flash',
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: options.model ?? this.config.model,
        stream: true,
        messages: options.messages.map(toWire),
        tools: options.tools?.length
          ? options.tools.map(t => ({ type: 'function', function: t }))
          : undefined,
      }),
    })
    if (!response.ok || !response.body) {
      throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
    }
    // 工具调用是分片到达的：按 index 把 name 和 arguments 拼起来，最后一起交出去
    const calls: ToolCall[] = []
    for await (const event of readSSE(response.body)) {
      const delta = event.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) yield { type: 'text', text: delta.content }
      for (const part of delta.tool_calls ?? []) {
        const call = calls[part.index] ??= { id: '', name: '', arguments: '' }
        if (part.id) call.id = part.id
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
      }
    }
    for (const call of calls) yield { type: 'tool-call', call }
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.effect(() => ctx.llm.registerAdapter('deepseek', new DeepSeekAdapter(config)))
}
