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
 * 布局约束：这个卡片会被塞进设置侧栏那种很窄的列里，所以
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

    var border = '1px solid var(--dsw-border, #d0d0d0)'
    var muted = { fontSize: '12px', opacity: 0.72 }
    var dangerColor = 'var(--dsw-danger, #d33)'
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
    function badgeStyle() {
      return {
        fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: border,
        opacity: 0.8, whiteSpace: 'nowrap'
      }
    }

    /** 认证方式的显示名（与 lib/hosts.js 的 authModeOf 对齐） */
    function authLabel(host) {
      if (host.passwordRef && host.identityFile) return '密钥 + 密码'
      if (host.passwordRef) return '密码'
      if (host.identityFile) return '密钥'
      return 'ssh-agent'
    }

    function Field(props) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0', minWidth: 0 } },
        h('span', { style: muted }, props.label),
        h('input', {
          type: props.type || 'text',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          autoComplete: props.autoComplete || 'off',
          style: inputStyle(),
          onChange: function (e) { props.onChange(e.target.value) }
        }),
        props.hint ? h('span', { style: muted }, props.hint) : null)
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

    function HostEditor(props) {
      var d = props.draft
      var set = props.setDraft
      var existing = props.existing || {}
      function change(key, value) {
        set(function (prev) { var next = Object.assign({}, prev); next[key] = value; return next })
      }
      var usesKey = d.auth === 'key' || d.auth === 'key+password'
      var usesPassword = d.auth === 'password' || d.auth === 'key+password'
      var passwordSaved = Boolean(d.passwordRef) && existing.passwordConfigured !== false

      var fields = [
        h(Field, { key: 'name', label: '名称（agent 用这个名字引用）', value: d.name, onChange: function (v) { change('name', v) }, placeholder: 'web-01' }),
        h(Field, { key: 'host', label: '地址 / IP', value: d.host, onChange: function (v) { change('host', v) }, placeholder: '10.0.0.11' }),
        h(Field, { key: 'port', label: '端口（默认 22）', value: d.port, onChange: function (v) { change('port', v) }, placeholder: '22' }),
        h(Field, { key: 'user', label: '登录用户', value: d.user, onChange: function (v) { change('user', v) }, placeholder: 'deploy' })
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
          key: 'identityFile', label: '私钥路径（可写 ~，权限必须 0600）', value: d.identityFile,
          onChange: function (v) { change('identityFile', v) }, placeholder: '~/.ssh/id_ed25519'
        }))
      }
      if (usesPassword) {
        authBlock.push(h(Field, {
          key: 'password', label: '密码', type: 'password', value: d.password,
          autoComplete: 'new-password',
          placeholder: passwordSaved ? '已保存，留空则不改动' : '登录密码',
          onChange: function (v) { change('password', v) },
          hint: props.passwordSupported
            ? '密码存进 DSH 凭据库（$DSH_HOME/.credentials.yaml，0600），清单里只留一个引用名；界面不回显已存的密码。'
            : '当前 profile 没有凭据服务，密码存不下来：请改用密钥或 ssh-agent。'
        }))
        if (passwordSaved) {
          authBlock.push(h('div', { key: 'clearpw', style: rowStyle() },
            h('button', {
              style: buttonStyle(false), disabled: props.busy,
              onClick: function () { change('passwordRef', '') }
            }, '清除已存密码'),
            h('span', { style: muted }, existing.passwordConfigured
              ? ('当前：已保存' + (existing.passwordSource ? '（来源 ' + existing.passwordSource + '）' : ''))
              : '当前：未设置')))
        }
      }

      return h('div', { style: Object.assign(boxStyle(), { marginTop: '10px' }) },
        h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } },
          props.previousName ? ('编辑 ' + props.previousName) : '新增主机'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px', minWidth: 0 } }, fields),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px', minWidth: 0 } }, authBlock),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px', minWidth: 0 } },
          h(Field, {
            key: 'proxyJump', label: '跳板机（本清单里的名称，或 user@host:port）', value: d.proxyJump,
            onChange: function (v) { change('proxyJump', v) }, placeholder: 'bastion'
          }),
          h(Field, {
            key: 'defaultWorkdir', label: '默认远端目录（绝对路径）', value: d.defaultWorkdir,
            onChange: function (v) { change('defaultWorkdir', v) }, placeholder: '/srv/app'
          }),
          h(Field, {
            key: 'tags', label: '标签（逗号分隔）', value: d.tags,
            onChange: function (v) { change('tags', v) }, placeholder: 'prod, web'
          })),
        h(Field, {
          label: '备注', value: d.description,
          onChange: function (v) { change('description', v) }, placeholder: '生产 Web'
        }),
        h(Check, {
          label: '只读主机（拒绝写文件；这是给模型的护栏，不是沙箱）',
          value: d.readOnly, onChange: function (v) { change('readOnly', v) }
        }),
        h('div', { style: actionsStyle() },
          h('button', { style: buttonStyle(true), disabled: props.busy, onClick: props.onSave }, '保存'),
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

      return h('div', { style: Object.assign(boxStyle(), { marginTop: '8px' }) },
        h('div', { style: Object.assign(rowStyle(), { marginBottom: '4px' }) },
          h('span', { style: { fontWeight: 600, fontSize: '13px' } }, host.name),
          isDefault ? h('span', { style: badgeStyle() }, '默认') : null,
          h('span', { style: badgeStyle() }, authLabel(host)),
          h('span', { style: badgeStyle() }, host.readOnly ? '只读' : '读写'),
          host.inUse === false ? h('span', { style: badgeStyle() }, '未生效') : null),
        details.length > 0 ? h('div', null, details) : null,
        h('div', { style: actionsStyle() },
          h('button', { style: buttonStyle(false), disabled: props.busy, onClick: function () { props.onEdit(host) } }, '编辑'),
          h('button', { style: buttonStyle(false), disabled: props.busy, onClick: function () { props.onTest(host.name) } }, '测试'),
          h('button', { style: buttonStyle(false), disabled: props.busy || isDefault, onClick: function () { props.onDefault(host.name) } }, '设为默认'),
          h('button', {
            style: Object.assign(buttonStyle(false), { color: dangerColor }),
            disabled: props.busy, onClick: function () { props.onRemove(host.name) }
          }, '删除')))
    }

    /** 「添加完怎么用」——用户最常问的一句话，直接印在界面上 */
    function UsageHint(props) {
      var name = props.name || '主机名'
      return h('div', { style: Object.assign(boxStyle(), { marginTop: '10px' }) },
        h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, '怎么用'),
        h('div', { style: Object.assign(muted, { marginBottom: '4px' }) },
          '在会话里直接说「在 ' + name + ' 上执行 uname -a」，agent 就会调用这个插件；也可以让它显式调用工具：'),
        h('code', { style: Object.assign(codeStyle(), { display: 'block' }) },
          'ssh_hosts()  →  ssh_use({ host: "' + name + '" })  →  ssh_run({ command: "uname -a" })'),
        h('div', { style: Object.assign(muted, { marginTop: '4px' }) },
          '工具：ssh_run 跑命令；ssh_read / ssh_write / ssh_edit / ssh_ls 读写远端文件。'
          + (props.hasDefault ? '已设默认主机，调用时可以省略 host。' : '没有默认主机时，每次调用都要带 host（或用 ssh_use 指定一次）。')),
        h('div', { style: Object.assign(muted, { marginTop: '4px' }) },
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

      function load() {
        setView(function (prev) { return { loading: true, error: null, data: prev.data } })
        get('/hosts').then(function (data) {
          setView({ loading: false, error: null, data: data })
        }).catch(function (err) {
          setView({ loading: false, error: String(err && err.message || err), data: null })
        })
      }

      useEffect(function () { load() }, [])

      function run(label, promise, done) {
        setBusy(label)
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
        setLog(null)
      }
      function openEdit(host) {
        setEdit({ open: true, previousName: host.name, draft: draftOf(host) })
        setLog(null)
      }
      function save() {
        var draft = edit.draft
        if (draft.name.trim().length === 0 || draft.host.trim().length === 0) {
          setLog({ kind: 'error', text: '名称和地址是必填的。' })
          return
        }
        var body = { host: payloadOf(draft) }
        if (edit.previousName) body.previousName = edit.previousName
        var previous = ((view.data && view.data.hosts) || []).filter(function (host) {
          return host.name === edit.previousName
        })[0]
        var hadPassword = Boolean(previous && previous.passwordRef)
        // 密码三态：填了 = 存入/替换；原本有、现在不要了 = 清除；其余 = 不动。
        var keepsPasswordRef = (draft.auth === 'password' || draft.auth === 'key+password') && draft.passwordRef !== ''
        if (draft.password.length > 0) body.password = draft.password
        else if (hadPassword && !keepsPasswordRef) body.clearPassword = true
        run('save', post('/hosts', body), function (value) {
          setEdit({ open: false, previousName: '', draft: emptyDraft() })
          var extra = value.password === 'set' ? '（密码已存入凭据库）'
            : value.password === 'replaced' ? '（密码已更新）'
              : value.password === 'cleared' ? '（已存密码已清除）' : ''
          setLog({
            kind: 'ok',
            text: (value.action === 'added' ? '已新增 ' : '已更新 ') + value.name + '，当前共 ' + value.total + ' 台。' + extra
              + '\n引用方式：ssh_run({ host: "' + value.name + '", command: "uname -a" })，或直接说「在 ' + value.name + ' 上执行 uname -a」。'
          })
        })
      }
      function remove(name) {
        run('remove', post('/hosts/delete', { name: name }), function (value) {
          if (edit.previousName === name) setEdit({ open: false, previousName: '', draft: emptyDraft() })
          setLog({
            kind: 'ok',
            text: '已删除 ' + value.name + '，当前共 ' + value.total + ' 台。'
              + (value.clearedDefault ? '（默认主机已清除）' : '')
              + (value.clearedPassword ? '（已存密码一并清除）' : '')
          })
        })
      }
      function setDefault(name) {
        run('default', post('/default', { name: name }), function (value) {
          setLog({ kind: 'ok', text: value.defaultHost ? ('默认主机已设为 ' + value.defaultHost) : '已清除默认主机' })
        })
      }
      function test(name) {
        run('test', post('/test', { name: name }), function (value) {
          setLog(value.ok
            ? { kind: 'ok', text: name + ' 连接正常（' + value.durationMs + ' ms）：\n' + value.stdout }
            : { kind: 'error', text: name + ' 命令退出码 ' + value.exitCode + '：\n' + (value.stderr || value.stdout) })
        })
      }

      var children = []
      children.push(h('div', { key: 'title', style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, TITLE))
      children.push(h('div', { key: 'blurb', style: Object.assign(muted, { marginBottom: '10px' }) }, BLURB))

      if (view.loading && view.data === null) children.push(h('div', { key: 'loading', style: muted }, '读取主机清单…'))
      if (view.error) children.push(h('div', { key: 'err', style: Object.assign(muted, { color: dangerColor }) }, '读取失败：' + view.error))

      var data = view.data
      if (data) {
        var info = data.fileInfo || {}
        children.push(h('div', { key: 'file', style: Object.assign(muted, { marginBottom: '8px' }) },
          '清单文件：', h('code', { style: codeStyle() }, data.file), info.mode ? ('（权限 ' + info.mode + '）') : '（尚未创建）',
          data.writable
            ? h('span', null, '　手工改过文件后点「重新读取」即可，不用重启。')
            : h('span', { style: { color: dangerColor } }, '　' + data.reason)))
        if (data.error) children.push(h('div', { key: 'stale', style: Object.assign(muted, { color: dangerColor }) }, '上次重载失败：' + data.error))

        if (data.hosts.length === 0) {
          children.push(h('div', { key: 'empty', style: muted }, '还没有任何主机。点下面的「新增主机」开始。'))
        } else {
          children.push(h('div', { key: 'list' }, data.hosts.map(function (host) {
            return h(HostBlock, {
              key: host.name, host: host, busy: busy !== null,
              isDefault: data.defaultHost === host.name,
              onEdit: openEdit, onRemove: remove, onDefault: setDefault, onTest: test
            })
          })))
          if (data.defaultHost) {
            children.push(h('div', { key: 'def', style: Object.assign(muted, { marginTop: '6px' }) },
              '默认主机：' + data.defaultHost + '（调用 ssh_* 时可以省略 host）'))
          } else if (data.configuredDefaultHost) {
            children.push(h('div', { key: 'def', style: Object.assign(muted, { marginTop: '6px' }) },
              '默认主机来自插件 config：' + data.configuredDefaultHost))
          } else {
            children.push(h('div', { key: 'def', style: Object.assign(muted, { marginTop: '6px' }) },
              '没有默认主机：每次调用都要显式给 host，或用 ssh_use 指定。'))
          }
          children.push(h(UsageHint, {
            key: 'usage',
            name: data.defaultHost || data.hosts[0].name,
            hasDefault: Boolean(data.defaultHost)
          }))
        }

        if (data.passwordSupported === false) {
          children.push(h('div', { key: 'nopw', style: Object.assign(muted, { marginTop: '8px' }) },
            '当前 profile 没有 credentials 服务：密码登录不可用，请用密钥或 ssh-agent。'))
        }

        if (edit.open) {
          children.push(h(HostEditor, {
            key: 'editor', draft: edit.draft, previousName: edit.previousName, busy: busy !== null,
            passwordSupported: data.passwordSupported !== false,
            existing: data.hosts.filter(function (host) { return host.name === edit.previousName })[0] || {},
            setDraft: function (updater) {
              setEdit(function (prev) {
                var draft = typeof updater === 'function' ? updater(prev.draft) : updater
                return { open: prev.open, previousName: prev.previousName, draft: draft }
              })
            },
            onSave: save,
            onCancel: function () { setEdit({ open: false, previousName: '', draft: emptyDraft() }) }
          }))
        }

        var actions = []
        if (data.writable && !edit.open) {
          actions.push(h('button', { key: 'new', style: buttonStyle(true), disabled: busy !== null, onClick: openNew }, '新增主机'))
        }
        actions.push(h('button', {
          key: 'reload', style: buttonStyle(false), disabled: busy !== null,
          onClick: function () { run('reload', post('/reload'), function (value) {
            setLog(value.ok
              ? { kind: 'ok', text: '已重新读取：' + value.hosts + ' 台主机' }
              : { kind: 'error', text: '重新读取失败：' + value.error })
          }) }
        }, '重新读取'))
        children.push(h('div', { key: 'actions', style: Object.assign(actionsStyle(), { marginTop: '12px' }) }, actions))
      }

      if (busy) children.push(h('div', { key: 'busy', style: Object.assign(muted, { marginTop: '8px' }) }, '执行中：' + busy + '…'))
      if (log) {
        children.push(h('div', {
          key: 'log',
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
        draftOf: draftOf,
        payloadOf: payloadOf,
        emptyDraft: emptyDraft,
        authLabel: authLabel,
        hostOptions: hostOptions,
        hostDetail: hostDetail,
        pickHost: pickHost
      }
    }
    return module.exports
  }
})
