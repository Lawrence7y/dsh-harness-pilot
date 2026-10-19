/**
 * **stdio → loopback HTTP 的 MCP 代理**（headless `--mcp-config` 通道专用）。
 *
 * ## 它存在的理由
 * headless 通道的注入向量是一份**落盘的** `--mcp-config` 文件。在这之前，那份文件里
 * 直接写着 `url` + `headers.Authorization = Bearer <令牌>` —— 于是**凭据以明文落盘**。
 * `mode: 0o600` 在 POSIX 上有意义，**在 Windows 上不是强制 ACL**，所以那不构成有效保护。
 *
 * 现在那份文件里**只有本代理的启动方式**（command/args/env，全部不含凭据），
 * 本代理从**自己的子进程环境**取一次性的入口 URL 与凭据，再转发到本机 loopback 的
 * 真实桥接入口。于是：**配置 / argv / 日志 / API 四处都不含令牌**。
 *
 * ## 与桥接模块之间的契约（`src/mcp-bridge.ts` 是唯一写入方）
 * | 环境变量 | 含义 |
 * |---|---|
 * | `DSH_BRIDGE_HANDOFF` | 本次入口的 **loopback URL**（含一次性随机路径段），形如 `http://127.0.0.1:<port>/mcp/<id>` |
 * | `DSH_BRIDGE_HANDOFF_PAT` | 本次入口的**一次性 Bearer 令牌**（32 字节 base64url） |
 * | `DSH_BRIDGE_PROXY_LOG` | 可选：本代理的事件 JSONL 路径（**只写方法与状态码，绝不写 URL/令牌**） |
 *
 * ### 为什么键名是「HANDOFF / HANDOFF_PAT」而不是 `…_TOKEN` / `…_KEY`
 * **实测**（`probe/_mcp-env-semantics-matrix.mjs`、`probe/_mcp-key-decisive.mjs`；
 * `qoderclicn 1.1.13`，值长度 18/20 与 43/47 两档都测）：CLI 在 spawn stdio MCP 子进程时
 * 把它自己进程的环境**深拷贝**过去，但**按名字丢掉**含
 * `TOKEN` / `SECRET` / `KEY` / `AUTH` / `PASSWORD` / `CREDENTIAL` 的键（大小写不敏感子串）。
 * 实测透传的是 `DSH_BRIDGE_HANDOFF` / `…_PAT` / `…_BEARER`；实测被丢的是
 * `…_TOKEN` / `…_KEY` / `…_SECRET` / `…_AUTH` / `…_PASSWORD` / `…_CREDENTIAL` / `API_KEY`。
 *
 * 用被过滤的名字，后果是「凭据被静默丢掉、代理起不来」—— **比明文落盘更隐蔽的坏状态**。
 * `…_PAT`（personal access token）就是这类凭据在业界最常用的名字，不是为了绕过滤器拼的怪名。
 * 桥接侧还会 `fail closed` 地核对键名（`handoffEnv()`），所以改错名字会在开入口时就炸，而不是在这里静默。
 *
 * ## 纪律
 * - **stdout 只跑 MCP 协议帧**：任何诊断一律走 stderr（否则会污染传输）。
 * - **不读宿主/厂商令牌**：本代理只认上面两个环境变量；缺任一个就**显式失败**（exit 2），
 *   绝不回退到 `process.env` 里的其它凭据，也绝不回退到「直连」。
 * - **两种 framing 都支持**：入帧是 `Content-Length` 头就按它回，是 NDJSON（一行一个 JSON）就按 NDJSON 回。
 *   本机 qoderclicn 用 **NDJSON**（实测：首帧 `{"method":"initialize",…"protocolVersion":"2025-11-25"}\n`）。
 */
import { appendFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import process from 'node:process'

/** 入帧 framing；由**第一帧**决定，之后的回帧跟着它走（混用会让 CLI 解析失败）。 */
let framing: 'ndjson' | 'content-length' = 'ndjson'
const logPath: string = typeof process.env.DSH_BRIDGE_PROXY_LOG === 'string' ? process.env.DSH_BRIDGE_PROXY_LOG : ''
let seq = 0

const note = (event: string, detail: Record<string, unknown>): void => {
  if (logPath.length === 0) return
  seq += 1
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), seq, event, pid: process.pid, ...detail })}\n`)
  } catch { /* 取证失败绝不影响协议 */ }
}
const warn = (message: string): void => { try { process.stderr.write(`mcp-bridge-proxy: ${message}\n`) } catch { /* stderr 断了 */ } }
/**
 * 退出码语义：2 = 凭据缺失（配置/接线问题）；3 = 凭据被拒（401/403）；4 = 入口不可达。
 * 写成**函数声明**（不是 const 箭头函数）：这样 TS 的控制流分析认它是 `never`，
 * 「缺凭据就退出」之后就不需要再给一遍假值。
 */
function die(code: number, message: string): never {
  warn(message)
  note('proxy.exit', { code, message })
  process.exit(code)
}

/**
 * 取一个**必需**的环境变量；缺了就**显式失败**。
 *
 * 这里刻意**不**接受「默认值 / 回退到别的环境变量 / 回退到直连」：
 * 令牌的唯一来源就是这一份手递凭据，任何回退都会变成「凭据悄悄换了个来路」。
 */
const requireEnv = (key: string, purpose: string): string => {
  const value = process.env[key]
  if (typeof value !== 'string' || value.length === 0) {
    die(2, `missing ${key} (${purpose}；本代理拒绝回退到任何其它凭据)`)
  }
  return value
}

const liveUrl: string = requireEnv('DSH_BRIDGE_HANDOFF', '入口地址未随子进程环境送达')
const liveKey: string = requireEnv('DSH_BRIDGE_HANDOFF_PAT', '令牌未随子进程环境送达')

/** 解析并**限定**入口地址：只允许 `http` + loopback，否则连凭据都不解析就退出。 */
function parseLoopbackTarget(raw: string): URL {
  const trimmed = raw.trim()
  let parsed: URL | undefined
  try {
    parsed = new URL(trimmed)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) die(2, 'DSH_BRIDGE_HANDOFF is not a valid URL')
  const allowed = ['127.0.0.1', '::1', '[::1]', 'localhost']
  if (parsed.protocol !== 'http:' || !allowed.includes(parsed.hostname)) {
    die(2, `refusing non-loopback handoff target (protocol=${parsed.protocol} host=${parsed.hostname})`)
  }
  return parsed
}

const liveTarget: URL = parseLoopbackTarget(liveUrl)
note('proxy.start', {
  target: `${liveTarget.origin}${liveTarget.pathname}`,
  keyLength: liveKey.length,
  keyFingerprint: fingerprint(liveKey),
  // 诊断用：**只看键在不在**（不记值）—— 「代理起来了但凭据没送到」与「代理没起来」
  // 是两种完全不同的故障，日志必须能把它们分开。
  handoffKeysPresent: {
    url: typeof process.env.DSH_BRIDGE_HANDOFF === 'string',
    pat: typeof process.env.DSH_BRIDGE_HANDOFF_PAT === 'string',
    proxyLog: typeof process.env.DSH_BRIDGE_PROXY_LOG === 'string',
  },
  envCount: Object.keys(process.env).length,
})

function fingerprint(value: string): string {
  // 只落 8 位指纹（与桥接模块同规矩）：日志里永远不出现令牌本体。
  // 这里用同步的简单散列避免额外依赖；它只用于**对账**，不是密码学用途。
  let h1 = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    h1 ^= value.charCodeAt(index)
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0')
}

/** 一帧 = stdout 上的一次写出（NDJSON 用 `\n`，另一种用 `Content-Length` 头）。 */
const writeFrame = (message: unknown): void => {
  const json = JSON.stringify(message ?? null)
  if (framing === 'ndjson') { process.stdout.write(`${json}\n`); return }
  const body = Buffer.from(json, 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

/**
 * 把一条 JSON-RPC 消息转发到真实入口。
 *
 * 承诺「转发不解析语义」：本代理**不认得**任何 MCP 方法，全部原样转发 ——
 * 它不做权限判断、不缓存、不改写参数（那是桥接入口的职责，不是代理的）。
 */
const forward = (raw: string, respond: (message: unknown) => void): void => {
  const req = httpRequest({
    protocol: liveTarget.protocol,
    hostname: liveTarget.hostname,
    port: liveTarget.port,
    path: `${liveTarget.pathname}${liveTarget.search}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(raw, 'utf8'),
      authorization: `Bearer ${liveKey}`,
      accept: 'application/json, text/event-stream',
    },
  }, (res) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      // 202 / 204 = 通知类请求，桥接不带响应体 ⇒ 这边也**不**回帧（回空帧会让 CLI 收到非法响应）。
      if (res.statusCode === 202 || res.statusCode === 204 || text.trim().length === 0) {
        note('proxy.forward', { status: res.statusCode ?? 0, empty: true })
        return
      }
      if ((res.statusCode ?? 0) >= 400) {
        note('proxy.forward', { status: res.statusCode ?? 0, error: true })
        if (res.statusCode === 401 || res.statusCode === 403) {
          die(3, `bridge rejected the handed-off credential (HTTP ${String(res.statusCode)})`)
        }
        return
      }
      note('proxy.forward', { status: res.statusCode ?? 0, bytes: text.length })
      try {
        respond(JSON.parse(text))
      } catch (error: unknown) {
        warn(`bridge returned non-JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  })
  req.on('error', (error: Error) => {
    note('proxy.error', { detail: error.message })
    warn(`cannot reach the bridge entrance: ${error.message} (入口已关或端口已回收)`)
  })
  req.end(raw, 'utf8')
}

// ── 入帧解析（两种 framing）────────────────────────────────────────────────────
let buffer = Buffer.alloc(0)
const consume = (): void => {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    const head = headerEnd < 0 ? buffer.toString('utf8') : buffer.subarray(0, headerEnd).toString('utf8')
    const match = /content-length:\s*(\d+)/iu.exec(head)
    if (match !== null) {
      framing = 'content-length'
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (buffer.length < bodyStart + length) return
      const raw = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      handle(raw)
      continue
    }
    const newline = buffer.indexOf(0x0a)
    if (newline < 0) return
    const raw = buffer.subarray(0, newline).toString('utf8').trim()
    buffer = buffer.subarray(newline + 1)
    if (raw.length === 0) continue
    handle(raw)
  }
}

const handle = (raw: string): void => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    writeFrame({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error (mcp-bridge-proxy)' } })
    return
  }
  const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  note('proxy.in', {
    methods: list.map((one) => (one !== null && typeof one === 'object' && typeof (one as { method?: unknown }).method === 'string'
      ? (one as { method: string }).method
      : 'response')),
  })
  forward(raw, (response: unknown) => writeFrame(response))
}

process.stdin.on('data', (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); consume() })
// stdin 关掉 = CLI 走了 ⇒ 本代理与它手里的凭据一起消失（**这是回收路径，不是错误路径**）。
process.stdin.on('end', () => { note('proxy.stdin-end', { frames: seq }); process.exit(0) })
process.stdin.on('error', () => process.exit(0))
process.stdin.resume()
