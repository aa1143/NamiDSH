// 对应 DSH：packages/llm/llm-replay（测试用的回放模型）
// 离线假模型：不需要 API Key，用几条规则模拟「决定调工具 → 拿到结果 → 回答」。

import type { Context } from '@nami/cordis'
import type { GenerateOptions, LlmAdapter, StreamChunk } from '@nami/dsh-llm'

export const name = 'llm-mock'
export const inject = ['llm']

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class MockAdapter implements LlmAdapter {
  async *stream({ messages, tools = [] }: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = messages[messages.length - 1]
    const has = (name: string) => tools.some(t => t.name === name)
    let reply: string

    if (last.role === 'tool') {
      reply = `工具返回了结果：\n\n${last.content}\n\n（这是离线假模型的回答。设置环境变量 API_KEY 后会改用 DeepSeek。）`
    } else {
      const text = last.content
      const call = (name: string, args: object) => ({ type: 'tool-call' as const, call: { id: `call_${Date.now()}`, name, arguments: JSON.stringify(args) } })
      if (/时间|几点|日期/.test(text) && has('get_time')) { yield call('get_time', {}); return }
      if (/文件|目录|项目/.test(text) && has('list_dir')) { yield call('list_dir', { path: '.' }); return }
      reply = `你好，我是离线假模型，只会两件事：\n- 问我「现在几点」，我会调用 get_time\n- 问我「项目里有哪些文件」，我会调用 list_dir\n\n设置环境变量 API_KEY 后，就会换成真正的 DeepSeek。`
    }
    // 模拟流式输出
    for (const char of reply) {
      yield { type: 'text', text: char }
      await sleep(8)
    }
  }
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.llm.registerAdapter('mock', new MockAdapter()))
}
