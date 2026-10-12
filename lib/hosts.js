/**
 * 主机清单的读取与校验。
 *
 * 这一层是纯 Node（不 import 任何 harness 包），便于单测。
 * 设计约束：
 *  - 未知字段一律报错：拼错的字段名不会被静默忽略；
 *  - identityFile 必须存在且权限不含 group/other 位（0600）：拿到密钥路径就能连服务器；
 *  - 清单文件本身同样要求 0600；
 *  - 报错信息必须可以直接照做（给出 chmod / 路径 / 字段名）。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** 主机名：会话里引用的键 */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 跳板的字面写法 user@host[:port]（或省略 user） */
const JUMP_LITERAL_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+(?::[0-9]{1,5})?$/
const HOST_LITERAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const ALLOWED_FIELDS = new Set([
  'name', 'host', 'port', 'user', 'identityFile', 'passwordRef', 'proxyJump', 'defaultWorkdir',
  'description', 'tags', 'connectTimeoutSec', 'keepAliveSec', 'readOnly'
])
/**
 * 凭据名（= 环境变量名形状）。清单里只存这个名字，密码本身存在 DSH 凭据库
 * （`$DSH_HOME/.credentials.yaml`，0600），由 `ctx.credentials` 读写。
 */
export const PASSWORD_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_DESCRIPTION = 400

/** 清单/主机条目不合法时抛这个（带可照做的说明） */
export class HostConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostConfigError'
  }
}

function fail(message) {
  throw new HostConfigError(message)
}

function octal(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/** 展开 ~ 与 ~/ 前缀 */
export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

function requireNonEmptyString(value, field, where) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${where}: 字段 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

function optionalString(value, field, where) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(`${where}: 字段 ${field} 必须是字符串`)
  return value.trim()
}

function optionalCount(value, field, where, minimum) {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    fail(`${where}: 字段 ${field} 必须是不小于 ${minimum} 的整数`)
  }
  return value
}

/** 校验一台主机条目；`where` 用于报错定位（文件名 + 主机名/序号） */
export function normalizeHostEntry(raw, where, { home = homedir(), checkIdentityFile = true } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where}: 每台主机必须是对象（{ name, host, ... }）`)
  }
  for (const key of Object.keys(raw)) {
    if (key === 'password' || key === 'passphrase') {
      fail(`${where}: 清单文件不存密码（字段 ${key}）。两种做法：① 用插件的设置界面填密码，插件会把密码存进 DSH 凭据库、清单里只留 passwordRef；② 用密钥 + ssh-agent。`)
    }
    if (!ALLOWED_FIELDS.has(key)) {
      fail(`${where}: 未知字段 ${key}。允许的字段：${[...ALLOWED_FIELDS].join(', ')}`)
    }
  }

  const name = requireNonEmptyString(raw.name, 'name', where)
  if (!NAME_PATTERN.test(name)) {
    fail(`${where}: 主机名 ${name} 不合法（需匹配 ${NAME_PATTERN}）`)
  }
  const label = `${where} (${name})`

  const host = requireNonEmptyString(raw.host, 'host', where)
  if (!HOST_LITERAL_PATTERN.test(host)) fail(`${label}: host ${host} 不合法`)

  const port = raw.port === undefined ? 22 : raw.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${label}: port 必须是 1-65535 的整数`)

  const user = optionalString(raw.user, 'user', label)
  if (user.length > 0 && !/^[A-Za-z0-9._-]+$/.test(user)) fail(`${label}: user ${user} 不合法`)

  const identityFile = expandHome(optionalString(raw.identityFile, 'identityFile', label), home)
  if (identityFile.length > 0 && checkIdentityFile) {
    let info
    try {
      info = statSync(identityFile)
    } catch {
      fail(`${label}: identityFile 不存在：${identityFile}`)
    }
    if (!info.isFile()) fail(`${label}: identityFile 不是普通文件：${identityFile}`)
    if ((info.mode & 0o077) !== 0) {
      fail(`${label}: identityFile 权限过于宽松（${octal(info.mode)}），请执行：chmod 600 ${identityFile}`)
    }
  }

  const defaultWorkdir = optionalString(raw.defaultWorkdir, 'defaultWorkdir', label)
  if (defaultWorkdir.length > 0 && !isAbsolute(defaultWorkdir)) {
    fail(`${label}: defaultWorkdir 必须是远端绝对路径，收到 ${defaultWorkdir}`)
  }

  const passwordRef = optionalString(raw.passwordRef, 'passwordRef', label)
  if (passwordRef.length > 0 && !PASSWORD_REF_PATTERN.test(passwordRef)) {
    fail(`${label}: passwordRef 必须是凭据名（字母/数字/下划线，如 DSH_SSH_HOSTS_PASSWORD_WEB_01），收到 ${passwordRef}`)
  }

  const proxyJump = optionalString(raw.proxyJump, 'proxyJump', label)
  const description = optionalString(raw.description, 'description', label)
  if (description.length > MAX_DESCRIPTION) fail(`${label}: description 过长（上限 ${MAX_DESCRIPTION} 字符）`)

  let tags = []
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) fail(`${label}: tags 必须是字符串数组`)
    tags = [...new Set(raw.tags.map(tag => {
      if (typeof tag !== 'string' || tag.trim().length === 0) fail(`${label}: tags 里必须是非空字符串`)
      return tag.trim()
    }))]
  }

  if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') fail(`${label}: readOnly 必须是布尔值`)

  return {
    name,
    host,
    port,
    user,
    identityFile,
    passwordRef,
    proxyJump,
    defaultWorkdir,
    description,
    tags,
    connectTimeoutSec: optionalCount(raw.connectTimeoutSec, 'connectTimeoutSec', label, 0),
    keepAliveSec: optionalCount(raw.keepAliveSec, 'keepAliveSec', label, 0),
    readOnly: raw.readOnly === true
  }
}

/**
 * 解析 proxyJump：优先当本清单里的主机名，其次当 user@host[:port] 字面量。
 * 两者都不是就报错——猜错的跳板会连到错误的机器上。
 */
export function resolveProxyJump(entry, byName) {
  const value = entry.proxyJump
  if (value.length === 0) return undefined
  const referenced = byName.get(value)
  if (referenced !== undefined) {
    const target = referenced.user.length > 0 ? `${referenced.user}@${referenced.host}` : referenced.host
    return referenced.port === 22 ? target : `${target}:${referenced.port}`
  }
  if (JUMP_LITERAL_PATTERN.test(value)) return value
  fail(`主机 ${entry.name}: proxyJump ${value} 既不是本清单里的主机名，也不像 user@host[:port]`)
}

/** 校验整份清单：名字唯一、跳板可解析 */
export function finalizeHosts(entries, { where = '主机清单' } = {}) {
  const byName = new Map()
  for (const entry of entries) {
    if (byName.has(entry.name)) fail(`${where}: 主机名重复：${entry.name}`)
    byName.set(entry.name, entry)
  }
  return entries
    .map(entry => ({ ...entry, jump: resolveProxyJump(entry, byName) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 解析 YAML 文本：接受 { version, hosts: [...] } 或裸数组 */
export function parseHostsDocument(text, { file = '<inline>', home = homedir(), checkIdentityFile = true } = {}) {
  let doc
  try {
    doc = parseYaml(text)
  } catch (error) {
    fail(`${file}: YAML 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (doc === null || doc === undefined) fail(`${file}: 文件为空`)
  const rawHosts = Array.isArray(doc)
    ? doc
    : (doc !== null && typeof doc === 'object' && Array.isArray(doc.hosts) ? doc.hosts : undefined)
  if (rawHosts === undefined) fail(`${file}: 需要 { version: 1, hosts: [...] } 或顶层数组`)
  if (!Array.isArray(doc) && doc.version !== undefined && doc.version !== 1) {
    fail(`${file}: 不支持的 version ${JSON.stringify(doc.version)}（当前只认 1）`)
  }
  const where = file
  const entries = rawHosts.map((raw, index) =>
    normalizeHostEntry(raw, `${where} hosts[${index}]`, { home, checkIdentityFile }))
  return { hosts: finalizeHosts(entries, { where }), source: file }
}

/**
 * 装载主机清单。
 *  - `inline`（config.hosts）非空时以它为准；
 *  - 否则读 `file`，要求 0600；
 *  - 两者都没有主机时返回空清单（插件照常启动，工具给出配置指引）。
 */
export function loadHosts({
  inline = [],
  file,
  source = 'config',
  home = homedir(),
  checkIdentityFile = true,
  readFile = readFileSync,
  stat = statSync
} = {}) {
  if (Array.isArray(inline) && inline.length > 0) {
    const entries = inline.map((raw, index) =>
      normalizeHostEntry(raw, `config.hosts[${index}]`, { home, checkIdentityFile }))
    return { hosts: finalizeHosts(entries, { where: 'config.hosts' }), source }
  }

  let text
  try {
    text = readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`主机清单不存在：${file}\n` +
        `  照这个开始：cp <插件目录>/ssh-hosts.example.yaml ${file} && chmod 600 ${file}\n` +
        `  或在插件 config 里用 hosts: [...] 就地声明主机。`)
    }
    fail(`主机清单读取失败：${file}：${error instanceof Error ? error.message : String(error)}`)
  }

  let info
  try {
    info = stat(file)
  } catch (error) {
    fail(`主机清单无法 stat：${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  if ((info.mode & 0o077) !== 0) {
    fail(`主机清单权限过于宽松（${octal(info.mode)}）：${file}\n  请执行：chmod 600 ${file}`)
  }

  return parseHostsDocument(text, { file, home, checkIdentityFile })
}

/**
 * 该主机的登录方式（给界面和模型看的摘要，不含任何秘密）：
 * `key` 只用密钥；`password` 只用密码；`key+password` 先试密钥再试密码；`agent` 交给 ssh-agent/默认密钥。
 */
export function authModeOf(entry) {
  const hasKey = typeof entry.identityFile === 'string' && entry.identityFile.length > 0
  const hasPassword = typeof entry.passwordRef === 'string' && entry.passwordRef.length > 0
  if (hasKey && hasPassword) return 'key+password'
  if (hasPassword) return 'password'
  return hasKey ? 'key' : 'agent'
}

/** 模型可见的主机投影：identityFile / passwordRef 都不外露，只给一个 auth 摘要 */
export function redactHost(entry) {
  return {
    name: entry.name,
    user: entry.user,
    host: entry.host,
    port: entry.port,
    tags: [...entry.tags],
    description: entry.description,
    defaultWorkdir: entry.defaultWorkdir,
    readOnly: entry.readOnly,
    auth: authModeOf(entry),
    ...(entry.jump === undefined ? {} : { via: entry.proxyJump })
  }
}
