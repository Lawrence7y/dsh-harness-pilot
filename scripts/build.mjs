#!/usr/bin/env node
/**
 * Windows 友好的构建脚本。
 *
 * 与 dsh-computer-use 的关键区别：依赖链接目标是**正在运行的 DSH 安装**
 * （默认 C:\dsh\node_modules，0.2.0-rc.1），而不是源码 checkout（0.1.0-rc.8）。
 * 这样编译期 .d.ts 与运行期模块实例都与实际运行 harness 一致。
 *
 * 步骤：定位 DSH 安装 → junction 链接 peer 依赖 → 用 checkout 的 tsc 编译 src → lib
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 正在运行的 DSH 安装（node_modules 根）。 */
function findInstall() {
  const candidates = [
    process.env.DSH_INSTALL,
    process.env.DSH_CHECKOUT ? join(process.env.DSH_CHECKOUT, 'node_modules') : undefined,
    'C:/dsh/node_modules',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'package.json'))) {
      return resolve(candidate)
    }
  }
  throw new Error('cannot locate the running dsh install (set DSH_INSTALL to its node_modules)')
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
  rmSync(link, { recursive: true, force: true })
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

const typesNode = join(install, '@types', 'node')
if (existsSync(typesNode)) link('@types/node', typesNode)

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
  copyFileSync(clientSource, join(root, 'client.js'))
  copyFileSync(clientSource, join(root, 'lib', 'client.js'))
  console.log('=== copied client/client.js -> client.js + lib/client.js ===')
}
process.exit(0)
