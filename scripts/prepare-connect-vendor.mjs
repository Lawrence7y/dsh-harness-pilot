import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const stage = join(root, 'work/api-migration-20261015')
const require = createRequire(import.meta.url)
const ts = require('D:/Project/deepseek-harness-master/deepseek-harness-master/node_modules/typescript')
const records = []
for (const family of ['workbuddy','qoder']) {
  const source = join(stage, family), dest = join(root, 'vendor/connect', family)
  mkdirSync(dest, { recursive: true })
  const folder = family === 'workbuddy' ? 'src' : 'lib'
  for (const name of readdirSync(join(source, folder))) {
    if (!name.endsWith(family === 'workbuddy' ? '.ts' : '.js') || name.endsWith('.d.ts')) continue
    const input = readFileSync(join(source, folder, name), 'utf8')
    let code = family === 'workbuddy' ? ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2') : input
    // Narrow local patches: carry explicit upstream quota classifications through the pi-ai seam.
    if(name.replace(/\.ts$/,'.js')==='shim.js') {
      if(family==='workbuddy') code=code.replace('function writeOpenAIError(res, status, kind, message) {',
        "function writeOpenAIError(res, status, kind, message) {\n    if (kind === 'hard_credit') message = `DSH_PILOT_QUOTA_EXHAUSTED quota_exceeded: ${message}`;")
      else code=code.replace("writeError(res, 429, 'daily_limit_exceeded', String(error?.message ?? error))",
        "writeError(res, 402, 'insufficient_quota', `DSH_PILOT_QUOTA_EXHAUSTED quota_exceeded: ${String(error?.message ?? error)}`)")
        .replace('const message = String(error?.message ?? error)',
          'const message = error?.dailyLimit === true ? `DSH_PILOT_QUOTA_EXHAUSTED quota_exceeded: ${String(error?.message ?? error)}` : String(error?.message ?? error)')
    }
    writeFileSync(join(dest, name.replace(/\.ts$/, '.js')), code)
  }
  if (existsSync(join(source, 'LICENSE'))) copyFileSync(join(source, 'LICENSE'), join(dest,'LICENSE'))
  records.push({ family, source: family === 'workbuddy' ? 'https://github.com/corrinehu/dsh-workbuddy-connect' : 'https://github.com/hdhgsysh/dsh-connect-qoder',
    sha: execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(), version: JSON.parse(readFileSync(join(source,'package.json'))).version })
}
writeFileSync(join(root, 'vendor/connect/SOURCES.json'), JSON.stringify(records,null,2)+'\n')
const install = 'D:/Project/_dsh-host-0.2.0-rc.2/node_modules'
for (const name of ['dsh-atomic-write','dsh-home-paths','dsh-brand','dsh-util-values','dsh-timeout','dsh-attachment','dsh-credentials','dsh-launch-environment']) {
  const link = join(root,'node_modules/@deepseek-ai',name)
  if (!existsSync(link)) symlinkSync(join(install,'@deepseek-ai',name),link,'junction')
}
// This package needs pi-ai next to this checkout; other shared host services stay linked.
const piSource = join(install,'@deepseek-ai/dsh-llm-pi-ai'), piDest = join(root,'vendor/connect/host/dsh-llm-pi-ai')
mkdirSync(join(piDest,'lib'), {recursive:true})
copyFileSync(join(piSource,'lib/index.js'),join(piDest,'lib/index.js'))
copyFileSync(join(piSource,'package.json'),join(piDest,'package.json'))
copyFileSync(join(piSource,'LICENSE'),join(piDest,'LICENSE'))
const piLink = join(root,'node_modules/@deepseek-ai/dsh-llm-pi-ai')
if (!existsSync(piLink)) symlinkSync(piDest,piLink,'junction')
mkdirSync(join(root,'node_modules/@earendil-works'),{recursive:true})
const depLink=join(root,'node_modules/@earendil-works/pi-ai')
if (!existsSync(depLink)) symlinkSync(join(stage,'deps/node_modules/@earendil-works/pi-ai'),depLink,'junction')
console.log('Prepared pinned source adapters; no account data accessed')
