/**
 * 由 build/icon.svg 生成应用图标产物：
 *   build/icon.png       1024×1024（Linux/macOS 与运行时窗口图标）
 *   build/icon-512.png   512×512（预览用）
 *   build/icon.ico       16/24/32/48/64/128/256 多尺寸（Windows）
 * 用法：electron scripts/make-icon.cjs
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const ROOT = path.join(__dirname, '..')
const SIZE = 1024

function icoFromPngs(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length

  images.forEach((img, i) => {
    const p = i * 16
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, p)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, p + 1)
    dir.writeUInt8(0, p + 2)
    dir.writeUInt8(0, p + 3)
    dir.writeUInt16LE(1, p + 4) // planes
    dir.writeUInt16LE(32, p + 6) // bpp
    dir.writeUInt32LE(img.png.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += img.png.length
  })

  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

async function main() {
  const svg = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8')

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}
  </style></head><body>${svg}</body></html>`

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 700))

  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const base = shot.resize({ width: SIZE, height: SIZE, quality: 'best' })

  const corner = base.toBitmap()
  console.log('SIZE=' + JSON.stringify(shot.getSize()) + ' CORNER_ALPHA=' + corner[3])

  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), base.toPNG())
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-512.png'), base.resize({ width: 512, height: 512, quality: 'best' }).toPNG())

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map((size) => ({
    size,
    png: nativeImage
      .createFromBuffer(base.toPNG())
      .resize({ width: size, height: size, quality: 'best' })
      .toPNG()
  }))
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), icoFromPngs(images))

  console.log('OK icon.png / icon-512.png / icon.ico (' + sizes.join(',') + ')')

  // 小尺寸检视表：确认 16/32px 下还认得出来
  const preview = new BrowserWindow({
    width: 720,
    height: 150,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: true }
  })
  const cells = [16, 24, 32, 48, 64, 128]
    .map((s) => {
      const b64 = images.find((i) => i.size === s).png.toString('base64')
      return `<figure><img src="data:image/png;base64,${b64}" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`
    })
    .join('')
  await preview.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;height:150px;overflow:hidden;display:flex;align-items:center;justify-content:center;gap:22px;background:#fff;
           font:11px -apple-system,'Segoe UI',sans-serif;color:#888}
      figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
      img{display:block;image-rendering:-webkit-optimize-contrast}
    </style>${cells}`
    )}`
  )
  await new Promise((r) => setTimeout(r, 400))
  const sheet = await preview.webContents.capturePage({ x: 0, y: 0, width: 720, height: 150 })
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-preview.png'), sheet.toPNG())
  console.log('OK icon-preview.png')

  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('FAILED', err)
    app.exit(1)
  })
})
