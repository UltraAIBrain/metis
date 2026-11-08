import { BrowserWindow, Menu, Tray, app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { context } from './context'
import { logger } from './logger'
import { initPaths, migrateLegacyData } from './paths'
import { buildMenu } from './menu'
import { registerIpc } from './ipc'
import { termHost } from './term'
import { bindScheduler, startScheduler, stopScheduler } from './scheduler'
import { createTrayImage } from './tray-icon'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 真正退出中：关闭窗口时不再拦截成"最小化到托盘" */
let quitting = false

const getWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

/**
 * 托盘图标：逐像素绘制的小尺寸专用图标（见 ./tray-icon）。
 * 大图缩小的路线已放弃——16px 下细节必然糊掉，专用粗笔画字形才锐利。
 */
function createTray(): void {
  const image = createTrayImage()
  tray = new Tray(image)
  tray.setToolTip('Metis')
  tray.on('click', () => {
    const win = getWindow()
    if (!win) return
    if (win.isVisible() && win.isFocused()) win.hide()
    else {
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
  // Windows 气泡点击 = 显示窗口
  tray.on('balloon-click', () => {
    const win = getWindow()
    if (!win) return
    if (!win.isVisible()) win.show()
    win.focus()
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 Metis',
        click: () => {
          const win = getWindow()
          if (!win) return
          if (!win.isVisible()) win.show()
          win.focus()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createWindow(): void {
  const cfg = context().config.load()

  const win = new BrowserWindow({
    width: cfg.window?.width ?? 1280,
    height: cfg.window?.height ?? 840,
    x: cfg.window?.x,
    y: cfg.window?.y,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Metis',
    // 打包后图标由 exe 自带；开发模式下显式指定，任务栏才不是 Electron 默认图标
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 面板内嵌浏览器用 <webview> 渲染（guest 页面仍沙箱隔离）
      webviewTag: true,
      spellcheck: false
    }
  })

  mainWindow = win

  win.once('ready-to-show', () => {
    if (cfg.window?.maximized) win.maximize()
    win.show()
  })

  win.on('close', (event) => {
    try {
      const bounds = win.getNormalBounds()
      context().config.setWindowState({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: win.isMaximized()
      })
    } catch (err) {
      logger.warn('window.persist_failed', err)
    }
    // 关闭 = 最小化到托盘（状态已保存）；真正退出走托盘菜单 / before-quit
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  // 外部链接一律交给系统浏览器，应用内不允许跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function bootstrap(): void {
  // 数据放在 ~/.metis；历史目录（~/.pidesktop → Electron userData）首次启动依次搬一次。
  // 测试用 PI_DESKTOP_HOME/METIS_HOME 指到临时目录时跳过迁移，避免把真实数据搬进沙箱。
  const dataRoot = initPaths()
  const legacyPidesktop = process.env.PI_DESKTOP_HOME ? null : join(homedir(), '.pidesktop')
  const migrated =
    (legacyPidesktop ? migrateLegacyData(legacyPidesktop) : 0) + migrateLegacyData(app.getPath('userData'))
  if (migrated) {
    logger.info('paths.migrated', {
      items: migrated,
      from: legacyPidesktop && existsSync(join(dataRoot, 'config.json')) ? legacyPidesktop : app.getPath('userData')
    })
  }

  if (process.platform === 'win32') app.setAppUserModelId('dev.metis.app')

  const ctx = context()
  registerIpc(getWindow)
  bindScheduler(ctx.runner)
  startScheduler()
  ctx.bind((event) => {
    const win = getWindow()
    if (win) win.webContents.send(IPC.event, event)
    // 窗口藏在托盘时，任务结束用气泡提醒（displayBalloon 仅 Windows；其它平台静默跳过）
    if (event.type === 'run_end' && (!win || !win.isVisible()) && tray) {
      const tail = event.status === 'done' ? '已完成' : event.status === 'aborted' ? '已中止' : '出错结束'
      try {
        tray.displayBalloon({
          iconType: 'info',
          title: 'Metis',
          content: `后台任务${tail}，点击托盘图标回到窗口`
        })
      } catch {
        /* 平台不支持气泡就跳过 */
      }
    }
  })

  Menu.setApplicationMenu(buildMenu())
  createWindow()
  createTray()

  logger.info('app.ready', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    dataDir: dataRoot
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 面板内嵌浏览器（webview guest）：链接点击处理
  // target=_blank / window.open → 转发给渲染层开一个**新的浏览器选项卡**（不就地导航）；
  // 渲染层按 guestId 认领（哪个 webview 发起的就由那个 BrowserPane 实例开新标签）；
  // 非 http(s) 一律拒绝
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        const win = getWindow()
        if (win) {
          win.webContents.send(IPC.browserOpenTab, { guestId: contents.id, url })
        }
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!/^https?:/i.test(url)) event.preventDefault()
    })
  })

  app.on('second-instance', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  })

  app.whenReady().then(bootstrap).catch((err) => {
    logger.error('app.bootstrap_failed', err)
    app.quit()
  })

  app.on('activate', () => {
    const win = getWindow()
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
      return
    }
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    context().runner.abortAll()
    termHost.killAll()
    stopScheduler()
    tray?.destroy()
    tray = null
    logger.info('app.quit')
    logger.close()
  })
}
