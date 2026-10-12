/**
 * SSH 传输层：本地 `ssh` / `sftp` 客户端的封装。
 *
 * 为什么用系统 OpenSSH 而不是 JS SSH 库：
 *  - 认证、known_hosts、ssh-agent、跳板这些安全机制由 OpenSSH 维护，插件不重复实现；
 *  - 运行时依赖少，清单里只存路径、不存秘密；
 *  - 代价是每次调用起一个进程 —— 用 ControlMaster 连接复用把握手成本摊掉。
 *
 * 契约：
 *  - 断连即失败，**不重连、不重放**：远端是否已执行无法确认，重试可能重复生效；
 *  - 输出有硬上限，超出保留尾部并标记 truncated（与本地 Bash 工具一致）；
 *  - 写文件是「临时文件 + rename」原子替换，并尽量保留原文件权限；
 *  - 错误按 kind 分类，交给上层翻成可照做的提示。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 传输层失败的类型；handler 据此给模型可照做的说明 */
export class SshExecError extends Error {
  constructor(kind, message, { detail } = {}) {
    super(message)
    this.name = 'SshExecError'
    this.kind = kind
    if (detail !== undefined) this.detail = detail
  }
}

const KIND_HINT = {
  auth: '认证失败：确认清单里的 user / identityFile，密码主机确认已设置密码（设置界面里填），或先 ssh-add 载入带 passphrase 的密钥',
  hostkey: '主机指纹校验失败：核对目标机是否重装或换过密钥，必要时清理 known_hosts 里的旧条目',
  dns: '域名解析失败：检查 host 字段',
  refused: '连接被拒绝：检查 host/port，以及目标机 sshd 是否在监听',
  timeout: '超时：检查网络与安全组，或调大 connectTimeoutSec / timeoutMs',
  network: '网络不可达：检查本机路由与 VPN',
  'not-found': '远端路径不存在',
  'not-a-directory': '远端路径不是目录',
  'too-large': '远端文件超过读取上限',
  'invalid-args': '参数不合法',
  ssh: 'SSH 调用失败'
}

/** 给模型可照做的失败提示 */
export function hintFor(kind) {
  return KIND_HINT[kind] ?? KIND_HINT.ssh
}

/** 保留尾部字节的输出缓冲：Total 记录真实字节数，Length 是保留下来的尾部 */
export class TailBuffer {
  constructor(limit) {
    this.limit = limit
    this.chunks = []
    this.length = 0
    this.total = 0
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.total += buffer.length
    this.chunks.push(buffer)
    this.length += buffer.length
    while (this.length > this.limit && this.chunks.length > 1) {
      const head = this.chunks.shift()
      this.length -= head.length
    }
    if (this.length > this.limit) {
      const tail = this.chunks[0].subarray(this.length - this.limit)
      this.chunks = [tail]
      this.length = tail.length
    }
    return this
  }

  get truncated() {
    return this.total > this.length
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** 远端 shell 的单引号转义 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** sftp 批处理命令的双引号转义 */
export function sftpQuote(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`
}

/** 给 ssh/sftp 用的目标串 */
export function destinationOf(host) {
  return host.user.length > 0 ? `${host.user}@${host.host}` : host.host
}

/** 把 cwd 拼进远端命令；cwd 已校验为绝对路径，仍按字面量引用 */
export function withWorkdir(cwd, command) {
  if (typeof cwd !== 'string' || cwd.length === 0) return command
  return `cd -- ${shellQuote(cwd)} || exit 66\n${command}`
}

function classifyStderr(stderr) {
  if (/Permission denied|Authentication failed|no supported authentication/i.test(stderr)) return 'auth'
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'hostkey'
  if (/Could not resolve hostname/i.test(stderr)) return 'dns'
  if (/Connection refused/i.test(stderr)) return 'refused'
  if (/Connection timed out|Operation timed out|Timeout, server/i.test(stderr)) return 'timeout'
  if (/No route to host|Network is unreachable/i.test(stderr)) return 'network'
  if (/No such file or directory/i.test(stderr)) return 'not-found'
  return 'ssh'
}

/** 校验一个远端路径参数：必须是绝对路径，避免把相对路径解释到不确定的 cwd */
export function assertAbsoluteRemotePath(value, field = 'path') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SshExecError('invalid-args', `${field} 必须是非空字符串`)
  }
  const path = value.trim()
  if (!path.startsWith('/')) {
    throw new SshExecError('invalid-args', `${field} 必须是远端绝对路径（以 / 开头），收到 ${path}`)
  }
  return path
}

function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * OpenSSH 的 askpass 助手（密码登录用）。
 * 密码既不在脚本里、也不在环境变量里 —— 只在 0600 的一次性文件里，
 * 所以 `ps` 看不到秘密，助手脚本本身可以随便读。
 */
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  '# dsh-ssh-hosts: OpenSSH askpass helper',
  'if [ -n "${DSH_SSH_HOSTS_ASKPASS_FILE:-}" ] && [ -f "$DSH_SSH_HOSTS_ASKPASS_FILE" ]; then',
  '  cat "$DSH_SSH_HOSTS_ASKPASS_FILE"',
  '  exit 0',
  'fi',
  'echo "dsh-ssh-hosts: 一次性密码文件不存在" >&2',
  'exit 1',
  ''
].join('\n')

export function createExec({
  sshBinary = process.env.DSH_SSH_HOSTS_SSH_BIN || 'ssh',
  sftpBinary = process.env.DSH_SSH_HOSTS_SFTP_BIN || 'sftp',
  strictHostKeyChecking = 'accept-new',
  knownHostsFile = '',
  connectTimeoutSec = 10,
  timeoutMs = 60000,
  maxOutputBytes = 262144,
  controlPersistSec = 300,
  controlDir = join(tmpdir(), `dsh-ssh-hosts-${typeof process.getuid === 'function' ? process.getuid() : 'u'}`),
  spawnImpl = nodeSpawn,
  now = () => Date.now(),
  logger = () => {},
  /** 解析 host.passwordRef → 明文密码；缺省表示这台机器只能用密钥/agent */
  resolvePassword = async () => undefined
} = {}) {
  const knownHosts = typeof knownHostsFile === 'string' && knownHostsFile.length > 0
    ? expandHomePath(knownHostsFile)
    : ''
  /** host.name → { destination, controlPath }，dispose 时逐条收尾 */
  const masters = new Map()
  let controlDirReady = false

  function ensureControlDir() {
    if (controlDirReady) return
    mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(controlDir, 0o700)
    } catch {
      /* 目录已存在时无法 chmod 就继续 */
    }
    controlDirReady = true
  }

  function controlPathFor(host) {
    const digest = createHash('sha256').update(destinationOf(host)).digest('hex').slice(0, 16)
    return join(controlDir, `cm-${digest}`)
  }

  function connectionArgs(host, { control = true, password = false } = {}) {
    const args = [
      '-o', `ConnectTimeout=${host.connectTimeoutSec > 0 ? host.connectTimeoutSec : connectTimeoutSec}`,
      '-o', `StrictHostKeyChecking=${strictHostKeyChecking}`
    ]
    if (password) {
      // 密码登录必须关掉 BatchMode（它就是「禁止交互认证」），并只允许一次提示，
      // 免得密码错了以后反复重试到被服务器锁账号。
      args.push('-o', 'NumberOfPasswordPrompts=1')
      args.push('-o', `PreferredAuthentications=${host.identityFile.length > 0 ? 'publickey,password,keyboard-interactive' : 'password,keyboard-interactive'}`)
    } else {
      args.push('-o', 'BatchMode=yes')
    }
    if (knownHosts.length > 0) args.push('-o', `UserKnownHostsFile=${knownHosts}`)
    if (host.keepAliveSec > 0) args.push('-o', `ServerAliveInterval=${host.keepAliveSec}`, '-o', 'ServerAliveCountMax=3')
    if (host.identityFile.length > 0) args.push('-o', 'IdentitiesOnly=yes', '-i', host.identityFile)
    if (control && controlPersistSec > 0) {
      ensureControlDir()
      const controlPath = controlPathFor(host)
      args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', `ControlPersist=${controlPersistSec}`)
      masters.set(host.name, { destination: destinationOf(host), controlPath })
    }
    if (host.jump !== undefined) args.push('-J', host.jump)
    if (host.port !== 22) args.push('-p', String(host.port))
    return args
  }

  function killTree(child) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
    }, 2000)
    timer.unref?.()
  }

  /**
   * 执行一次子进程并收集有界输出。
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, truncated: {stdout: boolean, stderr: boolean}, durationMs: number }>}
   */
  function collect(binary, args, { stdin, timeoutMs: budget = timeoutMs, signal, what = 'ssh', env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const started = now()
      let child
      try {
        child = spawnImpl(binary, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
          env: { ...process.env, ...env }
        })
      } catch (error) {
        reject(new SshExecError('spawn', `${what} 无法启动：${error instanceof Error ? error.message : String(error)}`))
        return
      }

      const stdout = new TailBuffer(maxOutputBytes)
      const stderr = new TailBuffer(maxOutputBytes)
      let timedOut = false
      let aborted = false
      let settled = false

      // 注意：这个 timer 不能 unref —— 假 spawn（单测）没有真实子进程句柄，
      // unref 后事件循环会直接排空，超时永远不会触发，Promise 悬空。
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, budget)

      const onAbort = () => {
        aborted = true
        killTree(child)
      }
      if (signal !== undefined) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      const cleanup = () => {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      }

      child.stdout?.on('data', chunk => stdout.push(chunk))
      child.stderr?.on('data', chunk => stderr.push(chunk))
      child.on('error', error => {
        if (settled) return
        settled = true
        cleanup()
        reject(new SshExecError('spawn', `${what} 无法启动：${error instanceof Error ? error.message : String(error)}`))
      })
      child.on('close', (code, closeSignal) => {
        if (settled) return
        settled = true
        cleanup()
        const out = stdout.text()
        const err = stderr.text()
        const durationMs = now() - started
        const truncation = { stdout: stdout.truncated, stderr: stderr.truncated }
        if (timedOut) {
          reject(new SshExecError('timeout', `${what} 超时（${budget} ms）`, { detail: { stdout: out, stderr: err, durationMs, truncated: truncation } }))
          return
        }
        if (aborted) {
          reject(new SshExecError('aborted', `${what} 已取消`, { detail: { stdout: out, stderr: err, durationMs, truncated: truncation } }))
          return
        }
        if (code === 255) {
          const kind = classifyStderr(err)
          reject(new SshExecError(kind, `${what} 失败（255）：${err.trim() || '无 stderr'}`, { detail: { stderr: err } }))
          return
        }
        if (code === null) {
          reject(new SshExecError('signal', `${what} 被信号 ${closeSignal} 终止`, { detail: { stderr: err } }))
          return
        }
        resolve({ exitCode: code, stdout: out, stderr: err, truncated: truncation, durationMs })
      })

      try {
        if (stdin !== undefined && stdin !== null) child.stdin?.end(stdin)
        else child.stdin?.end()
      } catch (error) {
        logger(`stdin 写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /**
   * 密码登录的一次性准备。
   * 密码写进 0700 临时目录里的 0600 文件，由 askpass 助手读取：
   * 命令行参数、环境变量、日志里都不会出现明文；调用结束（含异常）立刻删除整个目录。
   * @param {object} host - 已归一化的主机
   * @param {(auth: {password: boolean, env: object}) => Promise<any>} fn
   */
  async function withAuth(host, fn) {
    const ref = typeof host.passwordRef === 'string' ? host.passwordRef : ''
    if (ref.length === 0) return await fn({ password: false, env: {} })
    const secret = await resolvePassword(host)
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new SshExecError('auth',
        `主机 ${host.name} 配置为密码登录，但凭据 ${ref} 还没有值：在设置界面的「SSH 主机」里填一次密码（存进 DSH 凭据库），或改用密钥登录`)
    }
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-hosts-askpass-'))
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* mkdtemp 已经是 0700 */
    }
    try {
      const secretFile = join(dir, 'secret')
      writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 })
      const askpass = join(dir, 'askpass.sh')
      writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 })
      return await fn({
        password: true,
        env: {
          SSH_ASKPASS: askpass,
          // OpenSSH ≥ 8.4 认这个；更老的版本在没有 tty 时会退回「有 DISPLAY 就用 askpass」
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: typeof process.env.DISPLAY === 'string' && process.env.DISPLAY.length > 0 ? process.env.DISPLAY : ':0',
          DSH_SSH_HOSTS_ASKPASS_FILE: secretFile
        }
      })
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不覆盖真实错误 */
      }
    }
  }

  /** 在远端执行一条命令（交给远端 shell） */
  function run(host, { command, cwd, timeoutMs: budget, stdin, signal } = {}) {
    return withAuth(host, auth => {
      const args = [...connectionArgs(host, { password: auth.password }), '--', destinationOf(host), withWorkdir(cwd, command)]
      return collect(sshBinary, args, { stdin, timeoutMs: budget ?? timeoutMs, signal, env: auth.env, what: `ssh ${host.name}` })
    })
  }

  /** 一批 sftp 命令；`-b -` 从 stdin 读，遇到第一条失败即停止 */
  function sftpBatch(host, lines, { timeoutMs: budget, signal } = {}) {
    return withAuth(host, auth => {
      const args = [...connectionArgs(host, { password: auth.password }), '-b', '-', destinationOf(host)]
      return collect(sftpBinary, args, {
        stdin: `${lines.join('\n')}\n`,
        timeoutMs: budget ?? timeoutMs,
        signal,
        env: auth.env,
        what: `sftp ${host.name}`
      })
    })
  }

  /** 远端文件的存在性/大小/权限，一次往返拿到 */
  async function probe(host, remotePath, { signal } = {}) {
    const script = [
      `p=${shellQuote(remotePath)}`,
      'if [ -e "$p" ] || [ -L "$p" ]; then',
      "  stat -c '%a %s' -- \"$p\" 2>/dev/null || stat -f '%Lp %z' -- \"$p\" 2>/dev/null || exit 4",
      'else',
      '  exit 3',
      'fi'
    ].join('\n')
    const result = await run(host, { command: script, signal })
    if (result.exitCode === 3) return { exists: false }
    if (result.exitCode !== 0) {
      throw new SshExecError('ssh', `探测远端文件失败（exit ${result.exitCode}）：${result.stderr.trim()}`)
    }
    const [mode, size] = result.stdout.trim().split(/\s+/)
    return { exists: true, mode, size: Number.parseInt(size, 10) }
  }

  /** 目录列举；GNU stat 优先，BSD stat 兜底 */
  async function list(host, remotePath, { signal } = {}) {
    const script = [
      `d=${shellQuote(remotePath)}`,
      'if [ ! -d "$d" ]; then exit 3; fi',
      'for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do',
      '  [ -e "$f" ] || [ -L "$f" ] || continue',
      "  stat -c '%A %s %Y %n' -- \"$f\" 2>/dev/null || stat -f '%Sp %z %m %N' -- \"$f\" 2>/dev/null",
      'done',
      'exit 0'
    ].join('\n')
    const result = await run(host, { command: script, signal })
    if (result.exitCode === 3) throw new SshExecError('not-a-directory', `远端不是目录：${remotePath}`)
    if (result.exitCode !== 0) {
      throw new SshExecError('ssh', `列举远端目录失败（exit ${result.exitCode}）：${result.stderr.trim()}`)
    }
    const entries = []
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue
      const parts = line.split(' ')
      if (parts.length < 4) continue
      const [mode, size, mtime, ...rest] = parts
      const fullPath = rest.join(' ')
      const type = mode.startsWith('d') ? 'directory' : mode.startsWith('l') ? 'symlink' : mode.startsWith('-') ? 'file' : 'other'
      entries.push({
        name: fullPath.split('/').pop() ?? fullPath,
        type,
        mode,
        size: Number.parseInt(size, 10),
        mtime: Number.parseInt(mtime, 10)
      })
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { entries, truncated: result.truncated.stdout }
  }

  /** 临时目录在回调结束后（含异步）才删除 */
  async function withTempDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-hosts-'))
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* mkdtemp 已经是 0700 */
    }
    try {
      return await fn(dir)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不覆盖真实错误 */
      }
    }
  }

  /** 读取远端文本文件；先探测大小，超过上限直接拒绝（不把大文件拉回本地） */
  async function readText(host, remotePath, { maxBytes, signal } = {}) {
    const info = await probe(host, remotePath, { signal })
    if (!info.exists) throw new SshExecError('not-found', `远端文件不存在：${remotePath}`)
    if (maxBytes !== undefined && Number.isFinite(info.size) && info.size > maxBytes) {
      throw new SshExecError('too-large', `远端文件 ${info.size} 字节，超过读取上限 ${maxBytes} 字节：${remotePath}`)
    }
    return withTempDir(async dir => {
      const local = join(dir, 'file')
      await sftpBatch(host, [`get ${sftpQuote(remotePath)} ${sftpQuote(local)}`], { signal })
      let buffer
      try {
        buffer = readFileSync(local)
      } catch (error) {
        throw new SshExecError('ssh', `读取 sftp 落地文件失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return { text: buffer.toString('utf8'), bytes: buffer.length, sizeBytes: info.size, mode: info.mode }
    })
  }

  /** 原子写入：本地临时文件 → 远端同目录临时文件 → rename 覆盖；尽量保留原权限 */
  async function writeText(host, remotePath, content, { signal } = {}) {
    const info = await probe(host, remotePath, { signal })
    const priorMode = info.exists ? info.mode : undefined
    const random = Math.random().toString(36).slice(2, 10)
    const remoteTmp = `${remotePath}.dsh-ssh-hosts.${random}.tmp`
    return withTempDir(async dir => {
      const local = join(dir, 'content')
      writeFileSync(local, content, { mode: 0o600 })
      try {
        await sftpBatch(host, [`put ${sftpQuote(local)} ${sftpQuote(remoteTmp)}`], { signal })
        await sftpBatch(host, [`rename ${sftpQuote(remoteTmp)} ${sftpQuote(remotePath)}`], { signal })
        if (priorMode !== undefined && priorMode.length > 0) {
          // 覆盖已有文件时不要把权限改掉（例如 .env、authorized_keys）
          try {
            await sftpBatch(host, [`chmod ${priorMode} ${sftpQuote(remotePath)}`], { signal })
          } catch (error) {
            logger(`保留 ${remotePath} 原权限失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        try {
          await sftpBatch(host, [`rm ${sftpQuote(remoteTmp)}`], { signal })
        } catch {
          /* 远端临时文件清理是尽力而为 */
        }
        throw error
      }
      return { bytes: Buffer.byteLength(content, 'utf8'), created: !info.exists, mode: priorMode }
    })
  }

  /** 关闭复用的连接，并清掉 socket 目录 */
  async function dispose() {
    for (const { destination, controlPath } of masters.values()) {
      await new Promise(resolve => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        let child
        try {
          child = spawnImpl(sshBinary, ['-O', 'exit', '-o', `ControlPath=${controlPath}`, destination], { stdio: 'ignore' })
        } catch {
          finish()
          return
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* 已退出 */
          }
          finish()
        }, 3000)
        timer.unref?.()
        child.on('close', finish)
        child.on('error', finish)
      })
    }
    masters.clear()
    try {
      rmSync(controlDir, { recursive: true, force: true })
    } catch {
      /* 删除失败留给系统临时目录清理 */
    }
    controlDirReady = false
  }

  return {
    run,
    list,
    probe,
    readText,
    writeText,
    dispose,
    connectionArgs,
    controlPathFor,
    controlDir,
    binaries: { ssh: sshBinary, sftp: sftpBinary }
  }
}
