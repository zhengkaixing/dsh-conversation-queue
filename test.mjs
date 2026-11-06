/**
 * 离线自测：不启动 DSH，用假 ctx 模拟 pre-step / turn-end 事件，
 * 验证闸门、FIFO、取消、关闭、子代理豁免和状态文件。
 *
 * 运行： node test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-test-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('./index.js')

// ---------------------------------------------------------------- 假 ctx

function createHost(options = {}) {
  const listeners = new Map()
  const logs = []
  const agents = []

  const registry = {
    roots: () => agents.filter((agent) => agent.owner === undefined),
    get: (id) => agents.find((agent) => agent.id === id),
    list: () => [...agents],
  }

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    on(name, listener, listenerOptions) {
      const list = listeners.get(name) ?? []
      list.push({ listener, options: listenerOptions })
      listeners.set(name, list)
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      return () => disposer?.()
    },
    get(name) {
      if (name === 'agents' && options.noRegistry !== true) return registry
      return undefined
    },
  }

  function makeAgent(id, owner) {
    const agent = { id, owner, disposed: false }
    agents.push(agent)
    return agent
  }

  /** 模拟瀑布派发：listener(payload, next) → next() 返回 fallback 结果 */
  async function preStep(agent, turn, step, signal) {
    const hooks = (listeners.get('agent/pre-step') ?? []).map((entry) => entry.listener)
    const payload = { agent, messages: [{ role: 'user', content: 'hi' }], turn, step, signal }
    let index = 0
    const fallback = () => 'fallback'
    const next = () => (index < hooks.length ? hooks[index++](payload, next) : fallback())
    return next()
  }

  function emitSessionEvent(session, event) {
    for (const entry of listeners.get('session/event') ?? []) entry.listener(session, event)
  }

  function emitAgentDisposed(agent) {
    for (const entry of listeners.get('agent/disposed') ?? []) entry.listener({ agent })
  }

  return { ctx, registry, makeAgent, preStep, emitSessionEvent, emitAgentDisposed, logs, agents }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const statusPath = path.join(tmpHome, 'conversation-queue.json')
const readStatus = () => JSON.parse(fs.readFileSync(statusPath, 'utf8'))

const results = []
function check(label, fn) {
  try {
    fn()
    results.push(['ok', label])
  } catch (error) {
    results.push(['fail', label, error])
  }
}

// ---------------------------------------------------------------- 用例 1：上限 + FIFO

{
  const host = createHost()
  apply(host.ctx, { maxConcurrent: 2, logAdmissions: true })

  const a = host.makeAgent('sess-a')
  const b = host.makeAgent('sess-b')
  const c = host.makeAgent('sess-c')
  const d = host.makeAgent('sess-d')

  const aDone = host.preStep(a, 1, 1)
  const bDone = host.preStep(b, 1, 1)
  let cDone = false
  let dDone = false
  host.preStep(c, 1, 1).then(() => { cDone = true })
  host.preStep(d, 1, 1).then(() => { dDone = true })

  await tick(5)
  check('前两个对话立刻拿到槽位', () => {
    assert.equal(readStatus().running, 2)
    assert.equal(readStatus().waiting, 2)
  })
  check('第三、四个对话被挂起', () => {
    assert.equal(cDone, false)
    assert.equal(dDone, false)
  })
  check('状态文件记录排队位置', () => {
    const status = readStatus()
    assert.deepEqual(status.queue.map((entry) => entry.id), ['sess-c', 'sess-d'])
    assert.deepEqual(status.queue.map((entry) => entry.position), [1, 2])
  })

  await host.emitSessionEvent({ id: 'sess-a' }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  await tick(5)
  check('A 结束后 C 按 FIFO 放行', () => {
    assert.equal(cDone, true)
    assert.equal(dDone, false)
    assert.equal(readStatus().running, 2)
  })

  await host.emitSessionEvent({ id: 'sess-b' }, { type: 'turn/end' })
  await tick(5)
  check('B 结束后 D 放行', () => {
    assert.equal(dDone, true)
    assert.equal(readStatus().running, 2)
    assert.equal(readStatus().waiting, 0)
  })

  await host.emitSessionEvent({ id: 'sess-c' }, { type: 'turn/end' })
  await host.emitSessionEvent({ id: 'sess-d' }, { type: 'turn/end' })
  await tick(5)
  check('全部结束后槽位清空', () => {
    assert.equal(readStatus().running, 0)
    assert.ok(aDone && bDone)
  })
}

// ---------------------------------------------------------------- 用例 2：非第一步 / 子代理不排队

{
  const host = createHost()
  apply(host.ctx, { maxConcurrent: 1, statusFile: path.join(tmpHome, 'case2.json') })

  const a = host.makeAgent('root-a')
  const child = host.makeAgent('child-a', a)

  await host.preStep(a, 1, 1)
  check('根对话占满唯一槽位', () => {
    assert.equal(host.logs.filter(([level]) => level === 'info').length > 0, true)
  })
  const step2 = await host.preStep(a, 1, 2)
  check('第 2 步不再闸门', () => assert.equal(step2, 'fallback'))
  const childResult = await host.preStep(child, 1, 1)
  check('子代理不受闸门限制', () => assert.equal(childResult, 'fallback'))
}

// ---------------------------------------------------------------- 用例 3：排队中取消

{
  const host = createHost()
  apply(host.ctx, { maxConcurrent: 1, statusFile: path.join(tmpHome, 'case3.json') })

  const a = host.makeAgent('cancel-a')
  const b = host.makeAgent('cancel-b')
  const controller = new AbortController()

  await host.preStep(a, 1, 1)
  const pending = host.preStep(b, 1, 1, controller.signal)
  await tick(5)
  check('B 在排队', () => assert.equal(readStatusFile(path.join(tmpHome, 'case3.json')).waiting, 1))

  controller.abort()
  await assert.rejects(pending)
  check('取消后从队列移除', () => {
    const status = readStatusFile(path.join(tmpHome, 'case3.json'))
    assert.equal(status.waiting, 0)
  })

  await host.emitSessionEvent({ id: 'cancel-a' }, { type: 'turn/end' })
}

// ---------------------------------------------------------------- 用例 4：排队中对话被关闭

{
  const host = createHost()
  apply(host.ctx, { maxConcurrent: 1, statusFile: path.join(tmpHome, 'case4.json') })

  const a = host.makeAgent('close-a')
  const b = host.makeAgent('close-b')

  await host.preStep(a, 1, 1)
  const pending = host.preStep(b, 1, 1)
  await tick(5)
  host.emitAgentDisposed(b)
  await assert.rejects(pending)
  check('关闭后从队列移除', () => {
    assert.equal(readStatusFile(path.join(tmpHome, 'case4.json')).waiting, 0)
  })
}

// ---------------------------------------------------------------- 用例 5：配置归一化

{
  const host = createHost()
  apply(host.ctx, { maxConcurrent: -3, enabled: 'yes' })
  check('非法并发数回落到默认 2', () => {
    const status = readStatusFile(path.join(tmpHome, 'conversation-queue.json'))
    assert.equal(status.maxConcurrent, 2)
    assert.equal(status.enabled, true)
  })
}

function readStatusFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ---------------------------------------------------------------- 汇总

let failed = 0
for (const [state, label, error] of results) {
  if (state === 'ok') console.log(`  ✔ ${label}`)
  else {
    failed += 1
    console.log(`  ✘ ${label}\n    ${error?.message ?? error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
fs.rmSync(tmpHome, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
