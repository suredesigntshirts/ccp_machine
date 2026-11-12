// The orchestrator's host inside Claude Code. Every decision is the Node host's (packages/orchestrator, run
// through ../cli.js); this module does only what needs Claude Code: it starts each session an item waits on
// as a subagent of a hidden agent type, takes the session's claim through the return tool, hands the claim
// on when the session ends, and sets the item's timers. Inert until a session calls mcp__orchestrator__start.

let dir = null // the item's folder, once started
let seen = 0 // journal entries the main session has been told about
let last = Promise.resolve() // the step in progress: steps on one item run one at a time
const sessions = new Map() // agentId -> { run, claim }, for each session in flight
const started = new Set() // runs whose session has started
const timers = new Set() // timer ids set

async function cli($, args, input) {
  const { stdout } = await $.process.run(['node', `${$.plugin.root}/cli.js`, ...args], { stdin: JSON.stringify(input ?? null), timeoutMs: 600_000 })
  return JSON.parse(stdout)
}

// One step of the item, after any step in progress.
function step($, input) {
  const next = last.then(() => stepNow($, input))
  last = next.catch(() => undefined)
  return next
}

// One step, then start the sessions and set the timers the item now waits on.
async function stepNow($, input) {
  const out = await cli($, ['step', dir], input)
  for (const s of out.sessions ?? []) {
    if (started.has(s.run)) continue
    started.add(s.run)
    // A spawn's cwd did not reach the subagent in Claude Code 2.1.312 (it ran in the session's folder), so the
    // prompt names the folder too.
    const prompt = [
      `Work in the folder ${s.cwd}, with absolute paths under it.`,
      s.prompt,
      `When you are done, call mcp__orchestrator__return once with { "claim": <your claim> }, the claim matching this JSON schema:\n${JSON.stringify(s.schema)}`
    ].join('\n\n')
    const { agentId, deny } = await $.agent.spawn({ subagentType: `orchestrator:${s.actor}`, prompt, description: `${s.actor} ${s.run}`, cwd: s.cwd })
    if (!agentId) return stepNow($, { run: s.run, failed: `the session could not start: ${deny}`, source: 'orchestrator' })
    sessions.set(agentId, { run: s.run, claim: undefined })
  }
  for (const t of out.timers ?? []) {
    if (timers.has(t.id)) continue
    timers.add(t.id)
    $.clock.after(Math.max(0, Date.parse(t.due) - (await $.clock.now())), () => step($, { event: t.event, source: 'timer' }))
  }
  return out
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'start',
        description: 'Start (or resume) a work item. The orchestrator runs it to the end with sessions of its own; follow it with mcp__orchestrator__wait.',
        inputSchema: {
          type: 'object',
          required: ['dir'],
          properties: {
            dir: { type: 'string', description: 'The folder that holds the item' },
            issue: { type: 'object', description: 'To start: { url, title, expect: [lines that must hold when it is done] }. Leave out to resume.' }
          }
        }
      })
      await $.tool.register({ name: 'return', description: 'For a session the orchestrator started: hand back your claim, once, when your work is done.', inputSchema: { type: 'object', required: ['claim'], properties: { claim: { type: 'object' } } } })
      await $.tool.register({ name: 'wait', description: 'Wait up to 50 seconds for the started item to move; returns where it is now.', inputSchema: { type: 'object', properties: {} } })
      for (const a of await cli($, ['agents'])) {
        await $.agent.register({
          name: a.name,
          description: `The orchestrator's ${a.name} session`,
          prompt: `You are a session the orchestrator started for one work item. Do exactly the task in your first message, then call mcp__orchestrator__return with your claim.`,
          tools: [...a.tools, 'mcp__orchestrator__return'],
          model: 'haiku',
          permissionMode: 'acceptEdits',
          maxTurns: 40
        })
      }
    } catch (err) {
      $.ui.log(`orchestrator: not ready: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  // The session types are the orchestrator's to start; the model is never offered them.
  on('agent.offer', async ($, e, next) => (e.agent.startsWith('orchestrator:') ? { isOffered: false } : next(e)))

  on('tool.call', { tool: 'mcp__orchestrator__start' }, async ($, e) => {
    if (dir && dir !== e.dir) return { result: `This session already runs the item in ${dir}.` }
    dir = e.dir
    const out = await step($, e.issue ? { event: { type: 'xstate.init', input: { issue: e.issue } }, source: 'person' } : null)
    seen = out.seq ?? 0
    return { result: JSON.stringify({ state: out.state, done: out.done, seq: out.seq, refused: out.refused }) }
  })

  on('tool.call', { tool: 'mcp__orchestrator__wait' }, async ($, e) => {
    if (!dir) return { result: 'No item is running; call mcp__orchestrator__start first.' }
    const out = await cli($, ['wait', dir, String(seen)])
    seen = out.seq
    return { result: JSON.stringify(out) }
  })

  // A claim is checked when it is handed back, so the session can fix it, and taken when the session ends.
  on('tool.call', { tool: 'mcp__orchestrator__return' }, async ($, e) => {
    const session = sessions.get(e.agentId)
    if (!session) return { result: 'Only a session the orchestrator started can return a claim.' }
    const check = await cli($, ['check', dir], { run: session.run, claim: e.claim })
    if (!check.ok) return { result: `Not taken: ${JSON.stringify(check.rejected ?? check.refused)}. Fix the claim and call again.` }
    session.claim = e.claim
    return { result: 'Taken. End your turn now.' }
  })

  on('turn.complete', async ($, e, next) => {
    const session = e.agentId && sessions.get(e.agentId)
    if (session) {
      sessions.delete(e.agentId)
      const result = session.claim === undefined ? { failed: 'the session ended without returning a claim' } : { claim: session.claim }
      await step($, { run: session.run, ...result, source: `agent:${e.agentId}` })
    }
    return next(e)
  })
}
