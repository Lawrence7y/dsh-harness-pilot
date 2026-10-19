#!/usr/bin/env node
/**
 * Windows 友好的构建脚本。
 *
 * ⚠️ 2026-10-13 修正（原注释写错了，正是用户警告的「把旧源码当归宿」）：
 *   原注释称「依赖链接目标是**正在运行的 DSH 安装**（默认 C:\dsh\node_modules，
 *   0.2.0-rc.1）」—— 但**正在运行的不是 C:\dsh**。实测运行中的是
 *   `D:\DeepSeek\resources\app.asar` 里的 `@deepseek-ai/dsh-desktop` /
 *   `dsh-desktop-runtime` **0.2.0-rc.2**（commit 04f392c9，cordis 4.0.4）。
 *   `C:\dsh`(0.2.0-rc.1) 与 `D:\Project\deepseek-harness-master`(0.1.0-rc.8)
 *   都是**非运行的旧副本**。
 *
 * 因此现在分两个来源：
 *   · **运行期依赖** → 从运行中 asar 抽出的 rc.2 树
 *     `D:\Project\_dsh-host-0.2.0-rc.2\node_modules`（抽取方式见
 *     `docs/00-verified-status-report.md`；含 @deepseek-ai/cordis,dsh-tools,
 *     dsh-subagent,dsh-llm,dsh-session,dsh-agent,schemastery + node-pty/ws/
 *     @xterm/headless/@agentclientprotocol/sdk）。
 *   · **编译期** → 仍需一个带 `typescript` 与完整 `@types/node` 的 checkout，
 *     因为 **asar 里根本没有 .d.ts**（连 `@types/node` 都只有 3 个非 .d.ts 文件）。
 *     也就是说：编译期类型**无法**与 rc.2 完全一致，这是上游产物限制，不是配置问题。
 *
 * 步骤：定位 rc.2 运行树 → junction 链接运行期依赖 → 用 checkout 的 tsc 编译 src → lib
 */
import { copyFileSync, existsSync, mkdirSync, lstatSync, realpathSync, unlinkSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 运行期依赖来源：从**运行中 asar** 抽出的 rc.2 模块树（node_modules 根）。 */
function findInstall() {
  const candidates = [
    process.env.DSH_INSTALL,
    // 2026-10-17：宿主更新到 0.2.1-rc.1，运行树从新 asar 抽取（与 rc.2 同法）。
    // 优先匹配「当前运行的宿主」；rc.2 树留作回退。
    'D:/Project/_dsh-host-0.2.1-rc.1/node_modules',
    'D:/Project/_dsh-host-0.2.0-rc.2/node_modules',
    process.env.DSH_CHECKOUT ? join(process.env.DSH_CHECKOUT, 'node_modules') : undefined,
    // 旧副本，仅作最后兜底；它比运行版本低一个 rc，不应作为首选。
    'C:/dsh/node_modules',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'package.json'))) {
      return resolve(candidate)
    }
  }
  throw new Error('cannot locate the host runtime tree (set DSH_INSTALL to its node_modules)')
}

/** 提供 tsc 的源码 checkout（只有编译器与 @types/node 需要它）。 */
function findCheckout() {
  const candidates = [
    process.env.DSH_CHECKOUT,
    'D:/Project/deepseek-harness-master/deepseek-harness-master',
    'C:/dsh',
    join(process.env.USERPROFILE ?? '', 'dsh-harness'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', 'typescript', 'bin', 'tsc'))) return resolve(candidate)
  }
  return undefined
}

const install = findInstall()
const checkout = findCheckout()
console.log('=== install: ' + install + ' ===')
console.log('=== checkout: ' + (checkout ?? '(none; using npx tsc fallback)') + ' ===')

function link(linkPath, targetPath) {
  const link = join(root, 'node_modules', linkPath)
  if (!existsSync(targetPath)) throw new Error('build dependency missing: ' + targetPath)
  // Do not tear down a live junction when it already points at the required runtime.
  if (existsSync(link) && realpathSync(link).toLowerCase() === realpathSync(targetPath).toLowerCase()) return
  let previous
  try { previous=lstatSync(link) } catch { /* absent */ }
  if(previous){
    if(!previous.isSymbolicLink())throw new Error('refusing to replace a non-link dependency: '+link)
    unlinkSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(resolve(targetPath), link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 运行期必须与 harness 同源：直接从运行安装 junction。 */
for (const name of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-agent',
]) {
  link(name, join(install, ...name.split('/')))
}

// 仅窗口级通道需要；缺少时插件仍可加载，只是 window 通道不可用。
const pty = join(install, 'node-pty')
if (existsSync(pty)) link('node-pty', pty)

// ACP 客户端 SDK（宿主已随 dsh-acp 安装）、CDP 用的 WebSocket 实现、pty 屏幕模拟。
for (const name of ['@agentclientprotocol/sdk', 'ws', '@xterm/headless']) {
  const target = join(install, ...name.split('/'))
  if (existsSync(target)) link(name, target)
  else console.warn('=== optional dependency missing: ' + name + ' ===')
}

// @types/node 必须来自带 .d.ts 的 checkout：asar 里那份只有 3 个非 .d.ts 文件，
// 拿它去 tsc 会直接编译失败。运行期不需要它，所以这里的来源与 install 可以不同。
const typesNodeCandidates = [
  checkout === undefined ? undefined : join(checkout, 'node_modules', '@types', 'node'),
  join(install, '@types', 'node'),
].filter((value) => typeof value === 'string' && value.length > 0)
for (const typesNode of typesNodeCandidates) {
  if (existsSync(join(typesNode, 'index.d.ts'))) {
    link('@types/node', typesNode)
    break
  }
}

console.log('=== compiling src -> lib ===')
const tsc = checkout === undefined
  ? join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  : join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) throw new Error('tsc not found at ' + tsc + ' (set DSH_CHECKOUT)')
const compile = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
if ((compile.status ?? 1) !== 0) process.exit(compile.status ?? 1)

// client 半边：源码在 client/client.js。
// 浏览器工件按本机已验证的约定放在**包根 client.js**（exports["./client"] 指它），
// 同时额外拷一份到 lib/client.js —— 注入器的重载预检按这个路径检查。
const clientSource = join(root, 'client', 'client.js')
if (existsSync(clientSource)) {
  mkdirSync(join(root, 'lib'), { recursive: true })
  const grouped=readFileSync(join(root,'client/grouped-models.js'),'utf8')
  const bundle=grouped+'\n'+readFileSync(clientSource,'utf8')
  writeFileSync(join(root,'client.js'),bundle)
  writeFileSync(join(root,'lib/client.js'),bundle)
  console.log('=== copied client/client.js -> client.js + lib/client.js ===')
}
process.exit(0)
