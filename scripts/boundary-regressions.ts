import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveInside } from '../src/main/agent/tools/util'
import { writeTool } from '../src/main/agent/tools/write'
import { askTool, answerAsk, bindAskCloseDelivery, bindAskDelivery } from '../src/main/agent/tools/ask'
import type { ToolContext } from '../src/main/agent/tools/types'

/** 所有链接目标均位于独立测试目录内，不接触用户工作区之外的数据。 */
export async function runBoundaryRegressions(testRoot: string): Promise<void> {
  const fixture = mkdtempSync(join(testRoot, 'path-regression-'))
  const workspace = join(fixture, 'workspace')
  const outside = join(fixture, 'outside')
  const inside = join(workspace, 'inside')
  mkdirSync(inside, { recursive: true })
  mkdirSync(outside)
  const ctx: ToolContext = { workspace, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(outside, join(workspace, 'external'), linkType)
  symlinkSync(inside, join(workspace, 'internal'), linkType)
  symlinkSync(workspace, join(fixture, 'workspace-alias'), linkType)
  symlinkSync(join(outside, 'missing-directory'), join(workspace, 'dangling'), linkType)

  for (const path of ['external/new.txt', 'external/new-dir/deep/file.txt', 'dangling/new.txt']) {
    await assert.rejects(writeTool.run({ path, content: 'must not be written' }, ctx), /符号链接|无法校验/)
  }
  assert.equal(existsSync(join(outside, 'new.txt')), false)
  assert.equal(existsSync(join(outside, 'new-dir')), false)
  assert.equal(existsSync(join(outside, 'missing-directory')), false)
  writeFileSync(join(outside, 'existing.txt'), 'unchanged')
  await assert.rejects(writeTool.run({ path: 'external/existing.txt', content: 'changed' }, ctx), /符号链接/)
  assert.equal(readFileSync(join(outside, 'existing.txt'), 'utf8'), 'unchanged')
  assert.throws(() => resolveInside(workspace, '../outside/new.txt'), /超出工作目录/)
  const valid = await writeTool.run({ path: 'internal/new/deep.txt', content: 'allowed' }, ctx)
  assert.equal(valid.isError, false)
  assert.equal(readFileSync(join(inside, 'new/deep.txt'), 'utf8'), 'allowed')
  assert.equal(resolveInside(join(fixture, 'workspace-alias'), 'inside/new/deep.txt'), realpathSync(join(inside, 'new/deep.txt')))
  await writeTool.run({ path: 'new/directory/file.txt', content: 'normal new file' }, ctx)
  assert.equal(readFileSync(join(workspace, 'new/directory/file.txt'), 'utf8'), 'normal new file')
  console.log('  ✓ 新文件/多级父目录/悬空链接越界拒绝，目录内链接与普通新文件可用')

  const opened: { sessionId: string; callId: string }[] = []
  const closed: { sessionId: string; callId: string }[] = []
  const controllers: AbortController[] = []
  const requests: Promise<unknown>[] = []
  bindAskDelivery((payload) => opened.push(payload))
  bindAskCloseDelivery((payload) => closed.push(payload))
  const ask = (sessionId: string): { result: Promise<Awaited<ReturnType<typeof askTool.run>>>; abort: AbortController } => {
    const abort = new AbortController()
    controllers.push(abort)
    const result = askTool.run({ question: 'Choose a plan', options: ['A', 'B'] }, {
      ...ctx, signal: abort.signal, sessionId, callId: 'same-model-call-id'
    })
    // 即便断言提前失败，也不能留下拒绝未处理或十分钟定时器。
    requests.push(result.catch(() => {}))
    return { result, abort }
  }
  try {
    const first = ask('s_first')
    const second = ask('s_second')
    assert.equal(opened.length, 2)
    assert.notEqual(opened[0].callId, opened[1].callId)
    assert.equal(answerAsk(opened[1].callId, 1, 'B'), true)
    assert.match((await second.result).content, /B/)
    assert.deepEqual(closed, [{ sessionId: 's_second', callId: opened[1].callId }])
    first.abort.abort()
    await assert.rejects(first.result, /中止/)
    assert.equal(closed.length, 2)
    assert.equal(answerAsk(opened[0].callId, 0, 'A'), false)
    assert.equal(answerAsk(opened[1].callId, 1, 'B'), false)

    // 只捕获这次 ask 注册的超时回调，仍使用真实 timer handle 验证 cleanup。
    const realSetTimeout = globalThis.setTimeout
    let expire: (() => void) | undefined
    let timed: ReturnType<typeof ask>
    try {
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        expire = callback
        return realSetTimeout(callback, delay)
      }) as typeof setTimeout
      timed = ask('s_timeout')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    assert.ok(expire)
    expire()
    await assert.rejects(timed.result, /超时/)
    assert.equal(closed.filter((item) => item.sessionId === 's_timeout').length, 1)
    timed.abort.abort()
    assert.equal(closed.length, 3)
    assert.equal(answerAsk(opened[2].callId, 0, 'A'), false)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await assert.rejects(askTool.run({ question: 'Cancelled', options: ['A', 'B'] }, {
      ...ctx, signal: alreadyAborted.signal
    }), /中止/)
    assert.equal(opened.length, 3)
    console.log('  ✓ 并发提问 ID 独立，回答/中止/超时各关闭一次，迟到回答无效')
  } finally {
    controllers.forEach((controller) => controller.abort())
    await Promise.allSettled(requests)
    bindAskDelivery(null)
    bindAskCloseDelivery(null)
  }
}
