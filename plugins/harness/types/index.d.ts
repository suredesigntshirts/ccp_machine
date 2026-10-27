// What hooks/status.tsx keeps in $.state: the last answer of scripts/status.js.
export type Status = {
  readAt: number
  state: 'installed' | 'absent' | 'error'
  text: string | null
  name: string
  version: string
  commit: string | null
  root: string
  marker: string
  record: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    harness: { status: Shaped<Status | null> }
  }
}
