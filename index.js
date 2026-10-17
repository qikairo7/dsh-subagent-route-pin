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
 */

import { readFileSync, readdirSync } from 'node:fs'
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
      strict: z.boolean().default(false),
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
   * `soft: true` is the team-mode variant: a missing or unusable route must not
   * break member creation, so it warns and returns undefined (the member then
   * inherits the parent route, i.e. today's default behaviour).
   */
  async pickRoute(label, soft = false) {
    const { ctx, config } = this.options
    try {
      const settings = this.readSettings()
      const configured = this.configuredRoute()
      const picked = this.resolve(label, settings, configured)
      let route = picked.route
      let source = picked.source
      const problem = await this.checkRoute(route)
      if (problem !== undefined) {
        const message = `${PLUGIN}: ${problem} (route came from ${source})`
        if (config.strict === true) throw new Error(message)
        if (configured === undefined) throw new Error(`${message}; the config row has no fallback route`)
        ctx.logger.warn(`${message}; falling back to the config row ${routeKey(configured)}`)
        route = configured
        source = 'config row (fallback)'
      }
      return { route, source }
    } catch (error) {
      if (soft !== true) throw error
      ctx.logger.warn(
        `${PLUGIN}: team member keeps the inherited route: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
  }

  async start(request) {
    const { ctx } = this.options
    const label = request !== null && typeof request === 'object' ? request.label : undefined
    const { route, source } = await this.pickRoute(label)
    const agentOptions = { ...(request.agentOptions ?? {}), provider: route.provider, model: route.model }
    if (route.reasoningEffort !== undefined) agentOptions.reasoningEffort = route.reasoningEffort
    if (route.maxTokens !== undefined) agentOptions.maxTokens = route.maxTokens
    ctx.logger.info(
      `${PLUGIN}: label=${JSON.stringify(label ?? null)} -> ${routeKey(route)}` +
        `${route.reasoningEffort === undefined ? '' : ` effort=${route.reasoningEffort}`} (${source})`
    )
    return this.base().start({ ...request, agentOptions })
  }
}

/**
 * Team-mode hook.
 *
 * Continuable children (Agent-Teams members, agency's native engine) never pass
 * through `provider.start(request)`: `SubagentManager.startContinuable()` reads
 * `spec.request.agentOptions` on line 1680 and hands the resulting route to
 * `agents.create()` itself. Filling that field before the call is therefore the
 * only injection point, and the service object is not frozen, so one own
 * property on `ctx.subagents` covers it.
 *
 * The hook is installed at most once per service; later plugin generations only
 * swap the resolver, so a remount never double-wraps. It never throws: a
 * missing route leaves the member on the inherited (parent) route.
 */
function installContinuableHook(ctx, resolveProvider) {
  const service = ctx.subagents
  if (service === null || service === undefined || typeof service.startContinuable !== 'function') {
    ctx.logger.warn(`${PLUGIN}: ctx.subagents.startContinuable is unavailable; team-mode members keep the parent route`)
    return undefined
  }
  const existing = service[CONTINUABLE_HOOK]
  if (existing !== undefined) {
    existing.resolve = resolveProvider
    return existing
  }
  const raw = service.startContinuable
  const hadOwn = Object.prototype.hasOwnProperty.call(service, 'startContinuable')
  const slot = { resolve: resolveProvider, raw, hadOwn }
  const hook = async function startContinuable(spec) {
    try {
      const provider = slot.resolve()
      const request = spec !== null && typeof spec === 'object' ? spec.request : undefined
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
          ctx.logger.info(
            `${PLUGIN}: team member label=${JSON.stringify(spec.label ?? null)} -> ` +
              `${routeKey(picked.route)}${picked.route.reasoningEffort === undefined ? '' : ` effort=${picked.route.reasoningEffort}`} (${picked.source})`
          )
        }
      }
    } catch (error) {
      ctx.logger.warn(
        `${PLUGIN}: team member route injection skipped: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return raw.call(service, spec)
  }
  try {
    Object.defineProperty(service, 'startContinuable', {
      value: hook,
      enumerable: false,
      configurable: true,
      writable: true
    })
  } catch (error) {
    ctx.logger.warn(
      `${PLUGIN}: cannot hook ctx.subagents.startContinuable (${error instanceof Error ? error.message : String(error)}); ` +
        `team-mode members keep the parent route`
    )
    return undefined
  }
  service[CONTINUABLE_HOOK] = slot
  ctx.logger.info(`${PLUGIN}: team-mode hook installed on ctx.subagents.startContinuable`)
  return slot
}

export function apply(ctx, config = {}) {
  if (
    ctx.subagents === undefined ||
    ctx.subagents === null ||
    typeof ctx.subagents.registerProvider !== 'function'
  ) {
    // A DSH build without the subagent service, or a future rename of it: refuse
    // loudly instead of throwing, so the rest of the profile still boots.
    ctx.logger.warn(`${PLUGIN}: ctx.subagents.registerProvider is unavailable; no route is pinned`)
    return
  }
  const settingsPath = text(valueOf(config.settingsPath), 'config.settingsPath', DEFAULT_SETTINGS_PATH)
  const normalized = {
    providerName: text(valueOf(config.providerName), 'config.providerName', 'pinned-account'),
    baseProvider: text(valueOf(config.baseProvider), 'config.baseProvider', 'spawn'),
    settingsPath,
    strict: valueOf(config.strict) === true,
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
  const slot = installContinuableHook(ctx, resolveProvider)
  if (slot !== undefined) {
    try {
      ctx.effect(
        () => () => {
          const service = ctx.subagents
          const current = service === null || service === undefined ? undefined : service[CONTINUABLE_HOOK]
          if (current === undefined || current.resolve !== resolveProvider) return
          if (current.hadOwn) service.startContinuable = current.raw
          else delete service.startContinuable
          delete service[CONTINUABLE_HOOK]
        },
        `${PLUGIN}: team hook`
      )
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: cannot scope the team hook disposer: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
