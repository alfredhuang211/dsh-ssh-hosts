import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  Config,
  HOSTS_FILENAME,
  NS,
  SHAPE,
  STATE_FILENAME,
  defaults,
  isVolatileConfig,
  liveConfig,
  normalizeConfig,
  resolveDshHome,
  resolveHostsFile,
  resolveStateFile,
  unwrapConfig
} from '../lib/config.js'

test('插件名与默认文件名稳定（patch id / 清单路径都依赖它）', () => {
  assert.equal(NS, 'ssh-hosts')
  assert.equal(HOSTS_FILENAME, 'ssh-hosts.yaml')
  assert.equal(STATE_FILENAME, 'ssh-hosts.state.json')
})

test('defaults() 覆盖 schema 的每个字段', () => {
  const value = defaults()
  assert.deepEqual(Object.keys(value).sort(), Object.keys(SHAPE).sort())
  assert.equal(value.hostsFile, '')
  assert.equal(value.defaultHost, '')
  assert.equal(value.knownHostsFile, '')
  assert.equal(value.strictHostKeyChecking, 'accept-new')
  assert.equal(value.connectTimeoutSec, 10)
  assert.equal(value.timeoutMs, 60000)
  assert.equal(value.maxOutputBytes, 262144)
  assert.equal(value.maxReadBytes, 8388608)
  assert.equal(value.controlPersistSec, 300)
  assert.deepEqual(value.allow, [])
  assert.deepEqual(value.deny, [])
  assert.deepEqual(value.hosts, [])
})

test('defaults() 返回的数组是副本，改它不会污染 schema', () => {
  const first = defaults()
  first.allow.push('rm')
  first.hosts.push({ name: 'x' })
  const second = defaults()
  assert.deepEqual(second.allow, [])
  assert.deepEqual(second.hosts, [])
})

test('Config 至少有一个 volatile 字段，否则设置页保存会报 "no volatile fields"', () => {
  const volatile = Object.entries(Config.dict ?? {}).filter(([, schema]) => schema?.meta?.volatile === true)
  assert.ok(volatile.length > 0)
  assert.ok(volatile.some(([key]) => key === 'defaultHost'))
  // 主机清单以 YAML 为唯一权威，故意不放进 volatile 子树
  assert.equal(Config.dict.hosts.meta.volatile, undefined)
})

test('Config 校验非法指纹策略', () => {
  assert.throws(() => Config({ strictHostKeyChecking: 'maybe' }))
  assert.doesNotThrow(() => Config({ strictHostKeyChecking: 'yes' }))
})

test('normalizeConfig 用默认值补齐缺口', () => {
  const cfg = normalizeConfig({ defaultHost: 'web-01' })
  assert.equal(cfg.defaultHost, 'web-01')
  assert.equal(cfg.timeoutMs, 60000)
  assert.equal(cfg.strictHostKeyChecking, 'accept-new')
  assert.deepEqual(cfg.deny, [])
})

test('resolveDshHome 优先 DSH_HOME', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/dsh' }, '/home/u'), '/tmp/dsh')
  assert.equal(resolveDshHome({}, '/home/u'), join('/home/u', '.dsh'))
})

test('resolveHostsFile：空 = $DSH_HOME 默认文件；相对路径按 DSH_HOME；绝对路径原样', () => {
  const env = { DSH_HOME: '/tmp/dsh' }
  assert.equal(resolveHostsFile({ hostsFile: '' }, { env }), join('/tmp/dsh', HOSTS_FILENAME))
  assert.equal(resolveHostsFile({ hostsFile: 'servers.yaml' }, { env }), join('/tmp/dsh', 'servers.yaml'))
  assert.equal(resolveHostsFile({ hostsFile: '/etc/dsh/hosts.yaml' }, { env }), '/etc/dsh/hosts.yaml')
  assert.equal(resolveHostsFile({ hostsFile: '  ' }, { env }), join('/tmp/dsh', HOSTS_FILENAME))
  assert.equal(resolveHostsFile({ hostsFile: '~/x.yaml' }, { env, home: '/home/u' }), join('/home/u', 'x.yaml'))
})

test('resolveStateFile 始终在 $DSH_HOME 下', () => {
  assert.equal(resolveStateFile({}, { env: { DSH_HOME: '/tmp/dsh' } }), join('/tmp/dsh', STATE_FILENAME))
})

test('Config 校验后的 volatile 字段是引用：normalizeConfig 必须解包出真实值', () => {
  // 宿主（cordis Loader / 桌面端设置服务）就是这么交给插件的：
  // 每个 volatile 字段是一个 { get() } 引用对象，不是标量。
  const parsed = Config({
    hostsFile: '/srv/hosts.yaml',
    defaultHost: 'web-01',
    strictHostKeyChecking: 'yes',
    timeoutMs: 1234,
    allow: ['^uptime'],
    hosts: [{ name: 'web-01', host: '10.0.0.1' }]
  })
  assert.equal(typeof parsed.hostsFile, 'object', 'volatile 字段经宿主校验后应当是引用')
  assert.equal(typeof parsed.hostsFile.get, 'function')

  const cfg = normalizeConfig(parsed)
  assert.equal(cfg.hostsFile, '/srv/hosts.yaml')
  assert.equal(cfg.defaultHost, 'web-01')
  assert.equal(cfg.strictHostKeyChecking, 'yes')
  assert.equal(cfg.timeoutMs, 1234)
  assert.deepEqual(cfg.allow, ['^uptime'])
  assert.equal(cfg.hosts.length, 1)
  assert.equal(cfg.hosts[0].name, 'web-01')
  assert.equal(cfg.hosts[0].host, '10.0.0.1')
  assert.equal(cfg.hosts[0].port, 22)
  // 没配的字段仍然吃到默认值
  assert.equal(cfg.maxReadBytes, 8388608)
})

test('liveConfig：设置页改 volatile 字段后，下一次读就是新值（不用重启）', () => {
  const parsed = Config({ defaultHost: 'web-01', timeoutMs: 1000 })
  const cfg = liveConfig(parsed)
  assert.equal(cfg.defaultHost, 'web-01')
  assert.equal(cfg.timeoutMs, 1000)
  // 宿主更新引用里的值（updateVolatile 语义），插件不做任何重载
  parsed.defaultHost[Symbol.for('cosmokit.volatile.write')]('db-01')
  parsed.timeoutMs[Symbol.for('cosmokit.volatile.write')](2000)
  assert.equal(cfg.defaultHost, 'db-01')
  assert.equal(cfg.timeoutMs, 2000)
  // 纯对象也能用（测试/CLI dump 路径）
  const plain = liveConfig({ defaultHost: 'x' })
  assert.equal(plain.defaultHost, 'x')
  assert.equal(plain.timeoutMs, 60000)
})

test('unwrapConfig 递归解包：嵌套引用与数组都还原', () => {
  const inner = Config({ timeoutMs: 2000 }).timeoutMs
  const wrapped = { a: inner, list: [inner, 3], nested: { b: inner } }
  assert.deepEqual(unwrapConfig(wrapped), { a: 2000, list: [2000, 3], nested: { b: 2000 } })
  assert.equal(isVolatileConfig(inner), true)
  assert.equal(isVolatileConfig(7), false)
  assert.equal(isVolatileConfig(null), false)
})
