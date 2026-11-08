import { inflateRaw } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const MAX_ENTRIES = 2000
const MAX_ENTRY_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024

function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 66_000)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function inflate(raw: Buffer, declaredSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(raw, { maxOutputLength: Math.min(declaredSize, MAX_ENTRY_BYTES) + 1 }, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

/** 最小 zip 读取器：只支持 GitHub 归档会用到的 store(0) 与 deflate(8)，不引第三方依赖。 */
export async function unzip(buffer: Buffer): Promise<ZipEntry[]> {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是有效的 zip 文件')

  const total = buffer.readUInt16LE(eocd + 10)
  if (total > MAX_ENTRIES) throw new Error(`压缩包文件数过多（>${MAX_ENTRIES}）`)
  let p = buffer.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  let totalBytes = 0

  for (let i = 0; i < total; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('zip 中央目录损坏')

    const method = buffer.readUInt16LE(p + 10)
    const compSize = buffer.readUInt32LE(p + 20)
    const uncompressedSize = buffer.readUInt32LE(p + 24)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (uncompressedSize > MAX_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_TOTAL_BYTES) {
      throw new Error('压缩包解压后过大，已停止安装')
    }
    if (name.endsWith('/')) continue
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('zip 文件条目损坏')
    }

    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    if (start + compSize > buffer.length) throw new Error('zip 文件内容不完整')
    const raw = buffer.subarray(start, start + compSize)

    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = await inflate(raw, uncompressedSize)
    else throw new Error(`不支持的压缩方式：${method}`)
    if (data.length !== uncompressedSize) throw new Error(`zip 条目大小不一致：${name}`)

    totalBytes += data.length
    out.push({ name, data })
  }

  return out
}
