/* dsh-ssh-hosts — Browser half（手写产物，无需构建步骤）。
 *
 * 为什么插件要自带界面：宿主会为导出了 volatile Config 的插件生成「表单投影」，
 * 但当前版本没有任何已发布客户端渲染它，所以配置界面要插件自己提供
 * （工作区里的 dsh-webdav-sync 走的是同一条路）。
 *
 * 产物形态不是 ESM，而是自注册的 classic script：加载时调用
 * window.__ModuleLoader__.load({ id, factory })，factory 内用注入的 require
 * 走平台模块表（React 由宿主提供，不要打包进来）。
 *
 * 界面只做一件事：读写 ~/.dsh/ssh-hosts.yaml —— 也就是工具用的那份清单。
 * 走同源 HTTP（/ssh-hosts/*，见 lib/api.js），所以不存在「界面一套配置、
 * 工具另一套配置」的分叉；写完立刻重载，agent 下一个调用就能看到新主机。
 * 密码是唯一的例外：它只进不出，POST 上来后由插件交给 DSH 凭据库，
 * 清单里只留一个 passwordRef，界面永远只能看到「有没有 / 来自哪一层」。
 *
 * ── 设计规格（DESIGN SPECIFICATION）────────────────────────────────────
 * 1. 目的：运维/开发者在设置侧栏那种很窄的一列里，把服务器接进 agent。
 *    他们要做的是「加进来、确认能连、别删错」，不是浏览产品页 ——
 *    所以密度、就地反馈、防误操作优先于装饰。
 * 2. 风格方向：Industrial / utilitarian（仪表盘式运维控制台）。
 * 3. 色彩：全部走宿主 token，带兜底值，不使用任何紫/靛/渐变：
 *    --dsw-border/#d0d0d0（中性）、--dsw-accent/#4a7dff（只用于主操作）、
 *    --dsw-danger/#d33（危险）、#1a7f37（成功）、#9a6700（警告）。
 * 4. 字体：继承宿主（卡片不指定 font-family —— 设置面板里换字体会和 App 其余部分打架）。
 *    ⚠️ 对 skill 默认规则的显式覆盖：不用 Tailwind、不自选字体、不引入图标库，
 *    按钮一律文字标签（宿主只提供 React 与 --dsw-* 变量，卡片必须像 App 自己的一部分）。
 * 5. 布局：单列纵向（窄列是硬约束，绝不横向滚动）。信息层级 = 名称+状态徽章 →
 *    连接事实 → 操作；优化重点是「就地反馈」（校验错误、测试结果、删除确认都出现在
 *    触发它的那个元素旁边），而不是重排版式。
 * ───────────────────────────────────────────────────────────────────────
 *
 * 布局约束（有回归测试盯着）：卡片会被塞进设置侧栏那种很窄的列里，所以
 *  - 一律 width:100% + boxSizing:border-box + minWidth:0，绝不横向滚动；
 *  - 主机列表是纵向堆叠的块，不是宽表格；字段行 flexWrap，长路径 break-all；
 *  - 表单用 auto-fit 网格，宽了就两列，窄了自动落成一列。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ssh-hosts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/ssh-hosts'
    var TITLE = 'SSH 主机'
    var BLURB = '这里管理 agent 可用的服务器。改动直接落到 ssh-hosts.yaml 并立即生效，不用重启。'
      + '密码存进 DSH 凭据库（0600），清单里只留一个引用名，界面不回显密码。'

    async function api(path, init) {
      var res = await fetch(API + path, init)
      var body = await res.json().catch(function () { return null })
      if (!res.ok || !body || body.ok !== true) {
        throw new Error((body && body.error && body.error.message) || ('HTTP ' + res.status))
      }
      return body.value
    }
    function get(path) { return api(path) }
    function post(path, payload) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      })
    }

    /* ── 校验规则：与 lib/hosts.js 一一对应 ────────────────────────────────
     * 界面上先拦一道，用户不用等一次 400 才知道「端口得是 1-65535」。
     * 规则必须和服务端保持一致（服务端仍然是权威，这里是提前告知）。 */
    var NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
    var HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
    var USER_PATTERN = /^[A-Za-z0-9._-]+$/
    var JUMP_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+(?::[0-9]{1,5})?$/
    var MAX_DESCRIPTION = 400

    var border = '1px solid var(--dsw-border, #d0d0d0)'
    var muted = { fontSize: '12px', opacity: 0.72 }
    /** ⚠️ React DOM（dev 构建）会 Object.freeze 它收到的每个 style 对象，
     *  所以共享样式常量只能当只读底稿：永远返回新对象，绝不原地改。 */
    function mutedWith(extra) { return Object.assign({}, muted, extra) }
    var dangerColor = 'var(--dsw-danger, #d33)'
    var okColor = 'var(--dsw-success, #1a7f37)'
    var warnColor = 'var(--dsw-warning, #9a6700)'
    /** 卡片根样式：窄列里不撑破、长串自己断行 */
    var rootStyle = {
      padding: '4px 0', width: '100%', maxWidth: '100%', minWidth: 0,
      boxSizing: 'border-box', overflowWrap: 'anywhere', wordBreak: 'break-word'
    }
    function boxStyle() {
      return {
        width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
        padding: '10px', border: border, borderRadius: '8px'
      }
    }
    function inputStyle() {
      return {
        padding: '6px 8px', borderRadius: '6px', border: border, background: 'transparent',
        color: 'inherit', fontSize: '13px', width: '100%', maxWidth: '100%', minWidth: 0,
        boxSizing: 'border-box'
      }
    }
    function buttonStyle(primary) {
      return {
        padding: '5px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
        border: border, background: primary ? 'var(--dsw-accent, #4a7dff)' : 'transparent',
        color: primary ? '#fff' : 'inherit', maxWidth: '100%'
      }
    }
    function rowStyle() {
      return { display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'baseline', minWidth: 0 }
    }
    function actionsStyle() {
      return { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px', minWidth: 0 }
    }
    function codeStyle() {
      return { fontSize: '12px', wordBreak: 'break-all', minWidth: 0 }
    }
    /** 徽章：tone 决定颜色（默认中性；ok/warn/danger/accent 用于状态） */
    function badgeStyle(tone) {
      var color = tone === 'ok' ? okColor
        : tone === 'warn' ? warnColor
          : tone === 'danger' ? dangerColor
            : tone === 'accent' ? 'var(--dsw-accent, #4a7dff)' : 'inherit'
      return {
        fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: border,
        color: color, opacity: tone === undefined ? 0.8 : 1, whiteSpace: 'nowrap'
      }
    }

    /** 认证方式的显示名（与 lib/hosts.js 的 authModeOf 对齐） */
    function authLabel(host) {
      if (host.passwordRef && host.identityFile) return '密钥 + 密码'
      if (host.passwordRef) return '密码'
      if (host.identityFile) return '密钥'
      return 'ssh-agent'
    }

    function ErrorText(props) {
      if (!props.text) return null
      return h('span', { role: 'alert', style: { fontSize: '11px', color: dangerColor, wordBreak: 'break-word' } }, props.text)
    }

    function Field(props) {
      var err = props.error
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0', minWidth: 0 } },
        h('span', { style: muted }, props.label),
        h('input', {
          type: props.type || 'text',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          autoComplete: props.autoComplete || 'off',
          'aria-invalid': err ? 'true' : undefined,
          style: Object.assign(inputStyle(), err ? { borderColor: dangerColor } : null),
          onChange: function (e) { props.onChange(e.target.value) }
        }),
        err ? h(ErrorText, { text: err }) : (props.hint ? h('span', { style: muted }, props.hint) : null))
    }

    function Select(props) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0', minWidth: 0 } },
        h('span', { style: muted }, props.label),
        h('select', {
          value: props.value,
          style: inputStyle(),
          onChange: function (e) { props.onChange(e.target.value) }
        }, props.options.map(function (option) {
          return h('option', { key: option.value, value: option.value }, option.label)
        })))
    }

    function Check(props) {
      return h('label', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '10px 0', fontSize: '13px', minWidth: 0 } },
        h('input', { type: 'checkbox', checked: Boolean(props.value), onChange: function (e) { props.onChange(e.target.checked) } }),
        h('span', { style: { minWidth: 0 } }, props.label))
    }

    function emptyDraft() {
      return {
        name: '', host: '', port: '', user: '', auth: 'key', identityFile: '', password: '', passwordRef: '',
        proxyJump: '', defaultWorkdir: '', description: '', tags: '', readOnly: false
      }
    }

    function draftOf(host) {
      var auth = 'agent'
      if (host.identityFile && host.passwordRef) auth = 'key+password'
      else if (host.passwordRef) auth = 'password'
      else if (host.identityFile) auth = 'key'
      return {
        name: host.name || '',
        host: host.host || '',
        port: host.port === undefined || host.port === null || host.port === 22 ? '' : String(host.port),
        user: host.user || '',
        auth: auth,
        identityFile: host.identityFile || '',
        password: '',
        passwordRef: host.passwordRef || '',
        proxyJump: typeof host.proxyJump === 'string' ? host.proxyJump : (host.via || ''),
        defaultWorkdir: host.defaultWorkdir || '',
        description: host.description || '',
        tags: Array.isArray(host.tags) ? host.tags.join(', ') : '',
        readOnly: host.readOnly === true
      }
    }

    /** 草稿 → 请求体：空字段不发，避免把「没填」写成空串覆盖文件里的值。 */
    function payloadOf(draft) {
      var out = { name: draft.name.trim(), host: draft.host.trim() }
      if (draft.port.trim().length > 0) out.port = Number(draft.port.trim())
      if (draft.user.trim().length > 0) out.user = draft.user.trim()
      var usesKey = draft.auth === 'key' || draft.auth === 'key+password'
      var usesPassword = draft.auth === 'password' || draft.auth === 'key+password'
      if (usesKey && draft.identityFile.trim().length > 0) out.identityFile = draft.identityFile.trim()
      // 换认证方式时要把另一种方式的残留摘掉，否则清单里会留下指向已删凭据的引用。
      if (usesPassword && draft.passwordRef) out.passwordRef = draft.passwordRef
      if (draft.proxyJump.trim().length > 0) out.proxyJump = draft.proxyJump.trim()
      if (draft.defaultWorkdir.trim().length > 0) out.defaultWorkdir = draft.defaultWorkdir.trim()
      if (draft.description.trim().length > 0) out.description = draft.description.trim()
      var tags = draft.tags.split(',').map(function (s) { return s.trim() }).filter(Boolean)
      if (tags.length > 0) out.tags = tags
      if (draft.readOnly === true) out.readOnly = true
      return out
    }

    /**
     * 草稿校验：返回「字段 → 错误文案」的映射，空对象表示可以提交。
     * options: { existingNames, previousName, passwordConfigured, passwordSupported }
     * 规则与 lib/hosts.js 对齐；重名按「会覆盖」处理 —— 新增时撞名最容易把别人的主机改掉。
     */
    function validateDraft(draft, options) {
      var opts = options || {}
      var existingNames = opts.existingNames || []
      var previousName = opts.previousName || ''
      var passwordSupported = opts.passwordSupported !== false
      var fields = {}

      var name = String(draft.name || '').trim()
      var host = String(draft.host || '').trim()
      var port = String(draft.port || '').trim()
      var user = String(draft.user || '').trim()
      var identityFile = String(draft.identityFile || '').trim()
      var workdir = String(draft.defaultWorkdir || '').trim()
      var proxyJump = String(draft.proxyJump || '').trim()
      var description = String(draft.description || '').trim()
      var password = String(draft.password || '')
      var usesKey = draft.auth === 'key' || draft.auth === 'key+password'
      var usesPassword = draft.auth === 'password' || draft.auth === 'key+password'
      var passwordSaved = Boolean(draft.passwordRef) && opts.passwordConfigured !== false

      if (name.length === 0) fields.name = '必填：agent 就用这个名字引用这台机器'
      else if (!NAME_PATTERN.test(name)) fields.name = '字母或数字开头，只含字母、数字、. _ -，最多 64 字符'
      else if (name !== previousName && existingNames.indexOf(name) >= 0) {
        fields.name = '已有同名主机「' + name + '」：保存会覆盖它。改个名字，或直接点那台的「编辑」'
      }

      if (host.length === 0) fields.host = '必填：域名或 IP'
      else if (!HOST_PATTERN.test(host)) fields.host = '只能是域名 / IPv4 / IPv6（字母、数字、. : -）'

      if (port.length > 0) {
        var numeric = Number(port)
        if (!/^[0-9]+$/.test(port) || !Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
          fields.port = '端口是 1-65535 的整数'
        }
      }
      if (user.length > 0 && !USER_PATTERN.test(user)) fields.user = '用户名只能用字母、数字、. _ -'

      if (usesKey && identityFile.length > 0
        && identityFile.charAt(0) !== '/' && identityFile !== '~' && identityFile.indexOf('~/') !== 0) {
        fields.identityFile = '用绝对路径或 ~ 开头（相对路径会相对进程目录解析）'
      }
      if (workdir.length > 0 && workdir.charAt(0) !== '/') fields.defaultWorkdir = '必须是远端绝对路径（/ 开头）'
      if (description.length > MAX_DESCRIPTION) fields.description = '备注上限 ' + MAX_DESCRIPTION + ' 字符（现在 ' + description.length + '）'
      if (proxyJump.length > 0 && !JUMP_PATTERN.test(proxyJump)) fields.proxyJump = '写法：本清单里的名称，或 user@host:port'

      if (usesPassword && !passwordSupported) {
        fields.password = '当前 profile 没有凭据服务：密码存不下来，请改用密钥或 ssh-agent'
      } else if (usesPassword && !passwordSaved && password.length === 0) {
        fields.password = '密码登录至少要填一次密码（已经存过的可以留空）'
      }
      return fields
    }

    /** 主机过滤：名称 / 地址 / 用户 / 标签 / 备注 / 认证方式，任一命中即可 */
    function filterHosts(hosts, query) {
      var q = String(query || '').trim().toLowerCase()
      if (q.length === 0) return hosts
      return hosts.filter(function (host) {
        var hay = [
          host.name, host.host, host.user, host.description, authLabel(host),
          Array.isArray(host.tags) ? host.tags.join(' ') : ''
        ].join(' ').toLowerCase()
        return hay.indexOf(q) >= 0
      })
    }

    /** 忙碌文案：说清楚「在做什么」，而不是把内部动作名甩给用户 */
    function busyText(busy) {
      if (!busy) return ''
      var name = busy.name ? ' ' + busy.name : ''
      if (busy.kind === 'save') return '正在保存…'
      if (busy.kind === 'test') return '正在测试' + name + ' 的连接…'
      if (busy.kind === 'remove') return '正在删除' + name + '…'
      if (busy.kind === 'default') return '正在把' + name + '设为默认…'
      if (busy.kind === 'reload') return '正在重新读取清单…'
      return '处理中…'
    }

    function firstLine(text, max) {
      var value = String(text === undefined || text === null ? '' : text)
        .split('\n').map(function (line) { return line.trim() })
        .filter(function (line) { return line.length > 0 })[0] || ''
      var limit = max || 140
      return value.length > limit ? value.slice(0, limit) + '…' : value
    }

    function HostEditor(props) {
      var d = props.draft
      var set = props.setDraft
      var existing = props.existing || {}
      var errors = props.errors || {}
      var revealState = useState(false)
      var reveal = revealState[0]
      var setReveal = revealState[1]
      var clearState = useState(false)
      var confirmingClear = clearState[0]
      var setConfirmingClear = clearState[1]

      function change(key, value) {
        set(function (prev) { var next = Object.assign({}, prev); next[key] = value; return next })
      }
      /** Enter = 保存，Esc = 取消：表单里最常见的两个动作不该只能点按钮 */
      function onKeyDown(event) {
        if (!event || !event.key) return
        if (event.key === 'Escape') { event.preventDefault(); props.onCancel(); return }
        if (event.key === 'Enter' && event.target && event.target.tagName === 'INPUT') {
          event.preventDefault()
          props.onSave()
        }
      }

      var usesKey = d.auth === 'key' || d.auth === 'key+password'
      var usesPassword = d.auth === 'password' || d.auth === 'key+password'
      var passwordSaved = Boolean(d.passwordRef) && existing.passwordConfigured !== false
      var passwordSource = existing.passwordSource ? '（' + existing.passwordSource + '）' : ''

      var fields = [
        h(Field, {
          key: 'name', label: '名称（agent 用这个名字引用）', value: d.name, error: errors.name,
          onChange: function (v) { change('name', v) }, placeholder: 'web-01'
        }),
        h(Field, {
          key: 'host', label: '地址 / IP', value: d.host, error: errors.host,
          onChange: function (v) { change('host', v) }, placeholder: '10.0.0.11'
        }),
        h(Field, {
          key: 'port', label: '端口（默认 22）', value: d.port, error: errors.port,
          onChange: function (v) { change('port', v) }, placeholder: '22'
        }),
        h(Field, {
          key: 'user', label: '登录用户', value: d.user, error: errors.user,
          onChange: function (v) { change('user', v) }, placeholder: 'deploy'
        })
      ]

      var authBlock = [
        h(Select, {
          key: 'auth', label: '登录方式', value: d.auth,
          options: [
            { value: 'key', label: '密钥文件（推荐）' },
            { value: 'password', label: '密码' },
            { value: 'key+password', label: '密钥优先，密码兜底' },
            { value: 'agent', label: 'ssh-agent / 默认密钥' }
          ],
          onChange: function (v) { change('auth', v) }
        })
      ]
      if (usesKey) {
        authBlock.push(h(Field, {
          key: 'identityFile', label: '私钥路径（可写 ~，权限必须 0600）', value: d.identityFile, error: errors.identityFile,
          onChange: function (v) { change('identityFile', v) }, placeholder: '~/.ssh/id_ed25519'
        }))
      }
      if (usesPassword) {
        authBlock.push(h('div', { key: 'pwstatus', style: Object.assign(rowStyle(), { marginTop: '6px' }) },
          h('span', { style: muted }, '已存密码'),
          h('span', { style: badgeStyle(passwordSaved ? 'ok' : 'warn') },
            passwordSaved ? ('已保存' + passwordSource) : '未设置')))
        authBlock.push(h(Field, {
          key: 'password', label: '密码', type: reveal ? 'text' : 'password', value: d.password,
          autoComplete: 'new-password', error: errors.password,
          placeholder: passwordSaved ? '已保存，留空则不改动' : '登录密码',
          onChange: function (v) { change('password', v) },
          hint: props.passwordSupported
            ? '密码存进 DSH 凭据库（$DSH_HOME/.credentials.yaml，0600），清单里只留一个引用名；界面不回显已存的密码。'
            : '当前 profile 没有凭据服务，密码存不下来：请改用密钥或 ssh-agent。'
        }))
        authBlock.push(h('div', { key: 'pwactions', style: Object.assign(rowStyle(), { marginTop: '2px' }) },
          h('button', {
            type: 'button', style: buttonStyle(false), disabled: props.busy,
            onClick: function () { setReveal(!reveal) }
          }, reveal ? '隐藏密码' : '显示密码'),
          passwordSaved ? h('button', {
            type: 'button', style: buttonStyle(false), disabled: props.busy,
            onClick: function () { setConfirmingClear(true) }
          }, '清除已存密码') : null))
        if (confirmingClear && passwordSaved) {
          authBlock.push(h('div', {
            key: 'pwconfirm',
            style: { border: '1px solid ' + dangerColor, borderRadius: '6px', padding: '6px 8px', margin: '6px 0', minWidth: 0 }
          },
            h('div', { style: mutedWith({ marginBottom: '4px' }) },
              '清除后这台机器就没有已存密码了（保存时生效，凭据会一并删掉）。'),
            h('div', { style: rowStyle() },
              h('button', {
                type: 'button', style: Object.assign(buttonStyle(false), { color: dangerColor }), disabled: props.busy,
                onClick: function () { change('passwordRef', ''); setConfirmingClear(false) }
              }, '确认清除'),
              h('button', {
                type: 'button', style: buttonStyle(false), disabled: props.busy,
                onClick: function () { setConfirmingClear(false) }
              }, '取消'))))
        }
      }

      return h('div', { style: Object.assign(boxStyle(), { marginTop: '10px' }), onKeyDown: onKeyDown },
        h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } },
          props.previousName ? ('编辑 ' + props.previousName) : '新增主机'),
        h('div', { style: mutedWith({ marginBottom: '2px' }) }, 'Enter 保存，Esc 取消。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px', minWidth: 0 } }, fields),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px', minWidth: 0 } }, authBlock),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px', minWidth: 0 } },
          h(Field, {
            key: 'proxyJump', label: '跳板机（本清单里的名称，或 user@host:port）', value: d.proxyJump, error: errors.proxyJump,
            onChange: function (v) { change('proxyJump', v) }, placeholder: 'bastion'
          }),
          h(Field, {
            key: 'defaultWorkdir', label: '默认远端目录（绝对路径）', value: d.defaultWorkdir, error: errors.defaultWorkdir,
            onChange: function (v) { change('defaultWorkdir', v) }, placeholder: '/srv/app'
          }),
          h(Field, {
            key: 'tags', label: '标签（逗号分隔）', value: d.tags,
            onChange: function (v) { change('tags', v) }, placeholder: 'prod, web'
          })),
        h(Field, {
          label: '备注', value: d.description, error: errors.description,
          onChange: function (v) { change('description', v) }, placeholder: '生产 Web'
        }),
        h(Check, {
          label: '只读主机（拒绝写文件；这是给模型的护栏，不是沙箱）',
          value: d.readOnly, onChange: function (v) { change('readOnly', v) }
        }),
        props.formError ? h('div', {
          role: 'alert',
          style: { color: dangerColor, fontSize: '12px', margin: '6px 0', wordBreak: 'break-word' }
        }, props.formError) : null,
        h('div', { style: actionsStyle() },
          h('button', { style: buttonStyle(true), disabled: props.busy, onClick: props.onSave },
            props.busy ? '保存中…' : '保存'),
          h('button', { style: buttonStyle(false), disabled: props.busy, onClick: props.onCancel }, '取消')))
    }

    /** 单台主机：纵向堆叠的块（窄列友好），字段行自动换行 */
    function HostBlock(props) {
      var host = props.host
      var isDefault = props.isDefault
      var target = (host.user ? host.user + '@' : '') + host.host + (host.port && host.port !== 22 ? ':' + host.port : '')
      var details = []
      function detail(key, label, value, isCode) {
        if (value === undefined || value === null || String(value).length === 0) return
        details.push(h('div', { key: key, style: rowStyle() },
          h('span', { style: muted }, label),
          isCode ? h('code', { style: codeStyle() }, String(value)) : h('span', { style: { minWidth: 0 } }, String(value))))
      }
      detail('target', '地址', target)
      detail('key', '密钥', host.identityFile, true)
      detail('password', '密码', host.passwordRef
        ? (host.passwordConfigured ? ('已保存' + (host.passwordSource ? '（' + host.passwordSource + '）' : '')) : '未设置')
        : '', false)
      detail('workdir', '默认目录', host.defaultWorkdir, true)
      detail('tags', '标签', Array.isArray(host.tags) && host.tags.length > 0 ? host.tags.join(', ') : '')
      detail('note', '备注', host.description)
      if (host.via) detail('via', '跳板', host.via, true)

      var test = props.test
      var testColor = test && test.status === 'ok' ? okColor : test && test.status === 'fail' ? dangerColor : 'inherit'
      var testNode = test ? h('div', {
        key: 'testresult',
        role: 'status',
        style: {
          fontSize: '12px', marginTop: '4px', color: testColor, minWidth: 0,
          opacity: test.status === 'running' ? 0.72 : 1, wordBreak: 'break-word'
        }
      }, test.text) : null

      var actions = props.confirming
        ? h('div', {
          key: 'confirm',
          style: { border: '1px solid ' + dangerColor, borderRadius: '6px', padding: '6px 8px', marginTop: '8px', minWidth: 0 }
        },
          h('div', { style: mutedWith({ marginBottom: '4px' }) },
            '删除 ' + host.name + '？清单里会移除它' + (host.passwordRef ? '，已存密码也一并清除' : '') + '，且不可撤销。'),
          h('div', { style: rowStyle() },
            h('button', {
              style: Object.assign(buttonStyle(false), { color: dangerColor }), disabled: props.busy,
              onClick: function () { props.onConfirmRemove(host.name) }
            }, '确认删除'),
            h('button', { style: buttonStyle(false), disabled: props.busy, onClick: props.onCancelRemove }, '取消')))
        : h('div', { key: 'actions', style: actionsStyle() },
          h('button', { style: buttonStyle(false), disabled: props.busy, onClick: function () { props.onEdit(host) } }, '编辑'),
          h('button', { style: buttonStyle(false), disabled: props.busy, onClick: function () { props.onTest(host.name) } },
            props.busy ? '测试中…' : '测试连接'),
          h('button', {
            style: buttonStyle(false), disabled: props.busy || isDefault,
            onClick: function () { props.onDefault(host.name) }
          }, isDefault ? '已是默认' : '设为默认'),
          h('button', {
            style: Object.assign(buttonStyle(false), { color: dangerColor }),
            disabled: props.busy, onClick: function () { props.onRemove(host.name) }
          }, '删除'))

      return h('div', { style: Object.assign(boxStyle(), { marginTop: '8px' }) },
        h('div', { style: Object.assign(rowStyle(), { marginBottom: '4px' }) },
          h('span', { style: { fontWeight: 600, fontSize: '13px' } }, host.name),
          isDefault ? h('span', { style: badgeStyle('accent') }, '默认') : null,
          h('span', { style: badgeStyle() }, authLabel(host)),
          h('span', { style: badgeStyle() }, host.readOnly ? '只读' : '读写'),
          host.inUse === false ? h('span', { style: badgeStyle('danger') }, '未生效') : null),
        host.inUse === false
          ? h('div', { key: 'inuse', style: mutedWith({ color: warnColor, marginBottom: '2px' }) },
            '清单里有这台但加载失败（常见：密钥文件不存在或权限不是 0600、字段拼错）。修好后点「重新读取」。')
          : null,
        testNode,
        details.length > 0 ? h('div', null, details) : null,
        actions)
    }

    /** 「添加完怎么用」——用户最常问的一句话，直接印在界面上 */
    function UsageHint(props) {
      var name = props.name || '主机名'
      return h('div', { style: Object.assign(boxStyle(), { marginTop: '10px' }) },
        h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, '怎么用'),
        h('div', { style: mutedWith({ marginBottom: '4px' }) },
          '在会话里直接说「在 ' + name + ' 上执行 uname -a」，agent 就会调用这个插件；也可以让它显式调用工具：'),
        h('code', { style: Object.assign(codeStyle(), { display: 'block' }) },
          'ssh_hosts()  →  ssh_use({ host: "' + name + '" })  →  ssh_run({ command: "uname -a" })'),
        h('div', { style: mutedWith({ marginTop: '4px' }) },
          '工具：ssh_run 跑命令；ssh_read / ssh_write / ssh_edit / ssh_ls 读写远端文件。'
          + (props.hasDefault ? '已设默认主机，调用时可以省略 host。' : '没有默认主机时，每次调用都要带 host（或用 ssh_use 指定一次）。')),
        h('div', { style: mutedWith({ marginTop: '4px' }) },
          '换机器：点输入框左边的「+」，选「ssh」（或直接输入 /ssh ' + name + '）—— 它设的是本会话默认主机，' +
          '只影响这个会话；设置页里的「设为默认」是全局默认。'))
    }

    function Card() {
      var state = useState({ loading: true, error: null, data: null })
      var view = state[0]
      var setView = state[1]
      var editor = useState({ open: false, previousName: '', draft: emptyDraft() })
      var edit = editor[0]
      var setEdit = editor[1]
      var message = useState(null)
      var log = message[0]
      var setLog = message[1]
      var busyState = useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var queryState = useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var confirmState = useState('')
      var confirmName = confirmState[0]
      var setConfirmName = confirmState[1]
      var testStates = useState({})
      var tests = testStates[0]
      var setTests = testStates[1]
      var formState = useState(null)
      var form = formState[0]
      var setForm = formState[1]

      function load() {
        setView(function (prev) { return { loading: true, error: null, data: prev.data } })
        get('/hosts').then(function (data) {
          setView({ loading: false, error: null, data: data })
        }).catch(function (err) {
          setView({ loading: false, error: String(err && err.message || err), data: null })
        })
      }

      useEffect(function () { load() }, [])

      function closeEditor() {
        setEdit({ open: false, previousName: '', draft: emptyDraft() })
        setForm(null)
      }

      /** 通用动作：跑请求 → 成功回调 → 重载清单；失败落到日志 */
      function run(busyValue, promise, done) {
        setBusy(busyValue)
        setLog(null)
        return promise.then(function (value) {
          if (done) done(value)
          load()
        }).catch(function (err) {
          setLog({ kind: 'error', text: String(err && err.message || err) })
        }).finally(function () { setBusy(null) })
      }

      function openNew() {
        setEdit({ open: true, previousName: '', draft: emptyDraft() })
        setForm(null)
        setLog(null)
        setConfirmName('')
      }
      function openEdit(host) {
        setEdit({ open: true, previousName: host.name, draft: draftOf(host) })
        setForm(null)
        setLog(null)
        setConfirmName('')
      }

      function save() {
        var draft = edit.draft
        var hosts = (view.data && view.data.hosts) || []
        var previous = hosts.filter(function (host) { return host.name === edit.previousName })[0]
        var fields = validateDraft(draft, {
          existingNames: hosts.map(function (host) { return host.name }),
          previousName: edit.previousName,
          passwordConfigured: previous ? previous.passwordConfigured : undefined,
          passwordSupported: !view.data || view.data.passwordSupported !== false
        })
        var problems = Object.keys(fields)
        if (problems.length > 0) {
          setForm({ fields: fields, message: '还有 ' + problems.length + ' 处需要改一下（红框处）。' })
          return
        }
        setForm(null)
        var body = { host: payloadOf(draft) }
        if (edit.previousName) body.previousName = edit.previousName
        var hadPassword = Boolean(previous && previous.passwordRef)
        // 密码三态：填了 = 存入/替换；原本有、现在不要了 = 清除；其余 = 不动。
        var keepsPasswordRef = (draft.auth === 'password' || draft.auth === 'key+password') && draft.passwordRef !== ''
        if (draft.password.length > 0) body.password = draft.password
        else if (hadPassword && !keepsPasswordRef) body.clearPassword = true
        setBusy({ kind: 'save' })
        setLog(null)
        post('/hosts', body).then(function (value) {
          closeEditor()
          var extra = value.password === 'set' ? '（密码已存入凭据库）'
            : value.password === 'replaced' ? '（密码已更新）'
              : value.password === 'cleared' ? '（已存密码已清除）' : ''
          setLog({
            kind: 'ok',
            text: (value.action === 'added' ? '已新增 ' : '已更新 ') + value.name + '，当前共 ' + value.total + ' 台。' + extra
              + '\n引用方式：ssh_run({ host: "' + value.name + '", command: "uname -a" })，或直接说「在 ' + value.name + ' 上执行 uname -a」。'
          })
          load()
        }).catch(function (err) {
          // 保存失败留在表单里说，别丢到卡片底部让人找
          setForm({ fields: {}, message: String(err && err.message || err) })
        }).finally(function () { setBusy(null) })
      }

      function remove(name) {
        setConfirmName('')
        run({ kind: 'remove', name: name }, post('/hosts/delete', { name: name }), function (value) {
          if (edit.previousName === name) closeEditor()
          setLog({
            kind: 'ok',
            text: '已删除 ' + value.name + '，当前共 ' + value.total + ' 台。'
              + (value.clearedDefault ? '（默认主机已清除）' : '')
              + (value.clearedPassword ? '（已存密码一并清除）' : '')
          })
        })
      }

      function setDefault(name) {
        run({ kind: 'default', name: name }, post('/default', { name: name }), function (value) {
          setLog({ kind: 'ok', text: value.defaultHost ? ('默认主机已设为 ' + value.defaultHost) : '已清除默认主机' })
        })
      }

      /** 测试结果就地留在那台主机块里（失败原因也留在那儿），底部日志不再掺和 */
      function testHost(name) {
        setBusy({ kind: 'test', name: name })
        setLog(null)
        setTests(function (prev) {
          var next = Object.assign({}, prev)
          next[name] = { status: 'running', text: '正在测试连接…' }
          return next
        })
        post('/test', { name: name }).then(function (value) {
          var summary = value.ok
            ? '连接正常（' + value.durationMs + ' ms）' + (firstLine(value.stdout) ? '：' + firstLine(value.stdout) : '')
            : '连接失败（exit ' + value.exitCode + '）：' + firstLine(value.stderr || value.stdout, 160)
          setTests(function (prev) {
            var next = Object.assign({}, prev)
            next[name] = { status: value.ok ? 'ok' : 'fail', text: summary }
            return next
          })
          load()
        }).catch(function (err) {
          setTests(function (prev) {
            var next = Object.assign({}, prev)
            next[name] = { status: 'fail', text: '测试没跑起来：' + String(err && err.message || err) }
            return next
          })
        }).finally(function () { setBusy(null) })
      }

      var children = []
      children.push(h('div', { key: 'title', style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, TITLE))
      children.push(h('div', { key: 'blurb', style: mutedWith({ marginBottom: '10px' }) }, BLURB))

      if (view.loading && view.data === null) children.push(h('div', { key: 'loading', style: muted }, '读取主机清单…'))
      if (view.error) children.push(h('div', { key: 'err', role: 'alert', style: mutedWith({ color: dangerColor }) }, '读取失败：' + view.error))

      var data = view.data
      if (data) {
        var info = data.fileInfo || {}
        children.push(h('div', { key: 'file', style: mutedWith({ marginBottom: '8px' }) },
          '清单文件：', h('code', { style: codeStyle() }, data.file), info.mode ? ('（权限 ' + info.mode + '）') : '（尚未创建）',
          data.writable
            ? h('span', null, '　手工改过文件后点「重新读取」即可，不用重启。')
            : h('span', { style: { color: dangerColor } }, '　' + data.reason)))
        if (data.error) children.push(h('div', { key: 'stale', role: 'alert', style: mutedWith({ color: dangerColor }) }, '上次重载失败：' + data.error))

        if (data.hosts.length === 0) {
          children.push(h('div', { key: 'empty', style: boxStyle() },
            h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, '还没有主机'),
            h('div', { style: muted }, '最少只要两项：名称（agent 就用它引用这台机器）和地址。密码或密钥之后再补也行。'),
            h('div', { style: mutedWith({ marginTop: '4px' }) },
              '也可以直接手工编辑上面那个清单文件，改完点「重新读取」。'),
            data.writable
              ? h('div', { style: actionsStyle() },
                h('button', { key: 'new', style: buttonStyle(true), disabled: busy !== null, onClick: openNew }, '新增主机'))
              : null))
        } else {
          var filtered = filterHosts(data.hosts, query)
          if (data.hosts.length > 1) {
            children.push(h('div', { key: 'filter', style: { margin: '0 0 6px' } },
              h('input', {
                type: 'search', value: query, 'aria-label': '过滤主机',
                placeholder: '过滤：名称 / 地址 / 标签 / 备注', style: inputStyle(),
                onChange: function (e) { setQuery(e.target.value) }
              }),
              h('div', { style: mutedWith({ marginTop: '4px' }) },
                query.length > 0
                  ? ('匹配 ' + filtered.length + ' / ' + data.hosts.length + ' 台')
                  : ('共 ' + data.hosts.length + ' 台'))))
          }
          if (filtered.length === 0) {
            children.push(h('div', { key: 'nomatch', style: muted },
              '没有匹配「' + query + '」的主机。',
              h('button', {
                style: Object.assign(buttonStyle(false), { marginLeft: '6px' }),
                onClick: function () { setQuery('') }
              }, '清除过滤')))
          } else {
            children.push(h('div', { key: 'list' }, filtered.map(function (host) {
              return h(HostBlock, {
                key: host.name, host: host, busy: busy !== null,
                isDefault: data.defaultHost === host.name,
                test: tests[host.name],
                confirming: confirmName === host.name,
                onEdit: openEdit, onRemove: setConfirmName, onConfirmRemove: remove, onCancelRemove: function () { setConfirmName('') },
                onDefault: setDefault, onTest: testHost
              })
            })))
          }
          if (data.defaultHost) {
            children.push(h('div', { key: 'def', style: mutedWith({ marginTop: '6px' }) },
              '默认主机：' + data.defaultHost + '（调用 ssh_* 时可以省略 host）'))
          } else if (data.configuredDefaultHost) {
            children.push(h('div', { key: 'def', style: mutedWith({ marginTop: '6px' }) },
              '默认主机来自插件 config：' + data.configuredDefaultHost))
          } else {
            children.push(h('div', { key: 'def', style: mutedWith({ marginTop: '6px' }) },
              '没有默认主机：每次调用都要显式给 host，或用 ssh_use 指定。'))
          }
          children.push(h(UsageHint, {
            key: 'usage',
            name: data.defaultHost || data.hosts[0].name,
            hasDefault: Boolean(data.defaultHost)
          }))
        }

        if (data.passwordSupported === false) {
          children.push(h('div', { key: 'nopw', style: mutedWith({ marginTop: '8px' }) },
            '当前 profile 没有 credentials 服务：密码登录不可用，请用密钥或 ssh-agent。'))
        }

        if (edit.open) {
          children.push(h(HostEditor, {
            key: 'editor', draft: edit.draft, previousName: edit.previousName, busy: busy !== null,
            passwordSupported: data.passwordSupported !== false,
            errors: (form && form.fields) || {},
            formError: form ? form.message : null,
            existing: data.hosts.filter(function (host) { return host.name === edit.previousName })[0] || {},
            setDraft: function (updater) {
              setEdit(function (prev) {
                var draft = typeof updater === 'function' ? updater(prev.draft) : updater
                return { open: prev.open, previousName: prev.previousName, draft: draft }
              })
            },
            onSave: save,
            onCancel: closeEditor
          }))
        }

        var actions = []
        if (data.writable && !edit.open && data.hosts.length > 0) {
          actions.push(h('button', { key: 'new', style: buttonStyle(true), disabled: busy !== null, onClick: openNew }, '新增主机'))
        }
        actions.push(h('button', {
          key: 'reload', style: buttonStyle(false), disabled: busy !== null,
          onClick: function () {
            run({ kind: 'reload' }, post('/reload'), function (value) {
              setLog(value.ok
                ? { kind: 'ok', text: '已重新读取：' + value.hosts + ' 台主机' }
                : { kind: 'error', text: '重新读取失败：' + value.error })
            })
          }
        }, '重新读取'))
        children.push(h('div', { key: 'actions', style: Object.assign(actionsStyle(), { marginTop: '12px' }) }, actions))
      }

      if (busy) children.push(h('div', { key: 'busy', role: 'status', style: mutedWith({ marginTop: '8px' }) }, busyText(busy)))
      if (log) {
        children.push(h('div', {
          key: 'log',
          role: log.kind === 'error' ? 'alert' : 'status',
          'aria-live': 'polite',
          style: {
            marginTop: '8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', minWidth: 0,
            color: log.kind === 'error' ? dangerColor : 'inherit', opacity: log.kind === 'error' ? 1 : 0.8
          }
        }, log.text))
      }
      return h('div', { style: rootStyle }, children)
    }

    /** 主机的一行人类可读描述（选择弹窗用，短） */
    function hostDetail(host) {
      var user = typeof host.user === 'string' && host.user.length > 0 ? host.user + '@' : ''
      var port = Number(host.port) > 0 && Number(host.port) !== 22 ? ':' + host.port : ''
      var parts = [user + host.host + port]
      if (Array.isArray(host.tags) && host.tags.length > 0) parts.push(host.tags.join('/'))
      parts.push(authLabel(host))
      return parts.join(' · ')
    }

    /**
     * 会话窗口「+」菜单里点开 /ssh 后看到的主机列表。
     * 带上 sessionId 是为了让接口回报「本会话当前在用哪台」，好在列表里标出来。
     */
    function hostOptions(session) {
      var id = session && session.sessionId !== undefined ? String(session.sessionId) : ''
      var path = id.length > 0 ? '/hosts?sessionId=' + encodeURIComponent(id) : '/hosts'
      return get(path).then(function (view) {
        var active = view.sessionDefaultHost || view.defaultHost || ''
        var hosts = view.hosts || []
        if (hosts.length === 0) {
          throw new Error('还没有配置主机：请先到 设置 → SSH 主机 里新增一台')
        }
        return hosts.map(function (host) {
          var current = host.name === active
          return {
            id: host.name,
            label: host.name + (host.readOnly === true ? '（只读）' : ''),
            detail: hostDetail(host) + (current ? ' · 本会话在用' : ''),
            active: current
          }
        })
      })
    }

    /**
     * 选中一台主机 = 提交 `/ssh <主机名>`：会话作用域的状态由 host 侧命令写，
     * 与 ssh_use 工具走的是同一条路径（所以两边永远一致）。
     */
    async function pickHost(sessions, option, session) {
      var binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(session.sessionId) : undefined
      var live = binding && binding.session
      if (live === undefined || typeof live.command !== 'function') {
        throw new Error('这个会话还没就绪，稍后再试')
      }
      var result = await live.command('/ssh ' + option.id)
      if (!result || result.ok !== true) {
        var detail = result && result.error ? result.error.code + ': ' + result.error.message : '未知错误'
        throw new Error('设置默认主机失败（' + detail + '）')
      }
      if (!result.value || result.value.matched !== true) {
        throw new Error('当前会话没有 /ssh 命令：请重启桌面应用以加载最新插件')
      }
    }

    function apply(ctx) {
      // 两处落点：插件页（bundle 自己的配置，key 就是包名）与设置侧栏（独立分区）。
      // slots.inject 等声明出现才注册，所以宿主没有这个槽时什么也不会发生。
      try {
        ctx.effect(function () {
          return ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register({
              name: 'plugins.bundle.config',
              key: 'dsh-ssh-hosts',
              inject: function () { return {} }
            }, function BundleConfigSlot() {
              return h(Card, {})
            })
          })
        }, 'ssh-hosts: plugin page card')
      } catch (err) {
        try { console.error('[ssh-hosts] 注册插件页配置失败', err) } catch (e) { /* ignore */ }
      }

      // 会话窗口的「+」命令菜单：/ssh 这一行由 host 侧注册（lib/command.js），
      // 这里给它挂一个主机选择弹窗 —— 与官方 /permission 完全同一套 seam。
      // commandUi / sessions 缺失时什么也不做，卡片与工具照常工作。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi', 'sessions'], function (scope) {
            scope.effect(function () {
              return scope.commandUi.decorate({
                name: 'ssh',
                // 子代理会话（addressed subagent）没有独立的命令通道：与其让人点了才报错，
                // 不如这一行干脆不出现。
                available: function (session) {
                  var sessions = scope.sessions
                  if (session && sessions && typeof sessions.subagentAddress === 'function') {
                    return sessions.subagentAddress(session.sessionId) === undefined
                  }
                  return true
                },
                ui: {
                  kind: 'popupSelect',
                  options: hostOptions,
                  onSelect: function (option, session) { return pickHost(scope.sessions, option, session) }
                }
              })
            }, 'ssh-hosts: /ssh host picker')
          })
        }
      } catch (err) {
        try { console.error('[ssh-hosts] 注册 /ssh 选择器失败', err) } catch (e) { /* ignore */ }
      }

      try {
        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'ssh-hosts',
              order: 55,
              label: function () { return TITLE },
              inject: function () { return {} }
            }, function SettingsSectionSlot() {
              return h(Card, {})
            })
          })
        }, 'ssh-hosts: settings section')
      } catch (err) {
        try { console.error('[ssh-hosts] 注册设置分区失败', err) } catch (e) { /* ignore */ }
      }
    }

    // 宿主只读 inject / apply / name；__test 是给单测直接渲染子组件与验证
    // 草稿转换用的（这一层没有构建步骤，也没法在测试里点按钮）。
    module.exports = {
      inject: ['slots'],
      apply: apply,
      name: 'ssh-hosts',
      __test: {
        Card: Card,
        HostEditor: HostEditor,
        HostBlock: HostBlock,
        UsageHint: UsageHint,
        Field: Field,
        draftOf: draftOf,
        payloadOf: payloadOf,
        emptyDraft: emptyDraft,
        authLabel: authLabel,
        validateDraft: validateDraft,
        filterHosts: filterHosts,
        busyText: busyText,
        firstLine: firstLine,
        hostOptions: hostOptions,
        hostDetail: hostDetail,
        pickHost: pickHost
      }
    }
    return module.exports
  }
})
