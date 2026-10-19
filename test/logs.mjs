#!/usr/bin/env node
/**
 * Post-upgrade smoke check against a REAL DSH boot.
 *
 * `test/run.mjs` proves the plugin still behaves; this script proves it is still
 * mounted in the running build. Those are different failures, and an upstream
 * interface change shows up here first.
 *
 * Why a file instead of grepping logs: `ctx.logger.info` reaches the DSH process
 * console (GUI dev console / terminal stdout) and is not persisted, while
 * `~/.dsh/logs/startup-*.log` is a diagnostics dump written only when startup
 * FAILS. So the plugin writes one readiness record per boot, and this check reads
 * it. The console lines are still the human-facing contract — pass `--log <file>`
 * to assert them too when you have captured them.
 *
 * Usage:
 *   node test/logs.mjs                          # check the readiness record
 *   node test/logs.mjs --strict                 # also fail when team injection is unavailable
 *   node test/logs.mjs --log ~/.dsh/console.txt # also require the three console lines
 *   node test/logs.mjs --ready path/to/ready.json
 *
 * Exit 1 on a failed check.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'subagent-route-pin:'
const DEFAULT_READY = join(homedir(), '.dsh', 'subagent-route-pin.ready.json')
const LOCAL_MANIFEST = new URL('../package.json', import.meta.url)

/** Console contract: these lines are promises about the DSH seam. */
const CONSOLE_LINES = [
  { key: 'provider delegates', required: true, test: (text) => new RegExp(`${PREFIX} provider ".*" delegates to ".*"`).test(text) },
  { key: 'hook installed', required: true, test: (text) => text.includes(`${PREFIX} team-mode hook installed on ctx.subagents.startContinuable`) },
  { key: 'capabilities published', required: true, test: (text) => text.includes(`${PREFIX} capabilities {"teamInjection":"`) },
  { key: 'team member -> provider/model', required: false, test: (text) => text.includes(`${PREFIX} team member label=`) }
]

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  const next = index < 0 ? undefined : args[index + 1]
  return next === undefined || next.startsWith('--') ? fallback : next
}

let missing = 0
const report = (state, label, detail) => {
  process.stdout.write(`  ${state.padEnd(4)} ${label}${detail === undefined ? '' : `  (${detail})`}`)
  process.stdout.write('\n')
}

const readyPath = value('--ready', DEFAULT_READY)
process.stdout.write(`readiness: ${readyPath}\n`)

let record
try {
  record = JSON.parse(readFileSync(readyPath, 'utf8'))
} catch (error) {
  report('MISS', 'readiness record', error instanceof Error ? error.message : String(error))
  process.stdout.write(
    '\nNo readiness record. Either the plugin is not mounted in this profile, or DSH\n' +
      'has not been restarted since the upgrade. Start DSH once, then re-run.\n'
  )
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(LOCAL_MANIFEST, 'utf8'))
if (record.plugin === 'subagent-route-pin') report('ok', 'plugin identity')
else {
  report('MISS', 'plugin identity', JSON.stringify(record.plugin))
  missing += 1
}

if (record.version === manifest.version) report('ok', `version ${manifest.version}`)
else {
  report('WARN', 'version', `record ${record.version} vs local ${manifest.version}`)
  missing += 1
}

if (record.mounted === true) report('ok', 'mounted')
else {
  report('MISS', 'mounted', record.capabilities?.reason)
  missing += 1
}

const capability = record.capabilities ?? {}
if (capability.teamInjection === 'installed') {
  report('ok', `team injection ${capability.enabled === false ? 'installed but switched off' : 'installed'}`)
} else if (flag('--strict')) {
  report('MISS', 'team injection', capability.reason)
  missing += 1
} else {
  report('WARN', 'team injection', capability.reason ?? 'unavailable')
}

report(record.fallback === true ? 'ok' : 'WARN', `fallback ${record.fallback === true ? 'on' : 'off'}`)
report('ok', `fallback/route: ${record.providerName} -> ${record.baseProvider}`)

if (record.at !== undefined) {
  const ageHours = (Date.now() - Date.parse(record.at)) / 3_600_000
  if (!Number.isFinite(ageHours)) report('WARN', 'record timestamp unreadable', String(record.at))
  else if (ageHours > 24 * 7) report('WARN', `record is ${Math.round(ageHours / 24)} days old`, 'restart DSH, then re-run')
  else report('ok', `recorded ${Math.round(ageHours * 60)} min ago`)
}

const logPath = value('--log', undefined)
if (logPath !== undefined) {
  process.stdout.write(`console log: ${logPath}\n`)
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch (error) {
    report('MISS', 'console log', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  for (const line of CONSOLE_LINES) {
    if (line.test(text)) report('ok', line.key)
    else if (line.required) {
      report('MISS', line.key)
      missing += 1
    } else report('none', line.key, 'no delegation yet')
  }
}

if (missing > 0) {
  process.stdout.write(
    `\n${missing} check(s) failed. The plugin is linked but the DSH interface moved:\n` +
      '  - compare `peerDependencies` in package.json with the installed build\n' +
      '  - see the compatibility matrix in README.md before blaming quota or the route\n'
  )
  process.exit(1)
}

process.stdout.write('\nready: the plugin mounted and the seams it depends on are intact\n')
