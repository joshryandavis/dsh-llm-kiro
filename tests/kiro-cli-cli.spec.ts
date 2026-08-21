/**
 * The sqlite3-CLI fallback paths of the kiro-cli store. The database path
 * points at a directory: node:sqlite fails to open it and the fallback CLI
 * (mocked) takes over, so the engine-throws branch is exercised without
 * module-level mocking.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execKiroCliDb, queryKiroCliDb } from '../src/kiro-cli.ts'

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execSync: execSyncMock }))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

async function fixtureDirPath(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'llm-kiro-cli-'))
  const dirPath = join(root, 'data.sqlite3')
  // A directory named like the database exists but cannot be opened by sqlite.
  await mkdir(dirPath)
  return dirPath
}

describe('llm-kiro kiro-cli sqlite3-CLI fallback', () => {
  it('queries through the sqlite3 CLI when node:sqlite cannot open the store', async () => {
    const dirPath = await fixtureDirPath()
    execSyncMock.mockReturnValue(JSON.stringify([{ value: JSON.stringify({ access_token: 'cli-access' }) }]))
    expect(queryKiroCliDb(dirPath, 'SELECT 1')).toBeDefined()
    expect(execSyncMock).toHaveBeenCalledOnce()
  })

  it('executes writes through the sqlite3 CLI', async () => {
    const dirPath = await fixtureDirPath()
    execSyncMock.mockReturnValue('')
    expect(execKiroCliDb(dirPath, 'UPDATE auth_kv SET value = value;')).toBe(true)
    expect(execSyncMock).toHaveBeenCalledOnce()
  })

  it('returns undefined/false when the CLI also fails', async () => {
    const dirPath = await fixtureDirPath()
    execSyncMock.mockImplementation(() => {
      throw new Error('sqlite3 not installed')
    })
    expect(queryKiroCliDb(dirPath, 'SELECT 1')).toBeUndefined()
    expect(execKiroCliDb(dirPath, 'SELECT 1')).toBe(false)
  })

  it('treats an empty CLI result as no rows', async () => {
    const dirPath = await fixtureDirPath()
    execSyncMock.mockReturnValue('[]' as never)
    expect(queryKiroCliDb(dirPath, 'SELECT 1')).toBeUndefined()
  })
})