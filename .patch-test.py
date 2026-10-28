import io
p = 'test/run.mjs'
s = io.open(p, encoding='utf-8').read()
old_import = "import { apply, teamInjectionCapabilities, wireAgencyProvider } from '../index.js'"
new_import = "import { apply, inject, teamInjectionCapabilities, wireAgencyProvider } from '../index.js'"
assert s.count(old_import) == 1
s = s.replace(old_import, new_import)

anchor = """  check(
    'bundle patch name is a specifier, not a path',
    typeof declared === 'string' && !/[/\\]|^\./.test(declared),
    `name=${String(declared)} \u2014 a path here never resolves as a module`
  )
}"""
assert s.count(anchor) == 1, s.count(anchor)

addition = anchor[:-1] + """
  // A REQUIRED inject service that a build does not provide makes Cordis park the
  // plugin forever \u2014 silently, with no log line. In the UI that is indistinguishable
  // from "not installed", which is the failure mode this file exists to stop.
  const requiredServices = Array.isArray(inject)
    ? inject
    : Array.isArray(inject?.required)
      ? inject.required
      : []
  check(
    'only services the plugin cannot run without are required',
    requiredServices.length === 1 && requiredServices[0] === 'subagents',
    `inject=${JSON.stringify(inject)} \u2014 expect required ['subagents'] and llm optional`
  )
}"""
s = s.replace(anchor, addition)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched')
