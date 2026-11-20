/**
 * browser-bridge — bridge a DSH tool call to a web AI chat page in the user's
 * already-running Chrome (attached over CDP), so the model can drive a chat
 * window the user has opened and logged into manually.
 *
 * @module @local/dsh-browser-bridge
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { chromium, } from 'playwright-core';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge';
/** Services required by this plugin. */
export const inject = ['tools'];
/** Tool name exposed to the model. */
export const TOOL_NAME = 'browser_bridge';
/** Message shown when the CDP endpoint is unreachable. */
export const CONNECT_HELP = `无法通过 CDP 连接到 Chrome。请先通过命令行启动 Chrome 并添加参数 --remote-debugging-port=9222，然后手动登录 AI 网页账号。` +
    `\n示例（Windows）："C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\chrome-ai-profile"`;
/** Candidate chat-input selectors, in priority order. */
export const INPUT_SELECTORS = [
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]',
];
/** Candidate send-button selectors, in priority order. */
export const SEND_SELECTORS = [
    '[data-testid="send-button"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[title*="发送"]',
    'button[title*="Send"]',
    'button:has-text("发送")',
];
/** Candidate reply-container groups, in priority order (innermost match wins). */
export const REPLY_SELECTORS = [
    '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]',
    '.markdown, .prose',
    '[data-response-body]',
    '[class*="message"]',
];
/** Selectors that mark content as the user's own message rather than a reply. */
export const USER_MESSAGE_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-markdown-text-style="user-message"]',
    '[data-user-message-bubble]',
];
/** Selectors for a visible "stop generating" control. */
export const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    '[data-testid="composer-stop-button"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
];
/**
 * Built-in selector profiles for widely used web AI chat pages. Only the
 * ChatGPT profile is verified end to end; the others are best-effort defaults
 * that can be adjusted through the `sites` configuration.
 */
export const BUILTIN_SITES = {
    'chatgpt.com': {
        input: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror'],
        send: ['[data-testid="send-button"]'],
        reply: ['[data-markdown-text-style="assistant-message"]'],
        user: ['[data-user-message-bubble]', '[data-markdown-text-style="user-message"]'],
        stop: ['[data-testid="stop-button"]'],
    },
    'claude.ai': {
        input: ['div[contenteditable="true"].ProseMirror'],
        send: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]'],
        reply: ['.font-claude-message', '.prose'],
        user: ['[data-testid="user-message"]'],
        stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'],
    },
    'gemini.google.com': {
        input: ['rich-textarea .ql-editor[contenteditable="true"]', 'div[contenteditable="true"]'],
        send: ['button[aria-label*="Send message"]', 'button.send-button'],
        reply: ['model-response message-content', '.model-response-text', 'message-content'],
        user: ['user-query', '.user-query-text'],
        stop: ['button[aria-label*="Stop response"]'],
    },
    'chat.deepseek.com': {
        input: ['textarea', 'div[contenteditable="true"]'],
        send: ['button[type="submit"]', 'div[role="button"][aria-disabled="false"]'],
        reply: ['.ds-markdown', '.markdown'],
        user: ['[class*="message"][class*="user"]'],
        stop: ['div[role="button"][aria-label*="停止"]', 'button[aria-label*="停止"]'],
    },
    'chat.kimi.com': {
        input: ['div[contenteditable="true"]', 'textarea'],
        send: ['button[class*="send"]', 'button[aria-label*="发送"]'],
        reply: ['.markdown', '[class*="message"][class*="assistant"]'],
        user: ['[class*="message"][class*="user"]'],
        stop: ['button[aria-label*="停止"]'],
    },
    'doubao.com': {
        input: ['textarea', 'div[contenteditable="true"]'],
        send: ['button[class*="send"]', 'button[aria-label*="发送"]'],
        reply: ['[class*="markdown"]', '[class*="message"][class*="assistant"]'],
        user: ['[class*="message"][class*="user"]'],
        stop: ['button[aria-label*="停止"]'],
    },
};
/** Match a hostname against a selector map, preferring the longest suffix. */
function matchSite(map, hostname) {
    const host = hostname.toLowerCase();
    let bestKey = '';
    let best;
    for (const [key, value] of Object.entries(map)) {
        const site = key.toLowerCase();
        if ((host === site || host.endsWith(`.${site}`)) && site.length > bestKey.length) {
            bestKey = site;
            best = value;
        }
    }
    return best;
}
/** Append every list, keeping the first occurrence of each selector. */
function mergeSelectors(...lists) {
    const merged = [];
    for (const list of lists) {
        for (const selector of list ?? []) {
            if (!merged.includes(selector))
                merged.push(selector);
        }
    }
    return merged;
}
/**
 * Resolve the selector lists for one page: built-in profile first, then the
 * user's `sites` overrides, then the generic defaults as a fallback.
 *
 * Exported for tests.
 */
export function resolveSiteSelectors(target, sites = {}) {
    let hostname = target;
    try {
        hostname = new URL(target).hostname;
    }
    catch {
        /* target is already a hostname */
    }
    const builtin = matchSite(BUILTIN_SITES, hostname);
    const custom = matchSite(sites, hostname);
    return {
        input: mergeSelectors(builtin?.input, custom?.input, INPUT_SELECTORS),
        send: mergeSelectors(builtin?.send, custom?.send, SEND_SELECTORS),
        reply: mergeSelectors(builtin?.reply, custom?.reply, REPLY_SELECTORS),
        user: mergeSelectors(builtin?.user, custom?.user, USER_MESSAGE_SELECTORS),
        stop: mergeSelectors(builtin?.stop, custom?.stop, STOP_SELECTORS),
    };
}
/** Default CDP endpoint of a manually started Chrome. */
const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
/** Delay after sending before the first reply-length probe. */
const DEFAULT_FIRST_WAIT_MS = 2_000;
/** Delay between reply-length probes. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Consecutive unchanged probes that mark generation as finished. */
const DEFAULT_STABLE_CHECKS = 3;
/** Upper bound on one bridge call. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** Upper bound on locating the input and the send button. */
const ELEMENT_WAIT_MS = 10_000;
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
/** Sleep without assuming a page is available. */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** Resolve after `promise` settles or `ms` elapses, never rejecting. */
async function settleWithin(promise, ms, fallback) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    resolve(fallback);
                }, ms);
            }),
        ]);
    }
    catch {
        return fallback;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** Serialize calls so two tool invocations never drive the same tab at once. */
let bridgeQueue = Promise.resolve();
/** Run `task` after every previously queued bridge task settles. */
function exclusive(task) {
    const run = bridgeQueue.then(task, task);
    bridgeQueue = run.then(() => undefined, () => undefined);
    return run;
}
/** Normalize a configured number, falling back to its default. */
function positiveNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Normalize configuration from the patch row. */
export function resolveOptions(config = {}) {
    const endpoint = typeof config.cdpEndpoint === 'string' && config.cdpEndpoint.trim() !== ''
        ? config.cdpEndpoint.trim()
        : DEFAULT_CDP_ENDPOINT;
    return {
        cdpEndpoint: endpoint,
        firstWaitMs: positiveNumber(config.firstWaitMs, DEFAULT_FIRST_WAIT_MS),
        pollIntervalMs: positiveNumber(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
        stableChecks: Math.max(1, Math.floor(positiveNumber(config.stableChecks, DEFAULT_STABLE_CHECKS))),
        timeoutMs: positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS),
        sites: config.sites ?? {},
    };
}
/** URL without its hash, so `#fragment` differences do not break matching. */
function withoutHash(raw) {
    const index = raw.indexOf('#');
    return index === -1 ? raw : raw.slice(0, index);
}
/** Requested page URL as an absolute URL, or undefined when it cannot be parsed. */
function parseUrl(raw) {
    try {
        return new URL(raw);
    }
    catch {
        return undefined;
    }
}
/** Host:port of a URL, or undefined when it cannot be parsed. */
function originKey(raw) {
    const parsed = parseUrl(raw);
    return parsed === undefined ? undefined : `${parsed.protocol}//${parsed.host}`;
}
/** Find the first visible match across `selectors`, without waiting. */
async function findVisible(page, selectors) {
    for (const selector of selectors) {
        const matches = page.locator(selector);
        const count = await matches.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const locator = matches.nth(index);
            if (await locator.isVisible().catch(() => false))
                return { locator, selector };
        }
    }
    return undefined;
}
/** Poll for the first visible match until `timeoutMs` elapses. */
async function waitForVisible(page, selectors, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = await findVisible(page, selectors);
        if (found !== undefined)
            return found;
        await sleep(250);
    }
    return undefined;
}
/** Find a visible, enabled send button, waiting briefly for a disabled one to enable. */
async function findSendButton(page, selectors) {
    const deadline = Date.now() + ELEMENT_WAIT_MS;
    while (Date.now() < deadline) {
        for (const selector of selectors) {
            const matches = page.locator(selector);
            const count = await matches.count().catch(() => 0);
            for (let index = 0; index < count; index += 1) {
                const locator = matches.nth(index);
                if (!(await locator.isVisible().catch(() => false)))
                    continue;
                const enabled = await locator.isEnabled().catch(() => true);
                if (enabled)
                    return { locator, selector };
            }
        }
        await sleep(200);
    }
    return undefined;
}
/** Current text of a textarea, input, or contenteditable element. */
async function readInputText(input) {
    return input
        .evaluate((element) => {
        const control = element;
        if (typeof control.value === 'string')
            return control.value;
        return element.innerText ?? '';
    })
        .catch(() => '');
}
/** Type `prompt` into the chat input, using a DOM fallback for exotic editors. */
async function enterPrompt(page, input, prompt, inputSelectors) {
    await input.click().catch(() => { });
    await input.fill(prompt).catch(async () => {
        await page.keyboard.insertText(prompt).catch(() => { });
    });
    let text = await readInputText(input);
    if (text.trim() === '') {
        await input.click().catch(() => { });
        await page.keyboard.insertText(prompt).catch(() => { });
        text = await readInputText(input);
    }
    if (text.trim() === '') {
        await input
            .evaluate((element, value) => {
            element.focus();
            document.execCommand('insertText', false, value);
        }, prompt)
            .catch(() => { });
        text = await readInputText(input);
    }
    if (text.trim() === '') {
        throw new Error(`browser_bridge 找到输入框但无法写入内容。\n页面 URL: ${page.url()}\n` +
            `输入框选择器: ${inputSelectors.join(', ')}\n` +
            `请确认页面已加载完成、输入框未处于只读或禁用状态。`);
    }
}
/** Click the send button, or press Enter when no button is available. */
async function triggerSend(page, sendSelectors) {
    const button = await findSendButton(page, sendSelectors);
    if (button !== undefined) {
        await button.locator.click({ timeout: 5_000 });
        return `clicked ${button.selector}`;
    }
    await page.keyboard.press('Enter');
    return 'pressed Enter';
}
/**
 * Read the last reply container: try each selector group in priority order,
 * drop the user's own bubbles and any echo of the prompt, keep the innermost
 * visible nodes, and take the last one, which is the message being generated.
 *
 * Selector groups and user markers come from the resolved site profile, so a
 * different provider can add or replace them through configuration.
 */
function readReplySnapshot(page, prompt, replyGroups, userMarkers) {
    const groups = [...replyGroups];
    const markers = [...userMarkers];
    return page.evaluate(({ groups: groupList, userMarkers: markerList, sentPrompt }) => {
        const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const isUserSide = (element) => markerList.some((marker) => element.closest(marker) !== null) ||
            /user-message/.test(String(element.className ?? ''));
        for (const selector of groupList) {
            const candidates = Array.from(document.querySelectorAll(selector))
                .filter((element) => isVisible(element))
                .filter((element) => !isUserSide(element))
                .filter((element) => element.innerText.trim() !== sentPrompt);
            if (candidates.length === 0)
                continue;
            const innermost = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
            const last = innermost[innermost.length - 1];
            return { count: innermost.length, text: last === undefined ? '' : last.innerText };
        }
        return { count: 0, text: '' };
    }, { groups, userMarkers: markers, sentPrompt: prompt });
}
/** Whether a "stop generating" control is visible right now. */
function isGenerating(page, stopSelectors) {
    return page
        .evaluate((selectors) => {
        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                const rect = element.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0)
                    return true;
            }
        }
        return false;
    }, [...stopSelectors])
        .catch(() => false);
}
/** Describe the reply area for diagnostics. */
function describeReplySnapshot(snapshot) {
    return `回复容器数量=${snapshot.count}，最后容器文本长度=${snapshot.text.trim().length}`;
}
/**
 * Wait until the streamed answer stops changing: the first probe delivers
 * `firstWaitMs`, then every `pollIntervalMs` the reply length is compared, and
 * `stableChecks` consecutive identical probes end the wait.
 */
async function waitForReply(page, baseline, prompt, options, selectors, signal) {
    const startedAt = Date.now();
    await page.waitForTimeout(options.firstWaitMs);
    let started = false;
    let previous = '';
    let stable = 0;
    let lastSnapshot = baseline;
    for (;;) {
        if (signal?.aborted === true)
            throw new Error('browser_bridge 已被取消。');
        if (Date.now() - startedAt > options.timeoutMs) {
            throw new Error(`browser_bridge 等待 AI 回复超时（${Math.round(options.timeoutMs / 1000)}s）。\n` +
                `页面 URL: ${page.url()}\n` +
                `最后一次检测: ${describeReplySnapshot(lastSnapshot)}\n` +
                `已尝试选择器: ${selectors.reply.join(', ')}`);
        }
        const snapshot = await readReplySnapshot(page, prompt, selectors.reply, selectors.user).catch(() => lastSnapshot);
        lastSnapshot = snapshot;
        const current = snapshot.text.trim();
        const generating = await isGenerating(page, selectors.stop);
        if (!started) {
            if (snapshot.count !== baseline.count || current !== baseline.text.trim()) {
                started = true;
                previous = current;
                stable = 0;
            }
        }
        else if (current === previous) {
            // An empty answer or a visible stop control means "still working": keep waiting.
            stable = current === '' || generating || current === prompt ? 0 : stable + 1;
            if (stable >= options.stableChecks)
                return current;
        }
        else {
            previous = current;
            stable = 0;
        }
        await page.waitForTimeout(options.pollIntervalMs);
    }
}
// ---------------------------------------------------------------------------
// Browser connection
// ---------------------------------------------------------------------------
/** Connect to the user's Chrome over CDP, keeping the existing session and logins. */
async function connectBrowser(endpoint) {
    try {
        return await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`browser_bridge: ${CONNECT_HELP}\nCDP 端点: ${endpoint}\n原始错误: ${detail}`);
    }
}
/** Cached CDP connection so tabs created by one call survive into the next. */
let cachedConnection;
/** Reuse the live CDP connection, reconnecting when Chrome restarted or closed. */
async function acquireBrowser(endpoint) {
    const cached = cachedConnection;
    if (cached !== undefined && cached.endpoint === endpoint) {
        if (cached.browser.isConnected()) {
            try {
                cached.browser.contexts();
                return cached.browser;
            }
            catch {
                /* the socket is gone; fall through and reconnect */
            }
        }
        await cached.browser.close().catch(() => { });
        cachedConnection = undefined;
    }
    const browser = await connectBrowser(endpoint);
    cachedConnection = { endpoint, browser };
    return browser;
}
/** Disconnect the cached CDP session; the user's Chrome keeps running. */
export async function disconnectBrowser() {
    const cached = cachedConnection;
    cachedConnection = undefined;
    if (cached !== undefined)
        await cached.browser.close().catch(() => { });
}
/** Whether a page reports itself as the visible tab. */
async function pageIsVisible(page) {
    return settleWithin(page.evaluate(() => document.visibilityState === 'visible'), 1_000, false);
}
/**
 * Pick the page to drive: the matching tab for `url` (navigating a same-origin
 * tab or opening a new tab when needed), else the visible tab, else the newest
 * non-blank tab.
 */
async function resolvePage(context, url) {
    const pages = context.pages().filter((page) => !page.isClosed());
    if (url !== undefined && url.trim() !== '') {
        const requested = url.trim();
        const target = withoutHash(requested);
        const exact = pages.find((page) => withoutHash(page.url()) === target);
        if (exact !== undefined)
            return exact;
        const origin = originKey(target);
        if (origin !== undefined) {
            const sameOrigin = pages.find((page) => originKey(page.url()) === origin);
            if (sameOrigin !== undefined) {
                await sameOrigin.goto(requested, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                return sameOrigin;
            }
        }
        const blank = pages.find((page) => page.url() === 'about:blank');
        const reusable = blank ?? (await context.newPage());
        await reusable.goto(requested, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return reusable;
    }
    if (pages.length === 0) {
        throw new Error('browser_bridge 已连接到 Chrome，但没有可用的标签页。\n' +
            '请先在 Chrome 中打开并登录 AI 网页对话窗口，或通过 url 参数指定对话页面。');
    }
    for (const page of [...pages].reverse()) {
        if (await pageIsVisible(page))
            return page;
    }
    const contentPages = pages.filter((page) => page.url() !== 'about:blank');
    return contentPages[contentPages.length - 1] ?? pages[pages.length - 1];
}
/** Diagnostic text for a missing element. */
async function missingElementError(kind, page, selectors) {
    const title = await settleWithin(page.title(), 1_000, '(unknown)');
    return new Error(`browser_bridge 在页面上找不到${kind}。\n` +
        `页面 URL: ${page.url()}\n` +
        `页面标题: ${title}\n` +
        `已尝试选择器: ${selectors.join(', ')}\n` +
        `请确认该标签页是需要对话的 AI 网页，页面已加载完成且已登录；也可用 url 参数指定页面。`);
}
// ---------------------------------------------------------------------------
// Bridge flow
// ---------------------------------------------------------------------------
/**
 * Run one full bridge round-trip against the user's Chrome:
 * connect → pick page → type prompt → send → wait for the stream to settle →
 * return the reply text.
 *
 * Exported for integration tests; the tool uses it through `execute`.
 */
export async function runBridge(args, options, signal) {
    const prompt = args.prompt.trim();
    if (prompt === '')
        throw new Error('browser_bridge: prompt 不能为空。');
    const browser = await acquireBrowser(options.cdpEndpoint);
    const context = browser.contexts()[0];
    if (context === undefined) {
        throw new Error('browser_bridge 已连接到 Chrome，但没有可用的浏览器上下文（contexts()[0] 为空）。');
    }
    const page = await resolvePage(context, args.url);
    if (signal?.aborted === true)
        throw new Error('browser_bridge 已被取消。');
    // Selectors depend on the provider that hosts the chosen tab.
    const selectors = resolveSiteSelectors(page.url(), options.sites);
    const input = await waitForVisible(page, selectors.input, ELEMENT_WAIT_MS);
    if (input === undefined)
        throw await missingElementError('输入框', page, selectors.input);
    const baseline = await readReplySnapshot(page, prompt, selectors.reply, selectors.user).catch(() => ({ count: 0, text: '' }));
    await enterPrompt(page, input.locator, prompt, selectors.input);
    await triggerSend(page, selectors.send);
    const reply = await waitForReply(page, baseline, prompt, options, selectors, signal);
    if (reply === '' || reply === prompt) {
        throw await missingElementError('回复内容', page, selectors.reply);
    }
    return reply;
}
// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
/**
 * Register the `browser_bridge` tool. Environment facts (endpoint, timings) come
 * from the bundle patch row; the tool's per-call arguments stay limited to the
 * prompt and the optional conversation page.
 */
export function apply(ctx, config = {}) {
    const options = resolveOptions(config);
    // Drop the cached CDP session when the plugin unloads; the user's Chrome keeps running.
    ctx.effect(() => () => {
        void disconnectBrowser();
    });
    ctx.tools.register(defineTool({
        name: TOOL_NAME,
        description: 'Send a prompt to a web AI chat page (ChatGPT, Claude, Kimi, etc.) open in the user\'s already-running Chrome and return the complete reply text. ' +
            'Reuses the existing browser session and login instead of launching a new browser, so the browser must already listen on the CDP endpoint and show a chat page. ' +
            'The tool types the prompt, triggers send, waits for streaming output to stop, and returns the reply as plain text.',
        parameters: {
            prompt: {
                type: 'string',
                required: true,
                description: 'Text to type into the chat input and send to the web AI.',
            },
            url: {
                type: 'string',
                description: 'Conversation page URL to drive. When omitted, the currently visible tab is used. Set it to pin a specific chat tab.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            return exclusive(() => runBridge(args, options, exec.signal));
        },
    }));
}
