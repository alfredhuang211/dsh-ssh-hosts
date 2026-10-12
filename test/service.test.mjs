/** 界面可管理的运行时：热重载、写入回滚、只读内联清单。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { loadHosts } from '../lib/hosts.js'
import { createSessionState } from '../lib/session-state.js'
import { createHostService, liveHandlers, UiFailure } from '../lib/service.js'
import { writeHostsText } from '../lib/hosts-doc.js'

const FILE_BODY = 'version: 1\nhosts:\n  - name: web-01\n    host: 10.0.0.11\n    user: deploy\n'

/** 每个用例一个临时目录：真文件、真权限、真 rename */
function setup({ hosts = FILE_BODY, cfg = {}, exec, credentials } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-service-'))
  const file = join(dir, 'ssh-hosts.yaml')
  if (hosts !== null) writeHostsText(file, hosts)
  const calls = []
  const fakeExec = exec ?? {
    async run(host, options) {
      calls.push({ host: host.name, command: options.command })
      return { exitCode: 0, stdout: 'Linux 5.4 x86_64\nubuntu\n/home/ubuntu\n', stderr: '', truncated: {} }
    }
  }
  const state = createSessionState({ file: join(dir, 'state.json') })
  const service = createHostService({
    cfg: normalizeConfig({ ...cfg, hostsFile: file }),
    hostsFile: file,
    state,
    exec: fakeExec,
    logger: () => {},
    credentials: credentials === undefined ? () => undefined : () => credentials
  })
  service.install()
  return {
    dir, file, state, service, calls,
    read: () => readFileSync(file, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

test('install + list：读文件、可写、无默认主机', async () => {
  const t = setup()
  try {
    const view = await t.service.list()
    assert.equal(view.writable, true)
    assert.equal(view.file, t.file)
    assert.equal(view.hosts.length, 1)
    assert.equal(view.hosts[0].name, 'web-01')
    assert.equal(view.hosts[0].host, '10.0.0.11')
    assert.equal(view.defaultHost, '')
    assert.equal(view.fileInfo.mode, '0600')
    assert.equal(view.error, null)
  } finally {
    t.cleanup()
  }
})

test('清单文件不存在：从空清单起，界面负责把它建出来', async () => {
  const t = setup({ hosts: null })
  try {
    const view = await t.service.list()
    assert.equal(view.writable, true)
    assert.deepEqual(view.hosts, [])
    assert.equal(view.fileInfo.exists, false)
    assert.match(view.error, /主机清单不存在/)
    // 空清单时工具照常工作，只是没有目标机
    const listed = await t.service.live.listHosts({})
    assert.equal(listed.total, 0)
    await assert.rejects(() => t.service.live.run({ command: 'true', sessionId: 's1' }), /还没有配置任何 SSH 主机/)
    // 界面上新增一台就会创建文件
    const result = await t.service.upsert({ name: 'first-01', host: '10.0.0.5' })
    assert.equal(result.total, 1)
    assert.equal((await t.service.list()).fileInfo.exists, true)
    assert.equal((await t.service.list()).error, null)
  } finally {
    t.cleanup()
  }
})

test('upsert：新增落到文件，工具侧立刻能看到（不用重启）', async () => {
  const t = setup()
  try {
    const result = await t.service.upsert({ name: 'db-01', host: '10.0.0.12', user: 'dba', tags: ['prod'], readOnly: true })
    assert.equal(result.action, 'added')
    assert.equal(result.total, 2)
    const onDisk = t.read()
    assert.match(onDisk, /name: db-01/)
    assert.match(onDisk, /readOnly: true/)
    const listed = await t.service.live.listHosts({})
    // 工具侧按名称排序（finalizeHosts），文件里保持用户输入顺序
    assert.deepEqual(listed.hosts.map(host => host.name), ['db-01', 'web-01'])
    assert.equal(listed.total, 2)
    // 顺序保持：新主机追加在末尾
    assert.equal((await t.service.list()).hosts[1].name, 'db-01')
  } finally {
    t.cleanup()
  }
})

test('upsert：previousName 改名，不留下旧条目', async () => {
  const t = setup()
  try {
    await t.service.upsert({ name: 'web-02', host: '10.0.0.11', user: 'deploy' }, { previousName: 'web-01' })
    const names = (await t.service.list()).hosts.map(host => host.name)
    assert.deepEqual(names, ['web-02'])
    assert.doesNotMatch(t.read(), /web-01/)
  } finally {
    t.cleanup()
  }
})

test('remove：删除条目，并清掉指向它的默认主机', async () => {
  const t = setup()
  try {
    t.service.setDefault('web-01')
    assert.equal(t.state.getDefault(), 'web-01')
    const result = await t.service.remove('web-01')
    assert.equal(result.total, 0)
    assert.equal(result.clearedDefault, true)
    assert.equal(t.state.getDefault(), null)
    const listed = await t.service.live.listHosts({})
    assert.equal(listed.total, 0)
    assert.deepEqual(listed.hosts, [])
  } finally {
    t.cleanup()
  }
})

test('remove：不存在的主机报 unknown-host', async () => {
  const t = setup()
  try {
    await assert.rejects(() => t.service.remove('nope'), error => error instanceof UiFailure && error.kind === 'unknown-host')
  } finally {
    t.cleanup()
  }
})

test('setDefault：写进状态文件，工具据此解析主机（来源 default）', async () => {
  const t = setup()
  try {
    assert.throws(() => t.service.setDefault('nope'), /清单里没有主机/)
    t.service.setDefault('web-01')
    assert.equal((await t.service.list()).defaultHost, 'web-01')
    assert.equal(t.state.getDefault(), 'web-01')
    const used = await t.service.live.useHost({ sessionId: 's1' })
    assert.deepEqual(used, { host: 'web-01', source: 'default' })
    // 省略 host 的调用真的落到这台机器上
    await t.service.live.run({ command: 'uname -a', sessionId: 's1' })
    assert.equal(t.calls.at(-1).host, 'web-01')
    t.service.setDefault('')
    assert.equal(t.state.getDefault(), null)
  } finally {
    t.cleanup()
  }
})

test('config.hosts 内联声明时界面只读', async () => {
  const t = setup({
    hosts: null,
    cfg: { hosts: [{ name: 'inline-01', host: '10.0.0.99' }] }
  })
  try {
    const view = await t.service.list()
    assert.equal(view.writable, false)
    assert.match(view.reason, /config/)
    assert.deepEqual(view.hosts.map(host => host.name), ['inline-01'])
    await assert.rejects(() => t.service.upsert({ name: 'x', host: '1.1.1.1' }), error =>
      error instanceof UiFailure && error.kind === 'read-only')
    await assert.rejects(() => t.service.remove('inline-01'), error =>
      error instanceof UiFailure && error.kind === 'read-only')
    assert.equal(t.service.setDefault('inline-01').defaultHost, 'inline-01')
  } finally {
    t.cleanup()
  }
})

test('校验失败：文件一个字节都不动', async () => {
  const t = setup()
  try {
    const before = t.read()
    await assert.rejects(() => t.service.upsert({ name: 'bad name', host: '1.1.1.1' }), /不合法/)
    await assert.rejects(() => t.service.upsert({ name: 'x', host: '1.1.1.1', nope: 1 }), /未知字段/)
    await assert.rejects(() => t.service.upsert({ name: 'x', host: '1.1.1.1', identityFile: '/no/such/key' }), /identityFile 不存在/)
    await assert.rejects(() => t.service.upsert({ host: '1.1.1.1' }), /必须提供主机名/)
    await assert.rejects(() => t.service.upsert({ name: 'dup', host: '1.1.1.1', readOnly: 'yes' }), /readOnly 必须是布尔值/)
    assert.equal(t.read(), before)
    assert.deepEqual((await t.service.list()).hosts.map(host => host.name), ['web-01'])
  } finally {
    t.cleanup()
  }
})

test('重名：finalizeHosts 会拦下重复名称', async () => {
  const t = setup()
  try {
    writeHostsText(t.file, 'version: 1\nhosts:\n  - name: dup\n    host: 10.0.0.1\n')
    t.service.reload()
    await assert.rejects(() => t.service.upsert({ name: 'dup', host: '10.0.0.2' }, { previousName: 'other' }), /重复|dup/)
  } finally {
    t.cleanup()
  }
})

test('写后重载失败：回滚文件并保留旧清单', async () => {
  const t = setup()
  try {
    const before = t.read()
    let calls = 0
    const flaky = createHostService({
      cfg: normalizeConfig({ hostsFile: t.file }),
      hostsFile: t.file,
      state: t.state,
      exec: { async run() { return { exitCode: 0, stdout: '', stderr: '' } } },
      logger: () => {},
      reloadHosts: options => {
        calls += 1
        // 第 2 次是「写入后重载」，故意失败；之后回滚时的重载恢复正常
        if (calls === 2) throw new Error('磁盘读回失败')
        return loadHosts(options)
      }
    })
    flaky.install()
    await assert.rejects(() => flaky.upsert({ name: 'new-01', host: '10.0.0.50' }), error =>
      error instanceof UiFailure && error.kind === 'reload-failed')
    assert.equal(t.read(), before)
    assert.deepEqual((await flaky.list()).hosts.map(host => host.name), ['web-01'])
  } finally {
    t.cleanup()
  }
})

test('reload：手工改文件后重新读取；坏文件保留旧清单并记错', async () => {
  const t = setup()
  try {
    writeHostsText(t.file, 'version: 1\nhosts:\n  - name: web-01\n    host: 10.0.0.11\n  - name: db-01\n    host: 10.0.0.12\n')
    const reloaded = t.service.reload()
    assert.equal(reloaded.ok, true)
    assert.equal(reloaded.hosts, 2)

    writeHostsText(t.file, 'version: 1\nhosts: "nope"\n')
    const failed = t.service.reload()
    assert.equal(failed.ok, false)
    assert.match(failed.error, /需要 \{ version: 1, hosts: \[\.\.\.\] \} 或顶层数组/)
    // 旧清单继续可用，错误显示在界面上；这一份退回工具用的归一化顺序（按名称）
    const view = await t.service.list()
    assert.deepEqual(view.hosts.map(host => host.name), ['db-01', 'web-01'])
    assert.match(view.error, /需要 \{ version: 1, hosts: \[\.\.\.\] \} 或顶层数组/)
  } finally {
    t.cleanup()
  }
})

test('test()：界面上的连通性测试', async () => {
  const t = setup()
  try {
    const result = await t.service.test('web-01')
    assert.equal(result.ok, true)
    assert.match(result.stdout, /Linux/)
    assert.equal(t.calls.at(-1).host, 'web-01')
    await assert.rejects(() => t.service.test('nope'), /清单里没有主机/)

    const broken = setup({
      exec: { async run() { throw Object.assign(new Error('连接被拒绝'), { kind: 'refused' }) } }
    })
    try {
      await assert.rejects(() => broken.service.test('web-01'), error =>
        error instanceof UiFailure && error.kind === 'refused')
    } finally {
      broken.cleanup()
    }
  } finally {
    t.cleanup()
  }
})

test('liveHandlers：调用始终落到当前一份 handlers', async () => {
  const first = { async listHosts() { return { source: 'first' } }, hostNames: ['a'] }
  const second = { async listHosts() { return { source: 'second' } }, hostNames: ['b'] }
  let current = first
  const live = liveHandlers(() => current)
  assert.equal((await live.listHosts({})).source, 'first')
  assert.deepEqual(live.hostNames, ['a'])
  current = second
  assert.equal((await live.listHosts({})).source, 'second')
  assert.deepEqual(live.hostNames, ['b'])
})

/** 假凭据库：只记名字和值，够断言「值没进清单、名字进了清单」 */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = []
  return {
    store,
    calls,
    async resolve(ref) {
      calls.push(['resolve', ref])
      return store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined
    },
    async describe(ref) {
      calls.push(['describe', ref])
      return { configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true }
    },
    async set(ref, value) {
      calls.push(['set', ref])
      store.set(ref, value)
    },
    async unset(ref) {
      calls.push(['unset', ref])
      store.delete(ref)
    }
  }
}

test('界面填密码：值进凭据库，清单里只有 passwordRef（绝无明文）', async () => {
  const credentials = fakeCredentials()
  const t = setup({ credentials })
  try {
    const result = await t.service.upsert(
      { name: 'pw-01', host: '10.0.0.21', user: 'root' },
      { password: 'hunter2' })
    assert.equal(result.password, 'set')
    assert.equal(result.passwordRef, 'DSH_SSH_HOSTS_PASSWORD_PW_01')
    assert.equal(credentials.store.get('DSH_SSH_HOSTS_PASSWORD_PW_01'), 'hunter2')

    const onDisk = t.read()
    assert.match(onDisk, /passwordRef: DSH_SSH_HOSTS_PASSWORD_PW_01/)
    assert.equal(onDisk.includes('hunter2'), false, '明文密码绝不能落到清单文件里')

    const view = await t.service.list()
    const row = view.hosts.find(host => host.name === 'pw-01')
    assert.equal(row.passwordConfigured, true)
    assert.equal(row.passwordSource, 'file')
    assert.equal(view.passwordSupported, true)
    // 界面上也拿不到值
    assert.equal(JSON.stringify(view).includes('hunter2'), false)
  } finally {
    t.cleanup()
  }
})

test('界面改密码：沿用同一个凭据名并替换值；不改则保持', async () => {
  const credentials = fakeCredentials()
  const t = setup({ credentials })
  try {
    await t.service.upsert({ name: 'pw-01', host: '10.0.0.21' }, { password: 'first' })
    const ref = 'DSH_SSH_HOSTS_PASSWORD_PW_01'

    // 只改备注、不碰密码：值不动
    const kept = await t.service.upsert({ name: 'pw-01', host: '10.0.0.21', description: '改个备注', passwordRef: ref })
    assert.equal(kept.password, 'unchanged')
    assert.equal(credentials.store.get(ref), 'first')

    // 填新密码：同一个名字，值被替换
    const replaced = await t.service.upsert({ name: 'pw-01', host: '10.0.0.21', passwordRef: ref }, { password: 'second' })
    assert.equal(replaced.password, 'replaced')
    assert.equal(credentials.store.get(ref), 'second')
    const row = (await t.service.list()).hosts.find(host => host.name === 'pw-01')
    assert.equal(row.passwordConfigured, true)
  } finally {
    t.cleanup()
  }
})

test('界面清除密码：凭据被删，passwordRef 从清单里摘掉', async () => {
  const credentials = fakeCredentials()
  const t = setup({ credentials })
  try {
    await t.service.upsert({ name: 'pw-01', host: '10.0.0.21' }, { password: 'hunter2' })
    const cleared = await t.service.upsert({ name: 'pw-01', host: '10.0.0.21' }, { clearPassword: true })
    assert.equal(cleared.password, 'cleared')
    assert.equal(cleared.passwordRef, '')
    assert.equal(credentials.store.size, 0)
    assert.equal(t.read().includes('passwordRef'), false)
    const row = (await t.service.list()).hosts.find(host => host.name === 'pw-01')
    assert.equal(row.passwordConfigured, false)
  } finally {
    t.cleanup()
  }
})

test('删主机顺手清掉它的密码凭据', async () => {
  const credentials = fakeCredentials()
  const t = setup({ credentials })
  try {
    await t.service.upsert({ name: 'pw-01', host: '10.0.0.21' }, { password: 'hunter2' })
    const removed = await t.service.remove('pw-01')
    assert.equal(removed.clearedPassword, true)
    assert.equal(credentials.store.size, 0)
  } finally {
    t.cleanup()
  }
})

test('没有 credentials 服务：存密码报 unsupported（501），其余功能照常', async () => {
  const t = setup()
  try {
    await assert.rejects(
      () => t.service.upsert({ name: 'pw-01', host: '10.0.0.21' }, { password: 'hunter2' }),
      error => error instanceof UiFailure && error.kind === 'unsupported' && /credentials/.test(error.message))
    // 清单没被改动
    assert.equal(t.read().includes('pw-01'), false)
    // 纯密钥主机照常可加
    const added = await t.service.upsert({ name: 'key-01', host: '10.0.0.31' })
    assert.equal(added.action, 'added')
    const view = await t.service.list()
    assert.equal(view.passwordSupported, false)
    assert.equal(view.hosts.every(host => host.passwordConfigured === false), true)
  } finally {
    t.cleanup()
  }
})

test('清单里的 passwordRef 不会被当成明文，界面只回「有没有」', async () => {
  const credentials = fakeCredentials({ DSH_SSH_HOSTS_PASSWORD_WEB_01: 'secret-value' })
  const t = setup({
    hosts: 'version: 1\nhosts:\n  - name: web-01\n    host: 10.0.0.11\n    user: deploy\n    passwordRef: DSH_SSH_HOSTS_PASSWORD_WEB_01\n',
    credentials
  })
  try {
    const view = await t.service.list()
    assert.equal(view.hosts[0].passwordConfigured, true)
    assert.equal(view.hosts[0].passwordWritable, true)
    assert.equal(JSON.stringify(view).includes('secret-value'), false)
    // 工具侧投影只给 auth 摘要
    const listed = await t.service.live.listHosts({})
    assert.equal(listed.hosts[0].auth, 'password')
    assert.equal(JSON.stringify(listed).includes('secret-value'), false)
    assert.equal(JSON.stringify(listed).includes('DSH_SSH_HOSTS_PASSWORD_WEB_01'), false)
  } finally {
    t.cleanup()
  }
})

test('界面不再引用密码（没回传 passwordRef）时，凭据不会留成孤儿', async () => {
  const credentials = fakeCredentials()
  const t = setup({ credentials })
  try {
    await t.service.upsert({ name: 'pw-01', host: '10.0.0.21' }, { password: 'hunter2' })
    const dropped = await t.service.upsert({ name: 'pw-01', host: '10.0.0.21' })
    assert.equal(dropped.password, 'cleared')
    assert.equal(credentials.store.size, 0)
    assert.equal(t.read().includes('passwordRef'), false)
  } finally {
    t.cleanup()
  }
})
