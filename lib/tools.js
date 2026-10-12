/**
 * 模型可见的工具契约。
 *
 * 设计原则：
 *  - 语义对齐本地同名工具（read 的 offset/limit 是行号、edit 的 oldString 必须唯一），
 *    模型没有学习成本；
 *  - 非零退出码是**正常结果**（exitCode 字段），只有基础设施失败才 isError；
 *  - 每个结果都回显 host，避免多机会话里记混；
 *  - description 从模型视角写，不出现 UI/传输/实现词汇。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

const HOST_VIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    user: { type: 'string', required: true },
    host: { type: 'string', required: true },
    port: { type: 'number', required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    description: { type: 'string', required: true },
    defaultWorkdir: { type: 'string', required: true },
    readOnly: { type: 'boolean', required: true },
    auth: {
      type: 'string',
      required: true,
      description: 'Login method: key | password | key+password | agent (no secret material is ever returned)'
    },
    via: { type: 'string' }
  }
}

const HOSTS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    total: { type: 'number', required: true },
    defaultHost: {
      type: 'string',
      required: true,
      description: 'The host a call actually uses when host is omitted (session default, else global default, else config); empty when none is configured'
    },
    defaultSource: {
      type: 'string',
      required: true,
      description: 'Where defaultHost comes from: session (ssh_use or the /ssh command), default (set in the SSH hosts settings card), config, or none'
    },
    hosts: { type: 'array', required: true, items: HOST_VIEW }
  }
}

const USE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    source: { type: 'string', required: true }
  }
}

const RUN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    exitCode: { type: 'number', required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    truncatedStdout: { type: 'boolean', required: true },
    truncatedStderr: { type: 'boolean', required: true },
    durationMs: { type: 'number', required: true },
    readOnlyHost: { type: 'boolean', required: true }
  }
}

const READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    path: { type: 'string', required: true },
    content: { type: 'string', required: true },
    startLine: { type: 'number', required: true },
    endLine: { type: 'number', required: true },
    totalLines: { type: 'number', required: true },
    truncated: { type: 'boolean', required: true },
    bytes: { type: 'number', required: true }
  }
}

const WRITE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    path: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    created: { type: 'boolean', required: true }
  }
}

const EDIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    path: { type: 'string', required: true },
    replacements: { type: 'number', required: true }
  }
}

const LS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    path: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    entries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          type: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          size: { type: 'number', required: true },
          mtime: { type: 'number', required: true }
        }
      }
    }
  }
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function jsonRender(_args, value) {
  return text(JSON.stringify(value, null, 2))
}

function renderHosts(_args, value) {
  if (value.hosts.length === 0) {
    return text(`未配置主机（来源：${value.source}，共 ${value.total} 台）`)
  }
  const lines = [`配置来源：${value.source}（共 ${value.total} 台）`]
  if (value.defaultHost.length > 0) {
    const from = value.defaultSource === 'session' ? '，本会话在用'
      : value.defaultSource === 'config' ? '，来自插件 config' : ''
    lines.push(`默认主机：${value.defaultHost}${from}`)
  }
  for (const host of value.hosts) {
    const target = host.user.length > 0 ? `${host.user}@${host.host}` : host.host
    const flags = [
      host.port !== 22 ? `port=${host.port}` : '',
      `auth=${host.auth}`,
      host.readOnly ? 'readOnly' : '',
      host.via !== undefined ? `via ${host.via}` : ''
    ].filter(Boolean).join(' ')
    lines.push(`- ${host.name} → ${target}${flags.length > 0 ? ` (${flags})` : ''}` +
      `${host.tags.length > 0 ? ` [${host.tags.join(', ')}]` : ''}`)
    if (host.description.length > 0) lines.push(`    ${host.description}`)
    if (host.defaultWorkdir.length > 0) lines.push(`    默认目录：${host.defaultWorkdir}`)
  }
  return text(lines.join('\n'))
}

function renderUse(_args, value) {
  return text(value.host.length > 0
    ? `本会话默认主机：${value.host}（来源：${value.source}）`
    : '本会话没有默认主机，也没有配置 defaultHost：每次调用都要显式指定 host。')
}

function renderRun(_args, value) {
  const head = `[${value.host}] exit ${value.exitCode} · ${value.durationMs} ms${value.readOnlyHost ? ' · readOnly 主机' : ''}`
  const blocks = [head]
  if (value.stdout.length > 0) blocks.push(value.stdout.replace(/\n$/, ''))
  if (value.stderr.length > 0) blocks.push(`--- stderr ---\n${value.stderr.replace(/\n$/, '')}`)
  if (value.truncatedStdout || value.truncatedStderr) blocks.push('（输出超过上限，仅保留尾部）')
  return text(blocks.join('\n'))
}

function renderRead(_args, value) {
  const head = `[${value.host}] ${value.path} · 第 ${value.startLine}-${value.endLine} 行 / 共 ${value.totalLines} 行` +
    `${value.truncated ? '（已截断）' : ''}`
  return text(`${head}\n${value.content}`)
}

function renderWrite(_args, value) {
  return text(`[${value.host}] ${value.created ? '已创建' : '已覆盖'} ${value.path}（${value.bytes} 字节，原子替换）`)
}

function renderEdit(_args, value) {
  return text(`[${value.host}] ${value.path}：替换 ${value.replacements} 处`)
}

function renderLs(_args, value) {
  const lines = [`[${value.host}] ${value.path}`]
  for (const entry of value.entries) {
    const size = entry.type === 'directory' ? '-' : String(entry.size)
    lines.push(`${entry.mode}  ${size.padStart(10)}  ${entry.name}${entry.type === 'directory' ? '/' : ''}`)
  }
  if (value.entries.length === 0) lines.push('（空目录）')
  if (value.truncated) lines.push('（列表过长，已截断）')
  return text(lines.join('\n'))
}

/** 每个工具都需要的 host 参数说明 */
const HOST_PARAM = {
  type: 'string',
  description: '主机名（见 ssh_hosts 的列表）；省略时使用本会话默认主机，再退到配置的 defaultHost'
}

/** 从工具执行上下文里取会话 id（有 agent 才有；没有则用空串，退化为无会话默认） */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' ? id : ''
}

/**
 * 注册全部工具。
 * @returns 释放函数（撤销所有注册）
 */
export function registerTools(ctx, handlers) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_hosts',
    description: 'List the SSH servers configured for this deployment (name, login user, address, tags, description, default directory, auth method). Call this first to learn which host names the other ssh_* tools accept. When a host reports auth=password but its password is not set yet, tell the user to fill it in the SSH hosts settings card (the model cannot set passwords).',
    parameters: {
      tag: { type: 'string', description: 'Only list hosts carrying this tag' }
    },
    output: { schema: HOSTS_OUTPUT, render: renderHosts },
    async execute(args, exec) {
      return handlers.listHosts({ tag: args.tag, sessionId: sessionIdOf(exec) })
    }
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_use',
    description: 'Read or set the default SSH host for this session. With a host name, later ssh_run/ssh_read/ssh_write/ssh_edit/ssh_ls calls may omit their host argument. Without arguments, report which host is currently effective.',
    parameters: {
      host: { ...HOST_PARAM, description: 'Host name to make the session default; omit to just report the current one' }
    },
    output: { schema: USE_OUTPUT, render: renderUse },
    async execute(args, exec) {
      return handlers.useHost({ host: args.host, sessionId: sessionIdOf(exec) })
    }
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_run',
    description: 'Run a shell command on a configured SSH server and return its exit code, stdout and stderr. A non-zero exit code is a normal result, not a failure. Use ssh_read/ssh_write/ssh_edit for file contents instead of shell redirection.',
    parameters: {
      host: HOST_PARAM,
      command: { type: 'string', required: true, description: 'Command line to run on the remote host' },
      cwd: { type: 'string', description: 'Remote absolute working directory; defaults to the host defaultWorkdir' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (1000-1800000); defaults to the plugin setting' },
      stdin: { type: 'string', description: 'Text piped to the command standard input' }
    },
    output: { schema: RUN_OUTPUT, render: renderRun },
    async execute(args, exec) {
      return handlers.run({
        host: args.host,
        command: args.command,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        stdin: args.stdin,
        sessionId: sessionIdOf(exec),
        signal: exec.signal
      })
    }
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_read',
    description: 'Read a UTF-8 text file on a configured SSH server, optionally a line range. Line numbers start at 1.',
    parameters: {
      host: HOST_PARAM,
      path: { type: 'string', required: true, description: 'Remote absolute file path' },
      offset: { type: 'number', description: 'First line to return (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to return' }
    },
    output: { schema: READ_OUTPUT, render: renderRead },
    async execute(args, exec) {
      return handlers.read({
        host: args.host,
        path: args.path,
        offset: args.offset,
        limit: args.limit,
        sessionId: sessionIdOf(exec),
        signal: exec.signal
      })
    }
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_write',
    description: 'Create or replace a text file on a configured SSH server. The remote write is atomic: a temporary file in the same directory is renamed over the target, and an existing file keeps its permissions.',
    parameters: {
      host: HOST_PARAM,
      path: { type: 'string', required: true, description: 'Remote absolute file path' },
      content: { type: 'string', required: true, description: 'Full new file content' }
    },
    output: { schema: WRITE_OUTPUT, render: renderWrite },
    async execute(args, exec) {
      return handlers.write({
        host: args.host,
        path: args.path,
        content: args.content,
        sessionId: sessionIdOf(exec),
        signal: exec.signal
      })
    }
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_edit',
    description: 'Replace an exact string in a file on a configured SSH server. oldString must occur exactly once unless replaceAll is true; otherwise the file is left unchanged.',
    parameters: {
      host: HOST_PARAM,
      path: { type: 'string', required: true, description: 'Remote absolute file path' },
      oldString: { type: 'string', required: true, description: 'Exact text to replace, including indentation' },
      newString: { type: 'string', required: true, description: 'Replacement text' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' }
    },
    output: { schema: EDIT_OUTPUT, render: renderEdit },
    async execute(args, exec) {
      return handlers.edit({
        host: args.host,
        path: args.path,
        oldString: args.oldString,
        newString: args.newString,
        replaceAll: args.replaceAll,
        sessionId: sessionIdOf(exec),
        signal: exec.signal
      })
    }
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ssh_ls',
    description: 'List a directory on a configured SSH server with type, permissions, size and modification time.',
    parameters: {
      host: HOST_PARAM,
      path: { type: 'string', description: 'Remote absolute directory path; defaults to the host defaultWorkdir' }
    },
    output: { schema: LS_OUTPUT, render: renderLs },
    async execute(args, exec) {
      return handlers.ls({
        host: args.host,
        path: args.path,
        sessionId: sessionIdOf(exec),
        signal: exec.signal
      })
    }
  })))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载时尽力而为 */
      }
    }
  }
}

export { jsonRender }
