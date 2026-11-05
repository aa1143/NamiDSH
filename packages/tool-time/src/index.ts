// 一个最小的工具插件：依赖 tools 服务，用 effect 登记，插件卸载时工具自动消失。

import type { Context } from '@nami/cordis'

export const name = 'tool-time'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.tools.register({
    name: 'get_time',
    description: '获取当前的日期和时间',
    parameters: { type: 'object', properties: {} },
    execute: () => new Date().toLocaleString('zh-CN', { hour12: false }),
  }))
}
