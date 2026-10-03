export type Snapshot = {
  model: string
  effort: string | null
  tokens: number | null
  max: number
  isRemoteOn: boolean | null
  remoteClients: number
}

export type CommitAlert = { at: number; repo: string; text: string; count: number }

export type CommitLogEntry = {
  at: number
  root: string
  // Full object name, so undo and squash only ever touch our own commits.
  sha: string
  subject: string
  files: number
}

export type CommitState = {
  made: number
  toPush: number
  pending: number
  unseen: number
  isPaused: boolean
  isBusy: boolean
  alerts: CommitAlert[]
  log: CommitLogEntry[]
}

// What the session changed and has not committed yet, kept by the host so a
// reload of the mod (a settings change, an update) loses nothing.
export type PendingEntry = { agent: string; root: string; paths: string[] }

export type Tracking = { pending: PendingEntry[]; queue: string[] }

declare module 'claude-code' {
  interface PluginState {
    autocommit: {
      snap: Snapshot | null
      commits: CommitState
      tracking: Tracking
      attribution: string | null
    }
  }
}
