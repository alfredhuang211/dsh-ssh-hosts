/**
 * 会话级默认主机。
 *
 * 为什么不放内存：会话可以跨进程恢复，默认主机是「用户对这个会话的意图」，
 * 丢了就得重新交代一遍。所以落一个 0600 的小 JSON，按 session id 索引。
 *
 * 只存主机名，不存任何凭据；文件损坏时按空状态处理（不阻断启动）。
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STATE_VERSION = 1
const DEFAULT_MAX_SESSIONS = 200

/** 空状态：读不到/损坏时的统一形状 */
function emptyState() {
  return { version: STATE_VERSION, sessions: {}, defaultHost: '' }
}

/** 读一份状态文件；损坏/未知版本一律当空 */
export function readState(file, { readFile = readFileSync } = {}) {
  let text
  try {
    text = readFile(file, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const doc = JSON.parse(text)
    if (doc === null || typeof doc !== 'object' || doc.version !== STATE_VERSION) {
      return emptyState()
    }
    const sessions = doc.sessions !== null && typeof doc.sessions === 'object' && !Array.isArray(doc.sessions)
      ? doc.sessions
      : {}
    const clean = {}
    for (const [id, value] of Object.entries(sessions)) {
      if (id.length === 0) continue
      const host = value !== null && typeof value === 'object' ? value.host : undefined
      if (typeof host !== 'string' || host.length === 0) continue
      clean[id] = { host, at: typeof value.at === 'string' ? value.at : '' }
    }
    // defaultHost 由界面写入（「设为默认」），与 config.defaultHost 是两层：
    // 这一层属于用户在本机上的选择，改它不需要动 cordis.yml。
    const defaultHost = typeof doc.defaultHost === 'string' && NAME_SAFE.test(doc.defaultHost) ? doc.defaultHost : ''
    return { version: STATE_VERSION, sessions: clean, defaultHost }
  } catch {
    return emptyState()
  }
}

/** defaultHost 只接受主机名允许的字符，避免把任意字符串写回状态文件 */
const NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 创建会话状态读写器。
 * 写入是「临时文件 + rename」的原子替换，权限 0600；目录不存在时创建。
 */
export function createSessionState({
  file,
  maxSessions = DEFAULT_MAX_SESSIONS,
  now = () => new Date().toISOString(),
  readFile = readFileSync,
  writeFile = writeFileSync,
  renameFile = renameSync,
  mkdir = mkdirSync,
  stat = statSync,
  unlink = unlinkSync
} = {}) {
  let state = readState(file, { readFile })

  const persist = () => {
    const sessions = state.sessions
    const ids = Object.keys(sessions)
    if (ids.length > maxSessions) {
      ids.sort((a, b) => String(sessions[a].at).localeCompare(String(sessions[b].at)))
      for (const id of ids.slice(0, ids.length - maxSessions)) delete sessions[id]
    }
    mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const doc = state.defaultHost.length > 0
      ? { version: STATE_VERSION, defaultHost: state.defaultHost, sessions }
      : { version: STATE_VERSION, sessions }
    const tmp = `${file}.${process.pid}.tmp`
    writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
    renameFile(tmp, file)
    try {
      if ((stat(file).mode & 0o077) !== 0) {
        // 目录权限异常时 rename 会继承旧位；这里显式收紧一次。
        writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
      }
    } catch {
      /* 收紧失败不影响功能，下次写入再试 */
    }
  }

  return {
    /** 会话默认主机名，没设过返回 null */
    get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      return state.sessions[sessionId]?.host ?? null
    },
    /** 设置会话默认主机；传空字符串表示清除 */
    set(sessionId, host) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (typeof host !== 'string' || host.length === 0) delete state.sessions[sessionId]
      else state.sessions[sessionId] = { host, at: now() }
      persist()
    },
    /** 全局默认主机（界面「设为默认」）；没设过返回 null */
    getDefault() {
      return state.defaultHost.length > 0 ? state.defaultHost : null
    },
    /** 设置全局默认主机；传空/非法值表示清除 */
    setDefault(host) {
      state.defaultHost = typeof host === 'string' && NAME_SAFE.test(host) ? host : ''
      persist()
    },
    /** 当前所有会话记录（调试用） */
    snapshot() {
      return JSON.parse(JSON.stringify(state))
    },
    removeStaleTemps() {
      try {
        unlink(`${file}.${process.pid}.tmp`)
      } catch {
        /* 没有就没得删 */
      }
    },
    file,
    /** 供测试断言：文件是否存在 */
    exists() {
      try {
        stat(file)
        return true
      } catch {
        return false
      }
    },
    directory: dirname(join(file))
  }
}
