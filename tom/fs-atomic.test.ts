import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { atomicWriteFileSync, atomicWriteFile } from './fs-atomic'

// Re-export node:fs through a fresh object so its properties are configurable
// and vi.spyOn works (the real ESM namespace is frozen). Behavior is unchanged.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual }
})

let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-atomic-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('atomicWriteFileSync', () => {
  it('writes the complete content to the target', () => {
    const target = path.join(testDir, 'sub', 'user-model.json')
    const payload = JSON.stringify({ a: 1, big: 'x'.repeat(10000) })

    atomicWriteFileSync(target, payload)

    expect(fs.readFileSync(target, 'utf-8')).toBe(payload)
  })

  it('creates parent directories that do not exist', () => {
    const target = path.join(testDir, 'a', 'b', 'c', 'index.json')
    atomicWriteFileSync(target, '{}')
    expect(fs.existsSync(target)).toBe(true)
  })

  // The core anti-torn-read invariant, observed via the filesystem: an atomic
  // rename replaces the target with a NEW inode, whereas the old in-place
  // `fs.writeFileSync(target)` truncates and reuses the same inode (the window
  // in which a concurrent reader sees a torn file). This regresses
  // deterministically against the pre-fix code with no spies.
  it('replaces the target via rename (new inode), not in-place truncation', () => {
    const target = path.join(testDir, 'user-model.json')
    fs.writeFileSync(target, JSON.stringify({ old: true }))
    const inoBefore = fs.statSync(target).ino

    atomicWriteFileSync(target, JSON.stringify({ new: true }))

    expect(fs.statSync(target).ino).not.toBe(inoBefore)
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ new: true })
  })

  // Same invariant asserted at the call layer: the target is never opened for
  // writing — it is only ever published by renaming a fully-written temp.
  it('never writes the target directly; publishes via rename of a temp', () => {
    const target = path.join(testDir, 'user-model.json')
    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    const renameSpy = vi.spyOn(fs, 'renameSync')

    atomicWriteFileSync(target, '{"x":1}')

    // Every write hit a temp sibling, never the target itself.
    expect(writeSpy).toHaveBeenCalled()
    for (const call of writeSpy.mock.calls) {
      const writtenPath = call[0]
      expect(typeof writtenPath).toBe('string')
      expect(writtenPath).not.toBe(target)
      expect(String(writtenPath).startsWith(`${target}.`)).toBe(true)
      expect(String(writtenPath).endsWith('.tmp')).toBe(true)
    }

    // The publish was an atomic rename of the temp onto the target.
    expect(renameSpy).toHaveBeenCalledTimes(1)
    const [renameFrom, renameTo] = renameSpy.mock.calls[0]!
    expect(renameTo).toBe(target)
    expect(renameFrom).toBe(writeSpy.mock.calls[0]![0])
  })

  it('uses a unique temp path per write (no cross-write clobber)', () => {
    const target = path.join(testDir, 'index.json')
    const tempPaths: string[] = []
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor) => {
      tempPaths.push(String(p))
    }) as typeof fs.writeFileSync)
    vi.spyOn(fs, 'renameSync').mockImplementation((() => {}) as typeof fs.renameSync)

    atomicWriteFileSync(target, 'a')
    atomicWriteFileSync(target, 'b')
    atomicWriteFileSync(target, 'c')

    expect(new Set(tempPaths).size).toBe(3)
  })

  it('leaves no temp files behind on success', () => {
    const target = path.join(testDir, 'index.json')
    atomicWriteFileSync(target, '{}')
    const leftovers = fs.readdirSync(testDir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('removes the temp file and rethrows when rename fails', () => {
    const target = path.join(testDir, 'index.json')
    const renameErr = new Error('rename failed')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw renameErr
    })

    expect(() => atomicWriteFileSync(target, '{}')).toThrow(renameErr)

    // The temp that writeFileSync actually created must be cleaned up.
    const leftovers = fs.readdirSync(testDir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('atomicWriteFile (async)', () => {
  it('writes the complete content to the target', async () => {
    const target = path.join(testDir, 'session.json')
    const payload = JSON.stringify({ s: 'y'.repeat(5000) })

    await new Promise<void>((resolve, reject) => {
      atomicWriteFile(target, payload, reject)
      // Poll until the rename lands.
      const check = () => {
        if (fs.existsSync(target)) resolve()
        else setTimeout(check, 5)
      }
      setTimeout(check, 5)
    })

    expect(fs.readFileSync(target, 'utf-8')).toBe(payload)
    const leftovers = fs.readdirSync(testDir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('surfaces write errors through the callback', async () => {
    // A path whose parent is a file, not a directory — mkdir for the parent
    // will fail, surfacing through onError.
    const blocker = path.join(testDir, 'blocker')
    fs.writeFileSync(blocker, 'not a dir')
    const target = path.join(blocker, 'nested', 'x.json')

    // The synchronous mkdir failure (mkdir over a file) must be routed through
    // onError, never thrown out of the fire-and-forget call.
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      atomicWriteFile(target, '{}', resolve)
    })

    expect(err).toBeInstanceOf(Error)
  })
})
