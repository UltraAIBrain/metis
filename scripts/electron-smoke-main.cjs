// 本机 shell 可能带 ELECTRON_RUN_AS_NODE（Electron 以纯 Node 启动，app 为 undefined）。
// 检测到就剥掉该变量重新拉起自己，保证真正以 Electron 运行。
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [__filename], { env, stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 1))
  return
}

const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const home = mkdtempSync(join(tmpdir(), 'pidesktop-electron-smoke-'))
process.env.PI_DESKTOP_HOME = home
process.env.PI_LOG_LEVEL = 'error'
app.setPath('userData', join(home, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')

/**
 * 造一个带 Markdown 样本消息的会话夹具，验证渲染层：
 * 直接写 sessions/*.jsonl + *.meta.json，格式与 SessionStore 完全一致。
 */
function seedMarkdownSession() {
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const now = Date.now()
  const md = [
    '## 渲染自检',
    '',
    '正文带 **粗体**、*斜体*、~~删除线~~、`行内代码` 与 [链接](https://example.com)。',
    'snake_case_name 不应被斜体吃掉。',
    '',
    '- 项目一',
    '  - 嵌套项',
    '- 项目二',
    '',
    '1. 第一',
    '2. 第二',
    '',
    '> 引用一行',
    '',
    '| 列A | 列B |',
    '| :-- | :-: |',
    '| a | b |',
    '',
    '```ts',
    'const x: number = 1',
    '```',
    '',
    '---'
  ].join('\n')

  const user = { role: 'user', id: 'u1', ts: now - 5000, text: '渲染自检' }
  const assistant = {
    role: 'assistant',
    id: 'a1',
    ts: now - 4000,
    model: 'smoke-model',
    provider: 'openai',
    stopReason: 'stop',
    usage: { input: 10, output: 5 },
    blocks: [{ type: 'text', text: md }]
  }

  const entries = [user, assistant].map((message, i) => ({
    type: 'message',
    id: message.id,
    parentId: i === 0 ? null : [user][i - 1].id,
    ts: message.ts,
    message
  }))

  writeFileSync(
    join(home, 'sessions', 's_mdfixture.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  )
  writeFileSync(
    join(home, 'sessions', 's_mdfixture.meta.json'),
    JSON.stringify(
      {
        id: 's_mdfixture',
        title: '渲染自检会话',
        cwd: '',
        createdAt: now - 6000,
        updatedAt: now - 4000,
        leafId: 'a1',
        entryCount: 2,
        profileId: undefined,
        model: 'smoke-model'
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(join(home, 'sessions', 's_otherfixture.jsonl'), '', 'utf8')
  writeFileSync(join(home, 'sessions', 's_otherfixture.meta.json'), JSON.stringify({
    id: 's_otherfixture', title: '另一回归会话', cwd: '', createdAt: now - 8000,
    updatedAt: now - 7000, leafId: null, entryCount: 0, model: 'smoke-model'
  }), 'utf8')
}

const rendererErrors = []
let finished = false

function fail(error) {
  if (finished) return
  finished = true
  console.error(`Electron smoke failed: ${error instanceof Error ? error.stack : String(error)}`)
  app.exit(1)
}

process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

app.on('browser-window-created', (_event, win) => {
  const contents = win.webContents
  contents.on('console-message', (_event, level, message) => {
    if (level === 3) rendererErrors.push(message)
  })
  contents.on('preload-error', (_event, path, error) => {
    rendererErrors.push(`${path}: ${String(error)}`)
  })
  contents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`renderer gone: ${details.reason}`)
  })
  contents.on('did-fail-load', (_event, code, description) => {
    rendererErrors.push(`load failed ${code}: ${description}`)
  })
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(read, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Test-only IPC fixtures exercise the built renderer without exposing production internals. */
async function rendererRegressions(win) {
  const evaluate = (source) => win.webContents.executeJavaScript(source)
  const click = async (selector, text) => {
    await evaluate(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(el => ${text === undefined ? 'true' : `el.textContent.includes(${JSON.stringify(text)})`})
      if (!node) throw new Error('Missing test element: ' + ${JSON.stringify(selector)})
      node.click()
    })()`)
  }
  const input = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }
  const visible = (selector, text) => waitFor(() => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    return Boolean(el && el.textContent.includes(${JSON.stringify(text)}))
  })()`), `${selector}: ${text}`)
  const selectSession = async (title) => {
    await click('.session-row', title)
    await visible('.topbar-title', title)
  }
  const replace = (channel, handler) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }

  // A delayed @ reference must never send A's text or attachment to session B.
  let releaseRead
  let readStarted = false
  const sent = []
  replace('fs:search', () => [])
  replace('fs:read', async () => {
    readStarted = true
    return new Promise((resolve) => { releaseRead = resolve })
  })
  replace('chat:send', (_event, id, text) => { sent.push({ id, text }); return { queued: false } })
  await input('.composer textarea', '读取 @fixture.txt')
  await click('.btn-send')
  await waitFor(() => readStarted, '@ reference read started')
  await selectSession('另一回归会话')
  releaseRead({ name: 'fixture.txt', text: 'private to A' })
  await visible('.toast', '会话已切换')
  check(sent.length === 0, 'message was sent to a different session during @ reference resolution')
  await selectSession('渲染自检会话')
  await waitFor(() => evaluate("document.querySelector('.composer textarea').value === '读取 @fixture.txt'"), 'original draft retained')

  // Concurrent questions queue; cancellation removes only its own question and resets answer draft.
  const emit = (event) => win.webContents.send('agent:event', event)
  emit({ type: 'ask_question', sessionId: 's_mdfixture', callId: 'q-one', question: '第一条问题', options: ['甲', '乙'] })
  emit({ type: 'ask_question', sessionId: 's_otherfixture', callId: 'q-two', question: '第二条问题', options: ['丙', '丁'] })
  await visible('.ask-question', '第一条问题')
  await click('.ask-other-btn')
  await input('.ask-other-row input', '第一问草稿')
  emit({ type: 'ask_closed', sessionId: 's_mdfixture', callId: 'q-one' })
  await visible('.ask-question', '第二条问题')
  check(await evaluate("!document.querySelector('.ask-other-row input')"), 'answer draft leaked into next question')
  emit({ type: 'run_end', sessionId: 's_otherfixture', status: 'aborted', at: Date.now() })
  await waitFor(() => evaluate("!document.querySelector('.ask-dialog')"), 'ended run question removed')

  // A late answer response must not close a newer question.
  let releaseAnswer
  replace('ask:answer', () => new Promise((resolve) => { releaseAnswer = resolve }))
  emit({ type: 'ask_question', sessionId: 's_mdfixture', callId: 'q-three', question: '第三条问题', options: ['甲', '乙'] })
  await visible('.ask-question', '第三条问题')
  await click('.ask-option')
  await waitFor(() => releaseAnswer, 'answer submitted')
  emit({ type: 'ask_closed', sessionId: 's_mdfixture', callId: 'q-three' })
  emit({ type: 'ask_question', sessionId: 's_otherfixture', callId: 'q-four', question: '第四条问题', options: ['丙', '丁'] })
  await visible('.ask-question', '第四条问题')
  releaseAnswer(true)
  await delay(80)
  await visible('.ask-question', '第四条问题')
  emit({ type: 'ask_closed', sessionId: 's_otherfixture', callId: 'q-four' })
  await waitFor(() => evaluate("!document.querySelector('.ask-dialog')"), 'last question removed')

  // Resolve file B before A and ensure the selected file retains B's diff.
  const diffs = new Map()
  let releaseDirectory
  replace('fs:list', (_event, _id, rel) => rel
    ? new Promise((resolve) => { releaseDirectory = resolve })
    : [{ name: 'A.txt', kind: 'file', size: 1 }, { name: 'B.txt', kind: 'file', size: 1 }, { name: 'slow', kind: 'dir', size: 0 }])
  replace('workspace:diff', (_event, _id, file) => new Promise((resolve) => { diffs.set(file, resolve) }))
  await click('.panel-action-card', '查看工作空间')
  await visible('.pane-tree', 'A.txt')
  await click('.tree-row', 'A.txt')
  await waitFor(() => diffs.has('A.txt'), 'A diff requested')
  await click('.tree-row', 'B.txt')
  await waitFor(() => diffs.has('B.txt'), 'B diff requested')
  diffs.get('B.txt')('@@ -1 +1 @@\n-old\n+B-result')
  await visible('.pane-file', 'B-result')
  diffs.get('A.txt')('@@ -1 +1 @@\n-old\n+A-result')
  await delay(80)
  check(await evaluate("document.querySelector('.pane-file').textContent.includes('B-result') && !document.querySelector('.pane-file').textContent.includes('A-result')"), 'late A diff replaced B diff')
  await click('.tree-row', 'slow')
  await waitFor(() => releaseDirectory, 'slow directory requested')
  await selectSession('另一回归会话')
  await click('.panel-action-card', '查看工作空间')
  await visible('.pane-tree', 'A.txt')
  releaseDirectory([{ name: 'stale-child.txt', kind: 'file', size: 1 }])
  await delay(80)
  check(await evaluate("!document.querySelector('.pane-tree').textContent.includes('stale-child.txt')"), 'old directory leaked into another session')

  // A loopback page makes real guest navigations observable without external network access.
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>Browser regression</title><p>Local test page</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    await click('.panel-tab-add')
    await click('.panel-action-card', '打开浏览器')
    await input('.pane-url', `${base}/one`)
    const enterAddress = () => evaluate("document.querySelector('.pane-url').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
    await enterAddress()
    await waitFor(() => requests.includes('/one'), 'initial browser navigation')
    await waitFor(() => evaluate(`document.querySelector('webview')?.getURL() === ${JSON.stringify(`${base}/one`)}`), 'initial guest URL')
    await input('.pane-url', `${base}/two`)
    await delay(150)
    check(!requests.includes('/two'), 'editing address navigated the guest before Enter')
    check(await evaluate(`document.querySelector('webview').getURL() === ${JSON.stringify(`${base}/one`)}`), 'guest URL changed before Enter')
    await enterAddress()
    await waitFor(() => requests.includes('/two'), 'committed browser navigation')
    check(requests.filter((url) => url === '/two').length === 1, 'committed address navigated twice')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  console.log('Renderer regressions passed · @ reference session switch + ask lifecycle + file request races + browser address commit')
}

async function run() {
  await app.whenReady()
  seedMarkdownSession()
  require('../out/main/index.js')

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'main window')
  const prefs = win.webContents.getLastWebPreferences()
  check(prefs.contextIsolation === true, 'contextIsolation is not enabled')
  check(prefs.nodeIntegration === false, 'nodeIntegration is enabled')
  check(prefs.sandbox === true, 'renderer sandbox is not enabled')

  const result = await waitFor(async () => {
    if (win.webContents.isLoading()) return null
    return win.webContents.executeJavaScript(`(async () => {
      if (!window.pi || !document.querySelector('#root')?.children.length) return null
      const bootstrap = await window.pi.bootstrap()
      const created = await window.pi.newSession()
      const sessions = await window.pi.listSessions()
      return {
        platform: bootstrap.platform,
        dataDir: bootstrap.dataDir,
        createdId: created.id,
        listed: sessions.some((item) => item.id === created.id),
        title: document.title
      }
    })()`)
  }, 'renderer, preload and IPC')

  check(result.platform === process.platform, 'bootstrap returned the wrong platform')
  check(result.dataDir === home, `unexpected data directory: ${result.dataDir}`)
  check(/^s_[a-z0-9]+$/i.test(result.createdId), `invalid created session id: ${result.createdId}`)
  check(result.listed, 'created session was not returned by session:list')
  check(result.title === 'Metis', `unexpected document title: ${result.title}`)
  check(rendererErrors.length === 0, `renderer errors: ${rendererErrors.join(' | ')}`)

  /* ---- UI 断言：右键菜单 + Markdown 渲染（点开夹具会话） ---- */
  const ui = await waitFor(async () =>
    win.webContents.executeJavaScript(`(async () => {
      // 切到夹具会话：模拟点击侧栏行
      const row = [...document.querySelectorAll('.session-title')].find(t => t.textContent.includes('渲染自检会话'))
      if (!row) return { step: 'row-not-found' }
      row.closest('.session-row').click()
      await new Promise(r => setTimeout(r, 400))

      // 右键菜单
      const box = row.closest('.session-row').getBoundingClientRect()
      row.closest('.session-row').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: box.left + 40, clientY: box.top + 14
      }))
      await new Promise(r => setTimeout(r, 250))
      const menuBtns = [...document.querySelectorAll('.session-menu button')].map(b => b.textContent.trim())
      document.dispatchEvent(new MouseEvent('mousedown'))
      await new Promise(r => setTimeout(r, 150))

      // Markdown 结构
      const md = document.querySelector('.md')
      return {
        step: 'ok',
        menuBtns,
        h2: md?.querySelectorAll('h2').length ?? 0,
        ul: md?.querySelectorAll('ul').length ?? 0,
        // 嵌套列表是平铺 li + marginLeft；depth=0 也会渲染成 '0px'，按数值过滤
        nestedLi: [...(md?.querySelectorAll('ul li') ?? [])].filter(li => parseInt(li.style.marginLeft) > 0).length,
        ol: md?.querySelectorAll('ol').length ?? 0,
        quote: md?.querySelectorAll('blockquote').length ?? 0,
        table: md?.querySelectorAll('table').length ?? 0,
        codeBlock: md?.querySelectorAll('pre code').length ?? 0,
        hr: md?.querySelectorAll('hr').length ?? 0,
        strong: md?.querySelectorAll('strong').length ?? 0,
        em: md?.querySelectorAll('em').length ?? 0,
        del: md?.querySelectorAll('del').length ?? 0,
        link: md?.querySelectorAll('a[href="https://example.com"]').length ?? 0,
        snakeIntact: md?.textContent.includes('snake_case_name') ?? false,
        title: document.querySelector('.topbar-title')?.textContent ?? ''
      }
    })()`), 'sidebar context menu and markdown rendering', 15000)

  check(ui.step === 'ok', `UI probe failed at step: ${ui.step}`)
  const menuLabels = ui.menuBtns.join(',')
  check(menuLabels.includes('重命名任务'), `context menu missing rename: ${menuLabels}`)
  check(menuLabels.includes('从资源管理器中打开'), `context menu missing reveal: ${menuLabels}`)
  check(menuLabels.includes('置顶任务'), `context menu missing pin: ${menuLabels}`)
  check(menuLabels.includes('删除会话'), `context menu missing delete: ${menuLabels}`)
  check(ui.h2 === 1, `markdown h2 count: ${ui.h2}`)
  check(ui.ul === 1 && ui.nestedLi === 1, `markdown list structure: ul=${ui.ul} nested=${ui.nestedLi}`)
  check(ui.ol === 1, `markdown ol count: ${ui.ol}`)
  check(ui.quote === 1, `markdown blockquote count: ${ui.quote}`)
  check(ui.table === 1, `markdown table count: ${ui.table}`)
  check(ui.codeBlock === 1, `markdown code block count: ${ui.codeBlock}`)
  check(ui.hr === 1, `markdown hr count: ${ui.hr}`)
  check(ui.strong === 1, `markdown strong count: ${ui.strong}`)
  check(ui.em === 1, `markdown em count: ${ui.em}`)
  check(ui.del === 1, `markdown del count: ${ui.del}`)
  check(ui.link === 1, `markdown link count: ${ui.link}`)
  check(ui.snakeIntact, 'snake_case_name was mangled by italic parsing')

  await rendererRegressions(win)
  check(rendererErrors.length === 0, `renderer errors: ${rendererErrors.join(' | ')}`)

  finished = true
  console.log(`Electron smoke passed · window + sandbox + preload + IPC + context menu + markdown · ${home}`)
  app.quit()
}

const watchdog = setTimeout(() => fail(new Error('Global Electron smoke timeout')), 45000)
watchdog.unref()
app.on('will-quit', () => clearTimeout(watchdog))
run().catch(fail)
