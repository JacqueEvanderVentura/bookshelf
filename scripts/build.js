/**
 * Run `next build`, parking Node-only API routes when GITHUB_PAGES=true
 * so static export succeeds. Always restores those folders afterward.
 */
const { spawnSync } = require('child_process')
const { park, restore } = require('./export-api-routes')

park()
let status = 1
try {
  const result = spawnSync('npx', ['next', 'build'], {
    stdio: 'inherit',
    shell: true,
    env: process.env,
    cwd: require('path').join(__dirname, '..'),
  })
  status = result.status == null ? 1 : result.status
} finally {
  restore()
}
process.exit(status)
