#!/usr/bin/env node
/**
 * 真实服务器冒烟脚本：把模型会看到的每一步原样打出来。
 *
 *   node scripts/smoke-remote.mjs [host] [user]
 *
 * 默认打测试机；密钥取 .test-keys/id_ed25519，known_hosts 取 .test-keys/known_hosts。
 * 全程只用密钥认证，不需要也不接受密码。
 */
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExec } from '../lib/exec.js'
import { createHandlers } from '../lib/handlers.js'
import { createSessionState } from '../lib/session-state.js'
import { createFakeRegistry, executionContext } from '../test/harness.mjs'
import { registerTools } from '../lib/tools.js'

const ROOT = join(import.meta.dirname, '..')
const HOSTNAME = process.argv[2] ?? process.env.DSH_SSH_HOSTS_REMOTE_HOST ?? 'test-host.example.com'
const USER = process.argv[3] ?? process.env.DSH_SSH_HOSTS_REMOTE_USER ?? 'ubuntu'
const KEY = process.env.DSH_SSH_HOSTS_REMOTE_KEY ?? join(ROOT, '.test-keys', 'id_ed25519')
const KNOWN_HOSTS = process.env.DSH_SSH_HOSTS_REMOTE_KNOWN_HOSTS ?? join(ROOT, '.test-keys', 'known_hosts')
const REMOTE_DIR = `/tmp/dsh-ssh-hosts-smoke-${process.pid}`

function requireKey() {
  let info
  try {
    info = statSync(KEY)
  } catch {
    console.error(`找不到私钥：${KEY}\n先按 README「测试机准备」把 .test-keys/id_ed25519.pub 装到目标机。`)
    process.exit(1)
  }
  if ((info.mode & 0o077) !== 0) {
    chmodSync(KEY, 0o600)
    console.error(`已把 ${KEY} 权限收紧到 0600`)
  }
}

async function main() {
  requireKey()
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-smoke-'))
  const exec = createExec({
    knownHostsFile: KNOWN_HOSTS,
    strictHostKeyChecking: 'accept-new',
    connectTimeoutSec: 10,
    timeoutMs: 30000,
    controlPersistSec: 60,
    logger: message => console.error(`[exec] ${message}`)
  })
  const state = createSessionState({ file: join(dir, 'state.json') })
  const handlers = createHandlers({
    cfg: { maxReadBytes: 4 * 1024 * 1024, allow: [], deny: [], defaultHost: '', hostsFile: '' },
    hosts: [{
      name: 'test-box', host: HOSTNAME, port: 22, user: USER, identityFile: KEY, proxyJump: '',
      defaultWorkdir: '/tmp', description: '冒烟测试目标机', tags: ['smoke'], connectTimeoutSec: 10,
      keepAliveSec: 0, readOnly: false, jump: undefined
    }],
    source: 'smoke',
    exec,
    state,
    logger: message => console.error(`[plugin] ${message}`)
  })

  const { ctx, definitions } = createFakeRegistry()
  const dispose = registerTools(ctx, handlers)
  const session = executionContext('smoke-session')

  const call = async (name, args) => {
    const definition = definitions.get(name)
    process.stdout.write(`\n=== ${name}(${JSON.stringify(args)}) ===\n`)
    try {
      const value = await definition.execute(args, session)
      const blocks = definition.output.render(args, value)
      process.stdout.write(`${blocks.map(block => block.text).join('\n')}\n`)
      return value
    } catch (error) {
      process.stdout.write(`✗ ${error.name}: ${error.message}（kind=${error.kind}）\n`)
      return undefined
    }
  }

  await call('ssh_hosts', {})
  await call('ssh_use', {})
  await call('ssh_use', { host: 'test-box' })
  await call('ssh_use', {})
  await call('ssh_run', { command: 'uname -a' })
  await call('ssh_run', { command: 'df -h / | tail -1' })
  await call('ssh_run', { command: 'echo "这一步会失败"; exit 3' })
  await call('ssh_run', { command: 'cat /etc/os-release | head -3', cwd: '/etc' })
  await call('ssh_ls', { path: '/etc' })
  await call('ssh_read', { path: '/etc/hostname' })
  await call('ssh_read', { path: '/definitely/missing' })
  await call('ssh_run', { command: `mkdir -p ${REMOTE_DIR}` })
  await call('ssh_write', { path: `${REMOTE_DIR}/demo.txt`, content: 'server: web-01\nport: 8080\n' })
  await call('ssh_read', { path: `${REMOTE_DIR}/demo.txt` })
  await call('ssh_edit', { path: `${REMOTE_DIR}/demo.txt`, oldString: '8080', newString: '9090' })
  await call('ssh_read', { path: `${REMOTE_DIR}/demo.txt`, offset: 2, limit: 1 })
  await call('ssh_run', { command: `rm -rf ${REMOTE_DIR}` })
  await call('ssh_hosts', { tag: 'smoke' })

  dispose()
  await exec.dispose()
  process.stdout.write('\n冒烟结束。\n')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
