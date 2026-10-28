import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Status } from '../types'

// A placeholder status line and /harness pane: the harness version and commit and whether this project
// installed it, all from scripts/status.js (host.js's gate and version, one Library read, no network).
// Disabled (HARNESS_DISABLED=1): nothing at all. Not installed: the status line only.
// Installed: also /harness, a refresh every minute, and the load record status.js writes.
const PANE = 'harness'
const MINUTE = 60_000
const status = atom({ plugin: 'harness', key: 'status' } as const, null, { shape: 'status-1' })

// Mod probe (temporary, notes/mods-probe-2026-10-28 in the Library): inert unless a session runs the Bash
// command `echo harness-mod-probe`. Then, once per load, it tries read-only hearthbot calls through $.mcp.call
// and one "PONG" subagent, and writes what happened to that session's own file. Remove after the test.
const PROBE_MARK = 'harness-mod-probe'
const PROBE_DIR = '/mnt/project-files/notes/mods-probe-2026-10-28/projects'
const probeRows: string[] = []
let probed = false
let probeAgent: string | null = null
const probeAdd = (kind: string, data: unknown) => { probeRows.push(JSON.stringify({ at: new Date().toISOString(), kind, data })); return probeRows.join('\n') + '\n' }
const short = (r: unknown) => JSON.stringify(r ?? null).slice(0, 600)

let last = 0 // when status.js last ran; a module variable, so a reload starts over

async function refresh($: EngineInterface, record?: string): Promise<Status | null> {
  const now = await $.clock.now()
  if (!record && now - last < MINUTE) return read($, status)
  last = now
  let s: Status | null
  try {
    const argv = ['node', `${$.plugin.root}/scripts/status.js`, ...(record ? ['--record', record] : [])]
    const { stdout } = await $.process.run(argv, { timeoutMs: 5000 })
    const out = JSON.parse(stdout)
    s = out.state === 'disabled' ? null : { record: null, error: null, ...out, readAt: now }
  } catch (err) {
    s = { readAt: now, state: 'error', text: 'harness: status unavailable', name: 'harness', version: '', commit: null, root: $.plugin.root, marker: '', record: null, error: String(err) }
  }
  if (s?.error) $.ui.log(`harness status: ${s.error}`, { to: 'debug' })
  const was = await read($, status)
  await update($, status, () => s)
  if (s || was) $.ui.status(s?.text ?? undefined) // disabled from the start: no call at all
  return s
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const s = await refresh($, await $.session.id())
      if (s?.state === 'installed') {
        await $.command.register({ name: 'harness', description: 'Show the harness version and install state in a pane' })
        $.clock.every(MINUTE, () => refresh($).catch(() => undefined))
      }
    } catch {}
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      const ev = e as any
      if (!probed && String(ev.command ?? '').includes(PROBE_MARK)) {
        probed = true
        const log = `${PROBE_DIR}/${await $.session.id()}.jsonl`
        await $.fs.write(log, probeAdd('marker', { agentId: ev.agentId ?? null, model: await $.env.get('ANTHROPIC_MODEL') ?? null }))
        for (const [server, tool, args] of [['hearthbot', 'read_thread', { limit: 1 }], ['hearthbot', 'list_threads', { limit: 1 }], ['mcp__hearthbot', 'read_thread', { limit: 1 }]] as const) {
          try { await $.fs.write(log, probeAdd(`mcp.call ${server} ${tool}`, short(await $.mcp.call(server, tool, { ...args })))) }
          catch (err) { await $.fs.write(log, probeAdd(`mcp.call ${server} ${tool} threw`, String(err))) }
        }
        try {
          const a: any = await $.agent.spawn({ prompt: 'Reply with exactly the word PONG and nothing else. Use no tools.', description: 'mod probe ping' })
          probeAgent = a?.agentId ?? null
          await $.fs.write(log, probeAdd('agent.spawn', short(a)))
        } catch (err) { await $.fs.write(log, probeAdd('agent.spawn threw', String(err))) }
      }
    } catch {}
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const ev = e as any
      if (probeAgent && ev.agentId === probeAgent) {
        const log = `${PROBE_DIR}/${await $.session.id()}.jsonl`
        await $.fs.write(log, probeAdd('turn.complete probe agent', { answer: String(ev.answer ?? '').slice(0, 200), reason: ev.reason ?? null }))
      }
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'harness' }, async $ => {
    try {
      await refresh($)
      await $.ui.open({ id: PANE, title: 'Harness' })
      return { text: 'Harness pane opened.' }
    } catch (err) {
      return { text: `Harness pane not opened: ${String(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, status)
    if (!s) return <Text dimColor>Reading the harness status…</Text>
    return (
      <Box flexDirection="column">
        <Text bold>{s.text ?? 'harness'}</Text>
        <Text>version {s.version || 'unknown'} · commit {s.commit ?? 'unknown (no git)'}</Text>
        <Text>{s.state === 'installed' ? 'installed' : s.state === 'absent' ? 'available, not installed' : 'status unavailable'} ({s.marker || 'no marker path'})</Text>
        <Text dimColor>from {s.root}</Text>
        {s.error ? <Text color="yellow">{s.error}</Text> : null}
      </Box>
    )
  })
}
