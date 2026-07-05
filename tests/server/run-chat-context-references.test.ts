import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandBridgeContextReferences } from '../../packages/server/src/services/hermes/run-chat/context-references'

let tempDir = ''

describe('run chat context references', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hermes-context-refs-'))
    await mkdir(join(tempDir, 'src'), { recursive: true })
  })

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('expands file line ranges and folder listings into attached context', async () => {
    await writeFile(join(tempDir, 'src', 'main.ts'), 'line1\nline2\nline3\n', 'utf8')
    await writeFile(join(tempDir, 'src', 'helper.ts'), 'export const helper = true\n', 'utf8')

    const result = await expandBridgeContextReferences(
      'Review @file:src/main.ts:1-2 and @folder:src',
      { cwd: tempDir },
    )

    expect(result.blocked).toBe(false)
    expect(result.expanded).toBe(true)
    expect(result.message).toContain('--- Attached Context ---')
    expect(result.message).toContain('### File: src/main.ts:1-2')
    expect(result.message).toContain('line1\nline2')
    expect(result.message).not.toContain('line3')
    expect(result.message).toContain('### Folder: src')
    expect(result.message).toContain('main.ts')
    expect(result.message).toContain('helper.ts')
  })

  it('supports quoted file paths with line ranges', async () => {
    await writeFile(join(tempDir, 'src', 'file with spaces.ts'), 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await expandBridgeContextReferences(
      'Read @file:"src/file with spaces.ts":2-2',
      { cwd: tempDir },
    )

    expect(result.expanded).toBe(true)
    expect(result.message).toContain('### File: src/file with spaces.ts:2-2')
    expect(result.message).toContain('beta')
    expect(result.message).not.toContain('alpha')
    expect(result.message).not.toContain('gamma')
  })

  it('blocks references outside the workspace without inlining them', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'hermes-context-outside-'))
    await writeFile(join(outsideDir, 'secret.txt'), 'outside-content-marker\n', 'utf8')

    try {
      const result = await expandBridgeContextReferences(
        `Read @file:${join(outsideDir, 'secret.txt')}`,
        { cwd: tempDir },
      )

      expect(result.expanded).toBe(true)
      expect(result.message).toContain('failed to expand')
      expect(result.message).not.toContain('outside-content-marker')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('does not inline sensitive files', async () => {
    await writeFile(join(tempDir, '.env'), 'TOKEN=secret\n', 'utf8')

    const result = await expandBridgeContextReferences('Read @file:.env', { cwd: tempDir })

    expect(result.expanded).toBe(true)
    expect(result.message).toContain('Sensitive file reference is blocked')
    expect(result.message).not.toContain('TOKEN=secret')
  })
})
