export interface GitHubTarget {
  owner: string
  repo: string
  ref?: string
  subpath?: string
}

const MAX_BYTES = 40 * 1024 * 1024

/**
 * 支持这些写法：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main
 *   https://github.com/owner/repo/tree/main/plugins/foo
 *   github.com/owner/repo（可省略协议）
 */
export function parseGitHubUrl(input: string): GitHubTarget {
  const raw = (input || '').trim()
  if (!raw) throw new Error('请填写仓库地址')

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error('地址格式不对')
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) {
    throw new Error('只支持 github.com 的仓库地址')
  }

  const seg = url.pathname.split('/').filter(Boolean)
  if (seg.length < 2) throw new Error('地址里缺少仓库名，例如 https://github.com/owner/repo')

  const owner = seg[0]
  const repo = seg[1].replace(/\.git$/i, '')
  let ref: string | undefined
  let subpath: string | undefined

  if (seg[2] === 'tree' && seg[3]) {
    ref = decodeURIComponent(seg[3])
    if (seg.length > 4) subpath = seg.slice(4).map(decodeURIComponent).join('/')
  }

  return { owner, repo, ref, subpath }
}

async function request(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers: { 'user-agent': 'pi-desktop', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    const name = (err as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('请求超时，检查网络或代理')
    throw new Error(`请求失败：${(err as Error).message}`)
  }
}

/** codeload 不认 HEAD，先问 API 默认分支；失败再退 main / master */
async function resolveDefaultBranch(owner: string, repo: string): Promise<string | null> {
  try {
    const res = await request(`https://api.github.com/repos/${owner}/${repo}`, 15_000)
    if (!res || !res.ok) return null
    const json = (await res.json()) as { default_branch?: string }
    return json.default_branch ?? null
  } catch {
    return null
  }
}

async function fetchZip(owner: string, repo: string, ref: string): Promise<Buffer | null> {
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`
  const res = await request(url, 60_000)
  if (!res) return null
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) {
    await res.body?.cancel()
    throw new Error('仓库压缩包超过 40MB，暂不支持')
  }
  if (!res.body) throw new Error('下载失败：响应体为空')

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) throw new Error('仓库压缩包超过 40MB，暂不支持')
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    throw err
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

/** 下载仓库压缩包；只给 repo 时自动解析默认分支。 */
export async function downloadRepoZip(target: GitHubTarget): Promise<Buffer> {
  const refs: string[] = []
  if (target.ref) {
    refs.push(target.ref)
  } else {
    const def = await resolveDefaultBranch(target.owner, target.repo)
    if (def) refs.push(def)
    for (const guess of ['main', 'master']) if (!refs.includes(guess)) refs.push(guess)
  }

  for (const ref of refs) {
    const buf = await fetchZip(target.owner, target.repo, ref)
    if (buf) return buf
  }

  throw new Error(
    `仓库或分支不存在：${target.owner}/${target.repo}${target.ref ? `@${target.ref}` : ''}（私有仓库需要 token，暂不支持）`
  )
}
