import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DeepStateStore } from '../lib/store.js'

function fakeJournal(dir) {
  return {
    dir,
    async read() {
      return null
    },
    async write() {},
  }
}

test('warm 把磁盘上仍 active 的模式读回内存（重载后守卫不失效）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'look-then-build-store-'))
  try {
    await writeFile(
      join(dir, 'session-abc.json'),
      JSON.stringify({ version: 2, state: 'active', task: 't', ledger: '', rounds: [], maxRounds: 3 }),
      'utf8',
    )
    await writeFile(join(dir, 'session-done.json'), JSON.stringify({ version: 2, state: 'closed', task: 't' }), 'utf8')
    await writeFile(join(dir, 'old.json'), JSON.stringify({ version: 1, state: 'finished' }), 'utf8')
    const store = new DeepStateStore(fakeJournal(dir))
    await store.warm()
    assert.equal(store.peek('session-abc')?.state, 'active')
    assert.equal(store.peek('session-done'), null)
    assert.equal(store.peek('old'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('warm 遇到坏文件不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'look-then-build-store-'))
  try {
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
    const store = new DeepStateStore(fakeJournal(dir))
    await store.warm()
    assert.equal(store.peek('broken'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
