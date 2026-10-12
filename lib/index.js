/**
 * dsh-ssh-hosts —— host 插件入口。
 *
 * 形态要点：
 *  - `inject = ['tools']`：工具注册表就绪后才激活这一行；
 *  - 导出的 `Config` 让宿主校验 cordis.patch.yml 里的 config 并填默认值；
 *  - 装载期就把清单读进来并校验：配置错了要**当场失败**，不能等到模型调用才发现；
 *  - 工具拿到的是「当前 handlers」的门面，所以设置界面改完清单**不用重启**；
 *  - 设置界面走同源 HTTP 路由（webServer seam）；服务不存在时插件照常工作，
 *    只是没有界面；
 *  - 所有外部资源（工具注册、路由、SSH 复用连接、socket 目录）都用 ctx.effect 包住，
 *    fiber 卸载时自动回收。
 */
import { Config, NS, liveConfig, normalizeConfig, resolveHostsFile, resolveStateFile } from './config.js'
import { loadHosts } from './hosts.js'
import { SshExecError, createExec } from './exec.js'
import { createSessionState } from './session-state.js'
import { createHostService } from './service.js'
import { registerRoutes } from './api.js'
import { registerTools } from './tools.js'
import { registerSshCommand } from './command.js'

export const name = NS
export const inject = ['tools']
export { Config }

export function apply(ctx, config = {}) {
  // 宿主经过 Config 校验后，volatile 字段是「引用」而不是值：取一次当下值用于
  // 一次性决定（清单路径、exec 默认值），另给工具侧一个每次读都取当下值的视图。
  const snapshot = normalizeConfig(config)
  const cfg = liveConfig(config)
  const logger = (...args) => {
    try {
      const log = typeof ctx.logger === 'function' ? ctx.logger(name) : undefined
      if (log?.info !== undefined) log.info(...args)
    } catch {
      /* 日志失败不能影响插件 */
    }
  }

  const hostsFile = resolveHostsFile(snapshot)
  const state = createSessionState({ file: resolveStateFile(snapshot) })

  // 密码（host.passwordRef）只在 DSH 凭据库里存取，插件自己不落地任何秘密。
  // credentials 是**可选**依赖：不把它放进 inject（否则没装凭据服务的 profile 直接不装载），
  // 而是用 ctx.inject 等它出现；也不能直接写 ctx.credentials —— 未在 inject 里声明的
  // 服务，在插件自己的 scoped context 上访问会抛「cannot get property ... without inject」。
  // 凭据服务不在时插件照常工作，只是密码主机连不上、设置界面会说明原因。
  let credentialProvider
  ctx.inject(['credentials'], (scoped) => {
    credentialProvider = scoped.credentials
    return () => {
      credentialProvider = undefined
    }
  })
  const credentials = () => credentialProvider
  // 每次调用都重新解析：改密码立刻对下一次调用生效。
  const resolvePassword = async host => {
    const provider = credentials()
    if (provider === undefined) {
      throw new SshExecError('auth',
        `主机 ${host.name} 用密码登录，但当前 profile 没有 credentials 服务：请在桌面应用里运行，或改用密钥登录`)
    }
    const resolved = await provider.resolve(host.passwordRef)
    return resolved?.value
  }

  const exec = createExec({
    strictHostKeyChecking: snapshot.strictHostKeyChecking,
    knownHostsFile: snapshot.knownHostsFile,
    connectTimeoutSec: snapshot.connectTimeoutSec,
    timeoutMs: snapshot.timeoutMs,
    maxOutputBytes: snapshot.maxOutputBytes,
    controlPersistSec: snapshot.controlPersistSec,
    resolvePassword,
    logger
  })

  const service = createHostService({ cfg, hostsFile, state, exec, logger, credentials })
  // 装载期失败是刻意的硬失败：清单读不到/权限不对/字段非法都在这里炸。
  const installed = service.install()

  ctx.effect(() => registerTools(ctx, service.live))

  // `/ssh` 斜杠命令：让「选服务器」出现在会话窗口的「+」命令菜单里。
  // commands 同样是**可选**依赖（纯工具场景/裁剪过的 profile 可能没有），
  // 所以走 ctx.inject 等它出现，而不是写进 inject 让插件整个不装载。
  ctx.inject(['commands'], (scoped) => {
    ctx.effect(() => {
      try {
        return registerSshCommand(scoped.commands, { live: service.live, state, logger })
      } catch (error) {
        // 命令名撞车（别人的 profile 里已有 /ssh）不该把整个插件拖下水：
        // 工具与设置界面才是主体，这条命令只是「+」菜单里的便利入口。
        logger(`注册 /ssh 命令失败，跳过：${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }, 'ssh-hosts: /ssh command')
  })

  // 设置界面（浏览器半边）用的接口。webServer/connection 不在时整段不激活，
  // 插件在纯 CLI profile 下仍然完全可用。
  ctx.inject(['webServer', 'connection'], (scoped) => {
    ctx.effect(
      () => registerRoutes(scoped.webServer, scoped.connection, {
        list: () => service.list(),
        upsert: (entry, options) => service.upsert(entry, options),
        remove: (entryName) => service.remove(entryName),
        setDefault: (entryName) => service.setDefault(entryName),
        reload: () => service.reload(),
        test: (entryName) => service.test(entryName)
      }),
      'ssh-hosts: ui routes'
    )
  })

  ctx.effect(() => () => {
    void exec.dispose()
    state.removeStaleTemps()
  })

  logger(`已装载 ${installed.hosts.length} 台主机（来源：${installed.source}${snapshot.hosts.length > 0 ? '，config.hosts' : ''}）`)
  return { hosts: installed.hosts, hostsFile, service, handlers: service.live }
}

export { loadHosts, parseHostsDocument } from './hosts.js'
export { createExec, SshExecError } from './exec.js'
export { createHandlers } from './handlers.js'
export { createSessionState } from './session-state.js'
export { createHostService, liveHandlers, UiFailure } from './service.js'
export { registerRoutes, ROUTE_PREFIX } from './api.js'
export { registerSshCommand, COMMAND_NAME } from './command.js'
export { serializeHosts, parseHostsForEdit, writeHostsText } from './hosts-doc.js'
