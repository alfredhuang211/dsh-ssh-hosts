/** 同源 HTTP 路由：信任栅栏、状态码映射、请求体上限。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { registerRoutes, ROUTE_PREFIX } from '../lib/api.js'

/** 浏览器请求的是带前缀的路径，测试也跟着带 */
const PREFIX = ROUTE_PREFIX
import { UiFailure } from '../lib/service.js'

/** 假 webServer：记下注册的路由并给出一个可调用的 handler */
function fakeServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => { route.disposed = true }
    }
  }
}

/** 假 req：Readable 提供 body，headers 用于信任栅栏 */
function fakeRequest({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = PREFIX + url
  stream.headers = headers
  return stream
}

function fakeResponse() {
  const state = { status: 0, headers: null, text: '' }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers ?? null },
    end(text) { state.text = text ?? '' },
    get json() { return state.text.length === 0 ? null : JSON.parse(state.text) }
  }
}

async function call(route, options) {
  const res = fakeResponse()
  await route.handler(fakeRequest(options), res)
  return { status: res.state.status, json: res.json, headers: res.state.headers }
}

/** 记录被调用动作的 handler 替身 */
function handlers(overrides = {}) {
  const calls = []
  const base = {
    list: () => { calls.push(['list']); return { file: '/tmp/hosts.yaml', hosts: [] } },
    upsert: (entry, options) => {
      // 与真实 service 一样做参数检查，好让「空 body」走到 400 而不是 500
      if (entry === null || typeof entry !== 'object') throw new UiFailure('invalid-args', '主机必须是对象')
      calls.push(['upsert', entry, options])
      return { action: 'added', name: entry.name, total: 1 }
    },
    remove: name => { calls.push(['remove', name]); return { action: 'removed', name, total: 0 } },
    setDefault: name => { calls.push(['setDefault', name]); return { defaultHost: name ?? '' } },
    reload: () => { calls.push(['reload']); return { ok: true, hosts: 1, error: null } },
    test: async name => { calls.push(['test', name]); return { ok: true, stdout: 'Linux' } }
  }
  return { calls, handlers: { ...base, ...overrides } }
}

test('注册的是 prefix 路由，路径是插件自己的前缀', () => {
  const server = fakeServer()
  const dispose = registerRoutes(server, undefined, handlers().handlers)
  assert.equal(server.routes.length, 1)
  assert.deepEqual({ kind: server.routes[0].kind, path: server.routes[0].path },
    { kind: 'prefix', path: ROUTE_PREFIX })
  assert.equal(typeof dispose, 'function')
})

test('GET /hosts 返回清单', async () => {
  const server = fakeServer()
  const h = handlers()
  registerRoutes(server, undefined, h.handlers)
  const result = await call(server.routes[0], { method: 'GET', url: '/hosts' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.value.file, '/tmp/hosts.yaml')
  assert.deepEqual(h.calls, [['list']])
})

test('POST /hosts 新增、/hosts/delete 删除、/default 设默认、/reload 重读', async () => {
  const server = fakeServer()
  const h = handlers()
  registerRoutes(server, undefined, h.handlers)

  const added = await call(server.routes[0], {
    method: 'POST', url: '/hosts', body: { host: { name: 'web-01', host: '10.0.0.11' }, previousName: 'web-00' }
  })
  assert.equal(added.status, 200)
  assert.deepEqual(h.calls.at(-1), ['upsert', { name: 'web-01', host: '10.0.0.11' }, { previousName: 'web-00' }])

  const removed = await call(server.routes[0], { method: 'POST', url: '/hosts/delete', body: { name: 'web-01' } })
  assert.equal(removed.status, 200)
  assert.deepEqual(h.calls.at(-1), ['remove', 'web-01'])

  const def = await call(server.routes[0], { method: 'POST', url: '/default', body: { name: 'web-01' } })
  assert.equal(def.json.value.defaultHost, 'web-01')

  const reloaded = await call(server.routes[0], { method: 'POST', url: '/reload' })
  assert.equal(reloaded.json.value.ok, true)
  assert.deepEqual(h.calls.at(-1), ['reload'])
})

test('POST /test 走连通性测试', async () => {
  const server = fakeServer()
  const h = handlers()
  registerRoutes(server, undefined, h.handlers)
  const result = await call(server.routes[0], { method: 'POST', url: '/test', body: { name: 'web-01' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.value.stdout, 'Linux')
  assert.deepEqual(h.calls.at(-1), ['test', 'web-01'])
})

test('信任栅栏：connection 拒绝时直接返回状态码，不碰 handler', async () => {
  const server = fakeServer()
  const h = handlers()
  registerRoutes(server, { requestRejection: () => 403 }, h.handlers)
  const result = await call(server.routes[0], { method: 'GET', url: '/hosts', headers: { origin: 'https://evil.example' } })
  assert.equal(result.status, 403)
  assert.equal(result.json, null)
  assert.deepEqual(h.calls, [])
})

test('query string 不影响路由匹配', async () => {
  const server = fakeServer()
  const h = handlers()
  registerRoutes(server, undefined, h.handlers)
  const result = await call(server.routes[0], { method: 'GET', url: '/hosts?x=1' })
  assert.equal(result.status, 200)
})

test('错误映射：UiFailure 的 kind 决定状态码', async () => {
  const cases = [
    ['invalid-args', 400],
    ['bad-json', 400],
    ['too-large', 400],
    ['read-only', 409],
    ['unknown-host', 404],
    ['reload-failed', 500],
    ['internal', 500]
  ]
  for (const [kind, status] of cases) {
    const server = fakeServer()
    registerRoutes(server, undefined, handlers({ list: () => { throw new UiFailure(kind, `${kind} 消息`) } }).handlers)
    const result = await call(server.routes[0], { method: 'GET', url: '/hosts' })
    assert.equal(result.status, status, kind)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, kind)
    assert.match(result.json.error.message, new RegExp(kind))
  }
})

test('未知方法与未知路径都是 404', async () => {
  const server = fakeServer()
  registerRoutes(server, undefined, handlers().handlers)
  assert.equal((await call(server.routes[0], { method: 'DELETE', url: '/hosts' })).status, 404)
  assert.equal((await call(server.routes[0], { method: 'GET', url: '/nope' })).status, 404)
})

test('坏 JSON 报 400；请求体超限报 400', async () => {
  const server = fakeServer()
  registerRoutes(server, undefined, handlers().handlers)

  const bad = await call(server.routes[0], { method: 'POST', url: '/hosts' })
  // 空 body 当成 {} → upsert 收到 undefined，参数检查给出 400
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid-args')

  const badJson = await callRaw(server.routes[0], 'POST', '/hosts', '{not json')
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error.code, 'bad-json')

  const tooLarge = await callRaw(server.routes[0], 'POST', '/hosts', JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))
  assert.equal(tooLarge.status, 400)
  assert.equal(tooLarge.json.error.code, 'too-large')
})

/** 直接给一段原始文本当请求体，用于测坏 JSON 与超限 */
async function callRaw(route, method, url, text) {
  const stream = Readable.from([Buffer.from(text)])
  stream.method = method
  stream.url = PREFIX + url
  stream.headers = {}
  const res = fakeResponse()
  await route.handler(stream, res)
  return { status: res.state.status, json: res.json }
}

test('响应带 no-store 与长度头', async () => {
  const server = fakeServer()
  registerRoutes(server, undefined, handlers().handlers)
  const result = await call(server.routes[0], { method: 'GET', url: '/hosts' })
  assert.match(result.headers['content-type'], /application\/json/)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(Number(result.headers['content-length']), Buffer.byteLength(JSON.stringify(result.json)))
})

test('密码只进不出：响应体里只有凭据名，绝无密码值', async () => {
  const server = fakeServer()
  registerRoutes(server, undefined, {
    ...handlers().handlers,
    upsert: () => ({
      action: 'added', name: 'pw-01', total: 1,
      password: 'set', passwordRef: 'DSH_SSH_HOSTS_PASSWORD_PW_01'
    })
  })
  const result = await call(server.routes[0], {
    method: 'POST', url: '/hosts',
    body: { host: { name: 'pw-01', host: '10.0.0.21' }, password: 'hunter2' }
  })
  assert.equal(result.status, 200)
  assert.equal(JSON.stringify(result.json).includes('hunter2'), false)
  assert.equal(result.json.value.passwordRef, 'DSH_SSH_HOSTS_PASSWORD_PW_01')
})

test('POST /hosts：password / clearPassword 原样传给 service', async () => {
  const seen = []
  const server = fakeServer()
  const stub = handlers()
  registerRoutes(server, undefined, {
    ...stub.handlers,
    upsert: (entry, options) => {
      seen.push([entry, options])
      return { action: 'added', name: entry.name, total: 1 }
    }
  })
  await call(server.routes[0], {
    method: 'POST', url: '/hosts',
    body: { host: { name: 'pw-01', host: '10.0.0.21' }, previousName: 'pw-00', password: 'hunter2', clearPassword: false }
  })
  await call(server.routes[0], {
    method: 'POST', url: '/hosts',
    body: { host: { name: 'pw-01', host: '10.0.0.21' }, clearPassword: true }
  })
  await call(server.routes[0], {
    method: 'POST', url: '/hosts',
    body: { host: { name: 'pw-01', host: '10.0.0.21' }, password: '' }
  })
  assert.deepEqual(seen[0][1], { previousName: 'pw-00', password: 'hunter2' })
  assert.deepEqual(seen[1][1], { clearPassword: true })
  // 空密码不是「设置密码」：既不发 password 也不发 clearPassword
  assert.deepEqual(seen[2][1], {})
})

test('没有凭据服务：存密码 → 501，消息可照做', async () => {
  const server = fakeServer()
  registerRoutes(server, undefined, {
    ...handlers().handlers,
    upsert: () => { throw new UiFailure('unsupported', '当前 profile 没有 credentials 服务，密码存不下来') }
  })
  const result = await call(server.routes[0], {
    method: 'POST', url: '/hosts',
    body: { host: { name: 'pw-01', host: '10.0.0.21' }, password: 'hunter2' }
  })
  assert.equal(result.status, 501)
  assert.equal(result.json.error.code, 'unsupported')
  assert.match(result.json.error.message, /credentials/)
})

test('GET /hosts：?sessionId= 透传给 list，没有 query 时传 undefined', async () => {
  const seen = []
  const server = fakeServer()
  registerRoutes(server, undefined, {
    ...handlers().handlers,
    list: options => { seen.push(options); return { file: '/tmp/hosts.yaml', hosts: [] } }
  })
  const route = server.routes[0]
  await call(route, { method: 'GET', url: '/hosts' })
  await call(route, { method: 'GET', url: '/hosts?sessionId=s-42' })
  await call(route, { method: 'GET', url: '/hosts?sessionId=' })
  assert.deepEqual(seen, [undefined, { sessionId: 's-42' }, undefined])
})
