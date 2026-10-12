#!/usr/bin/env node
/**
 * 界面链路冒烟：真插件 + 真路由 + 真服务器。
 *
 *   node scripts/smoke-ui.mjs [host] [user]
 *
 * 跑的是「在设置里点一下」的完整路径：
 *   浏览器 fetch → lib/api.js 路由 → lib/service.js → 写 ssh-hosts.yaml → 立刻重载
 *   → 工具（ssh_*）在**同一个进程**里看到新主机并发起真实 SSH。
 *
 * 清单文件用临时目录里的一份，不碰 ~/.dsh/ssh-hosts.yaml —— 它连「文件还不存在」
 * 这个状态都演了一遍（新机器第一次装插件时的样子）。
 * 全程只用密钥认证：不接收、不落盘任何密码。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { normalizeConfig } from '../lib/config.js'
import { createExec } from '../lib/exec.js'
import { createSessionState } from '../lib/session-state.js'
import { createHostService } from '../lib/service.js'
import { registerRoutes, ROUTE_PREFIX } from '../lib/api.js'
import { registerTools } from '../lib/tools.js'
import { createFakeRegistry, executionContext } from '../test/harness.mjs'

const ROOT = join(import.meta.dirname, '..')
const HOSTNAME = process.argv[2] ?? process.env.DSH_SSH_HOSTS_REMOTE_HOST ?? 'test-host.example.com'
const USER = process.argv[3] ?? process.env.DSH_SSH_HOSTS_REMOTE_USER ?? 'ubuntu'
const KEY = process.env.DSH_SSH_HOSTS_REMOTE_KEY ?? join(ROOT, '.test-keys', 'id_ed25519')
const KNOWN_HOSTS = process.env.DSH_SSH_HOSTS_REMOTE_KNOWN_HOSTS ?? join(ROOT, '.test-keys', 'known_hosts')
const HOST_NAME = 'ui-smoke-01'

function requireKey() {
  try {
    if ((statSync(KEY).mode & 0o077) !== 0) chmodSync(KEY, 0o600)
  } catch {
    console.error(`找不到私钥：${KEY}`)
    process.exit(1)
  }
}

/** 假 webServer：与真实 seam 一样返回释放函数 */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    }
  }
}

/** 直接调注册出来的 handler，等价于浏览器 fetch 一次 */
async function request(route, method, path, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = ROUTE_PREFIX + path
  stream.headers = {}
  const state = { status: 0, text: '' }
  const res = {
    writeHead(status) { state.status = status },
    end(text) { state.text = text ?? '' }
  }
  await route.handler(stream, res)
  const json = state.text.length === 0 ? null : JSON.parse(state.text)
  process.stdout.write(`\n=== ${method} ${ROUTE_PREFIX}${path} → ${state.status} ===\n${JSON.stringify(json?.value ?? json, null, 2)}\n`)
  if (!json?.ok) throw new Error(`${method} ${path} 失败：${json?.error?.message ?? state.status}`)
  return json.value
}

async function main() {
  requireKey()
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-ui-smoke-'))
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  process.stdout.write(`临时清单：${hostsFile}（初始不存在）\n`)

  // 内存版凭据服务：与真实 credentials 同一套接口，值只在进程里，不落盘。
  const secrets = new Map()
  const credentials = {
    async describe(ref) { return { configured: secrets.has(ref), source: secrets.has(ref) ? 'file' : undefined, writable: true } },
    async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref), source: 'file' } : undefined },
    async set(ref, value) { secrets.set(ref, value) },
    async unset(ref) { secrets.delete(ref) }
  }
  const exec = createExec({
    knownHostsFile: KNOWN_HOSTS,
    strictHostKeyChecking: 'accept-new',
    connectTimeoutSec: 10,
    timeoutMs: 30000,
    controlPersistSec: 60,
    // 与插件里同一条路：清单只给凭据名，值由凭据服务按名字解析
    resolvePassword: async host => credentials.resolve(host.passwordRef).then(found => found?.value),
    logger: message => console.error(`[exec] ${message}`)
  })
  const state = createSessionState({ file: join(dir, 'state.json') })
  const service = createHostService({
    cfg: normalizeConfig({ hostsFile }),
    hostsFile,
    state,
    exec,
    logger: message => console.error(`[plugin] ${message}`),
    credentials: () => credentials
  })

  // 1) 文件还不存在：插件照常起来，界面能打开并提示去创建
  const installed = service.install()
  console.log(`install(): ${installed.hosts.length} 台主机，error=${JSON.stringify(installed.error?.split('\n')[0])}`)

  const server = fakeWebServer()
  registerRoutes(server, { requestRejection: () => undefined }, {
    list: () => service.list(),
    upsert: (entry, options) => service.upsert(entry, options),
    remove: name => service.remove(name),
    setDefault: name => service.setDefault(name),
    reload: () => service.reload(),
    test: name => service.test(name)
  })
  const route = server.routes[0]

  // 2) 界面读到的状态：可写、文件不存在
  const view = await request(route, 'GET', '/hosts')
  if (view.hosts.length !== 0) throw new Error('初始清单应为空')
  if (view.fileInfo.exists !== false) throw new Error('初始不应有文件')

  // 3) 界面上「新增主机」→ 这一步会把文件建出来
  await request(route, 'POST', '/hosts', {
    host: {
      name: HOST_NAME,
      host: HOSTNAME,
      user: USER,
      identityFile: KEY,
      defaultWorkdir: '/tmp',
      description: '界面冒烟用',
      tags: ['smoke']
    }
  })
  const mode = statSync(hostsFile).mode & 0o777
  if (mode !== 0o600) throw new Error(`清单权限应为 0600，实际 ${mode.toString(8)}`)
  process.stdout.write(`\n文件已创建，权限 ${mode.toString(8)}：\n${readFileSync(hostsFile, 'utf8')}\n`)

  // 4) 界面上「测试连接」→ 真实 SSH
  const tested = await request(route, 'POST', '/test', { name: HOST_NAME })
  if (!tested.ok) throw new Error(`连通性测试失败：${tested.stderr}`)
  if (!/Linux/.test(tested.stdout)) throw new Error(`预期 uname 输出里有 Linux，实际：${tested.stdout}`)

  // 5) 界面上「设为默认」→ 工具侧无需 host 参数
  await request(route, 'POST', '/default', { name: HOST_NAME })

  // 6) 同一个进程里，模型侧的 ssh_* 工具直接用这台刚加的主机
  const { ctx, definitions } = createFakeRegistry()
  const disposeTools = registerTools(ctx, service.live)
  const session = executionContext('ui-smoke-session')
  const call = async (name, args) => {
    const definition = definitions.get(name)
    process.stdout.write(`\n=== ${name}(${JSON.stringify(args)}) ===\n`)
    const value = await definition.execute(args, session)
    process.stdout.write(`${definition.output.render(args, value).map(block => block.text).join('\n')}\n`)
    return value
  }
  const listed = await call('ssh_hosts', {})
  if (listed.hosts.length !== 1 || listed.defaultHost !== HOST_NAME) {
    throw new Error(`工具侧没看到界面加的主机：${JSON.stringify(listed)}`)
  }
  const ran = await call('ssh_run', { command: 'uname -srm; id -un' })
  if (ran.exitCode !== 0 || !/Linux/.test(ran.stdout)) throw new Error(`ssh_run 失败：${JSON.stringify(ran)}`)

  // 7) 界面上「删除」→ 工具侧立刻变成没有主机
  await request(route, 'POST', '/hosts/delete', { name: HOST_NAME })
  const after = await call('ssh_hosts', {})
  if (after.hosts.length !== 0 || after.defaultHost !== '') {
    throw new Error(`删除后工具侧仍有主机：${JSON.stringify(after)}`)
  }
  let failedAsExpected = false
  try {
    await call('ssh_run', { command: 'true' })
  } catch (error) {
    failedAsExpected = error.kind === 'no-host'
    process.stdout.write(`预期失败：${error.kind} — ${error.message.split('\n')[0]}\n`)
  }
  if (!failedAsExpected) throw new Error('没有主机时 ssh_run 应当报 no-host')

  // 7.5) 密码登录冒烟（可选）：给了 DSH_SSH_HOSTS_REMOTE_PASSWORD 才跑，
  //      走「界面填密码 → 凭据服务 → askpass → 真 ssh」，全程不给密钥。
  const PASSWORD = process.env.DSH_SSH_HOSTS_REMOTE_PASSWORD ?? ''
  if (PASSWORD.length === 0) {
    process.stdout.write('\n跳过密码登录冒烟：未设置 DSH_SSH_HOSTS_REMOTE_PASSWORD。\n')
  } else {
    const pwName = `${HOST_NAME}-pw`
    await request(route, 'POST', '/hosts', {
      host: { name: pwName, host: HOSTNAME, user: USER, tags: ['smoke', 'password'] },
      password: PASSWORD
    })
    const yaml = readFileSync(hostsFile, 'utf8')
    if (yaml.includes(PASSWORD)) throw new Error('明文密码落进了清单文件')
    if (!yaml.includes(`passwordRef: DSH_SSH_HOSTS_PASSWORD_${pwName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`)) {
      throw new Error(`清单里缺少 ${pwName} 的 passwordRef：\n${yaml}`)
    }
    const pwView = await request(route, 'GET', '/hosts')
    if (JSON.stringify(pwView).includes(PASSWORD)) throw new Error('界面响应里出现了明文密码')
    const pwRow = pwView.hosts.find(host => host.name === pwName)
    if (pwRow.passwordConfigured !== true) throw new Error('界面应显示密码已保存')
    process.stdout.write(`\n密码主机 ${pwName}：清单只留 ${pwRow.passwordRef}，凭据在内存里；auth=${pwRow.passwordConfigured ? '已设置' : '未设置'}\n`)

    const pwRun = await call('ssh_run', { host: pwName, command: 'uname -s; id -un' })
    if (pwRun.exitCode !== 0 || !/Linux/.test(pwRun.stdout)) throw new Error(`密码登录 ssh_run 失败：${JSON.stringify(pwRun)}`)

    const pwRemoved = await request(route, 'POST', '/hosts/delete', { name: pwName })
    if (pwRemoved.clearedPassword !== true) throw new Error('删除密码主机时应一并清掉凭据')
    if (secrets.size !== 0) throw new Error('删除后凭据应已清空')
    process.stdout.write('密码主机已删除，凭据已清空。\n')
  }

  // 8) 界面只读态：config.hosts 内联声明
  const readOnlyService = createHostService({
    cfg: normalizeConfig({ hostsFile, hosts: [{ name: 'inline-01', host: '10.0.0.9' }] }),
    hostsFile,
    state,
    exec
  })
  readOnlyService.install()
  const readOnlyView = await readOnlyService.list()
  if (readOnlyView.writable !== false) throw new Error('内联清单应当只读')
  process.stdout.write(`\n内联清单只读：${readOnlyView.reason}\n`)

  disposeTools()
  await exec.dispose()
  rmSync(dir, { recursive: true, force: true })
  process.stdout.write('\n界面链路冒烟结束：全部通过。\n')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
