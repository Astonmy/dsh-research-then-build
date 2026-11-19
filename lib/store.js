import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 先看后建模式的内存状态 + journal 持久化。
 * 只认 version 2（模式化设计）的记录；v1 的旧循环记录只在 /look-status 里回显。
 */
export class DeepStateStore {
  constructor(journal) {
    this.journal = journal
    this.map = new Map()
  }

  /**
   * 插件重载后内存是空的。把磁盘上仍然 active 的模式读回内存，
   * 否则收尾守卫（peek）会在重载后静默失效。
   */
  async warm() {
    let names
    try {
      names = await readdir(this.journal.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(await readFile(join(this.journal.dir, name), 'utf8'))
        // journal 以 agentId 为文件名（只做安全字符替换），回填时按文件名还原。
        const agentId = name.replace(/\.json$/, '')
        if (record?.version === 2 && record.state === 'active') {
          this.map.set(agentId, record)
        }
      } catch {
        /* 坏文件跳过 */
      }
    }
  }

  peek(agentId) {
    return this.map.get(agentId) ?? null
  }

  async get(agentId) {
    const cached = this.map.get(agentId)
    if (cached) return cached
    const record = await this.journal.read(agentId).catch(() => null)
    if (record && record.version === 2) {
      this.map.set(agentId, record)
      return record
    }
    return null
  }

  async set(agentId, state) {
    this.map.set(agentId, state)
    await this.journal.write(agentId, state).catch(() => {})
    return state
  }

  drop(agentId) {
    this.map.delete(agentId)
  }
}
