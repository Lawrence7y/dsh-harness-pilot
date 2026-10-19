/**
 * （rev 标记：3dff19ac）
 * @dsh-external/dsh-harness-pilot — 浏览器端（client）半边。
 *
 * 只做两件事，零构建、零依赖（除宿主模块表里的 react）：
 *   1. `settings.section` 注册唯一的「外部 Harness」设置页：目标表 + 诊断运营面板（全部默认收起）。
 *      （2026-10-15 起不再注册 `settings.plugins.tab` —— 用户要求只保留一张设置页。）
 *
 * 数据唯一来源：宿主 HTTP 接口 `GET /harness-pilot/api/overview`（同源）。
 * 所有字段都当可选处理：缺数组、model 为 null、接口 404/不可达 —— 都只渲染空状态/错误提示，绝不抛出。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-harness-pilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主概览接口（同源）。 */
    const API = '/harness-pilot/api/overview'
    /** 运行时设置与后台任务接口（同源）。 */
    const API_SETTINGS_SAVE = '/harness-pilot/api/settings/save'
    const API_TASK = '/harness-pilot/api/task'
    const API_TASK_CANCEL = '/harness-pilot/api/task/cancel'

    /**
     * 主题令牌。优先用宿主真实别名令牌（--dsw-alias-*，明暗主题都有定义），
     * 再退到通用 --dsh-color-*，最后才是 inherit / transparent —— 于是任何主题下都不硬编码正文颜色。
     * 状态点必须绿/红，故只在这里保留最终兜底色。
     */
    const C = {
      text: 'var(--dsw-alias-label-primary, var(--dsh-color-text-primary, inherit))',
      textSecond: 'var(--dsw-alias-label-secondary, var(--dsh-color-text-secondary, inherit))',
      textDim: 'var(--dsw-alias-label-tertiary, var(--dsh-color-text-tertiary, inherit))',
      surface: 'var(--dsw-alias-bg-layer-2, var(--dsh-color-surface-2, transparent))',
      surfaceSoft: 'var(--dsw-alias-bg-layer-1, var(--dsh-color-surface-1, transparent))',
      border: 'var(--dsw-alias-border-l2, var(--dsh-color-border-1, currentColor))',
      borderSoft: 'var(--dsw-alias-border-l1, var(--dsh-color-border-1, currentColor))',
      ok: 'var(--dsw-alias-state-success-primary, var(--dsh-color-success, #16a34a))',
      bad: 'var(--dsw-alias-state-error-primary, var(--dsh-color-danger, #dc2626))',
    }
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace'

    // ── 取值助手：全部防御式，永不抛 ──────────────────────────────
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }
    function str(value) {
      return typeof value === 'string' ? value.trim() : ''
    }
    function isObj(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }
    function pad2(n) {
      return n < 10 ? '0' + String(n) : String(n)
    }
    /** 毫秒 → HH:MM:SS；非法值给空串。 */
    function clockText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const d = new Date(ms)
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    }

    // ── **加粗** 渲染：说明文本里的 markdown 强调不再原样显示星号 ──────────
    // （设置页曾整屏出现 `**不允许**` 这样的字面星号，因为服务端文案带 markdown 而前端当纯文本画。）
    function rich(value) {
      const parts = Array.isArray(value) ? value : [value]
      const out = []
      for (const part of parts) {
        if (typeof part !== 'string') { out.push(part); continue }
        const segs = part.split(/\*\*([^*]+)\*\*/)
        for (let i = 0; i < segs.length; i += 1) {
          if (segs[i].length === 0) continue
          out.push(i % 2 === 1 ? h('strong', { key: 'b' + String(i) }, segs[i]) : segs[i])
        }
      }
      return out
    }
    /**
     * 把服务端的「模型来源」说明转成人话。
     *
     * 原来客户端直接把服务端的内部英文说明画在界面上（本机实测出现过
     * `模型来源：no modelsCommand configured for this harness`）—— 中文设置页里一条英文内部术语，
     * 用户既看不懂也不知道要做什么。已知的兜底说明逐条翻译，**命令原文原样保留**（那是可核对的证据）。
     */
    function modelSourceText(note) {
      const value = str(note)
      if (value.length === 0) return '未报告来源'
      if (value === 'no modelsCommand configured for this harness') {
        return '该 CLI 没有可用的模型列举命令（本插件不猜、不编造列表）'
      }
      if (value.startsWith('catalog file ')) {
        return '读该 harness 自带的模型目录文件（只取 id / name，未读取任何值字段）'
      }
      if (value.startsWith('静态清单')) return value
      return value
    }

    /** 统一的提示/告警盒：内容过 `rich()`（把 **加粗** 真的画成加粗）。 */
    function Notice(props) {
      const children = props && props.children !== undefined ? props.children : []
      return h('div', { style: props.style }, rich(Array.isArray(children) ? children : [children]))
    }
    /** 提示行：与 Notice 同一套 `**加粗**` 渲染，但用在普通提示 / 弱色文字上。
     *  本机实测过整屏出现字面星号（`本插件**不编造**`）—— 把带 markdown 的文案当纯文本画。 */
    function Hint(props) {
      const children = props && props.children !== undefined ? props.children : []
      return h('div', { style: props && isObj(props.style) ? props.style : S.hint }, rich(Array.isArray(children) ? children : [children]))
    }
    /** 折叠说明：一行摘要 + `<details>` 里的全文。
     *
     * 用户反馈「外部 harness 管理页面信息过多、不方便操作」。原来 5–6 行的长句直接铺在页面上，
     * 每栏一打开就是一屏小字。这里**不删任何信息**，只改默认可见性：
     * 结论留在摘要行，依据/边界展开才看。
     */
    function Collapsible(props) {
      const label = str(props && props.label)
      const text = str(props && props.text)
      const summary = str(props && props.summary)
      const tone = str(props && props.tone)
      if (text.length === 0) return null
      const summaryStyle = tone === 'bad'
        ? Object.assign({}, S.detailSummary, { color: C.bad })
        : S.detailSummary
      return h('details', { style: props && isObj(props.style) ? props.style : S.detailBox },
        h('summary', { style: summaryStyle },
          (label.length > 0 ? label + '\u3000' : '') + (summary.length > 0 ? summary : '展开说明')),
        h('div', { style: S.detailBody }, rich(text)),
      )
    }

    // ── 共享快照：两个插槽共用一次请求，手动刷新 ────────────────────
    const store = {
      data: null,        // 最近一次成功的概览
      error: '',         // 最近一次失败原因（成功即清空）
      loading: false,
      updatedAt: 0,
      inflight: null,    // 去重：并发调用复用同一个 promise
      listeners: new Set(),
    }
    function emit() {
      for (const listener of Array.from(store.listeners)) {
        try {
          listener()
        } catch (err) {
          // 单个订阅者出错不影响其它订阅者
          void err
        }
      }
    }
    function subscribe(listener) {
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    }
    /** 重新拉取概览；失败只记录原因，不抛出（不打断渲染）。 */
    function loadOverview() {
      if (store.inflight !== null) return store.inflight
      store.loading = true
      emit()
      store.inflight = fetch(API, { headers: { accept: 'application/json' } })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + String(res.status))
          return res.json()
        })
        .then(json => {
          if (!isObj(json)) throw new Error('返回体不是 JSON 对象')
          store.data = json
          store.error = ''
          store.updatedAt = Date.now()
        })
        .catch(err => {
          store.error = str(err && err.message) || String(err)
        })
        .then(() => {
          store.loading = false
          store.inflight = null
          emit()
        })
      return store.inflight
    }
    /** 订阅共享快照；挂载时若还没有数据就拉一次（有数据可手动刷新，不自动轮询）。 */
    function useOverview() {
      const [tick, bump] = React.useState(0)
      React.useEffect(() => subscribe(() => bump(n => n + 1)), [])
      React.useEffect(() => {
        if (store.data === null) loadOverview()
      }, [])
      void tick
      return {
        data: store.data,
        error: store.error,
        loading: store.loading,
        updatedAt: store.updatedAt,
        reload: loadOverview,
      }
    }

    // ── 数据整形 ────────────────────────────────────────────────
    /** 目标：可用在前、其次按名字；字段缺失一律有兜底。 */
    function readTargets(data) {
      const rows = asArray(isObj(data) ? data.targets : null).filter(isObj)
      const mapped = rows.map((t, index) => ({
        key: (str(t.name) || 'target') + '#' + String(index),
        name: str(t.name) || '（未命名目标）',
        description: str(t.description),
        transport: str(t.transport),
        order: asArray(t.order).filter(x => typeof x === 'string' && x.length > 0),
        command: str(t.command),
        commandPath: str(t.commandPath),
        available: t.available === true,
        model: str(t.model),
        models: asArray(t.models).filter(x => typeof x === 'string' && x.length > 0),
        modelsNote: str(t.modelsNote),
        // 冻结契约里没有「不可用原因」字段名，这里按常见的几种名字兜底探测
        reason: str(t.reason) || str(t.missingReason) || str(t.note) || str(t.error) || str(t.detail),
      }))
      return mapped.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    }
    function transportText(t) {
      const order = t.order.length > 0 ? t.order.join(' → ') : ''
      if (t.transport.length > 0 && t.transport !== 'auto') {
        return order.length > 0 ? t.transport + ' · ' + order : t.transport
      }
      return order.length > 0 ? order : (t.transport || 'auto')
    }
    function availabilityText(t) {
      if (t.available) return t.commandPath || t.command || '可用'
      if (t.reason.length > 0) return t.reason
      return '未找到 ' + (t.command || t.name)
    }
    function readSessions(data) {
      return asArray(isObj(data) ? data.sessions : null).filter(isObj).map((s, index) => ({
        key: str(s.id) || 'session#' + String(index),
        id: str(s.id) || '（无 id）',
        target: str(s.target),
        transport: str(s.transport),
        detail: str(s.detail),
        openedAt: typeof s.openedAt === 'number' ? s.openedAt : 0,
      }))
    }
    // Only display identities supplied by the task record; request values never fill actual fields.
    function readTaskIdentity(value) {
      if (!isObj(value)) return null
      const account = str(value.accountId).trim()
      return {
        harnessId: str(value.harnessId),
        accountId: account.length === 0 ? '' : (account.startsWith('acct:') ? account : redactAccountId(account)),
        provider: str(value.provider), model: str(value.model), transport: str(value.transport),
        nativeSessionId: str(value.nativeSessionId),
      }
    }
    /** 后台任务：概览里的 tasks 字段。 */
    function readTasks(data) {
      return asArray(isObj(data) ? data.tasks : null).filter(isObj).map((t, index) => ({
        key: str(t.task_id) || 'task#' + String(index),
        id: str(t.task_id),
        target: str(t.target),
        model: str(t.model),
        requested: readTaskIdentity(t.requested),
        actual: readTaskIdentity(t.actual),
        actualSource: str(t.actualSource),
        status: str(t.status) || 'unknown',
        cwd: str(t.cwd),
        elapsedMs: typeof t.elapsed_ms === 'number' ? t.elapsed_ms : 0,
        outputChars: typeof t.output_chars === 'number' ? t.output_chars : 0,
        diagnostic: str(t.diagnostic),
        resultPath: str(t.result_path),
        callback: isObj(t.callback) ? t.callback : null,
        // 持久逻辑会话（P1）：原生会话与恢复状态；idle = 进程已释放、可精确恢复（不是丢失）。
        session: isObj(t.session) ? {
          logicalId: str(t.session.logicalId),
          nativeSessionId: str(t.session.nativeSessionId),
          resumeKind: str(t.session.resumeKind),
          status: str(t.session.status),
          account: str(t.session.account),
        } : null,
      }))
    }
    function readProviders(data) {
      const dsh = isObj(data) ? data.dsh : null
      return asArray(isObj(dsh) ? dsh.providers : null).filter(isObj).map((p, index) => ({
        key: str(p.id) || 'provider#' + String(index),
        id: str(p.id),
        name: str(p.name) || str(p.id) || '（未命名供应商）',
        models: asArray(p.models).filter(x => typeof x === 'string' && x.length > 0),
      }))
    }
    function summaryText(targets, sessions) {
      const available = targets.filter(t => t.available).length
      return String(targets.length) + ' 个 harness · ' + String(available) + ' 个可用 · ' + String(sessions.length) + ' 个会话'
    }
    function pluginText(data) {
      const plugin = isObj(data) ? data.plugin : null
      if (!isObj(plugin)) return ''
      const name = str(plugin.name)
      const version = str(plugin.version)
      if (name.length === 0) return ''
      return version.length > 0 ? name + ' v' + version : name
    }
    /** 缺口说明：告诉 Lead 接口地址与失败原因，便于排查。 */
    function emptyNotice(overview) {
      if (overview.loading && overview.data === null) return '正在读取 ' + API + ' …'
      return '未取到 harness 概览。点「刷新」重试；宿主需在 ' + API + ' 暴露概览接口。'
    }

    // ── 样式（全内联，颜色只走主题令牌）─────────────────────────
    const S = {
      page: { padding: '0 0 24px', width: '100%', boxSizing: 'border-box', color: C.text, fontSize: 13, lineHeight: '20px', fontFamily: 'inherit' },
      headRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 16, lineHeight: '24px', fontWeight: 500, color: C.text },
      summary: { marginTop: 2, fontSize: 12, color: C.textSecond },
      meta: { marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10, fontSize: 11, color: C.textDim },
      monoDim: { fontFamily: MONO, fontSize: 11, color: C.textDim },
      button: {
        padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', borderRadius: 6, cursor: 'pointer',
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.text, whiteSpace: 'nowrap',
      },
      buttonBusy: {
        padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', borderRadius: 6, cursor: 'not-allowed',
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.textDim, whiteSpace: 'nowrap', opacity: 0.6,
      },
      notice: {
        marginTop: 10, padding: '6px 10px', borderRadius: 6, whiteSpace: 'pre-wrap',
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.textSecond,
      },
      noticeError: {
        marginTop: 10, padding: '6px 10px', borderRadius: 6, whiteSpace: 'pre-wrap',
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.bad,
      },
      // 原生设置风格：每块一张卡（圆角边框 + 内边距），标题 13px，提示 11px 弱色。
      section: {
        marginTop: 14, padding: '12px 14px', borderRadius: 'var(--dsw-radius-lg, 10px)',
        border: '0.5px solid ' + C.border, background: 'transparent',
      },
      sectionTitle: { marginBottom: 4, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: C.text },
      hint: { marginBottom: 8, fontSize: 12, lineHeight: '18px', color: C.textSecond },
      details: {
        marginTop: 14, padding: '10px 14px', borderRadius: 'var(--dsw-radius-lg, 10px)',
        border: '1px solid ' + C.borderSoft, background: C.surfaceSoft,
      },
      summary: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: C.textSecond },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        padding: '4px 8px 6px 0', textAlign: 'left', fontSize: 11, fontWeight: 500,
        color: C.textDim, borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap',
      },
      tr: { verticalAlign: 'top' },
      td: { padding: '5px 8px 5px 0', color: C.textSecond, borderBottom: '1px solid ' + C.borderSoft },
      name: { fontFamily: MONO, fontWeight: 600, color: C.text },
      desc: {
        maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.textSecond,
      },
      monoEllipsis: {
        fontFamily: MONO, fontSize: 11, color: C.textDim,
        maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      dotWrap: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 240 },
      dot: { display: 'inline-block', flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%' },
      avail: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 11 },
      badge: {
        display: 'inline-block', padding: '0 4px', borderRadius: 4, whiteSpace: 'nowrap',
        border: '1px solid ' + C.borderSoft, background: C.surface, color: C.textDim, fontFamily: MONO, fontSize: 11,
      },
      buttonSmall: {
        padding: '2px 8px', fontSize: 11, fontFamily: 'inherit', borderRadius: 5, cursor: 'pointer',
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.text, whiteSpace: 'nowrap',
      },
      // 原生设置风格的分栏标签条：下划线指示当前栏，不再用一排「像按钮的方块」。
      // （用户反馈：原来的 7 个按钮块与 DSH 设置页风格差别大、信息过多、找不到账号/供应商/模型在哪。）
      tabBar: {
        display: 'flex', flexWrap: 'wrap', gap: 0, marginTop: 14,
        borderBottom: '1px solid ' + C.borderSoft,
      },
      tabItem: {
        padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', color: C.textSecond,
        background: 'transparent', border: 'none', borderBottom: '2px solid transparent',
        cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1,
      },
      tabActive: {
        padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', color: C.text, fontWeight: 600,
        background: 'transparent', border: 'none', borderBottom: '2px solid ' + C.text,
        cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1,
      },
      // 主行动入口（例如「新增账号档案」），比 buttonSmall 更像原生主按钮。
      buttonPrimary: {
        padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', borderRadius: 6, cursor: 'pointer',
        border: '1px solid ' + C.border, background: C.text, color: C.surface, whiteSpace: 'nowrap', fontWeight: 600,
      },
      // 折叠披露：长边界说明默认收起，先给一行摘要（信息过密的根治办法）。
      detailBox: {
        marginTop: 8, borderRadius: 'var(--dsw-radius-lg, 10px)',
        border: '1px solid ' + C.borderSoft, background: C.surfaceSoft, padding: '8px 12px',
      },
      detailSummary: { cursor: 'pointer', fontSize: 11, color: C.textSecond, outline: 'none' },
      detailBody: { marginTop: 6, fontSize: 11, lineHeight: 1.6, color: C.textDim, whiteSpace: 'pre-wrap' },
      buttonSmallBusy: {
        padding: '2px 8px', fontSize: 11, fontFamily: 'inherit', borderRadius: 5, cursor: 'not-allowed',
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.textDim, whiteSpace: 'nowrap', opacity: 0.6,
      },
      inputWide: {
        width: 190, padding: '3px 6px', fontSize: 12, fontFamily: MONO, borderRadius: 5,
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.text,
      },
      rowWrap: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
      stack: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 3 },
      list: { listStyle: 'none', margin: 0, padding: 0 },
      listItem: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
        borderBottom: '1px solid ' + C.borderSoft,
      },
      grow: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { padding: '6px 0', fontSize: 11, color: C.textDim },
      card: { padding: '10px 0', maxWidth: 660, fontSize: 12, lineHeight: 1.6, color: C.text },
      cardTitle: { fontSize: 13, fontWeight: 600, color: C.text },
      cardLine: { marginTop: 4, color: C.textSecond },
      cardSummary: { marginTop: 6, fontFamily: MONO, fontSize: 11, color: C.textDim },
      cardSummaryInline: { color: C.textSecond, fontSize: 12 },
      formRow: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
        borderBottom: '1px solid ' + C.borderSoft,
      },
      formLabel: { width: 160, flex: '0 0 auto', color: C.textSecond },
      formHint: { flex: '1 1 auto', fontSize: 11, color: C.textDim },
      input: {
        width: 120, padding: '3px 6px', fontSize: 12, fontFamily: MONO, borderRadius: 5,
        border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.text,
      },
      textarea: {
        width: '100%', minHeight: 56, padding: '4px 6px', fontSize: 12, fontFamily: 'inherit',
        borderRadius: 5, border: '1px solid ' + C.border, background: C.surfaceSoft, color: C.text, resize: 'vertical',
      },
      pre: {
        marginTop: 6, padding: '6px 8px', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: MONO, fontSize: 11, color: C.textSecond, background: C.surfaceSoft,
        border: '1px solid ' + C.borderSoft, maxHeight: 320, overflow: 'auto',
      },
      taskActions: { display: 'flex', gap: 6, flex: '0 0 auto' },
    }

    // ── 组件：设置页 ────────────────────────────────────────────
    function TargetsTable(props) {
      const targets = props.targets
      const defaultTarget = props.defaultTarget
      if (targets.length === 0) {
        if (props.hasData === false) {
          return h('div', { style: S.empty }, '尚未取到 harness 目标（概览接口不可用或还没返回）。')
        }
        return h('div', { style: S.empty }, '宿主没有返回任何 harness 目标（检查插件配置里的 targets 与内置目录）。')
      }
      const head = h('tr', null,
        h('th', { style: S.th }, '名称'),
        h('th', { style: S.th }, '说明'),
        h('th', { style: S.th }, '通道'),
        h('th', { style: S.th }, '可用性'),
        h('th', { style: S.th }, '默认模型'),
        h('th', { style: S.th }, '模型数'),
      )
      const rows = targets.map(t => {
        const isDefault = defaultTarget.length > 0 && t.name === defaultTarget
        const avail = availabilityText(t)
        return h('tr', { key: t.key, style: S.tr },
          h('td', { style: S.td },
            h('span', { style: S.name }, t.name),
            isDefault ? h('span', { style: Object.assign({}, S.badge, { marginLeft: 6 }) }, '默认') : null,
          ),
          h('td', { style: S.td },
            h('div', { style: S.desc, title: t.description.length > 0 ? t.description : '（无说明）' },
              t.description.length > 0 ? t.description : '—'),
          ),
          h('td', { style: S.td },
            h('div', { style: S.monoEllipsis, title: transportText(t) }, transportText(t)),
          ),
          h('td', { style: S.td },
            h('span', { style: S.dotWrap },
              h('span', {
                style: Object.assign({}, S.dot, { background: t.available ? C.ok : C.bad }),
                title: t.available ? '可用' : '不可用',
              }),
              h('span', {
                style: Object.assign({}, S.avail, { color: t.available ? C.textSecond : C.textDim }),
                title: avail,
              }, avail),
            ),
          ),
          h('td', { style: S.td },
            h('span', {
              style: t.model.length > 0 ? S.monoEllipsis : Object.assign({}, S.monoEllipsis, { color: C.textDim }),
              title: t.model,
            }, t.model.length > 0 ? t.model : '—'),
          ),
          h('td', { style: S.td },
            h('span', {
              style: Object.assign({}, S.monoEllipsis, { maxWidth: 160 }),
              title: t.models.length > 0
                ? t.models.join('\n') + (t.modelsNote.length > 0 ? '\n' + t.modelsNote : '')
                : (t.modelsNote || '宿主未返回模型列表'),
            },
            t.models.length > 0
              ? String(t.models.length) + ' 个' + (t.modelsNote.length > 0 ? '（' + t.modelsNote + '）' : '')
              : '—'),
          ),
        )
      })
      return h('table', { style: S.table },
        h('thead', null, head),
        h('tbody', null, rows),
      )
    }

    function SessionsList(props) {
      const sessions = props.sessions
      if (sessions.length === 0) return h('div', { style: S.empty }, '暂无进行中的 harness 会话。')
      return h('ul', { style: S.list }, sessions.map(s =>
        h('li', { key: s.key, style: S.listItem },
          h('span', { style: Object.assign({}, S.monoDim, { fontFamily: MONO, color: C.text }) }, s.id),
          s.target.length > 0 ? h('span', { style: S.badge }, s.target) : null,
          s.transport.length > 0 ? h('span', { style: S.badge }, s.transport) : null,
          h('span', { style: Object.assign({}, S.grow, S.monoDim), title: s.detail }, s.detail.length > 0 ? s.detail : '（无详情）'),
          s.openedAt > 0 ? h('span', { style: S.monoDim }, clockText(s.openedAt)) : null,
        )))
    }

    function ProvidersList(props) {
      const providers = props.providers
      if (providers.length === 0) return h('div', { style: S.empty }, '宿主未返回 DSH 已配置供应商（dsh.providers）。')
      return h('ul', { style: S.list }, providers.map(p =>
        h('li', { key: p.key, style: S.listItem },
          h('span', { style: Object.assign({}, S.name, { fontFamily: 'inherit' }) }, p.name),
          p.id.length > 0 && p.id !== p.name ? h('span', { style: S.monoDim }, p.id) : null,
          h('span', { style: S.badge }, String(p.models.length) + ' 个模型'),
          h('span', {
            style: Object.assign({}, S.grow, S.monoDim),
            title: p.models.join('\n'),
          }, p.models.length > 0 ? p.models.join('、') : '（未列出模型）'),
        )))
    }

    // ── 组件：插件设置（可编辑、立即生效）─────────────────────
    function SettingsForm(props) {
      const overview = props.overview
      const initial = isObj(overview.data) && isObj(overview.data.runtimeSettings) ? overview.data.runtimeSettings : null
      const [form, setForm] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [note, setNote] = React.useState('')
      React.useEffect(() => {
        if (form === null && initial !== null) {
          setForm({
            notifyOnComplete: initial.notifyOnComplete !== false,
            deliverResult: initial.deliverResult !== false,
            maxResultChars: Number(initial.maxResultChars) > 0 ? Number(initial.maxResultChars) : 20000,
            maxConcurrent: typeof initial.maxConcurrent === 'number' && Number.isFinite(initial.maxConcurrent) && initial.maxConcurrent >= 0 ? initial.maxConcurrent : 4,
            defaultTaskTimeoutMs: Number(initial.defaultTaskTimeoutMs) > 0 ? Number(initial.defaultTaskTimeoutMs) : 600000,
            resumeInstruction: typeof initial.resumeInstruction === 'string' ? initial.resumeInstruction : '',
            sessionModelLimit: typeof initial.sessionModelLimit === 'number' && Number.isFinite(initial.sessionModelLimit) && initial.sessionModelLimit >= 0 ? initial.sessionModelLimit : 10,
          })
        }
      }, [initial])
      if (form === null) {
        return h('div', { style: S.empty },
          overview.data === null
            ? '尚未读取到插件设置（点「刷新」重试）。'
            : '宿主未返回运行时设置：插件的 /harness-pilot/api/overview 需要新版（含 runtimeSettings 字段）。')
      }
      const set = (patch) => setForm(Object.assign({}, form, patch))
      const save = () => {
        setSaving(true)
        setNote('')
        fetch(API_SETTINGS_SAVE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(form),
        })
          .then(res => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
          .then(() => {
            setNote('已保存并立即生效。')
            void overview.reload()
          })
          .catch(err => { setNote('保存失败：' + (str(err && err.message) || String(err))) })
          .then(() => setSaving(false))
      }
      const row = (label, control, hint) => h('div', { style: S.formRow },
        h('label', { style: S.formLabel }, label),
        control,
        hint ? h('div', { style: S.formHint }, hint) : null,
      )
      return h('div', null,
        row('完成后唤醒会话',
          h('input', {
            type: 'checkbox',
            checked: form.notifyOnComplete === true,
            onChange: e => set({ notifyOnComplete: e.target.checked === true }),
          }),
          'harness 任务完成时，把交付内容送回发起会话并触发会话重新启动继续任务'),
        row('回执附带交付内容',
          h('input', {
            type: 'checkbox',
            checked: form.deliverResult === true,
            onChange: e => set({ deliverResult: e.target.checked === true }),
          }),
          '关闭后回执只含状态与结果文件路径，不含正文'),
        row('交付内容上限（字符）',
          h('input', {
            type: 'number', style: S.input, value: String(form.maxResultChars), min: 500,
            onChange: e => set({ maxResultChars: Number(e.target.value) }),
          }),
          '超出部分截断，完整内容在结果文件里'),
        row('并发任务上限',
          h('input', {
            type: 'number', style: S.input, value: String(form.maxConcurrent), min: 0,
            onChange: e => set({ maxConcurrent: Number(e.target.value) }),
          }),
          '同时在跑的 harness_task_start 数量；0 表示不限数量'),
        row('任务默认超时（毫秒）',
          h('input', {
            type: 'number', style: S.input, value: String(form.defaultTaskTimeoutMs), min: 5000,
            onChange: e => set({ defaultTaskTimeoutMs: Number(e.target.value) }),
          }),
          'harness_task_start 未指定 timeout_ms 时使用'),
        row('会话模型菜单每 CLI 列出上限',
          h('input', {
            type: 'number', style: S.input, value: String(form.sessionModelLimit), min: 0,
            onChange: e => set({ sessionModelLimit: Number(e.target.value) }),
          }),
          '默认 10：让「选 CLI + 选它的模型」在会话菜单里找得到；0 = 全部列出（会把原生菜单灌满 700+ 条）。'
          + '完整清单始终在「供应商与模型」栏，不受此值影响'),
        h('div', { style: Object.assign({}, S.formRow, { alignItems: 'flex-start' }) },
          h('label', { style: S.formLabel }, '续办提示（可选）'),
          h('div', { style: { flex: '1 1 auto' } },
            h('textarea', {
              style: S.textarea,
              value: form.resumeInstruction,
              placeholder: '回执里附加的续办提示；留空用内置提示语',
              onChange: e => set({ resumeInstruction: e.target.value }),
            }),
          ),
        ),
        h('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 } },
          h('button', {
            type: 'button',
            style: saving ? S.buttonBusy : S.button,
            disabled: saving === true,
            onClick: save,
          }, saving ? '保存中…' : '保存设置'),
          note.length > 0 ? h('span', { style: S.monoDim }, note) : null,
        ),
      )
    }

    // ── 组件：后台任务（状态 / 结果 / 取消）─────────────────────
    function formatTaskDetail(json) {
      if (!isObj(json)) return '（无数据）'
      const lines = []
      lines.push('task ' + str(json.task_id) + '  status=' + str(json.status))
      if (str(json.diagnostic).length > 0) lines.push('diagnostic: ' + str(json.diagnostic))
      const cb = isObj(json.callback) ? json.callback : null
      if (cb !== null) {
        lines.push('回执: notify=' + String(cb.notify) + ' status=' + str(cb.status)
          + (str(cb.error).length > 0 ? ' error=' + str(cb.error) : '')
          + (str(cb.receipt).length > 0 ? '\n送达回执: ' + str(cb.receipt) : ''))
      }
      if (str(json.text).length > 0) lines.push('\n--- 过程输出（节选）---\n' + str(json.text))
      const result = isObj(json.result) ? json.result : null
      if (result !== null) {
        lines.push('\n--- 交付内容（stop=' + str(result.stopReason) + '）---\n'
          + (str(result.text).length > 0 ? str(result.text) : '（无正文）'))
      }
      return lines.join('\n')
    }
    function taskIdentityText(task) {
      const actual = task.actual
      const verifiedSource = task.actualSource === 'transport-outcome'
      const value = (field) => actual !== null && actual !== undefined ? str(actual[field]) : ''
      const unknown = '未回报'
      const provider = verifiedSource ? value('provider') : ''
      const model = verifiedSource ? value('model') : ''
      const legacy = !verifiedSource && actual !== null && actual !== undefined
      const nativeSession = value('nativeSessionId')
      return '执行身份' + (legacy ? '（历史未验证）' : '') + '：'
        + 'Harness ' + (value('harnessId') || unknown)
        + ' · 账号 ' + (value('accountId') || unknown)
        + ' · 供应商 ' + (provider || unknown)
        + ' · 模型 ' + (model || unknown)
        + ' · 通道 ' + (value('transport') || unknown)
        + ' · 原生会话 ' + (nativeSession || '未回报')
        + ((provider.length === 0 || model.length === 0) ? '；未回报项无法确认' : '')
    }
    /** 持久逻辑会话行：idle = 进程已释放、可精确恢复（如实标注，不显示成丢失）。 */
    function taskSessionText(task) {
      const session = task.session
      if (!session || !session.logicalId) return ''
      const statusNote = session.status === 'recovery_needed'
        ? '（恢复失败待处理）'
        : (session.status === 'idle' ? '（可恢复）' : (session.status ? '（' + session.status + '）' : ''))
      return '逻辑会话 ' + session.logicalId
        + ' · 原生 ' + (session.nativeSessionId || '未回报')
        + ' · 恢复方式 ' + (session.resumeKind || '未记录')
        + ' · 状态 ' + (session.status || '未知') + statusNote
    }
    function TasksPanel(props) {
      const overview = props.overview
      const tasks = readTasks(overview.data)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const openResult = (id) => {
        setBusy(id)
        fetch(API_TASK + '?id=' + encodeURIComponent(id) + '&result=1')
          .then(res => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
          .then(json => setDetail({ id, text: formatTaskDetail(json) }))
          .catch(err => setDetail({ id, text: '读取失败：' + (str(err && err.message) || String(err)) }))
          .then(() => setBusy(''))
      }
      const cancel = (id) => {
        setBusy(id)
        fetch(API_TASK_CANCEL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ task_id: id }),
        })
          .then(res => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
          .then(() => void overview.reload())
          .catch(err => setDetail({ id, text: '取消失败：' + (str(err && err.message) || String(err)) }))
          .then(() => setBusy(''))
      }
      if (tasks.length === 0) return h('div', { style: S.empty }, '暂无后台 harness 任务（harness_task_start 派发后会出现在这里）。')
      return h('ul', { style: S.list }, tasks.map(t => {
        const cb = isObj(t.callback) ? t.callback : null
        const running = t.status === 'running'
        const requestedModel = t.requested !== null && t.requested.model.length > 0 ? t.requested.model : t.model
        return h('li', { key: t.key, style: { display: 'block', padding: '6px 0', borderBottom: '1px solid ' + C.borderSoft } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', {
              style: Object.assign({}, S.dot, { background: running ? C.ok : (t.status === 'completed' ? C.ok : C.bad) }),
              title: t.status,
            }),
            h('span', { style: Object.assign({}, S.monoDim, { color: C.text }) }, t.id.slice(0, 8)),
            h('span', { style: S.badge }, t.target),
            requestedModel.length > 0 ? h('span', { style: S.badge }, '请求模型：' + requestedModel) : null,
            h('span', { style: S.badge }, t.status),
            // ── 身份对照结论（服务端 `compareIdentity` 算好，客户端**不重新实现**比对）──
            // 需求 ⑧：请求值 ≠ 实际值要**提示**；没回报要说**未知**。绝不拿请求值冒充实际值。
            isObj(t.identity) && str(t.identity.verdict).length > 0
              ? h('span', {
                style: Object.assign({}, S.badge, /⚠️/.test(str(t.identity.verdict)) ? { background: C.bad, color: '#fff' } : {}),
                title: str(t.identity.verdict),
              }, /⚠️/.test(str(t.identity.verdict)) ? '身份不一致 / 未回报' : '身份：' + str(t.identity.verdict).slice(0, 18))
              : null,
            cb !== null ? h('span', { style: S.badge }, '回执 ' + str(cb.status)) : null,
            h('span', { style: Object.assign({}, S.grow, S.monoDim) },
              Math.round(t.elapsedMs / 1000) + 's · ' + String(t.outputChars) + ' chars'
              + (t.diagnostic.length > 0 ? ' · ' + t.diagnostic.slice(0, 60) : '')),
            h('div', { style: S.taskActions },
              h('button', {
                type: 'button',
                style: busy === t.id ? S.buttonBusy : S.button,
                disabled: busy === t.id,
                onClick: () => openResult(t.id),
              }, '结果'),
              running ? h('button', {
                type: 'button',
                style: busy === t.id ? S.buttonBusy : S.button,
                disabled: busy === t.id,
                onClick: () => cancel(t.id),
              }, '取消') : null,
            ),
          ),
          h('div', { style: Object.assign({}, S.monoDim, { marginTop: 4, overflowWrap: 'anywhere' }) }, taskIdentityText(t)),
          taskSessionText(t) !== ''
            ? h('div', { style: Object.assign({}, S.monoDim, { overflowWrap: 'anywhere' }) }, taskSessionText(t))
            : null,
          detail !== null && detail.id === t.id
            ? h('pre', { style: S.pre }, detail.text)
            : null,
        )
      }))
    }

    // ═══════════════ 联邦层（P1 注册表 / P2 账号 / P3 供应商）═══════════════
    // 三个接口各自独立取数：一个挂了不影响另外两个，且**失败就显示失败**，
    // 绝不用「看起来像成功」的空表糊过去。
    const FED = {
      registry: '/harness-pilot/api/registry',
      accounts: '/harness-pilot/api/accounts',
      providers: '/harness-pilot/api/providers',
    }

    const fedStore = {
      registry: { data: null, error: '', loading: false, measured: false },
      accounts: { data: null, error: '', loading: false, measured: false },
    }
    /** providers 按目标缓存（每个 harness 的清单不同）。 */
    const providerStore = new Map()
    function providerSlot(target) {
      if (!providerStore.has(target)) {
        providerStore.set(target, { data: null, error: '', loading: false, measured: false })
      }
      return providerStore.get(target)
    }
    const fedListeners = new Set()
    function fedEmit() {
      for (const l of [...fedListeners]) { try { l() } catch (e) { /* 单个订阅者出错不拖垮其它 */ } }
    }
    function fedSubscribe(listener) {
      fedListeners.add(listener)
      return () => { fedListeners.delete(listener) }
    }
    function fedLoad(key, measure) {
      const slot = fedStore[key]
      if (slot === undefined || slot.loading) return Promise.resolve()
      slot.loading = true
      slot.measured = measure === true
      fedEmit()
      const url = FED[key] + (measure === true ? '?measure=1' : '')
      return fetch(url, { headers: { accept: 'application/json' } })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
        .then(json => { slot.data = isObj(json) ? json : null; slot.error = '' })
        .catch(err => { slot.error = str(err && err.message) || String(err) })
        .then(() => { slot.loading = false; fedEmit() })
    }
    function loadProviders(target, measure) {
      const slot = providerSlot(target)
      if (target.length === 0 || slot.loading) return Promise.resolve()
      slot.loading = true
      slot.measured = measure === true
      fedEmit()
      const url = FED.providers + '?target=' + encodeURIComponent(target) + (measure === true ? '&measure=1' : '')
      return fetch(url, { headers: { accept: 'application/json' } })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + String(res.status)); return res.json() })
        .then(json => { slot.data = isObj(json) ? json : null; slot.error = '' })
        .catch(err => { slot.error = str(err && err.message) || String(err) })
        .then(() => { slot.loading = false; fedEmit() })
    }
    function useFed(key) {
      const [tick, bump] = React.useState(0)
      React.useEffect(() => fedSubscribe(() => bump(n => n + 1)), [])
      React.useEffect(() => { if (fedStore[key] !== undefined && fedStore[key].data === null) fedLoad(key, false) }, [key])
      void tick
      return fedStore[key] ?? { data: null, error: '', loading: false, measured: false }
    }
    /** 写操作：启停 / 指定入口。成功后重新取数。 */
    function fedUpdate(target, patch) {
      return fetch(FED.registry + '/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(Object.assign({ target: target }, patch)),
      }).then(res => {
        if (!res.ok) throw new Error('HTTP ' + String(res.status))
        return res.json()
      }).then(() => { fedStore.registry.data = null; return fedLoad('registry', false) })
    }

    /** 四态徽章。**顺序即含义**：这里只负责如实显示，不做任何美化合并。 */
    const AVAIL = {
      usable: { label: '实际可用', ok: true, hint: '真实完成过一次模型请求（非空回复）' },
      'auth-valid': { label: '认证有效', ok: true, hint: '认证门槛之后的列表命令成功 = 该账号凭据被接受' },
      discoverable: { label: '可发现', ok: false, hint: '该 harness 自己能列出它（尚未证明凭据可用）' },
      configured: { label: '已配置', ok: false, hint: '只出现在该 harness 的原生配置里' },
      unavailable: { label: '不可用', ok: false, hint: '明确不可用' },
    }
    function availBadge(state, evidence) {
      const meta = AVAIL[str(state)] ?? { label: str(state) || '未知', ok: false, hint: '未识别的状态' }
      return h('span', {
        style: Object.assign({}, S.badge, { color: meta.ok ? C.ok : C.textDim }),
        title: meta.hint + (str(evidence).length > 0 ? '\n证据：' + str(evidence) : ''),
      }, meta.label)
    }
    /** 三态徽章（账号）。**必须与四态分开**：登录成功 ≠ 身份可读 ≠ 模型请求认证有效。 */
    const AUTH_STATE = {
      unknown: { label: '未知', ok: null, hint: '还没查过' },
      'login-ok': { label: '登录成功', ok: null, hint: 'CLI 自己报告已登录 —— 这**不等于**凭据可用于模型请求' },
      'identity-readable': { label: '身份可读', ok: null, hint: '能读出账号身份 —— 仍**不等于**模型请求认证有效' },
      'model-request-authorized': { label: '模型请求认证有效', ok: true, hint: '真实完成过一次模型请求（非空回复）' },
      'auth-invalid': { label: '认证失效', ok: false, hint: '明确失效，需要重新登录' },
    }
    function authBadge(state, detail) {
      const meta = AUTH_STATE[str(state)] ?? { label: str(state) || '未知', ok: null, hint: '' }
      const color = meta.ok === true ? C.ok : (meta.ok === false ? C.bad : C.textSecond)
      return h('span', {
        style: Object.assign({}, S.badge, { color: color }),
        title: meta.hint + (str(detail).length > 0 ? '\n' + str(detail) : ''),
      }, meta.label)
    }
    /** 通道分级徽章：一级原生协议 / 二级 headless-PTY / 三级降级（必须显式标注）。 */
    function tierBadge(kind, tier, available) {
      const tierText = tier === 1 ? '一级' : (tier === 2 ? '二级' : '三级')
      const color = available === true ? (tier === 3 ? C.bad : C.textSecond) : C.textDim
      return h('span', {
        style: Object.assign({}, S.badge, { color: color, marginRight: 4 }),
        title: (tier === 1 ? '原生协议' : tier === 2 ? 'headless / PTY' : '降级通道（GUI/CDP）—— 必须显式标注且不得静默重派')
          + (available === true ? '：探针实测可用' : '：探针未证实可用'),
      }, kind + '·' + tierText)
    }
    /** 「未验证」标记：凡是没测到的，一律显式写未验证，不留空白假装正常。 */
    function unverifiedBadge(why) {
      return h('span', {
        style: Object.assign({}, S.badge, { color: C.textDim }),
        title: str(why) || '未验证',
      }, '未验证')
    }

    // ═══════════ 账号档案的写操作面（CRUD + 原生登录/退出 + 自动切换执行侧）═══════════
    // 三个接口都是**已实现并有独立验收**的后端能力（`src/index.ts` 的 /accounts/manage、
    // /accounts/native-auth、/pool/autoswitch）。这里的纪律只有三条：
    //   ① 失败一律**原样**显示服务端给的东西（reason / recovery / alternative / note），
    //      绝不替服务端编一个原因，也绝不把「服务端拒绝」渲染成「成功」；
    //   ② 显示文案用**稳定脱敏名**（`acct:…` 规则），机器档案 id 只留在请求体与登记表里
    //      （登记表是写操作要按 id 定位的**另一类面**，见 probe/verify-api-account-redaction.mjs 的 H4 说明）；
    //   ③ 交互式动作**只出计划**，把唯一需要用户做的那一步摆出来，绝不假装已经完成。
    const API_ACCOUNTS_MANAGE = '/harness-pilot/api/accounts/manage'
    const API_NATIVE_AUTH = '/harness-pilot/api/accounts/native-auth'
    const API_POOL_AUTOSWITCH = '/harness-pilot/api/pool/autoswitch'

    /**
     * 显示用稳定脱敏名 —— 与后端 `src/federation/poolconfig.ts` 的 `redactAccount` **同一条规则**
     * （长度 ≤ 4 给 `acct:***`；否则 `acct:…` + 末 2 字符 + 长度按 36 进制）。
     * 它只用于显示：请求体、写操作、路由仍然用机器档案 id（后端要靠它定位档案）。
     */
    function redactAccountId(id) {
      const t = str(id)
      if (t.length <= 4) return 'acct:***'
      return 'acct:…' + t.slice(-2) + t.length.toString(36)
    }
    /** 稳定显示名：人工显示名在前、脱敏名在后；**绝不回落到原始 id**。 */
    function accountLabel(displayName, id, redacted) {
      const r = str(redacted) || redactAccountId(id)
      const d = str(displayName)
      return d.length > 0 && d !== r ? d + '（' + r + '）' : r
    }
    /**
     * 把**当前档案**的原始 id 换成脱敏名（只为显示）。服务端正文的其余部分一个字都不改 ——
     * 这是显示层替换，不是重写服务端结论。
     */
    function scrubAccountId(text, id) {
      const t = str(text)
      const raw = str(id)
      if (raw.length === 0) return t
      return t.split(raw).join(redactAccountId(raw))
    }
    /** 一次 POST：HTTP 状态 **和** JSON 体都要 —— 400/409 里的服务端原因必须能显示出来。 */
    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
        .then(res => res.json()
          .catch(() => null)
          .then(json => ({ status: res.status, ok: res.ok === true, json: isObj(json) ? json : null })))
        .catch(err => ({ status: 0, ok: false, json: null, transport: str(err && err.message) || String(err) }))
    }
    /** 服务端原因：reason / error / plan.reason —— **只取第一个非空的，不改写**。 */
    function serverReason(json) {
      if (!isObj(json)) return ''
      const plan = isObj(json.plan) ? json.plan : null
      return str(json.reason) || str(json.error) || (plan === null ? '' : str(plan.reason))
    }
    /** 恢复建议：recovery / plan.alternative / alternative —— 同样只取不改写。 */
    function serverRecovery(json) {
      if (!isObj(json)) return ''
      const plan = isObj(json.plan) ? json.plan : null
      return str(json.recovery) || (plan === null ? '' : str(plan.alternative)) || str(json.alternative)
    }

    /**
     * 极简「取数 + 订阅」store。
     * 订阅按 **key** 覆盖（同一个 key 只留最后一个监听者）—— 于是重复挂载 / 反复渲染
     * 都不会把监听表撑大（离线渲染夹具里 `useEffect` 每轮都会执行，这个性质是必须的）。
     */
    function makeFeed(url) {
      const feedStore = { data: null, error: '', loading: false }
      const subs = new Map()
      const emit = () => {
        for (const listener of [...subs.values()]) {
          try {
            listener()
          } catch (err) {
            void err
          }
        }
      }
      const load = () => {
        if (feedStore.loading) return Promise.resolve()
        feedStore.loading = true
        emit()
        return fetch(url, { headers: { accept: 'application/json' } })
          .then(res => {
            if (!res.ok) throw new Error('HTTP ' + String(res.status))
            return res.json()
          })
          .then(json => {
            feedStore.data = isObj(json) ? json : null
            feedStore.error = ''
          })
          .catch(err => {
            feedStore.error = str(err && err.message) || String(err)
          })
          .then(() => {
            feedStore.loading = false
            emit()
          })
      }
      const use = (key) => {
        const [, bump] = React.useState(0)
        React.useEffect(() => {
          subs.set(key, () => bump(n => n + 1))
          return () => {
            subs.delete(key)
          }
        }, [])
        React.useEffect(() => {
          if (feedStore.data === null && feedStore.error.length === 0 && feedStore.loading === false) load()
        }, [])
        return { data: feedStore.data, error: feedStore.error, loading: feedStore.loading, reload: load }
      }
      return { load, use }
    }
    /** `GET /accounts/manage`：账号档案**登记表**（内置 ± 用户增删改；不含任何凭据）。 */
    const registryFeed = makeFeed(API_ACCOUNTS_MANAGE)
    /** `GET /pool/autoswitch`：自动切换执行侧的**真实**运行时状态。 */
    const autoSwitchFeed = makeFeed(API_POOL_AUTOSWITCH)

    /** 跨面板刷新总线：档案增删改同时影响账号列表与账号池，两个面板必须一起更新。 */
    const refreshSubs = new Map()
    function onRefresh(key, listener) {
      refreshSubs.set(key, listener)
      return () => {
        refreshSubs.delete(key)
      }
    }
    function emitRefresh() {
      for (const listener of [...refreshSubs.values()]) {
        try {
          listener()
        } catch (err) {
          void err
        }
      }
    }
    /** 档案动作成功后：登记表 + 账号列表 + 账号池全部重新取 —— 否则界面停在旧事实上。 */
    function afterAccountChange() {
      void registryFeed.load()
      // 账号列表按**上一次是否实测过**重取：否则一次删除会把其它档案的三态徽章打回「未知」，
      // 那是把已经查到的事实丢掉（界面看起来像「探测失败」）。
      const measured = fedStore.accounts.measured === true
      fedStore.accounts.data = null
      void fedLoad('accounts', measured)
      emitRefresh()
    }

    /** 动作结果块：**逐行照抄服务端**。客户端只加「这是哪一步的结果」这层包装，不解释、不改写。 */
    function ActionResultView(props) {
      const result = props.result
      if (!isObj(result)) return null
      const lines = asArray(result.lines).map(x => str(x)).filter(x => x.length > 0)
      // 「服务端拒绝」与「命令跑了但没成功」是两件事，不能都写成一个词。
      const suffix = result.ok === true ? '' : (result.refused === true ? ' —— 服务端拒绝' : ' —— 未成功')
      return h('div', { style: Object.assign({}, S.notice, { color: result.ok ? C.text : C.bad }) },
        h('div', { style: { fontWeight: 600, color: result.ok ? C.ok : C.bad } },
          str(result.title)
          + (typeof result.status === 'number' && result.status > 0 ? '（HTTP ' + String(result.status) + '）' : '')
          + suffix),
        lines.map((line, i) => h('div', { key: 'l' + String(i) }, line)),
      )
    }
    function smallButton(label, busy, onClick, title) {
      return h('button', {
        type: 'button',
        style: busy ? S.buttonSmallBusy : S.buttonSmall,
        disabled: busy,
        title: str(title),
        onClick: onClick,
      }, label)
    }

    /**
     * 原生登录 / 退出 / 状态：调 `/accounts/native-auth`，**先出计划**（不带 `run`）；
     * 只有 `mode: 'pipe'` 的**非交互**动作才允许「代为执行」。
     *
     * 为什么必须这样：登录通常是交互式的（设备码 / 浏览器授权 / 粘贴令牌），用管道捕获一个等待
     * 输入的进程只会得到「跑了但没结果」—— 那比不做更糟。所以交互式动作这里**只**把唯一需要
     * 用户做的那一步（命令 + 在哪个终端）摆出来。
     * 「未登录 / 已登录」**不**由这里判定：认证状态只由只读身份探测（三态徽章）说话。
     */
    function NativeAuthActions(props) {
      const accountId = str(props.accountId)
      const label = str(props.label) || redactAccountId(accountId)
      const [state, setState] = React.useState({ busy: '', plan: null, action: '', result: null })
      if (accountId.length === 0) {
        return h('div', { style: S.empty }, '（这个档案没有机器 id，无法调用原生认证接口）')
      }
      const request = (action, run) => {
        setState(s => Object.assign({}, s, { busy: action + (run === true ? ':run' : ''), action: action }))
        postJson(API_NATIVE_AUTH, run === true ? { accountId: accountId, action: action, run: true } : { accountId: accountId, action: action })
          .then(res => {
            const json = res.json
            if (json === null) {
              setState(s => Object.assign({}, s, {
                busy: '', plan: null,
                result: { ok: false, refused: false, title: '原生 ' + action, status: res.status, lines: [str(res.transport) || '服务端返回体不是 JSON'] },
              }))
              return
            }
            const plan = isObj(json.plan) ? json.plan : null
            const lines = []
            if (run === true) {
              const outcome = isObj(json.outcome) ? json.outcome : {}
              if (str(outcome.note).length > 0) lines.push(str(outcome.note))
              lines.push('exitCode: ' + (typeof outcome.exitCode === 'number' ? String(outcome.exitCode) : '(null)')
                + ' · 输出是否被服务端脱敏过: ' + (outcome.redacted === true ? '是' : '否'))
              if (str(outcome.stdout).length > 0) {
                lines.push('--- 原生输出 stdout（服务端已按令牌形状脱敏；其中的档案 id 这里换成脱敏名）---\n' + scrubAccountId(outcome.stdout, accountId))
              }
              if (str(outcome.stderr).length > 0) {
                lines.push('--- 原生输出 stderr（同上）---\n' + scrubAccountId(outcome.stderr, accountId))
              }
              if (str(json.note).length > 0) lines.push(str(json.note))
              lines.push('⚠️ 这只是该 CLI **自己**的原生命令的一次执行结果：它**不等于**登录成功，也**不等于**登录失败 ——'
                + '认证状态仍以只读身份探测（三态徽章）为准，本插件没有读取、复制或解密任何凭据文件。')
            } else {
              if (plan !== null) {
                if (str(plan.note).length > 0) lines.push(str(plan.note))
                if (plan.ok === true) {
                  if (str(plan.mode) === 'terminal') {
                    lines.push('这是**交互式**流程：本插件不会用管道捕获一个等待输入的进程（那只会得到「跑了但没结果」）。')
                    lines.push('**唯一需要你做的一步**：把下面这条命令原样粘贴到**你自己的终端**里执行，并按提示完成交互'
                      + '（设备码 / 浏览器授权 / 粘贴令牌等）。做完后回到这里点「状态」或「重新探测身份」核对。')
                  } else {
                    lines.push('这是**非交互**动作：可以点「代为执行」由本插件代跑，输出会先按服务端规则脱敏再显示。')
                  }
                }
                if (str(plan.cliLine).length > 0) lines.push('命令（配置目录用 <configDir> 占位，不含凭据）：\n' + scrubAccountId(plan.cliLine, accountId))
              }
              const reason = serverReason(json)
              if (reason.length > 0) lines.push('服务端原因：' + reason)
              const recovery = serverRecovery(json)
              if (recovery.length > 0) lines.push('恢复建议：' + recovery)
              if (str(json.note).length > 0) lines.push(str(json.note))
            }
            setState(s => Object.assign({}, s, {
              busy: '', plan: plan,
              result: {
                ok: run === true
                  ? (json.executed === true && isObj(json.outcome) && json.outcome.ok === true)
                  : (plan !== null && plan.ok === true),
                // 「服务端不肯执行」（交互式被拒 / 400）与「命令跑了但失败」在界面上必须能分开看。
                refused: res.status >= 400,
                title: run === true ? '原生 ' + action + '：已执行' : '原生 ' + action + '：执行计划（**未执行**）',
                status: res.status,
                lines: lines,
              },
            }))
          })
      }
      const plan = isObj(state.plan) ? state.plan : null
      const canRun = plan !== null && plan.ok === true && str(plan.mode) === 'pipe'
      return h('div', { style: S.stack },
        h('div', { style: S.rowWrap },
          smallButton('状态', state.busy === 'status', () => request('status', false), '调该 CLI 自己的只读状态命令（先出计划）'),
          smallButton('原生登录', state.busy === 'login', () => request('login', false), '先出计划：'+label+' 的原生登录入口（交互式一律由你在终端完成）'),
          smallButton('原生退出', state.busy === 'logout', () => request('logout', false), '先出计划：'+label+' 的原生退出入口'),
          canRun ? smallButton('代为执行（非交互）', state.busy === state.action + ':run', () => request(state.action, true), '仅非交互动作可代跑；输出先脱敏再显示') : null,
        ),
        h(ActionResultView, { result: state.result }),
      )
    }

    /**
     * 删除 / 恢复（两步确认）。
     * 契约要点（界面如实传递，不替服务端解释）：
     *   · **动态**档案删除成功后该 id 已不存在 —— 再删一次服务端回 400 是**正确契约**；
     *   · 内置档案删除只立**墓碑**（可 restore 回来），不会从代码里消失、也不删任何凭据；
     *   · `restore` **只**恢复被停用的内置默认档案。
     */
    function DeleteActions(props) {
      const id = str(props.id)
      const label = str(props.label) || redactAccountId(id)
      const [confirm, setConfirm] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      if (id.length === 0) return null
      const run = (kind) => {
        setBusy(kind)
        setResult(null)
        adminAction(kind, { id: id }).then(out => {
          setResult(out.result)
          setConfirm(false)
          setBusy('')
          if (out.ok) afterAccountChange()
        })
      }
      return h('div', { style: S.stack },
        h('div', { style: S.rowWrap },
          confirm
            ? h('span', { style: S.rowWrap },
                smallButton('确认删除', busy === 'delete', () => run('delete'), '删除档案登记（' + label + '）'),
                smallButton('取消', false, () => setConfirm(false), '不删了'),
              )
            : smallButton('删除档案', false, () => setConfirm(true), '两步确认：删除 '+label+' 的**登记**（不删凭据）'),
          props.canRestore === true
            ? smallButton('恢复内置默认', busy === 'restore', () => run('restore'), '把被停用的内置档案恢复回默认清单（只对内置档案有效）')
            : null,
        ),
        h(ActionResultView, { result: result }),
      )
    }

    /**
     * 提交一次账号档案动作（create / update / delete / restore）。
     * 非 0 状态**不是**客户端要解释的东西：把服务端的 `reason` / `recovery` 原样交出去。
     */
    function adminAction(kind, payload) {
      return postJson(API_ACCOUNTS_MANAGE, Object.assign({ kind: kind }, payload)).then(res => {
        const json = res.json
        if (json === null) {
          return {
            ok: false, json: null,
            result: { ok: false, refused: false, title: kind, status: res.status, lines: [str(res.transport) || '服务端返回体不是 JSON'] },
          }
        }
        if (json.ok === true) {
          return {
            ok: true, json: json,
            result: { ok: true, refused: false, title: kind, status: res.status, lines: [str(json.note)].filter(x => x.length > 0) },
          }
        }
        return {
          ok: false, json: json,
          result: {
            ok: false, refused: true, title: kind, status: res.status,
            lines: [
              '服务端原因：' + (str(json.reason) || '(服务端没有给出 reason —— 界面不替它编一个)'),
              '恢复建议：' + (str(json.recovery) || '(服务端没有给出 recovery)'),
            ],
          },
        }
      })
    }

    /** 修改档案字段（inline）。只提交**真的改过**的字段；清空默认值用 `null`（服务端契约）。 */
    function AccountEditFields(props) {
      const account = isObj(props.account) ? props.account : {}
      const id = str(account.id)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const base = {
        displayName: str(account.displayName),
        region: str(account.region) || 'unknown',
        defaultProvider: str(account.defaultProvider),
        defaultModel: str(account.defaultModel),
        note: '',
      }
      const now = draft === null ? base : draft
      if (id.length === 0) return null
      const set = patch => setDraft(Object.assign({}, now, patch))
      const submit = () => {
        const patch = {}
        if (now.displayName !== base.displayName) patch.displayName = now.displayName
        if (now.region !== base.region) patch.region = now.region
        if (str(now.defaultProvider) !== base.defaultProvider) patch.defaultProvider = str(now.defaultProvider).length === 0 ? null : str(now.defaultProvider)
        if (str(now.defaultModel) !== base.defaultModel) patch.defaultModel = str(now.defaultModel).length === 0 ? null : str(now.defaultModel)
        if (str(now.note).length > 0) patch.note = str(now.note)
        setBusy(true)
        setResult(null)
        if (Object.keys(patch).length === 0) {
          setResult({ ok: true, refused: false, title: 'update', status: 0, lines: ['没有任何字段被改动 —— 没有发请求（不制造假动作）'] })
          setBusy(false)
          return
        }
        adminAction('update', { id: id, patch: patch }).then(out => {
          setResult(out.result)
          setBusy(false)
          if (out.ok) {
            setDraft(null)
            afterAccountChange()
          }
        })
      }
      return h('div', { style: S.stack },
        h('div', { style: S.rowWrap },
          h('span', { style: S.monoDim }, '显示名'),
          h('input', { style: S.inputWide, value: now.displayName, onChange: e => set({ displayName: str(e && e.target && e.target.value) }) }),
          h('span', { style: S.monoDim }, '区域'),
          h('select', {
            value: now.region, style: S.buttonSmall,
            onChange: e => set({ region: str(e && e.target && e.target.value) }),
          },
            ['cn', 'intl', 'unknown'].map(r => h('option', { key: r, value: r }, r))),
        ),
        !['qoder', 'workbuddy', 'antigravity'].includes(cliFamily(account.harnessId)) ? h('div', { style: S.rowWrap },
          h('span', { style: S.monoDim }, '默认供应商'),
          h('input', {
            style: S.inputWide, value: now.defaultProvider, placeholder: '留空=清空（发 null）',
            onChange: e => set({ defaultProvider: str(e && e.target && e.target.value) }),
          }),
          h('span', { style: S.monoDim }, '默认模型'),
          h('input', {
            style: S.inputWide, value: now.defaultModel, placeholder: '留空=清空（发 null）',
            onChange: e => set({ defaultModel: str(e && e.target && e.target.value) }),
          }),
        ) : null,
        h('div', { style: S.rowWrap },
          h('span', { style: S.monoDim }, '备注'),
          h('input', {
            style: Object.assign({}, S.inputWide, { width: 280 }), value: now.note, placeholder: '追加一条备注（不改实测结论）',
            onChange: e => set({ note: str(e && e.target && e.target.value) }),
          }),
          smallButton(busy ? '保存中…' : '保存修改', busy, submit, '只提交改动过的字段；清空默认值会按服务端契约发 null'),
        ),
        h(ActionResultView, { result: result }),
      )
    }

    /**
     * 新增档案 + 被拒 harness 的说明 + 已停用内置档案（墓碑）的恢复入口。
     *
     * 「能不能新增」由服务端的 `isolationProfiles.mayAddAccounts` 决定：界面**只如实显示**
     * 白名单与拒绝理由（`refuseReason` / `disclosure`），不自己判断能不能加 ——
     * 拼错的目标、与 harness 不一致的目标同样交给服务端校验，失败原因原样显示。
     */
    function AccountRegistryForm(props) {
      const profiles = asArray(props.isolationProfiles).filter(isObj)
      const targets = asArray(props.targets).filter(isObj)
      const accounts = asArray(props.accounts).filter(isObj)
      const registry = isObj(props.registry) ? props.registry : null
      const addable = profiles.filter(p => p.mayAddAccounts === true)
      const refused = profiles.filter(p => p.mayAddAccounts !== true)
      const tombstones = asArray(registry === null ? null : registry.tombstones).filter(x => typeof x === 'string')
      const [form, setForm] = React.useState({ id: '', harnessId: '', targetName: '', displayName: '', region: 'unknown', note: '' })
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const harnessId = str(form.harnessId).length > 0
        ? str(form.harnessId)
        : str(addable.length > 0 ? addable[0].harnessId : '')
      const fin = addable.find(p => str(p.harnessId) === harnessId)
      const launchHint = new Set(accounts
        .filter(a => str(a.harnessId) === harnessId)
        .map(a => str(isObj(a.launch) ? a.launch.command : ''))
        .filter(x => x.length > 0))
      // 目标候选的**排序提示**（不是映射表）：该 harness 现有档案用的命令名优先，其次名字相近的。
      // 目标↔harness 是否真的一致由服务端判定 —— 这里不复制服务端的判定表。
      const ordered = targets.map(t => {
        const name = str(t.name)
        const score = launchHint.has(name) ? 0 : (name === harnessId ? 1 : (name.includes(harnessId) || harnessId.includes(name) ? 2 : 3))
        return { name: name, score: score }
      }).filter(x => x.name.length > 0).sort((a, b) => (a.score - b.score) || a.name.localeCompare(b.name))
      const set = patch => setForm(Object.assign({}, form, patch))
      const submit = () => {
        setBusy(true)
        setResult(null)
        adminAction('create', {
          input: {
            id: str(form.id), harnessId: harnessId, targetName: str(form.targetName),
            displayName: str(form.displayName), region: str(form.region) || 'unknown',
            ...(str(form.note).length > 0 ? { note: str(form.note) } : {}),
          },
        }).then(out => {
          setResult(out.result)
          setBusy(false)
          if (out.ok) {
            setForm({ id: '', harnessId: harnessId, targetName: '', displayName: '', region: 'unknown', note: '' })
            afterAccountChange()
          }
        })
      }
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '新增账号档案（POST ' + API_ACCOUNTS_MANAGE + '）'),
        h(Hint, { style: S.monoDim },
          '纯登记：不碰凭据、不复制认证文件、不关闭任何加密保护。只有「隔离开关**实测有效**」的 harness 才允许新增 ——'
          + '这是服务端白名单，界面不自己放宽。'),
        h('div', { style: S.formRow },
          h('span', { style: S.formLabel }, 'Harness'),
          addable.length === 0
            ? h('span', { style: S.monoDim }, '服务端没有给出任何可新增的 harness')
            : h('select', {
                value: harnessId, style: S.buttonSmall,
                onChange: e => set({ harnessId: str(e && e.target && e.target.value), targetName: '' }),
              }, addable.map((p, i) => h('option', { key: str(p.harnessId) + '#' + String(i), value: str(p.harnessId) }, str(p.harnessId)))),
          fin !== undefined && str(fin.disclosure).length > 0 ? h('span', { style: S.formHint }, str(fin.disclosure)) : null,
        ),
        h('div', { style: S.formRow },
          h('span', { style: S.formLabel }, '目标（必须属于该 harness）'),
          h('select', {
            value: str(form.targetName), style: S.buttonSmall,
            onChange: e => set({ targetName: str(e && e.target && e.target.value) }),
          }, [{ name: '', score: -1 }].concat(ordered).map((t, i) => h('option', { key: t.name + '#' + String(i), value: t.name }, t.name.length > 0 ? t.name : '（请选择目标）'))),
          h('span', { style: S.formHint }, '服务端会校验「目标属于所选 harness」；不一致时按服务端给的原因与恢复建议处理'),
        ),
        h('div', { style: S.formRow },
          h('span', { style: S.formLabel }, '档案 id'),
          h('input', {
            style: S.inputWide, value: str(form.id), placeholder: '例如 qoder-cn-c',
            onChange: e => set({ id: str(e && e.target && e.target.value) }),
          }),
          h('span', { style: S.formHint }, '小写字母/数字开头，字符集 a-z0-9._-，长度 2–48；它会成为配置目录名'),
        ),
        h('div', { style: S.formRow },
          h('span', { style: S.formLabel }, '显示名'),
          h('input', {
            style: S.inputWide, value: str(form.displayName), placeholder: '给人看的名字',
            onChange: e => set({ displayName: str(e && e.target && e.target.value) }),
          }),
          h('span', { style: S.formLabel }, '区域'),
          h('select', {
            value: str(form.region) || 'unknown', style: S.buttonSmall,
            onChange: e => set({ region: str(e && e.target && e.target.value) }),
          }, ['cn', 'intl', 'unknown'].map(r => h('option', { key: r, value: r }, r))),
          h('span', { style: S.formLabel }, '备注'),
          h('input', {
            style: S.inputWide, value: str(form.note), placeholder: '可选',
            onChange: e => set({ note: str(e && e.target && e.target.value) }),
          }),
        ),
        h('div', { style: S.rowWrap },
          smallButton(busy ? '提交中…' : '新增档案', busy, submit, 'POST /accounts/manage {kind:"create"}'),
        ),
        h(ActionResultView, { result: result }),
        refused.length > 0
          ? h('div', { style: { marginTop: 8 } },
              h(Hint, { style: S.monoDim }, '**不允许**新增的 harness（服务端理由，原样显示）——'),
              h('ul', { style: S.list }, refused.map((p, i) => h('li', { key: str(p.harnessId) + '#' + String(i), style: S.listItem },
                h('span', { style: Object.assign({}, S.grow, S.monoDim), title: str(p.refuseReason) || str(p.disclosure) },
                  rich([str(p.harnessId) + '：' + (str(p.refuseReason) || str(p.disclosure) || '（服务端未给出理由）')])),
              ))),
            )
          : null,
        h('div', { style: { marginTop: 8 } },
          h(Hint, { style: S.monoDim },
            '已停用的内置档案（墓碑）：' + (tombstones.length > 0
              ? '删除内置档案只会立墓碑 —— 它已从账号池与派发候选中移除，可用「恢复内置默认」放回来。'
              : '当前没有已停用的内置档案。restore **只**恢复被停用的内置默认档案，动态档案没有可恢复状态。')),
          tombstones.length > 0
            ? h('ul', { style: S.list }, tombstones.map((id, i) => h('li', { key: id + '#' + String(i), style: S.listItem },
                h('span', { style: Object.assign({}, S.grow, S.monoDim) }, id),
                h(DeleteActions, { id: id, label: redactAccountId(id), canRestore: true }),
              )))
            : null,
        ),
      )
    }

    /**
     * 自动切换执行侧：`GET /pool/autoswitch`。
     * `runtime` 里的冻结 / 冷却 / 熔断是**真实生效**的状态，`lastResult.attempts` 里每一次尝试
     * 都对应一次真实派发。界面只显示接口给的东西：没发生过就写「没有发生过」，绝不用 0 或绿色装作正常。
     */
    function AutoSwitchRuntimePanel(props) {
      const feed = autoSwitchFeed.use('autoswitch-panel')
      const members = asArray(props.members).filter(isObj)
      const redactedOf = id => {
        const found = members.find(m => str(m.accountId) === str(id))
        return isObj(found) ? str(found.redacted) : ''
      }
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const data = isObj(feed.data) ? feed.data : null
      const runtime = isObj(data && data.runtime) ? data.runtime : null
      const frozen = isObj(runtime && runtime.frozen) ? runtime.frozen : {}
      const cooldown = isObj(runtime && runtime.cooldownUntil) ? runtime.cooldownUntil : {}
      const breaker = isObj(runtime && runtime.breaker) ? runtime.breaker : {}
      const policy = isObj(data && data.policy) ? data.policy : {}
      const last = isObj(data && data.lastResult) ? data.lastResult : null
      const thaw = accountId => {
        setBusy(str(accountId) || 'all')
        setResult(null)
        postJson(API_POOL_AUTOSWITCH, accountId === undefined ? {} : { thaw: accountId }).then(res => {
          const json = res.json
          setBusy('')
          setResult({
            ok: res.ok && json !== null,
            refused: json !== null && res.ok !== true,
            title: '解冻', status: res.status,
            lines: json === null
              ? [str(res.transport) || '服务端返回体不是 JSON']
              : [str(json.note), serverReason(json)].filter(x => x.length > 0),
          })
          void feed.reload()
          emitRefresh()
        })
      }
      const entryRow = (kind, id, value) => h('li', { key: kind + ':' + str(id), style: S.listItem },
        h('span', { style: Object.assign({}, S.grow, S.monoDim) }, accountLabel('', id, redactedOf(id)) + '：' + str(value)),
        smallButton('解冻', busy === str(id), () => thaw(str(id)), '清掉该账号的冻结 / 冷却状态'),
      )
      const frozenIds = Object.keys(frozen)
      const cooldownIds = Object.keys(cooldown)
      return h('div', { style: { marginTop: 12 } },
        h('div', { style: S.sectionTitle }, '自动切换执行侧（GET ' + API_POOL_AUTOSWITCH + '）'),
        h('div', { style: S.rowWrap },
          h('span', { style: S.monoDim }, '接口：' + API_POOL_AUTOSWITCH),
          smallButton(feed.loading ? '读取中…' : '刷新执行侧状态', feed.loading, () => { void feed.reload() }, '重新读 runtime 与 lastResult'),
          smallButton('全部解冻', busy === 'all', () => thaw(undefined), '清空全部冻结 / 冷却 / 熔断状态'),
        ),
        feed.error.length > 0 ? h(Notice, { style: S.noticeError }, '自动切换执行侧接口读取失败：' + feed.error) : null,
        data === null && feed.error.length === 0 ? h('div', { style: S.empty }, feed.loading ? '读取中…' : '尚未读取') : null,
        data !== null
          ? h('div', null,
              h('div', { style: S.meta },
                h('span', null, '自动切换开关：' + (data.enabled === true ? '已启用' : '关闭中')),
                h('span', null, '连续失败 ' + (typeof breaker.consecutiveFailures === 'number' ? String(breaker.consecutiveFailures) : '(未提供)')
                  + ' / 上限 ' + (typeof policy.maxConsecutiveFailures === 'number' ? String(policy.maxConsecutiveFailures) : '(未提供)')),
                h('span', null, '每个任务最多切 ' + (typeof policy.maxSwitchesPerTask === 'number' ? String(policy.maxSwitchesPerTask) : '(未提供)') + ' 次'),
                h('span', null, 'runtime 更新于 ' + str(runtime && runtime.updatedAt)),
              ),
              h('div', { style: S.monoDim },
                'runtime 里的冻结 / 冷却 / 熔断是**真实生效**的：被冻结或处于冷却的账号不会被选为切换目标。'),
              frozenIds.length > 0 || cooldownIds.length > 0
                ? h('ul', { style: S.list },
                    frozenIds.map(id => entryRow('frozen', id, '冻结中 ' + str(frozen[id]))),
                    cooldownIds.map(id => entryRow('cool', id, '冷却至 ' + str(cooldown[id]))),
                  )
                : h('div', { style: S.empty }, '当前没有被冻结或被冷却的账号（这是接口给的 runtime，不是推测）。'),
              last === null
                ? h(Hint, { style: S.empty }, 'lastResult 为空：本次运行**还没有发生过**自动切换尝试（不是「切了 0 次成功」）。')
                : h('div', { style: S.monoDim },
                    'lastResult：' + str(last.reason) + ' · 尝试 ' + String(asArray(last.attempts).length) + ' 次 · ' + str(last.at)),
              str(data.note).length > 0 ? h('div', { style: S.monoDim }, str(data.note)) : null,
            )
          : null,
        h(ActionResultView, { result: result }),
      )
    }

    /** P1：Harness 注册表 —— 真实入口 / 真实版本（带来源）/ 连接 / 通道分级 / 启停。 */
    function RegistryPanel(props) {
      const fed = useFed('registry')
      const rows = asArray(isObj(fed.data) ? fed.data.harnesses : null).filter(isObj).filter(row => !str(props && props.targetName) || str(row.id) === str(props.targetName))
      const [busy, setBusy] = React.useState('')
      const [err, setErr] = React.useState('')
      const measured = isObj(fed.data) ? fed.data.measure === true : false
      return h('div', null,
        h('div', { style: S.meta },
          h('span', null, '共 ' + String(rows.length) + ' 个目标'),
          measured ? h('span', null, '本次为实测版本') : h('span', { style: S.monoDim }, '版本未实测'),
          h('button', {
            type: 'button',
            style: fed.loading ? S.buttonBusy : S.button,
            disabled: fed.loading,
            onClick: () => { void fedLoad('registry', !measured) },
            title: measured ? '只读已知信息（不起进程）' : '真实探测版本（会起进程，较慢）',
          }, fed.loading ? '读取中…' : (measured ? '只看已知' : '实测版本')),
        ),
        fed.error.length > 0 ? h(Notice, { style: S.noticeError }, '注册表接口读取失败：' + fed.error) : null,
        err.length > 0 ? h(Notice, { style: S.noticeError }, err) : null,
        rows.length === 0 && fed.error.length === 0
          ? h('div', { style: S.empty }, fed.loading ? '读取中…' : '暂无数据')
          : h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, '目标'),
              h('th', { style: S.th }, '类型'),
              h('th', { style: S.th }, '真实版本'),
              h('th', { style: S.th }, '连接'),
              h('th', { style: S.th }, '通道分级'),
              h('th', { style: S.th }, '启用'),
            )),
            h('tbody', null, rows.map((r, i) => {
              const inst = isObj(r.install) ? r.install : {}
              const version = str(inst.version)
              const vErr = str(inst.versionError)
              const enabled = r.enabled !== false
              const name = str(r.id)
              return h('tr', { key: name + '#' + String(i), style: S.tr },
                h('td', { style: S.td },
                  h('div', { style: S.name }, name),
                  str(r.displayName).length > 0 ? h('div', { style: S.monoEllipsis, title: str(r.displayName) }, str(r.displayName)) : null,
                ),
                h('td', { style: S.td }, str(r.kind) || '—'),
                h('td', { style: S.td },
                  version.length > 0
                    ? h('div', null,
                        h('span', { style: S.name }, version),
                        h('span', {
                          style: Object.assign({}, S.badge, { marginLeft: 4 }),
                          title: inst.versionSource === 'app-metadata'
                            ? '来自该应用自身的元数据（GUI/Electron 应用的 --version 只会回运行时版本，不予采信）'
                            : '来自该 CLI 自己的 --version',
                        }, inst.versionSource === 'app-metadata' ? '应用元数据' : 'CLI 自报'),
                      )
                    : h('div', null,
                        unverifiedBadge(vErr),
                        vErr.length > 0 ? h('div', { style: S.monoEllipsis, title: vErr }, vErr) : null,
                      ),
                  str(inst.sharedWithNote).length > 0
                    ? h('div', { style: S.monoDim }, '共享安装：' + str(inst.sharedWithNote))
                    : null,
                ),
                h('td', { style: S.td },
                  str(r.connection) || '—',
                  isObj(r.probe)
                    ? h('div', { style: S.monoEllipsis, title: str(r.probe.detail) },
                        (str(r.probe.connection) === 'ok' ? '可连' : str(r.probe.connection)))
                    : null,
                ),
                h('td', { style: S.td },
                  asArray(r.transports).filter(isObj).map((t, j) => h('span', { key: 't' + String(j) },
                    tierBadge(str(t.kind), t.tier, t.available === true),
                  )),
                ),
                h('td', { style: S.td },
                  h('button', {
                    type: 'button',
                    style: busy === name ? S.buttonBusy : S.button,
                    disabled: busy === name,
                    title: enabled ? '停用该目标（落盘，重启后仍生效）' : '启用该目标',
                    onClick: () => {
                      setBusy(name); setErr('')
                      fedUpdate(name, { enabled: !enabled })
                        .catch(e => { setErr('更新 ' + name + ' 失败：' + (str(e && e.message) || String(e))) })
                        .then(() => { setBusy('') })
                    },
                  }, enabled ? '已启用' : '已停用'),
                ),
              )
            })),
          ),
        h('div', { style: S.monoDim, marginTop: 4 },
          '注：停用只影响**新建**的派发；已在跑的任务继续用它创建时的设置。'),
      )
    }

    /**
     * P2：账号档案 —— 增删改（真动作）+ 原生登录/退出入口 + 三态分离 + 隔离披露 + 切换语义。
     *
     * 诚实性要点：
     *   · 「新增/修改/删除/恢复」都是**真的**调 `/accounts/manage`；服务端拒绝（含 400）时
     *     原样显示它的 reason / recovery —— 例如删除一个**动态**档案后再删一次、或对非内置档案
     *     调 restore，服务端回 400 就是**正确契约**，界面不得自己编一个更好听的原因；
     *   · 「原生登录 / 退出」调 `/accounts/native-auth`：**先出计划**，交互式流程只把用户
     *     唯一要做的那一步（命令 + 终端）摆出来；登录/退出本身**不**改变认证徽章；
     *   · 档案 id 在**登记表**里按原样显示（写操作要按它定位，属另一类面），
     *     而所有反馈/错误文案一律用稳定脱敏名（`acct:…`）。
     */

    function AccountsPanel(props) {
      const fed = useFed('accounts')
      const registry = registryFeed.use('accounts-registry')
      const rows = asArray(isObj(fed.data) ? fed.data.accounts : null).filter(isObj).filter(a => !str(props && props.family) || cliFamily(a.harnessId) === props.family)
      const targets = asArray(props && props.targets).filter(isObj)
      const profiles = asArray(isObj(fed.data) ? fed.data.isolationProfiles : null).filter(isObj)
      const registryBody = isObj(registry.data) && isObj(registry.data.registry) ? registry.data.registry : null
      const [defaultMessage, setDefaultMessage] = React.useState('')
      async function selectDefault(id) {
        try {
          const res = await fetch('/harness-pilot/api/accounts/default', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: id }) })
          const data = await res.json()
          if (!res.ok) throw Error(str(data.error) || '账号选择失败')
          setDefaultMessage(str(data.note))
        } catch (err) { setDefaultMessage(str(err.message)) }
      }
      const tombstoned = asArray(registryBody === null ? null : registryBody.tombstones).filter(x => typeof x === 'string')
      const groups = new Map()
      for (const a of rows) {
        const key = str(a.harnessId) || '（未知 harness）'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(a)
      }
      return h('div', null,
        h('div', { style: S.meta },
          h('span', null, '共 ' + String(rows.length) + ' 个档案，' + String(groups.size) + ' 个 harness'),
          h('span', { style: S.monoDim }, '登记表：' + String(registryBody === null ? '(未取到)' : asArray(registryBody.custom).length) + ' 个新增 · '
            + String(tombstoned.length) + ' 个内置已停用'),
          h('button', {
            type: 'button',
            style: fed.loading ? S.buttonBusy : S.button,
            disabled: fed.loading,
            onClick: () => { void fedLoad('accounts', true) },
            title: '重新做一次只读身份探测（不会登录/退出，不读取任何凭据）',
          }, fed.loading ? '探测中…' : '重新探测身份'),
        ),
        h(Collapsible, {
          label: '身份探测',
          summary: '只读；身份主键降为不可逆指纹（sha256 前 12 位），不读取 / 不导出 / 不复制任何凭据',
          text: '身份探测是**只读**的：只跑各 CLI 自己的 status，并把身份主键降为不可逆指纹（sha256 前 12 位）。不读取、不导出、不复制任何凭据。',
        }),
        h(Collapsible, {
          label: '原生登录 / 退出',
          summary: '先出计划再执行；交互式流程只给你要跑的那一步；原生命令跑成功 ≠ 登录成功',
          text: '原生登录 / 退出：调 ' + API_NATIVE_AUTH + '，一律**先出计划**（不带 run）再决定要不要执行；'
          + '交互式流程（设备码 / 浏览器授权 / 粘贴令牌）只把**唯一需要你做的那一步**（那条命令 + 你自己的终端）显示出来 ——'
          + '本插件不会用管道捕获一个等待输入的进程，那只会得到「跑了但没结果」。'
          + '登录 / 退出本身**不**改变认证徽章：原生命令跑成功也**不等于**登录成功，状态只由只读身份探测的三态徽章说话。',
        }),
        fed.error.length > 0 ? h(Notice, { style: S.noticeError }, '账号接口读取失败：' + fed.error) : null,
        registry.error.length > 0 ? h(Notice, { style: S.noticeError }, '账号登记表（' + API_ACCOUNTS_MANAGE + '）读取失败：' + registry.error) : null,
        defaultMessage ? h(Notice, null, defaultMessage) : null,
        rows.length === 0 && fed.error.length === 0 ? h('div', { style: S.empty }, '暂无档案') : null,
        h('details', { style: S.detailBox }, h('summary', { style: S.detailSummary }, '新增与恢复账号档案'), h(AccountRegistryForm, {
          isolationProfiles: profiles.filter(p => !str(props && props.family) || cliFamily(p.harnessId) === props.family),
          targets: targets,
          accounts: rows,
          registry: registryBody,
        })),
        [...groups.entries()].map(([harnessId, list]) => h('div', { key: harnessId, style: { marginTop: 12 } },
          h('div', { style: S.sectionTitle }, harnessId + ' · ' + String(list.length) + ' 个账号'),
          list.map(a => {
            const iso = isObj(a.isolation) ? a.isolation : {}
            const identity = isObj(a.identity) ? a.identity : {}
            const sw = isObj(a.switchSemantics) ? a.switchSemantics : {}
            return h('div', { key: str(a.id), style: { borderBottom: '1px solid ' + C.borderSoft, padding: '12px 0' } },
              h('div', { style: S.headRow }, h('div', null,
                h('span', { style: S.name }, accountLabel(a.displayName, str(a.id))),
                h('span', { style: Object.assign({}, S.badge, { marginLeft: 8 }) }, str(a.region) || '区域未知'),
                authBadge(identity.state, identity.detail)),
                h(NativeAuthActions, { accountId: str(a.id), label: accountLabel(a.displayName, str(a.id)) }),
                h('button', { type: 'button', style: S.buttonSmall, onClick: () => { void selectDefault(str(a.id)) } }, '用于新会话')),
              h('div', { style: S.meta },
                // ⚠️ 对账修复（2026-10-14）：这里原来只剩「认证已隔离 / 认证隔离未确认」两态，
                // **「厂商共享」那一态在改版中丢了** —— 而用户明确要求「明确说明哪些数据真正隔离、
                // 哪些仍使用厂商原生共享存储」。恢复成三态：已隔离 / 厂商共享 / 未确认。
                // 判据：`iso.authStoreIsolated === true` ⇒ 已隔离；`false`（服务端明确说了不隔离）⇒ 厂商共享；
                // 字段缺失/非布尔 ⇒ 未确认（**不把未知说成共享**，也不说成隔离）。
                iso.authStoreIsolated === true
                  ? h('span', { style: { color: C.ok }, title: str(iso.disclosure) }, '已隔离')
                  : iso.authStoreIsolated === false
                    ? h('span', { style: { color: C.bad }, title: str(iso.disclosure) + (asArray(iso.sharedWith).length > 0 ? '\n与 ' + asArray(iso.sharedWith).join('、') + ' 共享' : '') }, '厂商共享')
                    : h('span', { style: S.monoDim, title: str(iso.disclosure) }, '隔离未确认'),
                h('span', null, str(sw.currentSession) === 'in-place' ? '会话内切换' : str(sw.currentSession) === 'requires-new-process' ? '切换需新进程' : str(sw.currentSession) === 'requires-new-session' ? '切换需新会话' : '切换方式未知')),
              h('details', { style: S.detailBox }, h('summary', { style: S.detailSummary }, '身份与隔离详情'),
                h('div', { style: S.monoDim }, '档案键：' + str(a.id)),
                identity.fingerprint ? h('div', { style: S.monoDim }, '指纹：' + str(identity.fingerprint)) : null,
                h('div', { style: S.monoDim }, '配置目录：' + (str(a.configDir) || '未报告')),
                h(Hint, null, str(iso.disclosure) || '未报告认证存储隔离依据'),
                str(sw.note) ? h(Hint, null, str(sw.note)) : null,
                asArray(a.limits).map((limit, i) => h(Hint, { key: i }, str(limit)))),
              h('details', { style: S.detailBox }, h('summary', { style: S.detailSummary }, '管理（改 / 删 / 原生登录退出）'),
                h('div', { style: S.monoDim }, '改与删走 `/accounts/manage`；原生登录与退出走 `/accounts/native-auth`（**先出计划**）。'),
                h(AccountEditFields, { account: a }),
                h(DeleteActions, { id: str(a.id), label: accountLabel(a.displayName, str(a.id)), canRestore: false })))
          }))),
      )
    }

    /** 数据来源的人话名 —— `dsh-native` 只允许出现在 DSH 自己那一栏。 */
    const PROVIDER_SOURCE = {
      'cli-native-config': '该 CLI 的原生配置文件',
      'cli-list-command': '该 CLI 自己的列表命令',
      'acp-session': 'ACP 会话',
      'dsh-native': 'DSH 本 profile 的路由',
      none: '未发现来源',
    }
    /** 四态徽章里的短名，用于下拉选项的标签（下拉里放不下徽章，但状态必须跟着走）。 */
    const AVAIL_SHORT = {
      usable: '实际可用', 'auth-valid': '认证有效', discoverable: '可发现', configured: '已配置', unavailable: '不可用',
    }
    function availShort(state) {
      return AVAIL_SHORT[str(state)] || (str(state) || '未知')
    }

    /**
     * P3：供应商与模型 —— **两栏分标题**，四态徽章，**原生供应商 / 模型下拉**。
     *
     * 下拉与列表用**同一份**接口数据（`GET /providers?target=…`，必要时 `&measure=1` 实测），
     * 不新造数据源：`native`=该 harness 自己的供应商、`discovered`=它自己列表命令的结果、
     * `dshNative`=DSH 本 profile 的路由（**另一栏，永不混用**）。
     * 四态（已配置 / 可发现 / 认证有效 / 实际可用）在下拉选项里也必须带着走 ——
     * 否则「选得出来」会被读成「能用」。
     */
    function FederationProvidersPanel(props) {
      const targets = asArray(props && props.targets).filter(isObj)
      const [target, setTarget] = React.useState(str(props && props.targetName))
      const [provider, setProvider] = React.useState('')
      const [model, setModel] = React.useState('')
      const [catalogQuery, setCatalogQuery] = React.useState('')
      React.useEffect(() => {
        if (target.length === 0 && targets.length > 0) setTarget(str(targets[0].name))
      }, [targets.length])
      const slot = target.length > 0 ? providerSlot(target) : { data: null, error: '', loading: false, measured: false }
      const [tick, bump] = React.useState(0)
      React.useEffect(() => fedSubscribe(() => bump(n => n + 1)), [])
      React.useEffect(() => { if (target.length > 0) loadProviders(target, false) }, [target])
      void tick

      const inv = isObj(slot.data) ? slot.data : null
      const catalog = asArray(inv && inv.catalog).filter(isObj)
      const native = asArray(inv && inv.native).filter(isObj)
      const models = asArray(inv && inv.discovered).filter(isObj)
      const dshNative = asArray(inv && inv.dshNative).filter(isObj)
      const declared = isObj(inv && inv.declared) ? inv.declared : {}
      const errors = asArray(inv && inv.errors).filter(x => typeof x === 'string')
      // 下拉候选：选中某个原生供应商时只列它自己的模型；否则列该 harness 列表命令发现的全部模型。
      const picked = native.find(p => str(p.id) === provider) || null
      const modelOptions = picked !== null ? asArray(picked.models).filter(isObj) : models
      const pickedModel = modelOptions.find(m => str(m.id) === model) || null

      return h('div', null,
        h('div', { style: S.formRow },
          !str(props && props.targetName) ? h('span', null, 'Harness') : null,
          !str(props && props.targetName) ? h('select', {
            value: target,
            style: Object.assign({}, S.button, { cursor: 'pointer' }),
            onChange: e => {
              setTarget(str(e && e.target && e.target.value))
              setProvider('')
              setModel('')
            },
          }, targets.map((t, i) => h('option', { key: str(t.name) + '#' + String(i), value: str(t.name) }, str(t.name)))) : null,
          h('button', {
            type: 'button',
            style: slot.loading ? S.buttonBusy : S.button,
            disabled: slot.loading || target.length === 0,
            onClick: () => { void loadProviders(target, true) },
            title: '运行该 harness 自己的模型列表命令（实测，不起会话）',
          }, slot.loading ? '探测中…' : '实测发现'),
        ),
        // ── 原生供应商 / 模型下拉（数据源同上，不新造一套）──
        inv !== null ? h('div', { style: S.formRow },
          h('span', { style: S.formLabel }, '原生供应商'),
          native.length === 0
            ? h('span', { style: S.monoDim }, '该 harness 的原生供应商清单为空（空就是空，不拿 DSH 的供应商填充）')
            : h('select', {
                value: provider, style: S.buttonSmall,
                onChange: e => { setProvider(str(e && e.target && e.target.value)); setModel('') },
              }, [{ id: '', availability: '', source: '' }].concat(native).map((p, i) => h('option', { key: 'p' + str(p.id) + '#' + String(i), value: str(p.id) },
                str(p.id).length === 0 ? '（全部原生供应商）' : str(p.displayName) + ' · ' + availShort(p.availability)))),
          h('span', { style: S.formHint }, picked === null
            ? '未筛选：下面列该 harness 能发现/配置的全部模型'
            : '来源：' + (PROVIDER_SOURCE[str(picked.source)] || str(picked.source) || '(未注明)')),
        ) : null,
        inv !== null ? h('div', { style: S.formRow },
            h('span', { style: S.formLabel }, '模型筛选'),
          modelOptions.length === 0
            ? h('span', { style: S.monoDim }, '没有可选模型（原因见上方）')
            : h('select', {
                value: model, style: Object.assign({}, S.buttonSmall, { maxWidth: 320 }),
                onChange: e => setModel(str(e && e.target && e.target.value)),
              }, [{ id: '' }].concat(modelOptions).map((m, i) => h('option', { key: 'm' + str(m.id) + '#' + String(i), value: str(m.id) },
                str(m.id).length === 0 ? '（不指定模型）' : str(m.id) + ' · ' + availShort(m.availability)))),
          pickedModel !== null ? availBadge(pickedModel.availability, pickedModel.evidence) : null,
        ) : null,
        pickedModel !== null ? h('div', { style: S.monoDim },
          '所选模型的证据（服务端给原文）：' + (str(pickedModel.evidence) || '(未给出)')) : null,
        slot.error.length > 0 ? h(Notice, { style: S.noticeError }, '供应商接口读取失败：' + slot.error) : null,
        h('input', { style: S.input, value: catalogQuery, placeholder: '搜索模型名称', onChange: e => setCatalogQuery(e.target.value) }),
        catalog.length > 0 ? h('div', null,
          h('div', { style: S.sectionTitle }, '原生目录与模型别名 · ' + catalog.length),
          h('ul', { style: Object.assign({}, S.list, { maxHeight: 260, overflowY: 'auto' }) }, catalog.filter(row => str(row.id).toLowerCase().includes(catalogQuery.toLowerCase())).map(row => h('li', { key: row.id, style: S.listItem, title: str(row.evidence) },
            h('span', { style: S.grow }, (row.provider ? str(row.provider) + ' · ' : '') + str(row.id)),
            h('span', { style: S.monoDim }, row.selectable ? '可选 · ' + str(row.source) : '仅展示 · CLI 不接受此模型参数'),
          ))),
          h('div', { style: S.monoDim }, '执行模型在原版会话选择器中选择；目录不代表当前账号授权。'),
        ) : null,
        inv === null && slot.error.length === 0 ? h('div', { style: S.empty }, slot.loading ? '读取中…' : '请选择 harness') : null,

        inv !== null ? h('div', { style: S.meta },
          h('span', null, '列表命令：' + (asArray(declared.listCommand).join(' ') || '(该 harness 没有)')),
          declared.authBlocked === true ? h('span', { style: { color: C.bad } }, '认证受阻') : null,
        ) : null,
        errors.length > 0 ? h(Notice, { style: S.notice },
          errors.map((e, i) => h('div', { key: 'e' + String(i) }, '· ' + e))) : null,
        // 四态口径（写成整句，**不**单独放四态短名 —— 那样会让「徽章是否真的出现过」的断言失去意义）；
        // 下拉选项里也带着状态：选得出来 ≠ 能用。
        inv !== null ? h('details', { style: S.detailBox }, h('summary', { style: S.detailSummary }, '状态与来源说明'), h('div', { style: S.monoDim },
          '四态只升不降、逐级要证据：configured = 只出现在该 harness 的原生配置里；'
          + 'discoverable = 该 harness 自己能列出来（尚未证明凭据可用）；'
          + 'auth-valid = 认证门槛之后的列表命令成功（凭据被接受）；'
          + 'usable = 账本里有该模型一次真实完成、非空回复。null/未知一律按「未验证」显示，不并级、不美化。')) : null,

        inv !== null ? h('div', { style: { marginTop: 10, display: 'flex', gap: 18, alignItems: 'flex-start' } },
          // ── 左栏：该 harness 自己的供应商 ──
          h('div', { style: { flex: '1 1 0', minWidth: 0 } },
            h('div', { style: S.sectionTitle }, '「' + target + '」原生供应商与模型（' + String(models.length) + '）'),
            h(Hint, { style: S.monoDim }, '来源：该 harness 自己的配置与列表命令。**不含** DSH 的供应商。'),
            models.length === 0
              ? h('div', { style: S.empty }, '没有发现任何模型 —— 见上方原因（空就是空，不用 DSH 的列表填充）')
              : h('ul', { style: Object.assign({}, S.list, { maxHeight: 300, overflowY: 'auto' }) }, models.filter(m => str(m.id).toLowerCase().includes(catalogQuery.toLowerCase())).map((m, i) => h('li', { key: str(m.id) + '#' + String(i), style: S.listItem },
                  h('span', { style: S.grow, title: str(m.id) }, str(m.id)),
                  availBadge(m.availability, m.evidence),
                ))),
          ),

        ) : null,
      )
    }

    function cliFamily(value) {
      const name = str(value).toLowerCase()
      if (/qoder/.test(name)) return 'qoder'
      if (/workbuddy|wb-managed/.test(name)) return 'workbuddy'
      if (/antigravity|^agy(?:-|$)/.test(name)) return 'antigravity'
      return name
    }

    /**
     * CLI 友好名。
     *
     * 为什么需要：左栏与标题原来直接画**内部目标名**（`wb-managed-a`、`qoder-cn-acct-a`、
     * `opencode-desktop` …），35 条全是内部标识符 —— 用户原话「信息平摊在页面中」里很大一部分就是它。
     * 内部名仍然保留在 `title` 与详情里（写操作要按它定位），只是不再当主标题。
     */
    const CLI_LABELS = {
      opencode: 'OpenCode', 'opencode-desktop': 'OpenCode 桌面版', 'opencode-flash': 'OpenCode Flash', 'opencode-tui': 'OpenCode TUI',
      pi: 'Pi', claude: 'Claude Code', codex: 'Codex',
      agy: 'Antigravity CLI', antigravity: 'Antigravity IDE',
      'zcode-cli': 'ZCode CLI', zcode: 'ZCode 桌面版',
      qoder: 'Qoder IDE（国际）', qodercli: 'Qoder 国际 CLI', 'qoder-cli': 'Qoder IDE CLI（国际）',
      qoderclicn: 'Qoder 国内 CLI', 'qoder-cn': 'Qoder 国内',
      'qoder-cn-acct-a': 'Qoder 国内 · 账号 A', 'qoder-cn-acct-b': 'Qoder 国内 · 账号 B',
      'qoder-cn-app': 'Qoder 国内 IDE',
      'wb-managed-a': 'WorkBuddy 国内', 'wb-managed-ai-b': 'WorkBuddy 国际',
      workbuddy: 'WorkBuddy 桌面版', 'workbuddy-ai': 'WorkBuddy AI 桌面版',
      codebuddy: 'CodeBuddy CLI', 'command-code': 'Command Code', cursor: 'Cursor',
      gemini: 'Gemini CLI', grok: 'Grok 桌面版', 'grok-cli': 'Grok CLI',
      kimi: 'Kimi Code', mimo: 'MiMo 桌面版', 'mimo-ai': 'MiMo AI', 'mimo-cli': 'MiMo CLI',
      minimax: 'MiniMax', qwen: 'Qwen CLI',
      // 账号型 provider（与 dsh-model-connect 的 HARNESS_LABELS 同名；徽章展示用）
      'workbuddy-cn': 'WorkBuddy（国内）', 'workbuddy-intl': 'WorkBuddy.AI（国际）',
      'qoder-cn': 'Qoder（国内）', 'qoder-intl': 'Qoder（国际）',
    }
    /** DeepSeek 原生供应商展示名（2026-10-15 用户要求徽章覆盖全部供应商，含内部）。 */
    const NATIVE_PROVIDER_LABELS = {
      deepseek: 'DeepSeek',
      'deepseek-account': 'DeepSeek Account',
      'opencode-go': 'opencode-go',
      step: 'step',
      xiaomi: 'Xiaomi MiMo',
      muze: 'muze',
    }
    /** 徽章 tooltip 用的完整供应商名（原生优先映射，外部走 CLI_LABELS）。 */
    function providerLabelFull(provider, fallback) {
      const key = str(provider)
      if (key.startsWith('harness-')) {
        const rest = key.slice(8)
        return CLI_LABELS[rest] !== undefined ? '外部 · ' + CLI_LABELS[rest] : '外部 · ' + rest
      }
      return NATIVE_PROVIDER_LABELS[key] !== undefined ? NATIVE_PROVIDER_LABELS[key] : (fallback && fallback.length > 0 ? fallback : key)
    }
    function cliLabel(name) {
      const key = str(name)
      return CLI_LABELS[key] !== undefined ? CLI_LABELS[key] : key
    }

    /**
     * 设置页主体（2026-10-15 第四版）。
     *
     * 用户要求（原话，2026-10-14）：「只允许国内版和国外版的 CLI 区分成两条，其他的通通都算一条」，
     * 页面只保留四类信息（发现哪些 CLI 及其模型 / 登录账号 / 账号池 / 哪些模型可在会话与子代理中被选择）。
     * 2026-10-15 追加：「符合 DeepSeek 类似原版的特征，信息要明确，**不要把大量信息都堆积在页面中**」。
     *
     * 因此本版：
     *   · 默认可见面 = 「一条 harness 一行」的折叠列表（分组来自服务端 `/overview` 的
     *     `harnessGroups`，唯一一份分类实现在 `src/harness-groups.ts`）。行头只给
     *     「状态 · 模型数 · 账号数 · 选择器显示 M/N」；展开体首块就是**会话模型选择器显示**
     *     （整组开关 + 上限 + 逐模型勾选），其余发现/供应商目录全部收进默认关闭的 details。
     *   · 「高级与诊断」（注册表 / 任务 / 会话 / 进程 / 宿主供应商 / 自动切换 / 插件设置）
     *     保留在本页底部，**默认全部收起**（2026-10-15 第五版：原「设置 → 插件」二级页已删，
     *     用户要求只保留一张设置页；面板并入这里，一个不少）。
     *   · 账号型模型（WorkBuddy / Qoder 多账号 + 号池）已拆到独立插件
     *     `@dsh-external/dsh-model-connect`（设置 → API 模型连接），本页不再渲染它。
     */
    function HarnessPilotSection(props) {
      const overview = useOverview()
      const targets = readTargets(overview.data)
      const sessions = readSessions(overview.data)
      const allTabs = isObj(props) && props.allTabs === true
      const groups = isObj(overview.data) && Array.isArray(overview.data.harnessGroups)
        ? overview.data.harnessGroups.filter(isObj)
        : null
      const [open, setOpen] = React.useState('')
      const [query, setQuery] = React.useState('')
      // 子代理白名单**只拉一次**（16 行共用同一份候选与当前状态；避免每行各发一次请求）。
      const policy = useSubagentPolicy()
      // 选择器可见性同样只拉一次（18 行共用；写后由 apply() 内部 reload）。
      const visibility = useModelVisibility()
      // 冷启动补刷（2026-10-15 用户反馈「行头都是 0 个模型」）：落盘模型缓存超过 6 小时
      // 会被服务端按「不新鲜」丢弃，挂载后的后台预热要十几秒才填回。此时行头/概览都是 0，
      // 用户看到的页面却不会再自己变 —— 这里在「有目标但全部组 0 模型」时自动补拉两次
      // （15s / 35s），预热完成后计数自动出现；不弹错误、不无限轮询。
      const coldCount = groups !== null && groups.length > 0 && groups.every(g => !isObj(g.picker) || asNum(g.picker.total) === 0)
      const reloadRef = React.useRef(null)
      reloadRef.current = overview.reload
      React.useEffect(() => {
        if (!coldCount) return
        const timers = [15000, 35000].map(ms => setTimeout(() => { void reloadRef.current() }, ms))
        return () => timers.forEach(t => clearTimeout(t))
      }, [coldCount])
      const active = groups === null
        ? []
        : groups.filter(g => (str(g.label) + ' ' + asArray(g.members).join(' ')).toLowerCase().includes(query.toLowerCase()))
      return h('div', { 'data-pilot-settings': 'native', style: Object.assign({}, S.page, { paddingTop: 8, paddingBottom: 24 }) },
        h('div', { style: S.headRow },
          h('div', null,
            h('div', { style: S.title }, '外部 harness 管理'),
            h('div', { style: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: C.textSecond } }, '管理外部 Harness 的模型、账号和会话菜单显示。')),
          h('button', { type: 'button', style: S.button, disabled: overview.loading, onClick: () => { void overview.reload() } }, overview.loading ? '刷新中…' : '刷新')),
        overview.error ? h(Notice, { style: S.noticeError }, overview.error) : null,
        h('div', { style: { marginTop: 20, marginBottom: 20 } },
          h('input', {
            'aria-label': '搜索 harness',
            placeholder: '搜索 harness 或它的目标名',
            value: query,
            style: Object.assign({}, S.input, { width: '100%' }),
            onChange: e => setQuery(e.target.value),
          })),
        groups === null
          ? h(Notice, { style: S.noticeError }, '宿主接口没有返回 harness 分组（`/overview` 的 `harnessGroups`）。'
            + '这通常意味着服务端与客户端不是同一版：请重载插件后刷新本页。**这里不回退成「一个目标一行」**——'
            + '那正是你要去掉的重复形态。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 24 } },
            active.length === 0
              ? h('div', { style: S.empty }, '没有匹配的 harness')
              : active.map(group => h(HarnessGroupRow, {
                key: str(group.id),
                group,
                targets,
                allTabs,
                policy,
                visibility,
                open: allTabs || open === str(group.id),
                onToggle: () => setOpen(open === str(group.id) ? '' : str(group.id)),
              }))),
        // 2026-10-15 第五版：本插件只保留**这一张**设置页（用户要求「只有一个设置页面就可」）。
        // 原第二张（设置 → 插件 → 外部 harness 管理，`settings.plugins.tab`）已删，
        // 它承载的诊断与运营面板作为**默认收起**的 details 并入本页底部 —— 面板一个不少，
        // 只是不再有两张页面。
        h('details', { style: Object.assign({}, S.detailBox, { marginTop: 20 }) },
          h('summary', { style: S.detailSummary }, '插件设置'),
          h(SettingsForm, { overview })),
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary }, '任务与执行身份'),
          h(TasksPanel, { overview })),
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary }, '实时会话'),
          h(SessionsList, { sessions })),
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary }, '进程与内存'),
          h(ProcessMemoryPanel)),
        // ⚠️ 诚实性要求（用户原话：不得拿宿主的模型目录冒充外部 CLI 的模型目录）：
        // DSH 自己那一栏必须**显式命名**，并写明两栏**不含**对方、来源与命名空间都不同。
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary }, 'DSH 本 profile 已配置供应商'),
          h(Hint, null, '本栏是 **DSH 自己**的 llm 路由与模型（宿主供应商）。它与上面每条 harness 的'
            + '「该 CLI 自己报的模型」**来源不同、命名空间不同，两栏永不混用**：'
            + '外部 CLI 的列表为空时就是空，**不含** DSH 的模型；DSH 的列表也**不含**任何外部 CLI 的条目。'),
          h(ProvidersList, { providers: readProviders(overview.data) })),
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary }, 'Harness 注册表（入口、版本与启停）'),
          h(RegistryPanel, {})),
        // 自动切换执行侧：**本轮按用户要求不启用**，但面板与它的真实状态入口必须还在
        // （把面板删掉才是「用隐藏掩盖功能」；这里保留 + 明确说明不启用）。
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary }, '自动切换执行侧（本轮**暂不启用**：不实现、也不开启额度耗尽自动换号）'),
          h(AutoSwitchRuntimePanel, null)),
      )
    }

    /**
     * 会话模型选择器**可见性**（2026-10-15，用户要求「模型选择列表不要这么长、这么臃肿」
     * 「在设置中能够选择哪些 CLI 的哪些模型不显示在模型列表中」）。
     *
     * 数据源：`GET /api/model-visibility`（配置 + 每组「全量清单 ∪ 已配置隐藏项」摘要）。
     * 与 `useSubagentPolicy` 同一模式：整页只拉一次、写后独立回读。
     * 语义边界（面板里也要说明白）：隐藏/超限只影响**会话选择器的展示面**；
     * 已选中某模型的会话照常执行（执行校验走全量实时清单）；子代理白名单是另一套，不受影响。
     */
    function useModelVisibility() {
      const [state, setState] = React.useState({ data: null, error: '', loading: false, saving: false, result: null })
      const reload = React.useCallback(() => {
        setState(s => Object.assign({}, s, { loading: true }))
        fetch(API_MODEL_VISIBILITY, { headers: { accept: 'application/json' } })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + String(r.status)); return r.json() })
          .then(j => setState(s => Object.assign({}, s, { data: isObj(j) ? j : null, error: '', loading: false })))
          .catch(e => setState(s => Object.assign({}, s, { error: str(e && e.message) || String(e), loading: false })))
      }, [])
      React.useEffect(() => { reload() }, [reload])
      const apply = React.useCallback((body) => {
        setState(s => Object.assign({}, s, { saving: true, result: null }))
        return fetch(API_MODEL_VISIBILITY, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        })
          .then(r => r.json().then(j => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            setState(s => Object.assign({}, s, { saving: false, result: Object.assign({ httpOk: ok }, isObj(j) ? j : {}) }))
            reload()
            return { ok, j }
          })
          .catch(e => {
            setState(s => Object.assign({}, s, { saving: false, result: { ok: false, httpOk: false, reason: str(e && e.message) || String(e) } }))
            return { ok: false, j: {} }
          })
      }, [reload])
      return Object.assign({ reload, apply }, state)
    }

    /**
     * 一条 harness 的「会话模型选择器显示」管理面板（2026-10-15 用户要求逐模型显隐；晚间恢复交互版）。
     * 整组开关 + 每组上限 + 逐模型勾选；保存走 POST /model-visibility（写前撤销档 + 回读）。
     * 语义边界（面板里说明白）：隐藏/超限只影响**会话选择器**的展示面；
     * 已选中某模型的会话照常执行；子代理白名单是另一套，在下面单独管。
     */
    function PickerVisibilityPanel(props) {
      const providerId = str(props.providerId)
      const visibility = isObj(props.visibility) ? props.visibility : {}
      const data = isObj(visibility.data) ? visibility.data : null
      const row = data === null ? null : (asArray(data.providers).filter(isObj).find(p => str(p.providerId) === providerId) || null)
      const summary = row !== null && isObj(row.summary) ? row.summary : null
      const defaults = data !== null && isObj(data.defaults) ? data.defaults : {}
      const [limit, setLimit] = React.useState(null)
      const [groupHidden, setGroupHidden] = React.useState(null)
      const [draftHidden, setDraftHidden] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => {
        if (summary === null) return
        setLimit(asNum(summary.limit))
        setGroupHidden(summary.groupHidden === true)
        setDraftHidden(new Set(asArray(summary.models).filter(isObj).filter(m => m.visible === false).map(m => str(m.id))))
      }, [data])
      if (summary === null) {
        return h('div', { style: { paddingLeft: 12 } },
          h(Hint, null, '会话模型选择器可见性接口不可用'
            + (str(visibility.error).length > 0 ? '：' + str(visibility.error) : '（/api/model-visibility 未挂载或仍在加载）。')))
      }
      const models = asArray(summary.models).filter(isObj)
      const configuredHidden = models.filter(m => m.visible === false).map(m => str(m.id))
      const draftHiddenSet = draftHidden === null ? new Set(configuredHidden) : draftHidden
      const draftLimit = limit === null ? asNum(summary.limit) : limit
      const draftGroupHidden = groupHidden === null ? summary.groupHidden === true : groupHidden
      const diffHide = Array.from(draftHiddenSet).filter(id => !configuredHidden.includes(id))
      const diffShow = configuredHidden.filter(id => !draftHiddenSet.has(id))
      const dirty = draftLimit !== asNum(summary.limit)
        || draftGroupHidden !== (summary.groupHidden === true)
        || diffHide.length > 0 || diffShow.length > 0
      const visibleAfter = draftGroupHidden
        ? 0
        : Math.min(draftLimit === 0 ? Infinity : draftLimit, models.filter(m => !draftHiddenSet.has(str(m.id))).length)
      const effVisibleText = String(visibleAfter === Infinity ? models.length : visibleAfter)
      const save = () => {
        const body = { providerId }
        if (draftGroupHidden !== (summary.groupHidden === true)) body.groupHidden = draftGroupHidden
        if (draftLimit !== asNum(summary.limit)) body.limit = draftLimit
        if (diffHide.length > 0) body.hideModels = diffHide
        if (diffShow.length > 0) body.showModels = diffShow
        setBusy(true)
        visibility.apply(body).then(() => setBusy(false))
      }
      const reset = () => {
        setBusy(true)
        visibility.apply({ providerId, reset: true }).then(() => setBusy(false))
      }
      const filtered = models.filter(m => str(m.id).toLowerCase().includes(query.toLowerCase()))
      return h('div', { style: { padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 } },
        h('div', { style: Object.assign({}, S.formRow, { margin: 0 }) },
          h('span', { style: S.grow },
            h('strong', null, '会话菜单显示 ' + effVisibleText + ' / ' + String(asNum(summary.total))),
            h('span', { style: Object.assign({}, S.monoDim, { marginLeft: 12 }) }, '上限 ' + String(draftLimit === 0 ? '不限' : draftLimit)))),
        h('div', { style: Object.assign({}, S.formRow, { flexWrap: 'wrap', gap: 10 }) },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: !draftGroupHidden, onChange: e => setGroupHidden(e.target.checked !== true) }),
            '在会话菜单显示此 harness'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, '上限',
            h('input', {
              type: 'number', min: 0, max: 500, value: String(draftLimit), disabled: draftGroupHidden,
              'aria-label': '模型选择器每组显示上限（0 = 不限）',
              style: Object.assign({}, S.input, { width: 84 }),
              onChange: e => {
                const parsed = parseInt(e.target.value, 10)
                setLimit(Number.isFinite(parsed) ? Math.max(0, Math.min(500, parsed)) : 0)
              },
            })),
          h('button', { type: 'button', style: busy ? S.buttonBusy : S.button, disabled: busy || !dirty, onClick: save },
            busy ? '保存中…' : '保存显示设置'),
          h('button', { type: 'button', style: S.buttonSmall, disabled: busy, onClick: reset }, '恢复默认')),
        h(Hint, null, '只控制会话菜单展示。完整目录仍可查看，子代理选择不受影响。0 表示不限数量。'),
        h('details', { style: S.detailBox },
          h('summary', { style: S.detailSummary },
            '逐个模型控制显示（' + String(models.length) + ' 个'
            + (draftHiddenSet.size > 0 ? '，其中 ' + String(draftHiddenSet.size) + ' 个已设为隐藏' : '') + '）'),
          models.length === 0
            ? h('div', { style: S.empty }, '这条 harness 当前没有报出任何模型（未预热或真的没有；见下方「模型发现」）。')
            : h('div', null,
              h('input', {
                'aria-label': '搜索模型', placeholder: '搜索模型', value: query,
                style: Object.assign({}, S.input, { marginBottom: 6 }),
                onChange: e => setQuery(e.target.value),
              }),
              h('div', { style: { maxHeight: 220, overflowY: 'auto' } },
                filtered.map(m => {
                  const id = str(m.id)
                  return h('label', {
                    key: 'vis-' + id,
                    style: { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', opacity: m.known === false ? 0.55 : 1 },
                    title: m.known === false ? '该 CLI 当前已不再报这个模型（配置保留，重测出现即生效）' : id,
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: !draftHiddenSet.has(id),
                    onChange: e => {
                      setDraftHidden(prev => {
                        const next = new Set(prev === null ? configuredHidden : prev)
                        if (e.target.checked === true) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    },
                  }),
                  h('span', { style: S.grow }, id),
                  m.known === false ? h('span', { style: S.monoDim }, '当前未回报') : null)
                })),
              h(Hint, null, '取消勾选 = 不在选择器显示。')),
        ),
        isObj(visibility.result) && str(visibility.result.reason).length > 0
          ? h(Notice, { style: isObj(visibility.result) && visibility.result.ok === true ? S.notice : S.noticeError },
            (visibility.result.ok === true ? '已保存：' + str(visibility.result.note) : '保存失败：' + str(visibility.result.reason)))
          : null,
      )
    }

    /**
     * 子代理模型白名单（宿主 `subagent-model-selection-settings.allowedModels`）的读写。
     *
     * 为什么界面上要有这一块：会话选择器只要插件注册了 provider 就能看见模型，
     * 而**子代理**那条路还要过宿主一道**精确串白名单**（不匹配就抛
     * `child LLM route "…" is not allowed for this Session`）。用户要求「该 harness 中的模型，
     * 能够选择哪些在会话和子代理选择中被选择」⇒ 必须能勾、能看差分、能看回读结果。
     *
     * 纪律：只增删本插件路由（服务端保证）；写前落回滚快照；写后独立回读；
     * 改动**只对新会话生效**（宿主在会话创建时记录一次策略）——界面上明说这一点。
     */
    function useSubagentPolicy() {
      const [state, setState] = React.useState({ data: null, error: '', loading: false, saving: false, result: null })
      const reload = React.useCallback(() => {
        setState(s => Object.assign({}, s, { loading: true }))
        fetch(API_SUBAGENT_MODELS, { headers: { accept: 'application/json' } })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + String(r.status)); return r.json() })
          .then(j => setState(s => Object.assign({}, s, { data: isObj(j) ? j : null, error: '', loading: false })))
          .catch(e => setState(s => Object.assign({}, s, { error: str(e && e.message) || String(e), loading: false })))
      }, [])
      React.useEffect(() => { reload() }, [reload])
      const apply = React.useCallback((add, remove) => {
        setState(s => Object.assign({}, s, { saving: true, result: null }))
        fetch(API_SUBAGENT_MODELS, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ add, remove }),
        })
          .then(r => r.json().then(j => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            setState(s => Object.assign({}, s, { saving: false, result: Object.assign({ httpOk: ok }, isObj(j) ? j : {}) }))
            reload()
          })
          .catch(e => setState(s => Object.assign({}, s, { saving: false, result: { ok: false, httpOk: false, reason: str(e && e.message) || String(e) } })))
      }, [reload])
      return Object.assign({ reload, apply }, state)
    }

    /** 一条 harness 的「可在子代理中被选择」勾选面板（默认折叠；只在展开时渲染清单）。 */
    function SubagentPolicyPicker(props) {
      const policy = isObj(props.policy) ? props.policy : {}
      const data = isObj(policy.data) ? policy.data : null
      const [open, setOpen] = React.useState(props.allTabs === true)
      const [query, setQuery] = React.useState('')
      const [checked, setChecked] = React.useState(null)
      const providerId = str(props.providerId)
      // 首屏摘要来自 `/overview`（服务端读过一次），明细来自按需的 `/subagent-model-selection`。
      const summary = isObj(props.summary) ? props.summary : {}
      const all = asArray(data ? data.candidates : null).filter(isObj).filter(c => str(c.provider) === providerId)
      const enabledCount = data === null ? asNum(summary.allowedCount) : all.filter(c => c.enabled === true).length
      const totalCount = data === null ? asNum(summary.candidateCount) : all.length
      const writable = data === null ? summary.writable === true : data.writable === true
      const available = data === null ? summary.available === true : data.available === true
      const reason = data === null ? str(summary.reason) : str(data.reason)
      const base = React.useMemo(() => {
        const next = {}
        for (const c of all) next[str(c.model)] = c.enabled === true
        return next
      }, [data, providerId])
      const selection = checked === null ? base : checked
      const filtered = query.length === 0 ? all : all.filter(c => str(c.model).toLowerCase().includes(query.toLowerCase()))
      const add = [], remove = []
      for (const c of all) {
        const want = selection[str(c.model)] === true
        if (want && c.enabled !== true) add.push({ provider: providerId, model: str(c.model) })
        if (!want && c.enabled === true) remove.push({ provider: providerId, model: str(c.model) })
      }
      const dirty = add.length > 0 || remove.length > 0
      const result = isObj(policy.result) ? policy.result : null
      return h('div', { style: { paddingLeft: 12 } },
        h('div', { style: Object.assign({}, S.formRow, { paddingLeft: 0 }) },
          h('span', { style: S.grow }, '可在子代理中被选择：' + String(enabledCount) + ' / ' + String(totalCount) + ' 个模型'),
          h('button', { type: 'button', style: S.buttonSmall, onClick: () => setOpen(!open) }, open ? '收起' : '选择')),
        available !== true
          ? h(Notice, { style: S.noticeError }, '白名单不可用：' + reason)
          : writable !== true
            ? h(Hint, null, '宿主 `settings` 服务不可写 ⇒ 这里只能看，不能勾（明细读取：'
              + (policy.error.length > 0 ? '失败，' + policy.error : policy.loading ? '进行中…' : '就绪') + '）。')
            : null,
        h(Hint, null, '只影响**新会话**：宿主在会话创建时把白名单记一次（已开的会话策略不变）。'
          + '写入前自动落回滚快照，写后**独立回读**核验。'),
        open
          ? h('div', null,
            data === null
              ? h(Hint, null, policy.error.length > 0 ? '明细读取失败：' + policy.error : '明细读取中…')
              : h('div', null,
                h('input', { 'aria-label': '搜索模型', placeholder: '搜索模型', value: query, style: Object.assign({}, S.input, { width: '100%' }), onChange: e => setQuery(e.target.value) }),
                h('div', { style: { maxHeight: 220, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 4, marginTop: 6 } },
                  filtered.length === 0
                    ? h('div', { style: S.empty }, '没有匹配的模型')
                    : filtered.map(c => h('label', { key: str(c.model), style: Object.assign({}, S.formRow, { paddingLeft: 4, cursor: 'pointer' }) },
                      h('input', {
                        type: 'checkbox',
                        checked: selection[str(c.model)] === true,
                        disabled: writable !== true || policy.saving === true,
                        onChange: e => setChecked(Object.assign({}, selection, { [str(c.model)]: e.target.checked === true })),
                      }),
                      h('span', { style: S.grow }, str(c.model)))))),
            // ⚠️ 「改动摘要 + 应用按钮」**不依赖明细是否已到达**：它们本身就是能力的存在证明
            // （明细没到时按钮是禁用的，而不是整个面板消失 —— 后者会被读成「没有这个功能」）。
            h('div', { style: Object.assign({}, S.formRow, { paddingLeft: 0 }) },
              h('span', { style: S.grow }, data === null
                ? '明细未就绪'
                : dirty ? '本次将 +' + String(add.length) + ' / −' + String(remove.length) : '没有改动'),
              h('button', {
                type: 'button',
                style: S.buttonSmall,
                disabled: data === null || !dirty || policy.saving === true || writable !== true,
                onClick: () => policy.apply(add, remove),
              }, policy.saving === true ? '写入中…' : '应用到新会话')))
          : null,
        result !== null
          ? h(Notice, { style: result.verified === true ? null : S.noticeError },
            (result.dryRun === true ? '（dryRun）' : result.verified === true ? '已写入并回读一致' : '写入未通过回读核验')
            + '：' + str(result.reason)
            + (isObj(result.rollback) && str(result.rollback.snapshotPath).length > 0 ? ' · 快照：' + str(result.rollback.snapshotPath) : ''))
          : null)
    }

    /**
     * 一条目标的**模型来源与四态**（用户要求 ② 的界面落地）。
     *
     * 数据两层（**不假装**）：
     *   · 首屏用 `/overview` 里带回来的**缓存层**四态与四类计数（服务端读缓存/静态配置，不起进程）；
     *   · 点「测量」才真的去问一次该 CLI（`POST /api/models`），结果按**四类**分组列出：
     *     可选择模型 / 仅限于展示的底层模型 / 模型别名 / 当前默认模型，每条再标**来源**
     *     （真实 CLI 查询 / 原生配置 / 官方模型缓存 / 有明确依据的官方别名）。
     *
     * 纪律：概览说「未知（证据不足）」时就显示未知 + 提示点测量；**不许**把没测过的说成「没有配置供应商」。
     */
    function ModelDiscoveryRow(props) {
      const t = isObj(props.target) ? props.target : {}
      const state = isObj(t.modelState) ? t.modelState : null
      const counts = isObj(t.modelCounts) ? t.modelCounts : null
      const [measured, setMeasured] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const measure = React.useCallback(() => {
        setBusy(true); setError('')
        fetch('/harness-pilot/api/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ target: str(t.name), refresh: true }),
        })
          .then(r => r.json().then(j => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            if (!ok || !isObj(j)) throw new Error(str(isObj(j) ? j.error : '') || 'HTTP 失败')
            setMeasured(j)
          })
          .catch(e => setError(str(e && e.message) || String(e)))
          .then(() => setBusy(false))
      }, [t.name])
      const shown = measured !== null ? (isObj(measured.state) ? measured.state : null) : state
      const shownCounts = measured !== null && isObj(measured.counts) ? measured.counts : counts
      const entries = measured !== null ? asArray(measured.entries).filter(isObj) : []
      const kinds = ['selectable', 'display-only', 'alias', 'current-default']
      const kindLabels = { selectable: '可选择模型', 'display-only': '仅供展示的底层模型', alias: '模型别名', 'current-default': '当前默认模型' }
      const sourceLabels = isObj(measured) && isObj(measured.sourceLabels) ? measured.sourceLabels : {}
      return h('div', { style: { marginTop: 2 } },
        h('div', { style: S.formRow },
          h('span', { style: S.grow },
            '模型来源与状态：'
            + (shown === null ? '未报告' : str(shown.label) + (t.modelMeasured === true || measured !== null ? '' : '（未测量：缓存/静态信息）'))
            + (shownCounts === null ? '' : ' · 可选 ' + String(asNum(measured !== null ? asArray(measured.selectable).length : (counts.selectable + counts['current-default'] + counts.alias)))
              + ' / 仅展示 ' + String(asNum(shownCounts['display-only'])) + ' / 别名 ' + String(asNum(shownCounts.alias))
              + ' / 默认 ' + String(asNum(shownCounts['current-default'])))),
          h('button', { type: 'button', style: S.buttonSmall, disabled: busy, onClick: measure }, busy ? '测量中…' : '测量')),
        shown !== null && str(shown.evidence).length > 0
          ? h(Hint, null, str(shown.label) + '：' + str(shown.evidence))
          : null,
        error.length > 0 ? h(Notice, { style: S.noticeError }, '测量失败：' + error) : null,
        measured !== null
          ? h('div', null,
            h(Hint, null, str(measured.classificationNote)),
            kinds.map(kind => {
              const mine = entries.filter(e => str(e.kind) === kind)
              if (mine.length === 0) return null
              return h('details', { key: 'kind-' + kind, style: S.detailBox },
                h('summary', { style: S.detailSummary }, kindLabels[kind] + '（' + String(mine.length) + '）'),
                h('div', { style: { maxHeight: 200, overflowY: 'auto' } },
                  mine.map(e => h('div', { key: 'e-' + kind + '-' + str(e.id), style: S.formRow },
                    h('span', { style: S.grow, title: str(e.id) }, str(e.id)),
                    isObj(e.meta) && str(e.meta.name).length > 0 ? h('span', { style: S.monoDim }, str(e.meta.name)) : null,
                    isObj(e.meta) && str(e.meta.vendor).length > 0 ? h('span', { style: S.monoDim }, 'vendor ' + str(e.meta.vendor)) : null,
                    // 厂商 product config 里的**输出上限**：真实数字，不是估计（缺就不写，不编造）。
                    isObj(e.meta) && typeof e.meta.maxOutputTokens === 'number'
                      ? h('span', { style: S.monoDim }, '输出上限 ' + String(Math.round(e.meta.maxOutputTokens / 1000)) + 'k')
                      : null,
                    h('span', { style: S.monoDim }, str(sourceLabels[str(e.source)]) || str(e.source)),
                    h('span', { style: S.monoDim }, str(e.selectable) === 'true' ? '可作 --model' : '不可作 --model')))))
            }),
            str(measured.note).length > 0 ? h(Hint, null, '查询方式：' + str(measured.note)) : null)
          : null)
    }

    /**
     * 该 harness 在宿主模型目录里的**可选路由**（会话 / 子代理选择器里能看到什么）。
     *
     * 现在由 LLM 适配器按目标名广告：`<目标名>`（该 CLI 的默认档）与 `<目标名>::<模型>`（具体模型）。
     * 这里**只读**渲染，且明确标注「目录可见 ≠ 子代理白名单已生效」。
     */
    function selectableRoutesOf(group) {
      return asArray(group.dispatchable).map(str).filter(name => name.length > 0)
    }

    /** 该组在目标表里的成员（保留原始 target 行，供既有面板使用）。 */
    function groupTargetRows(group, targets) {
      const names = asArray(group.members).map(str)
      return targets.filter(t => names.includes(t.name))
    }

    /** 一条 harness（折叠行）。展开体只放三块：模型 / 登录账号 / 可选性。 */
    function HarnessGroupRow(props) {
      const group = isObj(props.group) ? props.group : {}
      const members = groupTargetRows(group, props.targets)
      const dispatchable = members.filter(t => str(t.transport) === 'auto' || str(t.transport).length === 0)
      const installed = members.filter(t => t.available === true)
      const accountLogin = str(group.login) === 'accounts'
      const acc = useFed('accounts')
      const accounts = asArray(isObj(acc.data) ? acc.data.accounts : null).filter(isObj)
      // 账号归属**由服务端算**（`accountIds`，按档案的 harnessId 经同一张产品身份表映射）：
      // 客户端不再实现第二份「区域归属」判断 —— 两份实现必然漂移，而这个仓库为此栽过。
      const ownedIds = asArray(group.accountIds).map(str)
      const mine = accounts.filter(a => ownedIds.includes(str(a.id)))
      const iso = isObj(group.isolation) ? group.isolation : null
      const statusText = members.length === 0
        ? '未发现目标'
        : installed.length === members.length
          ? '可用'
          : installed.length === 0
            ? '入口不可用（未安装或路径不存在）'
            : '部分入口不可用'
      const picker = isObj(group.picker) ? group.picker : null
      const pickerText = picker && picker.groupHidden === true ? ' · 会话菜单已隐藏' : ''
      // 行头计数优先用服务端的**选择器目录合计**（group.picker.total：与原生选择器同一份
      // 合并实现，含落盘缓存回填）；落盘缓存过期（>6h）时它可能是 0，此时退回各目标缓存之和，
      // 并由上方「冷启动补刷」在预热完成后自动刷新 —— 不再长期显示 0（2026-10-15 用户反馈）。
      const modelCount = Math.max(picker !== null ? asNum(picker.total) : 0, modelCountOf(members))
      return h('div', { style: Object.assign({}, S.section, { padding: 0, marginTop: 0, marginBottom: 0 }) },
        h('button', {
          type: 'button',
          'aria-expanded': props.open === true,
          style: Object.assign({}, S.formRow, { width: '100%', textAlign: 'left', cursor: 'pointer', background: props.open ? C.surfaceSoft : 'transparent', border: 'none', borderRadius: 'var(--dsw-radius-lg,10px)', padding: '16px', gap: 16, fontFamily: 'inherit', color: C.text }),
          onClick: props.onToggle,
        },
        h('span', { style: Object.assign({}, S.formLabel, { flex: '1 1 auto', fontWeight: 500, fontSize: 14, lineHeight: '20px' }) }, str(group.label)),
        h('span', { style: { color: C.textSecond, fontSize: 12, lineHeight: '18px' } },
          statusText
          + ' · 模型 ' + String(modelCount) + ' 个'
          + pickerText
          + (accountLogin ? ' · 账号 ' + String(mine.length) + ' 个' : '')),
        h('span', { style: S.monoDim }, props.open === true ? '收起' : '展开')),
        props.open === true
          ? h('div', { style: { padding: '4px 0 8px' } },
            // ① 会话模型选择器显示（2026-10-15：整组开关 + 上限 + 逐模型显隐）
            h('div', { style: Object.assign({}, S.formRow, { alignItems: 'baseline' }) },
              h('span', { style: S.formLabel }, '选择器显示')),
            h(PickerVisibilityPanel, { providerId: str(group.providerId), visibility: props.visibility, allTabs: props.allTabs }),
            // ①b 模型发现与供应商目录：**按需展开**（用户 2026-10-15：不要把大量信息堆在页面里；
            // 每条目标的四态测量 + 供应商目录都是重面板，默认只给一行摘要）。
            h('div', { style: Object.assign({}, S.formRow, { alignItems: 'baseline', marginTop: 6 }) },
              h('span', { style: S.formLabel }, '模型发现')),
            dispatchable.length === 0
              ? h(Hint, { style: { paddingLeft: 12 } }, '这条 harness 目前**没有可一次性派发的入口**（只有 GUI/IDE 目标），因此它的模型不会被列进模型目录。')
              : dispatchable.map(t => h('details', { key: 'disc-' + t.name, style: Object.assign({}, S.detailBox, { marginLeft: 12 }), open: props.allTabs === true },
                h('summary', { style: S.detailSummary },
                  cliLabel(t.name) + '（目标 ' + t.name + '）· ' + String(asArray(t.models).length) + ' 个模型 · 展开测量与目录'),
                h(ModelDiscoveryRow, { target: t }),
                h(FederationProvidersPanel, { targets: [t], targetName: t.name }))),
            // ② 登录账号（只对需要登录的 harness 出现）
            accountLogin || mine.length > 0
              ? h(React.Fragment, null,
                h('div', { style: Object.assign({}, S.formRow, { alignItems: 'baseline', marginTop: 6 }) },
                  h('span', { style: S.formLabel }, '登录账号')),
                mine.length === 0
                  ? (iso !== null && iso.mayAddAccounts === false
                    // ⚠️ 对「**不允许**建账号」的 harness（如 Antigravity），不能说「去下面的面板添加」——
                    // 那会把人引到一个必然失败的按钮上。要说清为什么不能。
                    ? h(Hint, null, '这个 harness 需要登录，但**本插件不允许为它新增账号档案**（见下面的「账号与认证边界」：'
                      + '它没有可验证的隔离手段，硬加只会造出「名字不同、其实是同一个账号」的假档案）。'
                      + '它用的是该 CLI/桌面端自己的登录态。')
                    : h(Hint, null, '这个 harness 需要登录，但本插件**还没有**为它保存任何账号档案。在下面的面板里添加。'))
                  : mine.map(a => h('div', { key: 'acct-' + str(a.id), style: Object.assign({}, S.formRow, { paddingLeft: 12 }) },
                    h('span', { style: S.grow, title: str(a.id) }, str(a.displayName) || str(a.id) || '（未命名档案）'),
                    h('span', { style: S.monoDim }, str(isObj(a.identity) ? a.identity.state : '') || '状态未知'),
                    str(a.region) === 'cn' || str(a.region) === 'intl'
                      ? h('span', { style: S.monoDim }, str(a.region) === 'cn' ? '国内' : '国际')
                      : null)),
                // ── 账号与认证边界（需求 ④：Antigravity 的共享认证槽边界必须**如实说明**）──
                // 这条以前只挂在「已存在的账号档案」上 ⇒ 没有账号的 harness 看不到任何说明。
                iso !== null ? h(IsolationBoundary, { isolation: iso, allTabs: props.allTabs }) : null,
                h('div', { style: { paddingLeft: 12 } },
                  h(AccountsPanel, { targets: members, family: str(group.key) }),
                  // 用户要求第 3 条：「支持添加他们登录的账号，**作为号池进行管理**」——
                  // 账号池面板就属于这一块，不能因为「信息太多」把它藏掉（那是能力缺失，不是分层）。
                  h('details', { style: S.detailBox, open: props.allTabs === true },
                    h('summary', { style: S.detailSummary }, '账号池与额度（默认账号 / 优先级 / 冷却 / 一键切换）'),
                    h(AccountPoolPanel, null))))
              : null,
            // ③ 可选性（会话 / 子代理）
            h('div', { style: Object.assign({}, S.formRow, { alignItems: 'baseline', marginTop: 6 }) },
              h('span', { style: S.formLabel }, '可选择')),
            h(Hint, null, '会话模型菜单不显示外部 harness。请在提示词中指定 harness 和模型，由当前模型通过原生子代理工具调用。'),
            // 子代理侧：**可操作**的勾选面板（写宿主 allowedModels，带差分预览 / 回滚快照 / 独立回读）。
            h(SubagentPolicyPicker, { providerId: str(group.providerId), policy: props.policy, summary: group.subagent, allTabs: props.allTabs }),
            // 两条说明**合并成一条**（2026-10-15：信息要明确，不堆叠）——内容不减：目标/通道明细
            // + 会话菜单条目形态 + 子代理白名单边界，全在展开体里。
            h(Collapsible, {
              label: '这条 harness 的目标与通道',
              summary: asArray(group.members).join(', ') + '（' + String(dispatchable.length) + ' 个可派发）',
              text: members.map(t => t.name + '：' + (t.available ? '入口可用' : '入口不可用') + ' · ' + (transportText(t) || '未声明通道')).join('\n')
                + '\n\n模型可通过 list_subagent_models 查询「' + str(group.providerId) + '」的全部可用模型，按提示词要求调用原生 subagent。'
                + '\n子代理侧用**同一份模型目录**，但宿主还额外要求「provider/模型」这一对出现在'
                + ' `subagent-model-selection-settings.allowedModels` 里（精确串匹配）'
                + '—— 上面的勾选面板就是在管它。目录可见 ≠ 已在白名单里。',
            }))
          : null)
    }

    /**
     * 一条 harness 的**账号与认证边界**（需求 ④ 原文：「Antigravity 的共享认证槽边界如实说明」）。
     *
     * 三个布尔各自有确切含义，**不许**把「没验证」说成「已隔离」、也不许反过来：
     *   · `configDirIsolated`：配置目录能否按档案切换（有实测证据的开关）；
     *   · `authStoreIsolated`：认证存储是否真的随配置目录走 —— `false` 就**不得**宣称认证隔离；
     *   · `mayAddAccounts`：能不能为它新增档案（`false` 通常是「加了也是假账号」）。
     * 结论（disclosure）与依据（evidence）/ 限制（limits）默认收起，但**结论行一定可见**。
     */
    function IsolationBoundary(props) {
      const iso = isObj(props.isolation) ? props.isolation : {}
      const yes = (v) => v === true ? '是' : v === false ? '否' : '未知'
      const line = '账号与认证边界：配置目录隔离 ' + yes(iso.configDirIsolated)
        + (str(iso.mechanism).length > 0 ? '（' + str(iso.mechanism) + '）' : '')
        + ' · 认证存储独立 ' + yes(iso.authStoreIsolated)
        + ' · 允许新增账号 ' + (iso.mayAddAccounts === true ? '允许' : '不允许')
      return h('div', { style: { paddingLeft: 12 } },
        h('div', { style: S.monoDim }, line),
        str(iso.disclosure).length > 0 ? h(Hint, null, str(iso.disclosure)) : null,
        iso.mayAddAccounts === false && str(iso.refuseReason).length > 0
          ? h(Hint, null, '为什么不允许新增：' + str(iso.refuseReason))
          : null,
        h('details', { style: S.detailBox, open: props.allTabs === true },
          h('summary', { style: S.detailSummary }, '依据与限制（' + String(asArray(iso.evidence).length) + ' 条依据 / '
            + String(asArray(iso.limits).length) + ' 条限制）'
            + (str(iso.viaTarget).length > 0 ? ' · 判据目标 ' + str(iso.viaTarget) : '')),
          asArray(iso.evidence).map((e, i) => h('div', { key: 'iso-ev-' + String(i), style: S.monoDim }, '· ' + str(e))),
          asArray(iso.limits).map((e, i) => h('div', { key: 'iso-lim-' + String(i), style: S.monoDim }, '· 限制：' + str(e)))))
    }

    /** 该组已发现的模型数（用概览里的缓存字段求和；未预热只说明「未预热」，不当成 0 个）。 */
    function modelCountOf(members) {
      let count = 0
      for (const t of members) count += asArray(t.models).length
      return count
    }

    /**
     * 会话页头部的**执行身份徽章**：当前这一轮到底由哪个外部 CLI、哪个模型产生。
     *
     * 只读：不选模型、不改路由。路由与模型仍然完全走宿主原生选择器。
     *
     * 判据（要求 4）：徽章只在**外部路由**下出现，并且必须同时给出 **CLI 名 + 模型名**；
     * 原生路由下**不得**出现（否则就是在把宿主自己说成外部 CLI）。
     */
    function HarnessSessionIdentity(props) {
      const sessionId = str(props && props.sessionId)
      const [identity, setIdentity] = React.useState(null)
      React.useEffect(() => {
        if (!sessionId) return
        let disposed = false, timer
        const controller = new AbortController()
        async function load() {
          try {
            const response = await fetch('/harness-pilot/api/session/identity?sessionId=' + encodeURIComponent(sessionId), {
              signal: controller.signal, headers: { accept: 'application/json' },
            })
            if (!response.ok) throw Error('HTTP ' + response.status)
            const value = await response.json()
            if (!disposed) setIdentity(Object.assign({}, value, { sessionId }))
          } catch {
            if (!disposed) setIdentity(null)
          } finally {
            if (!disposed) timer = setTimeout(load, 3000)
          }
        }
        void load()
        return () => { disposed = true; clearTimeout(timer); controller.abort() }
      }, [sessionId])
      // 宿主的 `modelDirectories.directoryFor(sessionId)` 对未知会话会**抛错**（响亮失败）。
      // 徽章只是锦上添花，不能因此把整个头部座位搞挂 ⇒ 包一层 try/catch。
      const store = (() => {
        const svc = props && props.modelDirectories
        if (!isObj(svc) || sessionId.length === 0 || typeof svc.directoryFor !== 'function') return null
        try {
          const directory = svc.directoryFor(sessionId)
          return isObj(directory) && isObj(directory.store) ? directory.store : null
        } catch {
          return null
        }
      })()
      const snapshot = React.useSyncExternalStore(
        listener => (store && typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {}),
        () => (store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null),
      )
      const route = isObj(snapshot && snapshot.current) ? snapshot.current : null
      const observed = isObj(identity) && identity.sessionId === sessionId && identity.available === true && str(identity.provider)
        ? identity : null
      const provider = observed ? str(observed.provider) : str(route && route.provider)
      if (provider.length === 0) return null
      // ── 2026-10-15 用户要求：徽章只显示「供应商 · 模型」，且**全部供应商**（含 DeepSeek
      // 原生与账号型）都显示；账号 / 实际模型 / 偏差细节全部退到悬停 tooltip，不再占正文。
      const parts = str(route && route.model).split('::')
      const model = observed ? str(observed.requestedModel) : provider === 'pilot-cli' ? parts.slice(1).join('::') : str(route && route.model)
      if (model.length === 0 && provider !== 'pilot-cli') return null
      const harness = provider === 'pilot-cli'
        ? cliLabel(parts[0])
        : (observed && str(observed.harnessLabel).length > 0 && !observed.harnessLabel.includes('已拆到')
          ? str(observed.harnessLabel)
          : cliLabel(provider.startsWith('harness-') ? provider.slice(8) : provider))
      const modelLabel = !model || model === 'cli-default' ? 'CLI 默认模型' : model
      const mismatch = observed ? asArray(observed.mismatch).map(str).filter(Boolean) : []
      const actual = observed && str(observed.actualModel) ? str(observed.actualModel) : ''
      const accountLabel = observed ? str(observed.accountLabel) : ''
      return h('span', {
        'data-harness-identity': 'true', 'data-harness-provider': provider,
        style: Object.assign({}, S.badge, { whiteSpace: 'normal', overflowWrap: 'anywhere' }),
        title: providerLabelFull(provider, harness)
          + '；模型：' + modelLabel
          + (accountLabel ? '；账号：' + accountLabel : '')
          + (actual ? '；实际模型：' + actual : '；实际模型以 CLI/上游回报为准（未回报即未知）')
          + (mismatch.length ? '\n' + mismatch.join('\n') : ''),
      }, harness.replace(/^外部 CLI · /, '') + ' · ' + modelLabel)
    }

    // ═══════════ 会话页选择器（P5b）：Harness → 账号 → 供应商 → 模型 ═══════════
    // 注册在 `conversation.input.model` 上，priority **-1** —— 宿主对该单槽的规则是
    // 「同 priority 注册抛错；**lowest renders**」（实测自运行版本
    // dsh-client-ui-slots/lib/index.js 的报错原文），shipped 占用者是 priority 0，
    // 所以 -1 才能接管这个座位。
    const SESSION_BINDING_API = '/harness-pilot/api/session/binding'
    /** 子代理模型白名单接口（GET 现状 / POST 应用差分）。 */
    const API_SUBAGENT_MODELS = '/harness-pilot/api/subagent-model-selection'
    /** 会话模型选择器可见性（每组上限 / 整组显隐 / 模型显隐）。 */
    const API_MODEL_VISIBILITY = '/harness-pilot/api/model-visibility'

    /** 读/写当前会话的绑定。失败只记录，不影响渲染。 */
    function useSessionBinding(sessionId) {
      const [state, setState] = React.useState({ binding: null, error: '', loading: false })
      const reload = React.useCallback(() => {
        if (sessionId.length === 0) return
        setState(s => Object.assign({}, s, { loading: true }))
        fetch(SESSION_BINDING_API + '?sessionId=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + String(r.status)); return r.json() })
          .then(j => setState({ binding: isObj(j) ? j.binding : null, error: '', loading: false }))
          .catch(e => setState({ binding: null, error: str(e && e.message) || String(e), loading: false }))
      }, [sessionId])
      React.useEffect(() => { reload() }, [reload])
      const save = React.useCallback(patch => {
        setState(s => Object.assign({}, s, { loading: true }))
        fetch(SESSION_BINDING_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(Object.assign({ sessionId }, patch)),
        })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + String(r.status)); return r.json() })
          .then(j => setState({ binding: isObj(j) ? j.binding : null, error: '', loading: false }))
          .catch(e => setState(s => Object.assign({}, s, { error: str(e && e.message) || String(e), loading: false })))
      }, [sessionId])
      // ⚠️ 必须把 `save` 一并返回。原来只返回 `{ reload, ...state }`，
      // 于是 HarnessSessionSelector 里每一次 `save(...)` 都是 `ReferenceError: save is not defined`：
      // 同步抛在 onChange 里 ⇒ 下拉值被 React 回退成旧值、**界面什么都不显示**，
      // 用户看到的就是「选了外部 harness 没反应 / 原生模型改不了」。
      // 离线渲染探针只画不点，永远测不到这一层 —— 那条测试腿必须补（见 probe/verify-session-binding-write.mjs）。
      return Object.assign({ reload, save }, state)
    }

    /**
     * 原来的模型选择位置：先 Harness，再账号档案、供应商、模型。
     *
     * ⚠️ 诚实性要求：作用范围必须**分范围**写清，绝不允许笼统说成「已切换会话引擎」。
     *
     * 复核实测 2026-10-13（结论在本轮内翻转过一次，留档）：
     *   · 20:54：绑定驱动的改道**尚未落地**（`lib/llm-adapter.js` 不存在、
     *     `lib/index.js` 里没有 `pilot-cli`、`/harness-pilot/api/llm-adapter` 404），
     *     所以当时显示「仍由 DSH 执行」是**如实描述**，**没有**提前写成「由所选 CLI 产生」。
     *   · 20:57：改道**已生效**（`/api/llm-adapter` 200，`registration.ok=true`、
     *     `catalog.pilotCliVisible=true`），于是本句**必须**改写 ——
     *     否则就从「提前声称」翻成「滞后于事实」，两者同样是不实。
     *   · 22:24：改道从**响应层**（`llm/stream` 短路）搬到**请求层**（`agent/request` 瀑布）。
     *     机制名必须同步改：在响应层改道时，会话日志的 `request/header` 与 assistant 的 `source`
     *     早已写好（`dsh-agent-loop:1205-1218` / `:1136-1143`）⇒ 必然把外部 CLI 的产出记成宿主路由。
     *     本句原来写的「绑定驱动的 llm/stream 改道已生效」在 22:24 之后就是**假话**，已改写。
     *
     * 现在的表述给出**范围**与**代价**（代价是固有代价，不是临时限制）：
     * 未绑定 / 原生 ⇒ 轮次仍由 DSH 执行；已绑定到**可派发**外部 Harness ⇒ 模型请求由所选 CLI 产生，
     * 且那些轮次里 **DSH 自身的工具链完全惰性** —— 适配器只产出 text 块、从不产出 tool-call 块，
     * `executeToolCalls` **从不被调用**；CLI 自己的工具跑在它自己的沙箱里，DSH 的审批 / fs 沙箱看不到。
     * 带 `purpose` 的辅助调用写**两段**（缺一段就是误导）：本插件**不**改写它们；但宿主按
     * 「会话最后一次 `request/header` 的路由」解析它们，而那条路由已被改写成 `pilot-cli`
     * ⇒ **改道过的会话里，会话标题 / 压缩会跟着跑到外部 CLI**（2026-10-13 实测）。
     * 判据分两条：路由可选 = `pilot-cli` 是否已注册；改道真的发生 = `requestLayer.installed` **且**
     * 会话日志里出现 `pilot-cli` 的 `request/header` 且 assistant `source` 与之同路由。
     * ⚠️ 本条只做过**离线渲染**验证（probe/verify-ui-smoke.mjs）与接口级实测，
     * **未在浏览器里确认**实际渲染。
     */
    /**
     * 该 harness 自己报的**真实模型**（POST /api/models）；按目标重取。
     * 修复前模型下拉只有「(harness 默认)」+ 当前值 —— 看得见 harness 却没有模型可选。
     */
    function useTargetModels(harnessId) {
      const [state, setState] = React.useState({ models: [], note: '', loading: false })
      React.useEffect(() => {
        if (harnessId.length === 0) { setState({ models: [], note: '', loading: false }); return }
        let alive = true
        setState(s => Object.assign({}, s, { loading: true }))
        fetch('/harness-pilot/api/models', {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ target: harnessId }),
        })
          .then(r => r.json())
          .then(j => { if (alive) setState({ models: asArray(isObj(j) ? j.models : null).map(str).filter(m => m.length > 0), note: str(j && j.note), loading: false }) })
          .catch(e => { if (alive) setState({ models: [], note: str(e && e.message) || String(e), loading: false }) })
        return () => { alive = false }
      }, [harnessId])
      return state
    }

    /** DSH 当前部署默认模型（原生选择的展示层；只读 `/llm-adapter` 的 catalog.default）。 */
    function useLlmDefault() {
      const [state, setState] = React.useState('')
      React.useEffect(() => {
        let alive = true
        fetch('/harness-pilot/api/llm-adapter', { headers: { accept: 'application/json' } })
          .then(r => r.json())
          .then(j => {
            if (!alive) return
            const d = isObj(isObj(j) ? j.catalog : null) ? j.catalog.default : null
            setState(isObj(d) ? (str(d.provider) + '/' + str(d.model)) : '')
          })
          .catch(() => { if (alive) setState('') })
        return () => { alive = false }
      }, [])
      return state
    }

    function HarnessSessionSelector(props) {
      const locked = isObj(props) && props.locked === true
      const sessionId = str(props && props.sessionId)
      const fed = useFed('registry')
      const acc = useFed('accounts')
      const bindingState = useSessionBinding(sessionId)
      const binding = isObj(bindingState.binding) ? bindingState.binding : null
      const harnessKind = str(binding && binding.harnessKind) || 'native'
      const harnessId = str(binding && binding.harnessId) || 'dsh'
      const accountId = str(binding && binding.accountId)
      const model = str(binding && binding.model)
      const targets = asArray(isObj(fed.data) ? fed.data.harnesses : null).filter(isObj)
      const accounts = asArray(isObj(acc.data) ? acc.data.accounts : null).filter(isObj)
      const targetAccounts = accounts.filter(a => str(a.harnessId) === harnessId || str(a.harnessId).startsWith(harnessId))
      const scope = str(binding && binding.scopeNote)

      if (sessionId.length === 0) {
        // 拿不到会话 id 就不猜 —— 宁可显示一句说明，也不写到一个错误的会话上。
        return h('div', { style: S.monoDim, title: '组件没有拿到 sessionId，无法读写本会话的绑定' }, 'Harness：无法确定会话')
      }
      const control = (label, value, options, onChange, disabled) => h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8 } },
        h('span', { style: S.monoDim }, label),
        h('select', {
          value: value,
          disabled: locked || disabled === true,
          style: Object.assign({}, S.button, { cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1 }),
          onChange: e => onChange(str(e && e.target && e.target.value)),
        }, options.map((o, i) => h('option', { key: str(o.value) + '#' + String(i), value: str(o.value) }, str(o.label)))),
      )

      const overview = useOverview()
      const targetModels = useTargetModels(harnessKind === 'external' ? harnessId : '')
      const dshDefault = useLlmDefault()
      /** 写操作失败要说出来 —— 不能静默回滚成一个「看起来没反应」的下拉。 */
      const [writeError, setWriteError] = React.useState('')

      const harnessOptions = [{ value: 'dsh', label: '原生 DSH（本会话由 DSH 执行）' }]
        .concat(targets.map(t => {
          const inst = isObj(t.install) ? t.install : {}
          const ver = str(inst.version)
          const off = t.enabled === false
          return { value: str(t.id), label: str(t.id) + (ver.length > 0 ? ' · ' + ver : '') + (off ? '（已停用）' : '') }
        }))
      // 注册表为空时退回概览目标 —— 不允许下拉里只剩「原生 DSH」（实测退化形态）。
      if (targets.length === 0) {
        const seen = new Set(harnessOptions.map(o => o.value))
        for (const t of asArray(isObj(overview.data) ? overview.data.targets : null).filter(isObj)) {
          const id = str(t.name)
          if (id.length === 0 || seen.has(id)) continue
          seen.add(id)
          harnessOptions.push({ value: id, label: id + (t.available === false ? '（不可用）' : '') })
        }
      }
      // 两条数据源都断了就必须说出来。用户报告的「只有原生 DSH 可选」正是这个**静默退化**形态：
      // 注册表读失败时原来既不报错也不显示原因，看起来就像「只有原生 DSH」。
      const harnessSourceProblems = []
      if (fed.error.length > 0) harnessSourceProblems.push('注册表接口失败：' + fed.error)
      if (overview.error.length > 0) harnessSourceProblems.push('概览接口失败：' + overview.error)
      if (targets.length === 0 && harnessSourceProblems.length === 0 && fed.loading) harnessSourceProblems.push('注册表读取中…')

      // 原生模型选项：DSH 自己配置的供应商×模型（**不是**外部 harness 的列表）。
      const dshProviders = []
      for (const p of asArray(isObj(overview.data) && isObj(overview.data.dsh) ? overview.data.dsh.providers : null).filter(isObj)) {
        const pid = str(p.id)
        const models = asArray(p.models).map(str).filter(x => x.length > 0)
        if (pid.length === 0 || models.length === 0) continue
        dshProviders.push({
          id: pid,
          name: str(p.name) || pid,
          options: models.map(m => ({ value: pid + '::' + m, label: m })),
        })
      }
      const dshModelOptions = []
      for (const p of dshProviders) for (const o of p.options) dshModelOptions.push({ value: o.value, label: p.name + ' · ' + o.label })
      // 当前生效的 DSH 供应商：绑定里的 `provider::model` 优先（就是我们自己写的那次选择），
      // 否则回退到**只读**的部署默认（`/llm-adapter` 的 catalog.default），并明确标出这是部署默认。
      const slash = dshDefault.indexOf('/')
      const dshDeployedPair = slash > 0
        ? { provider: dshDefault.slice(0, slash), model: dshDefault.slice(slash + 1), fromBinding: false }
        : null
      const dblColon = model.indexOf('::')
      const dshPair = dblColon > 0
        ? { provider: model.slice(0, dblColon), model: model.slice(dblColon + 2), fromBinding: true }
        : dshDeployedPair
      const dshProvider = dshPair !== null ? dshPair.provider : ''
      const dshActive = dshProviders.find(p => p.id === dshProvider) ?? null

      // 外部 harness：只有模型**自带供应商前缀**时才给「供应商」下拉
      // （opencode 的 `opencode-go/xxx`、pi 的 `antigravity/xxx`）。
      // wb-managed-a 的 `deep-model` 这类没有前缀 —— **不伪造**供应商维度。
      const extModels = targetModels.models
      const providerOf = m => { const i = m.indexOf('/'); return i > 0 ? m.slice(0, i) : '' }
      const extProviderIds = []
      for (const m of extModels) { const p = providerOf(m); if (p.length > 0 && extProviderIds.indexOf(p) < 0) extProviderIds.push(p) }
      const extHasProviderDim = extProviderIds.length > 1
      const extProvider = extHasProviderDim ? providerOf(model) : ''
      const visibleExtModels = extHasProviderDim ? extModels.filter(m => providerOf(m) === extProvider) : extModels

      const modelOptions = harnessKind === 'external'
        ? [{ value: '', label: '(harness 默认)' }].concat(visibleExtModels.map(m => ({ value: m, label: m })))
        : [{ value: '', label: '(DSH 默认)' }].concat(dshActive === null ? dshModelOptions : dshActive.options)
      const currentModel = harnessKind === 'external'
        ? (model.length > 0 ? model : '(该 harness 默认模型)')
        : (model.length > 0
            ? model
            : (dshDeployedPair !== null ? dshDefault + '（部署默认）' : '(DSH 默认模型)'))

      const remember = patch => {
        setWriteError('')
        const writer = bindingState.save
        if (typeof writer !== 'function') {
          setWriteError('绑定写入入口缺失（插件客户端与宿主版本不匹配），本次选择未提交')
          return
        }
        try {
          const pending = writer(patch)
          if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            pending.catch(err => { setWriteError('绑定写入失败：' + (str(err && err.message) || String(err))) })
          }
        } catch (err) {
          setWriteError('绑定写入抛错：' + (str(err && err.message) || String(err)))
        }
      }      /** 原生 DSH：改模型必须走宿主**真实**的选择入口（`ctx.sessionController.selectModel`），
       *  不是只写绑定 —— 只写绑定就会出现「界面显示改了、实际没生效」。 */
      const chooseNativeModel = value => {
        setWriteError('')
        let failure = ''
        if (value.length > 0) {
          const at = value.indexOf('::')
          if (at > 0) {
            const provider = value.slice(0, at)
            const modelId = value.slice(at + 2)
            fetch('/harness-pilot/api/llm-adapter/select-model', {
              method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionId, provider, model: modelId }),
            })
              .then(res => (res.ok ? null : res.text().then(text => { throw new Error('HTTP ' + String(res.status) + ' ' + String(text).slice(0, 200)) })))
              .then(json => {
                if (isObj(json) && json.ok === false) throw new Error('宿主拒绝了这次选择：' + str(json.reason))
                if (isObj(json) && json.thrown) throw new Error(str(json.thrown))
              })
              .catch(err => { setWriteError('切换原生模型失败（未改绑定）：' + (str(err && err.message) || String(err))) })
          } else failure = '未知的模型槽：' + value
        }
        if (failure.length > 0) { setWriteError(failure); return }
        remember({ model: value })
      }

      // 该 harness **自己声明**的能力：只说声明了什么，不声称已接线。
      const regEntry = targets.find(t => str(t.id) === harnessId) ?? null
      const caps = regEntry !== null && isObj(regEntry.capabilities) ? regEntry.capabilities : null
      const capParts = []
      if (harnessKind === 'external') {
        if (caps === null) capParts.push('能力：未知（注册表里没有该目标）')
        else {
          const pm = asArray(caps.permissionModes).length
          const re = asArray(caps.reasoningEfforts).length
          capParts.push('权限模式：' + (pm > 0 ? '该 CLI 声明 ' + String(pm) + ' 项（未接线）' : '未声明'))
          capParts.push('推理档位：' + (re > 0 ? '声明 ' + String(re) + ' 项（未接线）' : '未声明'))
          capParts.push('多账号：' + (str(caps.multiAccount) === 'yes' ? '支持' : '未知/未验证'))
          capParts.push('可主控：' + (str(caps.canLead) === 'yes' ? '支持' : '未知/未验证'))
        }
      }

      return h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, maxWidth: 640 } },
        control('Harness', harnessId, harnessOptions, v => { setWriteError(''); remember({ harnessId: v, accountId: '', provider: '', model: '' }) }),
        harnessSourceProblems.length > 0
          ? h('span', { style: { color: C.bad, fontSize: 11, flexBasis: '100%' }, title: harnessSourceProblems.join('\n') },
              '⚠ Harness 列表不完整：' + harnessSourceProblems.join('；'))
          : null,
        harnessKind === 'external'
          ? control('账号', accountId || '(默认)', [{ value: '', label: '(默认)' }].concat(
              targetAccounts.map(a => ({ value: str(a.id), label: str(a.displayName) || str(a.id) })),
            ), v => { setWriteError(''); remember({ accountId: v }) }, targetAccounts.length === 0)
          : null,
        harnessKind === 'external'
          ? (extHasProviderDim
              ? control('供应商', extProvider, extProviderIds.map(p => ({ value: p, label: p })), v => {
                  const first = extModels.find(m => providerOf(m) === v)
                  remember({ model: first !== undefined ? first : '' })
                })
              : (targetModels.models.length > 0
                  ? h('span', { style: S.monoDim, title: '该 harness 报出的模型名没有供应商前缀，因此不提供供应商维度（不伪造）' }, '供应商：该 harness 未区分')
                  : null))
          : (dshProviders.length > 0
              ? control('供应商', dshProvider, dshProviders.map(p => ({ value: p.id, label: p.name })), v => {
                  const p = dshProviders.find(x => x.id === v)
                  if (p === undefined || p.options.length === 0) return
                  chooseNativeModel(p.options[0].value)
                })
              : null),
        control('模型', model || '', modelOptions, v => {
          setWriteError('')
          if (harnessKind === 'external') { remember({ model: v }); return }
          chooseNativeModel(v)
        }, harnessKind === 'external' && targetModels.models.length === 0 && targetModels.loading),
        h('span', { style: S.monoDim, title: harnessKind === 'external'
          ? '外部 harness：所选模型由该 CLI 自己的执行引擎使用；它的回复不回报实际内部模型时，任务详情里如实标「未知」'
          : '原生 DSH：改选后经宿主真实选择入口（sessionController.selectModel）生效' }, '当前模型：' + currentModel),
        capParts.length > 0 ? h('span', { style: Object.assign({}, S.monoDim, { flexBasis: '100%' }), title: '来自注册表的 capabilities 字段；「未接线」= 本插件还没有把这些开关接到派发参数上' }, capParts.join(' · ')) : null,
        writeError.length > 0 ? h('span', { style: { color: C.bad, fontSize: 11, flexBasis: '100%' } }, writeError) : null,
        harnessKind === 'external' && targetModels.models.length > 0 && targetModels.note.length > 0
          ? h('span', { style: Object.assign({}, S.monoDim, { flexBasis: '100%' }), title: targetModels.note }, '模型来源：' + modelSourceText(targetModels.note))
          : null,
        harnessKind === 'external' && targetModels.models.length === 0 && !targetModels.loading
          ? h(Hint, {
              style: {
                flexBasis: '100%', marginTop: 2, fontSize: 11, lineHeight: 1.5, color: C.bad,
              },
              title: targetModels.note,
            },
              '该 harness 没有报出可选模型 —— ' + modelSourceText(targetModels.note) + '。'
              + (regEntry !== null && isObj(regEntry.install) && str(regEntry.install.status) !== 'found'
                  ? '入口状态：' + str(regEntry.install.status) + '（没装或路径不对，先把入口填对）。'
                  : '')
              + '本插件**不编造**列表：没有列举能力的 CLI（例：Claude Code 的 --model 只收别名或完整名）就只提供「该 harness 默认模型」，'
              + '不会拿 DSH 的供应商列表冒充它。想真的选到具体模型，先让该 CLI 自己登好并在原生侧能报出模型；'
              + '或在「设置 → 外部 harness 管理 → 供应商与模型」看该 harness 的原生发现到底返回了什么。',
            )
          : null,
        bindingState.loading ? h('span', { style: S.monoDim }, '读取中…') : null,
        bindingState.error.length > 0 ? h('span', { style: { color: C.bad, fontSize: 11 } }, '绑定读写失败：' + bindingState.error) : null,
        h('div', {
          style: Object.assign({}, S.monoDim, { flexBasis: '100%', marginTop: 2 }),
          title: scope,
        }, harnessKind === 'external'
          ? '本会话已绑定外部 Harness：本会话的模型请求由所选 CLI 产生（本插件自有 LLM 路由 pilot-cli 已注册，改道在请求层 agent/request 瀑布上把本轮 provider/model 改写掉 —— 不是 llm/stream 改道，那一版在响应层短路、归因必然不实，已移除；前提是该目标当前可派发）。范围：未绑定、或绑定为原生 DSH 的会话，对话轮次仍由 DSH 自己的供应商执行；绑定之后又在模型选择器里显式选过模型 ⇒ 那一次选择优先、该轮不改道。带 purpose 的辅助调用（压缩 / 会话标题）本插件不改写它们，但宿主按「会话最后一次 request/header 的路由」解析它们 ⇒ 改道过的会话里它们会跟着跑到外部 CLI（消耗它的额度）；想让它们留在宿主，只能把 session-title-llm 与 compaction-basic 的 provider/model 显式钉在宿主供应商上。代价（固有代价，不是临时限制）：改道后的轮次里 DSH 自身的工具链完全惰性 —— 适配器只产出 text 块、从不产出 tool-call 块，executeToolCalls 从不被调用；CLI 自己的工具跑在它自己的沙箱里，DSH 的审批/fs 沙箱/spill 看不到它们，DSH 的工具 schema 只是被渲染进 CLI 的 prompt 当说明文字。'
          : '本会话由 DSH 自己执行：对话轮次由 DSH 自己的供应商产生（未改道）。'),
      )
    }

    // ═══════════ 账号池（P9）：脱敏身份 / 认证 / 额度 / 优先级 / 冷却 / 自动切换 / 一键切换 ═══════════
    const POOL_API = '/harness-pilot/api/pool'

    /** 账号池状态 + 写操作。写操作只做「配置与判定记账」，界面要如实说明它不执行派发。 */
    function usePool() {
      const [state, setState] = React.useState({ data: null, events: [], audit: [], error: '', busy: '', note: '' })
      const load = React.useCallback(() => {
        // 池状态与切换事件一起取：事件是「切换可见」的落点，不能只在接口里躺着。
        Promise.all([
          fetch(POOL_API, { headers: { accept: 'application/json' } }).then(r => { if (!r.ok) throw new Error('HTTP ' + String(r.status)); return r.json() }),
          fetch(POOL_API + '/events', { headers: { accept: 'application/json' } }).then(r => r.ok ? r.json() : { events: [] }).catch(() => ({ events: [] })),
        ])
          .then(([pool, ev]) => setState(s => Object.assign({}, s, {
            data: isObj(pool) ? pool : null,
            events: asArray(isObj(ev) ? ev.events : null).filter(isObj),
            audit: asArray(isObj(ev) ? ev.redactionAudit : null),
            error: '',
          })))
          .catch(e => setState(s => Object.assign({}, s, { error: str(e && e.message) || String(e) })))
      }, [])
      React.useEffect(() => { load() }, [load])
      // 档案增删改（发生在另一个面板）会改变池成员 —— 订阅刷新总线，别让这里停在旧事实上。
      React.useEffect(() => onRefresh('pool-panel', load), [load])
      const post = React.useCallback((path, body, busyKey) => {
        setState(s => Object.assign({}, s, { busy: busyKey, note: '' }))
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        })
          .then(r => r.json().then(j => ({ ok: r.ok, json: j })))
          .then(({ ok, json }) => {
            if (!ok) throw new Error(str(json && json.error) || 'HTTP error')
            setState(s => Object.assign({}, s, { busy: '', note: str(json.applyNote) || str(json.note) || '已更新' }))
            load()
            return json
          })
          .catch(e => {
            setState(s => Object.assign({}, s, { busy: '', error: str(e && e.message) || String(e) }))
            return null
          })
      }, [load])
      return { ...state, reload: load, post }
    }

    /**
     * 账号池面板。
     *
     * 诚实性要点（都直接显示在界面上）：
     *   · 额度：本机实测这些 Harness **没有原生额度接口**，所以一律显示「未知」，
     *     并在旁边写明「未知 ≠ 额度充足」，绝不用绿色装作正常；
     *   · 自动切换**默认关闭**；打开后**只有**在额度被判定为**明确耗尽**（仅结构化错误码）时才真的换账号重新派发，
 *     未知 / 429 / 网络 / 认证失效**一律不切** —— 必须写出来，否则「开关打开了」会被误读成「已经在自动切了」；
     *   · 每行的「原生登录 / 原生退出」调 `/accounts/native-auth`（**先出计划**：交互式流程只把用户
     *     唯一要做的那一步摆出来），「删除档案」调 `/accounts/manage`（两步确认，服务端拒绝时原样显示原因）。
     *     这两件事都是**真的**；旧版本这里放的是一个点了没用的灰按钮，那是把能做的事说成不能做。
     */
    function AccountPoolPanel() {
      const pool = usePool()
      const acc = useFed('accounts')
      const data = isObj(pool.data) ? pool.data : null
      const members = asArray(data ? data.members : null).filter(isObj)
      const accounts = asArray(isObj(acc.data) ? acc.data.accounts : null).filter(isObj)
      const authOf = id => {
        const found = accounts.find(a => str(a.id) === str(id))
        return isObj(found) && isObj(found.identity) ? str(found.identity.state) : 'unknown'
      }
      const autoOn = data ? data.autoSwitchEnabled === true : false
      const defaultId = data ? str(data.defaultAccountId) : ''

      return h('div', null,
        h('div', { style: S.meta },
          h('span', null, '池内账号 ' + String(members.length) + '，已启用 ' + String(members.filter(m => m.enabled).length)),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: autoOn,
              disabled: pool.busy === 'auto',
              onChange: e => { void pool.post(POOL_API, { autoSwitchEnabled: e.target.checked === true }, 'auto') },
            }),
            h('span', null, '额度耗尽后自动切换'),
          ),
          h('button', { type: 'button', style: pool.busy === 'reload' ? S.buttonBusy : S.button, onClick: () => pool.reload() }, '刷新'),
        ),
        // 自动切换的真实状态必须说清，否则「开关打开了」会被误读成「已经在自动切了」。
        // ⚠️ 2026-10-13 更正：此前这里把执行侧说成「尚未接线」—— 第 4 阶段已把执行侧**真的接通**
        // （真实 /dispatch 上验证过：换账号后真的用新账号重新派发了一次真实 CLI 进程）。
        // 那句已变成**把能做的事说成不能做**的失实陈述，故改写。
        // 仍然成立的边界（不要删）：只有**结构化错误**判定的**明确耗尽**才会真的换号；
        // 未知 / 429 / 网络错误 / 认证失效**一律不切**。所以「打开开关」≠「一定会切」。
        h(Notice, { style: S.notice },
          autoOn
            ? '自动切换已打开：仅当额度被判定为**明确耗尽**（只认结构化错误码）时，才会真的换账号重新派发；'
              + '未知 / 429 / 网络错误 / 认证失效**一律不切**。实时状态看 `GET /harness-pilot/api/pool/autoswitch` —— '
              + '`runtime` 是冻结 / 冷却 / 熔断，`lastResult` 是每次尝试（都是真实派发）。'
            : '自动切换默认关闭：打开后才会在**明确耗尽**（只认结构化错误码）时换账号重跑；'
              + '未知 / 429 / 网络 / 认证失效**一律不切**；关闭状态下即使额度耗尽也不会自动切换。'
              + '实时状态看 `GET /harness-pilot/api/pool/autoswitch`（`runtime` 冻结/冷却/熔断、`lastResult` 每次尝试）。',
        ),
        pool.error.length > 0 ? h(Notice, { style: S.noticeError }, '账号池接口读取失败：' + pool.error) : null,
        pool.note.length > 0 ? h(Notice, { style: S.notice }, pool.note) : null,
        data && data.disclaimer ? h('div', { style: S.monoDim }, str(data.disclaimer)) : null,
        // 注：本面板目前**未挂载**到界面（section 改版后剩下）。额度卡片的可见入口在「登录账号」栏，
        // 这里不再重复渲染，避免一旦重新挂载就出现两张同一个来源的卡。

        members.length === 0 && pool.error.length === 0 ? h('div', { style: S.empty }, '暂无账号池成员') : h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, '账号（脱敏）'),
            h('th', { style: S.th }, 'Harness / 区域'),
            h('th', { style: S.th }, '认证状态'),
            h('th', { style: S.th }, '额度'),
            h('th', { style: S.th }, '池内 / 优先级 / 冷却'),
            h('th', { style: S.th }, '操作'),
          )),
          h('tbody', null, members.map((m, i) => {
            const id = str(m.accountId)
            const quota = isObj(m.quota) ? m.quota : {}
            const isDefault = m.isDefault === true
            return h('tr', { key: id + '#' + String(i), style: S.tr },
              h('td', { style: S.td },
                h('div', { style: S.name }, str(m.redacted) || id),
                isDefault ? h('span', { style: Object.assign({}, S.badge, { color: C.ok }) }, '默认账号') : null,
              ),
              h('td', { style: S.td }, str(m.harnessId) + ' · ' + str(m.region)),
              h('td', { style: S.td }, authBadge(authOf(id))),
              h('td', { style: S.td },
                h('span', {
                  style: Object.assign({}, S.badge, { color: C.textDim }),
                  title: str(quota.note),
                }, '未知'),
                h('div', { style: S.monoDim }, '未知 ≠ 额度充足'),
              ),
              h('td', { style: S.td },
                h('div', null,
                  h('input', {
                    type: 'checkbox',
                    checked: m.enabled === true,
                    disabled: pool.busy === id,
                    onChange: e => { void pool.post(POOL_API, { entry: { accountId: id, enabled: e.target.checked === true } }, id) },
                  }),
                  ' 启用',
                ),
                h('div', { style: S.monoDim }, '优先级 ' + String(m.priority ?? '-') + ' · 冷却 ' + String(Math.round(Number(m.cooldownMs ?? 0) / 1000)) + 's'),
              ),
              h('td', { style: S.td },
                h('button', {
                  type: 'button',
                  style: pool.busy === 'sw-' + id ? S.buttonBusy : S.button,
                  disabled: pool.busy === 'sw-' + id || m.enabled !== true,
                  title: m.enabled === true
                    ? '把该账号设为账号池默认账号：之后新建的派发会用它；正在运行的任务不受影响'
                    : '该账号未启用，不能作为切换目标（先启用）',
                  onClick: () => {
                    void pool.post(POOL_API + '/switch', {
                      scope: { kind: 'session', id: 'settings-pool-panel' },
                      harnessId: str(m.harnessId),
                      fromAccountId: defaultId,
                      toAccountId: id,
                      authOfTarget: authOf(id),
                      nativeSessionResumable: false,
                    }, 'sw-' + id)
                  },
                }, '一键切换'),
                // 原生登录 / 退出：调该 CLI **自己**的流程（先出计划，交互式只给你要执行的那一步）。
                // 旧版本这里放的是一个点了没用的灰按钮（已删除）—— 那是把能做的事说成不能做。
                h(NativeAuthActions, { accountId: id, label: accountLabel('', id, m.redacted) }),
                // 删除档案：只是删**登记**（不删凭据）；服务端拒绝时原样显示它的原因。
                h(DeleteActions, { id: id, label: accountLabel('', id, m.redacted), canRestore: false }),
              ),
            )
          })),
        ),
        h('div', { style: S.monoDim, marginTop: 4 },
          '说明：一键切换本身**只做判定与记账**（并把这个账号设为账号池默认账号），它不执行派发；'
          + '真正的「换账号重跑」由自动切换执行侧负责（见下方 runtime 与 lastResult）。'
          + '模型保不住、存在结果不确定的写操作等情况，接口会返回警告，界面必须如实显示。'),

        // ── 自动切换执行侧：冻结 / 冷却 / 熔断 / 每次尝试 ──
        h(AutoSwitchRuntimePanel, { members: members }),

        // ── 切换事件：原因 / 前后脱敏账号 / 时间 / 恢复方式 / 结果 ──
        h('div', { style: { marginTop: 12 } },
          h('div', { style: S.sectionTitle }, '切换事件（' + String(pool.events.length) + '）'),
          h('div', { style: S.monoDim },
            '包含切换原因、前后**脱敏**账号、时间、恢复方式与结果。拒绝与失败也记账 —— 它们同样是事实。'
            + (pool.audit.length > 0 ? `⚠️ 脱敏审计发现 ${String(pool.audit.length)} 处未脱敏内容！` : '（脱敏审计：0 处命中）')),
          pool.events.length === 0
            ? h('div', { style: S.empty }, '暂无切换事件')
            : h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, '时间'),
                h('th', { style: S.th }, '结果 / 触发'),
                h('th', { style: S.th }, '账号（前 → 后）'),
                h('th', { style: S.th }, '原因'),
                h('th', { style: S.th }, '恢复方式 / 交接边界'),
              )),
              h('tbody', null, pool.events.slice(0, 20).map((e, i) => {
                const result = str(e.result)
                const color = result === 'switched' ? C.ok : (result === 'refused' ? C.textDim : C.bad)
                return h('tr', { key: str(e.id) + '#' + String(i), style: S.tr },
                  h('td', { style: S.td }, str(e.at).replace('T', ' ').slice(0, 19)),
                  h('td', { style: S.td },
                    h('span', { style: Object.assign({}, S.badge, { color }) }, result || '?'),
                    h('div', { style: S.monoDim }, str(e.trigger) + ' · ' + str(e.scope && e.scope.kind)),
                  ),
                  h('td', { style: S.td },
                    h('div', { style: S.monoDim }, str(e.fromAccount) + ' → ' + str(e.toAccount)),
                    e.modelPreserved === false ? h('div', { style: { color: C.bad, fontSize: 11 } }, '模型未保住') : null,
                  ),
                  h('td', { style: S.td, title: str(e.reason) },
                    h('div', { style: S.desc, title: str(e.reason) }, str(e.reason)),
                  ),
                  h('td', { style: S.td },
                    h('div', { style: S.monoDim }, str(e.recovery)),
                    str(e.boundary).length > 0
                      ? h('div', { style: S.desc, title: str(e.boundary) }, str(e.boundary))
                      : null,
                  ),
                )
              })),
            ),
        ),
      )
    }

    // ═══════════ 进程与内存（P6）：**完整进程集合**，含树外厂商守护进程 ═══════════
    const DIAG_PROCESSES = '/harness-pilot/api/diag/processes'

    /**
     * 进程与内存面板。
     *
     * 为什么要有：§1.15 的内存数字**只覆盖 DSH 根进程树**，漏掉了树外的厂商常驻守护进程
     * （实测 opencode `serve --service` 约 320 MB）。用户要的是「按**完整进程集合**实测」——
     * 一个精确但不完整的数字更误导，所以这里把树外部分也显示出来。
     *
     * 诚实性纪律：接口失败时显示失败原因，**不显示 0**（工具失败不能伪装成「没有进程」）；
     * 树外进程只报告、不做归因（仅凭进程名分不清是谁拉起的）。
     *
     * 两个分支的分工（都不得撒谎）：
     *   · `available === true`  → 显示整机进程数 / 整机内存 / **树外厂商进程数与 MB**（§1.15 漏掉的那部分）。
     *   · `available !== true`  → **原样**显示接口给的失败原因，另起一行写清「不是 0」。
     *     原来的写法是 `'无法枚举进程：' + reason`，而接口给的 reason 本身就以「无法枚举进程」开头，
     *     于是界面上出现「无法枚举进程：无法枚举进程（…）—— 按「未知」处理 … —— 按「未知」处理，不是 0」，
     *     同一句话重复两遍、失败原因被自己的前缀淹没。原因归接口，客户端只补「不是 0」这一句口径。
     */
    /** 宽松取数（缺失/非数值 ⇒ 0）：**只用于计数类摘要**，不用于「未知/未提供」语义的字段。 */
    function asNum(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      const parsed = typeof value === 'string' ? Number(value.trim()) : Number.NaN
      return Number.isFinite(parsed) ? parsed : 0
    }
    /** 数字字段的显示口径：缺失时写「未提供」——**不得**退化成 0（0 会被读成「真的没有」）或裸 `?`。 */
    function numText(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      return '未提供'
    }
    function ProcessMemoryPanel() {
      const [state, setState] = React.useState({ data: null, error: '', loading: false })
      const load = React.useCallback(() => {
        setState(s => Object.assign({}, s, { loading: true }))
        fetch(DIAG_PROCESSES, { headers: { accept: 'application/json' } })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + String(r.status)); return r.json() })
          .then(j => setState({ data: isObj(j) ? j : null, error: '', loading: false }))
          .catch(e => setState({ data: null, error: str(e && e.message) || String(e), loading: false }))
      }, [])
      React.useEffect(() => { load() }, [load])
      const d = state.data
      return h('div', null,
        h('div', { style: S.meta },
          h('button', { type: 'button', style: state.loading ? S.buttonBusy : S.button, disabled: state.loading, onClick: load },
            state.loading ? '读取中…' : '刷新'),
          h('span', { style: S.monoDim }, DIAG_PROCESSES),
        ),
        // 口径必须写在面板上（探针按它断言）：测的是**完整进程集合**，不是只测本插件起的那几个。
        // 本机实测过：只看「插件自己起的进程」会把常驻的厂商守护进程排除在外，那就不叫内存占用。
        h(Hint, { style: S.monoDim }, '按**完整进程集合**统计（含树外厂商守护进程）；只报事实与占用，不做归因。'),
        state.error.length > 0 ? h(Notice, { style: S.noticeError }, '进程接口读取失败：' + state.error) : null,
        d === null && state.error.length === 0 ? h('div', { style: S.empty }, state.loading ? '读取中…' : '暂无数据') : null,
        d !== null ? h('div', null,
          d.available !== true
            ? h('div', null,
                // 失败原因**原样**显示（是什么工具失败由接口说，客户端不加前缀、不重写）。
                h(Notice, { style: S.noticeError },
                  str(d.reason).length > 0
                    ? str(d.reason)
                    : '进程枚举失败，但接口没有给出原因 —— 「不知道」不等于「没有进程」'),
                // 这一句是客户端自己的口径：工具失败**不得**被当成「整机没有进程」。
                h(Notice, { style: S.noticeError }, '按「未知」处理，不是 0 —— 工具失败不得伪装成「没有进程」。'),
              )
            : h('div', { style: S.meta },
                h('span', null, '整机进程 ' + numText(d.totalProcesses) + ' 个'),
                h('span', null, '整机内存约 ' + numText(d.totalMB) + ' MB'),
                h('span', null, '树外厂商进程 ' + numText(d.vendorProcessCount) + ' 个 / ' + numText(d.vendorTotalMB) + ' MB'),
              ),
          asArray(d.vendorProcesses).length > 0
            ? h('ul', { style: S.list }, asArray(d.vendorProcesses).map((p, i) => h('li', { key: str(p.name) + String(i), style: S.listItem },
                h('span', { style: S.grow }, str(p.name) + ' (pid ' + String(p.pid) + ')'),
                h('span', { style: S.monoDim }, String(p.mb) + ' MB'),
              )))
            : null,
          str(d.responsibleFor).length > 0 ? h(Notice, { style: S.notice }, str(d.responsibleFor)) : null,
          str(d.caveat).length > 0 ? h('div', { style: S.monoDim }, str(d.caveat)) : null,
        ) : null,
      )
    }

    return {
      inject: ['slots', 'modelDirectories'],
      apply(ctx) {
        // 2026-10-17 用户裁定：会话模型选择器与子代理白名单面板都**恢复宿主原生 UI**，
        // 不再 shadow。外部 CLI 模型此前已从选择器屏蔽（model-visibility groupHidden ×19，
        // 数据仍保留，但对原生选择器不起作用——原生目录本身会按「无凭据即隐藏」等规则收敛）。
        // grouped-models.js 的实现保留在仓库里（探针仍覆盖），只是不再安装。
        // ctx.effect(() => window.__DSH_PILOT_INSTALL_GROUPED__(ctx, require), 'harness-pilot: grouped native model menus')
        // rc.2 declares this as a session-scoped list: preserve native model chrome.
        //
        // ⚠️ `inject` 必须是**无参**函数（宿主自己的写法，见 `dsh-client-ui-open-in-app`：
        // `inject: directoryInjected` 而 `directoryInjected = () => ({...})`）。
        // 原来写成 `inject: sessionId => ({ modelDirectory: ctx.modelDirectories.directoryFor(sessionId).store })`
        // —— 依赖注入参数就是会话 id。实测后果：**会话页头部根本没有徽章**。
        // 原因：宿主的 `directoryFor(sessionId)` 对未知会话是「响亮报错」的
        // （`ui-model-selection: session "…" resolved no scope`），一旦注入参数不是
        // 一个活会话 id（无参调用 ⇒ undefined），这里**抛错** ⇒ 整个座位注册失败、徽章永不出现。
        // 现在改成：注入服务本体，会话 id 从 **props** 取（与宿主同一取法），并把
        // `directoryFor` 包在 try/catch 里 —— 未知会话只是**不显示徽章**，不再搞挂座位。
        // 会话页头部的执行身份徽章。
        //
        // The host renders this session-scoped list in both main and subagent chats.
        // Read host execution history, including completed children, instead of legacy bindings.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'harness-pilot-identity', order: 40,
            inject: () => ({ modelDirectories: ctx.modelDirectories }) },
          HarnessSessionIdentity,
        ))
        // 设置页（**唯一**一张，2026-10-15 用户要求「只有一个设置页面就可」）：列出全部
        // 已配置 harness 与诊断面板。原「设置 → 插件」二级页（settings.plugins.tab）已删。
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'harness-pilot', order: 30, label: '外部 harness 管理' },
          HarnessPilotSection,
        ))
      },
    }
  },
})
