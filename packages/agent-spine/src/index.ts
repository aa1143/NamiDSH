// 对应 DSH：packages/examples/agent-spine-demo
// 套件插件：把每个 Agent 都需要的核心服务一次挂上。
// 和 DSH 一样，「连哪个模型」和「入口（网页 / 命令行）」故意留在外面，由使用方决定。

import type { Context } from '@nami/cordis'
import LlmRuntime from '@nami/dsh-llm'
import SessionStore from '@nami/dsh-session'
import ToolRuntime from '@nami/dsh-tools'
import SystemPrompt from '@nami/dsh-system-prompt'
import AgentLoop, { type Config as AgentLoopConfig } from '@nami/dsh-agent-loop'
import * as toolTime from '@nami/dsh-tool-time'
import * as toolFs from '@nami/dsh-tool-fs'

export interface Config {
  /** 文件工具允许访问的目录。 */
  workspace: string
  persona?: string
  agent?: AgentLoopConfig
}

export const name = 'agent-spine'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(LlmRuntime)
  ctx.plugin(SessionStore)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SystemPrompt, { persona: config.persona })
  ctx.plugin(toolTime)
  ctx.plugin(toolFs, { root: config.workspace })
  ctx.plugin(AgentLoop, config.agent)
}
