// 对应 DSH：packages/host/webserver + frontend-static
// 网页服务：GET / 返回聊天页面；POST /api/chat 跑一次 Agent，用 SSE 把回答一个字一个字推给浏览器。

import type { Context } from '@nami/cordis'
import { createServer, type IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Config {
  port?: number
  host?: string
  /** 静态页面所在目录（里面要有 index.html）。 */
  staticDir: string
}

export const name = 'webserver'
export const inject = ['agentLoop', 'sessions']

async function readBody(req: IncomingMessage) {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body || '{}')
}

export function apply(ctx: Context, config: Config) {
  const { port = 3000, host = '127.0.0.1', staticDir } = config
  const logger = ctx.logger('webserver')

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(await readFile(join(staticDir, 'index.html')))
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.writeHead(404)
      return res.end('not found')
    }

    const { sessionId, message } = await readBody(req)
    const session = (sessionId && ctx.sessions.get(sessionId)) || ctx.sessions.create()
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('session', { id: session.id })

    // 浏览器断开就中止这次请求
    const abort = new AbortController()
    res.on('close', () => abort.abort())

    // 只转发属于这个会话的事件。请求结束时撤销监听
    const disposers = [
      ctx.on('agent/text-delta', (s, text) => { if (s === session) send('delta', { text }) }),
      ctx.on('agent/tool-call', (s, call) => { if (s === session) send('tool', { name: call.name }) }),
    ]
    try {
      await ctx.agentLoop.run(session, String(message ?? ''), abort.signal)
      send('done', {})
    } catch (error: any) {
      if (!abort.signal.aborted) send('error', { message: error.message })
    } finally {
      disposers.forEach(dispose => dispose())
      res.end()
    }
  })

  // 启动服务器也是一个 effect：插件卸载时自动关闭
  ctx.effect(() => {
    server.listen(port, host, () => logger.info(`网页端已启动：http://localhost:${port}`))
    return () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  })
}
