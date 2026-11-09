#!/usr/bin/env node
/**
 * 把终端版打成单文件 exe（Node SEA，Single Executable Application）。
 *
 *   npm run dist:cli   →  release-cli/metis.exe
 *
 * 为什么不能直接拿 out/main/cli.js 用：electron-vite 把主进程与 CLI 共享的模块
 * （plugins / trajectory-md / config …）拆进了 out/main/chunks/*.js，而 SEA 只接受
 * **一个** CJS 文件。所以这里用 esbuild 重新从 src 打一份自包含的 bundle。
 *
 * 前置：Node ≥ 20（22 上 --experimental-sea-config 已是稳定流程，仍需 postject 注入）。
 * postject 不是常驻依赖，只在这条命令里用得上：
 *     npm i -D postject
 *
 * 产物约 80–110MB（整个 Node 运行时），这是"不要求用户装 Node"的代价。
 * 只为自己用的话 `npm link` 更划算，见 README §6。
 */
const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const outDir = join(root, 'release-cli')
const exePath = join(outDir, 'metis.exe')
const workDir = join(outDir, '.sea')

/** Node 文档里的固定哨兵值：postject 靠它在二进制里定位注入点 */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

/* ---------------- 1. 前置检查 ---------------- */

const major = Number(process.versions.node.split('.')[0])
if (Number.isNaN(major) || major < 20) {
  fail(`需要 Node ≥ 20 才能用 SEA（当前 ${process.versions.node}）`)
}

let esbuild
try {
  esbuild = require('esbuild')
} catch {
  fail('缺少 esbuild。它是 vite 的传递依赖，理论上已安装；没有就 npm i -D esbuild')
}

let postjectBin
try {
  const pkgPath = require.resolve('postject/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.postject
  postjectBin = bin ? join(dirname(pkgPath), bin) : null
  if (!postjectBin || !existsSync(postjectBin)) postjectBin = null
} catch {
  postjectBin = null
}
if (!postjectBin) {
  fail('缺少 postject（用于把 blob 注入 node.exe）。先执行：npm i -D postject')
}

/* ---------------- 2. 打成单文件 CJS ---------------- */

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

const bundlePath = join(workDir, 'metis.cjs')
console.log('· esbuild 打包单文件…')
esbuild.buildSync({
  entryPoints: [join(root, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: bundlePath,
  // SEA 注入的主脚本里 __filename 不保证可用，而 plugins.ts 用它当 createRequire 的基址
  // （加载用户插件目录下的 index.js）。指到 exe 自身即可：插件都是绝对路径 require。
  define: { __filename: 'process.execPath' },
  logLevel: 'warning'
})

/* ---------------- 3. 生成 SEA blob ---------------- */

const blobPath = join(workDir, 'metis.blob')
const seaConfigPath = join(workDir, 'sea-config.json')
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  ),
  'utf8'
)

console.log('· 生成 SEA blob…')
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' })

/* ---------------- 4. 复制运行时并注入 ---------------- */

mkdirSync(outDir, { recursive: true })
copyFileSync(process.execPath, exePath)

if (process.platform === 'win32') {
  // node.exe 是签过名的；不摘签名就注入，产物会变成"签名失效"而不是"无签名"
  try {
    execFileSync('signtool', ['remove', '/s', exePath], { stdio: 'ignore' })
    console.log('· 已摘除 node.exe 签名')
  } catch {
    console.warn('· 跳过摘签名（未找到 signtool）——注入失败时先执行：signtool remove /s release-cli/metis.exe')
  }
}

console.log('· 注入 blob…')
const postjectArgs = [postjectBin, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE]
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
execFileSync(process.execPath, postjectArgs, { stdio: 'inherit' })

if (process.platform === 'darwin') {
  console.log('· macOS 需要重新签名才能运行：codesign --sign - release-cli/metis.exe')
}

/* ---------------- 5. 收尾 ---------------- */

rmSync(workDir, { recursive: true, force: true })
const mb = (statSync(exePath).size / 1024 / 1024).toFixed(1)
console.log(`\n✓ ${exePath}  (${mb} MB)`)
console.log('  试运行：release-cli/metis.exe --help\n')
