/** IPC 通道名，主进程与 preload 共用，避免字符串写错。 */
export const IPC = {
  bootstrap: 'app:bootstrap',
  configSave: 'config:save',
  sessionCwd: 'session:cwd',
  pickDir: 'dialog:pick-dir',
  logsOpen: 'logs:open',
  /** 打开（必要时创建）SOUL.md 人格文件 */
  soulEdit: 'soul:edit',
  sessionList: 'session:list',
  sessionLoad: 'session:load',
  sessionNew: 'session:new',
  sessionDelete: 'session:delete',
  sessionRename: 'session:rename',
  sessionFork: 'session:fork',
  sessionSwitch: 'session:switch',
  sessionModel: 'session:model',
  sessionThinking: 'session:thinking',
  /** 会话级单轮步数上限（null = 跟随全局默认） */
  sessionSteps: 'session:steps',
  sessionPin: 'session:pin',
  sessionReveal: 'session:reveal',
  sessionTrajectory: 'session:trajectory',
  /** 轨迹数据（不弹保存框，面板内检查器用） */
  sessionTrajectoryData: 'session:trajectory-data',
  /** 上下文压缩：当前分支总结成摘要 → 切到摘要新分支 */
  sessionCompact: 'session:compact',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  /** ask 工具：渲染层把用户的选择回填给等待中的提问 */
  askAnswer: 'ask:answer',
  attachmentStage: 'attachment:stage',
  attachmentPick: 'attachment:pick',
  workspaceOpen: 'workspace:open',
  workspaceChanges: 'workspace:changes',
  workspaceDiff: 'workspace:diff',
  workspaceFileOpen: 'workspace:file-open',
  /** 面板内嵌：目录树懒加载（单层列表） */
  fsList: 'fs:list',
  /** 输入区 @ 引用：按名字搜工作目录里的文件 */
  fsSearch: 'fs:search',
  /** 输入区 @ 引用：读取工作目录内的文本文件（发送时内联为附件） */
  fsRead: 'fs:read',
  /** 面板内嵌终端：持久 shell（spawn 幂等 / 写行 / 取历史 / 关闭）+ 输出事件流 */
  termSpawn: 'term:spawn',
  termWrite: 'term:write',
  termData: 'term:data',
  termKill: 'term:kill',
  termEvent: 'term:event',
  modelsFetch: 'models:fetch',
  /** OpenAI OAuth：拉起浏览器登录 / 退出登录（凭据只存主进程） */
  oauthLogin: 'oauth:login',
  oauthLogout: 'oauth:logout',
  pluginsList: 'plugins:list',
  pluginsInstall: 'plugins:install',
  pluginsInstallGithub: 'plugins:install-github',
  pluginsToggle: 'plugins:toggle',
  pluginsRemove: 'plugins:remove',
  pluginsReload: 'plugins:reload',
  pluginsOpenDir: 'plugins:open-dir',
  /** 定时任务：到点把 prompt 注入指定会话 */
  scheduleList: 'schedule:list',
  scheduleCreate: 'schedule:create',
  scheduleUpdate: 'schedule:update',
  scheduleRemove: 'schedule:remove',
  /** 跨会话全文检索（起始页搜索框） */
  sessionSearch: 'session:search',
  /** 内嵌浏览器：guest 的 window.open → 渲染层开新浏览器选项卡（{ guestId, url }） */
  browserOpenTab: 'browser:open-tab',
  event: 'agent:event',
  menuAction: 'menu:action'
} as const
