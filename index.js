/**
 * dsh-conversation-queue — 限制 Harness 同时“正在运行”的对话数量，超出的对话按先来后到排队等待。
 *
 * 核心机制（v1）：
 *   在 `agent/pre-step` 瀑布事件里，对“根对话”（非子代理）每个回合的第一步做闸门控制：
 *   拿到槽位才允许该回合真正开始；没拿到就挂起等待，直到别的对话回合结束（turn/end）释放槽位。
 *
 * 为什么在 pre-step 卡住能省内存：
 *   被卡的回合还没有进入请求循环（没有 llm 请求、没有上下文组装、没有流式输出），
 *   所以它不会为模型请求再分配大块内存，只是静静地等在队列里。
 *
 * 子代理（subagent / 后台任务派生的 agent）默认不排队：它们由父对话派生，
 *   如果也排队，父对话等子代理、子代理等槽位，就会互相锁死。
 *
 * 状态文件：默认写到 $DSH_HOME/conversation-queue.json，可随时查看谁在跑、谁在排队。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-conversation-queue'

/**
 * 不声明 inject：agents 服务只用来判断“这个 agent 是不是根对话”，
 * 运行时用 ctx.get('agents') 惰性读取（cordis 允许不声明就 get），
 * 声明成硬依赖反而会让插件在服务就绪前一直挂着不启动。
 */

const DEFAULTS = {
  /** 总开关，配置里写 enabled: false 可临时停用。 */
  enabled: true,
  /** 同时允许运行的对话数量。32G 内存建议 2，内存充裕可调到 3。 */
  maxConcurrent: 2,
  /** 子代理是否也参与排队（默认 false，避免父子互锁）。 */
  queueSubagents: false,
  /** 状态文件路径，留空 = $DSH_HOME/conversation-queue.json。 */
  statusFile: '',
  /** 运行期设置文件（小窗口写它来改并发数），留空 = $DSH_HOME/conversation-queue.settings.json。 */
  settingsFile: '',
  /** 是否把每次准入/排队写进日志。 */
  logAdmissions: true,
}

/** 小窗口写的运行期设置文件里认识的字段。 */
const SETTINGS_FIELDS = ['maxConcurrent', 'enabled']

const NOOP = () => {}

/** 加载痕迹：每次模块被 import（含 HMR 重载）都记一行，排障时先看它。 */
function traceLoad(stage, message) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    fs.mkdirSync(home, { recursive: true })
    fs.appendFileSync(path.join(home, 'conversation-queue.boot.log'), `${new Date().toISOString()} pid=${process.pid} ${stage} ${message}\n`, 'utf8')
  } catch {
    /* 诊断日志写不进去不影响主流程 */
  }
}

traceLoad('import', 'module evaluated')

export function apply(ctx, config) {
  try {
    return start(ctx, config)
  } catch (error) {
    traceLoad('apply-failed', String(error?.stack ?? error))
    throw error
  }
}

function start(ctx, config) {
  const cfg = normalizeConfig(config)
  const logger = ctx.logger

  /** @type {Map<string, { agent: any, since: number, turn: number }>} 持有槽位的对话 */
  const held = new Map()
  /** @type {Array<{ id: string, agent: any, turn: number, since: number, signal?: AbortSignal, resolve: () => void, reject: (error: any) => void, abort?: () => void, done: boolean }>} */
  const queue = []
  /** @type {Map<string, string>} 会话标题缓存（来自 session/title 事件） */
  const titles = new Map()
  let admittedTotal = 0
  let queuedTotal = 0
  let disposed = false

  const statusPath = resolveStatusPath(cfg)
  const settingsPath = resolveSettingsPath(cfg)

  /** 运行期覆盖值（来自 settings 文件）；null 表示用配置文件里的值。 */
  let runtimeMax = null
  let runtimeEnabled = null
  let settingsStamp = ''

  /** 当前生效的并发上限。 */
  function maxNow() {
    return runtimeMax === null ? cfg.maxConcurrent : runtimeMax
  }

  /** 当前是否启用限制。 */
  function enabledNow() {
    return runtimeEnabled === null ? cfg.enabled : runtimeEnabled
  }

  // ---------------------------------------------------------------- 工具函数

  function info(message) {
    if (typeof logger?.info === 'function') logger.info(message)
  }

  function warn(message) {
    if (typeof logger?.warn === 'function') logger.warn(message)
  }

  function registry() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 只有“根对话”才排队。
   * 根对话 = 注册表里 owner === undefined 的 agent（用户开的会话、后台任务）；
   * 子代理 = 由某个父 agent 派生，排队会死锁。
   */
  function isGatedAgent(agent) {
    if (cfg.queueSubagents) return true
    if (!agent) return false
    const agents = registry()
    if (!agents || typeof agents.roots !== 'function') return true
    try {
      return agents.roots().some((root) => root?.id === agent.id)
    } catch {
      return true
    }
  }

  function isAlive(agent) {
    if (!agent || agent.disposed === true) return false
    const agents = registry()
    if (!agents || typeof agents.get !== 'function') return true
    try {
      return agents.get(agent.id) === agent
    } catch {
      return true
    }
  }

  function resolveLabel(agent) {
    const id = String(agent?.id ?? 'unknown')
    return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
  }

  /** 记住一个会话的标题（状态条用它显示“进行中对话”的名字）。 */
  function rememberTitle(sessionId, title) {
    if (typeof sessionId !== 'string' || !sessionId) return
    const text = typeof title === 'string' ? title.trim() : ''
    if (!text) {
      titles.delete(sessionId)
      return
    }
    titles.set(sessionId, text.length > 60 ? `${text.slice(0, 60)}…` : text)
    // 标题缓存只用于展示，别无限长。
    if (titles.size > 500) {
      const oldest = titles.keys().next().value
      if (oldest !== undefined && oldest !== sessionId) titles.delete(oldest)
    }
  }

  /**
   * 取一个对话的显示名：先看缓存（session/title 事件），再问 sessionTitle 服务，
   * 最后退回会话事件里的最后一条 session/title。都拿不到就返回空串，由前端显示短 id。
   */
  function titleOf(agent) {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || !sessionId) return ''
    const cached = titles.get(sessionId)
    if (cached !== undefined) return cached

    let title = ''
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
      if (service && typeof service.get === 'function' && agent?.session) {
        const value = service.get(agent.session)
        if (typeof value === 'string') title = value
      }
    } catch {
      /* 没装 sessionTitle 插件时忽略 */
    }
    if (!title) {
      try {
        const events = agent?.session?.ownEvents?.() ?? []
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
            title = event.data.title
            break
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (title) {
      rememberTitle(sessionId, title)
      return titles.get(sessionId) ?? ''
    }
    return ''
  }

  // ---------------------------------------------------------------- 状态文件

  function writeStatus(extra) {
    const now = Date.now()
    const payload = {
      updatedAt: new Date(now).toISOString(),
      pid: process.pid,
      enabled: enabledNow(),
      maxConcurrent: maxNow(),
      configured: { enabled: cfg.enabled, maxConcurrent: cfg.maxConcurrent },
      settingsFile: settingsPath,
      settingsStamp,
      running: held.size,
      waiting: queue.length,
      totals: { admitted: admittedTotal, queued: queuedTotal },
      active: [...held.entries()].map(([id, item]) => ({
        id,
        title: titleOf(item.agent),
        turn: item.turn,
        since: new Date(item.since).toISOString(),
        runningMs: now - item.since,
      })),
      queue: queue.map((entry, index) => ({
        position: index + 1,
        id: entry.id,
        title: titleOf(entry.agent),
        turn: entry.turn,
        since: new Date(entry.since).toISOString(),
        waitingMs: now - entry.since,
      })),
      ...(extra === undefined ? {} : { lastEvent: extra }),
    }
    try {
      const tmp = `${statusPath}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
      fs.renameSync(tmp, statusPath)
    } catch (error) {
      // 状态文件只是可观测性，写不进去不能影响排队逻辑。
      void error
    }
  }

  // ---------------------------------------------------------------- 运行期设置
  // 资源小窗口把 maxConcurrent 写进 settings 文件，插件轮询后热应用：
  // 既不用改 YAML，也不用重启 DSH。文件不存在 = 用配置文件里的值。
  function readSettings() {
    let text
    try {
      text = fs.readFileSync(settingsPath, 'utf8')
    } catch {
      return null
    }
    // PowerShell 5.1 的 -Encoding UTF8 / Set-Content 会带 BOM，JSON.parse 会因此失败。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (!text.trim()) return null
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      // 可能只是写了一半，保持现有取值，等下一次轮询。
      return { text, raw: null }
    }
    const next = { text, raw: raw && typeof raw === 'object' ? raw : null }
    if (next.raw && next.raw.maxConcurrent !== undefined) {
      const value = Math.floor(Number(next.raw.maxConcurrent))
      // 非法值当作“没写这个字段”，不会把上限打回配置值。
      if (Number.isFinite(value) && value >= 1) next.maxConcurrent = Math.min(value, 32)
    }
    if (next.raw && next.raw.enabled !== undefined) next.enabled = Boolean(next.raw.enabled)
    return next
  }

  function applySettings(reason) {
    if (disposed) return
    const next = readSettings()

    if (next === null) {
      // 文件被删掉 / 空文件 = 回到配置文件里的值。
      if (runtimeMax === null && runtimeEnabled === null && settingsStamp === '') return
      runtimeMax = null
      runtimeEnabled = null
      settingsStamp = ''
      info(`conversation-queue: 设置文件已清空，回到配置值 maxConcurrent=${maxNow()} enabled=${enabledNow()}（${reason}）`)
      writeStatus('settings')
      pump()
      return
    }

    if (next.text === settingsStamp) return
    settingsStamp = next.text
    if (next.raw === null) {
      warn('conversation-queue: 设置文件不是合法 JSON，暂时忽略（等下次轮询）')
      return
    }
    if (next.maxConcurrent !== undefined) runtimeMax = next.maxConcurrent
    if (next.enabled !== undefined) runtimeEnabled = next.enabled
    info(`conversation-queue: 运行期设置更新 -> maxConcurrent=${maxNow()} enabled=${enabledNow()}（${reason}）`)
    writeStatus('settings')
    pump()
  }

  // ---------------------------------------------------------------- 队列核心

  function hold(agent, turn) {
    held.set(agent.id, { agent, since: Date.now(), turn })
    admittedTotal += 1
    if (cfg.logAdmissions) info(`conversation-queue: 放行 ${resolveLabel(agent)}（${held.size}/${maxNow()} 运行中）`)
  }

  function rejectEntry(entry, error) {
    if (entry.done) return
    entry.done = true
    detachAbort(entry)
    entry.reject(error)
  }

  function detachAbort(entry) {
    if (entry.signal && entry.abort) {
      try {
        entry.signal.removeEventListener('abort', entry.abort)
      } catch {
        /* ignore */
      }
      entry.abort = undefined
    }
  }

  function removeFromQueue(entry) {
    const index = queue.indexOf(entry)
    if (index >= 0) {
      queue.splice(index, 1)
      return true
    }
    return false
  }

  /** 把空闲槽位按 FIFO 分给等待中的对话。 */
  function pump() {
    while (!disposed && held.size < maxNow() && queue.length > 0) {
      const entry = queue.shift()
      if (entry.done) continue

      // 已经取消 / 已经销毁的对话直接跳过，不占名额。
      if (entry.signal?.aborted === true) {
        rejectEntry(entry, entry.signal.reason ?? abortError())
        continue
      }
      if (!isAlive(entry.agent)) {
        rejectEntry(entry, new Error('conversation-queue: 排队期间对话已关闭'))
        continue
      }

      entry.done = true
      detachAbort(entry)
      hold(entry.agent, entry.turn)
      entry.resolve()
    }
    writeStatus()
  }

  function acquire(agent, turn, signal) {
    // 理论上同一个 agent 不会重复进入（回合串行），这里做一次自愈：已有槽位就沿用。
    if (held.has(agent.id)) {
      held.get(agent.id).turn = turn
      return Promise.resolve()
    }
    // 队列非空时也不插队，保证严格 FIFO。
    if (held.size < maxNow() && queue.length === 0) {
      hold(agent, turn)
      writeStatus()
      return Promise.resolve()
    }

    const entry = {
      id: agent.id,
      agent,
      turn,
      since: Date.now(),
      signal,
      done: false,
      resolve: NOOP,
      reject: NOOP,
    }
    queuedTotal += 1

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })

    if (signal) {
      if (signal.aborted === true) {
        rejectEntry(entry, signal.reason ?? abortError())
        promise.catch(NOOP)
        return promise
      }
      entry.abort = () => {
        if (entry.done) return
        if (!removeFromQueue(entry)) return
        rejectEntry(entry, signal.reason ?? abortError())
        writeStatus()
        // 取消一个排队中的对话不会腾出槽位，但可能让 pump 有机会跳过它。
        pump()
      }
      try {
        signal.addEventListener('abort', entry.abort, { once: true })
      } catch {
        entry.abort = undefined
      }
    }

    queue.push(entry)
    // 避免“已关闭对话的拒绝”变成未处理拒绝：派生一条带 catch 的链即可。
    promise.catch(NOOP)
    if (cfg.logAdmissions) {
      info(`conversation-queue: ${resolveLabel(agent)} 排队中（前面还有 ${queue.length - 1} 个，${held.size}/${maxNow()} 运行中）`)
    }
    writeStatus()
    return promise
  }

  /** 释放某个对话占用的槽位（幂等）。 */
  function release(agentId, reason) {
    const item = held.get(agentId)
    if (!item) return false
    held.delete(agentId)
    if (cfg.logAdmissions) info(`conversation-queue: 释放 ${resolveLabel(item.agent)}（${reason}），${held.size}/${maxNow()} 运行中`)
    pump()
    return true
  }

  function abortError() {
    const error = new Error('conversation-queue: 排队中的对话被取消')
    error.name = 'AbortError'
    return error
  }

  // ---------------------------------------------------------------- 事件监听

  // 1) 闸门：每个回合的第一步（step === 1）在真正开始前抢槽位。
  //    global: true —— 这是一条跨作用域的全局触发，必须显式声明，否则收不到其它会话的事件。
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const agent = payload?.agent
      const step = payload?.step ?? payload?.position?.step
      if (disposed || !enabledNow() || !agent || step !== 1) return next()
      if (!isGatedAgent(agent)) return next()

      try {
        await acquire(agent, payload?.turn ?? payload?.position?.turn, payload?.signal)
      } catch (error) {
        // 取消/关闭：把结果交回请求循环，由它按取消语义收尾（不会真正发起模型请求）。
        throw error
      }

      try {
        return await next()
      } catch (error) {
        // 闸门之后的组装/校验失败 → 这个回合不会产生 turn/end 的常规路径时也要归还槽位。
        release(agent.id, 'pre-step 失败')
        throw error
      }
    },
    { prepend: true, global: true },
  )

  // 2) 回合结束：turn/end 一定会来（包括 reject / 取消 / 抛错的 finally 路径），在这里释放槽位。
  //    同时顺手记下会话标题，状态条用它显示“进行中对话”的名字。
  ctx.on(
    'session/event',
    (session, event) => {
      const type = event?.type
      const id = session?.id ?? event?.data?.sessionId
      if (type === 'session/title') {
        rememberTitle(id, event?.data?.title)
        return
      }
      if (type !== 'turn/end') return
      if (typeof id === 'string') release(id, 'turn/end')
    },
    { global: true },
  )

  // 3) 对话被关闭：既可能持有槽位，也可能还在排队。
  ctx.on(
    'agent/disposed',
    ({ agent } = {}) => {
      if (!agent?.id) return
      release(agent.id, 'agent/disposed')
      for (const entry of [...queue]) {
        if (entry.id !== agent.id) continue
        removeFromQueue(entry)
        rejectEntry(entry, new Error('conversation-queue: 排队期间对话已关闭'))
      }
      writeStatus()
    },
    { global: true },
  )

  // ---------------------------------------------------------------- 资源接口
  // 浏览器端状态条（client.js，注册在 shell.bottom）通过这两个 HTTP 接口拿数据、改上限。
  const resourceApi = startResourceApi({
    ctx,
    settingsPath,
    gate: {
      enabled: enabledNow,
      maxConcurrent: maxNow,
      running: () => held.size,
      waiting: () => queue.length,
      active: () =>
        [...held.entries()].map(([id, item]) => ({
          id,
          title: titleOf(item.agent),
          turn: item.turn,
          runningMs: Date.now() - item.since,
        })),
      queued: () =>
        queue.map((entry, index) => ({
          id: entry.id,
          title: titleOf(entry.agent),
          position: index + 1,
          waitingMs: Date.now() - entry.since,
        })),
      reload: () => applySettings('UI 设置'),
    },
  })

  // ---------------------------------------------------------------- 生命周期

  let settingsTimer = null

  function teardown() {
    disposed = true
    if (settingsTimer) clearInterval(settingsTimer)
    resourceApi.dispose()
    traceLoad('dispose', 'plugin unloaded')
    for (const entry of [...queue]) {
      removeFromQueue(entry)
      rejectEntry(entry, new Error('conversation-queue: 插件已卸载'))
    }
    held.clear()
    writeStatus('unloaded')
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => teardown)

  // 轮询 settings 文件（1.5s 一次），unref 保证不会拖住进程退出。
  settingsTimer = setInterval(() => applySettings('settings 文件变化'), 1500)
  if (typeof settingsTimer.unref === 'function') settingsTimer.unref()

  applySettings('启动')
  writeStatus('loaded')
  traceLoad('apply-ok', `maxConcurrent=${maxNow()} status=${statusPath} settings=${settingsPath}`)
  info(`conversation-queue: 已启用，最多 ${maxNow()} 个对话同时运行；状态文件 ${statusPath}`)

  // 返回副本便于调试（不参与运行）。
  return {
    get status() {
      return { running: held.size, waiting: queue.length, maxConcurrent: cfg.maxConcurrent }
    },
  }
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const value = (key) => (input[key] === undefined || input[key] === null ? DEFAULTS[key] : input[key])

  let maxConcurrent = Number(value('maxConcurrent'))
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) maxConcurrent = DEFAULTS.maxConcurrent
  maxConcurrent = Math.floor(maxConcurrent)

  const statusFile = typeof value('statusFile') === 'string' ? value('statusFile').trim() : ''
  const settingsFile = typeof value('settingsFile') === 'string' ? value('settingsFile').trim() : ''

  return {
    enabled: Boolean(value('enabled')),
    maxConcurrent,
    queueSubagents: Boolean(value('queueSubagents')),
    statusFile,
    settingsFile,
    logAdmissions: Boolean(value('logAdmissions')),
  }
}

function resolveStatusPath(cfg) {
  if (cfg.statusFile) return path.resolve(cfg.statusFile)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'conversation-queue.json')
}

function resolveSettingsPath(cfg) {
  if (cfg.settingsFile) return path.resolve(cfg.settingsFile)
  // 自定义了状态文件（测试/tools）时，设置文件跟着放同一个目录，避免污染真实 DSH_HOME。
  if (cfg.statusFile) return path.join(path.dirname(path.resolve(cfg.statusFile)), 'conversation-queue.settings.json')
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'conversation-queue.settings.json')
}

// ================================================================== 资源接口
// 浏览器端状态条需要“提交内存”这类只有 Windows API 才给的数据。Node 没有对应接口，
// 所以起一个常驻 PowerShell 采样进程（sampler.ps1），每 2 秒打一行 JSON，这里缓存最新值。
// 采样进程按需启动：没人打开页面就不会多一个进程。

const DISK_CACHE_MS = 5000
const SAMPLE_FRESH_MS = 15000
/** 卷标/文件系统变化很少，缓存 5 分钟，避免反复起 PowerShell。 */
const VOLUME_CACHE_MS = 300000
/** 系统盘：Windows 装在哪个盘就标哪个（默认 C:）。 */
const SYSTEM_DRIVE = String(process.env.SystemDrive ?? 'C:').toUpperCase()

function startResourceApi(options) {
  const { ctx, settingsPath, gate } = options

  const disposers = []
  let sampler = null
  let sample = null
  let samplerError = ''
  let samplerBuffer = ''
  let diskCache = null
  let diskCachedAt = 0
  let registered = false
  let retryTimer = null
  let retries = 0
  /** @type {Map<string, { label: string, fileSystem: string }>} 盘符 → 卷标 */
  let volumes = new Map()
  let volumesAt = 0
  let volumeProcess = null

  /**
   * webServer 往往比插件本体晚就绪（web 包的服务在启动后期才 fulfill），
   * 所以不能只在 apply 时取一次：先试一次，拿不到就监听服务上线事件 + 定时重试。
   */
  function resolveWebServer() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    } catch {
      return undefined
    }
  }

  function ensureSampler() {
    if (process.platform !== 'win32') return
    if (sampler && sampler.exitCode === null && !sampler.killed) return

    let script
    try {
      script = fileURLToPath(new URL('./sampler.ps1', import.meta.url))
    } catch (error) {
      samplerError = String(error?.message ?? error)
      return
    }

    try {
      sampler = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', '2000'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch (error) {
      samplerError = String(error?.message ?? error)
      sampler = null
      return
    }

    sampler.on('error', (error) => {
      samplerError = String(error?.message ?? error)
    })
    sampler.on('exit', () => {
      sampler = null
    })
    if (sampler.stdout) {
      sampler.stdout.setEncoding('utf8')
      sampler.stdout.on('data', (chunk) => {
        samplerBuffer += chunk
        let index
        while ((index = samplerBuffer.indexOf('\n')) >= 0) {
          const line = samplerBuffer.slice(0, index).trim()
          samplerBuffer = samplerBuffer.slice(index + 1)
          if (!line.startsWith('{')) continue
          try {
            const parsed = JSON.parse(line)
            if (parsed && Number(parsed.physTotal) > 0) {
              sample = parsed
              samplerError = ''
            }
          } catch {
            /* 半行输出，等下一次 */
          }
        }
        if (samplerBuffer.length > 8192) samplerBuffer = ''
      })
    }
  }

  /**
   * 卷标/文件系统只在第一次用到时取一次，之后每 5 分钟刷一次。
   * 失败就保持空表——状态条会退化成只显示盘符和容量。
   */
  function ensureVolumes() {
    if (process.platform !== 'win32') return
    const now = Date.now()
    if (volumesAt !== 0 && now - volumesAt < VOLUME_CACHE_MS) return
    if (volumeProcess !== null) return

    let script
    try {
      script = fileURLToPath(new URL('./volumes.ps1', import.meta.url))
    } catch {
      volumesAt = now
      return
    }

    try {
      volumeProcess = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      volumeProcess = null
      volumesAt = now
      return
    }

    let buffer = ''
    volumeProcess.stdout?.setEncoding('utf8')
    volumeProcess.stdout?.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 16384) buffer = buffer.slice(-16384)
    })
    volumeProcess.on('error', () => {
      volumeProcess = null
      volumesAt = Date.now()
    })
    volumeProcess.on('exit', () => {
      volumeProcess = null
      volumesAt = Date.now()
      const line = buffer
        .split('\n')
        .map((item) => item.trim())
        .filter((item) => item.startsWith('[') || item.startsWith('{'))
        .join('')
      if (!line) return
      try {
        const parsed = JSON.parse(line)
        const list = Array.isArray(parsed) ? parsed : [parsed]
        const next = new Map()
        for (const item of list) {
          const name = typeof item?.name === 'string' ? item.name.toUpperCase() : ''
          if (!name) continue
          next.set(name, {
            label: typeof item?.label === 'string' ? item.label.trim() : '',
            fileSystem: typeof item?.fileSystem === 'string' ? item.fileSystem.trim() : '',
          })
        }
        if (next.size > 0) volumes = next
      } catch {
        /* 卷标只是展示用，解析失败就算了 */
      }
    })
  }

  function volumeOf(name) {
    return volumes.get(String(name).toUpperCase()) ?? { label: '', fileSystem: '' }
  }

  function percentOf(used, limit) {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
    return Math.round((used / limit) * 1000) / 10
  }

  function memorySnapshot() {
    ensureSampler()
    const total = os.totalmem()
    const avail = os.freemem()
    const used = Math.max(0, total - avail)

    const fresh = sample !== null && Number.isFinite(sample.at) && Date.now() - sample.at < SAMPLE_FRESH_MS
    const commitLimit = fresh ? Number(sample.commitLimit) : null
    const commitAvail = fresh ? Number(sample.commitAvail) : null
    const commitUsed = commitLimit !== null && commitAvail !== null ? Math.max(0, commitLimit - commitAvail) : null

    return {
      totalBytes: total,
      availBytes: avail,
      usedBytes: used,
      usedPercent: percentOf(used, total),
      commitLimitBytes: commitLimit,
      commitUsedBytes: commitUsed,
      commitPercent: commitUsed === null ? null : percentOf(commitUsed, commitLimit),
      load: fresh ? sample.load : null,
      sampler: samplerError ? `error: ${samplerError}` : sample ? 'ok' : 'starting',
    }
  }

  function diskSnapshot() {
    const now = Date.now()
    ensureVolumes()
    if (diskCache !== null && now - diskCachedAt < DISK_CACHE_MS) return diskCache

    const disks = []
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const name = `${letter}:`
      let stats
      try {
        stats = fs.statfsSync(`${name}\\`)
      } catch {
        continue
      }
      const blockSize = Number(stats.bsize)
      const total = Number(stats.blocks) * blockSize
      const free = Number(stats.bavail) * blockSize
      if (!Number.isFinite(total) || total <= 0) continue
      const volume = volumeOf(name)
      disks.push({
        name,
        label: volume.label,
        fileSystem: volume.fileSystem,
        system: name === SYSTEM_DRIVE,
        totalBytes: total,
        freeBytes: free,
        usedBytes: Math.max(0, total - free),
        usedPercent: percentOf(total - free, total),
      })
    }

    diskCache = disks
    diskCachedAt = now
    return disks
  }

  function statusPayload() {
    return {
      ok: true,
      time: new Date().toISOString(),
      platform: process.platform,
      memory: memorySnapshot(),
      disks: diskSnapshot(),
      gate: {
        enabled: gate.enabled(),
        maxConcurrent: gate.maxConcurrent(),
        running: gate.running(),
        waiting: gate.waiting(),
        active: gate.active(),
        queue: gate.queued(),
      },
    }
  }

  function respond(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 8192) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function writeSettingsFile(next) {
    let current = {}
    try {
      const text = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
      if (text.trim()) {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') current = parsed
      }
    } catch {
      current = {}
    }
    const payload = { ...current, ...next, updatedAt: new Date().toISOString(), source: 'dsh-ui' }
    const directory = path.dirname(settingsPath)
    if (directory) fs.mkdirSync(directory, { recursive: true })
    const tmp = `${settingsPath}.tmp`
    // 不写 BOM：插件和本函数都用 JSON.parse 直接读。
    fs.writeFileSync(tmp, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
    fs.renameSync(tmp, settingsPath)
    return payload
  }

  async function handleStatus(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        respond(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      respond(res, 200, statusPayload())
    } catch (error) {
      respond(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  async function handleLimit(req, res) {
    try {
      if (req.method !== 'POST') {
        respond(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const raw = await readBody(req)
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        respond(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }

      const next = {}
      if (body?.maxConcurrent !== undefined) {
        const value = Math.floor(Number(body.maxConcurrent))
        if (!Number.isFinite(value) || value < 1 || value > 8) {
          respond(res, 400, { ok: false, error: 'maxConcurrent 必须是 1~8 的整数' })
          return
        }
        next.maxConcurrent = value
      }
      if (body?.enabled !== undefined) next.enabled = Boolean(body.enabled)
      if (Object.keys(next).length === 0) {
        respond(res, 400, { ok: false, error: '没有可写入的字段（maxConcurrent / enabled）' })
        return
      }

      const written = writeSettingsFile(next)
      gate.reload()
      respond(res, 200, {
        ok: true,
        settingsFile: settingsPath,
        maxConcurrent: gate.maxConcurrent(),
        enabled: gate.enabled(),
        written,
      })
    } catch (error) {
      respond(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  function registerRoutes() {
    if (registered) return true
    const webServer = resolveWebServer()
    if (!webServer || typeof webServer.register !== 'function') return false
    try {
      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-resource/status', handler: handleStatus }))
      disposers.push(webServer.register({ kind: 'exact', path: '/dsh-resource/limit', handler: handleLimit }))
      registered = true
      traceLoad('resources-ok', '/dsh-resource/status + /dsh-resource/limit 已注册')
      return true
    } catch (error) {
      traceLoad('resources-failed', String(error?.message ?? error))
      return true
    }
  }

  if (!registerRoutes()) {
    // cordis 在服务上线时会广播 internal/service；同时留一个定时重试兜底。
    try {
      ctx.on(
        'internal/service',
        (name) => {
          if (name !== 'webServer') return
          if (registerRoutes() && retryTimer) {
            clearInterval(retryTimer)
            retryTimer = null
          }
        },
        { global: true },
      )
    } catch {
      /* 旧版 cordis 没有这个事件时靠定时重试 */
    }
    retryTimer = setInterval(() => {
      retries += 1
      if (registerRoutes() || retries > 120) {
        if (retryTimer) clearInterval(retryTimer)
        retryTimer = null
        if (retries > 120) traceLoad('resources-skip', 'webServer 始终没出现，跳过资源接口')
      }
    }, 1000)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  return {
    dispose() {
      if (retryTimer) {
        clearInterval(retryTimer)
        retryTimer = null
      }
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          /* ignore */
        }
      }
      disposers.length = 0
      if (sampler) {
        try {
          sampler.kill()
        } catch {
          /* ignore */
        }
        sampler = null
      }
      if (volumeProcess) {
        try {
          volumeProcess.kill()
        } catch {
          /* ignore */
        }
        volumeProcess = null
      }
    },
  }
}
