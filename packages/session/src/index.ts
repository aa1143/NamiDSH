// 对应 DSH：packages/core/session
// 会话 = 一条只追加的事件日志。发给模型的消息列表，是从日志「推导」出来的。

import { type Context, Service } from '@nami/cordis'
import type { Message, ToolCall } from '@nami/dsh-llm'

declare module '@nami/cordis' {
  interface Context {
    sessions: SessionStore
  }
}

export type SessionEvent =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { type: 'tool-result'; toolCallId: string; name: string; content: string }

export class Session {
  id: string
  log: (SessionEvent & { ts: number })[] = []
  private ctx: Context

  constructor(ctx: Context, id: string) {
    this.ctx = ctx
    this.id = id
  }

  /** 追加一条事件，并广播 session/event。 */
  append(event: SessionEvent) {
    const entry = { ...event, ts: Date.now() }
    this.log.push(entry)
    this.ctx.emit('session/event', this, entry)
  }

  /** 从日志推导出发给模型的消息。 */
  deriveMessages(): Message[] {
    return this.log.map((e): Message => {
      if (e.type === 'user') return { role: 'user', content: e.text }
      if (e.type === 'assistant') return { role: 'assistant', content: e.text, toolCalls: e.toolCalls }
      return { role: 'tool', content: e.content, toolCallId: e.toolCallId }
    })
  }
}

export class SessionStore extends Service {
  private sessions = new Map<string, Session>()

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    // 服务卸载时，清掉所有会话
    ctx.effect(() => () => this.sessions.clear())
  }

  create(id = crypto.randomUUID()) {
    const session = new Session(this.ctx, id)
    this.sessions.set(id, session)
    this.ctx.emit('session/created', session)
    return session
  }

  get(id: string) {
    return this.sessions.get(id)
  }
}

export default SessionStore
