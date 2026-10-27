export type Item = { id: string; title: string; stage: string; needsYou: boolean }
export type Summary = {
  readAt: number
  updatedAt: string
  scheduler: string
  budget: string
  sevenDay: number | null
  wip: string
  pending: number
  items: Item[]
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'harness-status': { summary: Shaped<Summary | null> }
  }
}
