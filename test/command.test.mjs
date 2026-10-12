/**
 * `/ssh` 命令：会话窗口「+」菜单里那一行背后的 host 侧逻辑。
 *
 * 这里不启动真实 cordis：`commands.register` 换成记录器，直接拿到
 * CommandDefinition 再调 handler —— 与 tools 测试同一套路数。状态用的是
 * 真实 createSessionState + 真实 createHandlers，所以「命令选的机器 ==
 * ssh_use 选的机器 == 工具下一次实际用的机器」这条链是被真实验证过的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COMMAND_NAME, registerSshCommand } from '../lib/command.js'
import { createHandlers } from '../lib/handlers.js'
import { createSessionState } from '../lib/session-state.js'

/** 假 commands 服务：只记定义 */
function fakeCommands() {
  const definitions = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      return () => { definitions.splice(definitions.indexOf(definition), 1) }
    }
  }
}

const HOSTS = [
  {
    name: 'web-01', host: '10.0.0.11', port: 22, user: 'deploy', identityFile: '',
    proxyJump: '', defaultWorkdir: '/srv/app', description: '生产 Web', tags: ['prod', 'web'],
    connectTimeoutSec: 10, keepAliveSec: 0, readOnly: false, jump: undefined
  },
  {
    name: 'db-01', host: '10.0.0.12', port: 2222, user: 'readonly', identityFile: '',
    proxyJump: '', defaultWorkdir: '', description: '只读巡检', tags: ['prod', 'db'],
    connectTimeoutSec: 10, keepAliveSec: 0, readOnly: true, jump: undefined
  }
]

function setup({ hosts = HOSTS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-cmd-'))
  const state = createSessionState({ file: join(dir, 'state.json') })
  const handlers = createHandlers({
    cfg: { maxReadBytes: 1024, allow: [], deny: [], defaultHost: '', hostsFile: '' },
    hosts,
    source: 'test',
    exec: { /* 命令只读写清单与会话状态，不碰 ssh */ },
    state,
    logger: () => {}
  })
  const commands = fakeCommands()
  registerSshCommand(commands, { live: handlers, state, logger: () => {} })
  return {
    dir, state, handlers, commands,
    definition: commands.definitions[0],
    run: (rawInput, sessionId = 's-1') => commands.definitions[0].handler({
      commandId: 'c-1',
      agent: { session: { id: sessionId } },
      rawInput,
      signal: new AbortController().signal
    }),
    cleanup() { rmSync(dir, { recursive: true, force: true }) }
  }
}

test('注册成一条命令：名字、描述、参数提示齐全（「+」菜单那一行就靠这些）', () => {
  const t = setup()
  try {
    assert.equal(t.commands.definitions.length, 1)
    assert.equal(t.definition.name, COMMAND_NAME)
    assert.equal(t.definition.name, 'ssh')
    assert.match(t.definition.description, /本会话默认 SSH 主机/)
    assert.deepEqual(t.definition.input, { hint: '<主机名>' })
    assert.equal(typeof t.definition.handler, 'function')
  } finally {
    t.cleanup()
  }
})

test('裸 /ssh：报当前会话默认主机与可用主机（CLI / 无弹窗客户端用得上）', async () => {
  const t = setup()
  try {
    const empty = await t.run('')
    assert.equal(empty.kind, 'success')
    assert.match(empty.text, /还没有默认主机/)
    assert.match(empty.text, /web-01, db-01/)

    await t.run(' web-01 ')   // 前后空格由 handler 自己 trim
    const withDefault = await t.run('')
    assert.equal(withDefault.kind, 'success')
    assert.match(withDefault.text, /本会话默认主机：web-01/)
    assert.match(withDefault.text, /deploy@10\.0\.0\.11/)
    assert.match(withDefault.text, /prod\/web/)
  } finally {
    t.cleanup()
  }
})

test('/ssh <主机名>：写进会话状态，并且工具侧立刻用这台（与 ssh_use 同一条路径）', async () => {
  const t = setup()
  try {
    const result = await t.run('db-01')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /本会话默认主机：db-01/)
    assert.match(result.text, /readonly@10\.0\.0\.12:2222/)
    assert.match(result.text, /只读/)
    assert.equal(t.state.get('s-1'), 'db-01')
    // 工具侧的解析结果必须跟着变：命令选的机器就是下一次 ssh_run 的机器
    assert.equal(t.handlers.effectiveHost('s-1').name, 'db-01')
    // 会话隔离：别的会话不受影响（没默认机时按设计直接报 no-host）
    assert.equal(t.state.get('s-2'), null)
    assert.throws(() => t.handlers.effectiveHost('s-2'), error => error.kind === 'no-host')
  } finally {
    t.cleanup()
  }
})

test('/ssh clear：清掉本会话默认主机，之后要显式给 host', async () => {
  const t = setup()
  try {
    await t.run('web-01')
    for (const word of ['clear', 'CLEAR', '-', 'none']) {
      await t.run('web-01')
      const result = await t.run(word)
      assert.equal(result.kind, 'success', `${word} 应当被当成清除`)
      assert.match(result.text, /已清除本会话默认主机/)
      assert.equal(t.state.get('s-1'), null)
    }
  } finally {
    t.cleanup()
  }
})

test('未知主机 / 多词参数：报错并给出可用主机，绝不静默忽略', async () => {
  const t = setup()
  try {
    const unknown = await t.run('web-02')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /未知主机 "web-02"/)
    assert.match(unknown.text, /可用：web-01, db-01/)

    const tooMany = await t.run('web-01 uptime')
    assert.equal(tooMany.kind, 'error')
    assert.match(tooMany.text, /用法：\/ssh <主机名>/)
    assert.equal(t.state.get('s-1'), null, '用法错误不该写状态')
  } finally {
    t.cleanup()
  }
})

test('清单为空时给出可照做的提示', async () => {
  const t = setup({ hosts: [] })
  try {
    const bare = await t.run('')
    assert.equal(bare.kind, 'success')
    assert.match(bare.text, /还没有配置任何主机/)

    const named = await t.run('web-01')
    assert.equal(named.kind, 'error')
    assert.match(named.text, /还没有配置任何主机/)
    assert.match(named.text, /设置 → SSH 主机/)
  } finally {
    t.cleanup()
  }
})

test('没有 agent 的极端情况：不崩，状态写不进去但结果仍可读', async () => {
  const t = setup()
  try {
    const result = await t.definition.handler({ commandId: 'c', rawInput: 'web-01', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.equal(t.state.get(undefined), null)
  } finally {
    t.cleanup()
  }
})

test('register 的释放函数来自 commands.register（fiber 卸载时命令一起消失）', () => {
  const commands = fakeCommands()
  const t = setup()
  try {
    const dispose = registerSshCommand(commands, { live: t.handlers, state: t.state })
    assert.equal(commands.definitions.length, 1)
    dispose()
    assert.equal(commands.definitions.length, 0)
  } finally {
    t.cleanup()
  }
})

/**
 * 宿主（packages/interaction/commands）注册时会校验定义与结果：
 *   COMMAND_NAME = /^[a-z][a-z0-9_-]*$/；description/handler 必填；
 *   input.hint 必须是非空字符串；error 结果的 text 必须是非空字符串。
 * 这里把那套约束照抄成断言 —— 依赖不在插件里，但契约必须钉住。
 */
test('契约：定义与结果符合宿主 commands 注册时的校验', async () => {
  const t = setup()
  try {
    const definition = t.definition
    assert.match(definition.name, /^[a-z][a-z0-9_-]*$/)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.trim().length > 0)
    assert.equal(typeof definition.handler, 'function')
    assert.equal(typeof definition.input.hint, 'string')
    assert.ok(definition.input.hint.trim().length > 0)

    const cases = [await t.run(''), await t.run('web-01'), await t.run('nope'), await t.run('a b'), await t.run('clear')]
    for (const result of cases) {
      assert.ok(result.kind === 'success' || result.kind === 'error', `未知结果类型：${JSON.stringify(result)}`)
      if (result.text !== undefined) assert.equal(typeof result.text, 'string')
      if (result.kind === 'error') assert.ok(result.text.trim().length > 0, 'error 结果必须有非空文本')
    }
  } finally {
    t.cleanup()
  }
})
