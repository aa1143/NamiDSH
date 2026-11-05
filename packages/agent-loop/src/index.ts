// 对应 DSH：packages/core/agent-loop
// Agent 循环本身也只是一个插件。它不知道模型是哪家、有哪些工具，只认四个服务名。

import { type Context, Service } from '@nami/cordis'
import type { Message, ToolCall } from '@nami/dsh-llm'
import type { Session } from '@nami/dsh-session'

declare module '@nami/cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}

export interface Config {
  /** 用哪个适配器，默认第一个注册的。 */
  provider?: string
  model?: string
  /** 一次提问最多来回几轮（防止无限调工具）。 */
  maxSteps?: number
}

export class AgentLoop extends Service {
  static inject = ['llm', 'tools', 'sessions', 'systemPrompt']

  config: Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentLoop')
    this.config = { maxSteps: 8, ...config }
  }

  /**
   * 跑一次：用户输入 → [调模型 → 有工具调用就执行 → 结果写回会话 → 再调模型] → 最终回答。
   * 过程中发出 agent/* 事件，网页端靠它们拿到流式输出。
   */
  async run(session: Session, input: string, signal?: AbortSignal): Promise<string> {
    const { llm, tools, systemPrompt } = this.ctx
    const { provider, model, maxSteps } = this.config
    session.append({ type: 'user', text: input })
    this.ctx.emit('agent/status', session, 'busy')
    try {
      for (let step = 1; step <= maxSteps!; step++) {
        this.ctx.emit('agent/request', session, step)
        const messages: Message[] = [{ role: 'system', content: systemPrompt.build() }, ...session.deriveMessages()]
        let text = ''
        const calls: ToolCall[] = []
        for await (const chunk of llm.stream({ messages, tools: tools.list(), provider, model, signal })) {
          if (chunk.type === 'text') {
            text += chunk.text
            this.ctx.emit('agent/text-delta', session, chunk.text)
          } else {
            calls.push(chunk.call)
          }
        }
        session.append({ type: 'assistant', text, toolCalls: calls.length ? calls : undefined })
        if (!calls.length) return text

        for (const call of calls) {
          let args = {}
          try { args = JSON.parse(call.arguments || '{}') } catch {}
          this.ctx.emit('agent/tool-call', session, call)
          const result = await tools.execute({ name: call.name, args, sessionId: session.id })
          session.append({ type: 'tool-result', toolCallId: call.id, name: call.name, content: result.content })
        }
      }
      return '（达到最大步数，已停止）'
    } finally {
      this.ctx.emit('agent/status', session, 'idle')
    }
  }
}

export default AgentLoop
