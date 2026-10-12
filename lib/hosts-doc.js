/**
 * 主机清单文件的读写（界面用）。
 *
 * 分工：hosts.js 负责**读懂**清单（含校验），这里负责**写回**清单。
 * 写回刻意不动文件里的其他内容：用 parseDocument 保留注释与未知键，
 * 只替换 `hosts` 节点，所以「手改 YAML」与「界面改」不会互相覆盖对方的注释。
 *
 * 权限：写入是「临时文件 + rename」的原子替换，0600；rename 会继承旧位，
 * 因此写入后再核一次 mode 并显式收紧。清单里有 identityFile 路径，
 * 权限放宽等于把「用哪把钥匙」暴露给同机其他用户。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, parseDocument, stringify } from 'yaml'

export const DOC_VERSION = 1

const HEADER = `# dsh-ssh-hosts 主机清单。
# 这个文件由插件的设置界面读写，也可以手工编辑（改完在界面点「重新读取」）。
# 权限必须是 0600，否则插件拒绝加载：chmod 600 这个文件。
# 只存「怎么连」：host / user / port / identityFile / proxyJump / tags，
# 不存任何密码或私钥内容。
`

/** 读清单原文；不存在返回空串（界面允许从零创建） */
export function readHostsText(file, { readFile = readFileSync } = {}) {
  try {
    return readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * 解析一份清单原文，返回可编辑的原始条目数组。
 * 结构与 hosts.js 的 parseHostsDocument 保持一致（同样的接受范围、同样的报错措辞），
 * 但这里给的是**未归一化的原始条目** —— 界面要原样编辑用户写下的字段。
 * 字段级校验仍然只有 normalizeHostEntry 一处。
 */
export function parseHostsForEdit(text, { file = '<hosts>' } = {}) {
  if (text.trim().length === 0) return { version: DOC_VERSION, hosts: [] }
  let doc
  try {
    doc = parse(text)
  } catch (error) {
    throw new Error(`${file}: YAML 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (doc === null || doc === undefined) return { version: DOC_VERSION, hosts: [] }
  const hosts = Array.isArray(doc)
    ? doc
    : (typeof doc === 'object' && Array.isArray(doc.hosts) ? doc.hosts : undefined)
  if (hosts === undefined) throw new Error(`${file}: 需要 { version: 1, hosts: [...] } 或顶层数组`)
  if (!Array.isArray(doc) && doc.version !== undefined && doc.version !== DOC_VERSION) {
    throw new Error(`${file}: 不支持的 version ${JSON.stringify(doc.version)}（当前只认 ${DOC_VERSION}）`)
  }
  return { version: DOC_VERSION, hosts }
}

/**
 * 生成写回后的文件内容。
 * @param {object[]} hosts - 已经过校验的原始条目（保持用户输入顺序）
 * @param {{existingText?: string}} options - 现有文件内容，用于保留注释与其他键
 * @returns {string} 完整文件内容
 */
export function serializeHosts(hosts, { existingText = '' } = {}) {
  if (existingText.trim().length === 0) {
    return `${HEADER}${stringify({ version: DOC_VERSION, hosts }, { lineWidth: 0 })}`
  }
  const doc = parseDocument(existingText)
  if (doc.errors.length > 0) {
    throw new Error(`现有清单不是合法 YAML：${doc.errors[0].message}`)
  }
  doc.set('hosts', hosts)
  if (!doc.has('version')) doc.set('version', DOC_VERSION)
  const header = existingText.startsWith('#') ? '' : HEADER
  return `${header}${doc.toString({ lineWidth: 0 })}`
}

/**
 * 原子写入清单：临时文件 + rename，权限 0600。
 * @returns {{file: string, bytes: number}}
 */
export function writeHostsText(file, text, {
  writeFile = writeFileSync,
  renameFile = renameSync,
  chmodFile = chmodSync,
  mkdir = mkdirSync,
  stat = statSync,
  pid = process.pid
} = {}) {
  mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${pid}.tmp`
  writeFile(tmp, text, { mode: 0o600 })
  renameFile(tmp, file)
  if ((stat(file).mode & 0o077) !== 0) chmodFile(file, 0o600)
  return { file, bytes: Buffer.byteLength(text) }
}

/** 供界面显示：当前文件的权限位（八进制字符串）与是否存在 */
export function hostsFileInfo(file, { stat = statSync } = {}) {
  try {
    const info = stat(file)
    return { exists: true, mode: `0${(info.mode & 0o777).toString(8)}`, bytes: info.size, mtime: info.mtime.toISOString() }
  } catch {
    return { exists: false, mode: '', bytes: 0, mtime: '' }
  }
}
