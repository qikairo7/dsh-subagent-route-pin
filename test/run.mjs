/**
 * Offline harness for dsh-subagent-route-pin.
 *
 * Drives `apply()` against a fake ctx so the route resolution, hot reload and
 * fallback paths are exercised without a running DSH profile:
 *   node test/run.mjs
 *
 * It asserts the object handed to the base provider's `start()`, which is the
 * only thing the framework consumes.
 *
 * Resolution order under test (highest first):
 *   1. settings file `experts[<label>]`  — per-expert override
 *   2. this plugin's config row          — what the Settings page writes
 *   3. settings file `default`           — legacy fallback
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, teamInjectionCapabilities, wireAgencyProvider } from '../index.js'

const HOOK = Symbol.for('dsh-subagent-route-pin.team-hook')
// Pre-0.8 path, still published so a caller that learned it keeps working.
const LEGACY_HOOK = Symbol.for('dsh-subagent-route-pin.continuable-hook')

const dir = mkdtempSync(join(tmpdir(), 'route-pin-'))
const settingsPath = join(dir, 'routes.json')
// Never write the real readiness record from a test run.
const readinessPath = join(dir, 'ready.json')

const CAPABILITIES = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

function makeHarness(config, extraCtx = {}) {
  const calls = []
  const logs = []
  const base = {
    name: 'spawn',
    capabilities: CAPABILITIES,
    inheritsParentContext: false,
    start(request) {
      calls.push(request)
      return { started: true, request }
    },
    prepareContinuable() {
      return Promise.resolve({})
    }
  }
  const registered = []
  const teamCalls = []
  // Mirrors a current DSH build: `SubagentRuntime` exposes `startActivation` and
  // has no `startContinuable`. It lives on a prototype on purpose: the team hook
  // shadows it with an own property, so the dispose path can be asserted by
  // deleting it.
  const service = Object.create({
    async startActivation(spec) {
      teamCalls.push(spec)
      return { ok: true, spec }
    }
  })
  service.getProvider = (name) => (name === 'spawn' ? base : undefined)
  service.registerProvider = (provider) => registered.push(provider)
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message])
    },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }, { id: 'our-free-model' }],
      async listModels(provider) {
        if (provider === 'deepseek-account') return [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }]
        if (provider === 'our-free-model') return [{ id: 'deepseek-v4.1-flash-free' }]
        return []
      }
    },
    ...extraCtx
  }
  apply(ctx, { settingsPath, readinessPath, ...config })
  if (registered.length !== 1) throw new Error(`expected one registered provider, got ${registered.length}`)
  return { provider: registered[0], calls, logs, service, teamCalls }
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

async function startWith(harness, label) {
  const request = { prompt: 'do the thing', parent: {}, label }
  const result = await harness.provider.start(request)
  return { request: result.request, forwarded: harness.calls.at(-1) }
}

// --- 1. the config row is the primary route --------------------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'medium' })
  const { forwarded } = await startWith(harness, 'Anything')
  check('empty settings -> config row', forwarded.agentOptions.provider === 'deepseek-account' && forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(forwarded.agentOptions))
  check('config effort applied', forwarded.agentOptions.reasoningEffort === 'medium', JSON.stringify(forwarded.agentOptions))
  check('request fields preserved', forwarded.prompt === 'do the thing' && forwarded.label === 'Anything')
}

// --- 2. the config row beats a stale settings default ----------------------
writeFileSync(settingsPath, JSON.stringify({ default: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-pro' })
  const { forwarded } = await startWith(harness, 'Research Analyst')
  check('config row wins over default', forwarded.agentOptions.provider === 'deepseek-account' && forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(forwarded.agentOptions))
  // The row names no effort, so nothing is injected into a provider that may
  // not support it.
  check('no effort injected when unspecified', forwarded.agentOptions.reasoningEffort === undefined, JSON.stringify(forwarded.agentOptions))
}

// --- 3. per-expert override, exact and contains ----------------------------
writeFileSync(
  settingsPath,
  JSON.stringify({
    match: 'contains',
    default: { provider: 'deepseek-account', model: 'deepseek-flash' },
    experts: {
      'research analyst': { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free', reasoningEffort: 'low' },
      security: { provider: 'deepseek-account', model: 'deepseek-pro', maxTokens: 4096 }
    }
  }),
  'utf8'
)
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const exact = await startWith(harness, 'Research Analyst')
  check('exact expert match (case-insensitive)', exact.forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(exact.forwarded.agentOptions))
  check('expert effort applied', exact.forwarded.agentOptions.reasoningEffort === 'low')
  const partial = await startWith(harness, 'Senior Security Engineer')
  check('contains match', partial.forwarded.agentOptions.provider === 'deepseek-account' && partial.forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(partial.forwarded.agentOptions))
  check('maxTokens applied', partial.forwarded.agentOptions.maxTokens === 4096)
  const other = await startWith(harness, 'Legal Policy Writer')
  check('unmatched expert falls to the config row', other.forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(other.forwarded.agentOptions))
}

// --- 4. per-expert overrides hot reload without re-apply -------------------
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'deepseek-flash' } } }), 'utf8')
{
  const harness = makeHarness({})
  const before = await startWith(harness, 'X')
  check('before rewrite', before.forwarded.agentOptions.model === 'deepseek-flash')
  writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'deepseek-pro' } } }), 'utf8')
  const after = await startWith(harness, 'X')
  check('after rewrite (no re-apply)', after.forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(after.forwarded.agentOptions))
}

// --- 5. legacy default is used only when the row has no route --------------
writeFileSync(settingsPath, JSON.stringify({ default: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }), 'utf8')
{
  const harness = makeHarness({})
  const { forwarded } = await startWith(harness, 'X')
  check('row without a route -> settings default', forwarded.agentOptions.provider === 'our-free-model' && forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(forwarded.agentOptions))
}

// --- 6. an unusable expert override falls back to the row, with a warning --
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'nope', model: 'ghost' } } }), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', onPinFailure: 'inherit' })
  const { forwarded } = await startWith(harness, 'X')
  check('unknown provider falls back to the row', forwarded.agentOptions.provider === 'deepseek-account' && forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(forwarded.agentOptions))
  check('fallback warned', harness.logs.some(([kind, message]) => kind === 'warn' && message.includes('not registered')), JSON.stringify(harness.logs.at(-1)))
}

// --- 7. strict turns the same miss into a hard failure --------------------
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'ghost-model' } } }), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', strict: true })
  let message
  try {
    await startWith(harness, 'X')
  } catch (error) {
    message = error.message
  }
  check('strict rejects an unadvertised model', typeof message === 'string' && message.includes('does not advertise'), message)
}

// --- 8. malformed settings keep the last good parse ----------------------
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'deepseek-pro' } } }), 'utf8')
{
  const harness = makeHarness({})
  const good = await startWith(harness, 'X')
  check('good parse first', good.forwarded.agentOptions.model === 'deepseek-pro')
  writeFileSync(settingsPath, '{ this is not json', 'utf8')
  const kept = await startWith(harness, 'X')
  check('malformed keeps last good', kept.forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(kept.forwarded.agentOptions))
  check('malformed warned', harness.logs.some(([kind, message]) => kind === 'warn' && message.includes('ignoring')), JSON.stringify(harness.logs.slice(-2)))
}

// --- 9. no route anywhere: inherit instead of failing --------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ providerName: 'pinned-account', baseProvider: 'spawn' })
  const { forwarded } = await startWith(harness, 'X')
  check('missing route delegates without agentOptions', forwarded !== undefined && forwarded.agentOptions === undefined, JSON.stringify(forwarded?.agentOptions))
  check('missing route logs inherited', harness.logs.some(([kind, message]) => kind === 'info' && message.includes('inherited')), JSON.stringify(harness.logs.slice(-2)))
}
{
  const harness = makeHarness({ providerName: 'pinned-account', baseProvider: 'spawn', strict: true })
  let message
  try {
    await startWith(harness, 'X')
  } catch (error) {
    message = error.message
  }
  check('strict turns a missing route into a hard failure', typeof message === 'string' && message.includes('no route for expert') && message.includes(settingsPath), message)
}

// --- 10. prepareContinuable is delegated --------------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = { sessionId: 'abc', parent: {}, signal: undefined }
  const resolved = await harness.provider.prepareContinuable(spec)
  check('prepareContinuable delegated', resolved !== undefined && resolved !== null, String(resolved))
  check('inheritsParentContext mirrors base', harness.provider.inheritsParentContext === false)
}

// --- 11. a half-filled row is skipped, not fatal -------------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account' })
  const { forwarded } = await startWith(harness, 'X')
  check('provider without model inherits instead of throwing', forwarded !== undefined && forwarded.agentOptions === undefined, JSON.stringify(forwarded?.agentOptions))
}

// --- 12. `ctx.config` is a second live source for the row ----------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness(
    {},
    {
      config: {
        provider: () => 'our-free-model',
        model: () => 'deepseek-v4.1-flash-free',
        reasoningEffort: () => 'high'
      }
    }
  )
  const { forwarded } = await startWith(harness, 'X')
  check('ctx.config fallback resolved', forwarded.agentOptions.provider === 'our-free-model' && forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(forwarded.agentOptions))
  check('ctx.config effort resolved', forwarded.agentOptions.reasoningEffort === 'high')
}

// --- 13. accessor-valued fields (volatile write simulation) --------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  let current = { provider: 'deepseek-account', model: 'deepseek-flash' }
  const harness = makeHarness({
    provider: () => current.provider,
    model: () => current.model,
    reasoningEffort: () => undefined
  })
  const before = await startWith(harness, 'X')
  check('accessor read', before.forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(before.forwarded.agentOptions))
  current = { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' }
  const after = await startWith(harness, 'X')
  check('accessor reflects a live write without re-apply', after.forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(after.forwarded.agentOptions))
}

// --- 14. the provider is removed when THIS fiber disposes -----------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const live = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    subagents: {
      getProvider: (name) => live.get(name),
      registerProvider: (provider) => {
        let alive = true
        live.set(provider.name, provider)
        return () => {
          if (!alive) return
          alive = false
          if (live.get(provider.name) === provider) live.delete(provider.name)
        }
      }
    },
    llm: { listProviders: () => [], async listModels() { return [] } }
  }
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  check('provider registered into the live table', live.get('pinned-account') !== undefined)
  check('fiber scoped one disposer effect', effects.length === 1, String(effects.length))
  for (const callback of effects) callback()()
  check('fiber dispose unregisters the provider', live.get('pinned-account') === undefined)
}

// --- 15. a duplicate registration degrades instead of failing the plugin --
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: {
      getProvider: () => undefined,
      registerProvider: () => {
        throw new Error('a subagent provider named "pinned-account" is already registered')
      }
    },
    llm: { listProviders: () => [], async listModels() { return [] } }
  }
  let threw
  try {
    apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  } catch (error) {
    threw = error
  }
  check('duplicate provider does not fail apply', threw === undefined, threw && threw.message)
  check('duplicate provider warns', logs.some(([kind, message]) => kind === 'warn' && message.includes('not registered')))
}

// --- 16. team-mode members get the row route -----------------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'medium' })
  const spec = { childId: 'c1', provider: 'pinned-account', label: '问卷设计师', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  const agentOptions = spec.request.agentOptions
  check('team member route injected', agentOptions?.provider === 'deepseek-account' && agentOptions?.model === 'deepseek-flash', JSON.stringify(agentOptions))
  check('team member effort injected', agentOptions?.reasoningEffort === 'medium')
  check('underlying startActivation still called', harness.teamCalls.length === 1)
  check('team member logged', harness.logs.some(([kind, message]) => kind === 'info' && message.includes('team member')))
}

// --- 17. Agent Teams' own member route is overridden by default -----------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  await harness.service.startActivation(spec)
  check(
    'existing member route overridden',
    spec.request.agentOptions.provider === 'deepseek-account' && spec.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17b. overrideMemberRoute: false keeps the caller's own route ---------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', overrideMemberRoute: false })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  await harness.service.startActivation(spec)
  check(
    'existing member route untouched when the override is off',
    spec.request.agentOptions.provider === 'our-free-model' && spec.request.agentOptions.model === 'mimo-v2.6-flash-free',
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17c. an overridden route keeps the caller's extra fields -------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo', maxTokens: 4096 } }
  }
  await harness.service.startActivation(spec)
  check(
    'override keeps unrelated agentOptions',
    spec.request.agentOptions.maxTokens === 4096 && spec.request.agentOptions.provider === 'deepseek-account',
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17d. the pinned route drops a stale effort ---------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo', reasoningEffort: 'low' } }
  }
  await harness.service.startActivation(spec)
  check(
    'override drops effort the pinned route did not ask for',
    spec.request.agentOptions.reasoningEffort === undefined,
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17e. a failed override falls back to the requested route, not none ---
{
  const seen = []
  const service = Object.create({
    async startActivation(spec) {
      seen.push(spec.request.agentOptions)
      if (spec.request.agentOptions?.provider === 'deepseek-account') throw new Error('429 quota exhausted')
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  const result = await service.startActivation(spec)
  check('failed override retries on the requested route', seen.length === 2 && seen[1]?.provider === 'our-free-model' && seen[1]?.model === 'mimo-v2.6-flash-free', JSON.stringify(seen))
  check('failed override keeps the member alive', result.ok === true)
  check('failed override says requested, not inherited', logs.some(([, message]) => message.includes('retrying on the requested route')))
}

// --- 18. teamInjection: false is an off switch ---------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', teamInjection: false })
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  check('teamInjection false leaves the member on the parent route', spec.request.agentOptions === undefined)
}

// --- 19. a missing route never breaks member creation --------------------
{
  const harness = makeHarness({})
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  let threw
  try {
    await harness.service.startActivation(spec)
  } catch (error) {
    threw = error
  }
  check('missing route does not break member creation', threw === undefined, threw && threw.message)
  check('missing route warned', harness.logs.some(([kind, message]) => kind === 'warn' && message.includes('inherits the parent model')))
  check('member still created', harness.teamCalls.length === 1)
}

// --- 20. the hook is an own property and is removed on dispose -----------
{
  const effects = []
  const logs = []
  const service = Object.create({
    async startActivation(spec) {
      return { ok: true, spec }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = (provider) => () => {}
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    subagents: service,
    llm: { listProviders: () => [{ id: 'deepseek-account' }], async listModels() { return [{ id: 'deepseek-flash' }] } }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  check('hook is an own property of the service', Object.prototype.hasOwnProperty.call(service, 'startActivation'))
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startActivation(spec)
  check('hook works on a prototype-provided method', spec.request.agentOptions?.model === 'deepseek-flash', JSON.stringify(spec.request.agentOptions))
  for (const callback of effects) callback()()
  check('dispose deletes the own property', Object.prototype.hasOwnProperty.call(service, 'startActivation') === false)
  const after = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startActivation(after)
  check('prototype method restored', after.request.agentOptions === undefined)
}

// --- 21. a remount swaps the resolver but installs only one hook ---------
{
  const effects = []
  const logs = []
  const service = Object.create({ async startActivation(spec) { return { ok: true, spec } } })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }, { id: 'our-free-model' }],
      async listModels(provider) {
        return provider === 'our-free-model' ? [{ id: 'deepseek-v4.1-flash-free' }] : [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  apply(ctx, { settingsPath, readinessPath, provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startActivation(spec)
  check('remount swaps the resolver', spec.request.agentOptions?.model === 'deepseek-v4.1-flash-free', JSON.stringify(spec.request.agentOptions))
  check('hook installed exactly once', logs.filter(([, message]) => message.includes('team-mode hook installed')).length === 1)
}

// --- 22. the team-injection capability is a readable flag ----------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(harness.service)
  check('capability: team injection installed', capability.teamInjection === 'installed', JSON.stringify(capability))
  check('capability: enabled mirrors the live switch', capability.enabled === true, JSON.stringify(capability))
  check('capability: no reason when installed', capability.reason === undefined, JSON.stringify(capability))
  const published = harness.service[HOOK].capabilities
  check('capability published on the service symbol', published.teamInjection === 'installed', JSON.stringify(published))
  check('capability: names the wrapped seam', JSON.stringify(capability.seams) === '["startActivation"]', JSON.stringify(capability.seams))
  const legacy = harness.service[LEGACY_HOOK]
  check('capability: the pre-0.8 symbol still resolves', legacy !== undefined && legacy.capabilities.teamInjection === 'installed')
}

// --- 22b. a build that only has the older seam still gets injected ------
{
  const seen = []
  const service = Object.create({
    async startContinuable(spec) {
      seen.push(spec.request.agentOptions)
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(service)
  check('legacy seam: reported as the wrapped seam', JSON.stringify(capability.seams) === '["startContinuable"]', JSON.stringify(capability.seams))
  await service.startContinuable({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('legacy seam: route injected', seen[0]?.model === 'deepseek-flash', JSON.stringify(seen))
}

// --- 22c. both seams present: startActivation wins, no double injection --
{
  const order = []
  const service = Object.create({
    async startActivation(spec) {
      order.push(['activation', spec.request.agentOptions])
      // A real runtime dispatches to the older method internally, already carrying
      // the injected route; the inner hook must see it and leave it alone.
      return service.startContinuable(spec)
    },
    async startContinuable(spec) {
      order.push(['continuable', spec.request.agentOptions])
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(service)
  check(
    'both seams: reported most-preferred first',
    JSON.stringify(capability.seams) === '["startActivation","startContinuable"]',
    JSON.stringify(capability.seams)
  )
  await service.startActivation({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('both seams: route injected once', order[0][1]?.model === 'deepseek-flash' && order[1][1]?.model === 'deepseek-flash', JSON.stringify(order))
  check(
    'both seams: one injection log line',
    logs.filter(([, message]) => message.includes('team member label=')).length === 1,
    JSON.stringify(logs.filter(([, message]) => message.includes('team member label=')))
  )
}

// --- 23. a missing seam is a state, not just a warning -------------------
{
  const logs = []
  const service = { getProvider: () => undefined, registerProvider: () => () => {} }
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(service)
  check('capability: unavailable without a creation seam', capability.teamInjection === 'unavailable', JSON.stringify(capability))
  check('capability: names the missing seams', String(capability.reason).includes('startActivation') && String(capability.reason).includes('startContinuable'), String(capability.reason))
  check('capability: disabled is reported as off', capability.enabled === false, JSON.stringify(capability))
  check(
    'capability: one unavailable warning',
    logs.filter(([, message]) => message.includes('team-mode injection unavailable')).length === 1
  )
  check('capability: logged in the startup summary', logs.some(([, message]) => message.includes('capabilities {')))
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness: unavailable is recorded as a state',
    record.mounted === true && record.capabilities.teamInjection === 'unavailable',
    JSON.stringify(record.capabilities)
  )
}

// --- 24. onPinFailure: inherit falls back to the inherited route ---------
{
  const harness = makeHarness({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free', onPinFailure: 'inherit' })
  const attempts = []
  harness.service.getProvider = () => ({
    name: 'spawn',
    capabilities: CAPABILITIES,
    start(request) {
      attempts.push(request)
      if (attempts.length === 1) throw new Error('429 quota exhausted')
      return { started: true, request }
    }
  })
  const result = await harness.provider.start({
    prompt: 'do',
    parent: {},
    label: 'x',
    agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' }
  })
  check('fallback: the dead pin is retried', attempts.length === 2, String(attempts.length))
  check(
    'fallback: retry uses the inherited route',
    result.request.agentOptions.provider === 'deepseek-account' && result.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(result.request.agentOptions)
  )
  check('fallback: warned', harness.logs.some(([, message]) => message.includes('retrying on the inherited route')))
}

// --- 25. a dead pin fails loudly by default (no silent model swap) ------
{
  const harness = makeHarness({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  harness.service.getProvider = () => ({
    name: 'spawn',
    capabilities: CAPABILITIES,
    start() {
      throw new Error('429 quota exhausted')
    }
  })
  let threw
  try {
    await harness.provider.start({ prompt: 'do', parent: {}, label: 'x' })
  } catch (error) {
    threw = error
  }
  check('fail mode: the summon errors instead of swapping models', threw !== undefined && threw.message.includes('429 quota exhausted'))
  check('fail mode: the user-facing text names the route', threw !== undefined && threw.message.includes('our-free-model/deepseek-v4.1-flash-free'))
  check('fail mode: the original error is preserved as the cause', threw?.cause?.message === '429 quota exhausted')
  check('fail mode: nothing is retried on another route', harness.logs.some(([kind]) => kind === 'error'))
}

// --- 25b. an unusable configured route is a finding, not a silent degrade
{
  const harness = makeHarness({ provider: 'no-such-provider', model: 'whatever' })
  let threw
  try {
    await harness.provider.start({ prompt: 'do', parent: {}, label: 'x' })
  } catch (error) {
    threw = error
  }
  check('unusable route: start rejects', threw !== undefined, String(threw))
  check('unusable route: names the provider', threw !== undefined && threw.message.includes('not registered'), threw?.message)
}

// --- 25c. auto-wire writes the agency row, once --------------------------
{
  const root = join(dir, 'profile-autowire')
  mkdirSync(root, { recursive: true })
  const patch = join(root, 'cordis.patch.yml')
  writeFileSync(
    patch,
    [
      '- id: some-plugin',
      '  name: "some"',
      '  config:',
      '    a: 1',
      '- id: agency-agents',
      '  name: "@michengai/dsh-agency-agents"',
      '  config:',
      '    enabled:',
      '      - engineering-software-architect',
      '    customExperts: []',
      ''
    ].join('\n'),
    'utf8'
  )
  const first = wireAgencyProvider(root, 'pinned-account')
  const written = readFileSync(patch, 'utf8')
  check('auto-wire: reports a change', first.changed === true, JSON.stringify(first))
  check('auto-wire: inserts the provider under config', written.includes('  config:\n    provider: pinned-account'))
  check('auto-wire: keeps the rest of the row', written.includes('    customExperts: []'))
  const second = wireAgencyProvider(root, 'pinned-account')
  check('auto-wire: idempotent', second.changed === false && second.reason === 'already wired', JSON.stringify(second))
  check('auto-wire: backs the original up', readFileSync(patch, 'utf8').length > 0)
}
{
  const root = join(dir, 'profile-autowire-replace')
  mkdirSync(root, { recursive: true })
  const patch = join(root, 'cordis.patch.yml')
  writeFileSync(patch, '- id: agency-agents\n  name: "x"\n  config:\n    provider: spawn\n    enabled: []\n', 'utf8')
  wireAgencyProvider(root, 'pinned-account')
  const written = readFileSync(patch, 'utf8')
  check('auto-wire: replaces a foreign provider', written.includes('    provider: pinned-account') && !written.includes('provider: spawn'))
}
{
  const root = join(dir, 'profile-no-agency')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: other\n  name: "x"\n', 'utf8')
  const result = wireAgencyProvider(root, 'pinned-account')
  check('auto-wire: leaves a profile without agency alone', result.changed === false && result.reason === 'no agency-agents row')
}

// --- 26. a member that cannot start on the pin is retried without it ----
{
  const seen = []
  const service = Object.create({
    async startActivation(spec) {
      seen.push(spec.request.agentOptions)
      if (spec.request.agentOptions !== undefined) throw new Error('quota exceeded')
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const result = await service.startActivation({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('team fallback: retried once without the pin', seen.length === 2 && seen[0]?.model === 'deepseek-flash' && seen[1] === undefined, JSON.stringify(seen))
  check('team fallback: member still starts', result.ok === true)
  check('team fallback: warned', logs.some(([, message]) => message.includes('retrying on the inherited route')))
}

// --- 27. the three log lines are a contract -----------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  await harness.service.startActivation({ label: 'Researcher', request: { prompt: 'do', parent: {} } })
  const messages = harness.logs.map(([, message]) => message).join('\n')
  check('log contract: provider delegates', /provider "pinned-account" delegates to "spawn"/.test(messages))
  check('log contract: hook installed', /team-mode hook installed on ctx\.subagents\.startActivation/.test(messages))
  check(
    'log contract: team member -> provider/model',
    /team member label="Researcher" -> deepseek-account\/deepseek-flash/.test(messages)
  )
  check('log contract: capabilities line present', /capabilities \{"teamInjection":"installed"/.test(messages))
}

// --- 28. the readiness record is what a post-upgrade check reads ---------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  check('readiness: record written', record.plugin === 'subagent-route-pin' && record.schema === 1, JSON.stringify(record))
  check('readiness: version matches the manifest', record.version === manifest.version, String(record.version))
  check('readiness: mounted', record.mounted === true)
  check('readiness: capabilities installed', record.capabilities.teamInjection === 'installed', JSON.stringify(record.capabilities))
  check('readiness: route reported', record.providerName === 'pinned-account' && record.baseProvider === 'spawn')
  check('readiness: fallback reported', record.fallback === true)
  check('readiness: overrideMemberRoute reported', record.overrideMemberRoute === true, String(record.overrideMemberRoute))
  check('readiness: teamInjection reported', record.teamInjection === true)
  check('readiness: harness still usable', harness.provider !== undefined)
}

// --- 29. no subagent service is still recorded, as a state --------------
{
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) }
  }
  apply(ctx, { readinessPath })
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check('readiness: absent service is mounted=false', record.mounted === false, JSON.stringify(record))
  check(
    'readiness: absent service names registerProvider',
    String(record.capabilities?.reason).includes('registerProvider'),
    JSON.stringify(record.capabilities)
  )
  check('readiness: absent service warns', logs.some(([, message]) => message.includes('registerProvider is unavailable')))
}

// --- 31. the readiness record names the route actually in force -----------
// A settings file whose `default` is overruled by the config row used to fail
// silently: the JSON said one model, delegations got another, and nothing in the
// readiness record or the logs said which one won.
{
  writeFileSync(
    settingsPath,
    JSON.stringify({ default: { provider: 'deepseek-account', model: 'deepseek-pro' } }),
    'utf8'
  )
  const harness = makeHarness({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness: effective route is the config row',
    record.route === 'our-free-model/deepseek-v4.1-flash-free' && record.routeSource === 'config row',
    JSON.stringify({ route: record.route, routeSource: record.routeSource })
  )
  check(
    'readiness: the shadowed settings default is still reported',
    record.settingsDefault === 'deepseek-account/deepseek-pro' && record.settingsDefaultShadowed === true,
    JSON.stringify({ settingsDefault: record.settingsDefault, shadowed: record.settingsDefaultShadowed })
  )
  check(
    'readiness: a shadowed settings default warns instead of staying silent',
    harness.logs.some(
      ([level, message]) => level === 'warn' && message.includes('settings default is ignored')
    ),
    JSON.stringify(harness.logs.filter(([level]) => level === 'warn'))
  )
  const { forwarded } = await startWith(harness, 'Anything')
  check(
    'readiness: the reported route is the one a delegation gets',
    forwarded.agentOptions.provider === 'our-free-model' &&
      forwarded.agentOptions.model === 'deepseek-v4.1-flash-free',
    JSON.stringify(forwarded.agentOptions)
  )
}

// --- 32. with no config row, the settings default is reported as in force -
{
  writeFileSync(
    settingsPath,
    JSON.stringify({ default: { provider: 'deepseek-account', model: 'deepseek-pro' } }),
    'utf8'
  )
  makeHarness({})
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness: settings default wins when the row is empty',
    record.route === 'deepseek-account/deepseek-pro' && record.routeSource === 'settings default',
    JSON.stringify({ route: record.route, routeSource: record.routeSource })
  )
  check(
    'readiness: an unshadowed settings default does not warn',
    record.settingsDefaultShadowed === false,
    String(record.settingsDefaultShadowed)
  )
}

// --- 30. the peer range must not silently exclude prerelease builds ------
// node-semver only lets a prerelease satisfy a range when some comparator
// shares its exact major.minor.patch tuple *and* itself carries a prerelease
// tag. ">=0.2.0-rc.1 <0.4.0" looks broad, but it drops every 0.2.1-rc.* — the
// build this plugin actually runs on — so npm resolves nothing and the user
// gets an ERESOLVE they have to work around by hand. Each minor needs its own
// "||" branch. This is the regression the compat matrix exists to catch.
{
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  const parseVersion = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
    if (match === null) throw new Error(`unparseable version: ${version}`)
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.')
    }
  }
  const compareCore = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const compareIdentifier = (a, b) => {
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) - Number(b)
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  }
  const comparePre = (a, b) => {
    if (a.length === 0 && b.length === 0) return 0
    if (a.length === 0) return 1
    if (b.length === 0) return -1
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] === undefined) return -1
      if (b[i] === undefined) return 1
      const order = compareIdentifier(a[i], b[i])
      if (order !== 0) return order
    }
    return 0
  }
  const satisfiesComparator = (version, comparator) => {
    const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim())
    if (match === null) throw new Error(`unparseable comparator: ${comparator}`)
    const operator = match[1] ?? '='
    const bound = parseVersion(match[2])
    // Full semver ordering: compare the core, then the prerelease, where a
    // plain version outranks any prerelease of the same tuple.
    const coreOrder = compareCore(version.core, bound.core)
    const order = coreOrder !== 0 ? coreOrder : comparePre(version.pre, bound.pre)
    if (operator === '>=') return order >= 0
    if (operator === '>') return order > 0
    if (operator === '<=') return order <= 0
    if (operator === '<') return order < 0
    return order === 0
  }
  const sameTuple = (a, b) => a.core[0] === b.core[0] && a.core[1] === b.core[1] && a.core[2] === b.core[2]
  const satisfiesRange = (version, range) => {
    const parsed = parseVersion(version)
    return range.split('||').some((branch) => {
      const comparators = branch.trim().split(/\s+/)
      if (!comparators.every((comparator) => satisfiesComparator(parsed, comparator))) return false
      // node-semver's prerelease gate is per comparator *set*: a prerelease
      // only passes when some comparator in the same set shares its exact
      // major.minor.patch tuple and itself carries a prerelease tag. This is
      // why ">=0.2.0-rc.1 <0.4.0" admits 0.2.0-rc.1 but not 0.2.1-rc.2.
      if (parsed.pre.length === 0) return true
      return comparators.some((comparator) => {
        const bound = parseVersion(comparator.replace(/^(>=|<=|>|<|=)\s*/, ''))
        return sameTuple(parsed, bound) && bound.pre.length > 0
      })
    })
  }

  const supported = ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1']
  const refused = ['0.1.9', '0.4.0-rc.1', '0.4.0', '0.5.0']

  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tool-subagent']) {
    const range = manifest.peerDependencies[name]
    check(`peer range: ${name} is declared`, typeof range === 'string' && range.length > 0, String(range))
    if (typeof range !== 'string') continue
    const missed = supported.filter((version) => !satisfiesRange(version, range))
    check(
      `peer range: ${name} admits every supported build`,
      missed.length === 0,
      `excluded ${missed.join(', ')} — a bare ">=a-rc.1 <b" drops every later rc; each minor needs its own branch`
    )
    const leaked = refused.filter((version) => satisfiesRange(version, range))
    check(`peer range: ${name} stays below 0.4.0`, leaked.length === 0, `wrongly admitted ${leaked.join(', ')}`)
  }

  // The market index filters the Discover tab by `engines.dsh`, and the plugin
  // manager gates installs by `peerDependencies`. Two copies of the same range
  // drift the moment one is edited, and the drift is invisible: the package
  // lists fine but installs nowhere. Keep them byte-identical.
  const engineRange = manifest.engines?.dsh
  check('engines.dsh is declared', typeof engineRange === 'string' && engineRange.length > 0, String(engineRange))
  check(
    'engines.dsh matches the @deepseek-ai/dsh peer range',
    engineRange === manifest.peerDependencies?.['@deepseek-ai/dsh'],
    `engines.dsh=${String(engineRange)} vs peer=${String(manifest.peerDependencies?.['@deepseek-ai/dsh'])} — the market's Discover filter reads engines.dsh, install reads peerDependencies; one range, two copies`
  )

  // npm silently DELETES a bin entry whose path starts with "./" ("script name
  // bin/x.mjs was invalid and removed") and the publish still succeeds — the
  // installed package just has no command. Caught here instead of after publish.
  const binEntries = Object.entries(manifest.bin ?? {})
  check('bin is declared', binEntries.length > 0, `bin=${JSON.stringify(manifest.bin)}`)
  for (const [name, target] of binEntries) {
    check(`bin ${name}: no leading ./`, !String(target).startsWith('./'), String(target))
    check(`bin ${name}: file exists`, existsSync(new URL(`../${target}`, import.meta.url)), String(target))
  }
}

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
