# DSH Browser Bridge（`@local/dsh-browser-bridge`）

把 DSH 的一个 Tool 调用桥接到用户**已经手动启动并登录好**的 Chrome 中的网页版 AI 对话页面（ChatGPT / Claude / Kimi / DeepSeek 等）。

插件注册一个名为 `browser_bridge` 的 Tool：

1. 通过 CDP 连接 `http://127.0.0.1:9222` 的 Chrome，复用用户的登录态（不新开浏览器实例）；
2. 在指定会话页（或当前激活标签页）定位输入框，填入 `prompt` 并触发发送；
3. 每 2 秒检测一次回复区域文本长度，连续 3 次无变化即判定流式输出结束；
4. 提取最后一条回复的纯文本（`innerText`）并作为 Tool 返回值交给模型。

## 目录结构

```
package.json          # bundle 清单（dsh.bundle.patch + exports/files）
cordis.patch.yml      # Cordis patch：insert 插件行
src/index.ts          # 插件源码（函数形态 apply）
lib/                  # tsc 编译产物（安装时实际加载）
locale/en.json        # 插件显示名称/描述（英文）
locale/zh.json        # 插件显示名称/描述（中文）
icon.svg              # 插件图标
Start-Browser-Bridge.cmd      # 一键启动入口（双击/快捷方式指向它）
scripts/start-chrome.ps1      # 启动器：检测端口、复用实例、必要时启动 Chrome
scripts/stop-chrome.ps1       # 关闭桥接浏览器实例
scripts/install-shortcuts.ps1 # 创建桌面快捷方式 / 开机自启
test/fixture.html     # 冒烟测试用的假聊天页面
test/smoke.mjs        # 端到端冒烟测试（CDP + 输入 + 流式回复提取）
```

## 环境要求

- DSH Desktop（Host 侧插件），Node.js ≥ 20；
- 本机已安装 Chrome（或 Edge）；
- 运行时依赖 `playwright-core`（仅用于 CDP 连接，不下载浏览器）。

## 1. 一键启动带调试端口的 Chrome（推荐）

**双击桌面的「AI Bridge Chrome」图标**（首次初始化时会自动创建），或直接双击插件目录里的 `Start-Browser-Bridge.cmd`。

它做了三件事：

1. 调试端口 9222 已在监听 → 直接在该窗口打开对话页，不会重复启动浏览器；
2. 有同一独立用户目录的 Chrome 在跑但**没开**调试端口 → 提示你先关闭，或用 `-Force` 强制重启；
3. 否则用独立用户目录 `%USERPROFILE%\chrome-ai-profile` 启动 Chrome（并等待端口就绪）。

首次使用只需在该窗口里登录一次 AI 网页（如 chatgpt.com），登录态保存在 `%USERPROFILE%\chrome-ai-profile`，**以后每次重启电脑都用同一个目录，不用再登录**。

可选参数（在命令行或快捷方式「目标」里追加）：

```powershell
.\Start-Browser-Bridge.cmd                       # 默认：9222 端口 + 打开 https://chatgpt.com/
.\Start-Browser-Bridge.cmd -Url "https://claude.ai/"   # 换默认打开的页面
.\Start-Browser-Bridge.cmd -Port 9333            # 换端口（需同步改 cordis.patch.yml 的 cdpEndpoint）
.\Start-Browser-Bridge.cmd -NoOpen               # 只启动，不打开页面
.\Start-Browser-Bridge.cmd -Force                # 强制关闭占用的旧实例后重启
.\scripts\stop-chrome.ps1                        # 关闭这个桥接浏览器（端口被占用时用）
```

**开机自动启动（可选）**：执行一次

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcuts.ps1 -AutoStart
```

会在「启动」文件夹放一个静默启动项（不弹窗、不自动开网页），以后登录 Windows 就自动带调试端口起 Chrome；删除该快捷方式即可取消。`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcuts.ps1`（不带 `-AutoStart`）只重建桌面快捷方式。

> 手动方式（等价，仅供排查）：先完全退出浏览器，再执行
> `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\chrome-ai-profile"`
> 然后 `curl.exe http://127.0.0.1:9222/json/version` 验证。

## 2. 构建

```powershell
npm install          # 安装 devDependencies 与 playwright-core
npm run build        # tsc -> lib/index.js
```

安装 bundle 时加载的是 `lib/index.js`，所以**先构建再安装**。

## 3. 安装 bundle

任选其一：

**DSH 插件管理器（推荐）**：插件管理器 → 安装 bundle → 选择本目录（即 `package.json` 所在目录）。安装器读取 `package.json` 的 `dsh.bundle.patch`，应用 `cordis.patch.yml`，并把 bundle 以 `link:` 形式加入当前 profile。

**命令行**（Desktop 版 `dsh` 在 PATH 时）：

```powershell
dsh plugin install "<插件目录>"        # 等价于 dsh plugin add <dir>
# 显式指定 profile：
dsh plugin --profile desktop install "<插件目录>"
```

安装后在「设置 → 插件」中应看到 **浏览器桥接 / Browser bridge**，模型侧出现 `browser_bridge` 工具。若未立即生效，重启 DSH。

> 安装是 `link:` 方式（Windows 下为 junction）：本目录必须保留在原位置，且已执行过 `npm run build`；改动 `src/` 后需重新 `npm run build` 并重启 DSH。linked bundle 使用**本目录的 `node_modules`**（`playwright-core` 必须留在本目录下），DSH 不会把它装进 profile。

## 4. 使用

模型调用：

```json
{
  "prompt": "用三句话解释 CDP 是什么",
  "url": "https://chatgpt.com/c/xxxxxxxx"
}
```

- `prompt`（必填）：要输入并发送的文本；
- `url`（可选）：指定对话页。省略时使用当前**可见**标签页；若同源标签页已存在则直接复用，否则新开标签页。

返回值为该轮 AI 回复的完整纯文本。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cdpEndpoint` | `http://127.0.0.1:9222` | Chrome 的 CDP 地址 |
| `firstWaitMs` | `2000` | 发送后首次检测前的等待 |
| `pollIntervalMs` | `2000` | 轮询间隔 |
| `stableChecks` | `3` | 连续多少次长度不变判定结束 |
| `timeoutMs` | `180000` | 单次调用总超时 |

## 选择器策略

- 输入框：`textarea` → `div[contenteditable="true"]` → `[role="textbox"]`（取第一个可见元素；`fill` 失败时依次回退 `keyboard.insertText`、`execCommand('insertText')`，适配 ProseMirror / ChatGPT 新版编辑器）；
- 发送按钮：`[data-testid="send-button"]`、`button[aria-label*="发送"]`、`button[aria-label*="Send"]`、含「发送 / Send」文本的按钮；找不到可用按钮时回退 Enter；
- 回复区域（按优先级分组，取最内层最后一个可见容器）：
  1. `[data-markdown-text-style="assistant-message"]`、`[data-message-author-role="assistant"]` —— 新版 ChatGPT；
  2. `.markdown` / `.prose` —— Claude、Kimi 等；
  3. `[data-response-body]`；
  4. `[class*="message"]`（兜底）；
  并排除用户自己的气泡：`[data-user-message-bubble]`、`[data-markdown-text-style="user-message"]`、`[data-message-author-role="user"]`、class 含 `user-message`，以及文本与本次 `prompt` 完全相同的节点；这样不会把「我发的消息」误当回复；
- 完成判定：每 2s 采样回复文本长度，连续 3 次不变即结束；若期间仍能看到「停止生成」控件（`[data-testid="stop-button"]`、`button[aria-label*="停止"]` / `Stop`）或内容为空，则不计入稳定次数。

## 开发与验证

```powershell
npm run smoke        # 启动 headless Chrome + 本地假聊天页，端到端验证 CDP 连接/输入/发送/流式提取
```

冒烟测试覆盖：工具注册、contenteditable 输入、textarea 输入、同源标签页复用、激活标签页兜底、CDP 连接失败提示。

## 换电脑 / 迁移到新机器

插件是「本地目录 bundle」（DSH 里以 `link:` 指向本目录），所以迁移 = 复制目录 + 在新机器上装一次。

**第 1 步：在旧电脑打包**

```powershell
cd "<插件目录>"
# 选项 A（推荐，离线可用）：把 node_modules 一起打包，新机器无需联网/Node
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-portable-package.ps1 -WithNodeModules
# 选项 B（体积小，需要新机器有 Node 20+ 和网络）：只打源码 + 已编译的 lib
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-portable-package.ps1
```

产物在 `dist\dsh-browser-bridge-1.0.0.zip`（离线版为 `...-offline.zip`），把它拷到新电脑（U 盘 / 网盘均可）。

**第 2 步：在新电脑解压并初始化**

把 zip 解压到任意固定目录（建议路径不含特殊字符，例如 `C:\tools\dsh-browser-bridge`），然后在解压目录里执行：

```powershell
# 离线版（自带 node_modules）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1 -SkipNpmInstall
# 普通版（会 npm install + 构建 + 校验 playwright-core + 建桌面快捷方式）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1
```

**第 3 步：装进新电脑的 DSH**

- 图形界面：设置 → 插件 → 安装 bundle → 选择解压目录（`package.json` 所在目录）；
- 或命令行：`dsh plugin install "C:\tools\dsh-browser-bridge"`。

装完若工具没出现，重启一次 DSH。

**第 4 步：启动 Chrome 并登录一次**

双击桌面「AI Bridge Chrome」→ 在该窗口登录 AI 网页（ChatGPT / Claude / Kimi…）。登录态保存在 `%USERPROFILE%\chrome-ai-profile`，以后重启自动保持。然后让模型调用 `browser_bridge` 验证即可。

**迁移要点**

- 旧电脑的 Chrome 登录态**不会**随插件一起拷过去，新机器需要登录一次（也可以手动拷贝 `%USERPROFILE%\chrome-ai-profile` 目录，但那属于浏览器数据迁移，非必须）。
- 新电脑必须先装好 DSH Desktop；插件 `engines.dsh` 为 `>=0.2.2-rc.1`，DSH 版本过旧会被拒绝安装。
- 插件以链接方式安装，**解压后的目录不能删/不能移动**；要换位置就先在 DSH 里移除 bundle，再重新安装。
- 桌面快捷方式、开机自启项都是本机资源，需要在新机器上重建（`setup-new-pc.ps1` 已包含桌面快捷方式；开机自启再跑 `install-shortcuts.ps1 -AutoStart`）。
- 目标机器若是 Windows 以外的系统，`scripts\*.ps1` 不可用（只影响一键启动），插件本身是跨平台的：手动用 `chrome --remote-debugging-port=9222 --user-data-dir=...` 启动即可。

## 安全与隐私

- 仓库与插件**不保存**任何账号密码、Cookie、API Key 或个人信息；
- AI 网页的登录态只存在于你本机的 Chrome 独立用户目录（`%USERPROFILE%\chrome-ai-profile`），插件仅通过本机 CDP（`127.0.0.1:9222`）复用该会话；
- `browser_bridge` 会把网页 AI 的回复作为工具结果回传给模型，请勿在对话中粘贴敏感信息。

## 常见问题

- **提示无法连接 CDP**：Chrome 未带 `--remote-debugging-port=9222` 启动，或端口被占用；按上文重新启动并确认 `/json/version` 可访问。
- **找不到输入框/发送按钮**：当前标签页不是受支持的 AI 对话页，或页面未加载完成；用 `url` 显式指定会话页。
- **只拿到部分回复**：网页在生成中有较长停顿；增大 `stableChecks` 或 `firstWaitMs`。
- **Chrome 被关闭**：不会。`browser.close()` 在 CDP 连接场景只断开连接，用户的 Chrome 与登录态保留。
