/**
 * 真实服务器集成测试（默认跳过）。
 *
 *   DSH_SSH_HOSTS_REMOTE=1 node --test test/remote.test.mjs
 *
 * 默认目标是在用的测试机；可用环境变量覆盖：
 *   DSH_SSH_HOSTS_REMOTE_HOST / _USER / _PORT / _KEY / _KNOWN_HOSTS / _STRICT
 *
 * 密码认证那一条要显式给密码（只从环境变量读，绝不落盘、绝不写进仓库）：
 *   DSH_SSH_HOSTS_REMOTE_PASSWORD='...' DSH_SSH_HOSTS_REMOTE=1 node --test test/remote.test.mjs
 *
 * 前置条件：目标机 ~/.ssh/authorized_keys 里已经有 .test-keys/id_ed25519.pub
 * （见 README 的「测试机准备」）。全程只用密钥，不落任何密码。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExec } from '../lib/exec.js'
import { createHandlers } from '../lib/handlers.js'
import { createSessionState } from '../lib/session-state.js'

const ROOT = join(import.meta.dirname, '..')
const ENABLED = process.env.DSH_SSH_HOSTS_REMOTE === '1'
const HOSTNAME = process.env.DSH_SSH_HOSTS_REMOTE_HOST ?? 'test-host.example.com'
const USER = process.env.DSH_SSH_HOSTS_REMOTE_USER ?? 'ubuntu'
const PORT = Number(process.env.DSH_SSH_HOSTS_REMOTE_PORT ?? 22)
const KEY = process.env.DSH_SSH_HOSTS_REMOTE_KEY ?? join(ROOT, '.test-keys', 'id_ed25519')
const KNOWN_HOSTS = process.env.DSH_SSH_HOSTS_REMOTE_KNOWN_HOSTS ?? join(ROOT, '.test-keys', 'known_hosts')
const STRICT = process.env.DSH_SSH_HOSTS_REMOTE_STRICT ?? 'accept-new'
const skip = ENABLED ? false : '设置 DSH_SSH_HOSTS_REMOTE=1 才跑真实服务器测试'

const REMOTE_DIR = `/tmp/dsh-ssh-hosts-smoke-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const NOTE = `${REMOTE_DIR}/note.txt`

function hostEntry(overrides = {}) {
  return {
    name: 'test-box',
    host: HOSTNAME,
    port: PORT,
    user: USER,
    identityFile: KEY,
    proxyJump: '',
    defaultWorkdir: '',
    description: '集成测试目标机',
    tags: ['test'],
    connectTimeoutSec: 10,
    keepAliveSec: 0,
    readOnly: false,
    jump: undefined,
    ...overrides
  }
}

let shared
function setup() {
  if (shared !== undefined) return shared
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-remote-'))
  const exec = createExec({
    knownHostsFile: KNOWN_HOSTS,
    strictHostKeyChecking: STRICT,
    connectTimeoutSec: 10,
    timeoutMs: 30000,
    controlPersistSec: 60
  })
  const state = createSessionState({ file: join(dir, 'state.json') })
  const handlers = createHandlers({
    cfg: { maxReadBytes: 4 * 1024 * 1024, allow: [], deny: [], defaultHost: '', hostsFile: '' },
    hosts: [hostEntry()],
    source: 'remote-test',
    exec,
    state,
    logger: () => {}
  })
  shared = { handlers, exec, state }
  // 用会话默认主机把「ssh_use 之后可以省略 host」这条路径也覆盖到
  state.set('remote', 'test-box')
  return shared
}

after(async () => {
  if (shared === undefined) return
  // 收尾：删远端临时目录 + 关闭复用连接
  try {
    await shared.handlers.run({ sessionId: 'remote', command: `rm -rf ${REMOTE_DIR}` })
  } catch {
    /* 收尾失败不影响测试结论 */
  }
  await shared.exec.dispose()
})

test('ssh_run：真实执行并拿到 stdout/stderr/退出码', { skip }, async () => {
  const { handlers } = setup()
  const result = await handlers.run({ sessionId: 'remote', command: 'uname -s && whoami && printf "HOME=%s\\n" "$HOME"' })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /Linux/)
  assert.ok(result.stdout.includes(USER), `stdout 应包含登录用户，实际：${result.stdout}`)
  assert.equal(result.stderr, '')
  assert.equal(result.truncatedStdout, false)
  assert.ok(result.durationMs >= 0)
})

test('ssh_run：cwd 生效（远端先 cd）', { skip }, async () => {
  const { handlers } = setup()
  const result = await handlers.run({ sessionId: 'remote', command: 'pwd', cwd: '/tmp' })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), '/tmp')
})

test('ssh_run：cwd 不存在时给出 66，而不是悄悄在别处执行', { skip }, async () => {
  const { handlers } = setup()
  const result = await handlers.run({ sessionId: 'remote', command: 'pwd', cwd: '/no/such/dir' })
  assert.equal(result.exitCode, 66)
  assert.equal(result.stdout.trim(), '')
})

test('ssh_run：非零退出码是正常结果', { skip }, async () => {
  const { handlers } = setup()
  const result = await handlers.run({ sessionId: 'remote', command: 'echo out; echo err >&2; exit 7' })
  assert.equal(result.exitCode, 7)
  assert.equal(result.stdout.trim(), 'out')
  assert.equal(result.stderr.trim(), 'err')
})

test('ssh_run：超时按 timeout 报错', { skip }, async () => {
  const { handlers } = setup()
  await assert.rejects(
    () => handlers.run({ sessionId: 'remote', command: 'sleep 20', timeoutMs: 1500 }),
    error => error.kind === 'timeout'
  )
})

test('ssh_ls：列出 /etc 并识别目录', { skip }, async () => {
  const { handlers } = setup()
  const result = await handlers.ls({ sessionId: 'remote', path: '/etc' })
  assert.ok(result.entries.length > 10, `条目太少：${result.entries.length}`)
  assert.ok(result.entries.some(entry => entry.name === 'hostname'))
  assert.ok(result.entries.some(entry => entry.type === 'directory'))
})

test('ssh_ls：不是目录时报 not-a-directory', { skip }, async () => {
  const { handlers } = setup()
  await assert.rejects(
    () => handlers.ls({ sessionId: 'remote', path: '/etc/hostname' }),
    error => error.kind === 'not-a-directory'
  )
})

test('远端文件全流程：write → read → edit → 覆盖写', { skip }, async () => {
  const { handlers } = setup()
  await handlers.run({ sessionId: 'remote', command: `mkdir -p ${REMOTE_DIR}` })

  const created = await handlers.write({ sessionId: 'remote', path: NOTE, content: 'alpha\nbeta\n' })
  assert.equal(created.created, true)
  assert.equal(created.bytes, 11)

  const first = await handlers.read({ sessionId: 'remote', path: NOTE })
  assert.equal(first.content, 'alpha\nbeta\n')
  assert.equal(first.totalLines, 3)

  const edited = await handlers.edit({ sessionId: 'remote', path: NOTE, oldString: 'beta', newString: 'gamma' })
  assert.equal(edited.replacements, 1)
  assert.equal((await handlers.read({ sessionId: 'remote', path: NOTE })).content, 'alpha\ngamma\n')

  const lineRange = await handlers.read({ sessionId: 'remote', path: NOTE, offset: 2, limit: 1 })
  assert.equal(lineRange.content, 'gamma')
  assert.equal(lineRange.startLine, 2)

  const overwritten = await handlers.write({ sessionId: 'remote', path: NOTE, content: 'delta\n' })
  assert.equal(overwritten.created, false)
  assert.equal((await handlers.read({ sessionId: 'remote', path: NOTE })).content, 'delta\n')
})

test('覆盖写保留远端原文件权限', { skip }, async () => {
  const { handlers } = setup()
  const file = `${REMOTE_DIR}/secret.conf`
  await handlers.run({ sessionId: 'remote', command: `mkdir -p ${REMOTE_DIR}; touch ${file}; chmod 600 ${file}` })
  await handlers.write({ sessionId: 'remote', path: file, content: 'TOKEN=1\n' })
  const mode = await handlers.run({ sessionId: 'remote', command: `stat -c '%a' ${file} 2>/dev/null || stat -f '%Lp' ${file}` })
  assert.equal(mode.stdout.trim(), '600', `权限被改坏了：${mode.stdout.trim()}`)
})

test('ssh_read：不存在的文件报 not-found', { skip }, async () => {
  const { handlers } = setup()
  await assert.rejects(
    () => handlers.read({ sessionId: 'remote', path: `${REMOTE_DIR}/missing.txt` }),
    error => error.kind === 'not-found'
  )
})

test('ssh_edit：oldString 不唯一时拒绝且不改文件', { skip }, async () => {
  const { handlers } = setup()
  const file = `${REMOTE_DIR}/dup.txt`
  await handlers.write({ sessionId: 'remote', path: file, content: 'x\nx\n' })
  await assert.rejects(
    () => handlers.edit({ sessionId: 'remote', path: file, oldString: 'x', newString: 'y' }),
    error => error.kind === 'not-unique'
  )
  assert.equal((await handlers.read({ sessionId: 'remote', path: file })).content, 'x\nx\n')
})

test('认证失败时给出可照做的提示（用错密钥路径）', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-remote-bad-'))
  const exec = createExec({
    knownHostsFile: KNOWN_HOSTS,
    strictHostKeyChecking: STRICT,
    connectTimeoutSec: 10,
    timeoutMs: 20000,
    controlPersistSec: 0
  })
  const handlers = createHandlers({
    cfg: { maxReadBytes: 1024, allow: [], deny: [], defaultHost: '', hostsFile: '' },
    hosts: [hostEntry({ name: 'bad-key', user: 'definitely-not-a-user' })],
    source: 'remote-test',
    exec,
    state: createSessionState({ file: join(dir, 'state.json') })
  })
  await assert.rejects(
    () => handlers.run({ sessionId: 'remote', host: 'bad-key', command: 'uptime' }),
    error => ['auth', 'timeout', 'ssh'].includes(error.kind) && /definitely-not-a-user|bad-key/.test(error.message)
  )
  await exec.dispose()
})

const PASSWORD = process.env.DSH_SSH_HOSTS_REMOTE_PASSWORD ?? ''
const passwordSkip = ENABLED
  ? (PASSWORD.length > 0 ? false : '设置 DSH_SSH_HOSTS_REMOTE_PASSWORD 才跑密码认证测试')
  : skip

test('密码认证：askpass 真的能登上服务器（并验证错密码会失败）', { skip: passwordSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-remote-pw-'))
  const store = new Map([['DSH_SSH_HOSTS_PASSWORD_TESTBOX', PASSWORD]])
  const exec = createExec({
    knownHostsFile: KNOWN_HOSTS,
    strictHostKeyChecking: STRICT,
    connectTimeoutSec: 10,
    timeoutMs: 30000,
    controlPersistSec: 0,
    // 与插件里同一条路：清单只给凭据名，值由凭据库按名字解析
    resolvePassword: async host => store.get(host.passwordRef)
  })
  const handlers = createHandlers({
    cfg: { maxReadBytes: 1024, allow: [], deny: [], defaultHost: '', hostsFile: '' },
    // 故意不给密钥：只有密码这一条路能成功，才算真的验证了密码登录
    hosts: [hostEntry({ name: 'pw-box', identityFile: '', passwordRef: 'DSH_SSH_HOSTS_PASSWORD_TESTBOX' })],
    source: 'remote-test',
    exec,
    state: createSessionState({ file: join(dir, 'state.json') })
  })
  try {
    const result = await handlers.run({ sessionId: 'remote', host: 'pw-box', command: 'uname -s && whoami' })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /Linux/)
    assert.ok(result.stdout.includes(USER), `stdout 应包含登录用户，实际：${result.stdout}`)

    // 凭据没值：必须在起进程前就报 auth，并说明去哪儿填
    const missing = createHandlers({
      cfg: { maxReadBytes: 1024, allow: [], deny: [], defaultHost: '', hostsFile: '' },
      hosts: [hostEntry({ name: 'pw-missing', identityFile: '', passwordRef: 'DSH_SSH_HOSTS_PASSWORD_UNSET' })],
      source: 'remote-test',
      exec,
      state: createSessionState({ file: join(dir, 'state2.json') })
    })
    await assert.rejects(
      () => missing.run({ sessionId: 'remote', host: 'pw-missing', command: 'true' }),
      error => error.kind === 'auth' && /还没有值|设置界面/.test(error.message)
    )

    // 错密码：OpenSSH 只提示一次，失败要报 auth（不是超时或挂住）
    store.set('DSH_SSH_HOSTS_PASSWORD_TESTBOX', `${PASSWORD}-wrong`)
    await assert.rejects(
      () => handlers.run({ sessionId: 'remote', host: 'pw-box', command: 'true' }),
      error => ['auth', 'ssh'].includes(error.kind)
    )
  } finally {
    await exec.dispose()
  }
})
