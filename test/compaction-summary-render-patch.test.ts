import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

/**
 * Jev compaction checkpoints are verbatim transcript excerpts, so the chat
 * expander must show them as plain text instead of running them through the
 * Markdown renderer. The change lives in the dsh-client-ui-chat patch; check
 * both the recorded patch and the replayed install so a Harness upgrade that
 * renames the patch cannot silently drop it.
 */
describe('compaction summary render patch', () => {
  it('records the plain-text expander in the ui-chat patch', async () => {
    const patch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-chat'), 'utf8')
    expect(patch).toContain('-\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {\n-\t\t\t\t\t\ttext: node.summary,')
    expect(patch).toContain('+\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("pre", {')
    expect(patch).toContain('+\t\t\t\t\t\tchildren: node.summary')
  })

  it('renders the replayed compaction body as a pre element', async () => {
    const client = await readFile(
      path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js'),
      'utf8'
    )
    const start = client.indexOf('className: MessageItem_module_css_default.compactionBody,')
    expect(start).toBeGreaterThan(-1)
    const body = client.slice(start, start + 400)
    expect(body).toContain('(0, react_jsx_runtime.jsx)("pre", {')
    expect(body).toContain('children: node.summary')
    expect(body).not.toContain('MarkdownText')
  })
})
