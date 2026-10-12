/**
 * 契约层验证：真实的 @deepseek-ai/dsh-tools + 真实的 cordis。
 *
 * 分两级：
 *  1. 假注册表 + 真 defineTool —— 校验参数/输出规格能被 harness 接受；
 *  2. 真 cordis 装载（SystemPrompt + ToolRuntime + 本插件）—— 校验
 *     inject/effect 生命周期与 `ctx.tools.get()` 的可达性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createFakeRegistry, executionContext } from './harness.mjs'
import { createHandlers } from '../lib/handlers.js'
import { createSessionState } from '../lib/session-state.js'
import { registerTools } from '../lib/tools.js'
import * as plugin from '../lib/index.js'

const TOOL_NAMES = ['ssh_hosts', 'ssh_use', 'ssh_run', 'ssh_read', 'ssh_write', 'ssh_edit', 'ssh_ls']

/** 在测试工作区里造一把合法的（0600）私钥与一份主机清单 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-loader-'))
  const key = join(dir, 'id_ed25519')
  writeFileSync(key, 'PRIVATE KEY\n')
  chmodSync(key, 0o600)
  const hostsFile = join(dir, 'ssh-hosts.yaml')
  writeFileSync(hostsFile, `version: 1
hosts:
  - name: web-01
    host: 10.0.0.1
    user: ubuntu
    identityFile: ${key}
    defaultWorkdir: /srv/app
`)
  chmodSync(hostsFile, 0o600)
  return { dir, key, hostsFile, stateFile: join(dir, 'ssh-hosts.state.json') }
}

function fakeExec() {
  const calls = []
  return {
    calls,
    async run(host, options) {
      calls.push({ kind: 'run', ...options, host: host.name })
      return { exitCode: 0, stdout: 'ok\n', stderr: '', truncated: { stdout: false, stderr: false }, durationMs: 1 }
    },
    async readText() {
      return { text: 'x', bytes: 1, sizeBytes: 1, mode: '644' }
    },
    async writeText() {
      return { bytes: 1, created: false, mode: '644' }
    },
    async list() {
      return { entries: [], truncated: false }
    },
    async dispose() {}
  }
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 40))
}

test('defineTool 接受全部 7 个工具的参数与输出规格', () => {
  const { ctx, definitions } = createFakeRegistry()
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-tools-'))
  const state = createSessionState({ file: join(dir, 'state.json') })
  const handlers = createHandlers({
    cfg: { maxReadBytes: 1024 * 1024, allow: [], deny: [], defaultHost: 'web-01', hostsFile: '' },
    hosts: [{ name: 'web-01', host: '10.0.0.1', port: 22, user: 'ubuntu', identityFile: '/k', proxyJump: '', defaultWorkdir: '/srv/app', description: '', tags: [], connectTimeoutSec: 0, keepAliveSec: 0, readOnly: false, jump: undefined }],
    source: 'test',
    exec: fakeExec(),
    state
  })

  const dispose = registerTools(ctx, handlers)
  assert.deepEqual([...definitions.keys()].sort(), [...TOOL_NAMES].sort())

  for (const name of TOOL_NAMES) {
    const definition = definitions.get(name)
    assert.equal(definition.name, name)
    assert.ok(definition.description.length > 20, `${name} 的 description 太短`)
    assert.doesNotThrow(() => assertObjectJsonSchema(definition.output.schema), `${name} 的输出 schema 不合法`)
    assert.equal(typeof definition.output.render, 'function')
  }

  // 参数必填/类型校验真的生效（参数 schema 不设 additionalProperties:false，与 harness 一致）
  const run = definitions.get('ssh_run')
  assert.equal(run.parameters.type, 'object')
  assert.ok(run.parameters.required.includes('command'))
  assert.deepEqual(validateJsonSchemaValue(run.parameters, { command: 'uptime' }), [])
  assert.ok(validateJsonSchemaValue(run.parameters, {}).length > 0, '缺 command 应被拒绝')
  assert.ok(validateJsonSchemaValue(run.parameters, { command: 1 }).length > 0, 'command 类型不对应被拒绝')

  dispose()
  assert.equal(definitions.size, 0)
})

test('工具执行结果符合各自的输出 schema', async () => {
  const { ctx, definitions } = createFakeRegistry()
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-tools-'))
  const state = createSessionState({ file: join(dir, 'state.json') })
  const exec = fakeExec()
  const handlers = createHandlers({
    cfg: { maxReadBytes: 1024 * 1024, allow: [], deny: [], defaultHost: 'web-01', hostsFile: '' },
    hosts: [{ name: 'web-01', host: '10.0.0.1', port: 22, user: 'ubuntu', identityFile: '/k', proxyJump: '', defaultWorkdir: '/srv/app', description: '', tags: [], connectTimeoutSec: 0, keepAliveSec: 0, readOnly: false, jump: undefined }],
    source: 'test',
    exec,
    state
  })
  registerTools(ctx, handlers)

  const hostsValue = await definitions.get('ssh_hosts').execute({}, executionContext())
  assert.deepEqual(validateJsonSchemaValue(definitions.get('ssh_hosts').output.schema, hostsValue), [])
  assert.equal(hostsValue.hosts[0].name, 'web-01')

  const useValue = await definitions.get('ssh_use').execute({ host: 'web-01' }, executionContext('s1'))
  assert.deepEqual(validateJsonSchemaValue(definitions.get('ssh_use').output.schema, useValue), [])
  assert.deepEqual(useValue, { host: 'web-01', source: 'ssh_use' })

  const runValue = await definitions.get('ssh_run').execute({ command: 'uptime' }, executionContext('s1'))
  assert.deepEqual(validateJsonSchemaValue(definitions.get('ssh_run').output.schema, runValue), [])
  assert.equal(runValue.host, 'web-01')
  assert.equal(runValue.exitCode, 0)

  const listValue = await definitions.get('ssh_ls').execute({}, executionContext('s1'))
  assert.deepEqual(validateJsonSchemaValue(definitions.get('ssh_ls').output.schema, listValue), [])

  // 参数层面的错误以 ToolFailure 抛出（运行时负责翻成 isError 结果）
  await assert.rejects(() => definitions.get('ssh_run').execute({ command: '  ' }, executionContext('s1')), /command/)

  // 没给 host 时用 config.defaultHost，不需要调用方重复指定
  const readValue = await definitions.get('ssh_read').execute({ path: '/etc/hosts' }, executionContext('s1'))
  assert.equal(readValue.host, 'web-01')
  assert.deepEqual(validateJsonSchemaValue(definitions.get('ssh_read').output.schema, readValue), [])

  // render 必须产出 text block（模型看到的就是它）
  const blocks = definitions.get('ssh_run').output.render({ command: 'uptime' }, runValue)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /\[web-01\] exit 0/)
})

test('在真实 cordis 里装载：tools 服务上能看到 7 个工具', async () => {
  const { dir, hostsFile, stateFile } = fixture()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const ctx = new Context()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(plugin, { hostsFile })
    await settle()

    for (const name of TOOL_NAMES) {
      const definition = ctx.tools.get(name)
      assert.ok(definition !== undefined, `${name} 未注册`)
      assert.equal(definition.name, name)
    }
    assert.ok(ctx.tools.schemas().some(schema => schema.name === 'ssh_run'))
    assert.ok(stateFile.includes(dir))
    await ctx.stop?.()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('清单缺失时装载不失败：从空清单起，让界面/工具引导用户创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-loader-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const ctx = new Context()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(plugin, { hostsFile: join(dir, 'nope.yaml') })
    await settle()
    // 工具都在；清单为空时给的是引导语而不是「插件起不来」
    assert.ok(ctx.tools.get('ssh_run') !== undefined)
    const value = await ctx.tools.get('ssh_hosts').execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(value.total, 0)
    assert.deepEqual(value.hosts, [])
    await ctx.fiber.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('清单存在但坏掉时装载当场失败，而不是等到模型调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-loader-'))
  const hostsFile = join(dir, 'broken.yaml')
  writeFileSync(hostsFile, 'version: 1\nhosts: "nope"\n', { mode: 0o600 })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const ctx = new Context()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(plugin, { hostsFile })
    await settle()
    assert.equal(ctx.tools.get('ssh_run'), undefined)
    await ctx.fiber.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
