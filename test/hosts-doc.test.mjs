/** 主机清单文件的读写：注释保留、原子写、0600。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hostsFileInfo, parseHostsForEdit, readHostsText, serializeHosts, writeHostsText
} from '../lib/hosts-doc.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ssh-hosts-doc-'))
}

test('parseHostsForEdit：空文件 = 空清单', () => {
  assert.deepEqual(parseHostsForEdit(''), { version: 1, hosts: [] })
  assert.deepEqual(parseHostsForEdit('   \n'), { version: 1, hosts: [] })
  assert.deepEqual(parseHostsForEdit('null'), { version: 1, hosts: [] })
})

test('parseHostsForEdit：裸数组与 {version,hosts} 两种形态都收', () => {
  assert.deepEqual(parseHostsForEdit('- name: a\n  host: 1.2.3.4\n').hosts, [{ name: 'a', host: '1.2.3.4' }])
  assert.deepEqual(parseHostsForEdit('version: 1\nhosts:\n  - name: a\n    host: 1.2.3.4\n').hosts,
    [{ name: 'a', host: '1.2.3.4' }])
})

test('parseHostsForEdit：坏 YAML / 未知版本 / hosts 不是数组都报错', () => {
  assert.throws(() => parseHostsForEdit('a: [\n'), /YAML 解析失败/)
  assert.throws(() => parseHostsForEdit('version: 9\nhosts: []\n'), /不支持的 version/)
  assert.throws(() => parseHostsForEdit('version: 1\nhosts: 3\n'), /需要 \{ version: 1, hosts: \[\.\.\.\] \} 或顶层数组/)
  assert.throws(() => parseHostsForEdit('42'), /需要 \{ version: 1, hosts: \[\.\.\.\] \} 或顶层数组/)
})

test('serializeHosts：新文件带表头与 version', () => {
  const text = serializeHosts([{ name: 'a', host: '1.2.3.4' }])
  assert.match(text, /^# dsh-ssh-hosts 主机清单/)
  assert.match(text, /version: 1/)
  assert.match(text, /name: a/)
  assert.deepEqual(parseHostsForEdit(text).hosts, [{ name: 'a', host: '1.2.3.4' }])
})

test('serializeHosts：保留现有文件的注释与其他键', () => {
  const existing = [
    '# 我的手写注释：这台是生产机',
    'version: 1',
    'notes: 别忘了 6 月轮换密钥',
    'hosts:',
    '  - name: old',
    '    host: 10.0.0.1',
    ''
  ].join('\n')
  const text = serializeHosts([{ name: 'new', host: '10.0.0.2' }], { existingText: existing })
  assert.match(text, /我的手写注释/)
  assert.match(text, /notes: 别忘了 6 月轮换密钥/)
  assert.match(text, /name: new/)
  assert.doesNotMatch(text, /name: old/)
  assert.deepEqual(parseHostsForEdit(text).hosts, [{ name: 'new', host: '10.0.0.2' }])
})

test('serializeHosts：现有文件是坏 YAML 时拒绝覆盖', () => {
  assert.throws(() => serializeHosts([], { existingText: 'hosts: [\n' }), /不是合法 YAML/)
})

test('readHostsText：不存在返回空串，其他错误照抛', () => {
  assert.equal(readHostsText('/definitely/not/here.yaml', {
    readFile: () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error }
  }), '')
  assert.throws(() => readHostsText('/x', {
    readFile: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error }
  }), /denied/)
})

test('writeHostsText：原子写 + 0600 + 自动建目录', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'nested', 'ssh-hosts.yaml')
    const result = writeHostsText(file, 'version: 1\nhosts: []\n')
    assert.equal(readFileSync(file, 'utf8'), 'version: 1\nhosts: []\n')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(result.bytes, Buffer.byteLength('version: 1\nhosts: []\n'))
    assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeHostsText：rename 继承了宽松权限时显式收紧', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'ssh-hosts.yaml')
    writeFileSync(file, 'version: 1\nhosts: []\n', { mode: 0o644 })
    writeHostsText(file, 'version: 1\nhosts: []\n')
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostsFileInfo：存在与否都给出可显示的信息', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'ssh-hosts.yaml')
    assert.deepEqual(hostsFileInfo(file), { exists: false, mode: '', bytes: 0, mtime: '' })
    writeHostsText(file, 'version: 1\nhosts: []\n')
    const info = hostsFileInfo(file)
    assert.equal(info.exists, true)
    assert.equal(info.mode, '0600')
    assert.equal(info.bytes, Buffer.byteLength('version: 1\nhosts: []\n'))
    assert.match(info.mtime, /^\d{4}-/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
