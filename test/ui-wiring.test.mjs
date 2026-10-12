/**
 * 界面链路（真实 cordis 装载）：路由挂上了没有？界面改完工具是不是立刻看到？
 *
 * 这一层不碰 SSH：exec 由真实 createExec 负责，但测试里的主机不可达，
 * 所以只走「清单 + 路由 + 工具」这条链。真实 SSH 由 scripts/smoke-ui.mjs 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { ROUTE_PREFIX } from '../lib/api.js'

import { executionContext } from './harness.mjs'

const TOOL_NAMES = ['ssh_hosts', 'ssh_use', 'ssh_run', 'ssh_read', 'ssh_write', 'ssh_edit', 'ssh_ls']

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

async function request(route, method, path, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = ROUTE_PREFIX + path
  stream.headers = {}
  const state = { status: 0, text: '' }
  const res = { writeHead(status) { state.status = status }, end(text) { state.text = text ?? '' } }
  await route.handler(stream, res)
  return { status: state.status, json: state.text.length === 0 ? null : JSON.parse(state.text) }
}

function settle(ms = 40) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 这一版 cordis 的 Context 没有 stop()：卸载走 fiber.dispose() */
async function shutdown(ctx) {
  if (typeof ctx.stop === 'function') {
    await ctx.stop()
    return
  }
  await ctx.fiber.dispose()
}

/** 起一个最小宿主：真 cordis + 真 ToolRuntime + 假 webServer/connection */
async function boot({ hostsFile, provideServices = true, keyFile, credentials, commands }) {
  const dir = join(hostsFile, '..')
  const web = fakeWebServer()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  if (provideServices) {
    ctx.plugin({ name: 'fake-webserver', apply(c) { c.provide('webServer', web) } })
    ctx.plugin({ name: 'fake-connection', apply(c) { c.provide('connection', { requestRejection: () => undefined }) } })
  }
  // credentials 是可选依赖：不给就验证「没有凭据服务」的那条路
  if (credentials !== undefined) {
    ctx.plugin({ name: 'fake-credentials', apply(c) { c.provide('credentials', credentials) } })
  }
  // commands 同样是可选依赖：给了才会注册 /ssh 命令
  if (commands !== undefined) {
    ctx.plugin({ name: 'fake-commands', apply(c) { c.provide('commands', commands) } })
  }
  ctx.plugin(plugin, { hostsFile, ...(keyFile === undefined ? {} : {}) })
  await settle()
  return {
    dir, web, ctx,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ssh-hosts-ui-wiring-'))
}

test('文件不存在时：插件照常装载（界面才有机会创建它）', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  const booted = await boot({ hostsFile })
  try {
    for (const name of TOOL_NAMES) assert.ok(booted.ctx.tools.get(name) !== undefined, `${name} 未注册`)
    assert.equal(booted.web.routes.length, 1)
    assert.equal(booted.web.routes[0].path, ROUTE_PREFIX)

    const view = await request(booted.web.routes[0], 'GET', '/hosts')
    assert.equal(view.status, 200)
    assert.equal(view.json.value.writable, true)
    assert.deepEqual(view.json.value.hosts, [])
    assert.match(view.json.value.error, /主机清单不存在/)
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('界面新增主机：文件建出来（0600），工具下一个调用就看到', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  const key = join(dir, 'id_ed25519')
  writeFileSync(key, 'PRIVATE KEY\n')
  chmodSync(key, 0o600)
  const booted = await boot({ hostsFile })
  try {
    const route = booted.web.routes[0]
    const added = await request(route, 'POST', '/hosts', {
      host: { name: 'added-by-ui', host: '203.0.113.7', user: 'ops', identityFile: key, tags: ['ui'] }
    })
    assert.equal(added.status, 200)
    assert.equal(added.json.value.action, 'added')
    assert.equal(statSync(hostsFile).mode & 0o777, 0o600)
    assert.match(readFileSync(hostsFile, 'utf8'), /name: added-by-ui/)

    const listed = await booted.ctx.tools.get('ssh_hosts').execute({}, executionContext('s1'))
    assert.deepEqual(listed.hosts.map(host => host.name), ['added-by-ui'])
    assert.equal(listed.total, 1)
    assert.equal(listed.defaultHost, '')

    // 「设为默认」后，不带 host 的调用会落到这台机器（exec 真实发起连接，这里只断言它选对了主机）
    const def = await request(route, 'POST', '/default', { name: 'added-by-ui' })
    assert.equal(def.json.value.defaultHost, 'added-by-ui')
    const used = await booted.ctx.tools.get('ssh_use').execute({}, executionContext('s2'))
    assert.deepEqual(used, { host: 'added-by-ui', source: 'default' })

    // 删除后工具侧立刻为空
    const removed = await request(route, 'POST', '/hosts/delete', { name: 'added-by-ui' })
    assert.equal(removed.json.value.total, 0)
    const after = await booted.ctx.tools.get('ssh_hosts').execute({}, executionContext('s1'))
    assert.equal(after.total, 0)
    assert.equal(after.defaultHost, '')
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('校验失败：路由返回 400，文件与工具侧都不变', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  writeFileSync(hostsFile, 'version: 1\nhosts:\n  - name: keep\n    host: 10.0.0.1\n', { mode: 0o600 })
  const booted = await boot({ hostsFile })
  try {
    const route = booted.web.routes[0]
    const before = readFileSync(hostsFile, 'utf8')
    const bad = await request(route, 'POST', '/hosts', { host: { name: 'bad name', host: '10.0.0.2' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'invalid-args')
    const unknown = await request(route, 'POST', '/hosts', { host: { name: 'x', host: '10.0.0.2', nope: 1 } })
    assert.equal(unknown.status, 400)
    assert.equal(readFileSync(hostsFile, 'utf8'), before)
    const listed = await booted.ctx.tools.get('ssh_hosts').execute({}, executionContext('s1'))
    assert.deepEqual(listed.hosts.map(host => host.name), ['keep'])
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清单损坏时仍然当场失败：工具一个都不注册', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  writeFileSync(hostsFile, 'version: 1\nhosts: "nope"\n', { mode: 0o600 })
  const booted = await boot({ hostsFile })
  try {
    for (const name of TOOL_NAMES) assert.equal(booted.ctx.tools.get(name), undefined, `${name} 不该注册`)
    assert.equal(booted.web.routes.length, 0)
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主没有 webServer（纯 CLI profile）：工具照常，界面不出现', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  writeFileSync(hostsFile, 'version: 1\nhosts:\n  - name: cli-01\n    host: 10.0.0.1\n', { mode: 0o600 })
  const booted = await boot({ hostsFile, provideServices: false })
  try {
    for (const name of TOOL_NAMES) assert.ok(booted.ctx.tools.get(name) !== undefined, `${name} 未注册`)
    assert.equal(booted.web.routes.length, 0)
    const listed = await booted.ctx.tools.get('ssh_hosts').execute({}, executionContext('s1'))
    assert.deepEqual(listed.hosts.map(host => host.name), ['cli-01'])
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主给的 config 真的生效：volatile 字段解包，且改了立刻用新值', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'configured.yaml')
  writeFileSync(hostsFile, `version: 1
hosts:
  - name: cfg-host
    host: 10.9.9.9
  - name: live-host
    host: 10.9.9.10
`, { mode: 0o600 })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  // 宿主（Loader / 桌面端）就是把这份 config 交给插件：cordis 按 Config 校验后，
  // 每个 volatile 字段变成 { get() } 引用，而不是标量。
  const fiber = ctx.plugin(plugin, { hostsFile, defaultHost: 'cfg-host', timeoutMs: 45_000 })
  await fiber
  await settle()
  try {
    const value = await ctx.tools.get('ssh_hosts').execute({}, executionContext('s1'))
    assert.equal(value.source, hostsFile, '配置的 hostsFile 被忽略 = 又退回默认清单了')
    assert.deepEqual(value.hosts.map(host => host.name), ['cfg-host', 'live-host'])
    assert.equal(value.defaultHost, 'cfg-host')
    const used = await ctx.tools.get('ssh_use').execute({}, executionContext('s2'))
    assert.deepEqual(used, { host: 'cfg-host', source: 'config' })

    // 设置页改 volatile 字段：宿主只更新引用里的值，插件不重启也要立刻用新值
    const box = fiber.config.defaultHost
    assert.equal(typeof box?.get, 'function', '宿主交给插件的应当是 volatile 引用')
    box[Symbol.for('cosmokit.volatile.write')]('live-host')
    const replayed = await ctx.tools.get('ssh_use').execute({}, executionContext('s3'))
    assert.deepEqual(replayed, { host: 'live-host', source: 'config' })
  } finally {
    await shutdown(ctx)
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('卸载插件：工具与路由都被回收', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  writeFileSync(hostsFile, 'version: 1\nhosts:\n  - name: gone-01\n    host: 10.0.0.1\n', { mode: 0o600 })
  const booted = await boot({ hostsFile })
  try {
    assert.ok(booted.ctx.tools.get('ssh_run') !== undefined)
    assert.equal(booted.web.routes.length, 1)
    await shutdown(booted.ctx)
    // fiber 卸载后连 tools 服务本身都不再可达：读不到就是最直接的证据
    let stillThere
    try { stillThere = booted.ctx.tools.get('ssh_run') } catch { stillThere = undefined }
    assert.equal(stillThere, undefined)
    assert.equal(booted.web.routes.length, 0)
  } finally {
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 假凭据服务：只有 describe/resolve/set/unset，够跑通「界面填密码」这条路 */
function fakeCredentials() {
  const store = new Map()
  return {
    store,
    async describe(ref) {
      return { configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true }
    },
    async resolve(ref) {
      return store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined
    },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) }
  }
}

test('没有 credentials 服务：界面照常打开，并明说密码不可用', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  const booted = await boot({ hostsFile })
  try {
    const view = await request(booted.web.routes[0], 'GET', '/hosts')
    assert.equal(view.status, 200)
    assert.equal(view.json.value.passwordSupported, false)
    // 关键：插件没有因为「可选服务不存在」而挂掉
    for (const name of TOOL_NAMES) assert.ok(booted.ctx.tools.get(name) !== undefined, `${name} 未注册`)
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('界面填密码：值进凭据服务、清单只留 passwordRef，工具侧拿到 auth=password', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  const credentials = fakeCredentials()
  const booted = await boot({ hostsFile, credentials })
  try {
    const route = booted.web.routes[0]
    const added = await request(route, 'POST', '/hosts', {
      host: { name: 'pw-01', host: '203.0.113.9', user: 'root' },
      password: 'hunter2'
    })
    assert.equal(added.status, 200)
    assert.equal(added.json.value.password, 'set')
    assert.equal(added.json.value.passwordRef, 'DSH_SSH_HOSTS_PASSWORD_PW_01')
    assert.equal(credentials.store.get('DSH_SSH_HOSTS_PASSWORD_PW_01'), 'hunter2')

    const onDisk = readFileSync(hostsFile, 'utf8')
    assert.match(onDisk, /passwordRef: DSH_SSH_HOSTS_PASSWORD_PW_01/)
    assert.equal(onDisk.includes('hunter2'), false)
    assert.equal(statSync(hostsFile).mode & 0o777, 0o600)

    const view = await request(route, 'GET', '/hosts')
    assert.equal(view.json.value.passwordSupported, true)
    const row = view.json.value.hosts.find(host => host.name === 'pw-01')
    assert.equal(row.passwordConfigured, true)
    assert.equal(JSON.stringify(view.json).includes('hunter2'), false)

    // 工具侧：模型只看得到 auth 摘要，看不到凭据名，更看不到值
    const listed = await booted.ctx.tools.get('ssh_hosts').execute({}, executionContext('s-pw'))
    assert.equal(listed.hosts.find(host => host.name === 'pw-01').auth, 'password')
    assert.equal(JSON.stringify(listed).includes('hunter2'), false)
    assert.equal(JSON.stringify(listed).includes('DSH_SSH_HOSTS_PASSWORD_PW_01'), false)

    // 清除密码：凭据被删，清单里的引用也摘掉
    const cleared = await request(route, 'POST', '/hosts', {
      host: { name: 'pw-01', host: '203.0.113.9', user: 'root' },
      clearPassword: true
    })
    assert.equal(cleared.json.value.password, 'cleared')
    assert.equal(credentials.store.size, 0)
    assert.equal(readFileSync(hostsFile, 'utf8').includes('passwordRef'), false)
  } finally {
    await shutdown(booted.ctx)
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('有 commands 服务时注册 /ssh（会话窗口「+」菜单那一行）', async () => {
  const dir = tempDir()
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  writeFileSync(hostsFile, 'version: 1\nhosts:\n  - name: web-01\n    host: 10.0.0.11\n', { mode: 0o600 })
  const registered = []
  const commands = {
    register(definition) {
      registered.push(definition)
      return () => { registered.splice(registered.indexOf(definition), 1) }
    }
  }
  const booted = await boot({ hostsFile, commands })
  try {
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'ssh')
    assert.equal(registered[0].input.hint, '<主机名>')

    // 命令真的能改这个会话的默认主机，且工具侧跟着变
    const result = await registered[0].handler({
      commandId: 'c-1',
      agent: { session: { id: 'session-a' } },
      rawInput: 'web-01',
      signal: new AbortController().signal
    })
    assert.equal(result.kind, 'success')
    const used = await booted.ctx.tools.get('ssh_use').execute({}, executionContext('session-a'))
    assert.equal(used.host, 'web-01')
    assert.equal(used.source, 'ssh_use')

    // 卸载：命令一并回收（fiber 卸载不留全局注册）
    await shutdown(booted.ctx)
    assert.equal(registered.length, 0)
  } finally {
    booted.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})
