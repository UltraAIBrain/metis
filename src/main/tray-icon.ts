import { nativeImage } from 'electron'
import { deflateSync } from 'node:zlib'

/**
 * 托盘专用图标：不做"大图缩小"（细节在小尺寸必然糊掉），
 * 而是按目标尺寸逐像素绘制——深色圆角方块 + 粗笔画 π，
 * 圆角矩形 SDF 覆盖度采样自带抗锯齿，任何尺寸边缘都锐利。
 * 产出 = 32px 位图标 scaleFactor 2（= 16 DIP），Electron 创建托盘 HICON 时按 DPI 取 32px 位图。
 */

/* ---------------- PNG 编码（RGBA → PNG，zlib + 手写 CRC32） ---------------- */

let crcTable: number[] | null = null

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crc])
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  // 每行一个 filter 字节（0 = None）
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------- 绘制：圆角矩形 SDF + π 字形 ---------------- */

/** 圆角矩形 SDF（px/py 为像素中心坐标，返回带符号距离，负值在矩形内） */
function sdfRoundRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const qx = Math.abs(px - cx) - (x1 - x0) / 2 + r
  const qy = Math.abs(py - cy) - (y1 - y0) / 2 + r
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - r
}

/** 覆盖度：距离 → 0..1（以 1px 步长采样，0.5px 过渡带） */
function coverage(dist: number): number {
  return Math.max(0, Math.min(1, 0.5 - dist))
}

interface GlyphSpec {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** π 字形（16 网格坐标）：横杆 + 两条腿 */
function piGlyphs(k: number): GlyphSpec[] {
  return [
    { x0: 2.6 * k, y0: 3.6 * k, x1: 13.4 * k, y1: 6.2 * k },
    { x0: 4.1 * k, y0: 6.2 * k, x1: 6.6 * k, y1: 13 * k },
    { x0: 9.4 * k, y0: 6.2 * k, x1: 11.9 * k, y1: 13 * k }
  ]
}

function drawTrayPng(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4)
  const k = size / 16
  const bg = { top: [0x23, 0x23, 0x27], bottom: [0x0e, 0x0e, 0x11] }
  const fg = [0xf5, 0xf5, 0xf7]
  const glyphs = piGlyphs(k)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const idx = (y * size + x) * 4
      // 背景：圆角方块（半径 ~22%），上下微渐变
      const bgDist = sdfRoundRect(px, py, 0, 0, size, size, size * 0.22)
      const bgCov = coverage(bgDist)
      if (bgCov <= 0) continue // 圆角外全透明
      const t = py / size
      const r = bg.top[0] + (bg.bottom[0] - bg.top[0]) * t
      const g = bg.top[1] + (bg.bottom[1] - bg.top[1]) * t
      const b = bg.top[2] + (bg.bottom[2] - bg.top[2]) * t
      rgba[idx] = Math.round(r)
      rgba[idx + 1] = Math.round(g)
      rgba[idx + 2] = Math.round(b)
      rgba[idx + 3] = Math.round(255 * bgCov)
      // π 字形：白色覆盖在背景上（SDF 各部件取最小距离）
      let glyphDist = Infinity
      for (const s of glyphs) {
        glyphDist = Math.min(glyphDist, sdfRoundRect(px, py, s.x0, s.y0, s.x1, s.y1, 0.6 * k))
      }
      const fgCov = coverage(glyphDist)
      if (fgCov > 0) {
        const a = fgCov * bgCov
        rgba[idx] = Math.round(rgba[idx] * (1 - a) + fg[0] * a)
        rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - a) + fg[1] * a)
        rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - a) + fg[2] * a)
      }
    }
  }
  return encodePng(size, size, rgba)
}

/** 托盘图标：绘制 32px 位图（= 16 DIP @2x），标 scaleFactor 让系统按 DPI 取用。
 *  块状粗笔画字形缩小不糊；不用大图缩放，也不用 ICO 临时文件。 */
const TRAY_PX = 32

export function createTrayImage(): Electron.NativeImage {
  return nativeImage.createFromBuffer(drawTrayPng(TRAY_PX), { scaleFactor: 2 })
}
