/**
 * Live verification environment: serves the fake chat page and starts a headless
 * Chrome with the remote debugging port the installed plugin is configured for
 * (http://127.0.0.1:9222). Keeps running until killed.
 *
 * Used to exercise the installed `browser_bridge` tool through a real DSH call.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CDP_PORT = 9222

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => typeof candidate === 'string')

const markup = await readFile(new URL('./fixture.html', import.meta.url), 'utf8')
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(markup)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const baseUrl = `http://127.0.0.1:${server.address().port}/`
const fixtureUrl = `${baseUrl}?mode=contenteditable`
const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-bridge-live-'))
const executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (executable === undefined) throw new Error('No Chrome/Edge executable found; set CHROME_PATH')

const chrome = spawn(
  executable,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    fixtureUrl,
  ],
  { stdio: 'ignore' },
)

const deadline = Date.now() + 20_000
let ready = false
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
    if (response.ok) {
      ready = true
      break
    }
  } catch {
    /* not listening yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!ready) throw new Error(`Chrome did not expose CDP on port ${CDP_PORT}`)

console.log(JSON.stringify({ fixtureUrl, chromePid: chrome.pid, userDataDir, serverPort: server.address().port }))
console.log('LIVE-ENV-READY')
setInterval(() => {}, 60_000)
