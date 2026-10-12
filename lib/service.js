/**
 * 界面可管理的运行时。
 *
 * 为什么需要这一层：工具（tools.js）在装载时拿到一份 handlers，而那里面
 * 固化了「当时」的主机清单。界面改了清单后不能重启进程，所以工具每次调用
 * 都取当前的 handlers —— `live` 就是这个间接层。
 *
 * 单一事实来源仍是 `~/.dsh/ssh-hosts.yaml`：界面写文件，写完立刻重载，
 * 手工编辑与界面编辑看到的是同一份东西（这也是不在 config 里再存一份清单的原因）。
 * config.hosts 内联声明时界面只读，因为那份清单属于部署方，不属于这台机器的用户。
 *
 * 写入顺序是「先校验、再原子写、再重载」；重载失败就回滚文件并保留旧清单，
 * 把错误报给界面 —— 界面里一次误操作不能让正在跑的会话失去目标机。
 */
import { homedir } from 'node:os'
import { createHandlers } from './handlers.js'
import { finalizeHosts, loadHosts, normalizeHostEntry } from './hosts.js'
import { hostsFileInfo, parseHostsForEdit, readHostsText, serializeHosts, writeHostsText } from './hosts-doc.js'

/** 面向界面的失败；kind 用于测试与提示，message 直接显示 */
export class UiFailure extends Error {
  constructor(kind, message) {
    super(message)
    this.name = 'UiFailure'
    this.kind = kind
  }
}

/** 界面可写的字段白名单（与 hosts.js 的 ALLOWED_FIELDS 一致，显式列出便于报错） */
export const EDITABLE_FIELDS = [
  'name', 'host', 'port', 'user', 'identityFile', 'passwordRef', 'proxyJump',
  'defaultWorkdir', 'description', 'tags', 'readOnly', 'connectTimeoutSec', 'keepAliveSec'
]

/** 主机名 → 默认密码凭据名（界面填密码时用；`web-01` → `DSH_SSH_HOSTS_PASSWORD_WEB_01`） */
export function passwordRefFor(name) {
  return `DSH_SSH_HOSTS_PASSWORD_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}

/** 只保留界面可编辑字段，并丢掉等于默认值的项，避免把噪音写回文件 */
function pickEditable(raw) {
  if (raw === null || typeof raw !== 'object') return {}
  const out = {}
  for (const key of EDITABLE_FIELDS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (key === 'port' && value === 22) continue
    if (key === 'user' && value === '') continue
    if (key === 'tags' && Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

/**
 * 把「当前 handlers」包装成一个稳定对象：工具每次调用都落到最新一份。
 * @param {() => object} current - 返回当前 handlers
 * @param {object} [options]
 * @param {() => void} [options.before] - 每次取方法前先跑一次（用于发现配置变化并重建）
 */
export function liveHandlers(current, { before } = {}) {
  const cache = new Map()
  return new Proxy({}, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      if (typeof before === 'function') before()
      const value = current()[key]
      if (typeof value !== 'function') return value
      let bound = cache.get(key)
      if (bound === undefined) {
        bound = (...args) => current()[key](...args)
        cache.set(key, bound)
      }
      return bound
    },
    has(_target, key) {
      return typeof key === 'string' && key in current()
    },
    ownKeys() {
      return Reflect.ownKeys(current())
    },
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true }
    }
  })
}

/**
 * 创建可热重载的主机运行时。
 * @param {object} options
 * @param {object} options.cfg - normalizeConfig 之后的配置
 * @param {string} options.hostsFile - 清单文件绝对路径
 * @param {object} options.state - createSessionState 的返回值
 * @param {object} options.exec - createExec 的返回值
 * @param {Function} [options.reloadHosts] - 默认 loadHosts；测试可注入替身
 * @param {Function} [options.credentials] - 返回 ctx.credentials（可能为 undefined）；密码只在里面存取
 */
export function createHostService({
  cfg,
  hostsFile,
  state,
  exec,
  logger = () => {},
  reloadHosts = loadHosts,
  home = homedir(),
  readText = readHostsText,
  writeText = writeHostsText,
  serialize = serializeHosts,
  parseForEdit = parseHostsForEdit,
  fileInfo = hostsFileInfo,
  credentials = () => undefined,
  now = () => new Date().toISOString()
}) {
  const inline = Array.isArray(cfg.hosts) ? cfg.hosts : []
  /** 内联清单属于部署方，界面不可写 */
  const writable = inline.length === 0

  let current = null
  // 设置页改 volatile 配置时宿主**不会**重启插件，只更新引用里的值；
  // 所以每次工具调用前比一次指纹，变了就用新配置重建 handlers。
  // config.hosts（部署方声明的那份）不参与热改，动了它要重启。
  let configFingerprint = fingerprintConfig()

  function fingerprintConfig() {
    return JSON.stringify({ ...cfg, hosts: undefined })
  }

  function syncConfig() {
    const next = fingerprintConfig()
    if (next === configFingerprint || current === null) return
    configFingerprint = next
    try {
      current = build()
      logger('检测到配置变化，已按新配置重建主机清单')
    } catch (error) {
      // 重建失败不该让正在跑的会话失去目标机：保留旧 handlers，把原因挂出来
      current = { ...current, error: error instanceof Error ? error.message : String(error) }
      logger(`配置变化后重建失败：${current.error}`)
    }
  }

  function build() {
    const { hosts, source } = reloadHosts({ inline, file: hostsFile, source: hostsFile })
    const handlers = createHandlers({
      cfg: { ...cfg, resolvedHostsFile: hostsFile },
      hosts,
      source,
      exec,
      state,
      logger
    })
    return { hosts, source, handlers, loadedAt: now(), error: null }
  }

  /**
   * 装载期首次读取。
   *  - 清单**文件不存在**：从空清单起，把引导语记在 error 里。这是刻意的例外：
   *    设置界面就长在这个插件里，文件缺失如果直接炸掉，用户既没有工具也没有界面
   *    去创建它（先有鸡还是先有蛋）。
   *  - 文件存在但读不动 / 解析失败 / 权限过宽：照旧当场失败，那是真配置错误。
   */
  function install() {
    if (writable && !fileInfo(hostsFile).exists) {
      const guidance = `主机清单不存在：${hostsFile}\n`
        + '  在设置里「新增主机」会自动创建（0600）；'
        + `也可以手工写一份：cp <插件目录>/ssh-hosts.example.yaml ${hostsFile} && chmod 600 ${hostsFile}`
      logger(guidance.replace(/\n\s*/g, ' '))
      current = { ...buildFrom([], hostsFile), loadedAt: now(), error: guidance }
      return current
    }
    current = build()
    return current
  }

  /** 重新读盘；失败时保留旧清单并把原因记下（界面能看到，工具继续可用） */
  function reload() {
    try {
      const next = build()
      current = next
      logger(`已重载 ${next.hosts.length} 台主机（来源：${next.source}）`)
      return { ok: true, hosts: next.hosts.length, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (current !== null) current = { ...current, error: message }
      logger(`重载主机清单失败：${message}`)
      return { ok: false, hosts: current?.hosts.length ?? 0, error: message }
    }
  }

  function mustCurrent() {
    if (current === null) throw new UiFailure('not-loaded', '主机清单尚未装载')
    return current
  }

  function rawEditableEntries() {
    if (!writable) return []
    try {
      return parseForEdit(readText(hostsFile), { file: hostsFile }).hosts
    } catch (error) {
      // 文件被手工改坏时，界面要看到原因而不是一个 500
      throw new UiFailure('invalid-args', error instanceof Error ? error.message : String(error))
    }
  }

  function persist(rawEntries) {
    const previousText = readText(hostsFile)
    const text = serialize(rawEntries, { existingText: previousText })
    // 写之前先在内存里过一遍与装载期同一套校验：写坏文件比报错严重得多。
    // 校验错误来自 hosts.js 的纯 Error，这里翻成 UiFailure，界面才会拿到 400 + 原因。
    let normalized
    try {
      normalized = rawEntries.map((raw, index) =>
        normalizeHostEntry(raw, `界面第 ${index + 1} 台主机`, { home, checkIdentityFile: true }))
      finalizeHosts(normalized, { where: '界面提交的清单' })
    } catch (error) {
      throw new UiFailure('invalid-args', error instanceof Error ? error.message : String(error))
    }
    writeText(hostsFile, text)
    try {
      const { hosts, source } = reloadHosts({ inline: [], file: hostsFile, source: hostsFile })
      current = { ...buildFrom(hosts, source), loadedAt: now(), error: null }
      return { hosts, text }
    } catch (error) {
      // 回到写之前的字节，让「工具能用的清单」与「盘上文件」始终一致。
      try {
        writeText(hostsFile, previousText)
        if (previousText.trim().length > 0) reload()
      } catch {
        /* 回滚都失败时只能把错误抛出去，让界面显示出来 */
      }
      throw new UiFailure('reload-failed',
        `清单写入后校验失败，已回滚：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function buildFrom(hosts, source) {
    return {
      hosts,
      source,
      handlers: createHandlers({
        cfg: { ...cfg, resolvedHostsFile: hostsFile },
        hosts,
        source,
        exec,
        state,
        logger
      })
    }
  }

  function requireName(name, what) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new UiFailure('invalid-args', `${what}必须提供主机名`)
    }
    return name.trim()
  }

  /** 需要写密码时才要求凭据服务在；缺了就给出可照做的说明 */
  function requireCredentials() {
    const provider = credentials()
    if (provider === undefined) {
      throw new UiFailure('unsupported',
        '当前 profile 没有 credentials 服务，密码存不下来：请在桌面应用里设置密码（内置 0600 凭据库），或改用密钥 / ssh-agent 登录')
    }
    return provider
  }

  const service = {
    install,
    reload,
    /** 工具使用的稳定门面 */
    live: liveHandlers(() => mustCurrent().handlers, { before: syncConfig }),
    /** 当前状态快照，供 index.js 装载日志使用 */
    snapshot() {
      const s = mustCurrent()
      return { hosts: s.hosts, source: s.source, error: s.error }
    },
    /**
     * 界面读取：清单 + 可写性 + 文件信息 + 默认主机 + 每台主机的密码状态。
     * 异步是因为密码状态要向 credentials 服务问（只问「有没有、能不能写」，值永远不回界面）。
     */
    async list({ sessionId } = {}) {
      const s = mustCurrent()
      // 盘上文件坏了也要能打开界面：退回「当前生效的清单」，把解析错误挂在 error 上。
      let entries = inline
      let parseError = null
      if (writable) {
        try {
          entries = rawEditableEntries()
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error)
          entries = null
        }
      }
      const normalized = new Map(s.hosts.map(host => [host.name, host]))
      const rows = (entries ?? s.hosts).map((raw, index) => {
        const name = typeof raw?.name === 'string' ? raw.name : `#${index + 1}`
        const view = normalized.get(name)
        return {
          ...pickEditable(raw),
          via: view?.proxyJump,
          inUse: view !== undefined
        }
      })
      const provider = credentials()
      const hosts = await Promise.all(rows.map(async row => {
        const ref = typeof row.passwordRef === 'string' ? row.passwordRef : ''
        if (ref.length === 0) {
          return { ...row, passwordConfigured: false, passwordSource: '', passwordWritable: provider !== undefined }
        }
        if (provider === undefined) {
          return { ...row, passwordConfigured: false, passwordSource: '', passwordWritable: false, passwordError: '当前 profile 没有 credentials 服务' }
        }
        try {
          const info = await provider.describe(ref)
          return {
            ...row,
            passwordConfigured: info?.configured === true,
            passwordSource: typeof info?.source === 'string' ? info.source : '',
            passwordWritable: info?.writable === true
          }
        } catch (error) {
          // 凭据库读不动不该让整个设置页打不开：这一行标出原因，其它行照常显示。
          logger(`读取密码状态失败（${ref}）：${error instanceof Error ? error.message : String(error)}`)
          return { ...row, passwordConfigured: false, passwordSource: '', passwordWritable: false, passwordError: error instanceof Error ? error.message : String(error) }
        }
      }))
      // 会话默认主机（ssh_use / `/ssh` 命令设的）与全局默认（界面「设为默认」）分开报：
      // 会话窗口的选择器要标出「这台就是当前会话在用的」，而设置页关心的是全局默认。
      const scoped = typeof sessionId === 'string' && sessionId.length > 0 ? state.get(sessionId) : null
      const sessionDefaultHost = scoped !== null && hosts.some(host => host.name === scoped) ? scoped : ''
      return {
        file: hostsFile,
        writable,
        source: parseError === null ? s.source : `${s.source}（盘上文件当前无法解析）`,
        reason: writable ? '' : '主机来自插件 config 的 hosts: [...]，由部署方声明，界面只读。',
        defaultHost: state.getDefault() ?? '',
        sessionDefaultHost,
        configuredDefaultHost: typeof cfg.defaultHost === 'string' ? cfg.defaultHost : '',
        loadedAt: s.loadedAt,
        error: parseError ?? s.error,
        fileInfo: fileInfo(hostsFile),
        passwordSupported: provider !== undefined,
        hosts
      }
    },
    /**
     * 新增或修改一台主机；previousName 用于改名。
     * 密码不走清单：`password` 写进 DSH 凭据库（0600），清单里只留 passwordRef；
     * `clearPassword` 删掉凭据并摘掉 passwordRef；两个都不给 = 密码保持不变。
     */
    async upsert(rawEntry, { previousName, password, clearPassword } = {}) {
      if (!writable) throw new UiFailure('read-only', '主机清单来自插件 config，界面不可写')
      if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new UiFailure('invalid-args', '主机必须是对象')
      }
      const unknown = Object.keys(rawEntry).filter(key => !EDITABLE_FIELDS.includes(key))
      if (unknown.length > 0) throw new UiFailure('invalid-args', `未知字段：${unknown.join(', ')}`)
      const name = requireName(rawEntry.name, '新增/修改')
      const entries = rawEditableEntries()
      const target = typeof previousName === 'string' && previousName.length > 0 ? previousName : name
      const index = entries.findIndex(entry => entry?.name === target)
      const clean = pickEditable(rawEntry)
      if (clean.readOnly !== undefined && typeof clean.readOnly !== 'boolean') {
        throw new UiFailure('invalid-args', 'readOnly 必须是布尔值')
      }
      const given = typeof password === 'string' ? password : ''
      // 凭据名以「文件里现有的」为准，不依赖界面把它回传：否则界面只发
      // clearPassword 时会把凭据库里的值留成孤儿。
      const existing = index >= 0 ? entries[index] : undefined
      const existingRef = typeof existing?.passwordRef === 'string' ? existing.passwordRef.trim() : ''
      const clientRef = typeof clean.passwordRef === 'string' ? clean.passwordRef.trim() : ''
      let passwordAction = 'unchanged'
      let passwordRef = clientRef.length > 0 ? clientRef : existingRef
      if (given.length > 0) {
        const provider = requireCredentials()
        passwordRef = clientRef.length > 0 ? clientRef : (existingRef.length > 0 ? existingRef : passwordRefFor(name))
        // 先存凭据再改清单：反过来会出现「清单说用密码，凭据库却没有」的空窗。
        await provider.set(passwordRef, given)
        clean.passwordRef = passwordRef
        passwordAction = existingRef.length > 0 || clientRef.length > 0 ? 'replaced' : 'set'
      } else if (clearPassword === true || (clientRef.length === 0 && existingRef.length > 0)) {
        // 两种情形都算清除：界面明说不要了，或这次提交的条目不再引用它。
        const ref = clientRef.length > 0 ? clientRef : existingRef
        if (ref.length > 0) {
          const provider = credentials()
          if (provider !== undefined) {
            try {
              await provider.unset(ref)
            } catch (error) {
              logger(`清除密码失败（${ref}）：${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        delete clean.passwordRef
        passwordRef = ''
        passwordAction = existingRef.length > 0 ? 'cleared' : 'unchanged'
      }
      const next = index >= 0
        ? entries.map((entry, i) => (i === index ? clean : entry))
        : [...entries, clean]
      const { hosts } = persist(next)
      return { action: index >= 0 ? 'updated' : 'added', name, total: hosts.length, password: passwordAction, passwordRef }
    },
    /** 删除一台主机；顺手清掉指向它的全局默认，以及它自己的密码凭据 */
    async remove(name) {
      if (!writable) throw new UiFailure('read-only', '主机清单来自插件 config，界面不可写')
      const target = requireName(name, '删除')
      const entries = rawEditableEntries()
      const found = entries.find(entry => entry?.name === target)
      if (found === undefined) {
        throw new UiFailure('unknown-host', `清单里没有主机 "${target}"`)
      }
      const orphanRef = typeof found.passwordRef === 'string' ? found.passwordRef : ''
      const { hosts } = persist(entries.filter(entry => entry?.name !== target))
      const clearedDefault = state.getDefault() === target
      if (clearedDefault) state.setDefault('')
      let clearedPassword = false
      if (orphanRef.length > 0) {
        const provider = credentials()
        if (provider !== undefined) {
          try {
            await provider.unset(orphanRef)
            clearedPassword = true
          } catch (error) {
            // 删主机不该因为凭据库删不掉而失败：把残留记下来即可。
            logger(`删除主机 ${target} 后清理凭据 ${orphanRef} 失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return { action: 'removed', name: target, total: hosts.length, clearedDefault, clearedPassword }
    },
    /** 设为默认主机；传空清除 */
    setDefault(name) {
      const target = typeof name === 'string' ? name.trim() : ''
      if (target.length === 0) {
        state.setDefault('')
        return { defaultHost: '' }
      }
      if (!mustCurrent().hosts.some(host => host.name === target)) {
        throw new UiFailure('unknown-host', `清单里没有主机 "${target}"`)
      }
      state.setDefault(target)
      return { defaultHost: target }
    },
    /** 连通性测试：界面的「测试连接」按钮 */
    async test(name) {
      const target = requireName(name, '测试连接')
      const host = mustCurrent().hosts.find(entry => entry.name === target)
      if (host === undefined) throw new UiFailure('unknown-host', `清单里没有主机 "${target}"`)
      const started = Date.now()
      try {
        const result = await exec.run(host, {
          command: 'printf %s "$(uname -srm)"; echo; id -un; pwd',
          timeoutMs: 20000
        })
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim()
        }
      } catch (error) {
        throw new UiFailure(error?.kind ?? 'ssh', error instanceof Error ? error.message : String(error))
      }
    }
  }
  return service
}
