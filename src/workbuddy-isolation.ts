import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { TargetConfig } from './types.js'

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
function snapshotHome(profileDir: string, handle: string): string {
  if (handle !== 'native-home' && !/^native-accounts\/[a-f0-9]{12}-[a-f0-9]{10}$/.test(handle)) throw new Error('隔离账号引用无效')
  return join(profileDir, ...handle.split('/'))
}
export function activeWorkBuddyHome(profileDir: string): string | undefined {
  const selection = join(profileDir, 'active-native-account.json')
  if (!existsSync(selection)) return existsSync(join(profileDir, 'native-home', 'isolation.json')) ? join(profileDir, 'native-home') : undefined
  const selected = object(JSON.parse(readFileSync(selection, 'utf8')))
  return snapshotHome(profileDir, String(selected.handle))
}
export function workBuddyStoredAccounts(profileDir: string): { handle: string; label: string; fingerprint: string; selected: boolean; authenticatedAt?: string }[] {
  const handles: string[] = []
  if (existsSync(join(profileDir, 'native-home', 'isolation.json'))) handles.push('native-home')
  try { for (const dir of readdirSync(join(profileDir, 'native-accounts'))) if (/^[a-f0-9]{12}-[a-f0-9]{10}$/.test(dir)) handles.push('native-accounts/' + dir) } catch { /* none captured */ }
  const active = activeWorkBuddyHome(profileDir)
  return handles.map(handle => {
    const home = snapshotHome(profileDir, handle), state = object(JSON.parse(readFileSync(join(home, 'isolation.json'), 'utf8')))
    return { handle, label: typeof state.label === 'string' && state.label.trim() ? state.label : '账号 · ' + String(state.fingerprint).slice(-6), fingerprint: String(state.fingerprint), selected: home === active, ...(typeof state.authenticatedAt === 'string' ? { authenticatedAt: state.authenticatedAt } : {}) }
  })
}
export function selectWorkBuddyAccount(profileDir: string, handle: string): void {
  if (!workBuddyStoredAccounts(profileDir).some(account => account.handle === handle)) throw new Error('隔离账号不存在')
  writeFileSync(join(profileDir, 'active-native-account.json'), JSON.stringify({ version: 1, handle }), { mode: 0o600 })
}
export function captureWorkBuddyAccount(target: TargetConfig, profileDir: string, label: string, realHome = process.env.USERPROFILE ?? ''): void {
  const wrapper = target.args.findIndex(arg => /(?:^|[\\/])workbuddy-managed\.cjs$/i.test(arg)), adapter = target.args[wrapper + 1]
  if (wrapper < 0 || !['workbuddy-a', 'workbuddy-ai-b'].includes(adapter ?? '')) throw new Error('不是受管 WorkBuddy CLI')
  const cn = adapter === 'workbuddy-a', slot = cn ? 'workbuddy-desktop' : 'workbuddy-desktop-ai'
  const source = join(realHome, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', slot + '.info')
  if (existsSync(source + '.logged-out')) throw new Error('请先完成该区域 WorkBuddy 原生登录')
  const bytes = readFileSync(source), fingerprint = protectedWorkBuddyPrincipal(bytes)
  const key = readFileSync(join(realHome, cn ? '.workbuddy' : '.workbuddy-ai', 'keyblob'))
  if (!key.length || key.length > 64 * 1024) throw new Error('受保护 keyblob 无效')
  const handle = 'native-accounts/' + fingerprint + '-' + sha(bytes).slice(0, 10), home = snapshotHome(profileDir, handle)
  if (!existsSync(join(home, 'isolation.json'))) {
    const authDir = join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(join(authDir, slot + '.info'), bytes, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(home, 'native-keyblob'), key, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(home, 'isolation.json'), JSON.stringify({ version: 1, slot, fingerprint, label: label.trim().slice(0, 80), sourceAuthSha256: sha(bytes), keySha256: sha(key) }), { flag: 'wx', mode: 0o600 })
  }
  selectWorkBuddyAccount(profileDir, handle)
}
export function recordWorkBuddyAuthorization(target: TargetConfig): void {
  const home = target.env.DSH_WORKBUDDY_FROZEN_HOME
  if (!home) return
  const file = join(home, 'isolation.json'), state = object(JSON.parse(readFileSync(file, 'utf8')))
  if (state.fingerprint !== target.env.DSH_WORKBUDDY_PRINCIPAL_FINGERPRINT) throw new Error('认证证据与隔离账号不一致')
  if (protectedWorkBuddyPrincipal(readFileSync(join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', String(state.slot) + '.info'))) !== state.fingerprint) throw new Error('任务期间账号身份发生变化，拒绝认定成功')
  writeFileSync(file, JSON.stringify({ ...state, authenticatedAt: new Date().toISOString() }), { mode: 0o600 })
}
export function protectedWorkBuddyPrincipal(bytes: Buffer): string {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('WorkBuddy 认证文件超过限制')
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('WorkBuddy 原生认证文件无法解析') }
  const data = object(parsed), auth = object(data.auth), account = object(data.account)
  for (const key of ['accessToken', 'refreshToken']) {
    const value = auth[key]
    if (value === undefined || value === null || value === '') { if (key === 'accessToken') throw new Error('WorkBuddy 尚未登录'); continue }
    if (typeof value !== 'object' || object(value).$wbEncrypted === undefined) throw new Error('只接受厂商原生加密信封，请先在 WorkBuddy 完成原生登录')
  }
  const id = account.uid ?? account.id
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length === 0) throw new Error('WorkBuddy 没有可核对的账号身份')
  return sha(String(id)).slice(0, 12)
}

/** Separate native HOME and protected keyblob for each profile. Never decrypt/export tokens. */
export function prepareWorkBuddyHome(target: TargetConfig, profileDir: string, realHome = process.env.USERPROFILE ?? ''): TargetConfig {
  const wrapper = target.args.findIndex(arg => /(?:^|[\\/])workbuddy-managed\.cjs$/i.test(arg))
  if (wrapper < 0) return target
  const adapter = target.args[wrapper + 1]
  if (adapter !== 'workbuddy-a' && adapter !== 'workbuddy-ai-b') throw new Error('WorkBuddy 区域适配器无效')
  const cn = adapter === 'workbuddy-a', slot = cn ? 'workbuddy-desktop' : 'workbuddy-desktop-ai'
  const home = target.env.DSH_WORKBUDDY_FROZEN_HOME ?? activeWorkBuddyHome(profileDir) ?? join(profileDir, 'native-home')
  const rel = relative(profileDir, home)
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('隔离账号目录越界')
  const authDir = join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  const file = join(authDir, slot + '.info'), key = join(home, 'native-keyblob'), manifest = join(home, 'isolation.json')
  if (!existsSync(manifest)) {
    if (existsSync(file) || existsSync(key)) throw new Error('隔离目录包含未登记文件，拒绝覆盖')
    const source = join(realHome, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', slot + '.info')
    if (existsSync(source + '.logged-out')) throw new Error('该区域 WorkBuddy 已退出，请先登录')
    const bytes = readFileSync(source), fingerprint = protectedWorkBuddyPrincipal(bytes)
    const keyBytes = readFileSync(join(realHome, cn ? '.workbuddy' : '.workbuddy-ai', 'keyblob'))
    if (keyBytes.length === 0 || keyBytes.length > 64 * 1024) throw new Error('厂商受保护 keyblob 无效')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    writeFileSync(key, keyBytes, { flag: 'wx', mode: 0o600 })
    writeFileSync(manifest, JSON.stringify({ version: 1, slot, fingerprint, sourceAuthSha256: sha(bytes), keySha256: sha(keyBytes) }), { flag: 'wx', mode: 0o600 })
  }
  const state = object(JSON.parse(readFileSync(manifest, 'utf8')))
  if (state.version !== 1 || state.slot !== slot || state.fingerprint !== protectedWorkBuddyPrincipal(readFileSync(file)) || state.keySha256 !== sha(readFileSync(key))) throw new Error('隔离账号或受保护 keyblob 与登记不一致，拒绝执行')
  return { ...target, env: { ...target.env, USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), DSH_WORKBUDDY_PROFILE_DIR: join(home, 'cli-profile'), DSH_WORKBUDDY_CONTAINER_DIR: profileDir, DSH_WORKBUDDY_KEYBLOB_PATH: key, DSH_WORKBUDDY_FROZEN_HOME: home, DSH_WORKBUDDY_PRINCIPAL_FINGERPRINT: String(state.fingerprint) } }
}
