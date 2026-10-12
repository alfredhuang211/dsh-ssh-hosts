# dsh-ssh-hosts 方案

> 一句话：做**一个** DSH 插件包 `dsh-ssh-hosts`，把「若干台服务器」变成一份可保存的主机清单 + 一组模型可见工具（`ssh_hosts` / `ssh_run` / `ssh_read` / `ssh_write` / `ssh_edit` / `ssh_ls`），在任意 agent 会话里用 `host` 名字引用，桌面应用和 CLI 共用同一份产物。

状态：已实现并通过验收（见 §11 界面管理、§12 验收记录）；只剩「桌面 App 里卡片真实渲染」需要你在 GUI 上确认。已确认的四个前提：
1. 能力粒度 = **多机命令 + 远端文件读写**（不做官方 `dsh-ssh` 那套「整个执行世界」替换）。
2. 凭据 = **插件配置里存 host/user/密钥路径**（不依赖 `~/.ssh/config`，密码暂不入库）。
3. 引用方式 = **显式 `host` 参数 + 可选会话默认主机**。
4. 落地 = **桌面应用 + CLI 都要**，一个标准 npm 包（带 `dsh.bundle.patch`）。

---

## 1. 目标与非目标

**目标**

- 一份受保护的配置文件保存 N 台服务器的连接信息（别名、地址、端口、用户、私钥路径、跳板、默认目录、标签、备注）。
- agent 在会话中先 `ssh_hosts` 看到可用机器，再用 `ssh_run` / `ssh_read` / `ssh_write` / `ssh_edit` / `ssh_ls` 以 `host` 名字操作远端。
- 同一会话可引用多台；也支持`ssh_use` 设一个会话默认主机省 token。
- 所有调用走 DSH 既有工具管线：参数校验、审批策略、结果进 session log（模型可见 ⟺ 已记录）。
- 桌面 Plugins 页可安装/启停；CLI profile `pnpm add` 后用同一行 patch 生效。

**非目标（明确不做，留给别的方案）**

- 不替换 `ctx.fs` / `ctx.subprocess` / `ctx.sandbox`（那是官方 `dsh-ssh` 家族，一台机器一个实例，见 §2）。
- 不做密码入库、不做交互式认证；v1 只支持密钥/ssh-agent。
- 不做持久会话重连与操作重放（断连即失败，如实报告）。
- 不做多跳批量编排、端口转发、SFTP 目录镜像（v2 再评估）。
- Windows 只要求「本机有 OpenSSH 客户端」（Win10+ 自带）；远端仍假定 POSIX。

---

## 2. 为什么是这个形态

| 方案 | 多服务器 | 会话内引用 | 需要什么 | 结论 |
|---|---|---|---|---|
| 官方 `dsh-ssh` + `fs-ssh` + `subprocess-ssh` + `sandbox-ssh` | ✗ 一个实例/组合只能一台（`ctx.fs`/`ctx.subprocess`/`ctx.sandbox` 是单例） | ✗ | 自定义 profile、远端 helper、SHA-256 固定、摘要校验 | 作为**沉浸模式**保留：真的想「整台机器给 agent」时用 |
| 社区 MCP SSH server + `dsh-mcp-client` | ✓（每个 server 一个条目） | △ 工具名 `mcp__<server>__*`，无统一语义 | 依赖第三方实现的正确性与维护 | 零代码兜底，可先跑通体验 |
| **本方案：自研工具插件** | ✓ | ✓ | 一个 npm 包 + 一行 patch | **主方案** |

理由：你的诉求是「若干台 + 可保存登录信息 + 会话内引用」，本质是**资源引用问题**，不是执行世界替换问题。工具插件能精确表达「给哪台机器、做什么」，且不改变本地文件系统语义，桌面 GUI 不会出现「工作区视图对不上远端」的问题。

**产物形态**（对齐你已有的 `plugin-dev/webdav-sync` 工程结构）

```
ssh-hosts/
  package.json          # name: dsh-ssh-hosts, dsh.bundle.patch, engines.dsh, peerDeps
  cordis.patch.yml      # 一行 insert
  lib/index.js          # host 插件入口（注册工具 + 会话默认主机）
  lib/config.js         # Config schema（schemastery）+ 脱敏
  lib/hosts.js          # ssh-hosts.yaml 读取/校验/0600 检查
  lib/exec.js           # OpenSSH 调用层（exec / sftp 批量）
  lib/tools.js          # defineTool 定义
  locale/{en,zh}.json   # Plugins 页显示元数据
  icon.svg
  test/*.test.mjs       # node --test
  dist/dsh-ssh-hosts-<v>.tgz
```

`dsh.bundle.patch` 让它在桌面 **Plugins** 页是可安装/可切换的 bundle（官方 `OPTIONAL_BUNDLES` 之外的用户 bundle 走安装路径，不占官方白名单位）。

---

## 3. 配置设计

### 3.1 插件 Config（profile 的 `cordis.patch.yml` 里那一行）

```yaml
- insert:
    - id: ssh-hosts
      name: 'dsh-ssh-hosts'
      config:
        hostsFile: ''            # 空 = $DSH_HOME/ssh-hosts.yaml
        defaultHost: ''          # 空 = 无默认，必须显式传 host
        timeoutMs: 60000         # 单条命令默认超时
        maxOutputBytes: 262144   # stdout/stderr 各自截断上限（超出保尾并标记）
        maxReadBytes: 8388608    # 单文件读取上限
        controlPersistSec: 300   # OpenSSH 连接复用保持时间；0 = 关闭复用
        hosts: []                # 也可就地写主机数组（优先级高于 hostsFile）
```

`Config` 顶层用 `.volatile()` 暴露可写字段（否则设置页保存会报 `no volatile fields`；这是你 webdav 插件踩过的点）。

### 3.2 主机清单 `$DSH_HOME/ssh-hosts.yaml`（默认，0600）

```yaml
version: 1
hosts:
  - name: web-01                 # 会话里引用的唯一键；[a-z0-9][a-z0-9._-]*
    host: 10.0.0.11              # 域名或 IP
    port: 22
    user: deploy
    identityFile: ~/.ssh/id_ed25519   # 支持 ~ 展开；不写则交给 ssh-agent/默认密钥
    proxyJump: bastion           # 可选，跳板（可引用同清单里的另一台 name）
    defaultWorkdir: /srv/app     # 可选，ssh_run 未传 cwd 时使用
    description: 生产 Web 前端    # 给模型看的一行说明
    tags: [prod, web]            # 给模型筛选用
    connectTimeoutSec: 10
    keepAliveSec: 30
    readOnly: false              # true = 只允许读类操作（run 的写命令仍由审批/策略把关，见 §6）
```

**校验规则**：`name` 唯一且符合字符集；`host` 非空；`port` 1–65535；`identityFile` 展开后必须存在且**权限 0600**（否则启动即报错并给出修复命令）；`proxyJump` 必须能解析；未知字段报错而不是静默忽略（`additionalProperties: false` 风格）。

**加载顺序**：`Config.hosts` 非空 → 用它；否则读 `hostsFile`；两者都为空 → 插件照常启动但工具只返回「未配置主机」提示，不阻断宿主启动。

### 3.3 凭据边界

- 清单里**只有路径，没有秘密**。密钥内容、passphrase、ssh-agent 全部留给 OpenSSH。
- `identityFile` 与 `proxyJump` **不进模型可见输出**（`ssh_hosts` 只回 name/host/user/port/tags/description/defaultWorkdir）。
- v1 不支持密码：`dsh-ssh` 官方同样强制 `BatchMode`；密码会带来「存哪里、怎么脱敏、怎么轮换」一整套问题。
- 需要密码时留一个后端开关 `authBackend: 'openssh' | 'ssh2'`，`ssh2` 后端（纯 JS）可用 `agent`/`password`，届时密码走 macOS Keychain，不落 YAML。**这是 v2 的显式扩展点，不在 v1 实现。**

---

## 4. 工具契约（模型可见）

全部用 `defineTool`（`@deepseek-ai/dsh-tools`），`inject = ['tools']`。每个结果都回显 `host`，避免模型记混。

| 工具 | 关键参数 | 返回（canonical value） | 说明 |
|---|---|---|---|
| `ssh_hosts` | `tag?`（按标签过滤） | `{ hosts: [{ name, user, host, port, tags, description, defaultWorkdir, readOnly }] }` | 永远不含密钥路径；空清单时给配置指引 |
| `ssh_use` | `host?` | `{ host, scope: 'session' \| 'default' }` | 不传 = 查询当前生效主机；传 `host` = 设本会话默认 |
| `ssh_run` | `host?`, `command`(必填), `cwd?`, `timeoutMs?`, `stdin?` | `{ host, exitCode, stdout, stderr, truncated, durationMs }` | `command` 交给远端 shell 执行；非零退出是**成功结果**，不是抛错 |
| `ssh_read` | `host?`, `path`(必填), `offset?`, `limit?` | `{ host, path, content, bytes, truncated }` | 文本读取；超 `maxReadBytes` 拒绝并提示分片 |
| `ssh_write` | `host?`, `path`, `content` | `{ host, path, bytes, created }` | 远端先写临时文件再 `rename`，保证原子替换 |
| `ssh_edit` | `host?`, `path`, `oldString`, `newString`, `replaceAll?` | `{ host, path, replacements }` | 与本地 `edit` 同语义：`oldString` 必须唯一（除非 `replaceAll`）；不唯一即失败且不改文件 |
| `ssh_ls` | `host?`, `path`, `long?` | `{ host, path, entries: [{ name, type, size, mode, mtime }] }` | 目录列举 |

约定：
- `host` 省略时用「会话默认主机」，再退到 `Config.defaultHost`；都没有就**报错并列出可用主机**，绝不猜。
- 所有输出走 `output.schema` + `output.render`，不把 JSON 塞进散文。
- 抛错只用于基础设施失败（连不上、超时、认证失败、文件不存在），业务性非零退出/内容不匹配属于正常返回值。
- 语义与本地同名工具对齐（`read` 的 offset/limit、`edit` 的唯一性规则），模型已有先验，无需额外学习成本。

---

## 5. 会话内引用语义

优先级（高 → 低）：显式 `host` 参数 → 本会话 `ssh_use` → `Config.defaultHost`。

会话默认主机持久化在 `$DSH_HOME/ssh-hosts.state.json`（0600）：

```json
{ "version": 1, "sessions": { "<sessionId>": { "host": "web-01", "at": "2026-10-10T03:20:00Z" } } }
```

- 键取 `exec.agent.session.header.id`（工具执行上下文里可得）。
- 文件带版本号，未知版本自动忽略而不是崩。
- 只存主机名，不存任何凭据；会话恢复后默认主机仍在（这是不用进程内 Map 的原因）。
- 多台并行：同一会话里不同调用各带自己的 `host` 即可，无全局锁。

---

## 6. 传输、安全与审计

**传输（默认 OpenSSH 客户端，零 JS 依赖）**

- 每次调用拼一条 `ssh` 命令：`-o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=N -o ServerAliveInterval=N -p PORT [-i KEY] [-J JUMP] [-o ControlMaster=auto -o ControlPath=<私有目录>/%C -o ControlPersist=300] user@host -- <command>`。
- 连接复用目录：`$TMPDIR/dsh-ssh-hosts-<uid>/`（0700，socket 0600），进程退出/插件卸载时清理。
- 文件读写走 OpenSSH `sftp -b -` 批量模式：`read` = `get` 到 0600 临时文件再读；`write` = `put` 到 `<path>.dsh-tmp-<rand>` 后 `rename`；临时文件用后即删，异常路径也走 finally。
- 超时用 `AbortSignal`（`exec.signal` 联动）：到点杀进程树，返回 `timedOut` 错误，不重试。
- 输出：stdout/stderr 各自限流到 `maxOutputBytes`，超出保留**尾部**并置 `truncated: true`（与本地 Bash 工具一致的“保尾”策略）。
- 断连语义：连接丢失即失败；**不自动重连、不重放**，因为无法确认远端是否已执行（与官方 SSH 提供方同一原则）。

**安全边界（写进 README，避免误解）**

- `ssh-hosts.yaml` 与 state 文件 0600；权限不对时插件**拒绝加载**并打印修复命令，而不是继续跑。
- 密钥路径、passphrase、`ssh-agent` 内容不进模型上下文、不进 session log 的参数。
- 命令与结果本身是模型可见的，因此天然被 DSH 记录/审批覆盖；不要在这里自建“安全边界”。
- 可选 `deny`/`allow` 正则（插件 config）：**部署方策略**，不是沙箱；README 里明确写清楚（如 `deny: ['rm -rf /', 'mkfs', 'dd if=']`）。
- Desktop 默认审批策略下，`ssh_run` 会按工具调用触发审批；建议保持 `ask`，把 `readOnly: true` 的主机用于只读巡检。
- 远端 `readOnly` 目前只用作「工具层的写操作拒绝」+ 提示，不假装能拦住 `ssh_run` 里的任意命令——要强约束就上官方 `sandbox-ssh`。

---

## 7. 安装与启用

**打包**：`npm pack` 产出 `dist/dsh-ssh-hosts-<v>.tgz`（与你 webdav 插件一致）。

**桌面应用（当前 6.0.3 / dsh 0.2.0-rc.2）**
1. Plugins 页 → 安装 bundle（填本地 tgz 或 npm 包名）→ 启用。
2. 或手动：把包放进当前 profile 的 `node_modules`（`dsh-ssh-hosts`），在 profile 的 `cordis.patch.yml` 加 §3.1 那一行。
3. 目标是**独立 profile**（例如新建 `ssh` profile），不要动 `web` profile，便于回退。
4. 版本要对齐：本机 dsh 是 `0.2.0-rc.2`，`peerDependencies`/`engines.dsh` 按 `>=0.2.0-rc.2 <0.3.0` 写。

**CLI / headless**
```sh
cd "$(dsh profile path ssh)"        # 或 ~/.dsh/profiles/ssh
pnpm add /path/to/dsh-ssh-hosts-0.1.0.tgz
# cordis.patch.yml 加同一行
dsh --profile ssh "列一下 ssh_hosts，然后到 web-01 跑 uname -a"
```

**验收（人能做的最小检查）**
```sh
chmod 600 ~/.dsh/ssh-hosts.yaml
dsh --profile ssh "ssh_hosts"                          # 列出清单，且不含密钥路径
dsh --profile ssh "到 web-01 跑 uptime"                  # ssh_run 基本通
dsh --profile ssh "把 web-01:/srv/app/README.md 读出来"   # ssh_read
```

---

## 8. 测试计划

| 层 | 内容 |
|---|---|
| 单测（`node --test`） | 清单解析/校验/未知字段/权限检查；`~` 展开；host 解析优先级（参数 > 会话 > 配置）；脱敏断言（输出里绝不出现 `identityFile`）；输出截断边界（恰好上限、超限保尾）；`oldString` 不唯一必须失败且文件未变；错误分类（连不上/超时/认证失败/文件不存在） |
| 集成 | 本机 sshd 或 docker `linuxserver/openssh-server`；覆盖 ControlMaster 复用（第二次调用不重新握手）、sftp 原子写（写一半被杀不产生半文件）、`proxyJump` |
| 真实远端 smoke | 你的一台测试机：`ssh_hosts` → `ssh_run uname -a` → `ssh_write`/`ssh_read` 往返 → `ssh_edit` 唯一定位 → 断网错误路径 |
| 界面链路 | 真实 cordis 装载下 `ctx.tools.get()` 全在、路由挂载与回收、界面写入后工具立刻可见、错误码映射、清单损坏仍硬失败、无 `webServer` 时静默降级、volatile 改值立即生效；浏览器半边用假 React/槽位验证注册形态与渲染无副作用 |
| 界面端到端 | `scripts/smoke-ui.mjs`：真路由 + 真 service + 真服务器走一遍「新增 → 测试连通性 → 设默认 → 工具直接用 → 删除」 |
| 反向验证 | 故意把 YAML 改成 0644、故意写坏一个字段、故意指向不存在的密钥：三种都必须**启动即失败并给出可操作报错**，不能静默降级（界面写入的路径同样先校验再落盘，失败回滚） |

---

## 9. 里程碑

| 里程碑 | 交付 | 可验收 |
|---|---|---|
| M1 | 包骨架 + Config + 清单加载/校验 + `ssh_hosts` + `ssh_run` + `ssh_use`/state | CLI profile 里能列主机并在远端跑命令 |
| M2 | `ssh_read` / `ssh_write` / `ssh_edit` / `ssh_ls`（sftp 原子写）+ 单测 | 远端文件往返与 edit 唯一性 |
| M3 | locale/icon + 桌面 Plugins 页安装启用（bundle 形态）+ 会话恢复后默认主机保留 | 桌面应用里可用、可启停 |
| M4 | 加固：ControlMaster、截断策略、`deny/allow`、README 安全边界、集成测试 | 断连/超时/权限异常全部可复现可解释 |

工作量估计：M1 ≈ 半天到一天；M2 ≈ 一天；M3 ≈ 半天；M4 ≈ 半天（含测试）。

---

## 10. 风险与兜底

- **密钥没有 ssh-agent**（带 passphrase）：v1 直接报「请先 `ssh-add`」，不做交互式输入。
- **桌面 Plugins 页安装本地 tgz 的路径**需要实测（市场仍在设计阶段）；兜底是手动 `node_modules` + patch 行，两条路都保留。
- **不想写代码**：先用社区 MCP SSH server + `dsh-mcp-client`（桌面已内置）跑通体验，代价是多机工具名不统一、依赖第三方实现质量。
- **真的要「整台机器」**：另建一个 profile 用官方 `dsh-ssh` + `fs-ssh` + `subprocess-ssh` + `sandbox-ssh`，一台机器一个 profile；与 `dsh-ssh-hosts` 可共存，互不干扰。
- **端口/网络策略**：本机 `ssh` 客户端需要出网；DSH 的文件沙箱不拦网络（只限制文件效果），所以 `workspace-write` 策略下可用。

---

## 11. 界面管理（新增能力的决策记录）

### 11.1 为什么不是「再存一份清单到 config」

设置页能写的只有 **volatile config 字段**，而清单是一份 0600、要能手工编辑、要能按机器同步的 YAML。两条路并存会立刻出现「设置页一份、YAML 一份，谁赢」的问题。所以：

- `$DSH_HOME/ssh-hosts.yaml` 仍是**唯一权威**；界面写的就是它（原子写 + 0600 + 目录 0700）；
- 写入顺序「先校验 → 再原子写 → 再重载」，重载失败把文件**回滚**成写之前的字节：界面上一次误操作不能让正在跑的会话失去目标机；
- `config.hosts`（部署方内联声明）非空时界面**只读**，并说明原因。

### 11.2 界面半边怎么落地

| 层 | 文件 | 形态 |
| --- | --- | --- |
| HTTP 路由 | `lib/api.js` | `kind: 'prefix'` 挂在 `/ssh-hosts`；每请求先过 `connection.requestRejection`（Host/来源 + 浏览器登录态），过不了直接返回 403/401 |
| 界面运行时 | `lib/service.js` | 校验/写入/重载/测试连通性；`live` 门面让工具每次调用落到最新 handlers |
| 浏览器半边 | `client/bundle.js` | 手写的 classic script（`window.__ModuleLoader__.load({id, factory})`，无 JSX、无构建步骤）；注册 `plugins.bundle.config`（key = 包名）与 `settings.section`（id = `ssh-hosts`） |

浏览器半边的形态是照官方 `docs`/社区插件（`plugin-dev/webdav-sync/client/bundle.js`）核对的：槽位 `plugins.bundle.config` 是 **keyed**、key 是包的 npm 名、只会以 `view: 'page'` 派发；`settings.section` 是 list，选项 `id` / `order` / `label`。`require('react')` 从宿主模块表取，`module.exports = { inject: ['slots'], apply, name }`。

### 11.3 两个实现期挖出来的坑（都有回归测试）

1. **volatile 字段是引用，不是值。** 宿主按 `Config` 校验后，每个 `.volatile()` 字段都是一个 `{ get() }` 引用（`Symbol.for('cosmokit.volatile.write')` 协议）。插件早期直接 `cfg.hostsFile` 读，拿到的是引用对象，于是**所有配置都被静默换成了默认值**（一次「配了没生效」的隐性 bug，只是默认值恰好等于常用值所以没人发现）。现在 `normalizeConfig` 递归解包，另外 `liveConfig` 让每次读都取当下值 —— 设置页改完不重启就能生效（用真实 cordis + 真实 `Config` 的回归测试钉住）。

2. **文件不存在 ≠ 配置错误。** 界面的宿主就是插件自己：清单缺失如果按老设计「装载期硬失败」，用户既没有工具也没有界面去创建它。所以只把**文件不存在**放宽成「空清单 + 引导语」，文件存在但坏掉（YAML/字段/权限）照旧当场失败。

### 11.4 界面链路的验收证据

| 项 | 结果 |
| --- | --- |
| `node scripts/smoke-ui.mjs` | 真路由 + 真 service + 真服务器：文件不存在时插件照常装载 → 路由新增主机（文件 0600）→ `/test` 真实 SSH 返回 `Linux ... ubuntu` → 设为默认 → 同一进程里 `ssh_run` 直接跑在这台 UI 新加的机器上 → 删除后工具侧立刻为空且报 `no-host` → 内联 config 只读态。全程临时目录，不碰 `~/.dsh/ssh-hosts.yaml` |
| `test/ui-wiring.test.mjs` | 真实 cordis 装载：路由挂载/回收、界面写入后工具可见、400/409/404 映射、清单损坏仍硬失败、无 webServer 时纯 CLI 可用、volatile 改值立即生效 |
| `test/api.test.mjs` | 路由契约：方法/路径、query 不干扰匹配、`connection` 拒绝时不调 handler、错误码矩阵、坏 JSON 400、64KB 上限 |

---

## 12. 登录方式：密钥 / 密码 / ssh-agent（决策记录）

### 12.1 为什么密码不写进清单

清单是「怎么连」的配置，会被人复制、备份、贴进 issue。密码一旦写进去就同时违反了三条已有的设计前提（清单 0600 硬校验、清单可分享、模型可见投影脱敏）。而 DSH 已经有一个**专门为此存在的 seam**：`ctx.credentials`（`packages/credentials/credentials`）。

| 层 | 存什么 | 谁写 | 谁读 |
| --- | --- | --- | --- |
| `ssh-hosts.yaml`（0600） | `passwordRef: DSH_SSH_HOSTS_PASSWORD_WEB_01`（一个名字） | 界面 / 手工 | 插件、人 |
| `$DSH_HOME/.credentials.yaml`（0600） | 密码明文值 | `ctx.credentials.set(ref, value)` | `ctx.credentials.resolve(ref)`，**每次调用现解析** |

这个 seam 的文档写得很直白：「Settings and composition files carry *references* to secrets — environment-variable names — while providers own the actual values」。所以本插件只做两件事：把名字写进清单、把值交给凭据库。副作用都是想要的：

- 清单可以安全地备份/分享/进 git（如果没有其它秘密）；
- 界面、HTTP 响应、工具输出**只能**回报「有没有、来自哪一层（`file`/`env`）、能不能写」，值永远不出现在这些通道里（有断言：`JSON.stringify(view)` 不含密码）；
- 每次调用现解析 ⇒ 改完密码下一次调用就生效，不用重启（和 volatile 字段的语义一致）。

**可选依赖**：`credentials` 不放进 `inject`。放进去的话，任何没装凭据库的 profile 会连插件都不装载 —— 而「没有凭据服务」只该让密码不可用，不该让密钥登录也一起废掉。所以用 `ctx.inject(['credentials'], cb)` 等它出现，取不到就降级：`list()` 报 `passwordSupported: false`、存密码报 `unsupported`（HTTP 501）、密码主机报「请改用密钥」的 auth 错误。

**不能用 `ctx.credentials`**：插件自己的 scoped context 上访问未在 `inject` 里声明的服务会抛 `cannot get property "credentials" without inject`（`vendor/cordis/src/reflect.ts:144`），这个错会以 500 的形式冒到界面上 —— 回归测试钉住了这条（`test/ui-wiring.test.mjs`「没有 credentials 服务：界面照常打开」）。

### 12.2 密码怎么送到 ssh

OpenSSH 官方的非交互密码通道是 `SSH_ASKPASS`：ssh 需要密码时不读 tty，而是执行该程序、读它的 stdout。于是：

1. 每次调用建一个 0700 临时目录，里面放两个文件：`secret`（0600，密码 + 换行）与 `askpass.sh`（0700，`cat` 前者）；
2. 子进程环境里只给**路径**：`SSH_ASKPASS` / `SSH_ASKPASS_REQUIRE=force` / `DSH_SSH_HOSTS_ASKPASS_FILE`（老版本 OpenSSH 还需要 `DISPLAY`，一并给上）；
3. 调用结束（含异常）`rmSync` 整个目录。

因此密码**不进 argv、不进 env 值、不进日志**（`ps` 看不到），`secret` 只在一次调用的生命周期内存在。回归测试在「子进程运行中」这一刻读文件，断言 0600/0700、助手能吐出密码、argv 与 env 里都没有明文、调用后目录消失。

另外两条细节：`BatchMode=yes` 是「禁止交互认证」，密码主机必须去掉它（否则 ssh 直接失败）；`NumberOfPasswordPrompts=1` 保证密码错了只试一次，不会因为反复重试把账号撞锁。密钥 + 密码同时给出时 `PreferredAuthentications=publickey,password,keyboard-interactive`，先试密钥。

### 12.3 密码的生命周期（谁在什么时候删）

| 动作 | 清单 | 凭据库 |
| --- | --- | --- |
| 新增主机并填密码 | 写入 `passwordRef`（名字按主机名生成：`DSH_SSH_HOSTS_PASSWORD_<NAME>`） | `set(ref, 值)` |
| 编辑主机、密码框留空 | 不动 | 不动 |
| 编辑主机、填了新密码 | 沿用**同一个** `passwordRef` | `set` 覆盖 |
| 点「清除已存密码」 | 摘掉 `passwordRef` | `unset` |
| 改成不含密码的登录方式 | 摘掉 `passwordRef` | `unset`（不留孤儿） |
| 删除主机 | 条目删除 | `unset` |

「凭据名以文件里现有的为准，不依赖界面回传」是刻意的：界面只发 `clearPassword: true`（不带 `passwordRef`）时也必须清干净，否则凭据库里会留下没人引用的秘密。有回归测试。

写入顺序是**先存凭据、再改清单**：反过来会出现「清单说用密码、凭据库还没有」的空窗，而这期间正好有工具调用的话就会连不上。

### 12.4 界面为什么改成纵向堆叠（窄列）

设置侧栏是窄列，原来的六列表格（名称/地址/密钥/标签/权限/操作）必然横向溢出。改法不是加 `overflow-x: auto`（那只是把问题藏起来），而是换布局：

- 一台主机 = 一个纵向堆叠的块：标题行（名称 + 默认/认证方式/权限徽章，`flexWrap`）+ 若干「标签 值」行（值用 `break-all` 的 `code`）+ 一行可换行的按钮；
- 表单用 `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`：宽了自动两列、窄了自动一列，没有断点、没有媒体查询；
- 根容器 `width/maxWidth: 100%` + `boxSizing: border-box` + `minWidth: 0` + `overflowWrap: anywhere`，长路径/长命令自己断行；
- 回归测试断言产物里**不再有** `table`/`td` 与固定两列网格，且窄列规则（`flexWrap`/`minWidth: 0`/`boxSizing`/`overflowWrap`/`wordBreak`/`auto-fit`）都在。

### 12.5 模型侧看不到密码，也不能设密码

`ssh_hosts` 的投影只多了一个 `auth` 摘要（`key` / `password` / `key+password` / `agent`），`identityFile` 与 `passwordRef` 都不外露（有断言）。没有任何工具能设置或读取密码 —— 设置密码只有界面这一条路（本机操作员 + Host/登录态闸门）。密码没设时，工具报的是「在设置界面的「SSH 主机」里填一次密码」，而不是一句「认证失败」。

---

## 13. 会话窗口里的「+」：把选主机做成人用的入口（决策记录）

### 13.1 问题

工具是**模型**用的接口。人想指定一台服务器，只能在聊天里写字（「在 web-01 上执行…」）或者让模型先 `ssh_use` —— 会话窗口里没有任何「选服务器」的地方。而 DSH 会话窗口输入框左边那个 **「+」展开的就是命令菜单**（`aria-label` = 命令，`listbox`），是给人用的现成位置。

### 13.2 用哪套 seam

`+` 菜单的候选 = **host 命令目录** + **客户端 contribution**（`ui-commands` 的 `CommandUiRuntime.candidates`）。两条路都能加一行：

| 路 | 注册方式 | 选中后能做什么 |
| --- | --- | --- |
| 客户端 contribution | `ctx.commandUi.register({name, description, available, ui})` | 纯浏览器侧行为（如 `/model` 直接改会话模型） |
| **host 命令 + 客户端装饰** | host 侧 `ctx.commands.register(...)` + 浏览器侧 `ctx.commandUi.decorate({name, ui})` | 命令在 host 侧执行，能写会话作用域的状态，并留下持久化命令节点 |

选了第二条（官方 `/permission` 用的就是它）。理由是语义：**「这台会话用哪台服务器」是会话作用域的状态**，而会话作用域的真相在 host 侧（`ssh-hosts.state.json`，`ssh_use` 工具写的就是它）。走 host 命令有三个白拿的好处：

1. **一条状态来源**：命令调用的就是 `handlers.useHost`，和 `ssh_use` 完全同一条代码路径 —— 不存在「菜单选的机器」和「模型 ssh_use 的机器」两套账；
2. **可审计**：`command/run` + `command/done` 是持久化节点，会话记录里看得到「谁在什么时候把这台会话切到了哪台机器」；
3. **手打也行**：`/ssh web-01` 直接可用（host 命令声明了 `input: { hint: '<主机名>' }`，所以带参数的 Enter 会走命令而不是发给模型 —— 这点很关键，否则 `/ssh x` 会被当普通消息发给模型）。

### 13.3 两半边的分工

| 半边 | 文件 | 做什么 |
| --- | --- | --- |
| host | `lib/command.js` | 注册 `/ssh`：裸命令报当前值 + 可用主机；`/ssh <名>` 写会话默认；`/ssh clear` 清除；未知/多词报错并列出可用主机 |
| 浏览器 | `client/bundle.js` | `ctx.commandUi.decorate({name:'ssh', ui:{kind:'popupSelect', options, onSelect}})`：`options` 拉 `/ssh-hosts/hosts?sessionId=…` 列主机（标注「本会话在用」），`onSelect` 提交 `/ssh <名>` |

**可选依赖**：`commands`（host）与 `commandUi`/`sessions`（浏览器）都不是硬依赖 —— 缺了就没有那一行，工具和设置界面照常。所以 `module.exports.inject` 仍然只有 `['slots']`，两边都用 `ctx.inject([...], cb)` 等依赖出现（与 host 侧 credentials 同一套路数，也避开了「未在 inject 里声明的服务在 scoped context 上访问会抛错」那个坑）。

**`+` 的两种 position**：`+` 按钮用「草稿里光标之前是否只有空白」算出 `position`（`ui-conversation/src/client/apply.ts` 的 `toggleCommandMenu`）。`leading`（空草稿）会列出全部命令；`inline`（草稿已有内容）只列**没有参数提示**的命令 —— 这是平台对斜杠菜单的统一约定。我们的命令声明了 `input.hint`（必须声明，否则手打 `/ssh web-01` 回车会被当成普通消息发给模型，见 §13.2-3），所以在 `inline` 时不出现在 `+` 菜单里，与 `/permission` 行为一致。README 里把这条写给了用户。

**子代理会话不给这一行**：addressed subagent 会话没有独立的命令通道，`available` 里用 `sessions.subagentAddress` 判掉 —— 与其让人点了才发现执行不了，不如不出现。

**命令名撞车不拖垮插件**：`commands.register` 抛错（别人的 profile 里已有 `/ssh`）只记一条日志并跳过，工具与界面照常装载。

### 13.4 顺带修掉的一处不一致

做完这个功能立刻撞上一个真问题：`/ssh` 设好会话默认后，模型侧 `ssh_hosts` 报的 `defaultHost` 仍是**全局**默认（空），而 `ssh_run` 省略 host 却能跑 —— 模型会以为「没有默认机」。于是 `listHosts` 现在带 `sessionId` 计算**本次调用实际会用的那台**（会话默认 → 全局默认 → `config.defaultHost`），并新增 `defaultSource`（`session`/`default`/`config`/`none`）；`ssh_hosts` 的渲染也会写「默认主机：web-01，本会话在用」。回归测试断言 `defaultHost` 与 `effectiveHost` 完全一致。

---

## 14. 实现状态与验收记录

### 交付物

| 文件 | 作用 |
| --- | --- |
| `lib/config.js` | Config schema（volatile 字段 + defaults 兜底）、volatile 解包与 live 视图、`$DSH_HOME` / 清单 / 状态路径解析 |
| `lib/hosts.js` | 清单读取与校验（未知字段报错、0600 检查、跳板解析、`passwordRef` 校验、模型可见投影脱敏 + `auth` 摘要） |
| `lib/hosts-doc.js` | 界面那一侧的 YAML 读写：解析原文、保留注释地序列化、原子写 0600、文件信息 |
| `lib/session-state.js` | `$DSH_HOME/ssh-hosts.state.json`（0600、原子写、损坏容错、LRU 淘汰、界面设的默认机） |
| `lib/exec.js` | 传输层：ssh/sftp 封装、确定性 ControlPath、有界输出、错误分类、原子写、**密码 askpass（一次性 0600 文件）** |
| `lib/handlers.js` | 业务逻辑（主机解析优先级、命令策略、行切片、edit 唯一性、readOnly 护栏） |
| `lib/service.js` | 界面可管理的运行时：校验/写入/重载/回滚/连通性测试 + `live` 门面 + **密码生命周期（凭据名生成/沿用/清除）** |
| `lib/api.js` | `/ssh-hosts` 下的 6 条同源路由（含 Host/登录态闸门与错误码映射；密码只进不出） |
| `lib/tools.js` | 7 个 `defineTool` 契约 + 渲染（模型看到的就是渲染结果） |
| `lib/command.js` | `/ssh` 斜杠命令：会话窗口「+」菜单那一行的 host 侧行为 |
| `client/bundle.js` | 浏览器半边：插件页卡片 + 设置侧栏「SSH 主机」，窄列纵向布局、登录方式/密码编辑、「怎么用」提示，以及 `/ssh` 的主机选择弹窗；无构建步骤 |
| `lib/index.js` | `name` / `inject: ['tools']` / `Config` / `apply`；装载期即校验清单，`ctx.effect` 回收资源与路由 |
| `test/*.test.mjs` | 202 个测试（含界面链路、volatile 回归、密码 askpass、浏览器半边渲染、`/ssh` 命令契约）；`test/remote.test.mjs` 为真实服务器集成测试（默认跳过，密码用例需显式给密码） |
| `scripts/smoke-remote.mjs` | 把模型会看到的每一步原样打印 |
| `scripts/smoke-ui.mjs` | 界面链路端到端（路由 → 写文件 → 重载 → 真实 SSH）；给了 `DSH_SSH_HOSTS_REMOTE_PASSWORD` 时额外跑一遍密码登录 |

### 验收证据（都已实跑）

| 项 | 结果 |
| --- | --- |
| 单测 `npm test` | 202 个用例，189 通过 / 13 跳过（跳过的就是真实服务器用例）/ 0 失败 |
| 真实服务器集成 `DSH_SSH_HOSTS_REMOTE=1 node --test test/remote.test.mjs` | 12/12 通过：真实 `uname`、cwd、`exit 66`、非零退出、超时 kill、`/etc` 列目录、not-a-directory、write→read→edit→覆盖写、**覆盖写保留 600 权限**、not-found、not-unique 不改文件、认证失败提示 |
| 真实服务器**密码登录**（`DSH_SSH_HOSTS_REMOTE_PASSWORD` 显式给出，只走环境变量） | 13/13 通过：**不给密钥、只给密码**时 `ssh_run` 返回 `Linux`；凭据没值时在起进程前报 auth 并说明去哪儿填；错密码报 auth（`NumberOfPasswordPrompts=1`，不会挂住或撞锁） |
| 密码链路端到端（真 `credentials-local` + 真插件 + 真界面路由 + 真 ssh + 真服务器，scratch `DSH_HOME`） | 界面 `POST /hosts` 带密码 → `passwordSupported: true`、`password: set`；清单只留 `passwordRef`（0600）**且不含明文**；凭据库 `.credentials.yaml` 0600 且确有值；界面回报 `passwordConfigured: true / source: file` 而**响应不含明文**；仅凭密码 `ssh_run` → `exit 0 / "Linux\nubuntu"`；`ssh_read`（sftp 通道）同样成功；模型投影只有 `auth: "password"`；删除主机 → `clearedPassword: true` 且凭据库里的值消失；全程未触碰真实 `~/.dsh` |
| 冒烟脚本 | `node scripts/smoke-remote.mjs` 全程 exit 0；`ssh_ls /etc`、`ssh_write` 原子写、`ssh_edit`、行区间读取、错误提示全部符合预期 |
| 界面链路 | `node scripts/smoke-ui.mjs` exit 0（含真实 SSH 连通性测试与「UI 加的主机工具立刻可用」）；`DSH_SSH_HOSTS_REMOTE_PASSWORD=... node scripts/smoke-ui.mjs` 额外 exit 0：界面填密码 → 清单只留引用名 → `ssh_run` 用密码登录成功 → 删除后凭据清空 |
| 浏览器半边渲染 | 用最小 React 替身跑「首屏 → 跑 effect → 二次渲染」：加载完成后渲染出主机块（含 `密码 / 已保存（file）` 徽章）与「怎么用」，渲染树里**没有 table**、没有密码值与凭据名；`HostEditor` 的密码框 `type=password` 且值为空、登录方式四个选项齐全；`draftOf/payloadOf` 覆盖四种登录方式的字段增删 |
| `/ssh` 命令端到端（真插件装载 + 真 commands 注册 + 真服务器） | `/ssh` 注册成功（名字/描述/参数提示齐全）；裸命令报当前值 + 可用主机；`/ssh gzlh` → `ssh_hosts` 报 `defaultHost: gzlh, defaultSource: session` 且**省略 host 的 `ssh_run` 真的落在 gzlh**（`Linux`）；别的会话仍报 `none`；`/ssh nope` 报错并列出可用主机；`/ssh clear` 之后省略 host 立刻报 `no-host` |
| 真实 harness 契约 | 用真实 `@deepseek-ai/dsh-tools` 的 `defineTool` + `validateJsonSchemaValue` + `assertObjectJsonSchema` 校验 7 个工具的参数/输出 schema 与执行结果 |
| 真实 cordis 装载 | `Context + SystemPrompt + ToolRuntime + 本插件` 一次装成，`ctx.tools.get('ssh_run')` 可达，7 个工具全部注册；有 `webServer`/`connection` 时路由一并挂上，无则静默降级 |
| 真实 CLI 安装 | `dsh plugin --profile web add <dir>` → profile `dsh.profile.bundles` 自动追加 `dsh-ssh-hosts`；`dsh web --dump-config` 组出 `# == dsh-ssh-hosts` 层；再通过 profile 的 `node_modules/dsh-ssh-hosts` 软链接 + 安装目录里的 cordis/dsh-tools 启动，7 个工具全部注册（以上均在 `/tmp` 里的临时 DSH_HOME 完成，未改动真实 profile） |
| tgz 安装（0.3.0） | 临时 DSH_HOME 里 `dsh plugin --profile web add ./dsh-ssh-hosts-0.3.0.tgz` 成功，包内含 `client/bundle.js`，`--dump-config` 组出同一层。profile 里不装 `@deepseek-ai/*`：桌面端由 `dsh-plugin-desktop-beta/src/module-resolution.ts` 的 profile 解析器兜底（profile → `~/.dsh/profiles/node_modules` → App 安装树），所以插件里的 `@deepseek-ai/dsh-tools` 引用在 App 内可解析 |
| 桌面 profile 安装 | `dsh plugin --profile desktop add` 被 Electron 独占策略拒绝；改为按 App 写入的形态加 `link:` 依赖 + `dsh.profile.bundles` 条目，`node_modules/dsh-ssh-hosts` 软链到本目录，重启 App 即可加载（真实 GUI 点选路径仍待你确认） |

测试目标机：一台真实服务器（Ubuntu 20.04 / Linux 5.4，用户 `ubuntu`；域名/用户/端口/密钥路径都通过 `DSH_SSH_HOSTS_REMOTE_*` 环境变量传入，仓库里只留占位值），仅用 `.test-keys/id_ed25519` 密钥认证，密码从未落盘。

### 与设计的偏差（都是实现期收敛的结果）

1. `ssh_read` 的 `offset`/`limit` 定为**行号**语义（对齐本地 read 工具），不是字节；`maxReadBytes` 才是字节上限。
2. `offset` 越界返回空内容 + `startLine: offset`，**不做夹取**到末行 —— 夹取会让模型以为读到的就是那一行。
3. `ssh_edit` 为「先整文件读回、再整文件原子写回」，不是就地补丁；因此也受 `maxReadBytes` 约束。
4. 会话默认主机落 `$DSH_HOME/ssh-hosts.state.json`（0600、原子写），不是内存态：会话恢复后默认机仍保留。
5. `dispose()` 对每条复用连接发 `ssh -O exit` 并删掉 socket 目录，而不是只删目录。
6. 覆盖写会**尽量保留远端原权限**（先 `stat` 拿 mode，rename 后再 `chmod`），避免把 `.env` / `authorized_keys` 写成 0644。
7. `hostsFile` 的 0600 检查做成硬失败（与设计一致），另外补了 `knownHostsFile` / `strictHostKeyChecking` 两个 config 字段（沙箱里 `~/.ssh` 不可写时用得上）。
8. 「清单缺失 = 装载期硬失败」这条被**有意收窄**成「只有文件不存在时放宽」（见 §11.3-2）；其它一切坏配置仍然当场失败。
9. 原设计的「不存密码、也不接受密码参数」被**有意放宽**成「密码存在 DSH 凭据库、清单只留 `passwordRef`」（见 §12）：需求是「新增主机时支持密码或 key」，而清单本身必须保持可分享。
10. `service.list()` / `upsert()` / `remove()` 变成 **async**：密码状态要向 `ctx.credentials` 问（只问「有没有/能不能写」），写入要先落凭据库再改清单。同步调用点（测试、smoke 脚本）都跟着改了。
11. 会话窗口「+」菜单里的 `/ssh` 是**实现期新增**的能力（原设计只有工具 + 设置界面）：工具是模型用的、设置界面是本机操作员用的，中间缺了「人想指定机器」这一档（见 §13）。
12. 浏览器半边导出 `__test`（Card/HostEditor/HostBlock/draftOf/payloadOf 等）供单测直接渲染；宿主只读 `inject`/`apply`/`name`，多出的字段无副作用。没有构建步骤就没有别的办法在测试里「点按钮」。

### 仍未验证（需要你在真实桌面环境里确认）

- 桌面 **设置 → 插件** 页里安装本目录/tgz 并「启用」的完整 UI 路径（CLI 路径已实测通过）。
- **卡片在桌面 App 里的真实渲染**：插件页卡片与设置侧栏「SSH 主机」是否出现、窄列下是否真的没有横向滚动、按钮是否照预期工作（重启 App 后才能看到，客户端半边在启动时装载）。界面逻辑已用 React 替身渲染过，但没有真实浏览器/CSS 布局引擎参与 —— 「不横向滚动」目前是**布局规则层面的断言**，不是像素层面的。
- 桌面应用里的实际对话：模型能否在第 1 轮就正确挑主机（取决于 profile 的 `defaultHost` 与模型对工具描述的理解）。
- **「+」菜单里的 `ssh` 那一行在真实 GUI 里的观感**：候选来自 host 命令目录（已用真实 cordis 验证注册成功），但菜单渲染、弹窗列表的排版、选中后的命令节点在会话里的样子，只有重启桌面应用后才看得到 —— 我没有真实浏览器可用，这部分是逻辑层验证（弹窗 options/onSelect 用 React 替身跑过），不是像素层。
- Windows 目标机（本插件走系统 OpenSSH 客户端，Windows 上不可用）。
