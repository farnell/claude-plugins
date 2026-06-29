import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// __tests__ -> dev -> adversarial-review -> repo root
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const read = (p: string) => JSON.parse(readFileSync(resolve(repoRoot, p), 'utf8'))

// The two version fields are read independently by Claude Code's plugin
// installer (plugin.json) and marketplace catalog (marketplace.json). If they
// drift, `/plugin update` can show one version while installing another. The
// pre-push hook blocks an un-bumped push; this keeps the two equal at all times.
describe('manifest version sync', () => {
  it('plugin.json and marketplace.json declare the same version', () => {
    const plugin = read('adversarial-review/.claude-plugin/plugin.json')
    const catalog = read('.claude-plugin/marketplace.json')
    const entry = catalog.plugins.find((p: { name: string }) => p.name === 'adversarial-review')
    expect(entry, 'adversarial-review must be listed in marketplace.json').toBeTruthy()
    expect(plugin.version).toBe(entry.version)
  })

  it('version is semver-shaped', () => {
    const plugin = read('adversarial-review/.claude-plugin/plugin.json')
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
