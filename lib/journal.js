import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function defaultDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deep-loop')
}

/** 每个会话一份 JSON 快照：原子写，避免半截记录；不碰会话日志。 */
export class Journal {
  constructor(directory) {
    this.dir = directory ?? defaultDirectory()
  }

  pathOf(agentId) {
    const safe = String(agentId).replace(/[^a-zA-Z0-9_.-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  async write(agentId, record) {
    await mkdir(this.dir, { recursive: true })
    const file = this.pathOf(agentId)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await rename(tmp, file)
  }

  async read(agentId) {
    try {
      return JSON.parse(await readFile(this.pathOf(agentId), 'utf8'))
    } catch {
      return null
    }
  }
}
