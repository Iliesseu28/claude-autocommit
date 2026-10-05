// Pure helpers for the auto-commit feature: no `$`, so they are unit-tested.

export type CommitText = { subject: string; body: string; warnings: string[] }
export type DiffPart = { file: string; text: string }

const MAX_SUBJECT = 72
export const RECENT_SUBJECTS = 8
// Stale entries in the person's index from which it is worth a warning.
export const STALE_INDEX_MIN = 10
const MAX_DIFF_CHARS = 12_000
const MAX_FILE_DIFF_CHARS = 3_000

// "C:\\work\\x" and "C:/work/x" name the same file on Windows.
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

export const parentDir = (p: string): string => {
  const n = normPath(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? n : n.slice(0, i)
}

export const fileName = (p: string): string => {
  const n = normPath(p)
  return n.slice(n.lastIndexOf('/') + 1)
}

export const repoName = (root: string): string => fileName(root)

export const isAbsolute = (p: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(p)

export const absolute = (cwd: string, dir: string): string =>
  isAbsolute(dir) ? normPath(dir) : `${normPath(cwd)}/${dir}`

// `git status --porcelain=v1 -z`: path -> two-letter status ("??", " M", "A ", ...).
// A rename or copy is followed by its source path, recorded as deleted.
export const parsePorcelain = (z: string): Map<string, string> => {
  const out = new Map<string, string>()
  const parts = z.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry === undefined || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    out.set(entry.slice(3), xy)
    if (xy[0] === 'R' || xy[0] === 'C') {
      const source = parts[i + 1]
      if (source !== undefined && source !== '') out.set(source, 'D ')
      i += 1
    }
  }
  return out
}

// Tracked paths matched against `git status`. On a case-insensitive file
// system a tool may name `readme.md` while git lists `README.md`: both are
// the same file. `found` maps git's spelling to the tracked spellings.
export const matchStatus = (
  tracked: readonly string[],
  status: ReadonlyMap<string, string>,
  isCaseInsensitive: boolean,
): { found: Map<string, string[]>; missing: string[] } => {
  const folded = new Map<string, string>()
  if (isCaseInsensitive) for (const p of status.keys()) folded.set(p.toLowerCase(), p)
  const found = new Map<string, string[]>()
  const missing: string[] = []
  for (const p of tracked) {
    const actual = status.has(p) ? p : isCaseInsensitive ? folded.get(p.toLowerCase()) : undefined
    if (actual === undefined) {
      missing.push(p)
    } else {
      found.set(actual, [...(found.get(actual) ?? []), p])
    }
  }
  return { found, missing }
}

// Sections of a `git diff --no-renames --src-prefix=a/ --dst-prefix=b/`: with
// both sides the same path, "diff --git a/X b/X" gives X even with spaces.
export const splitDiff = (diff: string): DiffPart[] =>
  diff
    .split(/(?=^diff --git )/m)
    .filter(text => text.startsWith('diff --git '))
    .map(text => {
      const end = text.indexOf('\n')
      const rest = (end === -1 ? text : text.slice(0, end)).replace(/\r$/, '').slice('diff --git '.length)
      const n = (rest.length - 5) / 2
      const isPlain = Number.isInteger(n) && n > 0 && rest.startsWith('a/') && rest.slice(n + 2, n + 5) === ' b/'
      return { file: isPlain ? rest.slice(2, 2 + n) : rest, text }
    })

// Paths whose status appeared or changed between two snapshots.
// A status code alone also moves when only the index does (`git add -A` turns
// " M" into "M "), so a path dirty on both sides counts only when its content
// hash moved; without hashes, only paths that were clean before count.
export const changedPaths = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  hashesBefore: ReadonlyMap<string, string> | null = null,
  hashesAfter: ReadonlyMap<string, string> | null = null,
): string[] =>
  [...after]
    .filter(([p, xy]) => {
      const was = before.get(p)
      if (was === undefined) return true
      if (hashesBefore === null || hashesAfter === null) return false
      const h0 = hashesBefore.get(p)
      const h1 = hashesAfter.get(p)
      return h0 === undefined || h1 === undefined ? was !== xy : h0 !== h1
    })
    .map(([p]) => p)

// Entries of the person's own index that look left over from an older state
// of the repo, read from `git status --porcelain=v1 -z` of that index: a
// staged change (X is M or A) whose file differs again on disk (Y not blank),
// or a staged deletion (X is D) of a file still on disk (listed again as
// untracked). A few are ordinary work in progress; many at once is the mark
// of a `.git/index` that a folder sync copied back from another machine.
export const staleIndexCount = (z: string): number => {
  const entries: Array<[string, string]> = []
  const parts = z.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry === undefined || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    entries.push([xy, entry.slice(3)])
    if (xy[0] === 'R' || xy[0] === 'C') i += 1
  }
  const untracked = new Set(entries.filter(([xy]) => xy === '??').map(([, p]) => p))
  return entries.filter(
    ([xy, p]) => ((xy[0] === 'M' || xy[0] === 'A') && xy[1] !== ' ') || (xy[0] === 'D' && untracked.has(p)),
  ).length
}

// Paths `git hash-object --stdin-paths` can read: not deleted on either side.
// Files git can hash: not deleted, and not a directory (an untracked inner repo
// shows as `dir/`), since one bad path fails the whole hash-object call.
export const hashablePaths = (status: ReadonlyMap<string, string>): string[] =>
  [...status].filter(([p, xy]) => !xy.includes('D') && !p.endsWith('/')).map(([p]) => p)

export const zipHashes = (paths: readonly string[], stdout: string): Map<string, string> | null => {
  const hashes = stdout.split('\n').map(h => h.trim()).filter(h => h !== '')
  if (hashes.length !== paths.length) return null
  return new Map(paths.map((p, i) => [p, hashes[i] ?? '']))
}

const READ_ONLY_COMMANDS = new Set([
  'cd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'echo', 'pwd',
  'test', '[', 'stat', 'du', 'df', 'file', 'date', 'tree', 'type', 'printf',
  'sort', 'cut', 'tr', 'jq', 'awk', 'basename', 'dirname', 'realpath',
  'less', 'more', 'diff', 'whoami', 'uname', 'ps',
  'Get-ChildItem', 'Get-Content', 'Select-String', 'Test-Path', 'Get-Item',
  'Get-Location', 'Resolve-Path', 'Measure-Object', 'Select-Object', 'Where-Object',
])
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'describe', 'rev-list',
  'shortlog', 'blame', 'cat-file', 'remote', 'config', 'branch', 'grep', 'reflog',
  'ls-tree', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged',
])

// True only when every piece of the command surely writes nothing; any doubt
// says false, which costs a git status but never a wrong attribution.
export const isReadOnlyCommand = (command: string): boolean => {
  const cleaned = command
    .replace(/\d?>\s*\/dev\/null/g, '')
    .replace(/\d?>&\d/g, '')
    .replace(/\d?>\s*\$null/gi, '')
  if (
    /[>`]|\$\(|\btee\b|\bxargs\b|\bsed\s+-i|-delete\b|-exec(dir)?\b|-ok(dir)?\b|-fprint|-fls\b|\bsh\s+-c|\bbash\s+-c/.test(cleaned) ||
    /\bsort\b[^|;&]*\s(-o|--output)\b/.test(cleaned)
  ) {
    return false
  }
  const segments = cleaned.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(s => s !== '')
  if (segments.length === 0) return false
  return segments.every(seg => {
    const words = seg.split(/\s+/)
    const head = words[0] ?? ''
    if (head === 'git') {
      const sub = words.find((w, i) => i > 0 && !w.startsWith('-') && words[i - 1] !== '-C' && words[i - 1] !== '-c')
      if (sub === 'branch') return !/\s-(d|D|m|M|c|C|f)\b|\s--(delete|move|copy|force|set-upstream-to|unset-upstream)\b/.test(seg)
      if (sub === 'config') return /\s--get\b|\s--get-all\b|\s-l\b|\s--list\b/.test(seg)
      if (sub === 'remote') return !/\s(add|remove|rm|rename|set-url|set-head|prune|update)\b/.test(seg)
      if (sub === 'reflog') return !/\s(expire|delete)\b/.test(seg)
      return sub !== undefined && READ_ONLY_GIT.has(sub)
    }
    if (head === 'sed') return /\s-n\b/.test(seg)
    if (head === 'find') return true
    return READ_ONLY_COMMANDS.has(head)
  })
}

// Directories a command moves into or points git at: `cd X`, `git -C X`.
export const commandDirs = (command: string): string[] => {
  const dirs: string[] = []
  const re = /(?:\bcd\s+|\bgit\s+-C\s+|\bSet-Location\s+|\bpushd\s+)("([^"]+)"|'([^']+)'|([^\s;&|)]+))/g
  for (const m of command.matchAll(re)) {
    const dir = m[2] ?? m[3] ?? m[4]
    if (dir !== undefined && dir !== '' && dir !== '-' && !dir.startsWith('$')) dirs.push(dir)
  }
  return dirs
}

// A shell-like split of a configured command: quotes group, nothing expands.
export const splitArgs = (command: string): string[] => {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of command.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

// A push URL matches a pattern made of whole path segments of it, ignoring
// case and a trailing ".git": "me/notes" matches "git@github.com:me/notes.git"
// and "https://github.com/me/notes", never "me/notes-old"; "*" matches all.
export const matchesRemote = (url: string, patterns: readonly string[]): boolean => {
  const u = url.trim().toLowerCase().replace(/\.git\/?$/, '').replace(/^[\w.-]+@([^:/]+):/, '$1/')
  return patterns.some(p => {
    const q = p.trim().toLowerCase().replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '')
    if (q === '') return false
    return q === '*' || u === q || u.endsWith(`/${q}`) || u.startsWith(`${q}/`) || u.includes(`/${q}/`)
  })
}

// Diff trimmed per file and in total, so one big file never crowds the rest out.
export const trimDiff = (diff: string): string => {
  const files = diff.split(/(?=^diff --git )/m)
  const kept = files.map(f =>
    f.length > MAX_FILE_DIFF_CHARS ? `${f.slice(0, MAX_FILE_DIFF_CHARS)}\n[... cut ...]\n` : f,
  )
  const all = kept.join('')
  return all.length > MAX_DIFF_CHARS ? `${all.slice(0, MAX_DIFF_CHARS)}\n[... cut ...]\n` : all
}

export type PromptOptions = { commitLanguage: string; warningLanguage: string; isBugCheck: boolean }

export const commitSystem = (o: PromptOptions): string =>
  [
    'You write git commit messages' + (o.isBugCheck ? ' and spot obvious bugs in a diff.' : '.'),
    'Reply with JSON only, no code fence: {"subject": string, "body": string, "warnings": string[]}.',
    `subject: imperative, in ${o.commitLanguage}, at most 72 characters.`,
    "When the prompt lists the repo's recent subjects, write yours in their style: the same type words, a scope in parentheses whenever they use one (picked from the changed files), the same capitalization.",
    'Without them, Conventional Commits (feat, fix, refactor, docs, chore, test, style, perf, build, ci), optional scope.',
    `body: one to three short lines in ${o.commitLanguage} on WHY the change was made; empty string when obvious.`,
    o.isBugCheck
      ? `warnings: at most 2 items, in ${o.warningLanguage}, only for a likely real bug you can point to (debug leftover, broken reference, syntax error, half-finished code, deleted code still used). Empty array when nothing is clearly wrong.`
      : 'warnings: always an empty array.',
    'Never use the characters \u2014 or \u2013.',
  ].join(' ')

// The subjects of the repo's latest commits, one per line, newest first, each
// cut to a subject's length: the style the model copies.
export const recentSubjects = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(0, RECENT_SUBJECTS)
    .map(l => l.slice(0, MAX_SUBJECT))

export const commitPrompt = (stat: string, diff: string, recent: readonly string[] = []): string => {
  const style =
    recent.length === 0
      ? ''
      : `Recent subjects in this repo, newest first (copy their style, not their content):\n${recent.map(r => `- ${r}`).join('\n')}\n\n`
  return `${style}Files changed:\n${stat.trim()}\n\nDiff:\n${trimDiff(diff)}`
}

export const squashSystem = (commitLanguage: string): string =>
  [
    'You merge several git commits into one commit message.',
    'Reply with JSON only, no code fence: {"subject": string, "body": string}.',
    `subject: Conventional Commits, optional scope, imperative, in ${commitLanguage}, at most 72 characters, covering the whole change.`,
    `body: two to four short lines in ${commitLanguage} on what changed and why.`,
    'Never use the characters \u2014 or \u2013.',
  ].join(' ')

export const squashPrompt = (subjects: readonly string[], stat: string): string =>
  `Commits, oldest first:\n${subjects.map(s => `- ${s}`).join('\n')}\n\nFiles changed:\n${stat.trim()}`

// No em dash, en dash or horizontal bar in a message.
export const noLongDash = (s: string): string => s.replace(/\s*[\u2014\u2013\u2015]\s*/g, ', ')

const oneLine = (s: string): string => noLongDash(s).replace(/\s+/g, ' ').trim()

export const fallbackSubject = (files: readonly string[]): string => {
  const first = files[0] ?? 'files'
  const name = fileName(first)
  return files.length > 1 ? `chore: update ${name} and ${files.length - 1} more` : `chore: update ${name}`
}

export const parseCommitReply = (text: string, files: readonly string[]): CommitText => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let raw: unknown = null
  if (start !== -1 && end > start) {
    try {
      raw = JSON.parse(text.slice(start, end + 1))
    } catch {
      raw = null
    }
  }
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const subject = typeof obj.subject === 'string' ? oneLine(obj.subject) : ''
  const body = typeof obj.body === 'string' ? noLongDash(obj.body).trim() : ''
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((w): w is string => typeof w === 'string').map(oneLine).filter(w => w !== '').slice(0, 2)
    : []
  return {
    subject: (subject === '' ? fallbackSubject(files) : subject).slice(0, MAX_SUBJECT),
    body,
    warnings,
  }
}

export const TRAILER = 'Auto-commit: claude-autocommit'

// The trailer block: ours, then the person's commit attribution as Claude Code
// composed it (their settings applied; empty when they turned it off).
export const trailers = (attribution: string | null, model: string): string[] => {
  const own = attribution === null ? `Co-Authored-By: Claude ${model} <noreply@anthropic.com>` : attribution.trim()
  return [TRAILER, ...(own === '' ? [] : [own])]
}

export const commitMessage = (text: Pick<CommitText, 'subject' | 'body'>, trailerLines: readonly string[]): string =>
  [text.subject, '', ...(text.body === '' ? [] : [text.body, '']), ...trailerLines].join('\n')

// "claude-opus-5-5[1m]" -> "Opus 5.5"; anything else is shown as given.
export const prettyModel = (raw: string): string => {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(raw)
  const [, family, major, minor] = m ?? []
  if (family === undefined || major === undefined) return raw
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  return minor === undefined || minor.length > 2 ? `${name} ${major}` : `${name} ${major}.${minor}`
}
