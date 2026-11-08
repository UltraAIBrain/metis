/**
 * ```chart 代码块的解析与几何计算（纯函数，冒烟可测）。
 * Markdown 渲染器遇到 ```chart 围栏时用它生成内联 SVG 图表（Gen UI 轻量版），
 * 解析失败/数据不合法一律回退为普通代码块，绝不影响消息渲染。
 */

export interface ChartSpec {
  type: 'bar' | 'line'
  title?: string
  labels: string[]
  values: number[]
}

const MAX_POINTS = 31
const MAX_LABEL_CHARS = 12

export function parseChartSpec(raw: string): ChartSpec | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const obj = json as Record<string, unknown>
  const type = obj.type === 'line' ? 'line' : obj.type === 'bar' ? 'bar' : null
  if (!type) return null
  if (!Array.isArray(obj.values)) return null
  const values = obj.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (values.length < 2 || values.length > MAX_POINTS) return null
  const labels = Array.isArray(obj.labels)
    ? obj.labels.map((l) => String(l ?? '').slice(0, MAX_LABEL_CHARS))
    : values.map((_, i) => String(i + 1))
  return {
    type,
    title: typeof obj.title === 'string' ? obj.title.slice(0, 60) : '',
    labels: labels.slice(0, values.length),
    values
  }
}

export interface ChartGeometry {
  /** SVG 视口（不含标签区） */
  width: number
  height: number
  /** 折线的绘制点（x/y 已落在视口内，y=0 在顶部） */
  points: { x: number; y: number }[]
  /** 柱状图的柱形（x/宽/高） */
  bars: { x: number; width: number; y: number; height: number }[]
  min: number
  max: number
}

export function chartGeometry(spec: ChartSpec, width = 520, height = 160): ChartGeometry {
  const pad = 10
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const min = Math.min(...spec.values)
  const max = Math.max(...spec.values)
  const span = max - min || 1
  const n = spec.values.length
  const yOf = (v: number): number => pad + innerH - ((v - min) / span) * innerH
  if (type(spec) === 'line') {
    const points = spec.values.map((v, i) => ({
      x: n === 1 ? width / 2 : pad + (i / (n - 1)) * innerW,
      y: yOf(v)
    }))
    return { width, height, points, bars: [], min, max }
  }
  const slot = innerW / n
  const barW = Math.min(slot * 0.62, 44)
  const bars = spec.values.map((v, i) => {
    const x = pad + i * slot + (slot - barW) / 2
    const y = yOf(v)
    return { x, width: barW, y, height: pad + innerH - y }
  })
  return { width, height, points: [], bars, min, max }
}

function type(spec: ChartSpec): 'bar' | 'line' {
  return spec.type
}

/** 折线 path 的 d 属性（points 按序连线） */
export function linePath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
}
