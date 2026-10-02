/**
 * （rev 标记：3dff19ac）
 * @dsh-external/dsh-harness-pilot — 浏览器端（client）半边。
 *
 * 只做两件事，零构建、零依赖（除宿主模块表里的 react）：
 *   1. `settings.section` 注册一个「外部 Harness」设置页：目标表 + 实时会话 + 已配置供应商。
 *   2. `settings.plugins.tab` 注册「设置 → 插件」里的一页，让插件在该区可见并展示 harness 概览。
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
    /** 后台任务：概览里的 tasks 字段。 */
    function readTasks(data) {
      return asArray(isObj(data) ? data.tasks : null).filter(isObj).map((t, index) => ({
        key: str(t.task_id) || 'task#' + String(index),
        id: str(t.task_id),
        target: str(t.target),
        model: str(t.model),
        status: str(t.status) || 'unknown',
        cwd: str(t.cwd),
        elapsedMs: typeof t.elapsed_ms === 'number' ? t.elapsed_ms : 0,
        outputChars: typeof t.output_chars === 'number' ? t.output_chars : 0,
        diagnostic: str(t.diagnostic),
        resultPath: str(t.result_path),
        callback: isObj(t.callback) ? t.callback : null,
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
      page: { padding: '14px 16px', maxWidth: 780, color: C.text, fontSize: 12, lineHeight: 1.6, fontFamily: 'inherit' },
      headRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 14, fontWeight: 600, color: C.text },
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
      section: { marginTop: 16 },
      sectionTitle: { marginBottom: 6, fontSize: 12, fontWeight: 600, color: C.text },
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
            maxConcurrent: Number(initial.maxConcurrent) > 0 ? Number(initial.maxConcurrent) : 4,
            defaultTaskTimeoutMs: Number(initial.defaultTaskTimeoutMs) > 0 ? Number(initial.defaultTaskTimeoutMs) : 600000,
            resumeInstruction: typeof initial.resumeInstruction === 'string' ? initial.resumeInstruction : '',
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
            type: 'number', style: S.input, value: String(form.maxConcurrent), min: 1, max: 16,
            onChange: e => set({ maxConcurrent: Number(e.target.value) }),
          }),
          '同时在跑的 harness_task_start 数量'),
        row('任务默认超时（毫秒）',
          h('input', {
            type: 'number', style: S.input, value: String(form.defaultTaskTimeoutMs), min: 5000,
            onChange: e => set({ defaultTaskTimeoutMs: Number(e.target.value) }),
          }),
          'harness_task_start 未指定 timeout_ms 时使用'),
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
        return h('li', { key: t.key, style: { display: 'block', padding: '6px 0', borderBottom: '1px solid ' + C.borderSoft } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', {
              style: Object.assign({}, S.dot, { background: running ? C.ok : (t.status === 'completed' ? C.ok : C.bad) }),
              title: t.status,
            }),
            h('span', { style: Object.assign({}, S.monoDim, { color: C.text }) }, t.id.slice(0, 8)),
            h('span', { style: S.badge }, t.target),
            t.model.length > 0 ? h('span', { style: S.badge }, t.model) : null,
            h('span', { style: S.badge }, t.status),
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
          detail !== null && detail.id === t.id
            ? h('pre', { style: S.pre }, detail.text)
            : null,
        )
      }))
    }

    /** `settings.section` 页：外部 Harness 总览。 */
    function HarnessPilotSection() {
      const overview = useOverview()
      const targets = readTargets(overview.data)
      const sessions = readSessions(overview.data)
      const providers = readProviders(overview.data)
      const updated = clockText(overview.updatedAt)
      const defaultTarget = isObj(overview.data) ? str(overview.data.defaultTarget) : ''
      const plugin = pluginText(overview.data)

      return h('div', { style: S.page },
        h('div', { style: S.headRow },
          h('div', null,
            h('div', { style: S.title }, '外部 Harness'),
            h('div', { style: S.summary }, summaryText(targets, sessions)),
          ),
          h('button', {
            type: 'button',
            style: overview.loading ? S.buttonBusy : S.button,
            disabled: overview.loading === true,
            onClick: () => { void overview.reload() },
            title: '重新读取 ' + API,
          }, overview.loading ? '刷新中…' : '刷新'),
        ),
        h('div', { style: S.meta },
          h('span', null, updated.length > 0 ? '更新于 ' + updated : (overview.loading ? '读取中…' : '尚未更新')),
          plugin.length > 0 ? h('span', { style: S.monoDim }, plugin) : null,
          defaultTarget.length > 0 ? h('span', null, '默认目标：' + defaultTarget) : null,
          h('span', { style: S.monoDim }, API),
        ),
        overview.error.length > 0
          ? h('div', { style: S.noticeError }, '概览接口读取失败：' + overview.error)
          : null,
        overview.data === null && overview.error.length === 0
          ? h('div', { style: S.notice }, emptyNotice(overview))
          : null,

        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, 'harness 目标（' + String(targets.length) + '）'),
          h(TargetsTable, { targets: targets, defaultTarget: defaultTarget, hasData: overview.data !== null }),
        ),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '实时会话（' + String(sessions.length) + '）'),
          h(SessionsList, { sessions: sessions }),
        ),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, 'DSH 已配置供应商（' + String(providers.length) + '）'),
          h(ProvidersList, { providers: providers }),
        ),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '插件设置'),
          h(SettingsForm, { overview: overview }),
        ),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '后台任务（harness_task_start）'),
          h(TasksPanel, { overview: overview }),
        ),
      )
    }

    // ── 组件：插件页卡片（summary = 一行，page = 详情）─────────────
    function HarnessPilotCard(props) {
      const view = isObj(props) ? str(props.view) : ''
      const overview = useOverview()
      const targets = readTargets(overview.data)
      const sessions = readSessions(overview.data)
      const updated = clockText(overview.updatedAt)
      const status = overview.error.length > 0 && overview.data === null
        ? '概览接口不可用：' + overview.error
        : summaryText(targets, sessions) + (updated.length > 0 ? ' · 更新于 ' + updated : '')

      if (view === 'summary') {
        return h('div', { style: S.cardSummaryInline }, '外部 harness 接入 · ' + status)
      }
      return h('div', { style: S.card },
        h('div', { style: S.cardTitle }, 'Harness Pilot · 外部 harness 接入'),
        h('div', { style: S.cardLine },
          '把 opencode / agy / ZCode / MiMo / Cursor / Qoder / Antigravity 等已有 harness 接成 DSH 子代理与可操控会话；'
          + '支持选模型、新开会话、后台任务派发，任务完成自动把交付内容送回会话并唤醒继续。'),
        h('div', { style: S.cardSummary }, status),
        h('div', { style: S.cardLine },
          h('span', { style: S.monoDim }, '插件设置、后台任务与完整目标表见「设置 → 外部 Harness」。')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置页：列出全部已配置 harness（用户的主诉求）。
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'harness-pilot', order: 30, label: '外部 Harness' },
          HarnessPilotSection,
        ))
        // 插件设置区里的一页：让插件在「设置 → 插件」中可见并直接看到 harness 概览。
        // 用 settings.plugins.tab（= 插件设置区的一个页面）而不是 plugins.item：
        // 后者是「官方插件列表卡」的内部槽位，注入器的骨架校验不认它。
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'harness-pilot', order: 40, label: 'Harness Pilot · 外部 harness' },
          HarnessPilotCard,
        ))
      },
    }
  },
})
