import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fingerprint } from '../lib/fingerprint.js'

const run = promisify(execFile)

test('git 仓库下，未跟踪文件的内容改动也会改变指纹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deep-loop-fpgit-'))
  try {
    await run('git', ['init'], { cwd: dir })
    await writeFile(join(dir, 'tracked.js'), 'base', 'utf8')
    await run('git', ['add', '.'], { cwd: dir })
    await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'], { cwd: dir })
    await writeFile(join(dir, 'fresh.js'), 'one', 'utf8')
    const first = await fingerprint(dir)
    await writeFile(join(dir, 'fresh.js'), 'two', 'utf8')
    const second = await fingerprint(dir)
    assert.notEqual(first, second)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('文件内容变化会改变指纹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deep-loop-fp-'))
  try {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one', 'utf8')
    const first = await fingerprint(dir)
    await writeFile(file, 'two', 'utf8')
    const second = await fingerprint(dir)
    assert.notEqual(first, '')
    assert.notEqual(first, second)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('深层目录的改动也能被发现', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deep-loop-fp-'))
  try {
    const deep = join(dir, 'src', 'features', 'auth', 'hooks', 'use')
    await mkdir(deep, { recursive: true })
    const file = join(deep, 'auth.ts')
    await writeFile(file, 'one', 'utf8')
    const first = await fingerprint(dir)
    await writeFile(file, 'two', 'utf8')
    assert.notEqual(first, await fingerprint(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('易变目录（.dsh-meow、node_modules）不参与指纹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deep-loop-fp-'))
  try {
    await writeFile(join(dir, 'code.js'), 'x', 'utf8')
    const before = await fingerprint(dir)
    await mkdir(join(dir, '.dsh-meow'), { recursive: true })
    await writeFile(join(dir, '.dsh-meow', 'probe.tmp'), 'noise', 'utf8')
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'noise', 'utf8')
    assert.equal(before, await fingerprint(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('目录内容不变时指纹稳定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deep-loop-fp-'))
  try {
    await writeFile(join(dir, 'b.txt'), 'stable', 'utf8')
    assert.equal(await fingerprint(dir), await fingerprint(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有 cwd 时返回空串，不抛错', async () => {
  assert.equal(await fingerprint(''), '')
  assert.equal(await fingerprint(undefined), '')
})
