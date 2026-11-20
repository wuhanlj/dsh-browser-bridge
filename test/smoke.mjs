/**
 * End-to-end smoke test for the browser bridge.
 *
 * Starts a headless Chrome with a remote debugging port whose first tab already
 * shows a fake AI chat page (the "manually opened, logged-in" tab), serves that
 * page from two origins, then drives it through the real `runBridge`:
 *   1. tool registration through `apply()`
 *   2. exact-tab reuse via `url` (contenteditable + aria-label send + `.markdown`)
 *   3. same-origin tab navigation (textarea + `data-testid` send + `.prose`)
 *   4. active-tab selection when `url` is omitted
 *   5. new-tab creation for a different origin
 *   6. ChatGPT's redesigned DOM (`data-markdown-text-style` answer root, delayed
 *      stream start, user bubble that also matches `[class*="message"]`)
 *   7. built-in per-provider selector profiles and custom `sites` overrides
 *      (selector resolution + a provider whose DOM only the config knows)
 *   8. unreachable CDP endpoint error message
 *
 * Run with `npm run smoke` (needs Chrome or Edge; no Playwright browsers).
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONNECT_HELP,
  TOOL_NAME,
  apply,
  cleanReplyText,
  disconnectBrowser,
  resolveOptions,
  resolveSiteSelectors,
  runBridge,
} from '../lib/index.js'

const CDP_PORT = 9333
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((candidate) => typeof candidate === 'string')

const OPTIONS = resolveOptions({
  cdpEndpoint: CDP_ENDPOINT,
  firstWaitMs: 200,
  pollIntervalMs: 200,
  stableChecks: 3,
  timeoutMs: 30_000,
})

const EXPECTED_SUFFIX = 'the quick brown fox jumps over the lazy dog.'

let chromeProcess
let userDataDir
const servers = []
let baseUrlA
let baseUrlB

function log(message) {
  console.log(`[smoke] ${message}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForCdp(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP_ENDPOINT}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* not listening yet */
    }
    await sleep(200)
  }
  throw new Error(`Chrome did not expose CDP on ${CDP_ENDPOINT} within ${timeoutMs}ms`)
}

async function cdpTargets() {
  const response = await fetch(`${CDP_ENDPOINT}/json/list`)
  return response.json()
}

async function openTargetUrls() {
  const targets = await cdpTargets()
  return targets.filter((target) => target.type === 'page').map((target) => target.url)
}

async function startServer() {
  const markup = await readFile(fileURLToPath(new URL('./fixture.html', import.meta.url)), 'utf8')
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(markup)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}/`
}

async function startChrome(startUrl) {
  userDataDir = await mkdtemp(join(tmpdir(), 'dsh-bridge-smoke-'))
  const executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (executable === undefined) throw new Error('No Chrome/Edge executable found; set CHROME_PATH')

  chromeProcess = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      startUrl,
    ],
    { stdio: 'ignore' },
  )
  chromeProcess.on('error', (error) => log(`chrome spawn error: ${error.message}`))
  await waitForCdp()
  log(`chrome ready on ${CDP_ENDPOINT}`)
}

async function stopChrome() {
  if (chromeProcess?.pid !== undefined) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(chromeProcess.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
      killer.on('close', resolve)
      killer.on('error', resolve)
    })
    chromeProcess = undefined
  }
  if (userDataDir !== undefined) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    userDataDir = undefined
  }
}

function assertReply(reply, prompt) {
  assert.ok(reply.startsWith('ECHO:'), `reply should start with ECHO:, got: ${reply.slice(0, 80)}`)
  assert.ok(reply.includes(prompt), `reply should echo the prompt, got: ${reply.slice(0, 120)}`)
  assert.ok(reply.includes(EXPECTED_SUFFIX), 'reply should contain the streamed answer')
}

async function testRegistration() {
  let registered
  let disposed = false
  apply(
    {
      tools: {
        register: (definition) => {
          registered = definition
          return () => {}
        },
      },
      effect: (callback) => {
        callback()
        return () => {
          disposed = true
        }
      },
    },
    { cdpEndpoint: CDP_ENDPOINT },
  )
  assert.equal(registered?.name, TOOL_NAME)
  assert.equal(registered?.output.schema.type, 'string')
  assert.deepEqual(registered?.parameters.required, ['prompt'])
  assert.deepEqual(registered?.parameters.properties.url.type, 'string')
  assert.deepEqual(registered?.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }])
  assert.equal(typeof disposed, 'boolean')
  log('registration ok')
}

async function testExactTabReuse() {
  const url = `${baseUrlA}?mode=contenteditable`
  const prompt = 'first probe from the pre-opened tab'
  const reply = await runBridge({ prompt, url }, OPTIONS)
  assertReply(reply, prompt)
  const targets = await openTargetUrls()
  assert.ok(
    targets.some((target) => target.startsWith(`${baseUrlA}?mode=contenteditable`)),
    `pre-opened chat tab should still be open, got: ${targets.join(', ')}`,
  )
  log('exact tab reuse ok')
}

async function testSameOriginNavigation() {
  const url = `${baseUrlA}?mode=textarea`
  const prompt = 'second probe from the textarea page'
  const reply = await runBridge({ prompt, url }, OPTIONS)
  assertReply(reply, prompt)
  const targets = await openTargetUrls()
  assert.ok(
    targets.some((target) => target.startsWith(`${baseUrlA}?mode=textarea`)),
    `same-origin tab should navigate to the requested page, got: ${targets.join(', ')}`,
  )
  log('same-origin navigation ok')
}

async function testActiveTabFallback() {
  const prompt = 'third probe from the active tab'
  const reply = await runBridge({ prompt }, OPTIONS)
  assertReply(reply, prompt)
  log('active tab fallback ok')
}

async function testNewTabForOtherOrigin() {
  const url = `${baseUrlB}?mode=contenteditable`
  const prompt = 'fourth probe from another origin'
  const reply = await runBridge({ prompt, url }, OPTIONS)
  assertReply(reply, prompt)
  const targets = await openTargetUrls()
  assert.ok(
    targets.some((target) => target.startsWith(baseUrlB)),
    `a new tab should host the other-origin chat page, got: ${targets.join(', ')}`,
  )
  log('new tab for another origin ok')
}

async function testNewChatGptDom() {
  const url = `${baseUrlA}?mode=chatgpt`
  const prompt = 'fifth probe against the new ChatGPT DOM'
  const reply = await runBridge({ prompt, url }, OPTIONS)
  assertReply(reply, prompt)
  assert.notEqual(reply.trim(), prompt, 'must not return the echoed user message')
  log('new ChatGPT DOM (assistant-message) ok')
}

async function testSiteSelectorProfiles() {
  const chatgpt = resolveSiteSelectors('https://chatgpt.com/c/abc', {})
  assert.ok(chatgpt.reply[0].includes('[data-markdown-text-style="assistant-message"]'))
  assert.ok(chatgpt.input.includes('#prompt-textarea'))
  assert.ok(chatgpt.stop.includes('[data-testid="stop-button"]'))

  const claude = resolveSiteSelectors('https://claude.ai/chat/xyz', {})
  assert.ok(claude.reply.includes('.font-claude-message'))
  assert.ok(claude.stop.includes('button[aria-label="Stop response"]'))

  const gemini = resolveSiteSelectors('https://gemini.google.com/app/1', {})
  assert.ok(gemini.reply[0].startsWith('model-response'))

  const deepseek = resolveSiteSelectors('https://chat.deepseek.com/a/chat/s/1', {})
  // DeepSeek must not fall back to generic `.markdown` (reasoning blocks) rules.
  assert.deepEqual(deepseek.reply, ['[class*="ds-assistant-message-main-content"]'])
  assert.ok(deepseek.send.includes('div[role="button"].ds-button--primary:not(.ds-button--disabled)'))

  const muse = resolveSiteSelectors('https://muse.ai/', {})
  assert.equal(muse.reply[0], '[data-message-role="assistant"] .prose')
  assert.equal(muse.user[0], '[data-message-role="user"]')
  assert.ok(muse.send.includes('button[aria-label="发送"]'))
  // Muse declares an explicit empty stop list: generic stop detection is off.
  assert.deepEqual(muse.stop, [])

  const manus = resolveSiteSelectors('https://manus.im/app/QyReeyVP86vZuuMt5KydBY', {})
  assert.equal(manus.input[0], 'div.tiptap[contenteditable="true"]')
  assert.ok(manus.send.includes('button[class*="accent-send-button"]'))
  assert.equal(manus.reply[0], '[class*="latest-chat-reply"] [class*="chat-message-body"]')
  assert.equal(manus.user[0], '[data-chat-question-bubble="true"]')

  const qianwen = resolveSiteSelectors('https://www.qianwen.com/chat/abc123', {})
  assert.equal(qianwen.input[0], '[role="textbox"][contenteditable="true"]')
  assert.ok(qianwen.send.includes('button[aria-label="发送消息"]'))
  assert.equal(qianwen.reply[0], '[data-chat-answers-wrap] .qk-markdown')
  assert.equal(qianwen.user[0], '[data-chat-question-wrap]')
  assert.equal(qianwen.timeoutMs, 600_000)

  // Subdomain suffix matching.
  const subdomain = resolveSiteSelectors('https://www.chatgpt.com/x', {})
  assert.ok(subdomain.reply.includes('[data-markdown-text-style="assistant-message"]'))

  // User overrides run first and keep the generic fallbacks.
  const custom = resolveSiteSelectors('http://127.0.0.1:1234/?mode=custom', {
    '127.0.0.1': { reply: ['.custom-assistant-text'], user: ['.custom-user'] },
  })
  assert.equal(custom.reply[0], '.custom-assistant-text')
  assert.ok(custom.reply.includes('.markdown, .prose'))
  assert.equal(custom.user[0], '.custom-user')

  // Unknown hosts fall back to the generic lists only.
  const unknown = resolveSiteSelectors('https://example.com/', {})
  assert.equal(
    unknown.reply[0],
    '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]',
  )

  // A site can opt out of the generic reply fallback entirely.
  const noFallback = resolveSiteSelectors('http://127.0.0.1:1/', {
    '127.0.0.1': { reply: ['.only-answer'], genericFallback: false },
  })
  assert.deepEqual(noFallback.reply, ['.only-answer'])
  log('site selector profiles ok')
}

async function testReplyTextCleanup() {
  assert.equal(cleanReplyText('助手消息：你好'), '你好')
  assert.equal(cleanReplyText('用户消息：测试'), '测试')
  assert.equal(cleanReplyText('  Assistant: hello  '), 'hello')
  const messy = cleanReplyText('助手消息：助手消息：结果在这里 [[hatch_widget:widget-1]] 完成')
  assert.ok(!messy.includes('hatch_widget'), `widget tokens should be removed, got: ${messy}`)
  assert.ok(messy.startsWith('结果在这里'), `role labels should be stripped, got: ${messy}`)
  log('reply text cleanup ok')
}

async function testCustomSiteProfile() {
  const url = `${baseUrlA}?mode=custom`
  const prompt = 'sixth probe through a custom site profile'
  const options = {
    ...OPTIONS,
    sites: { '127.0.0.1': { reply: ['.custom-assistant-text'], user: ['.custom-user'] } },
  }
  const reply = await runBridge({ prompt, url }, options)
  assertReply(reply, prompt)
  log('custom site profile ok')
}

async function testConnectFailure() {
  const options = resolveOptions({ cdpEndpoint: 'http://127.0.0.1:1', timeoutMs: 5_000 })
  await assert.rejects(
    () => runBridge({ prompt: 'nope' }, options),
    (error) => {
      assert.ok(error.message.includes(CONNECT_HELP.split('\n')[0]))
      assert.ok(error.message.includes('--remote-debugging-port=9222'))
      return true
    },
  )
  log('connect failure message ok')
}

async function main() {
  baseUrlA = await startServer()
  baseUrlB = await startServer()
  log(`fixtures served at ${baseUrlA} and ${baseUrlB}`)
  await startChrome(`${baseUrlA}?mode=contenteditable`)

  await testRegistration()
  await testExactTabReuse()
  await testSameOriginNavigation()
  await testActiveTabFallback()
  await testNewTabForOtherOrigin()
  await testNewChatGptDom()
  await testSiteSelectorProfiles()
  await testReplyTextCleanup()
  await testCustomSiteProfile()
  await testConnectFailure()

  log('all smoke checks passed')
}

try {
  await main()
} finally {
  await disconnectBrowser().catch(() => {})
  await stopChrome()
  for (const server of servers) await new Promise((resolve) => server.close(resolve))
}
