/**
 * 用 Chrome 的 CDP(HTTP+WebSocket) 给任意 HTML 拍一张全页截图 + 量一下有没有横向溢出。
 * Archify 的 browser-check 走 --remote-debugging-pipe，本机 Chrome 154 直接退出码 0 不给 pipe，
 * 所以这里换端口模式做同一件事（只测量，不改产物）。
 *
 *   node .archify/shot.mjs <html> <out.png> [width]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const [, , htmlPath, outPath, widthArg] = process.argv
const width = Number(widthArg ?? 1440)
const port = 9400 + Math.floor(Math.random() * 300)

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-shot-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function version() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

const v = await version()
const ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`))
})

let seq = 0
const pending = new Map()
const events = []
ws.onmessage = (raw) => {
  const msg = JSON.parse(raw.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
    else resolve(msg.result)
  } else if (msg.method) events.push(msg)
}
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (m, p) => send(m, p, sessionId)

await call('Page.enable')
await call('Runtime.enable')
await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
await call('Page.navigate', { url: pathToFileURL(path.resolve(htmlPath)).href })

for (let i = 0; i < 100; i += 1) {
  if (events.some((e) => e.method === 'Page.loadEventFired')) break
  await sleep(100)
}
await sleep(1500)

const metrics = await call('Runtime.evaluate', {
  expression: `(() => {
    const d = document.documentElement, b = document.body;
    return JSON.stringify({
      title: document.title,
      scrollWidth: Math.max(d.scrollWidth, b ? b.scrollWidth : 0),
      clientWidth: d.clientWidth,
      scrollHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0),
      nodes: document.querySelectorAll('svg g.node, svg .node').length,
      headings: [...document.querySelectorAll('h1,h2')].map(h => h.textContent.trim()).slice(0, 8)
    });
  })()`,
  returnByValue: true
})
const report = JSON.parse(metrics.result.value)
report.viewportWidth = width
report.horizontalOverflow = report.scrollWidth - report.clientWidth

const shot = await call('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: report.scrollWidth, height: report.scrollHeight, scale: 1 }
})
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
report.screenshot = path.resolve(outPath)
report.bytes = fs.statSync(outPath).size
console.log(JSON.stringify(report, null, 2))

ws.close()
chrome.kill('SIGKILL')
process.exit(0)
