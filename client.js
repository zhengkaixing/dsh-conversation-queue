/**
 * dsh-conversation-queue 的浏览器端：底部全局状态条（内存 / 提交内存 / 各盘剩余 / 并发闸门）。
 *
 * 宿主侧（index.js）在 /dsh-resource/status 和 /dsh-resource/limit 上提供数据与写入；
 * 这里只负责每 3 秒拉一次、渲染成一条 26px 高的状态条，点击 −/+ 直接改并发上限。
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const STATUS_URL = '/dsh-resource/status'
    const LIMIT_URL = '/dsh-resource/limit'
    const POLL_MS = 3000
    const MIN_LIMIT = 1
    const MAX_LIMIT = 8

    const CSS = `
.dsh-res-strip{display:flex;align-items:center;gap:14px;height:26px;padding:0 14px;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-variant-numeric:tabular-nums;user-select:none;white-space:nowrap;box-sizing:border-box}
.dsh-res-strip .seg{display:inline-flex;align-items:center;gap:6px;flex:none}
.dsh-res-strip .lbl{color:var(--dsw-alias-label-tertiary)}
.dsh-res-strip .val{color:var(--dsw-alias-label-primary)}
.dsh-res-strip .bar{position:relative;width:44px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;flex:none}
.dsh-res-strip .bar>i{position:absolute;top:0;bottom:0;left:0;border-radius:2px;background:currentColor;transition:width .35s ease}
.dsh-res-strip .sep{width:1px;height:12px;background:var(--dsw-alias-border-l2);flex:none}
.dsh-res-strip .grow{flex:1 1 auto}
.dsh-res-strip .btn{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:0;font-family:inherit}
.dsh-res-strip .btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-res-strip .btn:disabled{opacity:.4;cursor:default}
.dsh-res-strip .limit{min-width:12px;text-align:center;color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-res-strip .warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-res-strip .bad{color:var(--dsw-alias-state-error-primary)}
.dsh-res-strip .idle{color:var(--dsw-alias-label-tertiary)}
.dsh-res-strip .hover{position:relative;cursor:default;outline:none;border-radius:6px}
.dsh-res-strip .hover:hover,.dsh-res-strip .hover:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-res-strip .pop{position:fixed;display:block;min-width:230px;max-width:340px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 10px 28px rgba(0,0,0,.22);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;white-space:normal;z-index:60;text-align:left}
.dsh-res-strip .pop .ph{color:var(--dsw-alias-label-primary);font-weight:600;margin-bottom:5px;font-size:11.5px}
.dsh-res-strip .pop .row{display:flex;justify-content:space-between;gap:14px}
.dsh-res-strip .pop .row>.k{color:var(--dsw-alias-label-tertiary);flex:none}
.dsh-res-strip .pop .row>.v{color:var(--dsw-alias-label-primary);text-align:right;font-variant-numeric:tabular-nums}
.dsh-res-strip .pop .note{margin-top:6px;color:var(--dsw-alias-label-tertiary);white-space:normal}
.dsh-res-strip .pop ul{margin:5px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;max-height:190px;overflow:auto}
.dsh-res-strip .pop li{display:flex;justify-content:space-between;gap:14px;align-items:baseline}
.dsh-res-strip .pop li>.t{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}
.dsh-res-strip .pop li>.t.q{color:var(--dsw-alias-label-secondary)}
.dsh-res-strip .pop li>.ms{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
.dsh-res-strip .pop .empty{color:var(--dsw-alias-label-tertiary)}

/* ---- 设置页里的“资源与并发”卡片（Plugins → 资源与并发） ---- */
.dsh-res-sum{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.dsh-res-page{display:flex;flex-direction:column;gap:16px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dsh-res-page h4{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-res-page .hint{color:var(--dsw-alias-label-tertiary);margin-top:4px}
.dsh-res-page .rows{display:flex;flex-direction:column;gap:3px;max-width:520px}
.dsh-res-page .rows>.r{display:flex;justify-content:space-between;gap:18px}
.dsh-res-page .rows>.r>.k{color:var(--dsw-alias-label-tertiary)}
.dsh-res-page .rows>.r>.v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-res-page .warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-res-page .bad{color:var(--dsw-alias-state-error-primary)}
.dsh-res-page table{border-collapse:collapse;width:100%;max-width:620px;font-variant-numeric:tabular-nums}
.dsh-res-page th,.dsh-res-page td{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:400}
.dsh-res-page th{color:var(--dsw-alias-label-tertiary);font-size:11px;border-bottom-color:var(--dsw-alias-border-l2)}
.dsh-res-page th.num,.dsh-res-page td.num{text-align:right}
.dsh-res-page .limitRow{display:flex;align-items:center;gap:8px;margin:2px 0 10px}
.dsh-res-page .limitRow .lbl{color:var(--dsw-alias-label-tertiary)}
.dsh-res-page .limitRow .num{min-width:18px;text-align:center;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-res-page .btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1;padding:0;font-family:inherit}
.dsh-res-page .btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-res-page .btn:disabled{opacity:.4;cursor:default}
.dsh-res-page ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;max-width:620px}
.dsh-res-page li{display:flex;justify-content:space-between;gap:18px;align-items:baseline}
.dsh-res-page li>.t{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-res-page li>.ms{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}
.dsh-res-page .empty{color:var(--dsw-alias-label-tertiary)}
.dsh-res-page .problem{color:var(--dsw-alias-state-error-primary)}
`

    const TAG_ID = '@deepseek-ai/dsh-conversation-queue/strip.css'

    /** 只注入一次样式；卸载时不移除，重新挂载时复用。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      const selector = `style[data-plugin-css=${JSON.stringify(TAG_ID)}]`
      if (document.querySelector(selector)) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', TAG_ID)
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function gb(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
      return `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)}G`
    }

    function toneFor(percent) {
      if (!Number.isFinite(percent)) return ''
      if (percent >= 88) return 'bad'
      if (percent >= 80) return 'warn'
      return ''
    }

    /** 127.4 GB：悬浮面板里用更精确的写法。 */
    function gbFull(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
      return `${(bytes / 1024 ** 3).toFixed(1)} GB`
    }

    /** 12 秒 / 2 分 13 秒 / 1 小时 02 分 */
    function duration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      const total = Math.round(ms / 1000)
      if (total < 60) return `${total} 秒`
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
      return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
    }

    function shortId(id) {
      const text = String(id ?? '')
      return text.length > 12 ? `${text.slice(0, 5)}…${text.slice(-5)}` : text
    }

    /**
     * 悬浮解释：面板用 position:fixed 画在视口里，避免被 shell.bottom 的 overflow 裁掉。
     * 坐标在鼠标进入 / 键盘聚焦时算一次，离开就卸载。
     */
    function Hover(props) {
      const className = `seg hover ${props.className ?? ''}`.trim()
      const ref = React.useRef(null)
      const [pos, setPos] = useState(null)
      const open = () => {
        const el = ref.current
        if (!el || typeof window === 'undefined') return
        const rect = el.getBoundingClientRect()
        const width = Math.min(340, Math.max(230, window.innerWidth - 24))
        const right = Math.min(window.innerWidth - 12, rect.right)
        setPos({
          left: Math.max(12, Math.round(right - width)),
          bottom: Math.round(window.innerHeight - rect.top + 9),
          width: Math.round(width),
        })
      }
      const close = () => setPos(null)
      return h(
        'span',
        {
          ref,
          className,
          tabIndex: 0,
          onMouseEnter: open,
          onMouseLeave: close,
          onFocus: open,
          onBlur: close,
        },
        props.children,
        pos
          ? h(
              'div',
              { className: 'pop', style: { left: `${pos.left}px`, bottom: `${pos.bottom}px`, width: `${pos.width}px` } },
              ...props.pop,
            )
          : null,
      )
    }

    function Row(props) {
      return h('div', { className: 'row' }, h('span', { className: 'k' }, props.k), h('span', { className: 'v' }, props.v))
    }

    function Segment(props) {
      const { label, value, percent, bar, title } = props
      const tone = toneFor(percent)
      return h(
        'span',
        { className: `seg ${tone}`, title: title ?? '' },
        h('span', { className: 'lbl' }, label),
        h('span', { className: 'val' }, value),
        bar && Number.isFinite(percent)
          ? h('span', { className: 'bar' }, h('i', { style: { width: `${Math.min(100, Math.max(0, percent))}%` } }))
          : null,
      )
    }

    function ResourceStrip() {
      const [data, setData] = useState(null)
      const [migrated, setMigrated] = useState(false)
      const [problem, setProblem] = useState('')

      useEffect(() => {
        ensureStyle()
        let alive = true
        let timer = null

        const tick = async () => {
          try {
            const response = await fetch(STATUS_URL, { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (!alive) return
            setData(json)
            setProblem('')
          } catch (error) {
            if (!alive) return
            setProblem(String(error?.message ?? error))
          }
          if (alive) timer = setTimeout(tick, POLL_MS)
        }

        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      const changeLimit = useCallback(
        async (delta) => {
          const current = data?.gate?.maxConcurrent
          if (typeof current !== 'number' || migrated) return
          const next = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, current + delta))
          if (next === current) return
          setMigrated(true)
          try {
            const response = await fetch(LIMIT_URL, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ maxConcurrent: next }),
            })
            const json = await response.json().catch(() => ({}))
            if (!response.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${response.status}`)
            setData((previous) =>
              previous && previous.gate ? { ...previous, gate: { ...previous.gate, maxConcurrent: next } } : previous,
            )
            setProblem('')
          } catch (error) {
            setProblem(String(error?.message ?? error))
          } finally {
            setMigrated(false)
          }
        },
        [data, migrated],
      )

      if (problem && !data) {
        return h('div', { className: 'dsh-res-strip' }, h('span', { className: 'seg warn' }, h('span', { className: 'lbl' }, '资源条'), h('span', null, problem)))
      }

      const memory = data?.memory ?? {}
      const gate = data?.gate ?? {}
      const disks = Array.isArray(data?.disks) ? data.disks : []
      const active = Array.isArray(gate.active) ? gate.active : []
      const queued = Array.isArray(gate.queue) ? gate.queue : []
      const limit = typeof gate.maxConcurrent === 'number' ? gate.maxConcurrent : null
      const running = Number.isFinite(gate.running) ? gate.running : active.length

      const parts = [
        h(Segment, {
          key: 'phys',
          label: '内存',
          value: Number.isFinite(memory.usedPercent) ? `${memory.usedPercent}%` : '—',
          percent: memory.usedPercent,
          bar: true,
          title: Number.isFinite(memory.usedPercent)
            ? `物理内存：已用 ${gb(memory.usedBytes)} / 共 ${gb(memory.totalBytes)}，可用 ${gb(memory.availBytes)}`
            : '物理内存读数暂缺',
        }),
        h(Segment, {
          key: 'commit',
          label: '提交',
          value: Number.isFinite(memory.commitPercent) ? `${memory.commitPercent}%` : '—',
          percent: memory.commitPercent,
          bar: true,
          title: Number.isFinite(memory.commitPercent)
            ? `提交内存：已用 ${gb(memory.commitUsedBytes)} / 上限 ${gb(memory.commitLimitBytes)}；接近上限时 Windows 会直接杀进程`
            : '提交内存读数暂缺',
        }),
        h('span', { key: 'sep1', className: 'sep' }),
      ]

      // 每个盘符一个悬浮解释：C/D/E 是什么、多大、用了多少。
      for (const disk of disks.slice(0, 4)) {
        const name = String(disk.name ?? '')
        const role = disk.system ? '系统盘' : '数据盘'
        const pop = [
          h('div', { key: 'ph', className: 'ph' }, `${name} · ${role}`),
          disk.label ? h(Row, { key: 'label', k: '卷标', v: disk.label }) : null,
          disk.fileSystem ? h(Row, { key: 'fs', k: '文件系统', v: disk.fileSystem }) : null,
          h(Row, { key: 'total', k: '容量', v: gbFull(disk.totalBytes) }),
          h(Row, {
            key: 'used',
            k: '已用',
            v: `${gbFull(disk.usedBytes)}${Number.isFinite(disk.usedPercent) ? `（${disk.usedPercent}%）` : ''}`,
          }),
          h(Row, { key: 'free', k: '剩余', v: gbFull(disk.freeBytes) }),
          h(
            'div',
            { key: 'note', className: 'note' },
            disk.system
              ? '系统盘：Windows、页面文件（虚拟内存）和用户目录都在这块盘上。剩余空间太少时，内存吃紧会直接把进程杀掉。'
              : '数据盘：放项目、缓存或备份都可以，具体看你自己怎么分区使用。',
          ),
        ]
        parts.push(
          h(
            Hover,
            { key: `disk-${name}`, className: toneFor(disk.usedPercent), pop },
            h('span', { className: 'lbl' }, name),
            h('span', { className: 'val' }, `剩 ${gb(disk.freeBytes)}`),
          ),
        )
      }

      parts.push(h('span', { key: 'grow', className: 'grow' }))

      // 进行中对话 + 上限：悬停能看到正在跑的是哪几个会话、排队的还有谁。
      const gatePop = [
        h(
          'div',
          { key: 'ph', className: 'ph' },
          `进行中 ${running}${limit !== null ? ` / 上限 ${limit}` : ''}${queued.length > 0 ? ` · 排队 ${queued.length}` : ''}`,
        ),
      ]
      if (active.length === 0) {
        gatePop.push(h('div', { key: 'none', className: 'empty' }, '当前没有正在运行的对话'))
      } else {
        gatePop.push(
          h(
            'ul',
            { key: 'active' },
            ...active.map((item) =>
              h(
                'li',
                { key: `a-${item.id}` },
                h('span', { className: 't', title: item.title || String(item.id ?? '') }, item.title || shortId(item.id)),
                h('span', { className: 'ms' }, `跑 ${duration(item.runningMs)}`),
              ),
            ),
          ),
        )
      }
      if (queued.length > 0) {
        gatePop.push(h('div', { key: 'qh', className: 'ph', style: { marginTop: '8px' } }, `排队 ${queued.length}`))
        gatePop.push(
          h(
            'ul',
            { key: 'queue' },
            ...queued.map((item) =>
              h(
                'li',
                { key: `q-${item.id}` },
                h(
                  'span',
                  { className: 't q', title: item.title || String(item.id ?? '') },
                  `${item.position}. ${item.title || shortId(item.id)}`,
                ),
                h('span', { className: 'ms' }, `等 ${duration(item.waitingMs)}`),
              ),
            ),
          ),
        )
      }
      gatePop.push(
        h(
          'div',
          { key: 'note', className: 'note' },
          '上限 = 同时运行的对话数；超出的对话排队等待，前面的回合结束后按顺序放行。点 − / + 直接调整，立即生效。',
        ),
      )

      parts.push(
        h(
          Hover,
          { key: 'gate', className: queued.length > 0 ? 'warn' : '', pop: gatePop },
          h('span', { className: 'lbl' }, '对话'),
          h('span', { className: 'val' }, String(running)),
          limit !== null ? h('span', { className: 'lbl' }, `/ ${limit}`) : null,
          queued.length > 0 ? h('span', { className: 'val warn', style: { marginLeft: '2px' } }, `排队 ${queued.length}`) : null,
          limit !== null
            ? h('button', {
                type: 'button',
                className: 'btn',
                disabled: limit <= MIN_LIMIT || migrated,
                onClick: () => changeLimit(-1),
                title: '减少一个并发',
              }, '−')
            : null,
          limit !== null
            ? h('button', {
                type: 'button',
                className: 'btn',
                disabled: limit >= MAX_LIMIT || migrated,
                onClick: () => changeLimit(1),
                title: '增加一个并发',
              }, '+')
            : null,
        ),
      )

      return h('div', { className: 'dsh-res-strip' }, ...parts)
    }

    /** 设置页（Plugins → 资源与并发）：把状态条的内容摊开，并能直接改上限。 */
    function ResourceSettings(props) {
      const view = typeof props?.view === 'string' && props.view ? props.view : 'page'
      const [data, setData] = useState(null)
      const [problem, setProblem] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        ensureStyle()
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const response = await fetch(STATUS_URL, { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (!alive) return
            setData(json)
            setProblem('')
          } catch (error) {
            if (!alive) return
            setProblem(String(error?.message ?? error))
          }
          if (alive) timer = setTimeout(tick, view === 'summary' ? 10000 : POLL_MS)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [view])

      const changeLimit = useCallback(
        async (delta) => {
          const current = data?.gate?.maxConcurrent
          if (typeof current !== 'number' || busy) return
          const next = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, current + delta))
          if (next === current) return
          setBusy(true)
          try {
            const response = await fetch(LIMIT_URL, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ maxConcurrent: next }),
            })
            const json = await response.json().catch(() => ({}))
            if (!response.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${response.status}`)
            setData((previous) =>
              previous && previous.gate ? { ...previous, gate: { ...previous.gate, maxConcurrent: next } } : previous,
            )
            setProblem('')
          } catch (error) {
            setProblem(String(error?.message ?? error))
          } finally {
            setBusy(false)
          }
        },
        [data, busy],
      )

      const memory = data?.memory ?? {}
      const disks = Array.isArray(data?.disks) ? data.disks : []
      const gate = data?.gate ?? {}
      const active = Array.isArray(gate.active) ? gate.active : []
      const queued = Array.isArray(gate.queue) ? gate.queue : []
      const limit = typeof gate.maxConcurrent === 'number' ? gate.maxConcurrent : null
      const running = Number.isFinite(gate.running) ? gate.running : active.length
      const percent = (value) => (Number.isFinite(value) ? `${value}%` : '—')

      // 列表里的那张卡片只渲染一行摘要，点进去才是这一页。
      if (view === 'summary') {
        if (!data) return h('span', { className: 'dsh-res-sum' }, problem ? '资源读数暂缺' : '正在读取资源占用…')
        return h(
          'span',
          { className: 'dsh-res-sum' },
          [
            `内存 ${percent(memory.usedPercent)}`,
            `提交 ${percent(memory.commitPercent)}`,
            `对话 ${running}${limit !== null ? `/${limit}` : ''}${queued.length > 0 ? ` · 排队 ${queued.length}` : ''}`,
          ].join(' · '),
        )
      }

      const row = (key, k, v, tone) =>
        h('div', { key, className: 'r' }, h('span', { className: 'k' }, k), h('span', { className: `v ${tone ?? ''}` }, v))

      const memorySection = h(
        'section',
        { key: 'memory' },
        h('h4', null, '内存'),
        h(
          'div',
          { className: 'rows' },
          row(
            'phys',
            '物理内存',
            `${gbFull(memory.usedBytes)} / ${gbFull(memory.totalBytes)} · ${percent(memory.usedPercent)}`,
            toneFor(memory.usedPercent),
          ),
          row('avail', '可用', gbFull(memory.availBytes)),
          row(
            'commit',
            '提交内存',
            `${gbFull(memory.commitUsedBytes)} / ${gbFull(memory.commitLimitBytes)} · ${percent(memory.commitPercent)}`,
            toneFor(memory.commitPercent),
          ),
        ),
        h('div', { className: 'hint' }, '提交内存把页面文件也算在内；接近上限时 Windows 会直接杀掉进程。'),
      )

      const diskSection = h(
        'section',
        { key: 'disk' },
        h('h4', null, '磁盘'),
        disks.length === 0
          ? h('div', { className: 'empty' }, '没有读到磁盘信息')
          : h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '盘符'),
                  h('th', null, '卷标'),
                  h('th', null, '类型'),
                  h('th', { className: 'num' }, '容量'),
                  h('th', { className: 'num' }, '已用'),
                  h('th', { className: 'num' }, '剩余'),
                ),
              ),
              h(
                'tbody',
                null,
                ...disks.map((disk) =>
                  h(
                    'tr',
                    { key: String(disk.name) },
                    h('td', null, disk.name),
                    h('td', null, disk.label || '—'),
                    h('td', null, disk.system ? '系统盘' : '数据盘'),
                    h('td', { className: 'num' }, gbFull(disk.totalBytes)),
                    h(
                      'td',
                      { className: 'num' },
                      `${gbFull(disk.usedBytes)}${Number.isFinite(disk.usedPercent) ? `（${disk.usedPercent}%）` : ''}`,
                    ),
                    h('td', { className: `num ${toneFor(disk.usedPercent)}` }, gbFull(disk.freeBytes)),
                  ),
                ),
              ),
            ),
      )

      const gateSection = h(
        'section',
        { key: 'gate' },
        h('h4', null, '对话并发'),
        h(
          'div',
          { className: 'limitRow' },
          h('span', { className: 'lbl' }, '上限'),
          h(
            'button',
            {
              type: 'button',
              className: 'btn',
              disabled: busy || limit === null || limit <= MIN_LIMIT,
              onClick: () => changeLimit(-1),
              title: '减少一个并发',
            },
            '−',
          ),
          h('span', { className: 'num' }, limit === null ? '—' : String(limit)),
          h(
            'button',
            {
              type: 'button',
              className: 'btn',
              disabled: busy || limit === null || limit >= MAX_LIMIT,
              onClick: () => changeLimit(1),
              title: '增加一个并发',
            },
            '+',
          ),
          h(
            'span',
            { className: 'lbl' },
            `· 运行中 ${running}${queued.length > 0 ? ` · 排队 ${queued.length}` : ''}`,
          ),
        ),
        h('div', { className: 'hint' }, '上限 = 同时运行的对话数；超出的对话排队，前面的回合结束后按顺序放行。改完立即生效。'),
        h('div', { style: { height: '10px' } }),
        active.length > 0
          ? h(
              'ul',
              null,
              ...active.map((item) =>
                h(
                  'li',
                  { key: `a-${item.id}` },
                  h('span', { className: 't', title: item.title || String(item.id ?? '') }, item.title || shortId(item.id)),
                  h('span', { className: 'ms' }, `跑 ${duration(item.runningMs)}`),
                ),
              ),
            )
          : h('div', { className: 'empty' }, '当前没有正在运行的对话'),
        queued.length > 0
          ? h(
              'ul',
              { style: { marginTop: '6px' } },
              ...queued.map((item) =>
                h(
                  'li',
                  { key: `q-${item.id}` },
                  h(
                    'span',
                    { className: 't', title: item.title || String(item.id ?? '') },
                    `${item.position}. ${item.title || shortId(item.id)}`,
                  ),
                  h('span', { className: 'ms' }, `等 ${duration(item.waitingMs)}`),
                ),
              ),
            )
          : null,
      )

      return h(
        'div',
        { className: 'dsh-res-page' },
        problem ? h('div', { className: 'problem' }, `读取失败：${problem}`) : null,
        memorySection,
        diskSection,
        gateSection,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get ? ctx.get('slots') : ctx.slots
        if (!slots || typeof slots.inject !== 'function') return
        slots.inject('shell.bottom', () =>
          slots.register({ name: 'shell.bottom', id: 'resource-strip', order: 50 }, ResourceStrip),
        )
        slots.inject('plugins.item', () =>
          slots.register(
            { name: 'plugins.item', id: 'resource-settings', order: 60, label: () => '资源与并发' },
            ResourceSettings,
          ),
        )
      },
    }
  },
})
