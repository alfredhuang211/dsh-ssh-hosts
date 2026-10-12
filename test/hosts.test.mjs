import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HostConfigError,
  authModeOf,
  loadHosts,
  parseHostsDocument,
  redactHost,
  resolveProxyJump
} from '../lib/hosts.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ssh-hosts-test-'))
}

function writeKey(dir, { name = 'id_ed25519', mode = 0o600, body = 'PRIVATE KEY' } = {}) {
  const file = join(dir, name)
  writeFileSync(file, body)
  chmodSync(file, mode)
  return file
}

function writeHosts(dir, text, mode = 0o600) {
  const file = join(dir, 'ssh-hosts.yaml')
  writeFileSync(file, text)
  chmodSync(file, mode)
  return file
}

const KEY = () => writeKey(tempDir())

test('解析正常清单：排序、跳板解析、字段归一', () => {
  const dir = tempDir()
  const key = writeKey(dir)
  const { hosts, source } = parseHostsDocument(`
version: 1
hosts:
  - name: web-01
    host: 10.0.0.1
    user: ubuntu
    identityFile: ${key}
    defaultWorkdir: /srv/app
    description: 生产 Web
    tags: [prod, web, prod]
  - name: bastion
    host: bastion.example.com
    port: 2222
    user: jump
    identityFile: ${key}
  - name: app-int
    host: 10.0.0.9
    user: ubuntu
    identityFile: ${key}
    proxyJump: bastion
`, { file: 'inline' })

  assert.equal(source, 'inline')
  assert.deepEqual(hosts.map(host => host.name), ['app-int', 'bastion', 'web-01'])
  const web = hosts.find(host => host.name === 'web-01')
  assert.equal(web.port, 22)
  assert.deepEqual(web.tags, ['prod', 'web'])
  assert.equal(web.readOnly, false)
  assert.equal(web.jump, undefined)
  const inner = hosts.find(host => host.name === 'app-int')
  assert.equal(inner.jump, 'jump@bastion.example.com:2222')
})

test('顶层裸数组也接受', () => {
  const key = KEY()
  const { hosts } = parseHostsDocument(`- name: a\n  host: a.example.com\n  user: u\n  identityFile: ${key}\n`)
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].name, 'a')
})

test('未知字段报错而不是静默忽略', () => {
  assert.throws(
    () => parseHostsDocument(`- name: a\n  host: a.example.com\n  keyFile: /tmp/k\n`),
    /未知字段 keyFile/
  )
})

test('主机名重复报错', () => {
  assert.throws(
    () => parseHostsDocument(`- name: a\n  host: x\n- name: a\n  host: y\n`),
    /主机名重复/
  )
})

test('主机名非法报错', () => {
  assert.throws(() => parseHostsDocument(`- name: "有中文"\n  host: x\n`), /不合法/)
  assert.throws(() => parseHostsDocument(`- name: -lead\n  host: x\n`), /不合法/)
})

test('port 必须是 1-65535 的整数', () => {
  assert.throws(() => parseHostsDocument(`- name: a\n  host: x\n  port: 0\n`), /port/)
  assert.throws(() => parseHostsDocument(`- name: a\n  host: x\n  port: 70000\n`), /port/)
  assert.throws(() => parseHostsDocument(`- name: a\n  host: x\n  port: 22.5\n`), /port/)
})

test('identityFile 必须存在', () => {
  assert.throws(
    () => parseHostsDocument(`- name: a\n  host: x\n  identityFile: /nope/id_ed25519\n`),
    /identityFile 不存在/
  )
})

test('identityFile 权限宽松时给出 chmod 提示', () => {
  const key = writeKey(tempDir(), { mode: 0o644 })
  assert.throws(
    () => parseHostsDocument(`- name: a\n  host: x\n  identityFile: ${key}\n`),
    /chmod 600/
  )
})

test('identityFile 可以省略（改用 ssh-agent / 默认密钥）', () => {
  const { hosts } = parseHostsDocument(`- name: a\n  host: x\n  user: u\n`)
  assert.equal(hosts[0].identityFile, '')
})

test('defaultWorkdir 必须是绝对路径', () => {
  assert.throws(() => parseHostsDocument(`- name: a\n  host: x\n  defaultWorkdir: srv/app\n`), /绝对路径/)
})

test('proxyJump 既不是本清单主机也不像 user@host 时报错', () => {
  assert.throws(
    () => parseHostsDocument(`- name: a\n  host: x\n  proxyJump: "bad jump"\n`),
    /proxyJump/
  )
  const key = KEY()
  const { hosts } = parseHostsDocument(`- name: a\n  host: x\n  identityFile: ${key}\n  proxyJump: jump@bastion.example.com:2222\n`)
  assert.equal(hosts[0].jump, 'jump@bastion.example.com:2222')
})

test('tags 必须是字符串数组且去重', () => {
  const { hosts } = parseHostsDocument(`- name: a\n  host: x\n  tags: [prod, prod, db]\n`)
  assert.deepEqual(hosts[0].tags, ['prod', 'db'])
  assert.throws(() => parseHostsDocument(`- name: a\n  host: x\n  tags: prod\n`), /tags/)
  assert.throws(() => parseHostsDocument(`- name: a\n  host: x\n  tags: ["  "]\n`), /tags/)
})

test('未知 version 报错', () => {
  assert.throws(() => parseHostsDocument(`version: 2\nhosts: []\n`), /version/)
})

test('空文件报错', () => {
  assert.throws(() => parseHostsDocument(''), /文件为空/)
})

test('loadHosts：清单文件必须 0600', () => {
  const dir = tempDir()
  const file = writeHosts(dir, `- name: a\n  host: x\n`, 0o644)
  assert.throws(() => loadHosts({ file }), /权限过于宽松/)
  chmodSync(file, 0o600)
  assert.equal(loadHosts({ file }).hosts.length, 1)
})

test('loadHosts：文件缺失时给出可照做的指引', () => {
  assert.throws(
    () => loadHosts({ file: '/definitely/missing/ssh-hosts.yaml' }),
    error => error instanceof HostConfigError && /主机清单不存在/.test(error.message) && /chmod 600/.test(error.message)
  )
})

test('loadHosts：config.hosts 就地声明优先于文件', () => {
  const dir = tempDir()
  // 文件本身是坏的：只走 inline 时不应被读到，否则会报「未知字段 keyFile」
  const file = writeHosts(dir, `- name: from-file\n  host: x\n  keyFile: /tmp/k\n`)
  assert.throws(() => loadHosts({ file }), /未知字段 keyFile/)
  const key = writeKey(dir)
  const result = loadHosts({
    file,
    inline: [{ name: 'inline-01', host: 'y.example.com', user: 'u', identityFile: key }],
    source: 'config'
  })
  assert.deepEqual(result.hosts.map(host => host.name), ['inline-01'])
})

test('loadHosts：都为空时返回空清单（不阻断启动）', () => {
  const dir = tempDir()
  const file = writeHosts(dir, `version: 1\nhosts: []\n`)
  assert.deepEqual(loadHosts({ file, inline: [] }).hosts, [])
})

test('权限位检查覆盖 group/other 的所有位', () => {
  const dir = tempDir()
  for (const mode of [0o640, 0o604, 0o660, 0o700, 0o777]) {
    const file = writeHosts(dir, `- name: a\n  host: x\n`, mode)
    assert.equal(statSync(file).mode & 0o077, mode & 0o077)
    if ((mode & 0o077) !== 0) assert.throws(() => loadHosts({ file }), /权限过于宽松/)
    else assert.doesNotThrow(() => loadHosts({ file }))
  }
})

test('redactHost 不泄露 identityFile，但给出 via', () => {
  const key = KEY()
  const { hosts } = parseHostsDocument(`- name: a\n  host: x\n  user: u\n  identityFile: ${key}\n  proxyJump: jump.example.com\n  tags: [prod]\n`)
  const view = redactHost(hosts[0])
  assert.equal(view.name, 'a')
  assert.equal(view.via, 'jump.example.com')
  assert.equal('identityFile' in view, false)
  assert.equal(JSON.stringify(view).includes(key), false)
})

test('resolveProxyJump 对空值返回 undefined', () => {
  assert.equal(resolveProxyJump({ name: 'a', proxyJump: '', user: 'u', host: 'h', port: 22 }, new Map()), undefined)
})

test('passwordRef 是合法凭据名，明文 password 字段被明确拒绝', () => {
  const { hosts } = parseHostsDocument('- name: a\n  host: x\n  user: u\n  passwordRef: DSH_SSH_HOSTS_PASSWORD_A\n')
  assert.equal(hosts[0].passwordRef, 'DSH_SSH_HOSTS_PASSWORD_A')
  // 凭据名形状不对 → 报错并给出示例
  assert.throws(
    () => parseHostsDocument('- name: a\n  host: x\n  passwordRef: "ds-ssh/pw"\n'),
    error => error instanceof HostConfigError && /passwordRef 必须是凭据名/.test(error.message))
  // 明文密码字段 → 不是「未知字段」，而是专门的「别把密码写进清单」提示
  assert.throws(
    () => parseHostsDocument('- name: a\n  host: x\n  password: hunter2\n'),
    error => error instanceof HostConfigError && /清单文件不存密码/.test(error.message))
  assert.throws(
    () => parseHostsDocument('- name: a\n  host: x\n  passphrase: hunter2\n'),
    error => error instanceof HostConfigError && /清单文件不存密码/.test(error.message))
})

test('authModeOf：密钥 / 密码 / 两者 / ssh-agent', () => {
  assert.equal(authModeOf({ identityFile: '/k', passwordRef: '' }), 'key')
  assert.equal(authModeOf({ identityFile: '', passwordRef: 'REF' }), 'password')
  assert.equal(authModeOf({ identityFile: '/k', passwordRef: 'REF' }), 'key+password')
  assert.equal(authModeOf({ identityFile: '', passwordRef: '' }), 'agent')
})

test('redactHost 不外露 passwordRef，只给 auth 摘要', () => {
  const { hosts } = parseHostsDocument('- name: a\n  host: x\n  user: u\n  passwordRef: DSH_SSH_HOSTS_PASSWORD_A\n')
  const view = redactHost(hosts[0])
  assert.equal(view.auth, 'password')
  assert.equal('passwordRef' in view, false)
  assert.equal(JSON.stringify(view).includes('DSH_SSH_HOSTS_PASSWORD_A'), false)
})
