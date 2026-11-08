/**
 * 工作空间树的 vscode-icons 风格彩色图标（零依赖，纯内联 SVG，逐路径手绘）。
 *
 * 文件夹：两色调（深色背板 + 浅色前板），**打开态使用翻盖形状**与关闭态明确区分；
 *         特殊文件夹（node_modules / src / public / server / tools / data / model /
 *         shared / .git / .github）在夹体上叠加彩色徽章。
 * 文件：折角页 + 类型色，常见类型带页内单色标签（TS / JS / {} / M / Y / <>…）；
 *       package*.json 为红底白六边形徽标；图片为页内山形。
 */

/* ---------------- 调色板 ---------------- */

const FOLDER_FRONT = '#d3aa5e'
const FOLDER_FRONT_OPEN = '#dcb46a'
const FOLDER_BACK_OPEN = '#96742f'

const FOLDER_EMBLEMS: Record<string, string> = {
  node_modules: '#4386c6',
  src: '#4f9eed',
  public: '#56b86b',
  server: '#57606a',
  tools: '#e8734a',
  data: '#8a5a44',
  model: '#a074c4',
  shared: '#9c6fd4',
  '.git': '#e8734a',
  '.github': '#8b949e'
}

const EXT_COLORS: Record<string, string> = {
  ts: '#3178c6',
  mts: '#3178c6',
  cts: '#3178c6',
  tsx: '#4f9eed',
  js: '#d8ac4a',
  mjs: '#d8ac4a',
  cjs: '#d8ac4a',
  jsx: '#e8c66a',
  json: '#d8ac4a',
  md: '#519aba',
  markdown: '#519aba',
  css: '#519aba',
  scss: '#c66b9b',
  less: '#c66b9b',
  html: '#e37933',
  htm: '#e37933',
  yml: '#a074c4',
  yaml: '#a074c4',
  toml: '#9c6fd4',
  xml: '#87b25c',
  svg: '#ffb13b',
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  webp: '#a074c4',
  ico: '#a074c4',
  bmp: '#a074c4',
  py: '#4ba08b',
  rs: '#d5a07b',
  go: '#57c3e8',
  sh: '#b5bd68',
  bash: '#b5bd68',
  ps1: '#9c6fd4',
  sql: '#c98a6b',
  txt: '#9aa0a6',
  log: '#9aa0a6'
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'])

export function folderColor(name: string): string {
  return FOLDER_EMBLEMS[name.toLowerCase()] ?? FOLDER_FRONT
}

export function fileColor(name: string): string {
  const n = name.toLowerCase()
  if (n === 'package.json' || n === 'package-lock.json' || n.endsWith('.lock')) return '#a3372c'
  if (n.startsWith('.git')) return '#e8734a'
  const dot = n.lastIndexOf('.')
  const ext = dot >= 0 ? n.slice(dot + 1) : ''
  return EXT_COLORS[ext] ?? '#9aa0a6'
}

/* ---------------- 文件夹（打开 / 关闭两种形态 + 徽章） ---------------- */

/** 关闭态：带标签页的合拢文件夹 */
function closedFolderPaths(): JSX.Element {
  return (
    <path
      d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.1c.36 0 .7.16.93.44l.9 1.06h5.67c.66 0 1.2.54 1.2 1.2v6.1c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.2z"
      fill={FOLDER_FRONT}
    />
  )
}

/** 打开态：深色背板 + 向右下翻开的前板 */
function openFolderPaths(): JSX.Element {
  return (
    <>
      <path
        d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.1c.36 0 .7.16.93.44l.9 1.06h5.67c.66 0 1.2.54 1.2 1.2v1.5H1.5V4.2z"
        fill={FOLDER_BACK_OPEN}
      />
      <path
        d="M1.1 6.9h12c.46 0 .79.44.66.88l-1.32 4.5c-.13.44-.53.72-.98.72H2.4c-.6 0-1.05-.55-.93-1.14l1.1-4.96z"
        fill={FOLDER_FRONT_OPEN}
      />
    </>
  )
}

/** 特殊文件夹徽章：画在夹体中心（坐标基于 16 网格，中心 ≈ (8, 9)） */
function folderEmblem(name: string): JSX.Element | null {
  const c = FOLDER_EMBLEMS[name.toLowerCase()]
  if (!c) return null
  switch (name.toLowerCase()) {
    case 'node_modules':
      // Node 六边形
      return (
        <path
          d="M10.7 9.2L9.35 11.5H6.65L5.3 9.2L6.65 6.9H9.35z"
          fill="none"
          stroke={c}
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      )
    case 'src':
      return (
        <g fill="none" stroke={c} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6.6 7.9L5.1 9.3L6.6 10.7M9.4 7.9L10.9 9.3L9.4 10.7" />
        </g>
      )
    case 'public':
      // 地球
      return (
        <g fill="none" stroke={c} strokeWidth="1">
          <circle cx="8" cy="9.2" r="2.5" />
          <ellipse cx="8" cy="9.2" rx="1.1" ry="2.5" />
          <path d="M5.6 9.2h4.8" />
        </g>
      )
    case 'server':
      // 齿轮
      return (
        <g stroke={c} strokeWidth="1" fill="none">
          <circle cx="8" cy="9.2" r="1.9" />
          <path d="M8 6.5v1M8 10.9v1M5.3 9.2h1M9.7 9.2h1M6.1 7.3l.7.7M9.2 10.4l.7.7M9.9 7.3l-.7.7M6.7 10.4l-.7.7" />
        </g>
      )
    case 'tools':
      // 交叉扳手（X 形，圆头）
      return (
        <g stroke={c} strokeWidth="1.3" strokeLinecap="round">
          <path d="M6.3 7.1l3.4 4.2M9.7 7.1L6.3 11.3" />
        </g>
      )
    case 'data':
      // 数据库圆柱
      return (
        <g fill="none" stroke={c} strokeWidth="1">
          <ellipse cx="8" cy="7.7" rx="2.5" ry="1" />
          <path d="M5.5 7.7v3c0 .55 1.12 1 2.5 1s2.5-.45 2.5-1v-3" />
        </g>
      )
    case 'model':
      return (
        <g>
          <circle cx="8" cy="9.2" r="2.1" fill={c} />
          <circle cx="8" cy="9.2" r="0.85" fill={FOLDER_FRONT} />
        </g>
      )
    case 'shared':
      return (
        <g fill="none" stroke={c} strokeWidth="1.05">
          <circle cx="6.8" cy="9.7" r="1.65" />
          <circle cx="9.2" cy="8.6" r="1.65" />
        </g>
      )
    case '.git':
      // 分支
      return (
        <g fill="none" stroke={c} strokeWidth="1">
          <path d="M6.5 8.1v3.4M9.5 7.4v1.4c0 1.3-1.3 1.5-2.4 1.8" />
          <circle cx="6.5" cy="7.1" r="1.05" />
          <circle cx="9.5" cy="6.5" r="1.05" />
          <circle cx="6.5" cy="12.6" r="1.05" />
        </g>
      )
    case '.github':
      return <circle cx="8" cy="9.2" r="2" fill={c} />
    default:
      return null
  }
}

function FolderIcon({ name, open }: { name: string; open: boolean }): JSX.Element {
  const emblem = folderEmblem(name)
  return (
    <svg className="tree-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      {open ? openFolderPaths() : closedFolderPaths()}
      {emblem}
    </svg>
  )
}

/* ---------------- 文件（折角页 + 类型标签 / 特殊徽标） ---------------- */

/** 常见扩展名的页内标签（1–2 字符，等宽小字） */
const EXT_LABELS: Record<string, string> = {
  ts: 'TS',
  mts: 'TS',
  cts: 'TS',
  tsx: 'TX',
  js: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  jsx: 'JX',
  json: '{}',
  md: 'M',
  markdown: 'M',
  yml: 'Y',
  yaml: 'Y',
  html: '<>',
  htm: '<>',
  css: '#',
  scss: '#',
  less: '#',
  py: 'PY',
  rs: 'RS',
  go: 'GO',
  sh: '$_',
  bash: '$_',
  ps1: 'PS',
  sql: 'SQ',
  toml: 'T'
}

function FileIcon({ name }: { name: string }): JSX.Element {
  const n = name.toLowerCase()
  const color = fileColor(name)

  // package.json / package-lock.json：红底圆角方块 + 白色 Node 六边形
  if (n === 'package.json' || n === 'package-lock.json') {
    return (
      <svg className="tree-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.6" y="2.2" width="12.8" height="11.6" rx="2" fill={color} />
        <path
          d="M10.6 8L9.15 10.45H6.85L5.4 8L6.85 5.55H9.15z"
          fill="none"
          stroke="#fff"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  const dot = n.lastIndexOf('.')
  const ext = dot >= 0 ? n.slice(dot + 1) : ''
  const isImage = IMAGE_EXTS.has(ext)
  const label = EXT_LABELS[ext]
  return (
    <svg className="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.8h4.4l3.8 3.8v8.2c0 .44-.36.8-.8.8H4.8c-.44 0-.8-.36-.8-.8V2.6c0-.44.36-.8.8-.8z"
        stroke={color}
        strokeWidth="1.2"
      />
      <path d="M8.4 1.8v3.8h3.8" stroke={color} strokeWidth="1.2" />
      {isImage && (
        <>
          <circle cx="6.4" cy="7" r="0.9" fill={color} />
          <path d="M5.4 11.6l2.2-2.4 1.6 1.6 1.2-1.2 1.8 2" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
        </>
      )}
      {!isImage && label && (
        <text
          x="7.4"
          y="11.4"
          textAnchor="middle"
          fontSize="5.4"
          fontWeight="700"
          fontFamily="Consolas, 'Courier New', monospace"
          fill={color}
        >
          {label}
        </text>
      )}
    </svg>
  )
}

/** 树行图标入口：isDir 时 open 区分打开/关闭形态 */
export function RowIcon({ name, isDir, open = false }: { name: string; isDir: boolean; open?: boolean }): JSX.Element {
  if (isDir) return <FolderIcon name={name} open={open} />
  return <FileIcon name={name} />
}
