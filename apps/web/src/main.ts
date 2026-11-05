// 对应 DSH：apps/web
// 入口只做一件事：创建根 ctx，把插件挂上去。整个 Agent 就是一棵插件树。
//
//   node apps/web/src/main.ts
//
// 环境变量：API_KEY（不设就用离线假模型）、BASE_URL、MODEL、PORT、WORKSPACE

import { Context } from '@nami/cordis'
import * as spine from '@nami/dsh-agent-spine'
import * as deepseek from '@nami/dsh-llm-deepseek'
import * as mock from '@nami/dsh-llm-mock'
import * as webserver from '@nami/dsh-webserver'
import { fileURLToPath } from 'node:url'

const env = process.env
const app = new Context()

// 1. 核心套件：llm、sessions、tools、systemPrompt、agentLoop，外加两个工具插件
app.plugin(spine, { workspace: env.WORKSPACE ?? process.cwd() })

// 2. 模型适配器：有 API Key 就接 DeepSeek，没有就用离线假模型。Agent 循环的代码一行不用改
const apiKey = env.API_KEY ?? env.DEEPSEEK_API_KEY
if (apiKey) {
  app.plugin(deepseek, { apiKey, baseURL: env.BASE_URL, model: env.MODEL })
} else {
  app.plugin(mock)
  app.logger('web').warn('没有设置 API_KEY，使用离线假模型')
}

// 3. 入口：网页服务
app.plugin(webserver, {
  port: Number(env.PORT ?? 3000),
  staticDir: fileURLToPath(new URL('../public', import.meta.url)),
})
