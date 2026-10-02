/**
 * cdp 通道：用 Chrome DevTools Protocol 直接读写 Electron harness 的真实 DOM。
 *
 * 为什么需要它：ZCode / 小米 MiMo / Cursor 这类桌面端把界面渲染在 Chromium 里，
 * 它们的 UI Automation 树几乎是空的（只有一个 `Chrome Legacy Window` 面板，没有任何
 * DOM 文本），无障碍读屏拿不到一句对话。给这些应用加上
 * `--remote-debugging-port=<n>` 之后，就能用 CDP 拿到真正的 DOM（`innerText`）并用
 * `Input.*` 注入文本 / 回车 —— 不截图、不 OCR、不按像素点击。
 *
 * 四条硬约束：
 *   1. 只有 `dispatchCdp` 承诺「永不 reject」，其余函数会抛错，由上层折叠成 stopReason。
 *   2. Electron 绝大多数是单实例：目标已经在跑但没有调试端口时，再启动一次只会把已有
 *      窗口拉到前台，CDP 永远不会起来。这种情况必须明确报错（honest failure），
 *      绝不悄悄退回像素点击。
 *   3. 只操作我们自己的调试连接：不关闭、不干扰用户已经开着的任何窗口。
 *   4. 本机 node_modules 里没有 `@types/ws`，`import WebSocket from 'ws'` 在 --strict 下会
 *      报 TS7016，所以这里用 createRequire 取 CJS 版 ws，并只声明真正用到的那一小块接口。
 */
import { createRequire } from 'node:module'
import { get } from 'node:http'
import { createConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { buildArgv, probeCommand } from '../launcher.js'
import { killTree } from './headless.js'
import type { CdpSpec, DispatchOutcome, DispatchSpec, ReadResult, TargetConfig } from '../types.js'

// ───────────────────────────── ws 的最小结构化类型 ─────────────────────────────

interface WsSocket {
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number, reason: unknown) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
}

interface WsConstructor {
  new (url: string, options?: Record<string, unknown>): WsSocket
}

const wsRequire = createRequire(import.meta.url)
const WebSocketCtor: WsConstructor = (wsRequire('ws') as { WebSocket: WsConstructor }).WebSocket

// ───────────────────────────────── 公开契约 ─────────────────────────────────

export interface CdpTargetInfo {
  id: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export interface CdpSession {
  readonly target: string
  readonly port: number
  readonly pageId: string
  /** 读对话 / 可见正文。 */
  read(options: { limit: number }): Promise<ReadResult>
  /** 往 harness 输入框插入文本，可选提交。 */
  send(input: { text: string; submit?: boolean }): Promise<{ note: string }>
  /** 逃生舱：在页面里求值一个表达式，返回 JSON 化后的值。 */
  evaluate(expression: string): Promise<unknown>
  /** Real CDP mouse input (synthetic DOM events hang some pages, e.g. ZCode). */
  mouse(action: 'click' | 'move', x: number, y: number): Promise<void>
  close(): Promise<void>
}

// ───────────────────────────────── 常量 ─────────────────────────────────

const MARKER_ATTRIBUTE = 'data-dsh-pilot'
/** 读屏上限：真正的正文裁剪由上层（maxReplyChars）负责。 */
const READ_LIMIT = 200_000
const READ_ATTEMPTS = 5
const READ_RETRY_MS = 400
/** 提交后的轮询间隔（要求 ~800ms）。 */
const POLL_MS = 800
const DISCOVERY_TIMEOUT_MS = 1500
/** 端点已起来、但还没有一个匹配应用主窗口的 page 时，最多再等这么久（辅助页先出现的竞态）。 */
const MATCH_GRACE_MS = 8000
const PORT_SCAN_LIMIT = 20

// ───────────────────────────────── 小工具 ─────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function truncate(text: string, limit: number): string {
  if (limit > 0 && text.length > limit) return text.slice(0, limit)
  return text
}

function rawToText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

/** 从一整段文本里取一小片「一定应该出现在输入框里」的片段，用于插入校验。 */
function verifyFragment(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  const last = lines.length > 0 ? lines[lines.length - 1]! : text.trim()
  return last.slice(-40)
}

/** 目标进程映像名（Windows 下必须是 xxx.exe 才好在 tasklist 里过滤）。 */
function processImageName(target: TargetConfig): string {
  const configured = target.window.process.trim()
  if (configured.length > 0) {
    if (process.platform === 'win32' && !/\.exe$/i.test(configured)) return `${configured}.exe`
    return configured
  }
  const command = target.command.trim()
  if (command.length === 0) return ''
  const base = basename(command)
  if (/\.exe$/i.test(base)) return base
  return process.platform === 'win32' ? `${base}.exe` : base
}

/** 该映像名是否正在运行（只读查询，不做任何干预）。 */
function processRunning(image: string): { running: boolean; pids: number[]; detail: string } {
  if (image.length === 0) return { running: false, pids: [], detail: 'no process image configured' }
  try {
    if (process.platform === 'win32') {
      const probe = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      })
      const pids: number[] = []
      for (const line of `${probe.stdout ?? ''}`.split(/\r?\n/)) {
        const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
        if (match === null) continue
        if (match[1]!.toLowerCase() === image.toLowerCase()) pids.push(Number(match[2]))
      }
      return { running: pids.length > 0, pids, detail: `tasklist IMAGENAME eq ${image}` }
    }
    const probe = spawnSync('pgrep', ['-f', image], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const pids = `${probe.stdout ?? ''}`
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(pid => Number.isFinite(pid) && pid > 0)
    return { running: pids.length > 0, pids, detail: `pgrep -f ${image}` }
  } catch (error) {
    return { running: false, pids: [], detail: `process probe failed: ${messageOf(error)}` }
  }
}

/** TCP 连一下，判断端口是否已被占用（不区分占用者是不是 CDP）。 */
function portTaken(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (taken: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // 已经关了
      }
      resolve(taken)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}

// ───────────────────────────── HTTP 发现（/json/list） ─────────────────────────────

function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status} from ${url}`))
          return
        }
        const body = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(JSON.parse(body) as unknown)
        } catch (error) {
          reject(new Error(`${url} did not answer with JSON (${messageOf(error)})`))
        }
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`no answer within ${timeoutMs}ms`))
    })
    request.on('error', (error: Error) => {
      reject(error)
    })
  })
}

/** 把 `/json/list` 的原始返回挑成「能附着的 page 目标」。 */
function toTargetInfos(raw: unknown): { targets: CdpTargetInfo[]; entries: number } {
  const list = Array.isArray(raw)
    ? raw
    : (isRecord(raw) && Array.isArray(raw.list) ? raw.list : [])
  const targets: CdpTargetInfo[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const type = typeof entry.type === 'string' ? entry.type : ''
    const wsUrl = typeof entry.webSocketDebuggerUrl === 'string' ? entry.webSocketDebuggerUrl : ''
    if (type !== 'page' || wsUrl.length === 0) continue
    targets.push({
      id: typeof entry.id === 'string' ? entry.id : '',
      title: typeof entry.title === 'string' ? entry.title : '',
      url: typeof entry.url === 'string' ? entry.url : '',
      webSocketDebuggerUrl: wsUrl,
    })
  }
  return { targets, entries: list.length }
}

/** 便宜的探测：这个端口上是不是已经有一个 CDP 端点在监听？永不抛错。 */
export async function probeCdp(port: number): Promise<{ ok: boolean; targets?: CdpTargetInfo[]; detail?: string }> {
  if (!Number.isFinite(port) || port <= 0) return { ok: false, detail: `invalid port ${String(port)}` }
  const failures: string[] = []
  for (const url of [`http://127.0.0.1:${port}/json/list`, `http://127.0.0.1:${port}/json`]) {
    try {
      const raw = await httpGetJson(url, DISCOVERY_TIMEOUT_MS)
      const { targets, entries } = toTargetInfos(raw)
      if (targets.length === 0) {
        failures.push(`${url}: ${entries} target(s), none of them an attachable page`)
        continue
      }
      return { ok: true, targets }
    } catch (error) {
      failures.push(`${url}: ${messageOf(error)}`)
    }
  }
  return { ok: false, detail: failures.join(' | ') }
}

// ───────────────────────────── CDP 连接（请求/响应相关器） ─────────────────────────────

interface PendingRequest {
  readonly method: string
  readonly timer: NodeJS.Timeout
  resolve(value: unknown): void
  reject(error: Error): void
}

interface EvaluateReply {
  result?: { type?: string; value?: unknown; description?: string; subtype?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

class CdpConnection {
  private readonly socket: WsSocket
  private readonly timeoutMs: number
  private readonly pending = new Map<number, PendingRequest>()
  private sequence = 0
  private closed = false
  private closeReason = ''

  constructor(socket: WsSocket, timeoutMs: number) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    socket.on('message', (data: unknown) => {
      this.onMessage(rawToText(data))
    })
    socket.on('close', (code: number) => {
      this.fail(`CDP websocket closed (code ${String(code)})`)
    })
    socket.on('error', (error: Error) => {
      this.fail(`CDP websocket error: ${error.message}`)
    })
  }

  static connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise<CdpConnection>((resolve, reject) => {
      let socket: WsSocket
      try {
        socket = new WebSocketCtor(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
      } catch (error) {
        reject(new Error(`cannot open CDP websocket (${url}): ${messageOf(error)}`))
        return
      }
      const timer = setTimeout(() => {
        try {
          socket.terminate()
        } catch {
          // 已经关了
        }
        reject(new Error(`CDP websocket did not open within ${timeoutMs}ms (${url})`))
      }, Math.max(1000, timeoutMs))
      socket.on('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket, timeoutMs))
      })
      socket.on('error', (error: Error) => {
        clearTimeout(timer)
        reject(new Error(`CDP websocket error while connecting (${url}): ${error.message}`))
      })
      socket.on('close', () => {
        clearTimeout(timer)
        reject(new Error(`CDP websocket closed before it opened (${url})`))
      })
    })
  }

  private onMessage(text: string): void {
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (typeof message.id !== 'number') return // 事件通知：本模块不订阅事件，直接忽略
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) {
      const detail = typeof message.error.message === 'string' ? message.error.message : 'unknown CDP error'
      entry.reject(new Error(`${entry.method} failed: ${detail}`))
      return
    }
    entry.resolve(message.result)
  }

  /** socket 断了 / 出错：把所有在飞的请求都拒掉，不留悬挂的 Promise。 */
  private fail(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error(`${reason} while waiting for ${entry.method}`))
    }
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(this.closeReason.length > 0 ? this.closeReason : 'CDP connection is already closed'))
    }
    const wait = Math.max(250, timeoutMs ?? this.timeoutMs)
    const id = ++this.sequence
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${wait}ms`))
      }, wait)
      this.pending.set(id, { method, timer, resolve, reject })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`cannot send ${method}: ${messageOf(error)}`))
      }
    })
  }

  /** Runtime.evaluate + returnByValue；页面抛异常时把异常文本抛出来。 */
  async evaluate(expression: string, timeoutMs?: number): Promise<unknown> {
    const reply = await this.request('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs)
    const typed = (reply ?? {}) as EvaluateReply
    if (typed.exceptionDetails !== undefined) {
      const detail = typed.exceptionDetails.exception?.description ?? typed.exceptionDetails.text ?? 'unknown JS exception'
      throw new Error(`page threw while evaluating: ${detail.slice(0, 500)}`)
    }
    return typed.result?.value
  }

  close(): void {
    if (this.closed) return
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error('CDP connection closed by caller'))
    }
    this.closed = true
    this.closeReason = 'CDP connection closed by caller'
    try {
      this.socket.close(1000, 'dsh-pilot closing')
    } catch {
      try {
        this.socket.terminate()
      } catch {
        // 已经关了
      }
    }
  }
}

// ───────────────────────────── 页面内注入的表达式 ─────────────────────────────

function readExpression(transcriptSelector: string): string {
  return `(function () {
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, IFRAME: 1, SVG: 1, CANVAS: 1 };
  var BLOCK = { DIV: 1, P: 1, LI: 1, TR: 1, TD: 1, TH: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, MAIN: 1, PRE: 1, BLOCKQUOTE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BR: 1, UL: 1, OL: 1, TABLE: 1 };
  // innerText 需要布局；Electron 窗口未真正合成时它可能是空的，这时退回到
  // 纯文本节点遍历（跳过 script/style 等，避免把代码当正文）。不用 textContent：
  // 它会把 <script>/<style> 的内容也算进来。
  function collectText(el, out) {
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 3) {
        var value = String(child.nodeValue || '').trim();
        if (value.length > 0) out.push(value);
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = String(child.tagName || '').toUpperCase();
      if (SKIP[tag] === 1) continue;
      if (BLOCK[tag] === 1 && out.length > 0) out.push('\\n');
      collectText(child, out);
    }
  }
  var sel = ${JSON.stringify(transcriptSelector)};
  var el = null;
  var selError = '';
  if (sel.length > 0) {
    try { el = document.querySelector(sel); }
    catch (e) { selError = String((e && e.message) || e); }
  }
  var node = el !== null ? el : document.body;
  var text = '';
  var textSource = 'empty';
  if (node !== null && node !== undefined) {
    if (typeof node.innerText === 'string' && node.innerText.trim().length > 0) {
      text = node.innerText;
      textSource = 'innerText';
    } else if (typeof node.innerText !== 'string' || node.innerText.trim().length === 0) {
      var parts = [];
      collectText(node, parts);
      var joined = parts.join(' ').replace(/[ \\t\\r]+/g, ' ').replace(/ ?\\n ?/g, '\\n').replace(/\\n{2,}/g, '\\n').trim();
      if (joined.length > 0) {
        text = joined;
        textSource = 'text-nodes';
      }
    }
  }
  return {
    text: String(text),
    textSource: textSource,
    ready: String(document.readyState || ''),
    missing: sel.length > 0 && el === null,
    selector: sel,
    selError: selError,
    url: String(location.href || ''),
    title: String(document.title || '')
  };
})()`
}

/**
 * 输入框定位：优先复用上次标记的元素（跨调用确定性），其次显式选择器，
 * 最后是页面内启发式（视口下半部分 + 面积最大的可见 textarea / contenteditable / 文本输入框）。
 */
function locateInputExpression(inputSelector: string): string {
  return `(function () {
  var MARK = ${JSON.stringify(MARKER_ATTRIBUTE)};
  var configured = ${JSON.stringify(inputSelector)};
  function rect(el) { try { return el.getBoundingClientRect(); } catch (e) { return null; } }
  function visible(el) {
    if (el === null || el === undefined) return false;
    if (el.disabled === true || el.readOnly === true) return false;
    if (el.hidden === true) return false;
    try { if (el.getAttribute('aria-disabled') === 'true') return false; } catch (e) {}
    var r = rect(el);
    if (r === null || r.width < 6 || r.height < 6) return false;
    var style = window.getComputedStyle(el);
    if (style === null) return true;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }
  function usable(el) {
    if (el === null || el === undefined) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable === true) return true;
    if (tag === 'INPUT') {
      var type = String(el.type || 'text').toLowerCase();
      return type === 'text' || type === 'search' || type === 'url' || type === 'email';
    }
    return false;
  }
  function mark(el) { try { el.setAttribute(MARK, '1'); } catch (e) {} }
  function describe(el, how) {
    var r = rect(el);
    var raw = (typeof el.value === 'string') ? el.value : String(el.innerText || el.textContent || '');
    return {
      ok: true,
      how: how,
      tag: String(el.tagName || '').toUpperCase(),
      id: String(el.id || ''),
      cls: String(el.className || '').slice(0, 60),
      contentEditable: el.isContentEditable === true,
      rect: r === null ? null : { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      existingChars: raw.length
    };
  }

  var marked = null;
  try { marked = document.querySelector('[' + MARK + '="1"]'); } catch (e) {}
  if (marked !== null && visible(marked) && usable(marked)) {
    mark(marked);
    try { marked.focus(); } catch (e) {}
    return describe(marked, 'marker');
  }

  if (configured.length > 0) {
    var explicit = null;
    try { explicit = document.querySelector(configured); }
    catch (e) { return { ok: false, how: 'selector', error: 'invalid inputSelector: ' + String((e && e.message) || e) }; }
    if (explicit !== null && visible(explicit)) {
      mark(explicit);
      try { explicit.focus(); } catch (e) {}
      return describe(explicit, 'selector');
    }
  }

  var nodes = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], input');
  var all = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (usable(el) && visible(el)) all.push(el);
  }
  if (all.length === 0) {
    return { ok: false, how: 'heuristic', error: 'no visible textarea / contenteditable / text input found' };
  }
  var lower = [];
  for (var j = 0; j < all.length; j++) {
    var rj = rect(all[j]);
    if (rj !== null && rj.top + rj.height / 2 >= window.innerHeight / 2) lower.push(all[j]);
  }
  var pool = lower.length > 0 ? lower : all;
  var best = pool[0];
  var bestScore = -1;
  for (var k = 0; k < pool.length; k++) {
    var rk = rect(pool[k]);
    var score = rk === null ? 0 : rk.width * rk.height;
    if (pool[k].isContentEditable === true) score += 2000;
    if (score > bestScore) { bestScore = score; best = pool[k]; }
  }
  mark(best);
  try { best.focus(); } catch (e) {}
  var how = lower.length > 0 ? 'heuristic-lower-half' : 'heuristic-any-visible';
  var info = describe(best, how);
  info.candidates = all.length;
  return info;
})()`
}

function markeredValueExpression(): string {
  return `(function () {
  var el = document.querySelector('[${MARKER_ATTRIBUTE}="1"]');
  if (el === null || el === undefined) return null;
  if (typeof el.value === 'string') return el.value;
  return String(el.innerText || el.textContent || '');
})()`
}

/** 回退方案：直接改 value/textContent 再派发 input + change（React 受控组件需要原生 setter）。 */
function fallbackInsertExpression(text: string): string {
  return `(function () {
  var el = document.querySelector('[${MARKER_ATTRIBUTE}="1"]');
  if (el === null || el === undefined) return { ok: false, error: 'the marked input element disappeared' };
  var text = ${JSON.stringify(text)};
  var tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, text);
    else el.value = text;
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`
}

function clickExpression(selector: string): string {
  return `(function () {
  try {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return 'missing';
    if (el.disabled === true) return 'disabled';
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return 'notclickable';
    el.click();
    return 'clicked';
  } catch (e) { return 'error:' + String((e && e.message) || e); }
})()`
}

function busyExpression(selector: string): string {
  return `(function () {
  try {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var style = window.getComputedStyle(el);
    if (style === null) return true;
    return !(style.visibility === 'hidden' || style.display === 'none');
  } catch (e) { return false; }
})()`
}

// ───────────────────────────── 会话实现 ─────────────────────────────

interface PageSnapshot {
  readonly text: string
  readonly ready: string
  readonly note: string
}

class CdpPageSession implements CdpSession {
  readonly target: string
  readonly port: number
  readonly pageId: string
  private readonly connection: CdpConnection
  private readonly cdp: CdpSpec
  private readonly requestTimeoutMs: number

  constructor(connection: CdpConnection, target: TargetConfig, port: number, pageId: string, requestTimeoutMs: number) {
    this.connection = connection
    this.target = target.name
    this.port = port
    this.pageId = pageId
    this.cdp = target.cdp
    this.requestTimeoutMs = requestTimeoutMs
  }

  private label(): string {
    return `cdp '${this.target}' @127.0.0.1:${this.port}`
  }

  async evaluate(expression: string): Promise<unknown> {
    return await this.connection.evaluate(expression, this.requestTimeoutMs)
  }

  /**
   * 真实鼠标：`Input.dispatchMouseEvent`。
   *
   * 为什么不用页面里的合成事件：ZCode 的菜单挂在真实 pointerdown 上，`el.click()` 打不开它；
   * 而在 `Runtime.evaluate` 里 `dispatchEvent(new PointerEvent(...))` 会把这次求值卡死
   * （实测 20s 超时）。浏览器侧的 `Input.*` 走的是真正的输入管线，两个问题都没有。
   */
  async mouse(action: 'click' | 'move', x: number, y: number): Promise<void> {
    const px = Math.round(x)
    const py = Math.round(y)
    const unfroze = await this.bringToFront()
    // 刚把 hidden 页面唤醒时，卡住的弹层要等退出动画（~100ms）跑完才卸载；
    // 立刻点击会落在它身上，所以先让出一小段时间。
    if (unfroze) await sleep(300)
    const send = async (type: string, extra: Record<string, unknown>): Promise<void> => {
      await this.connection.request('Input.dispatchMouseEvent', { type, x: px, y: py, ...extra }, this.requestTimeoutMs)
    }
    await send('mouseMoved', { button: 'none', buttons: 0 })
    if (action === 'move') return
    await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 })
    await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 })
  }

  private async snapshot(): Promise<PageSnapshot> {
    const value = await this.connection.evaluate(readExpression(this.cdp.transcriptSelector.trim()), this.requestTimeoutMs)
    if (!isRecord(value)) throw new Error('read expression returned an unexpected value')
    const text = typeof value.text === 'string' ? value.text : ''
    const ready = typeof value.ready === 'string' ? value.ready : ''
    const notes: string[] = []
    if (value.missing === true) notes.push(`transcriptSelector ${this.cdp.transcriptSelector.trim()} matched nothing`)
    if (typeof value.selError === 'string' && value.selError.length > 0) notes.push(`transcriptSelector is invalid CSS: ${value.selError}`)
    if (value.textSource === 'text-nodes') notes.push('innerText was empty (window not composited), read text nodes instead')
    return { text, ready, note: notes.join('; ') }
  }

  /** 页面加载中 / 空白时重试几次；最终仍为空就如实带诊断返回。 */
  async read(options: { limit: number }): Promise<ReadResult> {
    let lastReady = ''
    let lastNote = ''
    let lastText = ''
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      let snapshot: PageSnapshot
      try {
        snapshot = await this.snapshot()
      } catch (error) {
        return { text: '', source: 'cdp', diagnostic: `${this.label()} read failed: ${messageOf(error)}` }
      }
      lastText = snapshot.text
      lastReady = snapshot.ready
      lastNote = snapshot.note
      if (snapshot.text.trim().length > 0 && snapshot.ready !== 'loading') {
        return {
          text: truncate(snapshot.text, options.limit),
          source: 'cdp',
          ...(snapshot.note.length > 0 ? { diagnostic: snapshot.note } : {}),
        }
      }
      if (attempt < READ_ATTEMPTS) await sleep(READ_RETRY_MS)
    }
    const details = [`page text is still empty after ${READ_ATTEMPTS} attempts (readyState=${lastReady.length > 0 ? lastReady : 'unknown'})`]
    if (lastNote.length > 0) details.push(lastNote)
    return { text: truncate(lastText, options.limit), source: 'cdp', diagnostic: details.join('; ') }
  }

  /**
   * 尽力让页面成为前台目标（headless / 后台标签页下 Input.* 需要它）。
   * 返回 true 表示这次把 hidden 的页面唤醒了（调用方需要让动画跑一拍）。
   */
  private async bringToFront(): Promise<boolean> {
    try {
      await this.connection.request('Page.bringToFront', {}, 3000)
    } catch {
      // 不是所有 target 都支持，忽略
    }
    // 窗口被隐藏 / 最小化时 `document.visibilityState` 是 "hidden"：Chromium 会冻结 CSS 动画，
    // 于是「等退出动画跑完再卸载」的弹层（Radix Dialog / DropdownMenu）永远留在 DOM 里 ——
    // 实测 ZCode 的对话遮罩就是这样把整个视口盖住（body 还被 ScrollLock 设成
    // `pointer-events: none`），所有真实鼠标点击都被它吞掉、页面看上去点了没反应。
    // 打开焦点模拟能让页面恢复 visible，动画跑完、遮罩自行卸载。只对 hidden 的页面做。
    try {
      const hidden = await this.connection.evaluate('document.visibilityState === "hidden"', 3000)
      if (hidden !== true) return false
      await this.connection.request('Emulation.setFocusEmulationEnabled', { enabled: true }, 3000)
      return true
    } catch {
      // 老版本 Electron 没有这个域，忽略
      return false
    }
  }

  private async locateInput(): Promise<{ ok: boolean; detail: string }> {
    let value: unknown
    try {
      value = await this.connection.evaluate(locateInputExpression(this.cdp.inputSelector.trim()), this.requestTimeoutMs)
    } catch (error) {
      return { ok: false, detail: `input lookup failed: ${messageOf(error)}` }
    }
    if (!isRecord(value) || value.ok !== true) {
      const error = isRecord(value) && typeof value.error === 'string' ? value.error : 'unknown reason'
      const how = isRecord(value) && typeof value.how === 'string' ? value.how : 'heuristic'
      return { ok: false, detail: `${how}: ${error}` }
    }
    const tag = typeof value.tag === 'string' ? value.tag : '?'
    const how = typeof value.how === 'string' ? value.how : '?'
    const rect = isRecord(value.rect)
      ? ` @${String(value.rect.x)},${String(value.rect.y)} ${String(value.rect.w)}x${String(value.rect.h)}`
      : ''
    const existing = typeof value.existingChars === 'number' ? value.existingChars : 0
    return { ok: true, detail: `${how} -> <${tag}${typeof value.id === 'string' && value.id.length > 0 ? ` #${value.id}` : ''}>${rect} (${existing} chars before)` }
  }

  private async readMarkedValue(): Promise<string | null> {
    const value = await this.connection.evaluate(markeredValueExpression(), this.requestTimeoutMs)
    return typeof value === 'string' ? value : null
  }

  private async verifyInsertion(text: string): Promise<boolean> {
    const fragment = verifyFragment(text)
    if (fragment.length === 0) return true
    try {
      const value = await this.readMarkedValue()
      return value !== null && value.includes(fragment)
    } catch {
      return false
    }
  }

  /** 忠实插入：先 Input.insertText，不生效再退回 value/textContent + input/change。 */
  private async insertText(text: string): Promise<{ note: string }> {
    let transportError = ''
    try {
      await this.connection.request('Input.insertText', { text }, this.requestTimeoutMs)
    } catch (error) {
      transportError = messageOf(error)
    }
    if (transportError.length === 0 && await this.verifyInsertion(text)) {
      return { note: 'inserted with Input.insertText' }
    }
    try {
      await this.connection.evaluate(fallbackInsertExpression(text), this.requestTimeoutMs)
    } catch (error) {
      throw new Error(`${this.label()} could not insert text (Input.insertText: ${transportError.length > 0 ? transportError : 'had no effect'}; fallback: ${messageOf(error)})`)
    }
    const verified = await this.verifyInsertion(text)
    if (verified) return { note: 'inserted with value+input/change fallback (Input.insertText had no effect)' }
    return { note: `inserted with the fallback but could not verify the text landed (Input.insertText: ${transportError.length > 0 ? transportError : 'had no effect'})` }
  }

  /** 真回车：keydown + keypress(char) + keyup，windowsVirtualKeyCode=13。 */
  private async dispatchEnter(): Promise<string> {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.connection.request('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, this.requestTimeoutMs)
    await this.connection.request('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...base }, this.requestTimeoutMs)
    await this.connection.request('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.requestTimeoutMs)
    return 'keydown+keypress+keyup Enter (windowsVirtualKeyCode=13)'
  }

  private async submit(): Promise<string> {
    const selector = this.cdp.sendSelector.trim()
    if (selector.length > 0) {
      let outcome = 'error:unknown'
      try {
        const value = await this.connection.evaluate(clickExpression(selector), this.requestTimeoutMs)
        outcome = typeof value === 'string' ? value : 'error:non-string reply'
      } catch (error) {
        outcome = `error:${messageOf(error)}`
      }
      if (outcome === 'clicked') return `submitted by clicking sendSelector ${selector}`
      // 选择器失效时退回回车，并把原因写进 note（不静默）
      try {
        const keys = await this.dispatchEnter()
        return `sendSelector ${selector} was ${outcome}; fell back to ${keys}`
      } catch (error) {
        return `submit-failed: sendSelector ${selector} was ${outcome} and Enter failed: ${messageOf(error)}`
      }
    }
    try {
      const keys = await this.dispatchEnter()
      return `submitted with ${keys}`
    } catch (error) {
      return `submit-failed: Enter could not be dispatched: ${messageOf(error)}`
    }
  }

  async send(input: { text: string; submit?: boolean }): Promise<{ note: string }> {
    const text = input.text
    if (text.length === 0) throw new Error(`${this.label()} send() called with empty text`)
    await this.bringToFront()
    const located = await this.locateInput()
    if (!located.ok) throw new Error(`${this.label()} cannot find the prompt box: ${located.detail}`)
    const notes: string[] = [`input=${located.detail}`]
    const insertion = await this.insertText(text)
    notes.push(insertion.note)
    if (input.submit !== false) notes.push(await this.submit())
    return { note: notes.join('; ') }
  }

  async close(): Promise<void> {
    this.connection.close()
  }
}

// ───────────────────────────── 目标挑选 / 端口挑选 / 启动 ─────────────────────────────

interface MatchPattern {
  readonly kind: 'text' | 'regex'
  readonly value: string | RegExp
}

function matchPatterns(target: TargetConfig): MatchPattern[] {
  const patterns: MatchPattern[] = []
  const pushText = (raw: string): void => {
    const value = raw.trim().toLowerCase()
    if (value.length < 2) return
    if (patterns.some(entry => entry.kind === 'text' && entry.value === value)) return
    patterns.push({ kind: 'text', value })
  }
  const title = target.window.title.trim()
  if (title.length >= 3 && title.startsWith('/') && title.endsWith('/')) {
    try {
      patterns.push({ kind: 'regex', value: new RegExp(title.slice(1, -1), 'i') })
    } catch {
      // 非法正则忽略
    }
  } else {
    pushText(title)
  }
  pushText(target.name)
  const image = processImageName(target)
  if (image.length > 0) pushText(image.replace(/\.exe$/i, ''))
  return patterns
}

/** 单个 page 目标的匹配分：命中应用名/窗口标题/进程名 +10；devtools 与 Electron 辅助页扣分。 */
function scorePage(entry: CdpTargetInfo, patterns: readonly MatchPattern[]): number {
  const haystack = `${entry.title} ${entry.url}`.toLowerCase()
  let score = 0
  for (const pattern of patterns) {
    if (pattern.kind === 'regex') {
      if (pattern.value instanceof RegExp && pattern.value.test(haystack)) score += 10
    } else if (typeof pattern.value === 'string' && haystack.includes(pattern.value)) {
      score += 10
    }
  }
  if (/devtools|chrome-devtools/.test(haystack)) score -= 25
  // Electron 的辅助窗口（例如 .../node_modules/react-screenshots/dist/electron.html）没有正文，
  // 不该被当成会话主窗口
  if (/\/node_modules\//.test(entry.url.toLowerCase())) score -= 15
  if (entry.url.startsWith('about:blank')) score -= 5
  return score
}

/** 给一组 page 目标打分排序，挑出最像应用主窗口的那个（分数可能为负，仍会返回）。 */
function rankPages(targets: CdpTargetInfo[], target: TargetConfig): { best?: CdpTargetInfo; bestScore: number } {
  const patterns = matchPatterns(target)
  let best: CdpTargetInfo | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const entry of targets) {
    const score = scorePage(entry, patterns)
    if (score > bestScore) {
      bestScore = score
      best = entry
    }
  }
  return best === undefined ? { bestScore: 0 } : { best, bestScore }
}

function pickPage(targets: CdpTargetInfo[], target: TargetConfig): CdpTargetInfo | undefined {
  return rankPages(targets, target).best
}

async function attachSession(
  targets: CdpTargetInfo[],
  target: TargetConfig,
  port: number,
  requestTimeoutMs: number,
): Promise<CdpSession> {
  const page = pickPage(targets, target)
  if (page === undefined) {
    throw new Error(
      `CDP endpoint on 127.0.0.1:${port} exposes no attachable page target `
      + `(${targets.length} page(s) listed${targets.length > 0 ? `: ${targets.map(entry => entry.title.length > 0 ? entry.title : entry.url).join(', ')}` : ''})`,
    )
  }
  const connection = await CdpConnection.connect(page.webSocketDebuggerUrl, Math.max(3000, requestTimeoutMs))
  return new CdpPageSession(connection, target, port, page.id, requestTimeoutMs)
}

/**
 * 等端点出现，并且等一个「真的像应用主窗口」的 page。
 *
 * 为什么要等：Electron 的 CDP 端点通常在主窗口标题/URL 落定之前就起来了，那一刻
 * /json/list 里可能只有一个辅助页（实测 MiniMax Code：先只有 react-screenshots 的
 * `Rsbuild App`，随后才出现 `MiniMax Code` / `app://./archon`）。只要宽限期内出现
 * 匹配的 page 就用它，否则兜底用最后一次探测到的列表。
 */
async function waitForEndpoint(
  port: number,
  timeoutMs: number,
  target: TargetConfig,
): Promise<{ ok: boolean; targets?: CdpTargetInfo[]; detail?: string }> {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  let sawEndpointAt = 0
  let latest: CdpTargetInfo[] | undefined
  let last = 'no probe yet'
  for (;;) {
    const probe = await probeCdp(port)
    if (probe.ok && probe.targets !== undefined) {
      latest = probe.targets
      if (sawEndpointAt === 0) sawEndpointAt = Date.now()
      const ranked = rankPages(probe.targets, target)
      if (ranked.bestScore > 0) return { ok: true, targets: probe.targets }
      if (Date.now() - sawEndpointAt >= MATCH_GRACE_MS) return { ok: true, targets: probe.targets }
      last = `CDP is up on 127.0.0.1:${port} but no page target matches '${target.name}' yet (best score ${ranked.bestScore})`
    } else {
      last = probe.detail ?? 'no detail'
    }
    if (Date.now() >= deadline) {
      if (latest !== undefined) return { ok: true, targets: latest }
      return { ok: false, detail: `CDP endpoint did not appear on 127.0.0.1:${port} within ${timeoutMs}ms (last probe: ${last})` }
    }
    await sleep(400)
  }
}

/** 挑一个能真正拿来做调试端口的端口：优先 preferred，被占用就 portBase+1..+20。 */
async function pickLaunchPort(preferred: number, portBase: number): Promise<number> {
  if (!(await portTaken(preferred))) return preferred
  for (let offset = 1; offset <= PORT_SCAN_LIMIT; offset++) {
    const candidate = portBase + offset
    if (candidate === preferred) continue
    if (!(await portTaken(candidate))) return candidate
  }
  throw new Error(`every port in ${portBase}..${portBase + PORT_SCAN_LIMIT} is already taken; free one or set cdp.port explicitly`)
}

/** 把 `--remote-debugging-port=<port>` 塞进启动参数（含 `<port>` 占位符替换与硬编码端口改写）。 */
function launchArgsFor(target: TargetConfig, port: number): string[] {
  const args = target.cdp.launchArgs.map(arg => arg.replace('<port>', String(port)))
  let found = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--remote-debugging-port') {
      found = true
      if (index + 1 < args.length) args[index + 1] = String(port)
      else args.push(String(port))
      continue
    }
    if (arg.startsWith('--remote-debugging-port=')) {
      found = true
      args[index] = `--remote-debugging-port=${port}`
    }
  }
  if (!found) args.push(`--remote-debugging-port=${port}`)
  return args
}

interface SpawnResult {
  readonly pid?: number
  readonly error?: string
}

/** detached 启动：窗口正常打开，且能活过插件进程。 */
function spawnDetached(argv: string[], cwd: string | undefined, env: Record<string, string>, verbatim = false): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
        env: { ...process.env, ...env },
        stdio: 'ignore',
        detached: true,
        windowsHide: false,
        // .cmd/.bat 走 cmd.exe 时 buildArgv 已经拼好整条命令行，必须原样传递
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (error) {
      resolve({ error: messageOf(error) })
      return
    }
    child.unref()
    child.once('spawn', () => {
      if (settled) return
      settled = true
      resolve({ pid: child.pid })
    })
    child.once('error', (error: Error) => {
      if (settled) return
      settled = true
      resolve({ error: error.message })
    })
  })
}

/** Read-only readiness check using the same ownership and single-instance rules as openCdp. */
export async function probeCdpTarget(target: TargetConfig, port: number): Promise<{ available: boolean; detail: string }> {
  const endpoint = await probeCdp(port)
  if (endpoint.ok && endpoint.targets && rankPages(endpoint.targets, target).bestScore > 0) {
    return { available: true, detail: `cdp: matching debugging endpoint on port ${port}` }
  }
  const image = processImageName(target)
  const isolatedProfile = target.cdp.launchArgs.some(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
  const running = processRunning(image)
  if (running.running && !isolatedProfile) {
    return { available: false, detail: `cdp: target '${target.name}' is already running without a matching debugging endpoint (${image}, pid ${running.pids.join(', ')}); use an available window channel or restart it with --remote-debugging-port` }
  }
  const command = probeCommand(target.command)
  if (command.available) {
    return { available: true, detail: `cdp: can launch "${command.path}" with a debugging port${endpoint.ok ? '; preferred port belongs to another target' : ''}` }
  }
  return { available: false, detail: `cdp: no matching endpoint on ${port} and command not resolvable (${command.error ?? 'no command'})` }
}

// ───────────────────────────── openCdp ─────────────────────────────

/**
 * 附着到已经在跑的调试端点，或者带着调试端口把应用拉起来再附着。
 * 失败时抛错（错误消息就是给模型看的诊断）。
 */
export async function openCdp(
  target: TargetConfig,
  options: { cwd?: string; launch?: boolean; portBase: number; timeoutMs?: number },
): Promise<CdpSession> {
  const launch = options.launch !== false
  const portBase = Number.isFinite(options.portBase) && options.portBase > 0 ? Math.trunc(options.portBase) : 9333
  const requested = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? Math.trunc(options.timeoutMs!) : target.timeoutMs
  const requestTimeoutMs = Math.min(120_000, Math.max(3000, requested))
  const appearTimeoutMs = Math.max(1000, target.window.appearTimeoutMs > 0 ? target.window.appearTimeoutMs : 20_000)
  const preferred = target.cdp.port > 0 ? target.cdp.port : portBase

  // 1) 端口已经在提供 CDP：无论 launch 与否，直接附着（绝不重启用户已经开着的应用）。
  //    这里也走一次短宽限：应用刚起来时主窗口可能还没在 /json/list 里落定标题。
  const existing = await probeCdp(preferred)
  if (existing.ok && existing.targets !== undefined) {
    // 端口上有 CDP 不等于「这是我们目标的 CDP」：别的 harness 可能占着同一端口
    // （实测 MiMo AI 占了 9333，于是 Qoder CN 误附着到 MiMo 的页面上）。
    // 只有当至少一个 page 能按本目标排序得分 > 0 时才附着，否则换端口自己启动。
    const ownership = rankPages(existing.targets, target)
    if (ownership.bestScore > 0) {
      const settled = await waitForEndpoint(preferred, Math.min(appearTimeoutMs, MATCH_GRACE_MS), target)
      return await attachSession(settled.targets ?? existing.targets, target, preferred, requestTimeoutMs)
    }
  }

  const probeDetail = existing.detail !== undefined ? ` (${existing.detail})` : ''
  if (!launch) {
    throw new Error(`no CDP endpoint on 127.0.0.1:${preferred}${probeDetail} and launching was disabled`)
  }
  if (target.command.trim().length === 0) {
    throw new Error(
      `no CDP endpoint on 127.0.0.1:${preferred}${probeDetail} and target '${target.name}' has no command configured; `
      + `start it yourself with --remote-debugging-port=<port> (then it becomes attachable)`,
    )
  }

  // 2) 单实例检查：Electron 桌面端基本都是单实例，已经在跑（且没有调试端口）时再启动
  //    只会把旧窗口拉到前台，CDP 永远不会出现 —— 这里如实报错，绝不退回像素点击。
  //
  //    例外：启动参数里显式带了 `--user-data-dir=`（独立 profile）。Chromium 与 Electron
  //    的 requestSingleInstanceLock 都是按 user-data-dir 生效的，换了 profile 就是一个
  //    互不干扰的新实例（headless Chrome/Edge 正是这么和已开的浏览器并存）。这种情况
  //    再拦就是误报，所以放行；真起不来会在等待端点超时后如实报错并回收进程。
  const image = processImageName(target)
  const isolatedProfile = target.cdp.launchArgs.some(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
  const running = processRunning(image)
  if (running.running && !isolatedProfile) {
    throw new Error(
      `target '${target.name}' is already running without --remote-debugging-port (${image}, pid ${running.pids.join(', ')}); `
      + `close it and call harness_open (which relaunches with the flag), or use the window channel`,
    )
  }

  // 3) 选一个真的空闲的端口（preferred 可能被别的程序占着）
  const port = await pickLaunchPort(preferred, portBase)
  const args = launchArgsFor(target, port)
  const built = buildArgv(target.command, args)
  // .cmd/.bat shim 必须用 verbatim 形态（否则 cmd.exe 收到 \"…\" 直接报「不是内部或外部命令」）
  const argv = built.verbatim ? built.verbatimArgv : built.argv
  const cwd = (options.cwd ?? target.cwd).trim()
  const spawned = await spawnDetached(argv, cwd.length > 0 ? cwd : undefined, target.env, built.verbatim)
  if (spawned.pid === undefined) {
    throw new Error(`failed to launch ${argv[0]} for target '${target.name}': ${spawned.error ?? 'unknown spawn error'}`)
  }

  // 4) 等调试端点出现（并且等一个像样的主窗口 page）
  const ready = await waitForEndpoint(port, appearTimeoutMs, target)
  if (!ready.ok || ready.targets === undefined) {
    const alive = processRunning(image)
    killTree(spawned.pid)
    const fate = alive.running
      ? 'the launched process was still alive'
      : 'the launched process was already gone — the app is most likely single-instance and only focused an existing window'
    throw new Error(
      `${ready.detail ?? `no CDP endpoint on 127.0.0.1:${port}`}; launched ${argv[0]} ${args.join(' ')} `
      + `(pid ${String(spawned.pid)}): ${fate}; the launched process tree was terminated`,
    )
  }
  return await attachSession(ready.targets, target, port, requestTimeoutMs)
}

// ───────────────────────────── dispatchCdp ─────────────────────────────

async function isBusy(session: CdpSession, selector: string): Promise<boolean> {
  if (selector.trim().length === 0) return false
  try {
    return (await session.evaluate(busyExpression(selector.trim()))) === true
  } catch {
    return false
  }
}

/**
 * 一次性把任务交给 CDP：读快照 → 注入文本 → 回车 → 轮询文本变化并等它稳定。
 * 永不 reject：所有失败都折叠成 stopReason + diagnostic。
 */
export async function dispatchCdp(
  spec: DispatchSpec,
  options: { session?: CdpSession; launch?: boolean; portBase?: number },
): Promise<DispatchOutcome> {
  const started = Date.now()
  const portBase = options.portBase !== undefined && options.portBase > 0 ? Math.trunc(options.portBase) : 9333
  const timeoutMs = Math.max(1000, spec.timeoutMs)
  const settleMs = Math.max(300, spec.target.window.settleMs > 0 ? spec.target.window.settleMs : 1500)

  let session = options.session
  let owned = false
  try {
    if (session === undefined) {
      session = await openCdp(spec.target, {
        cwd: spec.cwd,
        launch: options.launch !== false,
        portBase,
        timeoutMs,
      })
      owned = true
    }
  } catch (error) {
    return {
      transport: 'cdp',
      text: '',
      diagnostic: `cdp attach failed: ${messageOf(error)}`,
      stopReason: 'error',
      facts: { port: spec.target.cdp.port > 0 ? spec.target.cdp.port : portBase, target: spec.target.name },
    }
  }

  const active = session
  const facts: Record<string, string | number | boolean | undefined> = {
    port: active.port,
    pageId: active.pageId,
    target: spec.target.name,
  }

  try {
    const title = await active.evaluate('document.title').catch(() => undefined)
    const targetTitle = typeof title === 'string' ? title : ''
    facts.targetTitle = targetTitle
    const where = `CDP 127.0.0.1:${active.port} target "${targetTitle}" (pageId ${active.pageId})`

    const before = await active.read({ limit: READ_LIMIT })
    const preText = before.text
    facts.preChars = preText.length

    const sent = await active.send({ text: spec.prompt, submit: true })
    const notes: string[] = [sent.note]
    if (sent.note.includes('submit-failed')) {
      facts.durationMs = Date.now() - started
      return {
        transport: 'cdp',
        text: preText,
        diagnostic: `${where} prompt was typed but never submitted: ${sent.note}`,
        stopReason: 'error',
        facts,
      }
    }

    const deadline = Date.now() + timeoutMs
    let current = ''
    let stableSince = 0
    let answer = ''
    let stopReason: DispatchOutcome['stopReason'] = 'timeout'
    let diagnosticBits: string[] = []

    for (;;) {
      if (spec.signal.aborted) {
        stopReason = 'aborted'
        diagnosticBits = ['cancelled by caller']
        break
      }
      if (Date.now() >= deadline) {
        stopReason = 'timeout'
        diagnosticBits = [`answer did not settle within ${timeoutMs}ms`]
        break
      }
      await sleep(POLL_MS)
      if (spec.signal.aborted) {
        stopReason = 'aborted'
        diagnosticBits = ['cancelled by caller']
        break
      }
      let snapshot: ReadResult
      try {
        snapshot = await active.read({ limit: READ_LIMIT })
      } catch (error) {
        stopReason = 'error'
        diagnosticBits = [`read failed while waiting for the answer: ${messageOf(error)}`]
        break
      }
      const text = snapshot.text
      spec.onProgress?.(text)
      if (text !== current) {
        current = text
        stableSince = Date.now()
      }
      const busy = await isBusy(active, spec.target.cdp.busySelector)
      const changed = text !== preText && text.trim().length > 0
      if (changed && !busy && stableSince > 0 && Date.now() - stableSince >= settleMs) {
        answer = text
        stopReason = 'completed'
        break
      }
    }

    facts.settleMs = settleMs
    facts.durationMs = Date.now() - started
    facts.answerChars = answer.length > 0 ? answer.length : current.length
    const details = [where, ...notes, ...diagnosticBits]
    return {
      transport: 'cdp',
      text: answer.length > 0 ? answer : current,
      diagnostic: details.join('; '),
      stopReason,
      facts,
    }
  } catch (error) {
    facts.durationMs = Date.now() - started
    return {
      transport: 'cdp',
      text: '',
      diagnostic: `cdp dispatch failed on 127.0.0.1:${active.port} (target '${spec.target.name}'): ${messageOf(error)}`,
      stopReason: 'error',
      facts,
    }
  } finally {
    // 只关我们自己开的连接；应用本身继续活着（detached）。
    if (owned) {
      try {
        await active.close()
      } catch {
        // 关不上就算了，不能影响结果
      }
    }
  }
}
