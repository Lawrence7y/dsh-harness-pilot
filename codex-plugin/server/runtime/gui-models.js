export function mechanismOf(target) {
    const parts = [];
    if (target.modelArgs.length > 0)
        parts.push(`argv ${target.modelArgs.join(' ')}`);
    if (target.acpArgs.length > 0)
        parts.push('ACP session/set_config_option');
    if (parts.length === 0)
        parts.push('no model switch (GUI harness picks the model in its own UI)');
    if (target.acpModel.length > 0)
        parts.push(`default: ${target.acpModel}`);
    return parts.join(' + ');
}
/** 在 CDP 会话里按可见文字点击元素（打开面板 / 点按钮）。返回页面内的自述结果。 */
function clickByTextSnippet(needle) {
    return `(() => {
  const needle = ${JSON.stringify(needle)};
  const visible = [];
  for (const el of document.querySelectorAll('button,a,[role="button"],div,span,li,p')) {
    try {
      const text = (el.innerText || '').trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      visible.push({ el, text, area: r.width * r.height, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略取不到文字的节点 */ }
  }
  const byArea = (a, b) => a.area - b.area;
  const hit = visible.filter(v => v.text === needle).sort(byArea)[0]
    ?? visible.filter(v => v.text.includes(needle)).sort(byArea)[0];
  if (!hit) {
    return { ok: false, reason: 'no visible element matched ' + JSON.stringify(needle), candidates: visible.slice(0, 15).map(v => v.text.slice(0, 40)) };
  }
  hit.el.click();
  return { ok: true, text: hit.text.slice(0, 80), rect: hit.rect };
})()`;
}
/**
 * 打开 GUI harness 的模型选择器。两级策略：
 *  1. 结构选择器优先（`[class*=model-selector]` / `[data-testid*=model-selector]` / `aria-label` 含 model|模型）——
 *     这些是应用自己的模型控件。
 *  2. 退回"文字像模型名"的可点元素（必须同时有厂商词 + 版本号，避免点到资源管理器里的 `.claude` 目录这种）。
 */
function openModelPickerSnippet() {
    return `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width >= 20 && r.height >= 12 ? r : null; };
  const areaOf = (r) => r.width * r.height;
  // 第一级：结构选择器（含实测到的 hooks：MiMo #model-btn / [data-model-menu]、ZCode [data-testid*=chat-model]）
  const structural = [];
  for (const el of document.querySelectorAll('[class*="model-selector"],[class*="model-list-selector"],[data-testid*="model-selector"],[data-testid*="chat-model"],[data-model-menu],[class*="model-btn"],[class*="model-trigger"],[aria-label*="model" i],[aria-label*="模型"]')) {
    try {
      const r = visible(el); if (r === null) continue;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '').trim()).trim();
      structural.push({ el, label: label.slice(0, 60), area: areaOf(r), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略 */ }
  }
  structural.sort((a, b) => a.area - b.area);
  if (structural.length > 0) {
    const hit = structural[0];
    // Radix DropdownMenu / Popover 不听 el.click()：派发完整鼠标序列（ZCode 实测只认 pointerdown）。
    try {
      const o = { bubbles: true, cancelable: true, view: window, clientX: hit.rect[0] + hit.rect[2] / 2, clientY: hit.rect[1] + hit.rect[3] / 2, button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) hit.el.dispatchEvent(new MouseEvent(type, o));
    } catch { /* 退化为 click */ }
    hit.el.click();
    return { ok: true, via: 'selector', trigger: hit.label, rect: hit.rect };
  }
  // 第二级：文字像模型名（厂商词 + 版本号），且不是文件树条目
  const MODELISH = /(gpt|claude|gemini|qwen|mimo|deepseek|glm|kimi|minimax|grok|opus|sonnet|llama)[-\\s]?v?\\d/i;
  const cands = [];
  for (const el of document.querySelectorAll('button,[role="button"],[aria-haspopup],div,span')) {
    try {
      const r = visible(el); if (r === null) continue;
      if (el.querySelectorAll('*').length > 3) continue;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.innerText || '').trim()).trim();
      if (label.length === 0 || label.length > 60) continue;
      if (!MODELISH.test(label)) continue;
      const cls = String(el.className || '');
      if (/monaco|explorer|file-tree|tree-item|label-name/i.test(cls)) continue;
      cands.push({ el, label, area: areaOf(r), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略 */ }
  }
  cands.sort((a, b) => a.area - b.area);
  if (cands.length === 0) return { ok: false, reason: 'no model-like trigger found' };
  cands[0].el.click();
  return { ok: true, via: 'text', trigger: cands[0].label, rect: cands[0].rect };
})()`;
}
/** 在弹出的选择器里按模型名点选一项（容忍换行/空格/大小写与"名称+倍率"拼接）。 */
function pickModelOptionSnippet(model) {
    return `(() => {
  const norm = (s) => s.toLowerCase().replace(/[\\s_()（）-]+/g, '');
  const want = norm(${JSON.stringify(model)});
  // 家族名：去掉档位词后的前缀（Antigravity 把 High/Medium/Low 作为行内子标签）
  const family = norm(${JSON.stringify(model)}.replace(/\\b(high|medium|low|minimal|fast|thinking)\\b/gi, ''));
  const level = (${JSON.stringify(model)}.match(/\\b(high|medium|low|minimal)\\b/i) || [])[1] || '';
  const sel = '[role="option"],[role="menuitem"],[role="listitem"],.select2-option,[class*="option"],[class*="model-item"],[data-testid*="model"]';
  const seen = [];
  const exact = [];
  const familyHits = [];
  // select2 这类组件不听 el.click()（它们挂在 mousedown/mouseup 上），必须派发完整鼠标事件序列。
  const fire = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, opts));
      }
      el.click();
      return true;
    } catch { return false; }
  };
  for (const el of document.querySelectorAll(sel)) {
    try {
      const text = (el.innerText || el.textContent || '').trim();
      if (text.length === 0 || text.length > 160) continue;
      seen.push(text.replace(/\\n/g, ' ').slice(0, 48));
      const n = norm(text);
      const r = el.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      if (n.includes(want)) exact.push({ el, text: text.replace(/\\n/g, ' ').slice(0, 60), area });
      else if (family.length > 0 && n.includes(family)) familyHits.push({ el, text: text.replace(/\\n/g, ' ').slice(0, 60), area });
    } catch { /* 忽略 */ }
  }
  const click = (hit, via) => { fire(hit.el); return { ok: true, picked: hit.text, via, options: seen.slice(0, 24) } };
  if (exact.length > 0) { exact.sort((a, b) => a.area - b.area); return click(exact[0], 'exact'); }
  if (familyHits.length > 0) {
    familyHits.sort((a, b) => a.area - b.area);
    const hit = familyHits[0];
    // 行内找档位子标签（元素自身没有子元素且文字等于档位词）
    if (level.length > 0) {
      for (const node of hit.el.querySelectorAll('*')) {
        try {
          if (node.children.length > 0) continue;
          if ((node.textContent || '').trim().toLowerCase() === level.toLowerCase()) { node.click(); return { ok: true, picked: hit.text + ' [' + level + ']', via: 'family+level', options: seen.slice(0, 24) }; }
        } catch { /* 忽略 */ }
      }
    }
    return click(hit, 'family');
  }
  return { ok: false, reason: 'no option matched ' + JSON.stringify(${JSON.stringify(model)}), options: seen.slice(0, 24) };
})()`;
}
/**
 * 数一数当前可见的模型选项（用于判断选择器是否已经打开，避免把已打开的菜单点关掉）。
 *
 * 选择器必须**收紧**：通用 `[role=menuitem]` 会把 IDE 菜单栏项（文件/编辑/…）也数进来，
 * 于是误判成"已打开"、跳过打开步骤 → 真选项根本没进 DOM（Qoder CN 就栽在这）。
 */
function countModelOptionsSnippet() {
    return `(() => {
  const sel = '[role="option"], .select2-option, [data-testid*="model-selector"] [role="menuitem"], [class*="model-list"] [role="menuitem"], [class*="model-selector"] [role="menuitem"]';
  let count = 0;
  const sample = [];
  for (const el of document.querySelectorAll(sel)) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      const text = (el.innerText || '').trim();
      if (text.length === 0) continue;
      count += 1;
      if (sample.length < 6) sample.push(text.replace(/\\n/g, ' ').slice(0, 30));
    } catch { /* 忽略 */ }
  }
  return { count, sample };
})()`;
}
/** 点家族行展开出来的档位/速度芯片（Antigravity：High/Medium/Low × Fast/Thinking）。 */
function clickChipSnippet(word) {
    return `(() => {
  const want = ${JSON.stringify(word)}.toLowerCase();
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    try {
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (text.length === 0 || text.length > 24) continue;
      if (text.toLowerCase() !== want) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      hits.push({ el, text, area: r.width * r.height, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略 */ }
  }
  if (hits.length === 0) return { ok: false, reason: 'chip ' + JSON.stringify(${JSON.stringify(word)}) + ' not found' };
  hits.sort((a, b) => a.area - b.area);
  hits[0].el.click();
  return { ok: true, chip: hits[0].text, rect: hits[0].rect };
})()`;
}
/** 子菜单探测预算：父行最多 12 行 / 最多 10s。 */
const MODEL_PARENT_ROWS = 12;
const MODEL_SUBMENU_BUDGET_MS = 10_000;
function sleep(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : undefined;
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function asText(value) {
    return typeof value === 'string' ? value : '';
}
/** 模型名的比较形态：忽略大小写、空白、括号与 `- _ : /` 分隔符。 */
function normModel(value) {
    return value.toLowerCase().replace(/[\s_()（）\-:/\\]+/g, '');
}
/** 触发按钮上读到的值是否就是想要的那个模型（ZCode 的值形如 `custom:<provider>:<model>`）。 */
function modelMatches(have, want) {
    const target = normModel(want);
    if (target.length === 0)
        return false;
    const current = normModel(have);
    return current === target || current.includes(target);
}
/**
 * 候选行打分：0 = 不匹配，1 = 子串，2 = 前缀/后缀，3 = 完全相等。
 * 4 个字段都看：data-model（MiMo）、data-testid（ZCode 的
 * `chat-model-select-item-custom:<provider>:<model>`）、data-value 与可见文字。
 */
function scoreModelCandidate(candidate, want) {
    const target = normModel(want);
    if (target.length === 0)
        return 0;
    let best = 0;
    for (const field of [candidate.model, candidate.testid, candidate.value, candidate.text]) {
        const haystack = normModel(field);
        if (haystack.length === 0)
            continue;
        if (haystack === target) {
            best = Math.max(best, 3);
            continue;
        }
        if (haystack.endsWith(target) || haystack.startsWith(target)) {
            best = Math.max(best, 2);
            continue;
        }
        if (haystack.includes(target))
            best = Math.max(best, 1);
    }
    return best;
}
/** 同分取面积最小的那一行（菜单里常有「外层容器 + 内层行」两份）。 */
function bestModelCandidate(candidates, want) {
    let best;
    let bestScore = 0;
    for (const candidate of candidates) {
        const score = scoreModelCandidate(candidate, want);
        if (score === 0)
            continue;
        if (best === undefined || score > bestScore || (score === bestScore && candidate.w * candidate.h < best.w * best.h)) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}
function toCandidate(value) {
    const raw = asRecord(value);
    if (raw === undefined)
        return undefined;
    const w = asNumber(raw.w);
    const h = asNumber(raw.h);
    if (w < 4 || h < 4)
        return undefined;
    return {
        x: asNumber(raw.x),
        y: asNumber(raw.y),
        w,
        h,
        text: asText(raw.text),
        model: asText(raw.model),
        testid: asText(raw.testid),
        value: asText(raw.value),
        providerKey: asText(raw.key),
        popup: asText(raw.popup),
        role: asText(raw.role),
        label: asText(raw.label),
    };
}
/**
 * 一次求值读全：触发按钮的屏幕矩形 + 当前模型 + 菜单是否已经开着。
 *
 * ZCode 的触发按钮 innerText 是**过期的动画胶片帧**（`管理模型 step/step-5-preview` 里混着上一帧），
 * 所以值只从属性读：隐藏载体 `span[data-testid="v4-model-config"]` 的 `data-provider`/`data-model`，
 * 其次是 `data-model-current-value`；只有拿不到任何属性源时才退回标签元素 / innerText。
 */
function readModelStateSnippet() {
    return `(() => {
  const SELECTORS = ['#model-btn', '[data-testid="chat-model-select-trigger"]', '[class*="model-selector"]', '[class*="model-list-selector"]'];
  const rect = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
  const text = (el) => String(el === null || el === undefined ? '' : (el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();
  const attr = (el, name) => el === null || el === undefined ? '' : String(el.getAttribute(name) || '').trim();
  const visible = (el) => { const r = el === null ? null : rect(el); return r !== null && r.width >= 12 && r.height >= 8 ? r : null; };
  let trigger = null;
  let triggerRect = null;
  let matchedBy = '';
  for (const selector of SELECTORS) {
    let found = null;
    try { found = document.querySelector(selector); } catch (e) { found = null; }
    const r = visible(found);
    if (r !== null) { trigger = found; triggerRect = r; matchedBy = selector; break; }
  }
  let carrier = null;
  try { carrier = document.querySelector('span[data-testid="v4-model-config"]'); } catch (e) { carrier = null; }
  const labelEl = trigger === null ? null : trigger.querySelector('.model-label');
  const aria = attr(trigger, 'aria-label');
  const dataCurrent = attr(trigger, 'data-model-current-value');
  const dataModel = attr(trigger, 'data-model');
  const carrierModel = attr(carrier, 'data-model');
  const carrierProvider = attr(carrier, 'data-provider');
  let current = '';
  let currentFrom = 'none';
  if (carrierModel.length > 0) { current = carrierModel; currentFrom = 'v4-model-config[data-model]'; }
  else if (dataCurrent.length > 0) { current = dataCurrent; currentFrom = 'trigger[data-model-current-value]'; }
  else if (dataModel.length > 0) { current = dataModel; currentFrom = 'trigger[data-model]'; }
  else if (labelEl !== null && text(labelEl).length > 0) { current = text(labelEl); currentFrom = '.model-label'; }
  else if (trigger !== null && carrier === null && text(trigger).length > 0) { current = text(trigger).slice(0, 80); currentFrom = 'innerText'; }
  else if (aria.length > 0) { current = aria; currentFrom = 'aria-label'; }
  let menuItems = 0;
  for (const menu of document.querySelectorAll('[role="menu"]')) {
    const r = rect(menu);
    if (r === null || r.width < 20 || r.height < 20) continue;
    menuItems += menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]').length;
  }
  return {
    current: current,
    currentFrom: currentFrom,
    aria: aria,
    menuOpen: menuItems > 0,
    menuItems: menuItems,
    trigger: triggerRect === null ? null : {
      x: Math.round(triggerRect.x), y: Math.round(triggerRect.y),
      w: Math.round(triggerRect.width), h: Math.round(triggerRect.height),
      label: current.length > 0 ? current : aria,
      selector: matchedBy
    }
  };
})()`;
}
/**
 * 列出当前可见的候选行（选项 + 能展开子菜单的父行）。**只读，不派发任何事件**：
 * 从页面里 dispatchEvent 会把 ZCode 的求值卡死。
 */
function listModelOptionsSnippet() {
    return `(() => {
  const rect = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
  const text = (el) => String(el === null || el === undefined ? '' : (el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();
  const row = (el) => {
    const r = rect(el);
    if (r === null || r.width < 12 || r.height < 8) return null;
    return {
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      text: text(el).slice(0, 120),
      model: String(el.getAttribute('data-model') || ''),
      testid: String(el.getAttribute('data-testid') || ''),
      value: String(el.getAttribute('data-value') || ''),
      key: String(el.getAttribute('data-model-provider-key') || ''),
      popup: String(el.getAttribute('aria-haspopup') || ''),
      role: String(el.getAttribute('role') || '')
    };
  };
  const CANDIDATES = '[role="option"],[role="menuitem"],[role="menuitemradio"],.select2-option,[data-model],[class*="model-item"]';
  const seen = [];
  const candidates = [];
  for (const el of document.querySelectorAll(CANDIDATES)) {
    if (seen.indexOf(el) >= 0) continue;
    seen.push(el);
    const info = row(el);
    if (info !== null) candidates.push(info);
  }
  // 父行：能展开子菜单的那些（ZCode 用 data-model-provider-key / aria-haspopup="menu"；
  // 另有一条弱规则兜住 data-slot="dropdown-menu-content" 里带 caret 的 menuitem）。
  const subRoots = [];
  for (const el of document.querySelectorAll('[data-slot="dropdown-menu-sub-content"]')) subRoots.push(el);
  const parents = [];
  for (const menu of document.querySelectorAll('[role="menu"]')) {
    const rm = rect(menu);
    if (rm === null || rm.width < 20 || rm.height < 20) continue;
    if (subRoots.indexOf(menu) >= 0) continue;
    const slot = String(menu.getAttribute('data-slot') || '');
    for (const el of menu.querySelectorAll('[data-model-provider-key],[aria-haspopup="menu"],[role="menuitem"]')) {
      const info = row(el);
      if (info === null) continue;
      const strong = info.key.length > 0 || info.popup === 'menu';
      const weak = slot === 'dropdown-menu-content' && info.role === 'menuitem'
        && el.querySelector('svg') !== null && info.text.length > 0 && info.text.length <= 40;
      if (!strong && !weak) continue;
      info.label = info.text.length > 0 ? info.text : info.testid;
      parents.push(info);
    }
  }
  return { candidates: candidates, parents: parents };
})()`;
}
async function readModelState(session) {
    const raw = asRecord(await session.evaluate(readModelStateSnippet()));
    const triggerRaw = raw === undefined ? undefined : asRecord(raw.trigger);
    const trigger = triggerRaw === undefined
        ? undefined
        : {
            x: asNumber(triggerRaw.x),
            y: asNumber(triggerRaw.y),
            w: asNumber(triggerRaw.w),
            h: asNumber(triggerRaw.h),
            label: asText(triggerRaw.label),
            selector: asText(triggerRaw.selector),
        };
    return {
        current: asText(raw?.current),
        currentFrom: asText(raw?.currentFrom),
        aria: asText(raw?.aria),
        menuOpen: raw?.menuOpen === true,
        menuItems: asNumber(raw?.menuItems),
        ...(trigger === undefined || trigger.w < 4 ? {} : { trigger }),
    };
}
/**
 * 只读地读出会话当前选中的模型（CDP 会话走 DOM 触发器）。
 * 非 CDP 会话没有页面求值，调用方应先判断 `session.evaluate`。
 */
export async function currentModelOf(session) {
    return (await readModelState(session)).current;
}
export async function listModelOptions(session) {
    const raw = asRecord(await session.evaluate(listModelOptionsSnippet()));
    const toList = (value) => (Array.isArray(value) ? value : []).map(toCandidate).filter((entry) => entry !== undefined);
    return { candidates: toList(raw?.candidates), parents: toList(raw?.parents) };
}
/**
 * 换模型：真实鼠标点开选择器 → 直接找目标项 → 找不到就逐个父行 hover 出子菜单再找 → 点中 → 读回。
 * 全过程不往页面里派发任何合成事件（那会把 ZCode 的求值卡死）。
 */
export async function switchModel(session, wanted) {
    const state = await readModelState(session);
    const before = state.current;
    if (session.mouse === undefined) {
        return { ok: false, before, picked: '', after: before, via: 'none', detail: 'this session cannot dispatch real mouse input (not a CDP session)' };
    }
    // 注意：必须用 `session.mouse(...)` 这种属性调用形式，方法内部要用 `this.connection`
    // （把方法摘出来当裸函数调用会丢 this）。
    const mouse = async (action, x, y) => await session.mouse(action, x, y);
    if (modelMatches(before, wanted)) {
        return { ok: true, before, picked: before, after: before, via: 'already' };
    }
    if (state.trigger === undefined) {
        return {
            ok: false, before, picked: '', after: before, via: 'none',
            detail: 'no model trigger is visible (looked for #model-btn, [data-testid="chat-model-select-trigger"], [class*=model-selector], [class*=model-list-selector])',
        };
    }
    const clickTrigger = async () => {
        const trigger = state.trigger;
        await mouse('click', trigger.x + trigger.w / 2, trigger.y + trigger.h / 2);
    };
    let openedByUs = false;
    if (!state.menuOpen) {
        await clickTrigger();
        openedByUs = true;
        await sleep(900);
    }
    let listed = await listModelOptions(session);
    let hit = bestModelCandidate(listed.candidates, wanted);
    let via = 'direct';
    if (hit === undefined && !openedByUs) {
        // 菜单其实没开着：补一次打开再找
        await clickTrigger();
        await sleep(900);
        listed = await listModelOptions(session);
        hit = bestModelCandidate(listed.candidates, wanted);
    }
    const tried = [];
    if (hit === undefined) {
        const deadline = Date.now() + MODEL_SUBMENU_BUDGET_MS;
        for (const parent of listed.parents.slice(0, MODEL_PARENT_ROWS)) {
            if (Date.now() >= deadline)
                break;
            const label = parent.label.length > 0 ? parent.label : `row@${parent.x},${parent.y}`;
            tried.push(label);
            await mouse('move', parent.x, parent.y);
            await sleep(700);
            const opened = await listModelOptions(session);
            const found = bestModelCandidate(opened.candidates, wanted);
            if (found !== undefined) {
                hit = found;
                via = `submenu:${label}`;
                break;
            }
        }
    }
    if (hit === undefined) {
        const sample = listed.candidates.slice(0, 12).map(entry => entry.text || entry.model || entry.testid).filter(entry => entry.length > 0);
        return {
            ok: false, before, picked: '', after: before, via: 'none',
            detail: `no visible option matched "${wanted}" (saw ${listed.candidates.length} option(s)${sample.length > 0 ? `: ${sample.join(' | ')}` : ''}; `
                + `submenu rows tried: ${tried.length > 0 ? tried.join(' | ') : 'none'})`,
        };
    }
    const picked = hit.text.length > 0 ? hit.text : (hit.model.length > 0 ? hit.model : hit.testid);
    await mouse('click', hit.x, hit.y);
    await sleep(600);
    const after = (await readModelState(session)).current;
    const ok = modelMatches(after, wanted);
    return {
        ok,
        before,
        picked,
        after,
        via,
        ...(ok ? {} : { detail: `clicked "${picked}" (${via}) but the trigger now reads "${after}"` }),
    };
}
/** 没有真实鼠标的会话（理论上只剩非 CDP 通道）：保留原来的页面内合成事件路径。 */
export async function switchModelInPage(session, wanted) {
    const notes = ['model switch via=evaluate (this session has no real CDP mouse)'];
    const before = await session.evaluate(countModelOptionsSnippet());
    const alreadyOpen = Number(before.count ?? 0) > 0;
    if (alreadyOpen) {
        notes.push(`model picker already open (${before.count} options)`);
    }
    else {
        const opened = await session.evaluate(openModelPickerSnippet());
        notes.push(`model picker: ${JSON.stringify(opened).slice(0, 200)}`);
        await sleep(800);
    }
    const picked = await session.evaluate(pickModelOptionSnippet(wanted));
    notes.push(`model select "${wanted}": ${JSON.stringify(picked).slice(0, 400)}`);
    await sleep(600);
    // 家族行被点开后，档位/速度芯片是后续渲染出来的：再补一次精确点击。
    if (picked.via === 'family') {
        const level = (wanted.match(/\b(high|medium|low|minimal)\b/i) ?? [])[1];
        const speed = (wanted.match(/\b(fast|thinking)\b/i) ?? [])[1];
        for (const word of [level, speed]) {
            if (word === undefined)
                continue;
            await sleep(500);
            const chip = await session.evaluate(clickChipSnippet(word));
            notes.push(`chip "${word}": ${JSON.stringify(chip).slice(0, 160)}`);
        }
        await sleep(500);
    }
    return notes.join(' | ');
}
