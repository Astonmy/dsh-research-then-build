import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const run = promisify(execFile)
/** 易变、与源码无关的目录：它们写入会让指纹抖动，造成"结论过期"误判。 */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '.venv',
  '.cache',
  '.dsh',
  '.dsh-meow',
  'logs',
  'tmp',
  'temp',
  'coverage',
  'playwright-report',
  '.turbo',
])
const MAX_DEPTH = 12
const MAX_ENTRIES = 20000
const MAX_UNTRACKED_BYTES = 512 * 1024
const MAX_UNTRACKED_FILES = 200

/**
 * 工作目录指纹：用来判断「独立检查之后代码有没有又被改过」。
 * 是 git 仓库就用 status + diff HEAD + 未跟踪文件内容；不是就退化成文件树（路径 + 大小 + mtime）。
 * 这是启发式，不是密码学意义上的内容校验——它只负责发现"变过"。
 */
export async function fingerprint(cwd) {
  if (!cwd) return ''
  try {
    const { stdout: status } = await run('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    })
    let diff = ''
    try {
      const result = await run('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
      diff = result.stdout
    } catch {
      diff = ''
    }
    const hash = createHash('sha1').update(status).update(diff)
    // 未跟踪文件的"改名"会被 status 记录，但改内容不会——这里补上内容哈希。
    const untracked = status
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3).trim())
      .slice(0, MAX_UNTRACKED_FILES)
    for (const relative of untracked) {
      try {
        const bytes = await readFile(join(cwd, relative))
        if (bytes.length > MAX_UNTRACKED_BYTES) continue
        hash.update(relative).update(bytes)
      } catch {
        /* 目录或读不到就跳过 */
      }
    }
    return hash.digest('hex')
  } catch {
    /* 不是 git 仓库，走文件树 */
  }

  const entries = []
  await walk(cwd, 0, entries)
  return createHash('sha1').update(entries.join('|')).digest('hex')
}

async function walk(dir, depth, acc) {
  if (depth > MAX_DEPTH || acc.length > MAX_ENTRIES) return
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  for (const item of items) {
    if (SKIP.has(item.name)) continue
    const full = join(dir, item.name)
    if (item.isDirectory()) {
      await walk(full, depth + 1, acc)
    } else if (item.isFile()) {
      try {
        const info = await stat(full)
        acc.push(`${full}:${info.size}:${Math.round(info.mtimeMs)}`)
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
}
