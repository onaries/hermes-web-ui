import { describe, expect, it } from 'vitest'
import { buildToolInlineSummary } from '@/utils/tool-inline-summary'

const t = (key: string, params?: Record<string, unknown>) => {
  const templates: Record<string, string> = {
    'chat.toolSummary.query': 'Query: {value}',
    'chat.toolSummary.path': 'Path: {value}',
    'chat.toolSummary.url': 'URL: {value}',
    'chat.toolSummary.command': 'Command: {value}',
    'chat.toolSummary.pattern': 'Pattern: {value}',
    'chat.toolSummary.action': 'Action: {value}',
    'chat.toolSummary.items': '{count} items',
    'chat.toolSummary.urls': '{count} URLs',
    'chat.toolSummary.results': '{count} results',
    'chat.toolSummary.matches': '{count} matches',
    'chat.toolSummary.files': '{count} files',
    'chat.toolSummary.success': 'Success',
    'chat.toolSummary.failure': 'Failed',
    'chat.toolSummary.exitCode': 'Exit {code}',
    'chat.toolSummary.status': 'Status: {value}',
    'chat.toolSummary.output': 'Output: {value}',
    'chat.toolSummary.topResult': 'Top: {value}',
    'chat.toolSummary.code': 'Code: {value}',
    'chat.toolSummary.goal': 'Goal: {value}',
    'chat.toolSummary.tasks': '{count} tasks',
    'chat.toolSummary.text': 'Text: {value}',
    'chat.toolSummary.target': 'Target: {value}',
    'chat.toolSummary.key': 'Key: {value}',
    'chat.toolSummary.direction': 'Direction: {value}',
  }
  let out = templates[key] || key
  for (const [param, value] of Object.entries(params || {})) {
    out = out.replace(`{${param}}`, String(value))
  }
  return out
}

describe('buildToolInlineSummary', () => {
  it('shows web search queries without labels or result summaries', () => {
    const summary = buildToolInlineSummary(
      'web_search',
      { query: 'Hermes Studio updater signing' },
      { results: [{ title: 'Electron code signing guide' }, { title: 'Notarization' }] },
      undefined,
      t,
    )

    expect(summary).toBe('Hermes Studio updater signing')
  })

  it('shows Codex Web Search action queries', () => {
    const summary = buildToolInlineSummary(
      'Web Search',
      { query: '', action: { query: 'Hermes Studio web search display bug' } },
      undefined,
      '{"query":""}',
      t,
    )

    expect(summary).toBe('Hermes Studio web search display bug')
  })

  it('summarizes terminal commands as the command only', () => {
    const summary = buildToolInlineSummary(
      'terminal',
      { command: 'npm run harness:check' },
      { exit_code: 0, output: 'Harness check passed\nextra logs' },
      undefined,
      t,
    )

    expect(summary).toBe('npm run harness:check')
  })

  it('summarizes Codex Command tools as commands, never output previews', () => {
    expect(buildToolInlineSummary(
      'Command',
      { command: '/bin/zsh -lc "nl -ba generate_pkl_data_mtml.py"' },
      '     1\timport pickle\n     2\timport numpy as np',
      '     1 import pickle 2 import numpy',
      t,
    )).toBe('/bin/zsh -lc "nl -ba generate_pkl_data_mtml.py"')

    expect(buildToolInlineSummary(
      'Command',
      undefined,
      '     1\timport pickle\n     2\timport numpy as np',
      '     1 import pickle 2 import numpy',
      t,
    )).toBe('')
  })

  it('shows read/write/patch file paths without labels', () => {
    expect(buildToolInlineSummary(
      'read_file',
      { path: '/Users/safemotion/project/package.json' },
      { content: '{"name":"demo"}' },
      undefined,
      t,
    )).toBe('/Users/safemotion/project/package.json')

    expect(buildToolInlineSummary(
      'write_file',
      { path: '/Users/safemotion/project/README.md' },
      { bytes_written: 42 },
      undefined,
      t,
    )).toBe('/Users/safemotion/project/README.md')

    expect(buildToolInlineSummary(
      'patch',
      { mode: 'replace', path: '/Users/safemotion/project/src/App.vue' },
      { success: true },
      undefined,
      t,
    )).toBe('/Users/safemotion/project/src/App.vue')
  })

  it('shows skill_view skill names', () => {
    const summary = buildToolInlineSummary(
      'skill_view',
      { name: 'hermes-webui-maintenance' },
      { success: true, content: 'long skill content' },
      undefined,
      t,
    )

    expect(summary).toBe('hermes-webui-maintenance')
  })

  it('summarizes Codex file changes from changes arrays', () => {
    const summary = buildToolInlineSummary(
      'File Change',
      { changes: [{ path: 'src/App.vue', action: 'update' }, { path: 'README.md', action: 'add' }] },
      { status: 'completed' },
      undefined,
      t,
    )

    expect(summary).toBe('update src/App.vue, add README.md')
  })

  it('falls back to existing preview without exposing raw JSON braces', () => {
    const summary = buildToolInlineSummary(
      'custom_tool',
      undefined,
      undefined,
      'short preview text',
      t,
    )

    expect(summary).toBe('short preview text')
  })
})
