/**
 * 同源 HTTP 路由：浏览器半边（client/bundle.js）就是靠这些接口增删改主机的。
 *
 * 为什么走 HTTP 而不是往 harness 的 RPC 表里加方法：第三方插件加不了 RPC 方法，
 * 但 webServer seam 是公开的，注册自己的前缀、浏览器端用普通 fetch 调即可。
 *
 * 安全：插件自注册的路由**不吃** /api 那套 Host/Origin 栅栏，必须自己过
 * `connection.requestRejection(req)`，否则任意网页都能借用户浏览器写本机清单
 * （加一台主机 = 让 agent 把命令发到攻击者的机器上）。
 * 另外这里只写「主机清单」——它是本地配置，不含凭据内容；私钥仍然只在文件系统里，
 * 接口既不接收也不返回密钥材料。密码是**只进不出**的例外：界面可以 POST 一个密码，
 * 插件把它交给 credentials 服务存起来（清单里只留 passwordRef），此后接口只回报
 * 「有没有、来自哪一层、能不能改」，值永远不回浏览器。
 */
import { UiFailure } from './service.js'

export const ROUTE_PREFIX = '/ssh-hosts'

/** 请求体上限：一份主机清单很小，64KB 足够且能挡住内存攻击 */
const MAX_BODY_BYTES = 64 * 1024

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

function ok(res, value) {
  send(res, 200, { ok: true, value })
}

function fail(res, status, code, message) {
  send(res, status, { ok: false, error: { code, message } })
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new UiFailure('too-large', `请求体超过 ${limit} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed === null || typeof parsed !== 'object' ? {} : parsed
  } catch {
    throw new UiFailure('bad-json', '请求体不是合法 JSON')
  }
}

/** UiFailure 的 kind 到 HTTP 状态：参数问题 400，只读 409，找不到 404，能力缺失 501，其余 500 */
function statusFor(kind) {
  if (kind === 'invalid-args' || kind === 'bad-json' || kind === 'too-large') return 400
  if (kind === 'read-only') return 409
  if (kind === 'unknown-host') return 404
  if (kind === 'unsupported') return 501
  if (kind === 'reload-failed') return 500
  return 500
}

/**
 * 注册本插件的全部路由。
 * @param {object} webServer - webServer 服务（webServer.register）
 * @param {object|undefined} connection - connection 服务（requestRejection 信任栅栏）
 * @param {object} handlers - 路由背后的动作，便于测试注入
 * @returns {Function} 释放函数
 */
export function registerRoutes(webServer, connection, handlers) {
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      // 栅栏：非本应用来源的请求一律拒绝（返回的是要写的状态码）
      const rejection = connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()
      try {
        // ?sessionId= 可选：带上它时多回报 sessionDefaultHost（会话窗口的主机选择器用）
        if (method === 'GET' && route === '/hosts') {
          const sessionId = url.searchParams.get('sessionId')
          return ok(res, await handlers.list(sessionId === null || sessionId.length === 0 ? undefined : { sessionId }))
        }
        if (method === 'POST' && route === '/hosts') {
          const body = await readBody(req)
          const options = {}
          if (body.previousName !== undefined) options.previousName = body.previousName
          if (typeof body.password === 'string' && body.password.length > 0) options.password = body.password
          if (body.clearPassword === true) options.clearPassword = true
          return ok(res, await handlers.upsert(body.host, options))
        }
        if (method === 'POST' && route === '/hosts/delete') {
          const body = await readBody(req)
          return ok(res, await handlers.remove(body.name))
        }
        if (method === 'POST' && route === '/default') {
          const body = await readBody(req)
          return ok(res, handlers.setDefault(body.name))
        }
        if (method === 'POST' && route === '/reload') return ok(res, handlers.reload())
        if (method === 'POST' && route === '/test') {
          const body = await readBody(req)
          return ok(res, await handlers.test(body.name))
        }
        return fail(res, 404, 'not-found', `${method} ${route}`)
      } catch (error) {
        if (error instanceof UiFailure) return fail(res, statusFor(error.kind), error.kind, error.message)
        return fail(res, 500, 'internal', error instanceof Error ? error.message : String(error))
      }
    }
  })
}
