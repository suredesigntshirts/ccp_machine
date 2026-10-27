import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Item, Summary } from '../types'

// The harness store the orchestrator thread writes (ccp_machine_test, packages/harness).
const STORE = '/mnt/project-files/harness/state/main'
const PANE = 'harness-status'
const summary = atom({ plugin: 'harness-status', key: 'summary' } as const, null, { shape: 'summary-1' })

const leaf = (v: unknown): string =>
  typeof v === 'string' ? v : Object.values(v as Record<string, unknown>).map(leaf).join(', ')

const lines = (text: string) => text.split('\n').filter(Boolean).map(l => {
  try {
    return JSON.parse(l)
  } catch {
    return null
  }
}).filter(Boolean)

async function refresh($: EngineInterface) {
  let next: Summary
  try {
    const state = JSON.parse(await $.fs.read(`${STORE}/state.json`))
    const snap = state.snapshot
    const items: Item[] = Object.values(snap.children ?? {})
      .filter((c: any) => c.src === 'workItem')
      .map((c: any) => ({
        id: c.snapshot.context.id,
        title: c.snapshot.context.title ?? c.snapshot.context.id,
        stage: leaf(c.snapshot.value).split('.').pop() ?? '',
        needsYou: Object.values(c.snapshot.children ?? {}).some((d: any) => d.snapshot.value === 'awaitingPerson')
      }))
    const budget: any = Object.values(snap.children ?? {}).find((c: any) => c.src === 'budget')
    const read = async (n: string) => ((await $.fs.exists(`${STORE}/${n}`)) ? lines(await $.fs.read(`${STORE}/${n}`)) : [])
    const acked = new Set((await read('acks.jsonl')).map((a: any) => a.effectId))
    next = {
      readAt: await $.clock.now(),
      updatedAt: state.updatedAt,
      scheduler: snap.value.scheduler,
      budget: budget ? leaf(budget.snapshot.value) : 'unknown',
      sevenDay: budget?.snapshot.context.sevenDay ?? null,
      wip: `${snap.context.inFlight.length}/${snap.context.wipLimit}`,
      pending: (await read('outbox.jsonl')).filter((e: any) => !acked.has(e.id)).length,
      items,
      error: null
    }
  } catch (err) {
    next = { readAt: await $.clock.now(), updatedAt: '', scheduler: '', budget: '', sevenDay: null, wip: '', pending: 0, items: [], error: String(err) }
  }
  await update($, summary, () => next)
  const asks = next.items.filter(i => i.needsYou).length
  $.ui.status(next.error ? 'harness: no store' : `harness: ${next.wip} in flight · ${asks} need you · budget ${next.budget}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'harness', description: 'Show the agent harness at a glance in a pane' })
    await refresh($)
    $.clock.every(60_000, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'harness' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Harness' })
    return { text: 'Harness pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, summary)
    if (!s) return <Text dimColor>Reading the harness store…</Text>
    if (s.error) return <Text dimColor>No harness store at {STORE}.</Text>
    const live = s.items.filter(i => !['done', 'failed', 'cancelled'].includes(i.stage))
    const asks = live.filter(i => i.needsYou)
    return (
      <Box flexDirection="column">
        <Text bold>{asks.length ? `${asks.length} need you` : 'Nothing needs you'}</Text>
        {asks.map(i => <Text color="yellow">• {i.title} ({i.stage})</Text>)}
        <Text>In flight {s.wip} · scheduler {s.scheduler} · budget {s.budget}{s.sevenDay != null ? ` · 7-day ${Math.round(s.sevenDay * 100)}%` : ''}</Text>
        {live.filter(i => !i.needsYou).map(i => <Text>• {i.title}: {i.stage}</Text>)}
        <Text dimColor>{s.items.length - live.length} finished · {s.pending} host to-dos · store updated {s.updatedAt.slice(11, 16)} UTC</Text>
      </Box>
    )
  })
}
