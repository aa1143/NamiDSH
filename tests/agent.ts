// Agent 层测试，同时也是一份演示：DSH 式的插件组合能做到什么。
//   node tests/agent.ts

import assert from 'node:assert/strict'
import { Context } from '@nami/cordis'
import * as spine from '@nami/dsh-agent-spine'
import * as mock from '@nami/dsh-llm-mock'
import * as toolTime from '@nami/dsh-tool-time'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))
const app = new Context()

// 记录每次工具调用
const toolCalls: string[] = []
app.on('tools/result', (exec: any) => { toolCalls.push(exec.name) })

// 1. 乱序挂载：先挂模型适配器（它依赖 llm 服务，会先等着），再挂核心套件
app.plugin(mock)
app.plugin(spine, { workspace: process.cwd() })
await tick()

const ask = async (text: string) => {
  const session = app.sessions.create()
  return app.agentLoop.run(session, text)
}

// 2. 正常调用工具
let answer = await ask('现在几点？')
assert.deepEqual(toolCalls, ['get_time'])
assert.match(answer, /工具返回了结果/)
console.log('✓ 调用工具 get_time')

// 3. 挂一个审批插件：在 tools/pre-execute 上拦截，不用改工具和循环的代码
const guard = app.plugin({
  name: 'guard',
  apply(ctx: Context) {
    ctx.on('tools/pre-execute', (exec: any, next: () => any) => {
      return exec.name === 'get_time' ? { allow: false, reason: '演示拦截' } : next()
    })
  },
})
await tick()
answer = await ask('现在几点？')
assert.match(answer, /已拦截/)
console.log('✓ 审批插件拦截了 get_time')

// 4. 卸载审批插件，监听自动撤销
await guard.dispose()
answer = await ask('现在几点？')
assert.doesNotMatch(answer, /已拦截/)
console.log('✓ 卸载审批插件后恢复')

// 5. 拔掉工具插件：工具自动从工具表消失，模型就不会再调用它
app.registry.delete(toolTime)
await tick()
assert.ok(!app.tools.list().some((t: any) => t.name === 'get_time'))
toolCalls.length = 0
await ask('现在几点？')
assert.deepEqual(toolCalls, [])
console.log('✓ 拔掉 tool-time 后，工具表里没有 get_time 了')

// 6. 拔掉核心服务 llm：依赖它的 agentLoop 自动停止
const llmFiber = [...app.registry.values()].find(r => r.name === 'LlmRuntime')!.fibers
for (const fiber of llmFiber) await fiber.dispose()
await tick()
assert.equal(app.get('agentLoop'), undefined)
console.log('✓ 拔掉 llm 服务后，agentLoop 自动停止')

console.log('\nAgent 测试全部通过')
process.exit(0)
