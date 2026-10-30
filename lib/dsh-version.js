/**
 * Which DSH release is hosting this plugin.
 *
 * Switching this computer's DSH window onto another computer's DSH reuses this computer's UI against
 * the other computer's API, so both must be the same release. The Host process is started from inside
 * the DSH installation (the desktop app spawns `<runtime>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`
 * with the runtime directory as its first argument; the CLI runs from the `@deepseek-ai/dsh` package),
 * so walking up from the start-up arguments finds the installed `@deepseek-ai/dsh/package.json`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PACKAGE = '@deepseek-ai/dsh'

function versionAt(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    return manifest && manifest.name === PACKAGE && typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * @returns the installed `@deepseek-ai/dsh` version, or undefined when it cannot be found.
 */
export function detectDshVersion({ argv = process.argv, execPath = process.execPath } = {}) {
  const starts = [argv[2], argv[1], execPath].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 14; depth += 1) {
      const found = versionAt(join(dir, 'package.json')) ?? versionAt(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      if (found !== undefined) return found
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}
