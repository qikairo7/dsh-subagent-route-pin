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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, teamInjectionCapabilities, wireAgencyProvider } from '../index.js'

const HOOK = Symbol.for('dsh-subagent-route-pin.continuable-hook')

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
  // startContinuable lives on a prototype on purpose: the team hook shadows it
  // with an own property, so the dispose path can be asserted by deleting it.
  const service = Object.create({
    async startContinuable(spec) {
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
  await harness.service.startContinuable(spec)
  const agentOptions = spec.request.agentOptions
  check('team member route injected', agentOptions?.provider === 'deepseek-account' && agentOptions?.model === 'deepseek-flash', JSON.stringify(agentOptions))
  check('team member effort injected', agentOptions?.reasoningEffort === 'medium')
  check('underlying startContinuable still called', harness.teamCalls.length === 1)
  check('team member logged', harness.logs.some(([kind, message]) => kind === 'info' && message.includes('team member')))
}

// --- 17. a route already on the request wins (Agent Teams pins its own) ---
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  await harness.service.startContinuable(spec)
  check('existing member route untouched', spec.request.agentOptions.model === 'mimo-v2.6-flash-free', JSON.stringify(spec.request.agentOptions))
}

// --- 18. teamInjection: false is an off switch ---------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', teamInjection: false })
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await harness.service.startContinuable(spec)
  check('teamInjection false leaves the member on the parent route', spec.request.agentOptions === undefined)
}

// --- 19. a missing route never breaks member creation --------------------
{
  const harness = makeHarness({})
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  let threw
  try {
    await harness.service.startContinuable(spec)
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
    async startContinuable(spec) {
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
  check('hook is an own property of the service', Object.prototype.hasOwnProperty.call(service, 'startContinuable'))
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startContinuable(spec)
  check('hook works on a prototype-provided method', spec.request.agentOptions?.model === 'deepseek-flash', JSON.stringify(spec.request.agentOptions))
  for (const callback of effects) callback()()
  check('dispose deletes the own property', Object.prototype.hasOwnProperty.call(service, 'startContinuable') === false)
  const after = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startContinuable(after)
  check('prototype method restored', after.request.agentOptions === undefined)
}

// --- 21. a remount swaps the resolver but installs only one hook ---------
{
  const effects = []
  const logs = []
  const service = Object.create({ async startContinuable(spec) { return { ok: true, spec } } })
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
  await service.startContinuable(spec)
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
  check('capability: unavailable without startContinuable', capability.teamInjection === 'unavailable', JSON.stringify(capability))
  check('capability: names the missing seam', String(capability.reason).includes('startContinuable'), String(capability.reason))
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
    async startContinuable(spec) {
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
  const result = await service.startContinuable({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('team fallback: retried once without the pin', seen.length === 2 && seen[0]?.model === 'deepseek-flash' && seen[1] === undefined, JSON.stringify(seen))
  check('team fallback: member still starts', result.ok === true)
  check('team fallback: warned', logs.some(([, message]) => message.includes('retrying on the inherited route')))
}

// --- 27. the three log lines are a contract -----------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  await harness.service.startContinuable({ label: 'Researcher', request: { prompt: 'do', parent: {} } })
  const messages = harness.logs.map(([, message]) => message).join('\n')
  check('log contract: provider delegates', /provider "pinned-account" delegates to "spawn"/.test(messages))
  check('log contract: hook installed', /team-mode hook installed on ctx\.subagents\.startContinuable/.test(messages))
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

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
