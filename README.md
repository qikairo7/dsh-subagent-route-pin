# dsh-subagent-route-pin

给被委派的子代理（专家团专家、Agent Teams 成员、单发子代理）单独指定 LLM 路由，主 agent 不受影响。

解决的问题：DSH 默认让子 agent 继承主 agent 的模型路由，于是「大脑 + 4 路子代理」挤在同一个 provider 账号额度里，`summon_experts` 看起来卡死。装上本插件后，主 agent 可以跑免费车道，子代理跑另一个账号/模型，两条额度队列互不阻塞。

适用面：**按 provider 生效，不按专家名单**。agency 里 331 个专家、你新建的自定义专家、以后升级新增的专家，只要还读 `config.provider`，都自动命中同一条路由。

## 它做什么

- 注册一个包装 provider `pinned-account`，委托内置 `spawn`，在创建子 agent 前填入 `agentOptions`
- 单发子代理走 `provider.start()`：包装 provider 直接生效
- 团队模式成员不经过 `provider.start()`：在 `subagents.startContinuable()` 上挂一层钩子，把路由填进 `request.agentOptions`（可用 `teamInjection: false` 关闭）
- 设置 → **专家模型** 页面：提供商 / 模型 / 推理强度下拉 + 团队模式注入开关 + 专家团引擎提示，保存写回 profile 补丁，下一次委派生效
- 逐专家覆盖：`~/.dsh/subagent-route-pin.json` 的 `experts` 字段（可选，优先级高于页面）

## 安装

```bash
# 从 tarball
dsh plugin --profile desktop add "./@xywr8884156-tech-dsh-subagent-route-pin-0.4.0.tgz"

# 从 npm（发布后）
dsh plugin --profile desktop add "@xywr8884156-tech/dsh-subagent-route-pin"

# 从本地目录（开发调试，link 安装）
dsh plugin --profile desktop add "D:\\path\\to\\dsh-subagent-route-pin"
```

`dsh plugin` 要写 profile 目录，通常需要提权（关闭沙箱或以同一用户直接运行终端）。

装完后 profile 的 `cordis.patch.yml` 里新增一行（包内 `cordis.patch.yml` 已自带，无需手写）：

```yaml
- id: subagent-route-pin
  name: "@xywr8884156-tech/dsh-subagent-route-pin"
  config:
    providerName: pinned-account
    baseProvider: spawn
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: ''
    strict: false
    teamInjection: true
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

## 验证

重启 DSH 后：

1. 设置 → 专家模型 页面出现，底部显示「专家团引擎」
2. 日志出现 `subagent-route-pin: provider "pinned-account" delegates to "spawn"`
3. 日志出现 `subagent-route-pin: team-mode hook installed on ctx.subagents.startContinuable`
4. 委派时出现 `subagent-route-pin: team member label="…" -> provider/model`

日志位置：`~/.dsh/logs/startup-*.log`。

## 兼容性

| 依赖 | 说明 |
| --- | --- |
| `ctx.subagents.registerProvider` / `startContinuable` | 缺失时只告警，不阻断 profile 启动 |
| `@deepseek-ai/dsh-tool-subagent` 的 provider 接口 | 能力表必须声明 `agentOptions`；内置 `spawn` 自带 |
| 浏览器侧 `configForms` / `slots` / `locale` / `remote.session.modelCatalog` | 页面用；缺失时卡片显示「不可用」状态 |
| 设置行 patch 语义 | 整行替换 config，不是合并 |

`teamInjection` 依赖 `startContinuable` 可被定义 own property；若 DSH 后续冻结该服务对象，插件只会告警并退化为「仅单发子代理可控」。

## 测试

```bash
node test/run.mjs
```

47 项断言：路由优先级、文件热读、strict 校验、团队注入、已有路由不覆盖、开关关闭、缺路由不阻断、dispose 还原、重复挂载换路由。

## 发布

```bash
npm login                      # 用户名需与 scope 一致：@xywr8884156-tech
npm publish                    # publishConfig 已设 access=public
pnpm pack --pack-destination dist
```

改 scope：只改 `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`client.js` 的 `__ModuleLoader__.load({ id })` 三处（三处必须完全一致）。

## 回滚

```bash
dsh plugin --profile desktop remove "@xywr8884156-tech/dsh-subagent-route-pin"
```

或删掉 profile `cordis.patch.yml` 里 `id: subagent-route-pin` 那一行。

## License

MIT — 见 [LICENSE](LICENSE)。
