// 对应真 Cordis：src/utils.ts（287 行）
// 只保留框架内部要用的几个小工具。

/** 全局 symbol，和真 Cordis 用同样的 key（Symbol.for），两边可以互认。 */
export const symbols = {
  init: Symbol.for('cordis.init'),
  config: Symbol.for('cordis.config'),
} as const

/**
 * 可撤销列表：push 返回一个「把自己删掉」的函数。
 * Fiber 用它记录「这个插件做过的所有注册」。
 */
export class DisposableList<T extends object> {
  private sn = 0
  private map = new Map<number, T>()
  private weak = new WeakMap<T, number>()

  get length() {
    return this.map.size
  }

  push(value: T) {
    const sn = ++this.sn
    this.map.set(sn, value)
    this.weak.set(value, sn)
    return () => this.map.delete(sn)
  }

  delete(value: T) {
    const sn = this.weak.get(value)
    return sn ? this.map.delete(sn) : false
  }

  /** 清空并返回所有元素，倒序：后注册的先撤销。 */
  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  [Symbol.iterator]() {
    return this.map.values()
  }
}

const GeneratorFunction = function* () {}.constructor

/** class 和普通 function 都能 new；箭头函数、对象方法简写不能。 */
export function isConstructor(fn: any): fn is new (...args: any[]) => any {
  return !!fn.prototype && !(fn instanceof GeneratorFunction)
}

export function isNullable(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

export function isObject(value: unknown): value is object {
  return !!value && (typeof value === 'object' || typeof value === 'function')
}
