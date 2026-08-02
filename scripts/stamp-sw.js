/**
 * Stamps a unique build id into the exported service worker so each
 * deploy gets a fresh cache name and installed PWAs update cleanly.
 */
const fs = require('fs')
const path = require('path')

const PLACEHOLDER = '__BUILD_ID__'
const version = (
  process.env.GITHUB_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  ''
).slice(0, 7) || `local-${Date.now().toString(36)}`

const candidates = [
  path.join(process.cwd(), 'out', 'sw.js'),
  // standalone / custom server copies public → .next sometimes; prefer out for GH Pages
]

let stamped = false
for (const file of candidates) {
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  if (!src.includes(PLACEHOLDER)) {
    console.log(`[stamp-sw] ${path.relative(process.cwd(), file)} already stamped or missing placeholder`)
    continue
  }
  fs.writeFileSync(file, src.split(PLACEHOLDER).join(version), 'utf8')
  const versionFile = path.join(path.dirname(file), 'build-id.txt')
  fs.writeFileSync(versionFile, version + '\n', 'utf8')
  console.log(`[stamp-sw] ${path.relative(process.cwd(), file)} → bookshelf-${version}`)
  stamped = true
}

if (!stamped) {
  // Not an export build (e.g. local `next build` without GITHUB_PAGES) — that's fine.
  if (process.env.GITHUB_PAGES === 'true') {
    console.error('[stamp-sw] ERROR: out/sw.js not found after GitHub Pages build')
    process.exit(1)
  } else {
    console.log('[stamp-sw] skipped (no out/sw.js — not a static export build)')
  }
}
