const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const API_DIR = path.join(ROOT, 'app', 'api')
const PARK_DIR = path.join(ROOT, '.export-skip')

/** Route folders that require a Node server — incompatible with `output: 'export'`. */
const SKIP_ROUTES = ['gutenberg-search', 'proxy-epub']

function park() {
  if (process.env.GITHUB_PAGES !== 'true') return
  fs.mkdirSync(PARK_DIR, { recursive: true })
  for (const name of SKIP_ROUTES) {
    const from = path.join(API_DIR, name)
    const to = path.join(PARK_DIR, name)
    if (!fs.existsSync(from)) continue
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
    fs.renameSync(from, to)
    console.log(`[export] parked app/api/${name} (not available on static GH Pages)`)
  }
}

function restore() {
  if (!fs.existsSync(PARK_DIR)) return
  for (const name of SKIP_ROUTES) {
    const from = path.join(PARK_DIR, name)
    const to = path.join(API_DIR, name)
    if (!fs.existsSync(from)) continue
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
    fs.renameSync(from, to)
    console.log(`[export] restored app/api/${name}`)
  }
  try {
    fs.rmdirSync(PARK_DIR)
  } catch {
    /* may still have files */
  }
}

module.exports = { park, restore, SKIP_ROUTES, PARK_DIR }
