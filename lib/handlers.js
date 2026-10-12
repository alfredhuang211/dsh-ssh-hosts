/**
 * 工具背后的业务逻辑。
 *
 * 与 tools.js 分开的原因：这一层是纯函数式的（依赖注入 exec / state），
 * 不 import 任何 harness 包，因此可以在 node --test 里直接跑真实断言。
 * tools.js 只负责把这里的能力翻译成模型可见的契约。
 */
import { redactHost } from './hosts.js'
import { SshExecError, assertAbsoluteRemotePath, hintFor } from './exec.js'

/** 默认一次读多少行（与本地 read 工具的习惯对齐） */
export const DEFAULT_READ_LINES = 2000
/** 单次命令超时上限（30 分钟） */
export const MAX_TIMEOUT_MS = 1800000

/** 面向模型的可读失败；kind 用于测试与日志，message 直接进工具结果 */
export class ToolFailure extends Error {
  constructor(kind, message) {
    super(message)
    this.name = 'ToolFailure'
    this.kind = kind
  }
}

function compilePatterns(raw, field) {
  if (!Array.isArray(raw)) return []
  return raw.map((source, index) => {
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error(`ssh-hosts: config.${field}[${index}] 必须是非空正则字符串`)
    }
    try {
      return { source, regex: new RegExp(source) }
    } catch (error) {
      throw new Error(`ssh-hosts: config.${field}[${index}] 不是合法正则：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  while (index <= text.length) {
    const found = text.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

export function createHandlers({ cfg, hosts, source, exec, state, logger = () => {} }) {
  const byName = new Map(hosts.map(host => [host.name, host]))
  const names = hosts.map(host => host.name)
  const allow = compilePatterns(cfg.allow, 'allow')
  const deny = compilePatterns(cfg.deny, 'deny')

  function mustGet(name) {
    const host = byName.get(name)
    if (host === undefined) {
      throw new ToolFailure('unknown-host',
        `未知主机 "${name}"。${names.length > 0 ? `可用主机：${names.join(', ')}` : '当前没有配置任何主机。'}`)
    }
    return host
  }

  /** 解析本次调用实际使用的主机：显式参数 > 本会话默认 > 全局默认（界面设置）> config.defaultHost */
  function effectiveHost(sessionId, requested) {
    const explicit = typeof requested === 'string' ? requested.trim() : ''
    if (explicit.length > 0) return mustGet(explicit)

    const scoped = state.get(sessionId)
    if (scoped !== null) {
      const host = byName.get(scoped)
      if (host !== undefined) return host
      logger(`会话默认主机 ${scoped} 已不在清单里，忽略`)
    }

    const stored = typeof state.getDefault === 'function' ? state.getDefault() : null
    if (stored !== null) {
      const host = byName.get(stored)
      if (host !== undefined) return host
      logger(`默认主机 ${stored} 已不在清单里，忽略`)
    }

    const configured = typeof cfg.defaultHost === 'string' ? cfg.defaultHost.trim() : ''
    if (configured.length > 0) return mustGet(configured)

    throw new ToolFailure('no-host', hosts.length === 0
      ? `还没有配置任何 SSH 主机。请创建 ${cfg.resolvedHostsFile ?? '$DSH_HOME/ssh-hosts.yaml'}（权限 0600），`
        + '在 hosts: 下写主机；或在插件 config 里用 hosts: [...] 就地声明。'
      : `没有指定 host，本会话也没有默认主机。可用主机：${names.join(', ')}；`
        + '可以先用 ssh_use 设定本会话默认主机。')
  }

  /** SshExecError → 面向模型的 ToolFailure */
  function toFailure(error, host) {
    if (error instanceof ToolFailure) return error
    if (error instanceof SshExecError) {
      const prefix = host === undefined ? '' : `[${host.name}] `
      const hint = error.kind === 'ssh' ? '' : `\n提示：${hintFor(error.kind)}`
      return new ToolFailure(error.kind, `${prefix}${error.message}${hint}`)
    }
    return error
  }

  function normalizeTimeout(value) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
      throw new ToolFailure('invalid-args', `timeoutMs 必须是 1000-${MAX_TIMEOUT_MS} 之间的整数`)
    }
    return value
  }

  /** 部署方命令策略：deny 优先于 allow；这是运维约定，不是安全边界 */
  function checkCommand(command) {
    for (const { source: pattern, regex } of deny) {
      if (regex.test(command)) throw new ToolFailure('denied', `命令被 deny 规则 /${pattern}/ 拦截：${command}`)
    }
    if (allow.length > 0 && !allow.some(({ regex }) => regex.test(command))) {
      throw new ToolFailure('denied', `命令不在 allow 白名单内：${command}`)
    }
  }

  function requireWritable(host, what) {
    if (host.readOnly) {
      throw new ToolFailure('read-only', `主机 ${host.name} 标记为 readOnly，拒绝${what}`)
    }
  }

  /**
   * 清单投影。`defaultHost` 报的是**本次调用实际会用的**那台（与 effectiveHost 同一套优先级），
   * 所以带上 sessionId 时它就是会话默认主机 —— 否则模型会看到「默认主机为空」而实际
   * ssh_run 省略 host 却能跑（用户在会话窗口「+」菜单里选过机器之后尤其容易撞上）。
   */
  async function listHosts({ tag, sessionId } = {}) {
    const filter = typeof tag === 'string' ? tag.trim().toLowerCase() : ''
    const selected = filter.length === 0
      ? hosts
      : hosts.filter(host => host.tags.some(value => value.toLowerCase() === filter))
    const scoped = typeof sessionId === 'string' && sessionId.length > 0 ? state.get(sessionId) : null
    const stored = typeof state.getDefault === 'function' ? state.getDefault() : null
    const configured = String(cfg.defaultHost ?? '').trim()
    const defaultHost = scoped !== null && byName.has(scoped)
      ? scoped
      : (stored !== null && byName.has(stored)
          ? stored
          : (byName.has(configured) ? configured : ''))
    return {
      source: String(source),
      total: hosts.length,
      defaultHost,
      defaultSource: scoped !== null && byName.has(scoped) ? 'session' : (stored !== null && byName.has(stored) ? 'default' : (byName.has(configured) ? 'config' : 'none')),
      hosts: selected.map(redactHost)
    }
  }

  async function useHost({ host, sessionId } = {}) {
    const requested = typeof host === 'string' ? host.trim() : ''
    if (requested.length > 0) {
      const entry = mustGet(requested)
      state.set(sessionId, entry.name)
      return { host: entry.name, source: 'ssh_use' }
    }
    const scoped = state.get(sessionId)
    if (scoped !== null && byName.has(scoped)) return { host: scoped, source: 'ssh_use' }
    const stored = typeof state.getDefault === 'function' ? state.getDefault() : null
    if (stored !== null && byName.has(stored)) return { host: stored, source: 'default' }
    const configured = typeof cfg.defaultHost === 'string' ? cfg.defaultHost.trim() : ''
    if (configured.length > 0 && byName.has(configured)) return { host: configured, source: 'config' }
    return { host: '', source: 'none' }
  }

  async function run({ host: requestedHost, command, cwd, timeoutMs, stdin, sessionId, signal } = {}) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new ToolFailure('invalid-args', 'command 必须是非空字符串')
    }
    checkCommand(command)
    const host = effectiveHost(sessionId, requestedHost)
    const workdir = typeof cwd === 'string' && cwd.trim().length > 0
      ? cwd.trim()
      : host.defaultWorkdir
    if (workdir.length > 0 && !workdir.startsWith('/')) {
      throw new ToolFailure('invalid-args', `cwd 必须是远端绝对路径，收到 ${workdir}`)
    }
    try {
      const result = await exec.run(host, {
        command,
        cwd: workdir,
        timeoutMs: normalizeTimeout(timeoutMs),
        stdin,
        signal
      })
      return {
        host: host.name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncatedStdout: result.truncated.stdout,
        truncatedStderr: result.truncated.stderr,
        durationMs: result.durationMs,
        readOnlyHost: host.readOnly
      }
    } catch (error) {
      throw toFailure(error, host)
    }
  }

  async function read({ host: requestedHost, path, offset, limit, sessionId, signal } = {}) {
    const remotePath = assertAbsoluteRemotePath(path)
    const host = effectiveHost(sessionId, requestedHost)
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
      throw new ToolFailure('invalid-args', 'offset 是从 1 开始的行号')
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ToolFailure('invalid-args', 'limit 必须是正整数行数')
    }
    let file
    try {
      file = await exec.readText(host, remotePath, { maxBytes: cfg.maxReadBytes, signal })
    } catch (error) {
      throw toFailure(error, host)
    }
    const lines = file.text.split('\n')
    const startLine = offset === undefined ? 1 : offset
    const maxLines = limit === undefined ? DEFAULT_READ_LINES : limit
    // 越界不夹到末行：宁可返回空，也不要让模型以为读到的是 offset 那一行
    const selected = startLine > lines.length ? [] : lines.slice(startLine - 1, startLine - 1 + maxLines)
    const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1
    return {
      host: host.name,
      path: remotePath,
      content: selected.join('\n'),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      bytes: file.bytes
    }
  }

  async function write({ host: requestedHost, path, content, sessionId, signal } = {}) {
    const remotePath = assertAbsoluteRemotePath(path)
    if (typeof content !== 'string') throw new ToolFailure('invalid-args', 'content 必须是字符串')
    const host = effectiveHost(sessionId, requestedHost)
    requireWritable(host, '写入')
    try {
      const result = await exec.writeText(host, remotePath, content, { signal })
      return { host: host.name, path: remotePath, bytes: result.bytes, created: result.created }
    } catch (error) {
      throw toFailure(error, host)
    }
  }

  async function edit({ host: requestedHost, path, oldString, newString, replaceAll = false, sessionId, signal } = {}) {
    const remotePath = assertAbsoluteRemotePath(path)
    if (typeof oldString !== 'string' || oldString.length === 0) {
      throw new ToolFailure('invalid-args', 'oldString 必须是非空字符串')
    }
    if (typeof newString !== 'string') throw new ToolFailure('invalid-args', 'newString 必须是字符串')
    const host = effectiveHost(sessionId, requestedHost)
    requireWritable(host, '编辑')

    let file
    try {
      file = await exec.readText(host, remotePath, { maxBytes: cfg.maxReadBytes, signal })
    } catch (error) {
      throw toFailure(error, host)
    }
    const occurrences = countOccurrences(file.text, oldString)
    if (occurrences === 0) {
      throw new ToolFailure('not-found', `在 ${remotePath} 里没找到 oldString（文件未修改）`)
    }
    if (occurrences > 1 && replaceAll !== true) {
      throw new ToolFailure('not-unique',
        `oldString 在 ${remotePath} 里出现 ${occurrences} 次，无法确定改哪一处（文件未修改）。`
        + '请给出更长的上下文，或显式设置 replaceAll: true。')
    }
    const next = replaceAll === true
      ? file.text.split(oldString).join(newString)
      : file.text.replace(oldString, newString)
    try {
      await exec.writeText(host, remotePath, next, { signal })
    } catch (error) {
      throw toFailure(error, host)
    }
    return { host: host.name, path: remotePath, replacements: replaceAll === true ? occurrences : 1 }
  }

  async function ls({ host: requestedHost, path, sessionId, signal } = {}) {
    const host = effectiveHost(sessionId, requestedHost)
    const raw = typeof path === 'string' && path.trim().length > 0 ? path.trim() : host.defaultWorkdir
    if (raw.length === 0) {
      throw new ToolFailure('invalid-args', `没有给定 path，主机 ${host.name} 也没有配置 defaultWorkdir`)
    }
    const remotePath = assertAbsoluteRemotePath(raw)
    try {
      const result = await exec.list(host, remotePath, { signal })
      return { host: host.name, path: remotePath, entries: result.entries, truncated: result.truncated }
    } catch (error) {
      throw toFailure(error, host)
    }
  }

  return { listHosts, useHost, run, read, write, edit, ls, effectiveHost, hostNames: names }
}
