/** Public-slot presentation only; all model writes remain native Host actions.
 *
 * 2026-10-17 视觉融入轮：两个界面全部换用宿主原生原语（MenuSurface/MenuGroup/
 * MenuItemButton/DisclosureRow/Checkbox/Input/Pill/Button），并按用户裁定把
 * 外部 CLI（harness-* / pilot-cli）模型从子代理白名单面板中过滤——会话选择器的
 * 外部 CLI 组由 `/harness-pilot/api/model-visibility` 的 groupHidden 数据屏蔽，
 * 这里不再承担该职责。 */
window.__DSH_PILOT_INSTALL_GROUPED__ = function installGroupedModels(ctx, require) {
  const R = require('react'), h = R.createElement
  const { createPortal } = require('react-dom')
  const P = require('@deepseek-ai/dsh-client-ui-primitives')
  const color = 'var(--dsw-alias-label-primary)'
  const dim = 'var(--dsw-alias-label-tertiary)'
  const border = '1px solid var(--dsw-alias-border-l3)'
  const section = { padding: '24px 0', display: 'grid', gap: 18 }
  const row = { display: 'flex', alignItems: 'center', gap: 12 }
  const button = { background: 'transparent', color, border, borderRadius: 8, padding: '8px 12px', cursor: 'pointer', font: 'inherit' }
  // 会话菜单的子代理面板：外部 CLI 不再作为可授权模型出现（用户裁定 2026-10-17）。
  // 派发外部 Harness 走 harness_* 工具族，不经子代理模型白名单。
  const isHiddenProvider = provider => provider === 'pilot-cli' || String(provider).startsWith('harness-')
  const keyOf = (p, m) => `${p}\0${m}`
  const isAlias = value => /^[0-9a-f]{8}-[0-9a-f-]{27,}::/i.test(value) || value.includes('::')
  const safeList = value => Array.isArray(value) ? value : []

  function groupedCandidates(candidates, query) {
    const groups = new Map(), unavailable = []
    const q = query.trim().toLocaleLowerCase()
    for (const c of safeList(candidates)) {
      if (isHiddenProvider(c.provider)) continue
      if (!c.available) { unavailable.push(c); continue }
      if (q && !`${c.modelName} ${c.model} ${c.providerName} ${c.provider}`.toLocaleLowerCase().includes(q)) continue
      let g = groups.get(c.provider)
      if (!g) groups.set(c.provider, g = { id: c.provider, name: c.providerName, models: [], aliases: [] })
      ;(isAlias(c.model) ? g.aliases : g.models).push(c)
    }
    return { groups: [...groups.values()], unavailable }
  }

  function shell(limits, models) {
    const parts = [limits, models].filter(v => v.available)
    return { available: !!parts.length, writable: parts.every(v => v.writable), dirty: parts.some(v => v.dirty),
      invalid: parts.some(v => v.invalid) || !!(models.available && models.dirty && models.conflicted),
      saving: parts.some(v => v.saving), failed: parts.some(v => v.failed) }
  }

  function GroupedSubagent(props) {
    const limits = props.useSubagentLimitsCard(s => s)
    const models = props.useSubagentModelSelectionCard(s => s)
    const [query, setQuery] = R.useState('')
    const [openIds, setOpenIds] = R.useState(() => new Set())
    const id = R.useId(), t = props.t
    if (props.view === 'summary') return '管理子智能体运行限制，按供应商授权可用模型。'
    const state = shell(limits, models), disabled = !models.writable || state.saving
    const { groups, unavailable } = groupedCandidates(models.candidates, query)
    const toggleOpen = pid => setOpenIds(prev => {
      const next = new Set(prev)
      next.has(pid) ? next.delete(pid) : next.add(pid)
      return next
    })
    const modelRow = c => h('label', { key: c.key, style: { ...row, alignItems: 'flex-start', gap: 10, padding: '7px 0', cursor: disabled ? 'default' : 'pointer' } },
      h(P.Checkbox, { checked: c.selected, disabled: disabled || (!c.available && !c.selected), onChange: () => props.toggleModel(c.key) }),
      h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, h('span', null, c.modelName),
        h('small', { style: { display: 'block', color: dim, marginTop: 2 } }, c.model)),
      !c.available && h('small', { style: { color: dim, marginLeft: 'auto' } }, '当前不可用'))
    const providerBlock = g => {
      const open = openIds.has(g.id) || query.trim() !== ''
      const total = g.models.length + g.aliases.length
      const selected = [...g.models, ...g.aliases].filter(c => c.selected).length
      return h(P.DisclosureRow, { key: g.id, expandable: true, expandOnRowClick: true, open, onToggle: () => toggleOpen(g.id),
        title: `${g.name} · ${total} 个模型`,
        collapsedContent: h('span', { style: { color: dim, marginLeft: 8 } }, `已选 ${selected}`) },
        open && h('div', { style: { padding: '2px 0 14px 22px', display: 'grid', gap: 2 } },
          g.models.map(modelRow),
          g.aliases.length > 0 && h('div', { style: { marginTop: 8, marginBottom: 2, fontSize: 12, color: dim } }, `指定账号路由（${g.aliases.length}）`),
          g.aliases.length > 0 && g.aliases.map(modelRow)))
    }
    const field = (name, label, minimum) => h(P.SettingsValueField, {
      id: `${id}-${name}`, label, overriddenLabel: t('overridden'), resetLabel: t('reset'),
      invalidLabel: `请输入不小于 ${minimum} 的整数。`, numeric: true,
      disabled: !limits.writable || state.saving, ...limits[name],
      onEdit: text => props.editLimit(name, text), onReset: () => props.resetLimit(name),
    })
    return h(P.SettingsForm, {
      labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
      state, onSave: props.save, onDiscard: props.discard,
    }, limits.available && h('section', { style: section }, h('h3', { style: { margin: 0 } }, '运行限制'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(220px,100%),1fr))', gap: 24 } },
        field('maxDepth', '最大递归深度', 0), field('maxActiveSubagents', '子智能体并行数量上限', 1)),
      h('small', { style: { color: dim } }, '深度 0 禁用子智能体；深度 1 仅主 Agent 可创建。工具自己的深度限制优先。')),
    models.available && h('section', { style: { ...section, borderTop: border } },
      h('div', { style: { ...row, justifyContent: 'space-between' } }, h('strong', null, '允许 Agent 为子智能体选择模型'),
        h(P.Switch, { checked: models.enabled, label: '允许 Agent 为子智能体选择模型', disabled, onChange: props.toggleEnabled })),
      h('p', { style: { color: dim, margin: 0, lineHeight: 1.7 } }, models.enabled
        ? '一级展开供应商，二级勾选模型。授权仅影响新会话；会话菜单的显示开关不会移除这里的模型。'
        : '关闭后使用配置默认模型或继承父 Agent 模型，已授权选择会保留。'),
      models.enabled && h(R.Fragment, null,
        h(P.Input, { type: 'search', value: query, placeholder: '搜索供应商或模型', 'aria-label': '搜索子智能体模型',
          onChange: e => setQuery(e.target.value), style: { width: '100%' } }),
        models.catalogStatus === 'loading' && h('p', { role: 'status' }, '正在加载模型…'),
        models.catalogStatus === 'error' && h('div', { role: 'alert', style: row }, '模型目录加载失败。', h(P.Button, { size: 'sm', onClick: props.retryCatalog }, '重试')),
        models.catalogPartial && h('p', { style: { color: dim } }, '部分供应商目录暂不可达，已有授权保留在下方诊断中。'),
        h('div', null, groups.map(providerBlock)),
        !groups.length && models.catalogStatus === 'ready' && h('p', { style: { color: dim } }, '没有匹配的可用模型。'),
        unavailable.length > 0 && h(P.DisclosureRow, { expandable: true, expandOnRowClick: true, open: openIds.has('__unavailable'), onToggle: () => toggleOpen('__unavailable'),
          title: `已保存但当前不可用（${unavailable.length}，仅供移除 / 诊断）` },
          openIds.has('__unavailable') && h('div', { style: { padding: '2px 0 14px 22px', display: 'grid', gap: 2 } }, unavailable.map(modelRow))),
        models.invalid && h('p', { role: 'alert' }, '保存前请至少选择一个模型。'),
        models.conflicted && h('p', { role: 'alert' }, '设置已在其他位置更新。请放弃修改后重试。'))))
  }

  function GroupedConversation({ locked, available, directory, load, select }) {
    const state = R.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
    const [open, setOpen] = R.useState(false), [query, setQuery] = R.useState('')
    const [visibility, setVisibility] = R.useState([]), [failure, setFailure] = R.useState('')
    const trigger = R.useRef(null), menu = R.useRef(null), [position, setPosition] = R.useState({})
    const busy = state.pending !== null && state.pending !== undefined
    const all = safeList(state.groups)
    const currentGroup = all.find(g => g.id === state.current?.provider)
    const currentModel = currentGroup?.models.find(m => m.id === state.current?.model)
    function allowed(provider, model) {
      const relevant = visibility.flatMap(v => safeList(v.providers)).find(v => v.providerId === provider)
      if (relevant) {
        const config = relevant.summary || relevant
        if (config.groupHidden) return false
        if(model==='cli-default')return !safeList(config.models).some(m=>m.id===model&&m.visible===false)
        const models = safeList(config.models).filter(m => m.visible)
        const limited = config.limit > 0 ? models.slice(0, config.limit) : models
        return limited.some(m => m.id === model)
      }
      return !provider.startsWith('harness-') && provider !== 'pilot-cli'
    }
    const groups = all.map(g => ({ ...g, models: safeList(g.models).filter(m => allowed(g.id, m.id)
      && (!query || `${g.name} ${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()))) })).filter(g => g.models.length)
    R.useEffect(() => {
      if (!open) return
      let live = true
      Promise.all(['/harness-pilot/api/model-visibility', '/model-connect/api/model-visibility'].map(async url => {
        try { const res = await fetch(url, { credentials: 'same-origin' }); return res.ok ? await res.json() : null } catch { return null }
      })).then(values => { if (live) setVisibility(values.filter(Boolean)) })
      const rect = trigger.current?.getBoundingClientRect()
      const popupWidth=menu.current?.getBoundingClientRect()?.width||320
      if (rect) setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - popupWidth - 16)), bottom: Math.max(16, window.innerHeight - rect.top + 6) })
      const close = e => { if (!menu.current?.contains(e.target) && !trigger.current?.contains(e.target)) setOpen(false) }
      document.addEventListener('pointerdown', close)
      return () => { live = false; document.removeEventListener('pointerdown', close) }
    }, [open])
    function close() { setOpen(false); trigger.current?.focus() }
    async function choose(selection) {
      setFailure('')
      try { const result = await select(selection); if (result?.ok === false) setFailure(result.error?.message || '模型选择未生效。'); else close() }
      catch { setFailure('模型选择未生效，请重试。') }
    }
    function keyboard(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.target.tagName === 'INPUT') return
      const nodes = [...menu.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(n => n.getClientRects().length)
      const i = nodes.indexOf(document.activeElement), delta = e.key === 'ArrowUp' ? -1 : 1
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : (i + delta + nodes.length) % nodes.length
      e.preventDefault(); nodes[next]?.focus()
    }
    const effort = currentModel?.reasoning
    const currentEffort = state.current?.reasoningEffort ?? effort?.defaultEffort ?? ''
    return h(R.Fragment, null,
      h('button', { ref: trigger, type: 'button', disabled: locked || !available, 'aria-expanded': open, 'aria-haspopup': 'dialog',
        style: { ...button, border: 0, height: 28, fontSize: 13, lineHeight: '20px', padding: '0 4px 0 8px', maxWidth: 340, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' },
        onClick: () => { setOpen(!open); if (!open) { setQuery(''); load() } } },
      busy ? '切换中…' : `${currentModel?.name || state.current?.model || '选择模型'}${state.current?.reasoningEffort ? ` · ${state.current.reasoningEffort}` : ''} ▾`),
      open && createPortal(h(P.MenuSurface, { ref: menu, role: 'dialog', 'aria-label': '选择供应商和模型', onKeyDown: keyboard,
        style: { position: 'fixed', zIndex: 1100, ...position, boxSizing: 'border-box', width: 'max-content', minWidth: 'min(260px,calc(100vw - 32px))', maxWidth: 'min(420px,calc(100vw - 32px))', maxHeight: 'min(420px,calc(100vh - 96px))', overflowY: 'auto',
          fontFamily: 'inherit', fontSize: 13, lineHeight: '20px', color, padding: 4 } },
      h('div', { style: { ...row, justifyContent: 'space-between', padding: '4px 7px', fontSize: 11, color: dim } }, '供应商', h(P.Button, { size: 'sm', onClick: close, 'aria-label': '关闭模型菜单' }, '关闭')),
      h(P.Input, { autoFocus: true, type: 'search', value: query, 'aria-label': '搜索模型', placeholder: '搜索模型或供应商', onChange: e => setQuery(e.target.value),
        style: { boxSizing: 'border-box', width: '100%', marginBottom: 3, fontSize: 12, lineHeight: '18px' } }),
      (failure || state.error) && h('p', { role: 'alert', style: { overflowWrap: 'anywhere', padding: '2px 7px' } }, failure || state.error),
      state.status === 'loading' && h('p', { role: 'status', style: { padding: '2px 7px' } }, '正在加载模型…'),
      groups.map(g => h(P.MenuGroup, { key: g.id, label: `${g.name} · ${g.models.length}` },
        g.models.map(m => h(P.MenuItemButton, { key: m.id, disabled: busy,
          icon: state.current?.provider === g.id && state.current?.model === m.id ? h(P.IconCheckCircleFillMedium, { style: { width: 14, height: 14 } }) : undefined,
          onSelect: () => choose({ provider: g.id, model: m.id, ...(m.reasoning?.defaultEffort ? { reasoningEffort: m.reasoning.defaultEffort } : {}) }) },
          h('span', { style: { overflowWrap: 'anywhere' } }, m.name))))),
      !groups.length && state.status !== 'loading' && h('p', { style: { color: dim, padding: '2px 7px' } }, '没有可显示的模型，请在设置中检查显示开关。'),
      h('div', { style: { borderTop: border, marginTop: 3, padding: '7px', display: 'grid', gap: 6 } },
        effort && state.current && h('div', { style: { ...row, flexWrap: 'wrap', gap: 6 } },
          h('span', { style: { fontSize: 11, color: dim } }, '推理强度'),
          safeList(effort.efforts).map(v => h(P.Pill, { key: v.id, active: currentEffort === v.id,
            onClick: () => choose({ provider: state.current.provider, model: state.current.model, ...(v.id ? { reasoningEffort: v.id } : {}) }) }, v.name))),
        h(P.Button, { size: 'sm', onClick: () => load() }, '刷新目录'))), document.body))
  }

  const disposers = []
  const slots = ctx.slots
  // Cordis contextual service views write into per-caller shadows. Patch the
  // shared read facade, or the plugin-manager caller would still see two rows.
  const registry=slots[Symbol.for('cordis.original')]||slots
  const baseEntries = registry.entries
  const rawEntries = name => baseEntries.call(slots, name)
  const navigationSnapshots=new WeakMap()
  const hadOwnEntries=Object.prototype.hasOwnProperty.call(registry,'entries')
  // rc.2 plugin-manager enumerates raw entries(), not entriesOfSlot(). A shadow
  // consequently creates two navigation rows for one id. Project only this id
  // through the same priority rule; keep the underlying registrations intact.
  const navigationEntries = function(name) {
    const entries=baseEntries.call(this,name)
    if(name!=='plugins.item')return entries
    if(navigationSnapshots.has(entries))return navigationSnapshots.get(entries)
    let seen=false
    const projected=entries.filter(entry=>{
      if(entry.options.id!=='subagent')return true
      if(seen)return false
      seen=true;return true
    })
    navigationSnapshots.set(entries,projected)
    return projected
  }
  let navigationPatched=false
  try { registry.entries=navigationEntries; navigationPatched=registry.entries===navigationEntries } catch { /* Keep the native page if the host locks its read facade. */ }
  disposers.push(()=>{if(navigationPatched&&registry.entries===navigationEntries){if(hadOwnEntries)registry.entries=baseEntries;else delete registry.entries}})
  const mountShadow = (name, id, component) => {
    let original, remove
    const sync = () => {
      const entry = rawEntries(name).find(e => e.component !== component && (id === undefined || e.options.id === id) && (e.options.priority ?? 0) >= 0)
      if (entry === original) return
      remove?.(); remove = undefined; original = entry
      if (entry) remove = ctx.slots.register({ name, ...entry.options, priority: -20,
        ...(entry.locale ? { locale: entry.locale } : {}), ...(entry.inject ? { inject: entry.inject } : {}) }, component)
    }
    sync()
    const unsub = ctx.slots.subscribe(name, sync)
    disposers.push(() => { unsub(); remove?.() })
  }
  mountShadow('conversation.input.model', undefined, GroupedConversation)
  if(navigationPatched)mountShadow('plugins.item', 'subagent', GroupedSubagent)
  return () => disposers.reverse().forEach(dispose => dispose())
}
