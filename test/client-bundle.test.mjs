/**
 * 浏览器半边：产物形态与槽注册。
 *
 * 这里不启动浏览器，而是按宿主加载器的真实契约跑一遍：
 * 1. 产物必须是「自注册 classic script」——调用 window.__ModuleLoader__.load；
 * 2. factory(require) 返回 { inject, apply }，React 走 require 而不是打包进来；
 * 3. apply 必须往 plugins.bundle.config 与 settings.section 各注册一张卡片；
 * 4. 卡片本身能渲染（用最小 React 替身跑一次函数组件，不真的挂载 DOM）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client', 'bundle.js')
const source = readFileSync(bundlePath, 'utf8')

/** 最小 React 替身：足够让 h(...) 建树、useState 给出初值。
 *  freezeStyles 复刻 react-dom dev 构建的行为：它会把收到的每个 style 对象冻结
 *  （见 setInitialDOMProperties），所以共享样式常量一旦被原地修改，第二次渲染就会抛错。 */
function fakeReact({ freezeStyles = false } = {}) {
  return {
    createElement(type, props, ...children) {
      if (freezeStyles && props && props.style) Object.freeze(props.style)
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() { /* 不执行副作用：用例不该发真实请求 */ }
  }
}

/** 用假的 window/require 加载产物，返回 factory 的结果 */
async function loadBundle(makeReact = fakeReact) {
  const captured = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: options => captured.push(options) } }
  try {
    await import(`${pathToFileURL(bundlePath).href}?t=${Math.random()}`)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.equal(captured.length, 1, '产物应当正好注册一次')
  const { id, factory } = captured[0]
  const React = makeReact()
  const requested = []
  const moduleExports = factory(spec => {
    requested.push(spec)
    if (spec === 'react') return React
    throw new Error(`未声明的模块请求：${spec}`)
  })
  return { id, moduleExports, requested }
}

function fakeClientCtx({ commandUi, sessions } = {}) {
  const injected = []
  const registered = []
  const disposers = []
  const scopes = []
  return {
    injected,
    registered,
    disposers,
    scopes,
    ctx: {
      // 客户端 cordis 同样有 ctx.inject(deps, cb)：这里只记录依赖并按需注入假服务
      inject(deps, contribute) {
        const scope = {
          commandUi,
          sessions,
          effect(fn) {
            const dispose = fn()
            disposers.push(dispose)
            return dispose
          }
        }
        scopes.push(deps)
        return contribute(scope)
      },
      effect(fn) {
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
      slots: {
        inject(name, contribute) {
          injected.push(name)
          const dispose = contribute()
          return () => { dispose?.() }
        },
        register(options, component) {
          registered.push({ options, component })
          return () => {}
        }
      }
    }
  }
}

test('产物是自注册 classic script，用的是宿主模块表', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id: 'dsh-ssh-hosts'/)
  // 没有 ESM 语法：它是 classic script，不是 ESM 产物
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /^\s*export\s/m)
  // React 不打包进来，由 factory 注入的 require 提供
  assert.match(source, /require\('react'\)/)
})

test('factory 返回宿主需要的插件对象', async () => {
  const { id, moduleExports, requested } = await loadBundle()
  assert.equal(id, 'dsh-ssh-hosts')
  assert.deepEqual(requested, ['react'])
  assert.deepEqual(moduleExports.inject, ['slots'])
  assert.equal(moduleExports.name, 'ssh-hosts')
  assert.equal(typeof moduleExports.apply, 'function')
})

test('apply 在两处注册卡片：插件页配置 + 设置分区', async () => {
  const { moduleExports } = await loadBundle()
  const client = fakeClientCtx()
  moduleExports.apply(client.ctx)

  assert.deepEqual(client.injected, ['plugins.bundle.config', 'settings.section'])
  const bySlot = new Map(client.registered.map(entry => [entry.options.name, entry.options]))
  assert.equal(bySlot.get('plugins.bundle.config').key, 'dsh-ssh-hosts')
  assert.equal(bySlot.get('settings.section').id, 'ssh-hosts')
  assert.equal(bySlot.get('settings.section').order, 55)
  assert.equal(bySlot.get('settings.section').label(), 'SSH 主机')
  assert.equal(typeof bySlot.get('settings.section').inject, 'function')
  assert.deepEqual(bySlot.get('settings.section').inject(), {})
  // 每个注册都带 effect 释放器，宿主卸载时能回收
  assert.equal(client.disposers.length, 2)
})

test('卡片能渲染出加载态；渲染本身不发请求', async () => {
  const { moduleExports } = await loadBundle()
  const client = fakeClientCtx()
  moduleExports.apply(client.ctx)

  const bundleSlot = client.registered.find(entry => entry.options.name === 'plugins.bundle.config')
  const page = bundleSlot.component({ view: 'page' })
  assert.equal(typeof page, 'object')
  assert.equal(page.type.name, 'Card')

  // 卡片渲染时不动 fetch、不抛异常
  const previousFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = () => { fetched += 1; return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: {} }) }) }
  try {
    const tree = bundleSlot.component({ view: 'page' })
    assert.equal(fetched, 0, '渲染本身不该发请求（副作用留给 useEffect）')
    assert.equal(tree.type.name, 'Card')
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

/** 从渲染树里收集所有元素类型与文本，便于断言「渲染出了什么」 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (typeof node === 'object' && node.type !== undefined) {
    visit(node)
    // 函数组件就地「浅渲染」一次，这样 Field/Select/HostBlock 产出的
    // 真实 DOM 节点也能被断言看到（这些组件都没有副作用）。
    if (typeof node.type === 'function') walk(node.type(node.props), visit)
    else walk(node.props?.children, visit)
    return
  }
  visit({ type: '#text', props: { children: String(node) } })
}

function textOf(tree) {
  const parts = []
  walk(tree, node => {
    if (node.type === '#text') parts.push(String(node.props.children))
    if (typeof node.type === 'function') parts.push(node.type.name || '')
    // Field/Select 的标题与提示是 props，不在 children 里
    for (const key of ['label', 'placeholder', 'hint']) {
      if (typeof node.props?.[key] === 'string') parts.push(node.props[key])
    }
  })
  return parts.join(' ')
}

function typesOf(tree) {
  const types = []
  walk(tree, node => { if (typeof node.type === 'string') types.push(node.type) })
  return types
}

async function internals() {
  const { moduleExports } = await loadBundle()
  return moduleExports.__test
}

const PASSWORD_HOST = {
  name: 'pw-01',
  host: '10.0.0.21',
  port: 22,
  user: 'root',
  identityFile: '',
  passwordRef: 'DSH_SSH_HOSTS_PASSWORD_PW_01',
  passwordConfigured: true,
  passwordSource: 'file',
  passwordWritable: true,
  tags: ['prod'],
  description: '生产库',
  defaultWorkdir: '/srv',
  readOnly: false,
  inUse: true
}

test('窄列布局：没有宽表格、没有固定两列，处处可换行可断行', () => {
  // 设置侧栏很窄，横向滚动是 bug：产物里不该再有表格与固定列宽
  assert.doesNotMatch(source, /h\('table'/)
  assert.doesNotMatch(source, /h\('td'/)
  assert.doesNotMatch(source, /gridTemplateColumns: '1fr 1fr'/)
  for (const rule of [
    "flexWrap: 'wrap'",
    "minWidth: 0",
    "boxSizing: 'border-box'",
    "overflowWrap: 'anywhere'",
    "wordBreak: 'break-word'",
    "repeat(auto-fit, minmax(180px, 1fr))",
    "wordBreak: 'break-all'"
  ]) {
    assert.ok(source.includes(rule), `缺少窄列布局规则：${rule}`)
  }
})

test('主机块：纵向堆叠、给出认证方式与密码状态，且不含任何秘密', async () => {
  const { HostBlock } = await internals()
  const tree = HostBlock({ host: PASSWORD_HOST, isDefault: true, busy: false })
  const types = typesOf(tree)
  assert.equal(types.includes('table'), false)
  const text = textOf(tree)
  assert.match(text, /pw-01/)
  assert.match(text, /默认/)
  assert.match(text, /密码/)
  assert.match(text, /已保存（file）/)
  assert.match(text, /编辑/)
  assert.match(text, /测试连接/)
  // 已经是默认主机：按钮变成禁用态的「已是默认」，不再让人点了个没反应的按钮
  assert.match(text, /已是默认/)
  assert.match(text, /删除/)
  // 凭据名与密码值都不出现在渲染结果里
  assert.equal(text.includes('DSH_SSH_HOSTS_PASSWORD_PW_01'), false)
  assert.equal(text.includes('hunter2'), false)
})

test('编辑器：登录方式可选、密码是 write-only 输入框、可清除已存密码', async () => {
  const { HostEditor, draftOf } = await internals()
  const draft = draftOf(PASSWORD_HOST)
  assert.equal(draft.auth, 'password')
  assert.equal(draft.password, '', '打开编辑器时密码框必须是空的（不回显）')
  const tree = HostEditor({
    draft: draft,
    previousName: 'pw-01',
    busy: false,
    passwordSupported: true,
    existing: PASSWORD_HOST,
    setDraft: () => {}
  })
  const text = textOf(tree)
  assert.match(text, /登录方式/)
  assert.match(text, /清除已存密码/)
  assert.match(text, /已存密码/)
  assert.match(text, /已保存（file）/)
  assert.match(text, /显示密码/)
  assert.match(text, /Enter 保存，Esc 取消/)
  const inputs = []
  const selects = []
  walk(tree, node => {
    if (node.type === 'input') inputs.push(node.props)
    if (node.type === 'select') selects.push(node.props)
  })
  const passwordInput = inputs.find(props => props.type === 'password')
  assert.ok(passwordInput, '必须有 type=password 的输入框')
  assert.equal(passwordInput.value, '')
  assert.equal(passwordInput.autoComplete, 'new-password')
  const options = selects[0].children.map(option => option.props.value)
  assert.deepEqual(options, ['key', 'password', 'key+password', 'agent'])
})

test('draftOf/payloadOf：换登录方式时不留下另一种方式的残留', async () => {
  const { draftOf, payloadOf, emptyDraft } = await internals()

  // 密码主机 → 改成纯密钥：identityFile 进，passwordRef 出
  const toKey = payloadOf({ ...draftOf(PASSWORD_HOST), auth: 'key', identityFile: '/keys/id_ed25519' })
  assert.equal(toKey.identityFile, '/keys/id_ed25519')
  assert.equal('passwordRef' in toKey, false)

  // 密钥主机 → 改成纯密码：passwordRef 进，identityFile 出
  const keyHost = { ...PASSWORD_HOST, identityFile: '/keys/id_ed25519', passwordRef: '' }
  const toPassword = payloadOf({ ...draftOf(keyHost), auth: 'password', passwordRef: 'DSH_SSH_HOSTS_PASSWORD_PW_01' })
  assert.equal('identityFile' in toPassword, false)
  assert.equal(toPassword.passwordRef, 'DSH_SSH_HOSTS_PASSWORD_PW_01')

  // 密钥 + 密码：两个都在
  const both = payloadOf({ ...draftOf(keyHost), auth: 'key+password', passwordRef: 'REF' })
  assert.equal(both.identityFile, '/keys/id_ed25519')
  assert.equal(both.passwordRef, 'REF')

  // 新增主机的空草稿不会写出任何空字段
  const blank = payloadOf({ ...emptyDraft(), name: 'a', host: 'h' })
  assert.deepEqual(blank, { name: 'a', host: 'h' })
})

test('「怎么用」块：直接给出引用方式', async () => {
  const { UsageHint } = await internals()
  const text = textOf(UsageHint({ name: 'pw-01', hasDefault: true }))
  assert.match(text, /怎么用/)
  assert.match(text, /ssh_run\(\{ command: "uname -a" \}\)/)
  assert.match(text, /ssh_use/)
  assert.match(text, /pw-01/)
  assert.match(text, /省略 host/)
})

/** 带状态的 React 替身：够跑「首屏 → 跑 effect → 二次渲染」这条真实路径 */
function statefulReact({ freezeStyles = false } = {}) {
  const slots = []
  let cursor = 0
  const effects = []
  return {
    __render(component, props) {
      cursor = 0
      return component(props)
    },
    __runEffects() { effects.splice(0).forEach(fn => fn()) },
    createElement(type, props, ...children) {
      if (freezeStyles && props && props.style) Object.freeze(props.style)
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = cursor++
      if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      }]
    },
    useEffect(fn) { effects.push(fn) }
  }
}

test('整张卡片：加载完成后渲染主机块与「怎么用」，全程不出现密码值', async () => {
  const React = statefulReact()
  const { moduleExports } = await loadBundle(() => React)
  const client = fakeClientCtx()
  moduleExports.apply(client.ctx)
  // 直接渲染卡片本体：槽位包装组件只是 h(Card)，不跑 hooks
  const Card = moduleExports.__test.Card

  const view = {
    file: '/home/u/.dsh/ssh-hosts.yaml',
    writable: true,
    source: 'file',
    reason: '',
    defaultHost: 'pw-01',
    configuredDefaultHost: '',
    loadedAt: '2026-01-01T00:00:00.000Z',
    error: null,
    fileInfo: { exists: true, mode: '0600', bytes: 100, mtime: '2026-01-01T00:00:00.000Z' },
    passwordSupported: true,
    hosts: [PASSWORD_HOST]
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: view }) })
  try {
    React.__render(Card, {})   // 首屏：loading
    React.__runEffects()       // 触发 load()
    await new Promise(resolve => setTimeout(resolve, 0))
    const tree = React.__render(Card, {})
    const text = textOf(tree)
    assert.match(text, /pw-01/)
    assert.match(text, /已保存（file）/)
    assert.match(text, /默认主机：pw-01/)
    assert.match(text, /怎么用/)
    assert.match(text, /ssh_run/)
    assert.match(text, /新增主机/)
    assert.match(text, /重新读取/)
    // 渲染结果里没有表格（窄列不该横向滚动），也没有任何秘密
    assert.equal(typesOf(tree).includes('table'), false)
    assert.equal(text.includes('hunter2'), false)
    assert.equal(text.includes('DSH_SSH_HOSTS_PASSWORD_PW_01'), false)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('宿主没有这些槽位时 apply 也不报错（纯 CLI/旧版本宿主）', async () => {
  const { moduleExports } = await loadBundle()
  const ctx = {
    effect(fn) { return fn() },
    slots: {
      inject() { /* 声明永远不出现：宿主不会调用注册 */ },
      register() { throw new Error('不应被调用') }
    }
  }
  assert.doesNotThrow(() => moduleExports.apply(ctx))
})

test('会话窗口「+」菜单：给 /ssh 挂主机选择弹窗（commandUi.decorate）', async () => {
  const { moduleExports } = await loadBundle()
  const decorated = []
  const commandUi = {
    decorate(decoration) { decorated.push(decoration); return () => {} },
    register() { throw new Error('本插件用的是 decorate（/ssh 是 host 命令），不是 register') }
  }
  const client = fakeClientCtx({ commandUi, sessions: { binding: () => undefined } })
  moduleExports.apply(client.ctx)

  assert.deepEqual(client.scopes, [['commandUi', 'sessions']])
  assert.equal(decorated.length, 1)
  const decoration = decorated[0]
  assert.equal(decoration.name, 'ssh')
  assert.equal(decoration.available({ sessionId: 's' }), true)

  // 子代理会话不给这一行（点了也执行不了）
  const subagentDecorated = []
  const subagentClient = fakeClientCtx({
    commandUi: { decorate: value => { subagentDecorated.push(value); return () => {} }, register: () => { throw new Error('unused') } },
    sessions: { binding: () => undefined, subagentAddress: id => (id === 'sub-1' ? { kind: 'subagent' } : undefined) }
  })
  const subagentExports = await loadBundle()
  subagentExports.moduleExports.apply(subagentClient.ctx)
  assert.equal(subagentDecorated.length, 1)
  assert.equal(subagentDecorated[0].available({ sessionId: 'sub-1' }), false)
  assert.equal(subagentDecorated[0].available({ sessionId: 'main' }), true)
  assert.equal(decoration.ui.kind, 'popupSelect')
  assert.equal(typeof decoration.ui.options, 'function')
  assert.equal(typeof decoration.ui.onSelect, 'function')
  // inject 仍然只有 slots：没有 commandUi 的宿主也必须能加载卡片
  assert.deepEqual(moduleExports.inject, ['slots'])
})

test('没有 commandUi 的宿主：apply 照常，不注册选择器也不报错', async () => {
  const { moduleExports } = await loadBundle()
  const client = fakeClientCtx()   // 没有 commandUi / sessions
  assert.doesNotThrow(() => moduleExports.apply(client.ctx))
  assert.equal(client.registered.length, 2, '两处卡片照旧注册')
})

test('选择弹窗的选项：带上会话默认主机标记与认证方式；空清单给出可照做的错误', async () => {
  const { hostOptions } = await internals()
  const view = {
    file: '/f', writable: true, defaultHost: 'db-01', sessionDefaultHost: 'pw-01',
    hosts: [PASSWORD_HOST, { ...PASSWORD_HOST, name: 'db-01', host: '10.0.0.12', user: 'ro', port: 2222, tags: ['db'], auth: 'key', passwordConfigured: false }]
  }
  const seen = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => {
    seen.push(String(url))
    return { ok: true, json: async () => ({ ok: true, value: view }) }
  }
  try {
    const rows = await hostOptions({ sessionId: 'sess-1' })
    assert.equal(seen[0], '/ssh-hosts/hosts?sessionId=sess-1')
    assert.deepEqual(rows.map(row => row.id), ['pw-01', 'db-01'])
    // 本会话在用哪台：标记来自 sessionDefaultHost（不是全局默认）
    assert.equal(rows[0].active, true)
    assert.match(rows[0].detail, /root@10\.0\.0\.21/)
    assert.match(rows[0].detail, /prod/)
    assert.match(rows[0].detail, /密码/)
    assert.match(rows[0].detail, /本会话在用/)
    assert.equal(rows[1].active, false)
    assert.match(rows[1].detail, /:2222/)

    // 没有 sessionId 时不带 query
    await hostOptions({})
    assert.equal(seen[1], '/ssh-hosts/hosts')

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: { ...view, hosts: [] } }) })
    await assert.rejects(() => hostOptions({ sessionId: 's' }), /设置 → SSH 主机/)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('选中主机 = 提交 /ssh <名字>；会话未就绪或命令缺失时报错', async () => {
  const { pickHost } = await internals()
  const lines = []
  const sessions = {
    binding(sessionId) {
      return {
        session: {
          command(line) { lines.push([sessionId, line]); return Promise.resolve({ ok: true, value: { matched: true } }) }
        }
      }
    }
  }
  await pickHost(sessions, { id: 'web-01' }, { sessionId: 'sess-1' })
  assert.deepEqual(lines, [['sess-1', '/ssh web-01']])

  await assert.rejects(() => pickHost({ binding: () => undefined }, { id: 'web-01' }, { sessionId: 's' }), /还没就绪/)

  const notMatched = { binding: () => ({ session: { command: () => Promise.resolve({ ok: true, value: { matched: false } }) } }) }
  await assert.rejects(() => pickHost(notMatched, { id: 'web-01' }, { sessionId: 's' }), /重启桌面应用/)

  const failed = { binding: () => ({ session: { command: () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'boom' } }) } }) }
  await assert.rejects(() => pickHost(failed, { id: 'web-01' }, { sessionId: 's' }), /internal: boom/)
})

test('校验：必填 / 名称字符集 / 端口范围 / 重名 / 密码缺失，都给可照做的文案', async () => {
  const { validateDraft, emptyDraft } = await internals()
  const base = { ...emptyDraft(), name: 'web-01', host: '10.0.0.11' }
  assert.deepEqual(validateDraft(base, {}), {})

  assert.match(validateDraft({ ...base, name: '' }, {}).name, /必填/)
  assert.match(validateDraft({ ...base, name: '-bad' }, {}).name, /字母或数字开头/)
  assert.match(validateDraft({ ...base, name: 'a'.repeat(65) }, {}).name, /64 字符/)
  assert.match(validateDraft({ ...base, host: '' }, {}).host, /必填/)
  assert.match(validateDraft({ ...base, host: 'http://x' }, {}).host, /域名/)

  for (const port of ['0', '70000', '22a', '-1']) {
    assert.match(validateDraft({ ...base, port }, {}).port, /1-65535/, `端口 ${port} 应被拦下`)
  }
  assert.deepEqual(validateDraft({ ...base, port: '2222' }, {}), {})
  assert.match(validateDraft({ ...base, user: 'a b' }, {}).user, /用户名/)

  // 重名 = 会覆盖别人的主机：新增时拦下，编辑它自己时放行
  assert.match(validateDraft(base, { existingNames: ['web-01'] }).name, /已有同名主机/)
  assert.deepEqual(validateDraft(base, { existingNames: ['web-01'], previousName: 'web-01' }), {})

  // 私钥路径与远端目录：相对路径是最常见的坑
  const keyDraft = { ...base, auth: 'key', identityFile: 'keys/id_ed25519' }
  assert.match(validateDraft(keyDraft, {}).identityFile, /绝对路径或 ~/)
  assert.deepEqual(validateDraft({ ...keyDraft, identityFile: '~/.ssh/id_ed25519' }, {}), {})
  assert.match(validateDraft({ ...base, defaultWorkdir: 'srv/app' }, {}).defaultWorkdir, /绝对路径/)
  assert.match(validateDraft({ ...base, proxyJump: 'bast ion' }, {}).proxyJump, /user@host:port/)

  // 密码登录必须至少填一次；已存过的可以留空；没有凭据服务时提前说清楚
  const pwDraft = { ...base, auth: 'password' }
  assert.match(validateDraft(pwDraft, {}).password, /至少要填一次/)
  assert.deepEqual(validateDraft({ ...pwDraft, password: 'x' }, {}), {})
  assert.deepEqual(validateDraft({ ...pwDraft, passwordRef: 'REF' }, { passwordConfigured: true }), {})
  assert.match(validateDraft({ ...pwDraft, password: 'x' }, { passwordSupported: false }).password, /没有凭据服务/)
})

test('过滤：名称/地址/标签/备注/认证方式任一命中，大小写不敏感', async () => {
  const { filterHosts } = await internals()
  const keyHost = { ...PASSWORD_HOST, name: 'db-01', host: '10.0.0.12', user: 'ro', tags: ['db'], description: '只读从库', passwordRef: '', passwordConfigured: false, identityFile: '/k/id' }
  const hosts = [PASSWORD_HOST, keyHost]
  assert.equal(filterHosts(hosts, '').length, 2, '空查询原样返回')
  assert.deepEqual(filterHosts(hosts, 'db-01').map(host => host.name), ['db-01'])
  assert.deepEqual(filterHosts(hosts, '10.0.0.21').map(host => host.name), ['pw-01'])
  assert.deepEqual(filterHosts(hosts, '只读从库').map(host => host.name), ['db-01'])
  assert.deepEqual(filterHosts(hosts, '密钥').map(host => host.name), ['db-01'], '认证方式也能搜')
  assert.deepEqual(filterHosts(hosts, 'PROD').map(host => host.name), ['pw-01'])
  assert.equal(filterHosts(hosts, '不存在的主机').length, 0)
})

test('忙碌文案说人话（不是内部动作名）', async () => {
  const { busyText } = await internals()
  assert.equal(busyText(null), '')
  assert.equal(busyText({ kind: 'save' }), '正在保存…')
  assert.equal(busyText({ kind: 'test', name: 'web-01' }), '正在测试 web-01 的连接…')
  assert.equal(busyText({ kind: 'remove', name: 'web-01' }), '正在删除 web-01…')
  assert.equal(busyText({ kind: 'default', name: 'web-01' }), '正在把 web-01设为默认…')
  assert.match(busyText({ kind: 'reload' }), /重新读取/)
})

test('主机块：删除要先确认，且说清会连带清掉什么', async () => {
  const { HostBlock } = await internals()
  const plain = textOf(HostBlock({ host: { ...PASSWORD_HOST, passwordRef: '' }, isDefault: false, busy: false }))
  assert.match(plain, /设为默认/)

  const confirming = textOf(HostBlock({ host: PASSWORD_HOST, isDefault: false, busy: false, confirming: true }))
  assert.match(confirming, /确认删除/)
  assert.match(confirming, /取消/)
  assert.match(confirming, /已存密码也一并清除/)
  assert.equal(confirming.includes('编辑'), false, '确认态不再给「编辑」，避免误触')
})

test('主机块：连通性结果就地显示；加载失败的条目给出原因', async () => {
  const { HostBlock } = await internals()
  const ok = textOf(HostBlock({ host: PASSWORD_HOST, isDefault: false, busy: false, test: { status: 'ok', text: '连接正常（12 ms）' } }))
  assert.match(ok, /连接正常（12 ms）/)
  const fail = textOf(HostBlock({ host: PASSWORD_HOST, isDefault: false, busy: false, test: { status: 'fail', text: '连接失败（exit 255）：Permission denied' } }))
  assert.match(fail, /连接失败（exit 255）/)
  const broken = textOf(HostBlock({ host: { ...PASSWORD_HOST, inUse: false }, isDefault: false, busy: false }))
  assert.match(broken, /未生效/)
  assert.match(broken, /重新读取/, '未生效的条目要告诉人怎么修')
})

test('编辑器：错误就地显示在字段上；Enter 保存 / Esc 取消', async () => {
  const { HostEditor, draftOf } = await internals()
  let saved = 0
  let cancelled = 0
  const tree = HostEditor({
    draft: draftOf(PASSWORD_HOST), previousName: 'pw-01', busy: false, passwordSupported: true,
    existing: PASSWORD_HOST, errors: { port: '端口是 1-65535 的整数' },
    formError: '还有 1 处需要改一下（红框处）。',
    setDraft: () => {}, onSave: () => { saved += 1 }, onCancel: () => { cancelled += 1 }
  })
  const text = textOf(tree)
  assert.match(text, /端口是 1-65535 的整数/)
  assert.match(text, /还有 1 处需要改一下/)

  const alerts = []
  walk(tree, node => { if (node.props?.role === 'alert') alerts.push(node) })
  assert.ok(alerts.length >= 2, '错误要用 role=alert 暴露给读屏')

  let container = null
  walk(tree, node => {
    if (container === null && node.type === 'div' && typeof node.props?.onKeyDown === 'function') container = node
  })
  assert.ok(container, '表单容器要处理键盘')
  const press = tagName => ({ key: tagName === 'Escape' ? 'Escape' : 'Enter', target: { tagName }, preventDefault() {} })
  container.props.onKeyDown(press('INPUT'))
  assert.equal(saved, 1, 'Enter 应触发保存')
  container.props.onKeyDown(press('Escape'))
  assert.equal(cancelled, 1, 'Esc 应触发取消')
  container.props.onKeyDown(press('SELECT'))
  assert.equal(saved, 1, '焦点在下拉框上时 Enter 不该提交表单')
})

test('整张卡片：没有主机时给出可照做的空状态', async () => {
  const React = statefulReact()
  const { moduleExports } = await loadBundle(() => React)
  const Card = moduleExports.__test.Card
  const view = {
    file: '/home/u/.dsh/ssh-hosts.yaml', writable: true, source: 'file', reason: '',
    defaultHost: '', configuredDefaultHost: '', error: null,
    fileInfo: { exists: false }, passwordSupported: true, hosts: []
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: view }) })
  try {
    React.__render(Card, {})
    React.__runEffects()
    await new Promise(resolve => setTimeout(resolve, 0))
    const text = textOf(React.__render(Card, {}))
    assert.match(text, /还没有主机/)
    assert.match(text, /新增主机/)
    assert.match(text, /重新读取/)
    assert.equal(text.includes('怎么用'), false, '没有主机时不显示「怎么用」')
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('整张卡片：多台主机时出现过滤框与台数（style 被冻结也照样重渲染）', async () => {
  // 用 dev 构建那样的冻结行为跑：共享样式若被原地改，第二次渲染会抛 TypeError。
  const React = statefulReact({ freezeStyles: true })
  const { moduleExports } = await loadBundle(() => React)
  const Card = moduleExports.__test.Card
  const view = {
    file: '/home/u/.dsh/ssh-hosts.yaml', writable: true, source: 'file', reason: '',
    defaultHost: '', configuredDefaultHost: '', error: null,
    fileInfo: { exists: true, mode: '0600' }, passwordSupported: true,
    hosts: [PASSWORD_HOST, { ...PASSWORD_HOST, name: 'db-01', host: '10.0.0.12', passwordRef: '', passwordConfigured: false }]
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: view }) })
  try {
    React.__render(Card, {})
    React.__runEffects()
    await new Promise(resolve => setTimeout(resolve, 0))
    React.__render(Card, {})
    const tree = React.__render(Card, {})
    const text = textOf(tree)
    assert.match(text, /共 2 台/)
    const searches = []
    walk(tree, node => { if (node.type === 'input' && node.props.type === 'search') searches.push(node.props) })
    assert.equal(searches.length, 1, '主机多于一台时给一个过滤框')
    assert.match(searches[0]['aria-label'], /过滤/)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('共享样式常量只能当只读底稿（React DOM dev 构建会冻结 style）', async () => {
  // 这条是上面那个 TypeError 的源码级护栏：任何一个共享 style 常量被 Object.assign
  // 原地修改，都会在 dev 构建里第二次渲染时炸掉。
  const shared = ['muted', 'rootStyle', 'inputStyle', 'buttonStyle', 'rowStyle', 'actionsStyle', 'codeStyle', 'badgeStyle', 'boxStyle']
  for (const name of shared) {
    const mutating = new RegExp(`Object\\.assign\\(${name}\\s*[,)]`)
    assert.equal(mutating.test(source), false, `${name} 是共享样式常量，不能原地修改`)
  }
  assert.match(source, /function mutedWith\(/, '要有返回新对象的 mutedWith 辅助')
})
