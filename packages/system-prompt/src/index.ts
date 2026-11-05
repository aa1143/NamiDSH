// 对应 DSH：packages/core/system-prompt
// 系统提示词不是一个写死的字符串，而是由多个插件各自贡献「段落」拼起来的。

import { type Context, Service } from '@nami/cordis'

declare module '@nami/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }
}

export interface Config {
  /** 部署方的人设，放在最前面。 */
  persona?: string
}

export interface PromptSection {
  id: string
  /** 越小越靠前。 */
  order: number
  render(): string | undefined
}

export class SystemPrompt extends Service {
  private sections = new Map<string, PromptSection>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'systemPrompt')
    const persona = config.persona ?? '你是一个乐于助人的 AI 助手，回答简洁准确。需要时调用工具获取信息。'
    ctx.effect(() => this.section({ id: 'persona', order: 0, render: () => persona }))
    ctx.effect(() => this.section({ id: 'time', order: 100, render: () => `今天是 ${new Date().toLocaleDateString('zh-CN')}。` }))
  }

  /** 其他插件调用它贡献一段提示词。返回撤销函数。 */
  section(section: PromptSection) {
    this.sections.set(section.id, section)
    return () => this.sections.delete(section.id)
  }

  build() {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map(s => s.render())
      .filter(Boolean)
      .join('\n\n')
  }
}

export default SystemPrompt
