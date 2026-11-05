// 对应 DSH：packages/fs/tool-fs
// 只读文件工具：read_file、list_dir。只允许访问 root 目录以内的文件。

import type { Context } from '@nami/cordis'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export interface Config {
  /** 允许访问的根目录。 */
  root: string
  /** 单个文件最多读多少字节。 */
  maxBytes?: number
}

export const name = 'tool-fs'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const { root, maxBytes = 20_000 } = config

  // 防止 ../ 跳出根目录
  const safePath = (path = '.') => {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`不允许访问根目录以外的路径：${path}`)
    return full
  }

  ctx.effect(() => ctx.tools.register({
    name: 'list_dir',
    description: '列出目录里的文件和子目录（路径相对于工作目录）',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，默认 .' } } },
    async execute({ path }) {
      const entries = await readdir(safePath(path), { withFileTypes: true })
      return entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n') || '（空目录）'
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'read_file',
    description: '读取一个文本文件的内容（路径相对于工作目录）',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute({ path }) {
      const full = safePath(path)
      if ((await stat(full)).size > maxBytes) {
        return (await readFile(full, 'utf8')).slice(0, maxBytes) + `\n…（文件太大，只读了前 ${maxBytes} 字节）`
      }
      return readFile(full, 'utf8')
    },
  }))
}
