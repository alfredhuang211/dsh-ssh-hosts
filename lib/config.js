/**
 * 插件配置 schema。
 *
 * dsh 0.2.x 的形态约束：
 *  - 模块顶层导出 `Config`，宿主据此校验 cordis.patch.yml 里的 config 并填默认值；
 *  - `.volatile()` 子树是设置页可写部分；一个 volatile 字段都没有时，
 *    用户一保存就报 "Plugin entry ... has no volatile fields"；
 *  - schemastery 不会在 `Config({})` 这一步填默认值，所以默认值只能从
 *    schema 的 meta 里取（见 defaults()）。
 *
 * 主机清单本身**不放在这里**：它是一份 0600 的独立 YAML（ssh-hosts.yaml），
 * 便于手工编辑、复用与权限收紧。config 里只留一个路径开关。
 */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** patch 行 id，同时也是设置命名空间 */
export const NS = 'ssh-hosts'
/** 主机指纹策略取值 */
export const STRICT_HOST_KEY = ['accept-new', 'yes', 'no']
/** $DSH_HOME 下的默认清单文件名 */
export const HOSTS_FILENAME = 'ssh-hosts.yaml'
/** $DSH_HOME 下的会话状态文件名 */
export const STATE_FILENAME = 'ssh-hosts.state.json'

/** 就地声明一台主机（非空时优先于 hostsFile） */
const INLINE_HOST = Schema.object({
  name: Schema.string().required().description('主机名（会话里引用的键）'),
  host: Schema.string().required().description('域名或 IP'),
  port: Schema.number().default(22).description('SSH 端口'),
  user: Schema.string().default('').description('登录用户；留空用 OpenSSH 默认'),
  identityFile: Schema.string().default('').description('私钥路径（~ 可展开）；必须 0600'),
  passwordRef: Schema.string().default('').description('密码凭据名（值存在 DSH 凭据库）：单独给出 = 只用密码，与 identityFile 同时给出 = 先密钥后密码'),
  proxyJump: Schema.string().default('').description('跳板：本清单里的主机名，或 user@host[:port]'),
  defaultWorkdir: Schema.string().default('').description('默认远端工作目录（绝对路径）'),
  description: Schema.string().default('').description('给模型看的一行说明'),
  tags: Schema.array(Schema.string()).default([]).description('标签，便于按用途筛选'),
  connectTimeoutSec: Schema.number().default(0).description('覆盖全局建连超时；0 = 用全局'),
  keepAliveSec: Schema.number().default(0).description('ServerAliveInterval；0 = 不发送'),
  readOnly: Schema.boolean().default(false).description('只读主机：拒绝远端写入与编辑')
})

/**
 * 全部可配置字段。
 *
 * 标量字段在 Config 里被标记为 volatile（设置页可写），`hosts` 不标记：
 * 主机清单以 YAML 为唯一权威，避免「设置页改一半、YAML 改一半」。
 */
export const SHAPE = {
  hostsFile: Schema.string().default('').description(`主机清单 YAML；留空 = $DSH_HOME/${HOSTS_FILENAME}`),
  defaultHost: Schema.string().default('').description('未指定 host 且本会话没设过时的默认主机名；留空则要求显式指定'),
  knownHostsFile: Schema.string().default('').description('known_hosts 路径；留空交给 OpenSSH 默认（~/.ssh/known_hosts）'),
  strictHostKeyChecking: Schema.union(STRICT_HOST_KEY)
    .default('accept-new')
    .description('主机指纹策略：accept-new 首次自动记录、指纹变更即拒绝；yes 只接受已知主机；no 不校验（不推荐）'),
  connectTimeoutSec: Schema.number().min(1).default(10).description('SSH 建连超时（秒）'),
  timeoutMs: Schema.number().min(1000).default(60000).description('单条命令默认超时（毫秒）'),
  maxOutputBytes: Schema.number().min(1024).default(262144).description('ssh_run 的 stdout/stderr 各自保留上限（超出保尾并标记截断）'),
  maxReadBytes: Schema.number().min(1024).default(8388608).description('ssh_read / ssh_edit 读取单个文件的上限（字节）'),
  controlPersistSec: Schema.number().min(0).default(300).description('OpenSSH 连接复用保持时长（秒）；0 = 每次调用重新建连'),
  allow: Schema.array(Schema.string()).default([]).description('ssh_run 命令白名单正则；非空时只放行匹配项'),
  deny: Schema.array(Schema.string()).default([]).description('ssh_run 命令黑名单正则；优先于 allow'),
  hosts: Schema.array(INLINE_HOST).default([]).description('就地声明主机（非空时忽略 hostsFile）')
}

const VOLATILE_KEYS = new Set(Object.keys(SHAPE).filter(key => key !== 'hosts'))

/** 宿主用来校验并填默认值的 schema */
export const Config = Schema.object(Object.fromEntries(
  Object.entries(SHAPE).map(([key, schema]) => [key, VOLATILE_KEYS.has(key) ? schema.volatile() : schema])
))

/**
 * volatile 引用的跨副本识别标记（@deepseek-ai/cosmokit 的 Volatile 协议）。
 * 这里按协议符号判断，不 import cosmokit：本插件对宿主的依赖面只保留 cordis + dsh-tools。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** @returns 是否为 schemastery `.volatile()` 产生的配置引用（值要用 `.get()` 取） */
export function isVolatileConfig(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * 递归解包 volatile 引用。
 * 宿主经过 `Config` 校验后的 config，每个 volatile 字段都是一个引用对象；
 * 直接读字段会拿到引用本身（不是值），所以进插件前必须解包。
 */
export function unwrapConfig(value) {
  if (isVolatileConfig(value)) return unwrapConfig(value.get())
  if (Array.isArray(value)) return value.map(unwrapConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapConfig(child)]))
  }
  return value
}

/**
 * 每次读字段都重新解包一次的配置视图。
 *
 * 设置页改一个 volatile 字段时，宿主只更新引用里的值，**不会**重启插件
 * （这正是 volatile 的含义）。所以插件不能只在 apply 时快照一次配置，
 * 否则设置页改了不生效。工具每次读到的是当下值。
 */
export function liveConfig(source) {
  const read = () => normalizeConfig(source)
  return new Proxy({}, {
    get: (_target, key) => read()[key],
    has: (_target, key) => key in read(),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
  })
}

function cloneDefault(value) {
  if (Array.isArray(value)) return value.map(item => (item !== null && typeof item === 'object' ? { ...item } : item))
  if (value !== null && typeof value === 'object') return { ...value }
  return value
}

/** schema 里声明的默认值（schemastery 的 Config({}) 不填默认值，所以直接读 meta） */
export function defaults() {
  const out = {}
  for (const [key, schema] of Object.entries(SHAPE)) out[key] = cloneDefault(schema.meta?.default)
  return out
}

/**
 * 装载时传入的 config → 带默认值的纯 JS 配置。
 * @param raw 宿主给的 config：可能是纯对象（测试/CLI dump），也可能含 volatile 引用
 * @returns 解包并补默认值后的配置
 */
export function normalizeConfig(raw = {}) {
  const plain = unwrapConfig(raw ?? {})
  return { ...defaults(), ...(plain && typeof plain === 'object' ? plain : {}) }
}

/** $DSH_HOME：显式 DSH_HOME > ~/.dsh */
export function resolveDshHome(env = process.env, home = homedir()) {
  const explicit = env?.DSH_HOME
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return join(home, '.dsh')
}

/** 主机清单路径：config.hostsFile（相对路径按 $DSH_HOME 解析）> $DSH_HOME/ssh-hosts.yaml */
export function resolveHostsFile(cfg, { env, home } = {}) {
  const configured = typeof cfg?.hostsFile === 'string' ? cfg.hostsFile.trim() : ''
  if (configured.length === 0) return join(resolveDshHome(env, home), HOSTS_FILENAME)
  if (configured.startsWith('~/')) return join(home ?? homedir(), configured.slice(2))
  return isAbsolute(configured) ? configured : join(resolveDshHome(env, home), configured)
}

/** 会话状态路径：始终在 $DSH_HOME 下（它属于本机状态，不属于主机清单） */
export function resolveStateFile(cfg, { env, home } = {}) {
  return join(resolveDshHome(env, home), STATE_FILENAME)
}
