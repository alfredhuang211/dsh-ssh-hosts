import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_VERSION, createSessionState, readState } from '../lib/session-state.js'

function stateFile() {
  return join(mkdtempSync(join(tmpdir(), 'ssh-hosts-state-')), 'ssh-hosts.state.json')
}

test('未写过时返回 null', () => {
  const state = createSessionState({ file: stateFile() })
  assert.equal(state.get('session-1'), null)
})

test('set/get 并落盘，新实例可读', () => {
  const file = stateFile()
  const first = createSessionState({ file, now: () => '2024-01-01T00:00:00.000Z' })
  first.set('session-1', 'web-01')
  assert.equal(first.get('session-1'), 'web-01')

  const second = createSessionState({ file })
  assert.equal(second.get('session-1'), 'web-01')
  assert.equal(second.snapshot().version, STATE_VERSION)
})

test('状态文件权限是 0600', () => {
  const file = stateFile()
  createSessionState({ file }).set('s', 'a')
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('set 空串清除默认主机', () => {
  const file = stateFile()
  const state = createSessionState({ file })
  state.set('s', 'a')
  state.set('s', '')
  assert.equal(state.get('s'), null)
  assert.equal(createSessionState({ file }).get('s'), null)
})

test('空 sessionId 不写不读（不会串到别的会话）', () => {
  const file = stateFile()
  const state = createSessionState({ file })
  state.set('', 'a')
  assert.equal(state.get(''), null)
  assert.equal(state.get(undefined), null)
  assert.equal(state.exists(), false)
})

test('文件损坏时按空状态处理，并能在其后正常写入', () => {
  const file = stateFile()
  writeFileSync(file, '{ this is not json')
  const state = createSessionState({ file })
  assert.equal(state.get('s'), null)
  state.set('s', 'a')
  assert.equal(state.get('s'), 'a')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.s.host, 'a')
})

test('未知 version 视为空', () => {
  const file = stateFile()
  writeFileSync(file, JSON.stringify({ version: 99, sessions: { s: { host: 'a' } } }))
  assert.deepEqual(readState(file).sessions, {})
})

test('忽略结构不对的条目', () => {
  const file = stateFile()
  writeFileSync(file, JSON.stringify({ version: 1, sessions: { good: { host: 'a' }, bad: { host: '' }, weird: 5 } }))
  const state = createSessionState({ file })
  assert.equal(state.get('good'), 'a')
  assert.equal(state.get('bad'), null)
  assert.equal(state.get('weird'), null)
})

test('超过 maxSessions 时按时间淘汰最旧的', () => {
  const file = stateFile()
  let tick = 0
  const state = createSessionState({ file, maxSessions: 2, now: () => `2024-01-01T00:00:0${tick++}.000Z` })
  state.set('a', 'h1')
  state.set('b', 'h2')
  state.set('c', 'h3')
  const sessions = state.snapshot().sessions
  assert.deepEqual(Object.keys(sessions).sort(), ['b', 'c'])
})

test('写入是原子替换：不会留下半截文件', () => {
  const file = stateFile()
  const state = createSessionState({ file })
  for (let index = 0; index < 20; index += 1) state.set('s', `host-${index}`)
  assert.equal(state.get('s'), 'host-19')
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
})

test('全局默认主机：界面写的这一层单独存、单独读', () => {
  const file = stateFile()
  const state = createSessionState({ file })
  assert.equal(state.getDefault(), null)

  state.setDefault('web-01')
  assert.equal(state.getDefault(), 'web-01')
  assert.equal(readState(file).defaultHost, 'web-01')
  // 会话默认与全局默认互不影响
  state.set('s1', 'db-01')
  assert.equal(state.get('s1'), 'db-01')
  assert.equal(state.getDefault(), 'web-01')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['defaultHost', 'sessions', 'version'])

  // 非法名称不落盘；清除后文件里不再有这一层
  state.setDefault('bad name')
  assert.equal(state.getDefault(), null)
  state.setDefault('web-01')
  state.setDefault('')
  assert.equal(state.getDefault(), null)
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'defaultHost'), false)
})

test('状态里的 defaultHost 形状不对时忽略', () => {
  const file = stateFile()
  writeFileSync(file, JSON.stringify({ version: 1, defaultHost: 42, sessions: {} }))
  assert.equal(readState(file).defaultHost, '')
  writeFileSync(file, JSON.stringify({ version: 1, defaultHost: 'bad name', sessions: {} }))
  assert.equal(readState(file).defaultHost, '')
})
