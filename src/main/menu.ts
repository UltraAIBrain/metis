import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc'

function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuAction, action)
}

/**
 * 菜单只做"桌面应有的样子"：文件/编辑/视图/帮助。
 * 真正的交互都在渲染层，菜单仅负责转发快捷键动作。
 */
export function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Pi Desktop',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: '设置…', accelerator: 'Cmd+,', click: () => send('settings') },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建项目…', accelerator: 'CmdOrCtrl+N', click: () => send('new-session') },
        { label: '新建项目并选目录…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-session-pick') },
        { label: '更换项目目录…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('change-cwd') },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开日志目录', click: () => send('open-logs') },
        { label: '关于 Pi Desktop', click: () => send('about') }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
