/**
 * dsh-subagent-route-pin — Host half.
 *
 * Registers ONE extra subagent provider that delegates to an already-registered
 * provider (default `spawn`) while pinning the child LLM route. The framework
 * lets a delegating agent inherit its own route into every child; a provider
 * wrapper is the only place where a child's route can still be chosen before
 * the child Agent is created, because `SubagentManager.start` hands the request
 * to `provider.start(request)`.
 *
 * Route resolution, highest priority first:
 *   1. settings file `experts[<label>]`   — per-expert override (advanced, optional)
 *   2. this plugin's config row           — the normal control (Settings → Plugins)
 *   3. settings file `default`            — legacy fallback, only when the row has no route
 *
 * The config-row fields `provider` / `model` / `reasoningEffort` / `maxTokens`
 * are declared `volatile()`: the Host settings service writes them into the
 * profile patch and the Cordis loader updates this module's live config without
 * remounting it. They are therefore read through an accessor on every spawn, so
 * a change applies to the next delegation with no restart.
 *
 * The settings file is re-read on every `start()` (content-compared), so per
 * expert overrides also switch without a restart. An unreadable or malformed
 * file falls back to the last successful parse, then to the config row.
 *
 * Resolved routes are checked against `ctx.llm` catalogs on a best-effort
 * basis — catalog membership is advisory in DSH, so a mismatch warns and falls
 * back instead of blocking, unless `strict: true`.
 *
 * The team-mode hook is wrapped in `TeamInjectionAdapter`, which probes the
 * `ctx.subagents.startContinuable` seam once and publishes a capability flag
 * (`{ teamInjection: 'installed' | 'unavailable', enabled, reason }`) on the
 * service under `Symbol.for('dsh-subagent-route-pin.continuable-hook')`. A
 * caller that sees `unavailable` knows team members keep the parent route and
 * can degrade deliberately instead of trusting a log line.
 *
 * `fallback` (default on) makes a failed pin non-fatal: if the wrapped
 * provider's `start()` rejects, the request is retried once on the route the
 * caller already had (the parent/inherited route); a team member whose
 * `startContinuable()` rejects is retried with `request.agentOptions` removed.
 * Only start-time failures are observable at this seam — a quota error raised
 * later, inside the child's own LLM stream, cannot be caught here.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'subagent-route-pin'

export const inject = ['subagents', 'llm']

/** Verbatim copy of the `spawn` provider's start-time capabilities. */
const CAPABILITIES = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true
}

const SUCCESS_CACHE_MS = 10 * 60 * 1000
const FAILURE_CACHE_MS = 60 * 1000

/** Marks the service object that already carries this plugin's team hook. */
const CONTINUABLE_HOOK = Symbol.for('dsh-subagent-route-pin.continuable-hook')

const PLUGIN = 'subagent-route-pin'

const DEFAULT_SETTINGS_PATH = join(homedir(), '.dsh', 'subagent-route-pin.json')

/**
 * Where this plugin records its own readiness.
 *
 * `ctx.logger.info` reaches the DSH process console (visible in the GUI's dev
 * console or the terminal DSH was started from) but is not persisted, and
 * `~/.dsh/logs/startup-*.log` is a diagnostics dump written only when startup
 * FAILS. A post-upgrade check therefore needs a file it can read: one small JSON
 * record per boot, overwritten each time.
 */
const DEFAULT_READINESS_PATH = join(homedir(), '.dsh', 'subagent-route-pin.ready.json')

/** Plugin version, read once; a missing package.json is not fatal. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return undefined
  }
})()

/**
 * Publish the readiness record. Never throws: a read-only home directory must not
 * take the profile down, it only costs the post-upgrade check its evidence.
 */
function recordReadiness(path, record) {
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return describeError(error)
  }
}

/** Read a config value that may be a live accessor (volatile) or plain. */
function valueOf(field) {
  if (typeof field === 'function') return field()
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * Schema for the config form (Settings → Plugins). The bare specifier resolves
 * through the DSH loader; when this bundle is linked from outside the profile
 * tree that resolution fails, so every profile under `~/.dsh/profiles` is probed
 * as a fallback. Without a schema the plugin still pins routes from the settings
 * file, it just has no form.
 */
async function loadSchemastery() {
  const candidates = ['@deepseek-ai/schemastery']
  let profiles = []
  try {
    profiles = readdirSync(join(homedir(), '.dsh', 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    profiles = []
  }
  for (const profile of profiles) {
    for (const file of ['lib/index.mjs', 'lib/index.js']) {
      candidates.push(
        pathToFileURL(join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery', file)).href
      )
    }
  }
  for (const specifier of candidates) {
    try {
      const loaded = await import(specifier)
      const schema = loaded.default ?? loaded
      if (typeof schema?.object === 'function') return schema
    } catch {
      /* try the next specifier */
    }
  }
  return undefined
}

/** Build the config schema; a missing or incompatible schemastery is not fatal. */
function makeConfig(z) {
  if (z === undefined) return undefined
  try {
    return z.object({
      providerName: z.string().default('pinned-account'),
      baseProvider: z.string().default('spawn'),
      settingsPath: z.string().default(DEFAULT_SETTINGS_PATH),
      readinessPath: z.string().default(DEFAULT_READINESS_PATH),
      strict: z.boolean().default(false),
      fallback: z.boolean().default(true),
      teamInjection: z.boolean().default(true).volatile(),
      provider: z.string().volatile(),
      model: z.string().volatile(),
      reasoningEffort: z.string().volatile(),
      maxTokens: z.number().step(1).min(1).volatile()
    })
  } catch {
    return undefined
  }
}

/**
 * Config schema exported under the name the Cordis loader reads. `volatile()`
 * on the route fields is what lets the Settings page write them into the live
 * config without remounting this plugin.
 */
export const Config = makeConfig(await loadSchemastery())

function text(value, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${PLUGIN}: ${field} must be a non-empty string`)
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PLUGIN}: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Validate one `{ provider, model, reasoningEffort?, maxTokens? }` route.
 * `optional` lets the whole route be absent (the row may carry none and leave
 * every decision to the settings file).
 */
function normalizeRoute(value, field, optional = false) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PLUGIN}: ${field} must be an object with provider and model`)
  }
  const provider = value.provider
  const model = value.model
  if (
    optional &&
    (provider === undefined || provider === '') &&
    (model === undefined || model === '') &&
    (value.reasoningEffort === undefined || value.reasoningEffort === '') &&
    (value.maxTokens === undefined || value.maxTokens === null)
  ) {
    return undefined
  }
  const route = {
    provider: text(provider, `${field}.provider`),
    model: text(model, `${field}.model`)
  }
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null && value.reasoningEffort !== '') {
    route.reasoningEffort = text(value.reasoningEffort, `${field}.reasoningEffort`)
  }
  if (value.maxTokens !== undefined && value.maxTokens !== null) {
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0) {
      throw new Error(`${PLUGIN}: ${field}.maxTokens must be a positive integer`)
    }
    route.maxTokens = value.maxTokens
  }
  return route
}

function routeKey(route) {
  return `${route.provider}/${route.model}`
}

/** One-line rendering for logs; never throws on odd thrown values. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeSettings(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the settings root must be a JSON object')
  }
  const settings = { default: normalizeRoute(parsed.default, 'default'), experts: new Map(), match: 'exact' }
  if (parsed.match !== undefined) {
    if (parsed.match !== 'exact' && parsed.match !== 'contains') {
      throw new Error('match must be "exact" or "contains"')
    }
    settings.match = parsed.match
  }
  if (parsed.experts !== undefined && parsed.experts !== null) {
    if (typeof parsed.experts !== 'object' || Array.isArray(parsed.experts)) {
      throw new Error('experts must be an object keyed by expert name')
    }
    for (const [key, value] of Object.entries(parsed.experts)) {
      const route = normalizeRoute(value, `experts[${JSON.stringify(key)}]`)
      if (route !== undefined) settings.experts.set(key.trim().toLowerCase(), route)
    }
  }
  return settings
}

/**
 * The route-pinning provider. Everything is resolved lazily: the base provider
 * is looked up per call (this plugin may be applied before the spawn provider
 * registers), the config row is read through live accessors, and the settings
 * file is re-read per call (hot switching).
 */
class RoutePinProvider {
  capabilities = CAPABILITIES

  constructor(options) {
    this.options = options
    // `registerProvider` keys the provider table by `provider.name`, so the
    // wrapper must expose the configured name (it is not a class name).
    this.name = options.config.providerName
  }

  base() {
    const { ctx, config } = this.options
    if (typeof ctx.subagents.getProvider !== 'function') {
      throw new Error(`${PLUGIN}: ctx.subagents.getProvider is unavailable in this DSH build`)
    }
    const provider = ctx.subagents.getProvider(config.baseProvider)
    if (provider === undefined || provider === null) {
      throw new Error(`${PLUGIN}: base subagent provider "${config.baseProvider}" is not registered`)
    }
    return provider
  }

  get inheritsParentContext() {
    try {
      return this.base().inheritsParentContext === true
    } catch {
      return false
    }
  }

  prepareContinuable(request) {
    const base = this.base()
    if (typeof base.prepareContinuable !== 'function') {
      throw new Error(`${PLUGIN}: base provider "${this.options.config.baseProvider}" has no prepareContinuable`)
    }
    return base.prepareContinuable(request)
  }

  /**
   * The route currently configured on the plugin row, read live.
   *
   * Volatile fields are served as accessors whose identity survives a settings
   * write, so the captured config object is normally enough. `ctx.config` is
   * consulted as a second source in case a loader generation swapped the
   * accessors underneath us; a source without both fields is skipped instead of
   * raising, so an unrelated shape can never break a working route.
   */
  configuredRoute() {
    const { ctx, config } = this.options
    const sources = [config]
    const live = ctx.config
    if (live !== undefined && live !== null && live !== config) sources.push(live)
    for (const source of sources) {
      const provider = valueOf(source.provider)
      const model = valueOf(source.model)
      if (typeof provider !== 'string' || provider.trim() === '') continue
      if (typeof model !== 'string' || model.trim() === '') continue
      return normalizeRoute(
        {
          provider,
          model,
          reasoningEffort: valueOf(source.reasoningEffort),
          maxTokens: valueOf(source.maxTokens)
        },
        'config',
        true
      )
    }
    return undefined
  }

  /** Re-read the settings file, keeping the last good parse on failure. */
  readSettings() {
    const { ctx, config, state } = this.options
    let source
    try {
      source = readFileSync(config.settingsPath, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        if (state.settingsText !== undefined) {
          state.settingsText = undefined
          state.settings = undefined
          ctx.logger.info(`${PLUGIN}: ${config.settingsPath} removed; using the config row`)
        }
        return undefined
      }
      ctx.logger.warn(`${PLUGIN}: cannot read ${config.settingsPath}: ${String(error)}`)
      return state.settings
    }
    if (source === state.settingsText) return state.settings
    state.settingsText = source
    try {
      const settings = normalizeSettings(JSON.parse(source))
      state.settings = settings
      ctx.logger.info(
        `${PLUGIN}: settings reloaded from ${config.settingsPath} ` +
          `(match=${settings.match}, experts=${settings.experts.size}, default=${settings.default === undefined ? 'none' : routeKey(settings.default)})`
      )
      return settings
    } catch (error) {
      ctx.logger.warn(
        `${PLUGIN}: ignoring ${config.settingsPath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return state.settings
    }
  }

  /**
   * Resolve the route for one child. Per-expert overrides win, then the row the
   * Settings page writes, then a legacy `default` in the settings file.
   */
  resolve(label, settings, configured) {
    if (settings !== undefined) {
      const key = typeof label === 'string' ? label.trim().toLowerCase() : ''
      if (key !== '') {
        const exact = settings.experts.get(key)
        if (exact !== undefined) return { route: exact, source: `experts[${JSON.stringify(key)}]` }
        if (settings.match === 'contains') {
          for (const [candidate, route] of settings.experts) {
            if (key.includes(candidate)) return { route, source: `experts[${JSON.stringify(candidate)}] (contains)` }
          }
        }
      }
    }
    if (configured !== undefined) return { route: configured, source: 'config row' }
    if (settings !== undefined && settings.default !== undefined) return { route: settings.default, source: 'settings default' }
    throw new Error(
      `${PLUGIN}: no route for expert ${JSON.stringify(label ?? null)} — ` +
        `pick a model in Settings → 专家模型 (the plugin's own page), or put a "default" route in ${this.options.config.settingsPath}`
    )
  }

  /**
   * Best-effort catalog check. DSH treats catalog membership as advisory, so a
   * miss returns a problem string instead of throwing; `strict` turns it fatal.
   */
  async checkRoute(route) {
    const { ctx, state } = this.options
    const key = routeKey(route)
    const cached = state.checked.get(key)
    const now = Date.now()
    if (cached !== undefined) {
      const ttl = cached.problem === undefined ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS
      if (now - cached.at < ttl) return cached.problem
    }
    let problem
    try {
      const providers = ctx.llm.listProviders()
      const known = providers.some((provider) => provider.id === route.provider)
      if (!known) {
        problem = `provider "${route.provider}" is not registered (available: ${providers.map((provider) => provider.id).join(', ') || 'none'})`
      } else {
        const models = await ctx.llm.listModels(route.provider)
        if (!models.some((model) => model.id === route.model)) {
          problem = `provider "${route.provider}" does not advertise model "${route.model}" (advertised: ${models.map((model) => model.id).join(', ')})`
        }
      }
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: route check skipped for ${key}: ${error instanceof Error ? error.message : String(error)}`)
      problem = undefined
    }
    state.checked.set(key, { at: now, problem })
    return problem
  }

  /**
   * Resolve + validate the route for one label.
   *
   * Returns `undefined` when no usable route exists and `strict` is off: the
   * child then simply inherits the parent's route, which is exactly what a
   * freshly installed plugin with no configuration should do. A missing route
   * must never make a delegation fail — that would turn an optional feature into
   * an outage on every machine that forgot one line of YAML.
   *
   * `soft: true` (team mode) additionally swallows a strict-mode throw, because a
   * broken route must not take member creation down with it.
   */
  async pickRoute(label, soft = false) {
    const { ctx, config } = this.options
    const strict = config.strict === true
    try {
      const settings = this.readSettings()
      const configured = this.configuredRoute()
      const picked = this.resolve(label, settings, configured)
      let route = picked.route
      let source = picked.source
      const problem = await this.checkRoute(route)
      if (problem !== undefined) {
        const message = `${PLUGIN}: ${problem} (route came from ${source})`
        if (strict) throw new Error(message)
        if (configured === undefined) {
          ctx.logger.warn(`${message}; no fallback route, so the child inherits the parent model`)
          return undefined
        }
        ctx.logger.warn(`${message}; falling back to the config row ${routeKey(configured)}`)
        route = configured
        source = 'config row (fallback)'
      }
      return { route, source }
    } catch (error) {
      if (strict && soft !== true) throw error
      ctx.logger.warn(
        `${PLUGIN}: no usable route, the child inherits the parent model: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
  }

  async start(request) {
    const { ctx, config } = this.options
    const label = request !== null && typeof request === 'object' ? request.label : undefined
    const base = this.base()
    const picked = await this.pickRoute(label)
    if (picked === undefined) {
      // Zero-config install (or a route that no longer exists): delegate untouched
      // so the child inherits the parent route instead of the summon failing.
      ctx.logger.info(
        `${PLUGIN}: label=${JSON.stringify(label ?? null)} -> inherited (no pinned route configured)`
      )
      return base.start({ ...request })
    }
    const { route, source } = picked
    const agentOptions = { ...(request.agentOptions ?? {}), provider: route.provider, model: route.model }
    if (route.reasoningEffort !== undefined) agentOptions.reasoningEffort = route.reasoningEffort
    if (route.maxTokens !== undefined) agentOptions.maxTokens = route.maxTokens
    ctx.logger.info(
      `${PLUGIN}: label=${JSON.stringify(label ?? null)} -> ${routeKey(route)}` +
        `${route.reasoningEffort === undefined ? '' : ` effort=${route.reasoningEffort}`} (${source})`
    )
    try {
      return await base.start({ ...request, agentOptions })
    } catch (error) {
      // The pinned route is the one most likely to run dry (a free lane), so a
      // start-time failure must not be the end of the delegation: retry once on
      // whatever route the caller already had (normally the parent's).
      const inherited = request.agentOptions
      const sameRoute = inherited !== undefined && inherited.provider === route.provider && inherited.model === route.model
      if (config.fallback !== true || sameRoute) throw error
      ctx.logger.warn(
        `${PLUGIN}: pinned route ${routeKey(route)} failed to start (${describeError(error)}); ` +
          `retrying on the inherited route ${inherited === undefined ? '(parent default)' : routeKey(inherited)}`
      )
      return base.start({ ...request })
    }
  }
}

/** Values of the `teamInjection` capability flag. */
const TEAM_INJECTION_INSTALLED = 'installed'
const TEAM_INJECTION_UNAVAILABLE = 'unavailable'

/**
 * Team-mode hook, behind an adapter.
 *
 * Continuable children (Agent-Teams members, agency's native engine) never pass
 * through `provider.start(request)`: `SubagentManager.startContinuable()` reads
 * `spec.request.agentOptions` on line 1680 and hands the resulting route to
 * `agents.create()` itself. Filling that field before the call is therefore the
 * only injection point, and the service object is not frozen, so one own
 * property on `ctx.subagents` covers it.
 *
 * The adapter turns a missing seam into a *state* instead of a log line:
 * `probe()` records why injection is impossible, `capabilities()` publishes
 * `{ teamInjection, enabled, reason }`, and a caller reads it from
 * `service[Symbol.for('dsh-subagent-route-pin.continuable-hook')].capabilities`
 * (or via `teamInjectionCapabilities(service)`) to decide whether to degrade.
 *
 * The hook is installed at most once per service; later plugin generations only
 * swap the resolver, so a remount never double-wraps. Injection never throws: a
 * missing route leaves the member on the inherited (parent) route, and with
 * `fallback` on, a rejected `startContinuable()` is retried once without the
 * injected route instead of failing the delegation.
 */
class TeamInjectionAdapter {
  constructor(ctx) {
    this.ctx = ctx
    this.service = ctx.subagents
    this.installed = false
    this.reason = undefined
  }

  /** Probe the seam without mutating anything. */
  probe() {
    const service = this.service
    if (service === null || service === undefined) {
      return { teamInjection: TEAM_INJECTION_UNAVAILABLE, reason: 'ctx.subagents is unavailable in this DSH build' }
    }
    if (typeof service.startContinuable !== 'function') {
      return {
        teamInjection: TEAM_INJECTION_UNAVAILABLE,
        reason: 'ctx.subagents.startContinuable is not exposed by this DSH build'
      }
    }
    return { teamInjection: TEAM_INJECTION_INSTALLED, reason: undefined }
  }

  /**
   * Capability snapshot. `enabled` mirrors the live (volatile) `teamInjection`
   * switch, so a caller can tell "cannot inject" from "turned off".
   */
  capabilities() {
    if (!this.installed) {
      return { teamInjection: TEAM_INJECTION_UNAVAILABLE, enabled: false, reason: this.reason }
    }
    const slot = this.service === null || this.service === undefined ? undefined : this.service[CONTINUABLE_HOOK]
    let enabled
    if (slot !== undefined && typeof slot.resolve === 'function') {
      const provider = slot.resolve()
      if (provider !== undefined) enabled = valueOf(provider.options.config.teamInjection) !== false
    }
    return {
      teamInjection: this.installed ? TEAM_INJECTION_INSTALLED : TEAM_INJECTION_UNAVAILABLE,
      enabled,
      reason: this.reason
    }
  }

  /** Install the hook once, or swap the resolver on a later generation. */
  install(resolveProvider) {
    const service = this.service
    const ctx = this.ctx
    const probe = this.probe()
    if (probe.teamInjection === TEAM_INJECTION_UNAVAILABLE) {
      this.installed = false
      this.reason = probe.reason
      // Publish the negative result too: a caller that looks at the service after
      // a failed probe must be able to read *why* team injection is off.
      if (service !== null && service !== undefined) {
        service[CONTINUABLE_HOOK] = {
          capabilities: { teamInjection: TEAM_INJECTION_UNAVAILABLE, enabled: false, reason: probe.reason }
        }
      }
      ctx.logger.warn(
        `${PLUGIN}: team-mode injection unavailable (${probe.reason}); team-mode members keep the parent route`
      )
      return this
    }
    const existing = service[CONTINUABLE_HOOK]
    if (existing !== undefined && existing.adapter !== undefined) {
      existing.resolve = resolveProvider
      this.installed = true
      this.reason = undefined
      return this
    }
    const raw = service.startContinuable
    const hadOwn = Object.prototype.hasOwnProperty.call(service, 'startContinuable')
    const slot = { resolve: resolveProvider, raw, hadOwn, adapter: this }
  const hook = async function startContinuable(spec) {
    const request = spec !== null && typeof spec === 'object' ? spec.request : undefined
    let injected
    try {
      const provider = slot.resolve()
      if (
        provider !== undefined &&
        // Read live: `teamInjection` is volatile, so the Settings page can switch
        // it without remounting this plugin.
        valueOf(provider.options.config.teamInjection) !== false &&
        request !== null &&
        typeof request === 'object' &&
        request.agentOptions === undefined
      ) {
        const picked = await provider.pickRoute(spec.label, true)
        if (picked !== undefined) {
          const agentOptions = { provider: picked.route.provider, model: picked.route.model }
          if (picked.route.reasoningEffort !== undefined) agentOptions.reasoningEffort = picked.route.reasoningEffort
          if (picked.route.maxTokens !== undefined) agentOptions.maxTokens = picked.route.maxTokens
          request.agentOptions = agentOptions
          injected = picked
          ctx.logger.info(
            `${PLUGIN}: team member label=${JSON.stringify(spec.label ?? null)} -> ` +
              `${routeKey(picked.route)}${picked.route.reasoningEffort === undefined ? '' : ` effort=${picked.route.reasoningEffort}`} (${picked.source})`
          )
        }
      }
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: team member route injection skipped: ${describeError(error)}`)
    }
    try {
      return await raw.call(service, spec)
    } catch (error) {
      // A member that cannot start on the pinned route must not lose the whole
      // delegation: drop the injection and retry once on the inherited route.
      if (injected === undefined) throw error
      const live = slot.resolve()
      if (live === undefined || live.options.config.fallback !== true) throw error
      delete request.agentOptions
      ctx.logger.warn(
        `${PLUGIN}: team member ${JSON.stringify(spec.label ?? null)} failed to start on ${routeKey(injected.route)} ` +
          `(${describeError(error)}); retrying on the inherited route`
      )
      return raw.call(service, spec)
    }
  }
    try {
      Object.defineProperty(service, 'startContinuable', {
        value: hook,
        enumerable: false,
        configurable: true,
        writable: true
      })
    } catch (error) {
      this.installed = false
      this.reason = `cannot define ctx.subagents.startContinuable (${describeError(error)})`
      ctx.logger.warn(`${PLUGIN}: ${this.reason}; team-mode members keep the parent route`)
      return this
    }
    Object.defineProperty(slot, 'capabilities', { get: () => this.capabilities(), enumerable: true })
    service[CONTINUABLE_HOOK] = slot
    this.installed = true
    this.reason = undefined
    ctx.logger.info(`${PLUGIN}: team-mode hook installed on ctx.subagents.startContinuable`)
    return this
  }

  /** Remove this generation's hook, restoring whatever ran before it. */
  dispose(resolveProvider) {
    const service = this.service
    const current = service === null || service === undefined ? undefined : service[CONTINUABLE_HOOK]
    if (current === undefined || current.resolve !== resolveProvider) return
    if (current.hadOwn) service.startContinuable = current.raw
    else delete service.startContinuable
    delete service[CONTINUABLE_HOOK]
    this.installed = false
  }
}

/**
 * Public read-only view of the team-injection capability. Callers that hold the
 * `ctx.subagents` service can ask whether team-mode routing is live instead of
 * grepping the log.
 */
export function teamInjectionCapabilities(service) {
  const slot = service === null || service === undefined ? undefined : service[CONTINUABLE_HOOK]
  if (slot === undefined) {
    return {
      teamInjection: TEAM_INJECTION_UNAVAILABLE,
      enabled: undefined,
      reason: 'the route-pin hook is not installed on this service'
    }
  }
  // A failed probe records its reason instead of installing a hook.
  if (slot.adapter === undefined) return { ...slot.capabilities }
  return slot.adapter.capabilities()
}

export function apply(ctx, config = {}) {
  const readinessPath = text(valueOf(config.readinessPath), 'config.readinessPath', DEFAULT_READINESS_PATH)
  if (
    ctx.subagents === undefined ||
    ctx.subagents === null ||
    typeof ctx.subagents.registerProvider !== 'function'
  ) {
    // A DSH build without the subagent service, or a future rename of it: refuse
    // loudly instead of throwing, so the rest of the profile still boots.
    ctx.logger.warn(`${PLUGIN}: ctx.subagents.registerProvider is unavailable; no route is pinned`)
    // Record the failure too: "the plugin is gone" is exactly what a post-upgrade
    // check must be able to distinguish from "the plugin was never installed".
    recordReadiness(readinessPath, {
      schema: 1,
      plugin: PLUGIN,
      version: PLUGIN_VERSION,
      at: new Date().toISOString(),
      node: process.version,
      processId: process.pid,
      mounted: false,
      capabilities: {
        teamInjection: TEAM_INJECTION_UNAVAILABLE,
        enabled: false,
        reason: 'ctx.subagents.registerProvider is unavailable in this DSH build'
      }
    })
    return
  }
  const settingsPath = text(valueOf(config.settingsPath), 'config.settingsPath', DEFAULT_SETTINGS_PATH)
  const normalized = {
    providerName: text(valueOf(config.providerName), 'config.providerName', 'pinned-account'),
    baseProvider: text(valueOf(config.baseProvider), 'config.baseProvider', 'spawn'),
    settingsPath,
    readinessPath,
    strict: valueOf(config.strict) === true,
    // Default on: a dead pinned lane must degrade, not fail the delegation.
    fallback: valueOf(config.fallback) !== false,
    teamInjection: config.teamInjection,
    // Volatile fields stay as their live accessors; the provider reads them per spawn.
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens
  }
  const state = { settings: undefined, settingsText: undefined, checked: new Map() }
  const provider = new RoutePinProvider({ ctx, config: normalized, state })
  let disposeProvider
  try {
    disposeProvider = ctx.subagents.registerProvider(provider)
    ctx.logger.info(
      `${PLUGIN}: provider "${normalized.providerName}" delegates to "${normalized.baseProvider}", ` +
        `settings ${normalized.settingsPath}`
    )
  } catch (error) {
    // A provider with this name already exists (another generation of this plugin
    // is still mounted): keep serving with it instead of failing the whole plugin,
    // because the extra provider only adds routes.
    ctx.logger.warn(
      `${PLUGIN}: provider "${normalized.providerName}" not registered ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        `agency-agents routes through "${normalized.providerName}" keep using the existing instance`
    )
  }
  if (disposeProvider !== undefined) {
    // The subagent service registers the provider inside ITS OWN effect scope, so a
    // remount of this plugin (toggle, non-volatile config edit, reload generation)
    // would otherwise hit DUPLICATE_PROVIDER. Tie the removal to this fiber instead.
    try {
      ctx.effect(() => () => disposeProvider(), `${PLUGIN}: provider`)
    } catch (error) {
      ctx.logger.warn(
        `${PLUGIN}: cannot scope the provider disposer: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  // Team mode: continuable children bypass provider.start(), so their route has to
  // be filled into the request before SubagentManager reads it.
  const resolveProvider = () => provider
  const adapter = new TeamInjectionAdapter(ctx).install(resolveProvider)
  // One canonical readiness line + a machine-readable flag, so a deploy check can
  // assert "team injection is live" without pattern-matching a WARN.
  const capability = adapter.capabilities()
  ctx.logger.info(`${PLUGIN}: capabilities ${JSON.stringify(capability)}`)
  const readinessError = recordReadiness(normalized.readinessPath, {
    schema: 1,
    plugin: PLUGIN,
    version: PLUGIN_VERSION,
    at: new Date().toISOString(),
    node: process.version,
    processId: process.pid,
    mounted: true,
    providerName: normalized.providerName,
    baseProvider: normalized.baseProvider,
    settingsPath: normalized.settingsPath,
    fallback: normalized.fallback,
    teamInjection: normalized.teamInjection !== false,
    capabilities: capability
  })
  if (readinessError !== undefined) {
    ctx.logger.warn(
      `${PLUGIN}: cannot write the readiness record ${normalized.readinessPath} (${readinessError}); ` +
        'the post-upgrade check has to read the console log instead'
    )
  }
  if (adapter.installed) {
    try {
      ctx.effect(() => () => adapter.dispose(resolveProvider), `${PLUGIN}: team hook`)
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: cannot scope the team hook disposer: ${describeError(error)}`)
    }
  }
}
