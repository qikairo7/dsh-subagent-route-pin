# dsh-subagent-route-pin

给被委派的子代理（专家团专家、Agent Teams 成员、单发子代理）单独指定 LLM 路由，主 agent 不受影响。

解决的问题：DSH 默认让子 agent 继承主 agent 的模型路由，于是「大脑 + 4 路子代理」挤在同一个 provider 账号额度里，`summon_experts` 看起来卡死。装上本插件后，主 agent 可以跑免费车道，子代理跑另一个账号/模型，两条额度队列互不阻塞。

适用面：**按 provider 生效，不按专家名单**。agency 里 331 个专家、你新建的自定义专家、以后升级新增的专家，只要还读 `config.provider`，都自动命中同一条路由。

## 它做什么

- 注册一个包装 provider `pinned-account`，委托内置 `spawn`，在创建子 agent 前填入 `agentOptions`
- 单发子代理走 `provider.start()`：包装 provider 直接生效
- 团队模式成员不经过 `provider.start()`：在 `subagents.startContinuable()` 上挂一层钩子，把路由填进 `request.agentOptions`（可用 `teamInjection: false` 关闭）
- **能力标志**：钩子探测结果会发布成 `{ teamInjection: 'installed' | 'unavailable', enabled, reason }`，调用方能读到「团队注入此刻可不可用」，而不是只靠日志猜
- **失败回退**（`fallback`，默认开）：钉住的路由起不来就退回调用方原本的路由，委派不会因为免费车道额度耗尽而直接失败
- 设置 → **专家模型** 页面：提供商 / 模型 / 推理强度下拉 + 团队模式注入开关 + 专家团引擎提示，保存写回 profile 补丁，下一次委派生效
- 逐专家覆盖：`~/.dsh/subagent-route-pin.json` 的 `experts` 字段（可选，优先级高于页面）

## 安装

```bash
# 从 tarball
dsh plugin --profile desktop add "./dsh-subagent-route-pin-0.6.0.tgz"

# 从 npm（发布后）
dsh plugin --profile desktop add "dsh-subagent-route-pin"

# 从本地目录（开发调试，link 安装）
dsh plugin --profile desktop add "D:\\path\\to\\dsh-subagent-route-pin"
```

`dsh plugin` 要写 profile 目录，通常需要提权（关闭沙箱或以同一用户直接运行终端）。

装完后 profile 的 `cordis.patch.yml` 里新增一行（包内 `cordis.patch.yml` 已自带，无需手写）：

```yaml
- id: subagent-route-pin
  name: "dsh-subagent-route-pin"
  config:
    providerName: pinned-account
    baseProvider: spawn
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: ''
    strict: false
    teamInjection: true
    fallback: true
```

## 让专家团用上它

专家团（`@michengai/dsh-agency-agents`）默认走 `spawn`，需要把它的 provider 指过来：

```yaml
- id: agency-agents
  name: "@michengai/dsh-agency-agents"
  config:
    provider: pinned-account
    # 不要写 maxDepth —— 写了会强制单发阻塞引擎，召唤要等全部跑完
```

> 注意：profile 的 patch 行是**整行替换 config**，改这一行时要把 `enabled` / `customExperts` / `enabledTeams` 等原字段一起重述，否则会被清空。

Agent Teams（`@nanmicoder/dsh-agent-teams`）有自己的一套 `memberModel` / `memberLlmProvider`，插件不会覆盖它——两条路由各管各的，避免互相打架。

## 看团队跑到哪了（本地面板）

Agent Teams 自己是**条件渲染**的：会话标题栏那个入口只在「当前会话确实持有一个开跑的团队」时才出现，计划还在暂存（等你批准）、或者你换了会话、想看别的项目里的团队，界面上就什么都看不到。

插件带了一个只读的状态面板，直接读磁盘上的 `.agent-teams/<team>/team.json`：

```bash
# 起一个本地面板，浏览器打开它给的地址，2 秒自动刷新
npm run teams -- --scan "D:/你的工作区父目录"

# 只想在终端看一眼
npm run teams:once -- --dir "D:/你的项目"

# 装了 npm 包的话，也可以直接用 bin
dsh-team-status --serve --port 7800
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--dir <path>` | 指定工作区根目录（其下有 `.agent-teams/`），可重复 |
| `--scan <root>` | 把 root 自身和它的直接子目录里带 `.agent-teams` 的都扫进来 |
| `--serve` | 起 HTTP 面板（默认 `127.0.0.1:7788`） |
| `--port <n>` | 换端口 |

面板显示：团队阶段、计划是否**待批准**、成员（角色/状态/模型）、任务表（ID/状态/负责人/依赖/尝试次数）、完成进度条。暂存态会直接提示「计划还没批准：去 Web 的计划卡点 Approve & Run，否则成员不会启动」——这就是最常见的「看不到团队」原因。

它只读状态文件，不连 DSH、不改任何东西，所以任何会话、任何项目都能看。

## 验证

重启 DSH 后：

1. 设置 → 专家模型 页面出现，底部显示「专家团引擎」
2. 日志出现 `subagent-route-pin: provider "pinned-account" delegates to "spawn"`
3. 日志出现 `subagent-route-pin: team-mode hook installed on ctx.subagents.startContinuable`
4. 日志出现 `subagent-route-pin: capabilities {"teamInjection":"installed","enabled":true}`
5. 委派时出现 `subagent-route-pin: team member label="…" -> provider/model`

**这五行是接口契约，不是装饰**：第 2 行说明 provider 包装还挂得上，第 3、4 行说明 `startContinuable` 这个缝还在，第 5 行说明注入实际生效。升级 DSH 后少任何一行，都说明上游接口变了，先别怪额度。

这些行在哪看：`ctx.logger.info` 只进 DSH 进程控制台（GUI 的开发者控制台 / 终端 stdout），**不落盘**。`~/.dsh/logs/` 下只有启动**失败**时的诊断 dump，正常启动不写日志文件——所以别去那里找。

插件为此每次启动落一条就绪记录，升级后一条命令就能验：

```bash
npm run verify        # = node test/run.mjs && node test/logs.mjs --strict
npm run ready         # 只看盘上的就绪记录，不跑测试
```

就绪记录：`~/.dsh/subagent-route-pin.ready.json`

```json
{
  "schema": 1,
  "plugin": "subagent-route-pin",
  "version": "0.5.0",
  "at": "2026-10-19T14:11:28.596Z",
  "mounted": true,
  "providerName": "pinned-account",
  "baseProvider": "spawn",
  "fallback": true,
  "teamInjection": true,
  "capabilities": { "teamInjection": "installed", "enabled": true }
}
```

`test/logs.mjs` 校验：插件身份、版本与本地 `package.json` 一致、是否挂载、能力标志、回退开关、`providerName -> baseProvider`、记录龄（超过 7 天提示重启 DSH）。`--strict` 时 `teamInjection: 'unavailable'` 直接判失败——发版前该用这个。

有控制台输出时还能一起验那五行：

```bash
node test/logs.mjs --log captured-console.txt
```

默认 `provider delegates` / `hook installed` / `capabilities published` 三条必需，`team member label=` 在还没委派过时记为 `none`。

## 失败回退

`fallback: true`（默认）时，钉住的这条路由起不来不会直接砸掉委派：

| 场景 | 行为 | 日志 |
| --- | --- | --- |
| 单发子代理，`pinned-account` 的 `start()` 报错 | 去掉注入的路由，用调用方本来的路由重试一次 | `pinned route … failed to start (…); retrying on the inherited route …` |
| 团队成员，`startContinuable()` 报错 | 删掉 `request.agentOptions`，用继承路由重试一次 | `team member … failed to start on …; retrying on the inherited route` |
| 重试后仍然失败 | 抛出原始错误，不吞 | — |
| 注入的路由和继承路由本来就一样 | 不重试（重试等于再撞一次同一额度） | — |

边界要说清楚：**只在启动阶段可观测**。子代理跑起来之后，流式请求中途的 429/额度错误发生在 `start()` 返回之后，插件抓不到——那种情况要看 DSH 自己的重试与错误上报。所以 `fallback` 兜的是「开局就撞墙」，不是「跑到一半断粮」。

## 兼容性

### 兼容矩阵

| DSH / `@deepseek-ai/dsh-tool-subagent` | 状态 | 说明 |
| --- | --- | --- |
| `0.2.1-rc.2` | ✅ 已验证 | 当前 `peerDependencies` 钉住的版本，79 项断言全绿 |
| `0.2.0-rc.x` | ❓ 未验证 | 接口面看起来一致，但没跑过；装了会看到 peer 警告 |
| `>= 0.3.0` | ⚠️ 预期不兼容 | 上游一旦改动 provider / `startContinuable` 签名，第 2–5 行日志会先缺，插件按能力标志降级 |

`peerDependencies` 钉死版本是刻意的：**升级前 npm/pnpm 就会警告**，把「升级完发现坏了」提前成「装的时候就知道要验」。想放宽就改 `package.json` 的 `peerDependencies`，但改完请按上面的测试跑一遍再发版。

### 接口依赖

| 依赖 | 说明 |
| --- | --- |
| `ctx.subagents.registerProvider` / `startContinuable` | 缺失时置能力标志 `teamInjection: 'unavailable'` 并告警，不阻断 profile 启动 |
| `@deepseek-ai/dsh-tool-subagent` 的 provider 接口 | 能力表必须声明 `agentOptions`；内置 `spawn` 自带 |
| 浏览器侧 `configForms` / `slots` / `locale` / `remote.session.modelCatalog` | 页面用；缺失时卡片显示「不可用」状态 |
| 设置行 patch 语义 | 整行替换 config，不是合并 |

读取能力标志（宿主侧）：

```js
import { teamInjectionCapabilities } from 'dsh-subagent-route-pin'

// { teamInjection: 'installed' | 'unavailable', enabled?: boolean, reason?: string }
const capability = teamInjectionCapabilities(ctx.subagents)
if (capability.teamInjection === 'unavailable') {
  // 团队成员会保持父路由 —— 这里决定要不要降级/提示用户
}
```

同一份结果也挂在 `ctx.subagents[Symbol.for('dsh-subagent-route-pin.continuable-hook')].capabilities` 上。

`teamInjection` 依赖 `startContinuable` 可被定义 own property；若 DSH 后续冻结该服务对象，插件置 `unavailable` 并退化为「仅单发子代理可控」。

## 测试

```bash
node test/run.mjs        # 79 项断言，不需要 DSH 在跑
node test/logs.mjs       # 检查真实启动留下的就绪记录
npm run verify           # 两个一起，且 --strict
```

79 项断言：路由优先级、文件热读、strict 校验、团队注入、已有路由不覆盖、开关关闭、缺路由不阻断、dispose 还原、重复挂载换路由、能力标志（installed / unavailable / 缺 `startContinuable`）、启动失败回退（单发 / 团队 / 关闭开关 / 重试仍失败 / 同路由不重试）、日志契约、就绪记录（正常挂载 / 缺服务 / 版本一致）。

`test/run.mjs` 证明的是**插件逻辑没坏**；`test/logs.mjs` 证明的是**它在这个 DSH 构建里还挂着**。两件事会分别失败，上游接口变更先体现在后者。

## 升级回归

升级 DSH 后按这个顺序走，别跳步：

```bash
node test/run.mjs                 # 1. 逻辑层：79 项还绿吗
# 2. 重启 DSH（只改插件不用，改 DSH 本体必须）
npm run ready                     # 3. 挂载层：就绪记录还是这次启动写的吗
```

第 3 步读到 `capabilities.teamInjection: "unavailable"` 就是上游把 `startContinuable` 动了——此时单发子代理仍可控，团队模式成员退回父路由。把 `peerDependencies` 和兼容矩阵一起对一遍，再决定是适配还是回滚。

## 发布

包名是**不带 scope** 的 `dsh-subagent-route-pin`（npm 上确认未被占用），因此不需要拥有任何 npm 组织/scope，登录任意账号即可发布：

```bash
npm login
npm publish                    # 无 scope，默认为 public
pnpm pack --pack-destination dist
```

> 若以后要改到自己的 scope（例如 `@yourname/dsh-subagent-route-pin`），必须同时改这 **4 处**，少一处就会出现「装上了但不加载」：
>
> | # | 位置 | 作用 |
> | --- | --- | --- |
> | 1 | `package.json` → `name` | 安装名、依赖解析名 |
> | 2 | `cordis.patch.yml` → 行的 `name` | profile 加载器按包名找入口 |
> | 3 | `client.js` → `__ModuleLoader__.load({ id })` | 浏览器端模块 id |
> | 4 | `client.js` → `CONFIG_NS_CANDIDATES` | 设置页绑定配置行的候选名 |
>
> 另需同步 `test/client.mjs`、`test/browser-harness.html` 里的 id 断言，以及 README 里的安装示例。

GitHub 仓库名与 npm 包名保持一致（`dsh-subagent-route-pin`），仓库归属 `tkaiz0406` 是 GitHub 账号，与 npm scope 无关，`repository`/`homepage`/`bugs` 无需随 npm 改名。

## 回滚

```bash
dsh plugin --profile desktop remove "dsh-subagent-route-pin"
```

或删掉 profile `cordis.patch.yml` 里 `id: subagent-route-pin` 那一行。

## License

MIT — 见 [LICENSE](LICENSE)。
