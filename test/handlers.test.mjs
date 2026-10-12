import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolFailure, createHandlers } from '../lib/handlers.js'
import { SshExecError } from '../lib/exec.js'
import { createSessionState } from '../lib/session-state.js'

function hostEntry(overrides = {}) {
  return {
    name: 'web-01',
    host: '10.0.0.1',
    port: 22,
    user: 'ubuntu',
    identityFile: '/keys/id',
    proxyJump: '',
    defaultWorkdir: '/srv/app',
    description: '生产 Web',
    tags: ['prod', 'web'],
    connectTimeoutSec: 0,
    keepAliveSec: 0,
    readOnly: false,
    jump: undefined,
    ...overrides
  }
}

const HOSTS = [
  hostEntry(),
  hostEntry({ name: 'db-01', host: '10.0.0.2', port: 2222, user: 'admin', tags: ['prod', 'db'], defaultWorkdir: '', readOnly: true })
]

function fakeExec(overrides = {}) {
  const calls = []
  return {
    calls,
    async run(host, options) {
      calls.push({ kind: 'run', host: host.name, ...options })
      if (overrides.run !== undefined) return overrides.run(host, options)
      return { exitCode: 0, stdout: 'ok\n', stderr: '', truncated: { stdout: false, stderr: false }, durationMs: 7 }
    },
    async readText(host, path, options) {
      calls.push({ kind: 'readText', host: host.name, path, ...options })
      if (overrides.readText !== undefined) return overrides.readText(host, path, options)
      return { text: 'one\ntwo\nthree', bytes: 13, sizeBytes: 13, mode: '644' }
    },
    async writeText(host, path, content, options) {
      calls.push({ kind: 'writeText', host: host.name, path, content, ...options })
      if (overrides.writeText !== undefined) return overrides.writeText(host, path, content, options)
      return { bytes: Buffer.byteLength(content), created: true, mode: undefined }
    },
    async list(host, path, options) {
      calls.push({ kind: 'list', host: host.name, path, ...options })
      if (overrides.list !== undefined) return overrides.list(host, path, options)
      return { entries: [{ name: 'index.js', type: 'file', mode: '-rw-r--r--', size: 12, mtime: 1 }], truncated: false }
    },
    async dispose() {}
  }
}

function make({ cfg = {}, hosts = HOSTS, overrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-handlers-'))
  const state = createSessionState({ file: join(dir, 'state.json') })
  const exec = fakeExec(overrides)
  const handlers = createHandlers({
    cfg: { maxReadBytes: 1024 * 1024, allow: [], deny: [], defaultHost: 'web-01', hostsFile: '', ...cfg },
    hosts,
    source: 'test',
    exec,
    state,
    logger: () => {}
  })
  return { handlers, state, exec, dir }
}

test('ssh_hosts：投影不含密钥，可按 tag 过滤', async () => {
  const { handlers } = make()
  const all = await handlers.listHosts()
  assert.equal(all.total, 2)
  assert.equal(JSON.stringify(all).includes('/keys/id'), false)
  assert.equal(all.hosts[0].name, 'web-01')
  const dbOnly = await handlers.listHosts({ tag: 'db' })
  assert.deepEqual(dbOnly.hosts.map(host => host.name), ['db-01'])
  assert.equal((await handlers.listHosts({ tag: 'nope' })).hosts.length, 0)
})

test('主机解析优先级：显式参数 > 本会话默认 > config.defaultHost', async () => {
  const { handlers, state } = make({ cfg: { defaultHost: 'db-01' } })
  // 1) 显式参数
  const explicit = await handlers.run({ sessionId: 's1', host: 'web-01', command: 'pwd' })
  assert.equal(explicit.host, 'web-01')
  // 2) 会话默认
  state.set('s1', 'db-01')
  assert.equal((await handlers.run({ sessionId: 's1', command: 'pwd' })).host, 'db-01')
  // 3) config 默认（会话没设过）
  assert.equal((await handlers.run({ sessionId: 's2', command: 'pwd' })).host, 'db-01')
})

test('ssh_use 设置/读取/回显来源', async () => {
  const { handlers, state } = make({ cfg: { defaultHost: '' } })
  assert.deepEqual(await handlers.useHost({ sessionId: 's1' }), { host: '', source: 'none' })
  assert.deepEqual(await handlers.useHost({ sessionId: 's1', host: 'web-01' }), { host: 'web-01', source: 'ssh_use' })
  assert.equal(state.get('s1'), 'web-01')
  assert.deepEqual(await handlers.useHost({ sessionId: 's1' }), { host: 'web-01', source: 'ssh_use' })
  await assert.rejects(() => handlers.useHost({ sessionId: 's1', host: 'ghost' }), error => error.kind === 'unknown-host')
})

test('没有可用主机时的报错能指引配置', async () => {
  const { handlers } = make({ hosts: [], cfg: { defaultHost: '' } })
  await assert.rejects(
    () => handlers.run({ sessionId: 's1', command: 'pwd' }),
    error => error instanceof ToolFailure && error.kind === 'no-host' && /ssh-hosts\.yaml/.test(error.message)
  )
})

test('未指定 host 时列出可用主机', async () => {
  const { handlers } = make({ cfg: { defaultHost: '' } })
  await assert.rejects(
    () => handlers.run({ sessionId: 's1', command: 'pwd' }),
    error => error.kind === 'no-host' && error.message.includes('web-01') && error.message.includes('db-01')
  )
})

test('未知主机报错并列出可用主机', async () => {
  const { handlers } = make()
  await assert.rejects(
    () => handlers.run({ sessionId: 's1', host: 'web-99', command: 'pwd' }),
    error => error.kind === 'unknown-host' && error.message.includes('web-99')
  )
})

test('会话默认主机失效后回落到 config 默认', async () => {
  const { handlers, state } = make({ cfg: { defaultHost: 'web-01' } })
  state.set('s1', 'deleted-host')
  assert.equal((await handlers.run({ sessionId: 's1', command: 'pwd' })).host, 'web-01')
})

test('ssh_run：命令走 defaultWorkdir，可被 cwd 覆盖', async () => {
  const { handlers, exec } = make()
  await handlers.run({ sessionId: 's', host: 'web-01', command: 'ls' })
  assert.equal(exec.calls[0].cwd, '/srv/app')
  await handlers.run({ sessionId: 's', host: 'web-01', command: 'ls', cwd: '/tmp' })
  assert.equal(exec.calls[1].cwd, '/tmp')
})

test('ssh_run：cwd 必须是绝对路径', async () => {
  const { handlers } = make()
  await assert.rejects(
    () => handlers.run({ sessionId: 's', command: 'ls', cwd: 'tmp' }),
    error => error.kind === 'invalid-args'
  )
})

test('ssh_run：timeoutMs 范围校验', async () => {
  const { handlers } = make()
  await assert.rejects(() => handlers.run({ sessionId: 's', command: 'ls', timeoutMs: 10 }), error => error.kind === 'invalid-args')
  await assert.rejects(() => handlers.run({ sessionId: 's', command: 'ls', timeoutMs: 99_999_999 }), error => error.kind === 'invalid-args')
  await handlers.run({ sessionId: 's', command: 'ls', timeoutMs: 5000 })
})

test('ssh_run：空命令拒绝', async () => {
  const { handlers } = make()
  await assert.rejects(() => handlers.run({ sessionId: 's', command: '   ' }), error => error.kind === 'invalid-args')
})

test('命令策略：deny 优先于 allow（这是运维约定，不是安全边界）', async () => {
  const denied = make({ cfg: { deny: ['rm -rf'] } })
  await assert.rejects(
    () => denied.handlers.run({ sessionId: 's', command: 'sudo rm -rf /var' }),
    error => error.kind === 'denied'
  )
  await denied.handlers.run({ sessionId: 's', command: 'uptime' })

  const allowed = make({ cfg: { allow: ['^uptime$', '^df '] } })
  await allowed.handlers.run({ sessionId: 's', command: 'df -h' })
  await assert.rejects(() => allowed.handlers.run({ sessionId: 's', command: 'reboot' }), error => error.kind === 'denied')

  const both = make({ cfg: { allow: ['^uptime$'], deny: ['uptime'] } })
  await assert.rejects(() => both.handlers.run({ sessionId: 's', command: 'uptime' }), error => error.kind === 'denied')
})

test('非法正则在装载期就失败（不等到调用）', () => {
  assert.throws(() => make({ cfg: { deny: ['('] } }), /不是合法正则/)
  assert.throws(() => make({ cfg: { allow: [''] } }), /必须是非空正则字符串/)
})

test('readOnly 主机拒绝写与编辑，但允许读和跑命令', async () => {
  const { handlers } = make()
  await assert.rejects(
    () => handlers.write({ sessionId: 's', host: 'db-01', path: '/tmp/a', content: 'x' }),
    error => error.kind === 'read-only'
  )
  await assert.rejects(
    () => handlers.edit({ sessionId: 's', host: 'db-01', path: '/tmp/a', oldString: 'a', newString: 'b' }),
    error => error.kind === 'read-only'
  )
  await handlers.run({ sessionId: 's', host: 'db-01', command: 'uptime' })
  await handlers.read({ sessionId: 's', host: 'db-01', path: '/etc/hosts' })
})

test('ssh_read：按行切片并标记截断', async () => {
  const { handlers } = make({
    overrides: { readText: () => ({ text: 'l1\nl2\nl3\nl4', bytes: 11, sizeBytes: 11, mode: '644' }) }
  })
  const all = await handlers.read({ sessionId: 's', path: '/a.txt' })
  assert.equal(all.content, 'l1\nl2\nl3\nl4')
  assert.equal(all.startLine, 1)
  assert.equal(all.endLine, 4)
  assert.equal(all.totalLines, 4)
  assert.equal(all.truncated, false)

  const page = await handlers.read({ sessionId: 's', path: '/a.txt', offset: 2, limit: 2 })
  assert.equal(page.content, 'l2\nl3')
  assert.equal(page.startLine, 2)
  assert.equal(page.endLine, 3)
  assert.equal(page.truncated, true)
})

test('ssh_read：offset 越界返回空内容而不是报错', async () => {
  const { handlers } = make({ overrides: { readText: () => ({ text: 'a\nb', bytes: 3, sizeBytes: 3, mode: '644' }) } })
  const result = await handlers.read({ sessionId: 's', path: '/a.txt', offset: 99 })
  assert.equal(result.content, '')
  assert.equal(result.startLine, 99)
  assert.equal(result.endLine, 98)
  assert.equal(result.totalLines, 2)
  assert.equal(result.truncated, false)
})

test('ssh_read：相对路径拒绝', async () => {
  const { handlers } = make()
  await assert.rejects(() => handlers.read({ sessionId: 's', path: 'a.txt' }), error => error.kind === 'invalid-args')
})

test('ssh_write：透传内容并回显 created', async () => {
  const { handlers, exec } = make()
  const result = await handlers.write({ sessionId: 's', host: 'web-01', path: '/srv/app/.env', content: 'A=1\n' })
  assert.deepEqual(result, { host: 'web-01', path: '/srv/app/.env', bytes: 4, created: true })
  assert.equal(exec.calls[0].content, 'A=1\n')
})

test('ssh_edit：唯一匹配才替换', async () => {
  const { handlers, exec } = make({
    overrides: { readText: () => ({ text: 'port = 8080\nhost = x\n', bytes: 20, sizeBytes: 20, mode: '644' }) }
  })
  const result = await handlers.edit({ sessionId: 's', path: '/etc/app.conf', oldString: '8080', newString: '9090' })
  assert.deepEqual(result, { host: 'web-01', path: '/etc/app.conf', replacements: 1 })
  const written = exec.calls.find(call => call.kind === 'writeText')
  assert.equal(written.content, 'port = 9090\nhost = x\n')
})

test('ssh_edit：0 处匹配 → not-found，1 处以上 → not-unique（都不动文件）', async () => {
  const { handlers, exec } = make({
    overrides: { readText: () => ({ text: 'x\nx\n', bytes: 4, sizeBytes: 4, mode: '644' }) }
  })
  await assert.rejects(
    () => handlers.edit({ sessionId: 's', path: '/f', oldString: 'zzz', newString: 'y' }),
    error => error.kind === 'not-found'
  )
  await assert.rejects(
    () => handlers.edit({ sessionId: 's', path: '/f', oldString: 'x', newString: 'y' }),
    error => error.kind === 'not-unique' && /2 次/.test(error.message)
  )
  assert.equal(exec.calls.some(call => call.kind === 'writeText'), false)
})

test('ssh_edit：replaceAll 全量替换并报数量', async () => {
  const { handlers, exec } = make({
    overrides: { readText: () => ({ text: 'x\nx\nx\n', bytes: 6, sizeBytes: 6, mode: '644' }) }
  })
  const result = await handlers.edit({ sessionId: 's', path: '/f', oldString: 'x', newString: 'y', replaceAll: true })
  assert.equal(result.replacements, 3)
  assert.equal(exec.calls.find(call => call.kind === 'writeText').content, 'y\ny\ny\n')
})

test('ssh_edit：oldString 为空拒绝', async () => {
  const { handlers } = make()
  await assert.rejects(
    () => handlers.edit({ sessionId: 's', path: '/f', oldString: '', newString: 'y' }),
    error => error.kind === 'invalid-args'
  )
})

test('ssh_ls：默认用 defaultWorkdir；没有则要求给 path', async () => {
  const { handlers, exec } = make()
  await handlers.ls({ sessionId: 's', host: 'web-01' })
  assert.equal(exec.calls[0].path, '/srv/app')
  await assert.rejects(() => handlers.ls({ sessionId: 's', host: 'db-01' }), error => error.kind === 'invalid-args')
  await handlers.ls({ sessionId: 's', host: 'db-01', path: '/var/log' })
  assert.equal(exec.calls.at(-1).path, '/var/log')
})

test('传输层失败被翻译成可照做的提示，并带上主机名', async () => {
  const { handlers } = make({
    overrides: { run: () => { throw new SshExecError('auth', 'ssh web-01 失败（255）：Permission denied (publickey).') } }
  })
  await assert.rejects(
    () => handlers.run({ sessionId: 's', host: 'web-01', command: 'uptime' }),
    error => error instanceof ToolFailure && error.kind === 'auth' && error.message.startsWith('[web-01]') && /ssh-add/.test(error.message)
  )
})

test('会话 id 缺失时不炸（CLI/子 agent 场景）', async () => {
  const { handlers } = make({ cfg: { defaultHost: 'web-01' } })
  assert.equal((await handlers.run({ command: 'uptime' })).host, 'web-01')
  assert.deepEqual(await handlers.useHost({}), { host: 'web-01', source: 'config' })
})

test('listHosts：defaultHost 报「本次调用实际会用的那台」，会话默认优先', async () => {
  const { handlers, state } = make({ cfg: { defaultHost: 'db-01' } })
  // 没给 sessionId：维持老语义（全局默认 → config）
  const global = await handlers.listHosts()
  assert.equal(global.defaultHost, 'db-01')
  assert.equal(global.defaultSource, 'config')

  state.set('s-1', 'web-01')
  const scoped = await handlers.listHosts({ sessionId: 's-1' })
  assert.equal(scoped.defaultHost, 'web-01')
  assert.equal(scoped.defaultSource, 'session')

  // 别的会话看不到这台会话的选择
  const other = await handlers.listHosts({ sessionId: 's-2' })
  assert.equal(other.defaultHost, 'db-01')
  assert.equal(other.defaultSource, 'config')

  // 会话默认指向已经删掉的主机：忽略，继续按下一档
  state.set('s-3', 'gone')
  const stale = await handlers.listHosts({ sessionId: 's-3' })
  assert.equal(stale.defaultHost, 'db-01')
  assert.equal(stale.defaultSource, 'config')

  // 会话默认与 effectiveHost 完全一致（模型看到的默认 == 实际会用的机器）
  assert.equal(handlers.effectiveHost('s-1').name, scoped.defaultHost)
  assert.equal(handlers.effectiveHost('s-2').name, other.defaultHost)
})
