# Pi Desktop

把 [pi](https://pi.dev) 这个极简编码代理搬到桌面上：一个可双击启动、看得见工具调用、能随时插话或回退的应用。
底层仍然是 pi 的取向——**少而正交的工具、极短的提示词、不替你做决定**——只是把终端里的 TUI 换成了更易读的桌面交互。

---

## 1. 核心职责

桌面版不新增代理能力，只负责把 pi 的运行模型"翻译"成桌面体验：

| 职责 | 说明 |
| --- | --- |
| 代理循环 | 调模型 → 执行工具 → 回填结果 → 继续，直到模型不再调用工具或达到步数上限 |
| 工具执行 | `read` / `write` / `edit` / `bash` / `task` / `ask` / `memory` / `skills` / `repomind` / `fetch` 十个内置工具 + 插件工具，结果结构化回传 |
| 会话持久化 | 每会话一个 JSONL 追加文件，消息带 `parentId`，构成可回溯的**树** |
| 上下文构造 | 把树上的当前路径还原成 provider 需要的消息序列（OpenAI / Anthropic 两套协议） |
| 打断与插话 | 运行中可停止；也可追加消息排队，在下一步开始前注入 |
| 上下文压缩 | 状态栏实时显示上下文占用；接近上限时一键把当前分支总结成**摘要新分支**（原分支完整保留，可切回）；CLI 同款 `/compact` |
| 错误分类 | 认证 / 限流 / 网络 / 上下文超限 / 服务端，分别给出可读提示与重试策略 |
| 提供商档案 | 每家的 baseUrl、Key、模型缓存各自独立保存，切换厂商不会互相覆盖 |
| 会话级模型 | 每个会话记住自己的提供商与模型，互不影响；新会话继承全局默认 |
| 会话级目录 | 工作目录属于会话（项目）；可以不选，首次运行时自动开一个 `projects/<guid>`；**开始后锁定** |
| 草稿会话 | 点「新建项目」只在内存里开草稿，不写磁盘；发出第一条消息才真正创建 |
| 模型发现 | 按协议调用服务商的 `/models` 接口读取可用模型名，失败时退回手动输入 |
| 状态与日志 | 流式文本、工具状态、token 用量、`JSONL` 日志（按天轮转，保留 7 天） |

**边界很明确**：不做 MCP、不做内置 todo。子智能体（`task`）与计划型子任务（`plan` 类型）
是当前仅有的"多代理"能力：子任务一次性派生、独立历史、汇报后即结束，不可再嵌套。

## 2. 典型使用场景

- **改一处代码**：`把 src/main.rs 里的重试改成指数退避` —— 代理会先 read，再 edit，diff 直接在卡片里展开。
- **查一个问题**：`这个项目为什么 npm run build 失败` —— 它会跑命令、读报错、继续验证，全程 bash 输出可见。
- **批量改造**：运行中按 Enter 追加"顺便把相关的测试也改一下"，不打断当前步骤，下一步自动带上新要求。
- **试错回退**：某一步跑偏了，在那条助手消息上点「分叉」，从该点开新分支继续，原分支完整保留，可以左右切换对比。
- **只查看不动手**：把工作目录指向一个只读目录，或者干脆不给写权限的仓库。

## 3. 技术选型

| 选择 | 依据 |
| --- | --- |
| **Electron** | 代理需要不受限的文件系统与子进程能力。Electron 主进程就是 Node，`fs`/`child_process` 直接用，不需要写两套 FFI；打包链成熟，一套 TS 覆盖全部三层。相比 Tauri 省掉 Rust 工具链与跨语言边界。 |
| **electron-vite** | 主进程 / preload / 渲染进程三段式构建开箱即用，开发时渲染层保留 HMR，主进程改动自动重启。 |
| **React + TypeScript** | 流式消息、工具卡片、分支切换都是典型的状态驱动 UI；严格类型让"事件 → 状态"的映射关系可验证。 |
| **零运行时依赖** | 主进程不引 openai/anthropic SDK，直接 `fetch` + 手写 SSE 解析。少一层版本约束，也便于对接任意 OpenAI 兼容网关（DeepSeek / Ollama / vLLM / 自建）。 |
| **自研轻量状态容器** | 全局只有一份状态，用 `useSyncExternalStore` 即可，不需要 Redux/Zustand。 |
| **JSONL 存储** | 追加写、崩溃不毁全量、人肉可读、便于事后排查；比 SQLite 更符合"会话就是一条消息流"的语义。 |

## 4. 项目结构

```
pidesktop/
├── electron.vite.config.ts      # 三层构建配置
├── electron-builder.yml         # 打包配置（win/mac/linux）
├── tsconfig.node.json           # 主进程 / preload / scripts
├── tsconfig.web.json            # 渲染进程
├── scripts/smoke.ts             # 端到端冒烟测试（含假模型服务）
├── scripts/electron-smoke-main.cjs  # 真实 Electron 启动：窗口 / 沙箱 / preload / IPC
├── scripts/make-icon.cjs        # 由 icon.svg 渲染 png / 多尺寸 ico
├── build/                       # 打包资源：icon.svg / icon.png / icon.ico
└── src/
    ├── cli/index.ts             # 终端版 REPL（npm run pi），与桌面版共用 agent 核心
    ├── shared/                  # 主/渲染共享的领域类型与 IPC 通道名
    │   ├── types.ts
    │   ├── ipc.ts
    │   ├── providers.ts         # 6 个提供商预设 + baseUrl 识别（host + 路径）
    │   ├── model-catalog.ts     # 模型参数兜底表（上下文 / 最大输出 / 输入模态）
    │   └── chart.ts             # chart 围栏的解析与几何计算（→ 内联 SVG）
    ├── main/                    # 主进程：唯一有系统权限的地方
    │   ├── index.ts             # 生命周期、窗口、单实例、托盘
    │   ├── ipc.ts               # IPC 收口与参数校验
    │   ├── context.ts           # 服务单例装配 + safeStorage 加密
    │   ├── config.ts            # 配置读写、档案管理、API Key 加解密、v1 迁移
    │   ├── models.ts            # 按协议读取服务商的 /models 模型列表
    │   ├── oauth.ts             # OpenAI OAuth：PKCE + 本地回环回调 + token 续期
    │   ├── plugins.ts           # 插件宿主：清单、安装、启停、PreToolUse 钩子
    │   ├── github.ts            # GitHub 仓库 zip 下载 + URL 解析（含子目录）
    │   ├── zip.ts               # 最小 zip 读取器（不引三方依赖）
    │   ├── projects.ts          # 惰性创建 projects/<guid> 目录
    │   ├── attachments.ts       # 附件暂存、类型/大小上限、请求期校验
    │   ├── workspace.ts         # 面板：git 变更 / diff / 目录树 / @ 引用搜索
    │   ├── term.ts              # 面板内嵌终端：会话级持久 shell、UTF-8/GBK 解码
    │   ├── scheduler.ts         # 定时任务：cron 解析与 prompt 注入
    │   ├── session-search.ts    # 跨会话全文检索
    │   ├── trajectory.ts        # 消息 → 回合/工具往返的轨迹聚合
    │   ├── trajectory-md.ts     # 轨迹 → Markdown 报告
    │   ├── tray-icon.ts         # 托盘图标：SDF 逐像素绘制的小尺寸 ICO
    │   ├── logger.ts            # JSONL 日志 + 按天轮转
    │   ├── paths.ts             # 数据目录
    │   ├── menu.ts              # 原生菜单
    │   └── agent/               # 纯 Node，不依赖 Electron，可单独测试
    │       ├── runner.ts        # 代理循环 / 队列 / 中断 / 子智能体 / 上下文压缩
    │       ├── session.ts       # JSONL 会话树：append / fork / switchBranch
    │       ├── prompt.ts        # 极简提示词 + AGENTS/SOUL/USER/记忆/技能/插件注入
    │       ├── memory-store.ts  # MEMORY.md 读写、检索式注入、图谱与全息出处
    │       ├── sanitize.ts      # 补齐未配对的 tool_use / tool_result
    │       ├── diff.ts          # 行级 diff（给 edit 用）
    │       ├── errors.ts        # 错误分类与用户提示
    │       ├── tools/           # 10 个内置工具 + 路径守卫
    │       │   ├── index.ts     # 规格表 / 执行 / 按子智能体类型裁剪
    │       │   ├── util.ts      # resolveInside 路径守卫 + 参数校验
    │       │   ├── read.ts  write.ts  edit.ts  bash.ts  task.ts
    │       │   └── memory.ts  skills.ts  repomind.ts  fetch.ts  ask.ts
    │       └── providers/       # openai / anthropic / responses 流式适配 + 重试
    │           ├── index.ts     # createProvider + streamWithRetry
    │           ├── sse.ts       # SSE 解析、空闲看门狗、HTTP 错误分类
    │           └── types.ts     # StreamRequest / 模型能力判定
    ├── preload/
    │   ├── index.ts             # contextBridge 暴露的窄接口
    │   └── index.d.ts
    └── renderer/
        ├── index.html
        ├── main.tsx
        ├── App.tsx
        ├── store.ts             # 单一状态源，事件驱动（含草稿会话）
        ├── util.ts              # baseName / timeAgo / hasStarted
        ├── styles/              # 按区域拆分的样式，index.css 汇总
        │   ├── base.css         变量、重置、布局
        │   ├── sidebar.css      侧栏与会话列表
        │   ├── topbar.css       顶栏、模型切换、目录控件
        │   ├── messages.css     消息区、Markdown、工具卡片
        │   ├── composer.css     输入区与状态栏
        │   ├── overlays.css     空状态、对话框、Toast、动画
        │   └── plugins.css      插件管理
        └── components/
            ├── Sidebar.tsx      Composer.tsx     StatusBar.tsx
            ├── MessageList.tsx  MessageItem.tsx  ToolCard.tsx
            ├── Markdown.tsx     DiffView.tsx     AskDialog.tsx
            ├── SessionDir.tsx   SessionModelPicker.tsx  SessionThinking.tsx
            ├── StartScreen.tsx  Toasts.tsx      SidePanel.tsx
            ├── panel/                       # 面板内嵌视图
            │   ├── BrowserPane.tsx          <webview> 浏览器（多选项卡）
            │   ├── FilesPane.tsx            目录树 / diff / 会话产物
            │   ├── TerminalPane.tsx         内嵌终端
            │   └── TracePane.tsx            运行轨迹检查器
            ├── SettingsDialog.tsx           # 外壳：页签 + 保存
            └── settings/                    # 设置面板内部
                ├── useModelDrafts.ts         草稿状态与模型读取
                ├── draft.ts                  Draft / toPatch / freshness
                ├── ModelPicker.tsx           可搜索的模型选择器
                ├── GeneralTab.tsx ModelsTab.tsx
                └── PluginsTab.tsx RuntimeTab.tsx SchedulesTab.tsx
```

## 5. 依赖清单

**运行时**：无（全部逻辑走本地代码 + 原生 `fetch`）。

**开发/构建**：`electron` `electron-vite` `electron-builder` `vite` `@vitejs/plugin-react` `react` `react-dom` `typescript` `@types/*` `tsx`。

## 6. 运行 / 构建 / 打包

```bash
npm install

npm run pi         # 终端版（纯 Node REPL，与桌面版共用全部核心）
npm run dev        # 开发模式（渲染层 HMR）
npm run build      # 编译到 out/
npm start          # 以生产产物启动（本地预览）
npm run verify     # 一键验证：typecheck → build → smoke → smoke:electron
npm run smoke      # 端到端冒烟测试（主进程领域逻辑，无需真实 API Key）
npm run smoke:electron  # 真实 Electron 启动：窗口 + 沙箱 + preload + IPC
npm run typecheck  # 主进程 + 渲染进程类型检查
npm run icon       # 由 build/icon.svg 重新生成 png / ico / 尺寸检视表

npm run pack       # 免安装目录（release/win-unpacked）
npm run dist:win   # Windows NSIS 安装包
npm run dist:mac   # macOS dmg
npm run dist:linux # Linux AppImage
```

> Electron 二进制默认从 GitHub 下载。网络较慢时可临时指定镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`
>
> 如果 npm 在解析 `electron-builder` 的预发布依赖时报 `Invalid Version:`，
> 改用嵌套安装策略即可：`npm install --install-strategy=nested`。
>
> `electron-builder` 打包时会下载 `winCodeSign`（用于写 exe 图标与版本信息）。GitHub releases 不通时用：
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run pack`
>
> 打包注意：某个 `release*/win-unpacked` 目录一旦被启动过，Windows 上它的 `app.asar`
> 可能被索引/杀软长期占用，导致再次打包时报 `cannot access the file`。
> 重启机器后删掉旧的 `release*` 目录再打包即可。

## 7. 配置

首次启动只有起始页，点「新建项目」直接开始——不用先选目录；其余配置在「设置」里，落盘于 `config.json`。

| 字段 | 说明 |
| --- | --- |
| `lastCwd` | 上次选过的目录，只作为选择器的默认位置；真正的工作目录记录在会话里 |
| `activeProfileId` | 当前使用的提供商档案 |
| `profiles[]` | 每个档案：`id` / `label` / `protocol` / `baseUrl` / `apiKey` / `models`（缓存） |
| `model` | 全局默认模型；首次启动为空，由你从候选列表里选（不预置任何模型名） |
| `profiles[].models[]` | 模型缓存，含 `contextWindow` / `maxOutput` / `inputs` 与来源（`api` 或 `catalog`） |
| `temperature` / `maxSteps` | 采样温度；单轮最多几步工具往返（1–200，默认 40）。这只是**新会话的默认值**，每个会话可以单独覆盖 |
| `shell` | bash 工具实际使用的 shell（Windows 默认 PowerShell） |
| `thinking` | 新会话的默认思考强度：`low` / `high` / `max`（默认 `high`）；会话可在顶栏单独覆盖 |
| `maxTokens` | 输出上限；`0`（默认）= 自动跟随模型自身上限，推理模型的思考也计入 |

`apiKey` 用系统密钥加密（Electron `safeStorage`），渲染进程永远看不到明文；
若系统密钥不可用会退化为本地混淆，并在设置里如实标注。也支持环境变量兜底：
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。

旧版（v1，只有 openai / anthropic 两个槽位）的 `config.json` 会在首次加载时自动迁移为档案结构，原有 Key 与模型选择保留。

### 7.1 模型服务

「设置 → 模型服务」是一个**提供商列表** + 地址 + Key + 模型：

| 条目 | 协议 | Base URL |
| --- | --- | --- |
| `openai-codex` | Responses | `https://chatgpt.com/backend-api/codex` |
| `kimi` | OpenAI 兼容 | `https://api.moonshot.cn/v1` |
| `kimi-coding` | Anthropic | `https://api.kimi.com/coding` |
| `zai` | OpenAI 兼容 | `https://api.z.ai/api/paas/v4` |
| `zai-coding` | Anthropic | `https://api.z.ai/api/anthropic` |
| `deepseek` | OpenAI 兼容 | `https://api.deepseek.com` |

- **OpenAI Codex 用 ChatGPT 订阅登录（OAuth，无需 API Key）**：选 `openai-codex` 后点「用 ChatGPT 账号登录」，
  浏览器完成授权即接入（PKCE + 本地回环回调，token 加密存在本机、过期自动续期）。
  该后端走 **Responses 协议**（`/responses`），消息与工具调用会自动映射。
  终端版对应命令：`/login`、`/logout`。

- **不预置任何模型名**：候选一律运行时从 `GET {baseUrl}/models`（Anthropic 为 `/v1/models`）拉取，读取后由你手动选一个；因此换新模型不需要改代码。
- **自动识别**：选中条目会填好地址与协议；直接把地址粘到 Base URL 里也会反查。`kimi-coding` / `zai-coding` 与各自的开放平台**同域不同路径**，靠路径区分；路径里含 `/anthropic` 的一律按 Anthropic 协议处理。
- **手填兜底**：接口 404 / 网关禁用 / 需要接入点 ID 时，可直接在模型搜索框输入后回车。
- 「＋ 添加自定义端点」可加任意 OpenAI 兼容或中转地址，可加多个。
- 环境变量登录仍可用：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。

### 7.2 会话级模型

模型选择是**两层**的：

| 层级 | 在哪里改 | 作用范围 |
| --- | --- | --- |
| 全局默认 | 设置 → 模型服务 → 默认模型 | 只影响之后新建的会话 |
| 会话绑定 | 顶栏 `提供商 · 模型` 按钮 | 只影响当前会话之后的请求 |

新建会话时会把自己的 `profileId` + `model` 写进会话 meta，所以之后再改全局默认，已有会话的设置不会被悄悄改掉。
顶栏切换器左侧选提供商、右侧选模型（也可直接输入模型名回车绑定）；运行中切换会提示「下一条消息生效」——当前这一步不会被打断。

**工作目录同理，而且更彻底**：它只存在于会话 meta 的 `cwd` 里，没有全局工作目录。

- 新建项目**可以不指定目录**：第一次发送消息时，会在 `~/.pidesktop/projects/<guid>` 下自动开一个；
  也可以点「选择目录…」/ 侧栏的文件夹按钮，直接把已有仓库建成项目（`Ctrl+Shift+N`）；
- 目录显示在**会话窗口顶栏**（`📁 目录名`），点它就能换；左侧卡片上也带目录名，便于区分同名项目；
- **会话一旦开始就不能再改目录**（有任意一条消息即视为开始）：顶栏控件变成带锁的只读态，
  主进程同样拒绝 `session:cwd` 请求。历史消息里的相对路径指向旧目录，允许中途切换只会让上下文失效，所以直接锁死；
- `lastCwd` 只是选择框的起始位置，不参与任何路径解析；
- 设置里的「项目目录」可以更换，只影响这个项目之后的工具调用；
- 列表里删掉最后一个项目会回到起始页，不会自动建一个。
- 会话卡片支持右键菜单：**重命名任务**（行内编辑，回车保存）、**从资源管理器中打开**、
  **置顶任务**（置顶排在列表最前，带图钉标记，可一键取消）。
- **运行轨迹**（仿 agent harness 的 trajectory）：把会话聚合成「回合 → 模型响应 → 工具往返」的
  线性结构，每回合带步数 / token / 耗时统计；右键可导出 **Markdown**（人类可读报告，工具调用带
  命令与观察）或 **JSON**（机器可读完整结构）。状态栏实时显示本会话累计的步数与 token。
- **子智能体**（`task` 工具）：模型可派生子 agent 独立完成自包含子任务（探索代码、跑测试并汇总、
  跨文件搜索）。子 agent 有独立消息历史（看不到主对话）、共用工作目录与模型、随主任务中止而中止；
  过程不落盘，只把文本汇报作为工具结果写回父会话；**不可再嵌套派生**。工具卡片显示
  「N 步」徽标（步数 / token / 耗时），轨迹里同样带统计。
  同一轮里的多个 task 调用**并行执行**（混合轮次仍串行以保证文件操作可预测）；
  子任务执行期间界面实时显示它正在跑的工具（进度事件只喂 UI，不进历史）。
  三种子类型：`general`（全工具）/ `explore`（只读调研）/ `plan`（产出实施计划）——只读类型
  物理上没有 write/edit 工具（插件工具同样不进子任务）。每个子任务的完整过程落盘到
  `sessions/<id>.subagents.jsonl`（回放时工具输出按 8KB 截断），
  轨迹 JSON 导出按 taskCallId 关联（`subProcesses` 字段，只含当前分支的调用），
  Markdown 导出末尾带「子任务过程」回放段，删除会话时一并清理。

- **记忆系统**（`memory` 工具 + 全局 MEMORY.md，参考 Claude Code auto memory / Codex AGENTS.md，
  并扩展了 **MemoryGraph** 记忆图谱、**Hermes 式全息上下文**、**检索式注入**与**主动 nudge**）：
  - 分层：项目层 `AGENTS.md`（工作目录里，手动/模型维护，已有）→ 用户层 `~/.pidesktop/USER.md`
    （用户画像：这个用户是谁、习惯怎么协作；`memory scope=user` 维护，全量注入）→
    全局层 `~/.pidesktop/MEMORY.md`（项目/世界知识，模型自主维护）→ 会话历史（JSONL，自动）。
  - `memory(action, scope?)`：`read` / `append`（自动带日期）/ `rewrite`（精简）；
    `scope=user` 三个动作操作 USER.md（上限 4000 字符）。
  - **检索式注入**：记忆文件不超 8000 字符时整份注入；超限后不再粗暴截尾，而是按
    **当前消息分词检索**（拉丁整词 + CJK 二元组，词频倒排打分，稀有词权重更高）
    取最相关的 10 条 + 最新 5 条注入，图一跳邻居同样参与。文件上限 16000。
  - **主动 nudge**：一轮任务用过工具但全程没写任何记忆/技能时，下一轮 system prompt
    温和提醒一次（只提醒一次，不唠叨）——解决"全靠模型自觉、实际上从不记"的问题。
  - 提示词规则第 10 条指明记什么：用户长期偏好（进 USER.md）、需要自己摸索出的约定、
    可能复发的坑；**不记**单次任务细节。并行子任务不带 memory/skills 工具（并发写会交错）。
  - 设置 → 通用 显示记忆文件位置；原子写（tmp + rename）。
  - **MemoryGraph**：条目自动分配 id（`m1`、`m2`…），`link` 动作用关系边把两条记忆连起来
    （存 `memory-graph.json`，上限 500 条边）；`related` 召回时分词打分 + 图一跳扩展——
    直接命中的条目会把它的邻居也带出来。
  - **全息上下文**：每条记忆 append 时自动记录来源（会话 id、工作目录、时间，存
    `memory-holo.json`）；`related` 召回结果附带这些出处。rewrite 精简时自动清理失效条目的图与全息。

- **技能自创**（`skills` 工具，agent 的过程记忆，agentskills.io 风格）：
  模型把可复用的过程（环境搭建步骤、发布清单、排障套路）写成 `~/.pidesktop/skills/<id>/SKILL.md`
  （frontmatter 一行描述 + markdown 正文），system prompt 只注入**一行索引**、正文按需 `read`——
  技能多了也不烧 token。规则 11：开工前查索引，有匹配就先读再照做；做完发现技能不对就改进它。
  纯文本过程说明，不是可执行代码。

- **人格文件 SOUL.md**：`~/.pidesktop/SOUL.md` 存在即注入 system prompt（口吻、称呼、回复风格）；
  设置 → 通用 →「编辑人格文件」创建并打开（首次给注释模板）。留空/删除即恢复默认风格。

- **fetch 工具**（agent 侧网页阅读）：GET 一个 http(s) 地址返回正文文本——HTML 剥标签/脚本/样式、
  解码实体、提取标题；只读、无 cookie、20s 超时、400KB/30k 字符双上限。
  给模型看文档、changelog、报错解释用；交互式浏览仍在面板里。
- **ask 工具**（结构化提问）：请求有歧义或需要用户拍板时，模型给出问题 + 2–4 个候选，
  界面弹出选择卡片（可"其他…"自行输入），答案作为工具结果回填；超时 10 分钟，中止即取消。
  不用于模型自己能查到答案的问题。
- **定时任务**（设置 → 自动化）：cron（本地时区 5 段，支持 `*/n`、区间、列表，dom/dow 同时受限按 OR）
  到点把一条 prompt 注入指定会话——任务在跑就是排队插话，空闲则立即开跑。
  存 `schedules.json`，30s 粒度轮询 + 分钟去重；会话被删则任务自动停用。操作即时生效。
- **跨会话检索**：起始页搜索框扫最近 50 个会话的消息全文（复用记忆分词，命中至少一半查询词），
  按相关度排序、单会话最多出 4 条，点结果直接进入会话。
- **内联图表（```chart 围栏）**：助手回复里的 ```chart 代码块（JSON：type bar/line + labels + values）
  直接渲染成 SVG 柱状/折线图（Gen UI 轻量版），坏数据自动回退为普通代码块。

- **RepoMind**（`repomind` 工具，工作目录的轻量知识图谱）：递归扫描源码（跳过 node_modules 等，
  3000 文件封顶）建索引——文件清单、import/require 依赖边、顶层符号定义。
  `stats`（语言分布 / 最大文件 / 依赖热点）、`deps`/`usedby`（正反向依赖）、
  `symbol`（符号定位）。索引缓存按目录，`rebuild` 在大重构后显式重建。
  比 grep 更结构化地回答「谁引用了 X」「Y 定义在哪」。
- 助手消息的 Markdown 自己解析（不引三方库、不用 innerHTML）：标题、有序/无序列表（含嵌套）、
  引用、表格（含对齐）、分隔线、代码块（语言标签 + 复制）、链接 / 图片 / 粗体 / 斜体 / 删除线 / 行内代码，
  且 `snake_case_name` 这类标识符不会被误判成斜体。链接只放行 `http(s)` / `mailto`。

**新建 ≠ 立即创建**：点「新建项目」只会在内存里开一个草稿（顶栏显示「未命名会话」，侧栏不出现条目）。
发出第一条消息时才落盘创建，之后再刷新侧栏——所以不会留下一堆发过 0 条消息的空会话；
草稿阶段选的目录、绑定的模型都会一并写进会话 meta。

### 7.3 插件

「设置 → 插件」可以手动安装、启用/停用、卸载。一个插件就是一个目录：

```
~/.pidesktop/plugins/web-tools/
├── plugin.json     # { "name", "version", "description", "main" }
└── index.js        # module.exports = { instructions?, tools? }
```

```js
module.exports = {
  instructions: '需要外部资料时用 fetch_text 抓取网页。',
  tools: [{
    name: 'fetch_text',
    description: '抓取网页并返回纯文本',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run(input, ctx) {
      const res = await fetch(input.url, { signal: ctx.signal })
      return { content: await res.text() }
    }
  }]
}
```

- `ctx` 提供 `{ workspace, signal, log, resolve(p) }`；`resolve()` 自带路径守卫，只能解析到本项目目录内。
- 工具名需匹配 `^[a-z][a-z0-9_]{1,40}$`，与内置 `read/write/edit/bash` 冲突时内置优先。
- 插件注册的工具会一起进入模型可用的工具清单；`instructions` 会追加到系统提示词末尾。
- 安装方式：选插件文件（`plugin.json` / `.js`）或整个目录；也可以把文件夹直接丢进 `~/.pidesktop/plugins`，再点「重新加载」。
- **PreToolUse 钩子**：插件可导出 `hooks.beforeTool({ tool, input })`，在**每次**工具执行前裁决——
  `deny` 拦截并说明原因、`modify` 改写参数（后一个插件看到改后的）、返回空视为放行。
  钩子异常按放行处理（fail-open，审计插件故障不卡死代理）。适合做写操作审计、危险命令拦截。
- **从 GitHub 在线安装**：粘贴 `https://github.com/owner/repo` 即可，也支持 `/tree/分支/子目录` 定位 monorepo 里的子包。
  实现上直接下 `codeload` 的 zip（默认分支经 API 解析，失败回退 `main`/`master`），用自带的最小 zip 读取器解包，不引第三方依赖。
- 单个插件加载失败只会降级它自己（界面上标红原因），不影响主流程。

> **安全边界**：插件是本地 JS，由主进程 `require` 执行——安装即等于在你的机器上运行它。
> 应用不做沙箱，只装你信任来源的插件。

**数据目录**（统一在 `~/.pidesktop`，三平台一致）

```
~/.pidesktop/
├── config.json                 # 全局默认（模型偏好、参数、窗口位置）
├── sessions/                   # 每个会话一个 .jsonl + .meta.json（含 cwd / profileId / model）
│   └── <id>.subagents.jsonl    # 会话的子任务过程记录（轨迹导出用；删除会话时清理）
├── logs/app-YYYY-MM-DD.jsonl   # 按天轮转，保留 7 天
├── projects/<guid>/            # 没指定目录的项目，首次运行时自动开在这里
├── attachments/<sessionId>/    # 会话附件暂存；删除会话时一并清理
├── plugins/<id>/               # 插件目录，一个插件一个文件夹
├── plugins.json                # 插件的启用状态
├── MEMORY.md                   # 全局记忆（模型通过 memory 工具维护）
├── USER.md                     # 用户画像（memory scope=user 维护，全量注入）
├── SOUL.md                     # 人格文件（存在即注入；设置里可编辑）
├── skills/<id>/SKILL.md        # 技能（模型通过 skills 工具自建自改）
├── memory-graph.json           # 记忆图谱（条目关联边）
├── memory-holo.json            # 记忆全息出处（来源会话 / 目录 / 时间）
```

> 旧版本把数据放在 Electron userData（Windows 是 `%APPDATA%/pi-desktop`）。
> 升级后首次启动会把 `config.json` / `sessions` / `logs` 自动搬到 `~/.pidesktop`，不覆盖已有数据。

## 8. 交互约定

| 操作 | 效果 |
| --- | --- |
| `Enter` | 发送 |
| `Shift+Enter` | 换行 |
| 运行中 `Enter` | 追加到队列（下一步注入，不打断当前步骤） |
| `Esc` | 停止当前任务 |
| `Ctrl/Cmd+N` | 新建项目（草稿，发消息后才落盘） |
| `Ctrl/Cmd+Shift+N` | 新建项目并选目录 |
| `Ctrl/Cmd+Shift+O` | 更换当前项目的目录（仅会话开始前可用） |
| `Ctrl/Cmd+,` | 设置 |
| 输入区回形针 / 粘贴 / 拖入 | 添加附件（图片或文本文件，一条消息最多 8 个；模型不支持图片输入时图片会被拦下并说明原因） |
| 输入区 `@` | 引用工作目录里的文件：输入 `@` 加文件名片段弹出补全（↑↓ 选择、Enter/Tab 插入）；发送时自动把引用的文本文件内联为附件（≤256KB，草稿会话/读不到的按普通文字） |
| 顶栏 `提供商 · 模型` | 切换当前会话的提供商与模型（可手填模型名） |
| 顶栏 `思考 · 高` | 切换当前会话的思考强度（低/高/极致），可恢复跟随默认 |
| 顶栏 `步数 · 40` | 切换当前会话的单轮步数上限（20/40/80/150/200），可恢复跟随默认；长任务不必再改全局设置 |
| 会话卡片右键 | 重命名任务 / 从资源管理器中打开 / 导出轨迹（Markdown / JSON）/ 置顶任务 / 删除会话 |
| 顶栏 `面板` | 展开会话区右侧功能面板，动作都在面板内完成：**打开浏览器** = 面板内嵌浏览器（`<webview>`，带地址栏 / 前进后退 / 刷新 / 首页，切走再切回不丢页面；
**链接点击开新选项卡**——target=_blank 与 window.open 会新建一个独立浏览器标签（各自 webview 与地址栏，
标签芯片显示站点名），非 http(s) 一律拒绝）；**查看工作空间** = 面板内目录树（懒加载逐层展开、显示文件大小，点文件看对 HEAD 的 diff 或用系统程序打开）；**查看变更** = git 变更列表与差异；**查看轨迹** = 按回合检查运行轨迹（工具参数 / 结果 / 耗时 / 成败逐层展开，带刷新）；**打开终端** = 面板内嵌终端（会话级持久 shell，保留 cd 状态与历史；**点击终端区域直接输入**——
输出末尾行内块状光标 + 闪烁动画，↑↓ 回溯输入历史，Ctrl+C 清行，支持 IME 与粘贴；
**5 套配色主题**（深色默认 / 纯黑 / 深蓝 / Solarized / 浅色）与三档字号，圆角终端卡片，偏好记忆；全屏交互程序不支持；
终端全链路 UTF-8（严格解码失败自动回退 GBK、解不出的字符丢弃），工具栏可切换 PowerShell 7 / 5.1 / cmd / bash，「自动」= 系统默认，
Windows 上优先探测 PowerShell 7（含 Microsoft Store 版，位于 WindowsApps 执行别名），启动带版本横幅，
父进程的 PSModulePath 不会传入 shell（防模块解析错乱）），另有会话产物列表（write/edit 产出过的文件，点击用系统程序打开） |
| 助手消息「分叉」 | 以该消息为父节点开新分支 |
| 助手消息 `‹ 1/3 ›` | 在兄弟分支间切换 |

## 9. 稳定性设计

- **路径守卫**：`resolveInside()` 以**当前会话的目录**为根，对每个文件操作做 `relative` 校验，`../` 与绝对路径越界一律拒绝；
  对已存在的目标再做 `realpath` 解析，工作目录内指向外部的符号链接同样不允许越界；
  工作空间面板的变更差异与产物打开同样只允许目录内的相对路径（并做真实路径校验）。
- **bash 不在路径守卫之内**：`bash` 在工作目录里起进程，但命令本身可以 `cd` 或用绝对路径读到目录外的东西
  ——这是"能跑构建 / 测试 / git"的前提，不是遗漏。越界拦截只对 `read` / `write` / `edit` 与面板操作生效；
  bash 侧只做凭据过滤（见下一条）。要限制代理的活动范围，就把项目指向只读或隔离的仓库。
- **凭据隔离**：bash 子进程的环境变量会剔除名字带 KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL 的条目，
  避免模型用 `env` 之类命令直接读走 API Key。
- **提示注入边界**：AGENTS.md、全局记忆与插件说明注入 system prompt 时会声明它们是"本地数据"，
  与 `Rules` 冲突时以 `Rules` 为准。
- **中断一致性**：任何中断都会为已发出的 `tool_use` 补一条 `tool_result`，避免会话结构损坏导致后续请求 400。
- **重试策略**：仅对限流/网络/5xx 重试，最多 2 次指数退避；**已经推过 token 就不再重试**，否则会出现重复文本。
- **超时与清理**：bash 默认 120s 超时，超时/中断时在 Windows 上用 `taskkill /T /F` 杀进程树。
- **输出限额**：命令输出 200KB、文件读取默认 2000 行（单次最大 5000 行）、diff 200 行，超出即截断并明确告知模型与用户；
  模型侧输出上限默认**自动跟随模型**：接口给了 `max_output_tokens` 就用它，没有查内置表，再没有兜底 16384。
- **流式看门狗**：SSE 每收到一块数据就重置 120s 空闲计时；连接不断但没数据时主动中断并提示「等待模型响应超时」，不会无限转圈。
- **推理模型**：`reasoning_content`（OpenAI 兼容）与 `thinking_delta`（Anthropic）只用于界面「思考中」提示，**不写入历史**，既不会污染后续请求，也不会撑爆上下文。
- **思考强度**：顶栏「思考」chip 可随时切 `低/高/极致`（只写当前会话 meta，可一键恢复跟随默认）；
  设置 → 运行 里是**新会话的默认值**。OpenAI 兼容协议发 `reasoning_effort`，Anthropic 发 `output_config.effort`；
  若思考把输出额度吃光（`finish_reason=length` 且只有思维链），会**自动降到 `low` 重试一次**并提示，
  而不是直接把错误丢给用户；
  仅当模型名白名单命中（GLM-4.5+ / o 系列 / GPT-5+ / DeepSeek-R1 / Claude 5.x）才带该字段，
  服务端若仍明确报「参数不认识」（unsupported parameter / unknown field 等），OpenAI 兼容协议最多
  剔除 `reasoning_effort`、`tool_choice` 各重试一次，Anthropic 剔除 `output_config` 重试一次——
  绝不因为一个可选参数把请求打死；其它 400（真实参数错误）原样透传，不盲目删参数。
- **原子写**：配置与会话 meta 都走 `tmp + rename`，不会留下半截 JSON。
- **附件边界**：附件只收图片（png/jpeg/webp/gif，≤10MB）与文本文件（≤256KB），暂存在数据目录里；
  请求构造时校验路径必须位于本会话的附件目录内，元数据随消息进 JSONL，分支回放同样有效；
  文本附件在请求里内联为带标记的正文，图片按 OpenAI（data URL）/ Anthropic（base64 块）协议分别构造。
- **渲染层隔离**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，能力全部经 preload 白名单暴露。
- **单实例**：重复启动只会聚焦已有窗口。
- **托盘常驻**：关闭窗口 = 最小化到托盘（窗口状态照常保存，后台任务继续跑）；托盘左键切换显隐，
  右键菜单「打开 Pi Desktop / 退出」，真正退出只从托盘或退出菜单走；窗口藏在托盘时任务结束弹气泡提醒。
  托盘图标为小尺寸专用绘制（深色圆角方块 + 粗笔画 π，SDF 逐像素渲染 + 内存多尺寸 ICO），
  不依赖大图缩放，小尺寸边缘锐利。
- **终端版**（`npm run pi`；需先 `npm run build` 生成 `out/main/cli.js`）：纯 Node REPL，零 Electron 依赖，与桌面版共用
  runner / 会话 / 工具 / 插件 / 记忆 / 轨迹 / 子智能体全部核心。流式渲染（文本直写、
  工具行 `⏺ name 参数` → `✓ 结果 · 耗时`、用量行），运行中再输入会排队注入（steering），
  Ctrl+C 只中止当前任务。  命令：`/help /new /sessions /switch /model /thinking /login /logout /compact /attach /export /memory /tools /quit`。
  启动参数：`--new`（强制新会话）、`--session <id>`、`--dir <目录>`、`--home <数据目录>`、`--help`。

## 10. 验证

`npm run smoke` 会拉起一个本地假模型服务，完整跑一遍：

1. 流式文本 + 分片 `tool_calls` 解析；
2. 四个工具真实执行（写文件 → 读文件 → 编辑 → 执行命令）并校验落盘结果；
3. 消息结构与 token 用量；
4. 路径越界拒绝、缺失文件错误可读；
5. 会话树分叉与分支切换；
6. 配置不回传明文 Key、缺 Key 时报错明确；
7. 提供商地址识别（kimi / kimi-coding / zai / zai-coding / deepseek，含同域不同路径）；
8. `/models` 读取、排序、字段保留，以及 404 时的可读提示；
9. v1 → v2 配置迁移（Key 与模型选择不丢）；
10. 会话级模型与会话级目录：两个会话并行各用各的模型、文件各自落在自己的目录；
11. 惰性目录：不选目录新建 → 首轮自动在 `projects/<guid>` 建目录，工具落在里面；开始前可改目录、开始后被锁定；
12. 插件：识别清单、工具进入规格表、提示词注入、工具可执行、停用后下线；
13. 流式鲁棒性：只返回思维链时报错可读、卡住的流会主动超时；
14. 思考强度：推理模型带上 `reasoning_effort`，服务端不认时自动降级重试；会话级覆盖可写入/恢复；
15. 输出上限：请求带 `max_tokens`，思考吃光额度时自动降档重试并拿到正文；
16. 模型参数：解析接口返回的 `context_length` / `max_completion_tokens` / `input_modalities`，缺失时用内置表兜底；
17. 破损工具参数拒绝执行、响应头等待有超时；
18. 附件：图片/文本按类型暂存、文本内联进请求、删除会话时清理附件目录；
19. 运行轨迹：按用户消息分段、收集工具往返与耗时、token 按回合聚合、Markdown 报告结构完整；
20. 子智能体：task 派生 → 子循环真实执行工具 → 汇报作为结果写回、过程不落盘、统计进 meta 与轨迹；
21. 子智能体进阶：同轮多 task 并行（两个 tool_start 先于首个 tool_end）、进度事件发出且不落盘；
22. 子类型与子过程：explore 无写类工具、子过程落盘并被轨迹 JSON 关联、删除会话时清理；
23. 记忆：append 写入带日期、新会话 system 注入记忆、rewrite 全量覆盖、删会话不误删记忆；
24. MemoryGraph 与全息：append 自动分配 id、link 建边、related 打分召回 + 图扩展、全息记录会话来源、rewrite 清理失效边；
25. RepoMind：deps 正向 / usedby 反向 / symbol 定位 / rebuild 重建；
26. 终端版：子进程跑 CLI 完成真实对话（工具执行 → 结果渲染 → 用量行 → 会话落盘）；
27. GitHub 安装链路：zip 解包（条目数/解压大小上限）、URL 解析（根 / 分支 / 子目录 / 非 GitHub 拒绝）、目录安装落盘；
28. 日志落盘且包含 `run.start` / `run.end` / 工具记录；
29. OpenAI OAuth：PKCE（challenge 可复算）、JWT 解码、假认证服务跑完整登录流（授权 URL 参数、
    code_verifier 匹配、state 篡改拒绝、token 落库不外泄、refresh 轮换、过期自动刷新）；
30. Responses 协议：请求映射（instructions / reasoning.effort / max_output_tokens / input_text）、
    SSE 事件流（文本 / 思考 / 工具调用分片拼装 / 用量 / 停机原因）；
31. 上下文压缩：当前分支 → 模型摘要 → 摘要成为新分支根（原分支完整保留、可切回）、压缩后可继续对话；
32. 闭环学习：记忆分词检索（拉丁 + CJK 2-gram、相关条目排最前）、超限检索式注入（相关 + 最新、长度受控）、
    nudge 触发与消除、技能 write/list/read、fetch 的 HTML 正文提取与非 http 拒绝、
    USER.md / SOUL.md / 技能索引注入 system prompt；
33. ZCode 借鉴：插件 beforeTool 钩子（deny/modify/放行 + executeTool 全链路）、ask 桥（投递/回填/结果）、
    cron（解析/匹配/OR 语义/非法拒绝）、跨会话检索（命中与空查询）、chart（解析/拒绝坏数据/几何/折线 path）。

另有 `npm run smoke:electron` 用真实 Electron 验证：窗口创建、渲染层沙箱配置、preload 桥接、
基础 IPC（bootstrap / 建会话 / 列表），以及注入夹具会话后的 **UI 断言**——侧栏右键菜单
（重命名 / 资源管理器 / 置顶 / 删除四项齐全）与 Markdown 渲染结构（标题 / 列表含嵌套缩进 /
引用 / 表格 / 代码块 / 分隔线 / 粗斜删 / 链接 / snake_case 完好）。

## 11. 已知限制

- 桌面版与终端版**不要同时**操作同一个数据目录：会话 / 配置 / 记忆都是进程内缓存 + 原子整写，
  没有跨进程文件锁，并发写同一会话或 MEMORY.md 会互相覆盖。
- 一个项目绑定一个目录；需要同时处理两套代码就建两个项目。
- 插件在主进程内运行，没有沙箱与权限提示；只装可信来源。
- 从 GitHub 安装只支持公开仓库（没有配 token 的地方），私有仓库请先下载到本地再装。
- **步数上限是软停，不是失败**：一轮任务最多 `maxSteps` 步模型往返，达到上限只是本轮停下（`run_end` 仍是 `done`），
  回一句「继续」就接着做，排队中的消息也不会被丢。默认 40 步是经验值：改一处代码 3–8 步、排查构建失败 10–20 步、
  大范围重构 30–60 步。步数只是**上下文的代理指标**——真正会杀死任务的是窗口超限，而那个由状态栏的占用比例 + 手动压缩兜底。
  子智能体另有独立上限：`min(maxSteps, 24)`，单轮多任务里一个子任务最多吃 24 步。
- **上下文压缩不做全自动**：状态栏显示占用（≥60% 出现按钮、≥75% 变黄、≥90% 变红），
  由你决定何时压；压缩 = 摘要新分支，**原历史一个字不动**（pi 的取向：不偷偷改你的历史）。
  超限报错时不自动压缩，仍由你手动触发。
- 只保留两个协议族，其他厂商通过 OpenAI 兼容网关接入。
- 模型列表依赖服务商提供 `GET /models`；部分网关禁用了该接口，此时只能手动输入模型名。
- 一个提供商档案绑定一套 baseUrl + Key；同一厂商的多账号可各建一个自定义档案。
- 未做代码高亮，diff 与代码块使用等宽字体呈现。
- 图标只有静态 SVG 源，没有做 macOS 的 `.icns`（需要在 mac 上跑一次 `electron-builder` 才会生成）。
