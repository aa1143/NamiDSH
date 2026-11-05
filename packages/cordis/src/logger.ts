// 对应真 Cordis：src/logger.ts（270 行）
// 只做一个很薄的日志门面：ctx.logger.error(...)、ctx.logger('name').info(...)。

export interface Logger {
  (name: string): Logger
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 } as const

/** 日志级别，用环境变量 CORDIS_LOG 调整（debug / info / warn / error / silent）。 */
const threshold: number = LEVELS[(globalThis as any).process?.env?.CORDIS_LOG as keyof typeof LEVELS] ?? LEVELS.info

export function createLogger(name = 'app'): Logger {
  const logger = ((child: string) => createLogger(child)) as Logger
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    logger[level] = (...args: any[]) => {
      if (LEVELS[level] < threshold) return
      const text = args.map(a => a instanceof Error ? a.message : a)
      ;(level === 'error' ? console.error : console.log)(`[${level[0].toUpperCase()}] ${name}`, ...text)
    }
  }
  return logger
}
