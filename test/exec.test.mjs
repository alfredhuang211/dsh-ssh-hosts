import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SshExecError,
  TailBuffer,
  assertAbsoluteRemotePath,
  createExec,
  destinationOf,
  shellQuote,
  sftpQuote,
  withWorkdir
} from '../lib/exec.js'

/** 假 spawn：把「子进程」做成可编排的 EventEmitter，不真的起进程 */
function makeSpawn(respond) {
  const calls = []
  const impl = (binary, args, options) => {
    const call = { binary, args, options, stdin: '' }
    calls.push(call)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      end(data) {
        if (data !== undefined && data !== null) call.stdin += String(data)
      }
    }
    child.closed = false
    const close = code => {
      if (child.closed) return
      child.closed = true
      child.emit('close', code, null)
    }
    // 无 pid：killTree 的 process.kill(-undefined) 会抛错并回落到 child.kill()
    child.kill = () => setImmediate(() => close(null))
    setImmediate(() => {
      const plan = typeof respond === 'function' ? respond(call) : respond
      if (plan === 'hang') return
      if (plan.stdout !== undefined) child.stdout.emit('data', Buffer.from(plan.stdout))
      if (plan.stderr !== undefined) child.stderr.emit('data', Buffer.from(plan.stderr))
      close(plan.code ?? 0)
    })
    return child
  }
  return { impl, calls }
}

function execWith(respond, opts = {}) {
  const { impl, calls } = makeSpawn(respond)
  const controlDir = mkdtempSync(join(tmpdir(), 'ssh-hosts-exec-'))
  const exec = createExec({
    sshBinary: 'ssh',
    sftpBinary: 'sftp',
    controlPersistSec: 0,
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
    controlDir,
    spawnImpl: impl,
    ...opts
  })
  return { exec, calls, controlDir }
}

function host(overrides = {}) {
  return {
    name: 'web-01',
    host: 'example.com',
    port: 22,
    user: 'ubuntu',
    identityFile: '',
    proxyJump: '',
    defaultWorkdir: '',
    description: '',
    tags: [],
    connectTimeoutSec: 0,
    keepAliveSec: 0,
    readOnly: false,
    jump: undefined,
    ...overrides
  }
}

function sftpCommand(call) {
  return call.stdin.trim().split(/\s+/)[0]
}

test('TailBuffer 保留尾部并标记截断', () => {
  const buffer = new TailBuffer(10)
  buffer.push(Buffer.from('0123456789abcdef'))
  assert.equal(buffer.total, 16)
  assert.equal(buffer.text(), '6789abcdef')
  assert.equal(buffer.truncated, true)
})

test('TailBuffer 未超限时不标记截断', () => {
  const buffer = new TailBuffer(10)
  buffer.push(Buffer.from('abc'))
  assert.equal(buffer.text(), 'abc')
  assert.equal(buffer.truncated, false)
})

test('shellQuote / sftpQuote 处理引号', () => {
  assert.equal(shellQuote("/tmp/it's here"), `'/tmp/it'\\''s here'`)
  assert.equal(sftpQuote('/tmp/a"b\\c'), '"/tmp/a\\"b\\\\c"')
})

test('withWorkdir 只在给了 cwd 时拼接', () => {
  assert.equal(withWorkdir('', 'ls'), 'ls')
  assert.equal(withWorkdir('/srv/app', 'ls'), `cd -- '/srv/app' || exit 66\nls`)
})

test('assertAbsoluteRemotePath 拒绝相对路径与空值', () => {
  assert.equal(assertAbsoluteRemotePath(' /etc/hosts '), '/etc/hosts')
  assert.throws(() => assertAbsoluteRemotePath('etc/hosts'), /绝对路径/)
  assert.throws(() => assertAbsoluteRemotePath('  '), /非空/)
})

test('destinationOf 省略空 user', () => {
  assert.equal(destinationOf(host()), 'ubuntu@example.com')
  assert.equal(destinationOf(host({ user: '' })), 'example.com')
})

test('run 的 argv：批量模式、指纹策略、目标与命令分离', async () => {
  const { exec, calls } = execWith({ code: 0, stdout: 'ok\n' })
  const result = await exec.run(host(), { command: 'uptime' })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'ok\n')
  assert.equal(calls.length, 1)
  const { binary, args } = calls[0]
  assert.equal(binary, 'ssh')
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', 'ubuntu@example.com', 'uptime'])
  for (const expected of ['BatchMode=yes', 'StrictHostKeyChecking=accept-new', 'ConnectTimeout=10']) {
    assert.ok(args.includes(expected), `缺少 ${expected}`)
  }
  assert.equal(args.includes('ControlMaster=auto'), false, 'controlPersistSec=0 时不该复用连接')
})

test('run 带上端口、密钥与跳板参数', async () => {
  const { exec, calls } = execWith({ code: 0 })
  await exec.run(host({ port: 2222, identityFile: '/keys/id_ed25519', jump: 'jump@bastion:22' }), { command: 'true' })
  const { args } = calls[0]
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', '2222'])
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/keys/id_ed25519'])
  assert.deepEqual(args.slice(args.indexOf('-J'), args.indexOf('-J') + 2), ['-J', 'jump@bastion:22'])
  assert.ok(args.includes('IdentitiesOnly=yes'))
})

test('knownHostsFile 与 keepAlive 进入 argv', async () => {
  const { exec, calls } = execWith({ code: 0 }, { knownHostsFile: '/tmp/known_hosts', strictHostKeyChecking: 'yes' })
  await exec.run(host({ keepAliveSec: 30 }), { command: 'true' })
  const { args } = calls[0]
  assert.ok(args.includes('UserKnownHostsFile=/tmp/known_hosts'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('ServerAliveInterval=30'))
})

test('连接复用：ControlPath 确定性、目录 0700、dispose 会 -O exit', async () => {
  const { exec, calls, controlDir } = execWith({ code: 0 }, { controlPersistSec: 300 })
  await exec.run(host(), { command: 'true' })
  const expected = join(controlDir, `cm-${createHash('sha256').update('ubuntu@example.com').digest('hex').slice(0, 16)}`)
  assert.ok(calls[0].args.includes(`ControlPath=${expected}`))
  assert.ok(existsSync(controlDir))

  await exec.dispose()
  const exitCall = calls.find(call => call.args.includes('-O'))
  assert.ok(exitCall, 'dispose 应该向复用的连接发 -O exit')
  assert.deepEqual(exitCall.args, ['-O', 'exit', `-o`, `ControlPath=${expected}`, 'ubuntu@example.com'])
  assert.equal(existsSync(controlDir), false)
})

test('run 的 cwd 通过 cd 前缀实现', async () => {
  const { exec, calls } = execWith({ code: 0 })
  await exec.run(host(), { command: 'ls -la', cwd: '/srv/app' })
  assert.equal(calls[0].args.at(-1), `cd -- '/srv/app' || exit 66\nls -la`)
})

test('stdin 透传', async () => {
  const { exec, calls } = execWith({ code: 0 })
  await exec.run(host(), { command: 'cat', stdin: 'hello\n' })
  assert.equal(calls[0].stdin, 'hello\n')
})

test('非零退出码是正常结果，不是错误', async () => {
  const { exec } = execWith({ code: 3, stdout: 'partial', stderr: 'boom' })
  const result = await exec.run(host(), { command: 'false' })
  assert.equal(result.exitCode, 3)
  assert.equal(result.stderr, 'boom')
})

test('输出超限保留尾部', async () => {
  const payload = 'x'.repeat(200)
  const { exec } = execWith({ code: 0, stdout: payload }, { maxOutputBytes: 32 })
  const result = await exec.run(host(), { command: 'yes' })
  assert.equal(result.stdout.length, 32)
  assert.equal(result.truncated.stdout, true)
})

test('exit 255 按 stderr 分类', async () => {
  const cases = [
    ['Permission denied (publickey).', 'auth'],
    ['Host key verification failed.', 'hostkey'],
    ['ssh: Could not resolve hostname nope: Name or service not known', 'dns'],
    ['ssh: connect to host x port 22: Connection refused', 'refused'],
    ['ssh: connect to host x port 22: Operation timed out', 'timeout'],
    ['ssh: connect to host x port 22: No route to host', 'network'],
    ['something odd', 'ssh']
  ]
  for (const [stderr, kind] of cases) {
    const { exec } = execWith({ code: 255, stderr })
    await assert.rejects(
      () => exec.run(host(), { command: 'true' }),
      error => error instanceof SshExecError && error.kind === kind && error.message.includes(stderr.trim())
    )
  }
})

test('超时：kill 掉子进程并按 timeout 报错', async () => {
  const { exec, calls } = execWith('hang', { timeoutMs: 60 })
  await assert.rejects(
    () => exec.run(host(), { command: 'sleep 100' }),
    error => error instanceof SshExecError && error.kind === 'timeout'
  )
  assert.equal(calls.length, 1)
})

test('取消：按 aborted 报错', async () => {
  const controller = new AbortController()
  const { exec } = execWith('hang', { timeoutMs: 5000 })
  const pending = exec.run(host(), { command: 'sleep 100', signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, error => error.kind === 'aborted')
})

test('probe：存在时一次往返拿到权限与大小', async () => {
  const { exec, calls } = execWith({ code: 0, stdout: '644 128\n' })
  assert.deepEqual(await exec.probe(host(), '/etc/hosts'), { exists: true, mode: '644', size: 128 })
  assert.match(calls[0].args.at(-1), /stat -c '%a %s'/)
})

test('probe：exit 3 = 不存在', async () => {
  const { exec } = execWith({ code: 3 })
  assert.deepEqual(await exec.probe(host(), '/nope'), { exists: false })
})

test('readText：get 到临时文件后返回内容', async () => {
  const { exec, calls } = execWith(call => {
    if (call.binary === 'ssh') return { code: 0, stdout: '644 11\n' }
    const match = /^get "([^"]+)" "([^"]+)"$/.exec(call.stdin.trim())
    assert.ok(match, `sftp 批处理应为 get 命令，实际：${call.stdin}`)
    assert.equal(match[1], '/etc/motd')
    writeFileSync(match[2], 'hello world')
    return { code: 0 }
  })
  const result = await exec.readText(host(), '/etc/motd', { maxBytes: 1024 })
  assert.equal(result.text, 'hello world')
  assert.equal(result.mode, '644')
  assert.equal(calls.filter(call => call.binary === 'sftp').length, 1)
})

test('readText：不存在 / 过大都不拉文件', async () => {
  const missing = execWith({ code: 3 })
  await assert.rejects(() => missing.exec.readText(host(), '/nope'), error => error.kind === 'not-found')
  assert.equal(missing.calls.filter(call => call.binary === 'sftp').length, 0)

  const huge = execWith({ code: 0, stdout: '644 999999\n' })
  await assert.rejects(
    () => huge.exec.readText(host(), '/big', { maxBytes: 1024 }),
    error => error.kind === 'too-large'
  )
  assert.equal(huge.calls.filter(call => call.binary === 'sftp').length, 0)
})

test('writeText：put → rename → 保留原权限', async () => {
  const { exec, calls } = execWith(call => {
    if (call.binary === 'ssh') return { code: 0, stdout: '640 12\n' }
    return { code: 0 }
  })
  const result = await exec.writeText(host(), '/etc/app.conf', 'x = 1\n')
  assert.deepEqual(result, { bytes: 6, created: false, mode: '640' })
  const sftp = calls.filter(call => call.binary === 'sftp')
  assert.deepEqual(sftp.map(sftpCommand), ['put', 'rename', 'chmod'])
  const [, local, temp] = /^put "([^"]+)" "([^"]+)"$/.exec(sftp[0].stdin.trim())
  assert.match(temp, /^\/etc\/app\.conf\.dsh-ssh-hosts\.[a-z0-9]+\.tmp$/)
  const rename = /^rename "([^"]+)" "([^"]+)"$/.exec(sftp[1].stdin.trim())
  assert.equal(rename[1], temp)
  assert.equal(rename[2], '/etc/app.conf')
  assert.equal(sftp[2].stdin.trim(), 'chmod 640 "/etc/app.conf"')
  assert.ok(local.length > 0)
})

test('writeText：新文件只做 put → rename，标记 created', async () => {
  const { exec, calls } = execWith(call => (call.binary === 'ssh' ? { code: 3 } : { code: 0 }))
  const result = await exec.writeText(host(), '/tmp/new.txt', 'hi')
  assert.deepEqual(result, { bytes: 2, created: true, mode: undefined })
  assert.deepEqual(calls.filter(call => call.binary === 'sftp').map(sftpCommand), ['put', 'rename'])
})

test('writeText：put 失败时清理远端临时文件并保留原错误', async () => {
  const { exec, calls } = execWith(call => {
    if (call.binary === 'ssh') return { code: 0, stdout: '644 1\n' }
    return sftpCommand(call) === 'put' ? { code: 255, stderr: 'Permission denied' } : { code: 0 }
  })
  await assert.rejects(() => exec.writeText(host(), '/etc/app.conf', 'x'), error => error.kind === 'auth')
  assert.ok(calls.filter(call => call.binary === 'sftp').map(sftpCommand).includes('rm'))
})

test('list：解析 GNU stat 输出并排序', async () => {
  const { exec } = execWith({ code: 0, stdout: [
    'drwxr-xr-x 4096 1700000000 /etc/nginx',
    '-rw-r--r-- 12 1700000001 /etc/hostname',
    'lrwxrwxrwx 4 1700000002 /etc/localtime'
  ].join('\n') })
  const { entries, truncated } = await exec.list(host(), '/etc')
  assert.equal(truncated, false)
  assert.deepEqual(entries.map(entry => entry.name), ['hostname', 'localtime', 'nginx'])
  assert.deepEqual(entries.map(entry => entry.type), ['file', 'symlink', 'directory'])
  assert.equal(entries[0].size, 12)
  assert.equal(entries[1].mode, 'lrwxrwxrwx')
})

test('list：不是目录时报 not-a-directory', async () => {
  const { exec } = execWith({ code: 3 })
  await assert.rejects(() => exec.list(host(), '/etc/hosts'), error => error.kind === 'not-a-directory')
})

test('密码主机：argv/env 里都没有明文，秘密只在 0600 一次性文件里，用完即删', async () => {
  const captured = {}
  const { exec, calls } = execWith(call => {
    // 子进程「运行中」的这一刻读，才能看到一次性文件还在
    captured.env = call.options.env
    captured.args = call.args
    captured.secretFile = call.options.env.DSH_SSH_HOSTS_ASKPASS_FILE
    captured.askpass = call.options.env.SSH_ASKPASS
    captured.secretMode = statSync(captured.secretFile).mode & 0o777
    captured.askpassMode = statSync(captured.askpass).mode & 0o777
    captured.secretText = readFileSync(captured.secretFile, 'utf8')
    captured.printed = execFileSync('sh', [captured.askpass], {
      env: { DSH_SSH_HOSTS_ASKPASS_FILE: captured.secretFile }
    }).toString()
    return { code: 0, stdout: 'ok\n' }
  }, { resolvePassword: async () => 'S3cr3t!pa$$' })

  const result = await exec.run(host({ passwordRef: 'DSH_SSH_HOSTS_PASSWORD_WEB_01' }), { command: 'uptime' })
  assert.equal(result.exitCode, 0)

  // 密码登录必须关掉 BatchMode，并且只允许一次提示
  assert.equal(captured.args.includes('BatchMode=yes'), false)
  assert.ok(captured.args.includes('NumberOfPasswordPrompts=1'))
  assert.ok(captured.args.includes('PreferredAuthentications=password,keyboard-interactive'))
  // 命令行参数里没有明文
  assert.equal(captured.args.some(arg => arg.includes('S3cr3t!pa$$')), false)
  // 环境变量里只有路径，没有明文
  assert.equal(captured.env.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(Object.values(captured.env).some(value => typeof value === 'string' && value.includes('S3cr3t!pa$$')), false)
  // 秘密文件 0600、助手脚本 0700、助手能吐出密码
  assert.equal(captured.secretMode, 0o600)
  assert.equal(captured.askpassMode, 0o700)
  assert.equal(captured.secretText, 'S3cr3t!pa$$\n')
  assert.equal(captured.printed, 'S3cr3t!pa$$\n')
  // 调用结束后一次性目录被删掉
  assert.equal(existsSync(captured.secretFile), false)
  assert.equal(existsSync(captured.askpass), false)
})

test('密钥 + 密码：先公钥后密码，-i 仍在', async () => {
  const { exec, calls } = execWith({ code: 0 }, { resolvePassword: async () => 'pw' })
  await exec.run(host({ identityFile: '/keys/id_ed25519', passwordRef: 'REF' }), { command: 'true' })
  const { args } = calls[0]
  assert.ok(args.includes('PreferredAuthentications=publickey,password,keyboard-interactive'))
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/keys/id_ed25519'])
  assert.equal(args.includes('BatchMode=yes'), false)
})

test('纯密钥主机不受影响：仍然是 BatchMode，且不注入 askpass', async () => {
  const { exec, calls } = execWith({ code: 0 }, { resolvePassword: async () => 'never-used' })
  await exec.run(host({ identityFile: '/keys/id_ed25519' }), { command: 'true' })
  const { args, options } = calls[0]
  assert.ok(args.includes('BatchMode=yes'))
  assert.equal(args.includes('NumberOfPasswordPrompts=1'), false)
  assert.equal(options.env.SSH_ASKPASS, undefined)
})

test('密码没设：直接报 auth 并说明去哪儿填，不起进程', async () => {
  const { exec, calls } = execWith({ code: 0 }, { resolvePassword: async () => undefined })
  await assert.rejects(
    () => exec.run(host({ passwordRef: 'DSH_SSH_HOSTS_PASSWORD_WEB_01' }), { command: 'true' }),
    error => error instanceof SshExecError && error.kind === 'auth' && /设置界面/.test(error.message))
  assert.equal(calls.length, 0)
})

test('sftp 走同一套密码认证', async () => {
  const captured = {}
  const { exec, calls } = execWith(call => {
    if (call.binary === 'sftp') {
      captured.env = call.options.env
      captured.args = call.args
      return { code: 0 }
    }
    return { code: 0, stdout: '755 4\n' }
  }, { resolvePassword: async () => 'pw' })
  // 读文件会在「落地文件不存在」这一步失败，但 sftp 那次调用已经足够断言
  await assert.rejects(() => exec.readText(host({ passwordRef: 'REF' }), '/tmp/f'), /落地文件/)
  assert.equal(captured.args.includes('BatchMode=yes'), false)
  assert.ok(captured.args.includes('PreferredAuthentications=password,keyboard-interactive'))
  assert.equal(captured.env.SSH_ASKPASS_REQUIRE, 'force')
  assert.ok(calls.some(call => call.binary === 'sftp'))
})
