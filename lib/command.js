/**
 * `/ssh` —— 把「选择服务器」做进会话窗口。
 *
 * 为什么要有这条命令：工具是**模型**用的接口，人想指定一台服务器时只能在
 * 聊天里写字（「在 web-01 上执行…」），或者让模型先 `ssh_use`。DSH 的斜杠命令
 * 是**人**用的接口，而且会话窗口的「+」按钮展开的就是命令菜单 —— 所以把
 * 「选服务器」做成一条命令，人就能在输入框旁边直接点选。
 *
 * 两个半边各司其职（与官方 `/permission` 完全同一套 seam）：
 *  - host 侧（本文件）：注册 `/ssh <主机名>`，把**本会话**的默认主机写进
 *    `ssh-hosts.state.json` —— 与 `ssh_use` 工具同一份状态、同一条代码路径，
 *    所以「命令选的机器」和「模型 ssh_use 选的机器」永远是同一件事。
 *  - 浏览器侧（client/bundle.js）：用 `ctx.commandUi.decorate` 给这一行挂一个
 *    主机选择弹窗，点一下等于提交 `/ssh <主机名>`。
 *
 * 会话作用域是刻意的：默认主机按会话隔离（`state.get(sessionId)`），
 * 界面上「设为默认」改的是全局默认，两者不互相覆盖。
 */
import { authModeOf } from './hosts.js'

/** 命令名（不带斜杠）。与 host 命令目录里的其它命令同名会注册失败，故意不吞。 */
export const COMMAND_NAME = 'ssh'

/** 清除本会话默认主机的写法 */
const CLEAR_WORDS = ['clear', 'none', 'off', 'reset', '-']

/** 一行人类可读的主机描述：user@host[:port] · tags · 认证方式 */
function describeHost(host) {
  const user = typeof host.user === 'string' && host.user.length > 0 ? `${host.user}@` : ''
  const port = Number(host.port) > 0 && Number(host.port) !== 22 ? `:${host.port}` : ''
  const tags = Array.isArray(host.tags) && host.tags.length > 0 ? ` · ${host.tags.join('/')}` : ''
  const auth = host.auth !== undefined ? host.auth : authModeOf(host)
  const readOnly = host.readOnly === true ? ' · 只读' : ''
  return `${user}${host.host}${port}${tags} · ${auth}${readOnly}`
}

/** 用法错误（多词、未知主机名）都由这里统一成可照做的文本 */
function usage(hosts) {
  const names = hosts.map(host => host.name)
  return names.length > 0
    ? `用法：/ssh <主机名>（可用：${names.join(', ')}；/ssh clear 清除本会话默认主机）`
    : '用法：/ssh <主机名>，但当前还没有配置任何主机：请在 设置 → SSH 主机 里新增。'
}

/**
 * 注册 `/ssh`。
 * @param {object} commands - `ctx.commands`（interaction/commands 的 CommandRuntime）
 * @param {object} options - 运行时依赖
 * @param {object} options.live - handlers 门面（`ssh_hosts`/`ssh_use` 用的是同一个）
 * @param {object} options.state - createSessionState 的返回值（会话默认主机）
 * @param {Function} [options.logger] - 诊断日志
 * @returns {Function} 释放函数（commands.register 的返回值）
 */
export function registerSshCommand(commands, { live, state, logger = () => {} }) {
  const handler = async (invocation) => {
    const sessionId = invocation?.agent?.session?.id
    const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const listed = await live.listHosts()
    const hosts = Array.isArray(listed?.hosts) ? listed.hosts : []
    const byName = new Map(hosts.map(host => [host.name, host]))

    // 裸 `/ssh`：报当前值 + 可用主机。GUI 里裸命令会被浏览器侧的弹窗接管，
    // 所以这里主要服务纯 CLI / 没有弹窗的客户端。
    if (raw.length === 0) {
      const scoped = typeof sessionId === 'string' ? state.get(sessionId) : null
      const current = scoped !== null && byName.has(scoped) ? scoped : ''
      const names = hosts.map(host => host.name)
      if (current.length > 0) {
        return { kind: 'success', text: `本会话默认主机：${current}（${describeHost(byName.get(current))}）。其它可用：${names.filter(name => name !== current).join(', ') || '无'}` }
      }
      return {
        kind: 'success',
        text: names.length > 0
          ? `本会话还没有默认主机。可用：${names.join(', ')}；用 /ssh <主机名> 选择。`
          : '当前还没有配置任何主机：请在 设置 → SSH 主机 里新增。'
      }
    }

    if (CLEAR_WORDS.includes(raw.toLowerCase())) {
      state.set(sessionId, '')
      logger(`/ssh clear：会话 ${String(sessionId)} 的默认主机已清除`)
      return { kind: 'success', text: '已清除本会话默认主机，之后调用要显式给 host。' }
    }

    // 主机名不含空格：多词一律当用法错误，避免把 `/ssh web-01 uptime` 悄悄当成主机名
    if (/\s/.test(raw)) return { kind: 'error', text: usage(hosts) }
    if (!byName.has(raw)) {
      return {
        kind: 'error',
        text: `未知主机 "${raw}"。${usage(hosts)}`
      }
    }

    // 复用 ssh_use 的同一条路径：校验 + 写会话状态都由 handlers 负责
    const used = await live.useHost({ host: raw, sessionId })
    logger(`/ssh：会话 ${String(sessionId)} 的默认主机设为 ${used.host}`)
    return {
      kind: 'success',
      text: `本会话默认主机：${used.host}（${describeHost(byName.get(used.host))}）。之后 ssh_run / ssh_read / ssh_write / ssh_edit / ssh_ls 可以省略 host；用 /ssh clear 清除。`
    }
  }

  return commands.register({
    name: COMMAND_NAME,
    description: '选择本会话默认 SSH 主机（之后 ssh_run 等可省略 host）',
    input: { hint: '<主机名>' },
    handler
  })
}
