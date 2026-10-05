import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { CommitLogEntry, CommitState, PendingEntry, Snapshot, Tracking } from '../types'
import { readConfig } from './config'
import type { Config } from './config'
import {
  absolute,
  changedPaths,
  commandDirs,
  commitMessage,
  commitPrompt,
  commitSystem,
  fallbackSubject,
  fileName,
  hashablePaths,
  isReadOnlyCommand,
  matchStatus,
  matchesRemote,
  normPath,
  parentDir,
  parseCommitReply,
  parsePorcelain,
  prettyModel,
  RECENT_SUBJECTS,
  recentSubjects,
  repoName,
  splitArgs,
  squashPrompt,
  squashSystem,
  STALE_INDEX_MIN,
  staleIndexCount,
  trailers,
  zipHashes,
} from './git'
import type { CommitText } from './git'
import { actionOf, strings } from './i18n'
import type { Strings } from './i18n'
import { forbiddenFile, scanDiff, scanLine } from './secrets'

// The whole mod's engine-facing code lives in this one file: the engine
// follows `$` only into functions declared next to the hooks. Pure helpers
// (paths, git output parsing, prompts, the secret scan, strings) are in the
// files imported above and unit-tested on their own.

// ================================================================ state

export const NO_COMMITS: CommitState = {
  made: 0,
  toPush: 0,
  pending: 0,
  unseen: 0,
  isPaused: false,
  isBusy: false,
  alerts: [],
  log: [],
}

const NO_TRACKING: Tracking = { pending: [], queue: [] }

export const snap = atom({ plugin: 'autocommit', key: 'snap' } as const, null)
export const commits = atom({ plugin: 'autocommit', key: 'commits' } as const, NO_COMMITS)
export const tracking = atom({ plugin: 'autocommit', key: 'tracking' } as const, NO_TRACKING)
// The commit trailer Claude Code composed with the person's settings; null
// until seen.
export const attribution = atom({ plugin: 'autocommit', key: 'attribution' } as const, null)

// ================================================================ work

const MAIN = ''
const PATHS_PER_CALL = 100
const MAX_NEW_FILE_BYTES = 5_000_000
const MAX_WATCHED_REPOS = 6
const KEPT_ALERTS = 30
const KEPT_LOG = 200
const BUSY_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']
// Patches read as text, whatever a repo's attributes say, so a scan sees every line.
const PATCH_FLAGS = [
  '--text', '--no-textconv', '--no-color', '--no-ext-diff', '--no-renames',
  '--src-prefix=a/', '--dst-prefix=b/',
]
// Files the mod writes inside `.git`, never in the working tree, each named
// for its session (`w.tag`) so two sessions in one repo never share one, and
// each deleted once used: a synced folder would carry leftovers to every
// machine. Commit messages go through standard input, never a file.
const INDEX_FILE = 'autocommit.index'
const JOURNAL_FILE = 'AUTOCOMMIT_RESET'
const PUSH_LIST_FILE = 'AUTOCOMMIT_PUSH_LIST'
// Auto-commits (ours or another mod's) carry this trailer: left out of the
// subjects the model copies the repo's style from.
const AUTO_TRAILER = '^Auto-commit:'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Where a directory sits in its repo: git's own root (a junction or link
// resolved) and the directory's path inside it.
export type RepoAt = { root: string; prefix: string }

// Status and content hashes of a repo's dirty files at one moment.
export type RepoState = { status: Map<string, string>; hashes: Map<string, string> | null }

type GitInit = { stdin?: string; timeoutMs?: number; env?: Record<string, string> }

// What the module tracks between events. `tracked` and `queue` are mirrored in
// `$.state` so a reload starts from them; the rest is rebuilt on demand.
export type Work = {
  cwd: string
  isInteractive: boolean
  // agent key (MAIN for the main loop) -> repo root -> paths it changed
  tracked: Map<string, Map<string, Set<string>>>
  // directory -> where it sits in a repo, null when in none
  places: Map<string, RepoAt | null>
  // repos this session touched, most recent last
  repos: Set<string>
  // agents whose turn ended with files to commit
  queue: Set<string>
  // agents whose last turn is over: their leftovers are retried at any turn end
  idle: Set<string>
  // the main loop's turn is under way: a subagent that ends meanwhile leaves
  // its files to the main turn's end
  isMainWorking: boolean
  // repos already warned of a stale index this session
  staleWarned: Set<string>
  isWindows: boolean
  // `root\0path` -> how many times it was tracked: a path tracked again while
  // a drain commits it stays pending for the newer change
  edits: Map<string, number>
  // the drain, undo or squash under way: one at a time
  running: Promise<void> | null
  // Claude's own git commands under way: no drain starts meanwhile
  gitCommands: number
  // suffix of the mod's files in `.git`, from the session id
  tag: string
  isPaused: boolean
  isPushAsked: boolean
}

export const newWork = (): Work => ({
  gitCommands: 0,
  tag: '',
  cwd: '.',
  isInteractive: true,
  tracked: new Map(),
  places: new Map(),
  repos: new Set(),
  queue: new Set(),
  idle: new Set(),
  isMainWorking: false,
  staleWarned: new Set(),
  isWindows: false,
  edits: new Map(),
  running: null,
  isPaused: false,
  isPushAsked: false,
})

export type Ctx = { w: Work; cfg: Config; t: Strings }

const firstLine = (s: string | undefined): string => (s ?? '').trim().split('\n')[0]?.slice(0, 160) ?? ''

export async function git(
  $: EngineInterface,
  root: string,
  args: readonly string[],
  init: GitInit = {},
): Promise<ProcessRunResult> {
  return $.process.run(
    ['git', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', '-C', root, ...args],
    { timeoutMs: 30_000, ...init },
  )
}

const out = (r: ProcessRunResult | null): string => (r !== null && r.exitCode === 0 ? r.stdout.trim() : '')

// ---------------------------------------------------------------- tracking

export const pendingCount = (w: Work): number => {
  const all = new Set<string>()
  for (const repos of w.tracked.values()) {
    for (const [root, paths] of repos) for (const p of paths) all.add(`${root}/${p}`)
  }
  return all.size
}

const editKey = (root: string, path: string): string => `${root}\0${path}`

// `-` and the session id's first 8 letters and digits: the suffix of the
// mod's files in `.git`.
export const tagOf = (sessionId: string): string => {
  const s = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  return s === '' ? '' : `-${s}`
}

export const track = (w: Work, agent: string, root: string, paths: readonly string[]): void => {
  if (paths.length === 0) return
  const repos = w.tracked.get(agent) ?? new Map<string, Set<string>>()
  const set = repos.get(root) ?? new Set<string>()
  for (const p of paths) {
    set.add(p)
    w.edits.set(editKey(root, p), (w.edits.get(editKey(root, p)) ?? 0) + 1)
  }
  repos.set(root, set)
  w.tracked.set(agent, repos)
  w.repos.delete(root)
  w.repos.add(root)
}

// Settled paths leave every agent's list: committed, or held back for good.
// A path tracked again since `seen` was taken keeps its place: its newer
// change is not in the commit.
export const forget = (w: Work, root: string, paths: readonly string[], seen?: ReadonlyMap<string, number>): void => {
  const gone = paths.filter(p => seen === undefined || w.edits.get(editKey(root, p)) === seen.get(editKey(root, p)))
  for (const [agent, repos] of w.tracked) {
    const set = repos.get(root)
    if (set === undefined) continue
    for (const p of gone) set.delete(p)
    if (set.size === 0) repos.delete(root)
    if (repos.size === 0) w.tracked.delete(agent)
  }
  for (const p of gone) w.edits.delete(editKey(root, p))
}

// Mirrors `tracked` and `queue` into the host, and the pending count into the band.
export async function saveTracking($: EngineInterface, c: Ctx): Promise<void> {
  const pending: PendingEntry[] = []
  for (const [agent, repos] of c.w.tracked) {
    for (const [root, paths] of repos) pending.push({ agent, root, paths: [...paths] })
  }
  await update($, tracking, () => ({ pending, queue: [...c.w.queue] }))
  const count = pendingCount(c.w)
  if ((await read($, commits)).pending !== count) {
    await update($, commits, s => ({ ...s, pending: count }))
  }
}

export async function loadTracking($: EngineInterface, c: Ctx): Promise<void> {
  const saved = await read($, tracking)
  for (const e of saved.pending) {
    track(c.w, e.agent, e.root, e.paths)
    c.w.idle.add(e.agent)
  }
  for (const agent of saved.queue) if (c.w.tracked.has(agent)) c.w.queue.add(agent)
  c.w.isPaused = (await read($, commits)).isPaused
}

export async function alert($: EngineInterface, c: Ctx, repo: string, text: string): Promise<void> {
  const isNew = !(await read($, commits)).alerts.some(a => a.repo === repo && a.text === text)
  await update($, commits, s => {
    const i = s.alerts.findIndex(a => a.repo === repo && a.text === text)
    const seen = i === -1 ? undefined : s.alerts[i]
    if (seen === undefined) {
      return {
        ...s,
        unseen: s.unseen + 1,
        alerts: [...s.alerts, { at: Date.now(), repo, text, count: 1 }].slice(-KEPT_ALERTS),
      }
    }
    // The same alert again (a hook refusing every turn): counted, not toasted.
    return {
      ...s,
      alerts: [...s.alerts.filter((_, j) => j !== i), { ...seen, at: Date.now(), count: seen.count + 1 }],
    }
  })
  if (isNew) $.ui.toast(c.t.alert(repo, text), { timeoutMs: 8000 })
}

export async function repoAt($: EngineInterface, c: Ctx, dir: string): Promise<RepoAt | null> {
  const key = normPath(dir)
  const known = c.w.places.get(key)
  if (known !== undefined) return known
  const r = await $.process
    .run(['git', '-C', key, 'rev-parse', '--show-toplevel', '--show-prefix'], { timeoutMs: 10_000 })
    .catch(() => null)
  const [top, prefix] = r !== null && r.exitCode === 0 ? r.stdout.split('\n') : []
  const place =
    top !== undefined && top.trim() !== '' ? { root: normPath(top.trim()), prefix: (prefix ?? '').trim() } : null
  // A folder that does not exist yet may become a repo's: asked again later.
  if (place !== null || !/cannot change to/i.test(r?.stderr ?? '')) c.w.places.set(key, place)
  return place
}

export async function trackFile($: EngineInterface, c: Ctx, agent: string, file: string): Promise<void> {
  const place = await repoAt($, c, parentDir(file))
  if (place === null) return
  track(c.w, agent, place.root, [`${place.prefix}${fileName(file)}`])
  await saveTracking($, c)
}

// `git status --porcelain=v1 -z` of the person's own index, null when unread.
async function statusText($: EngineInterface, root: string): Promise<string | null> {
  // A submodule is its own repo: its pointer is never ours to commit.
  const r = await git($, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']).catch(
    () => null,
  )
  return r !== null && r.exitCode === 0 && !r.isStdoutTruncated ? r.stdout : null
}

async function statusOf($: EngineInterface, root: string): Promise<Map<string, string> | null> {
  const text = await statusText($, root)
  return text === null ? null : parsePorcelain(text)
}

export async function stateOf($: EngineInterface, root: string): Promise<RepoState | null> {
  const status = await statusOf($, root)
  if (status === null) return null
  const paths = hashablePaths(status)
  if (paths.length === 0) return { status, hashes: new Map() }
  // Raw content, no clean filter (LFS, line endings): only before and after are compared.
  const r = await git($, root, ['hash-object', '--no-filters', '--stdin-paths'], { stdin: `${paths.join('\n')}\n` }).catch(
    () => null,
  )
  return { status, hashes: r !== null && r.exitCode === 0 ? zipHashes(paths, r.stdout) : null }
}

// The repos a shell command may touch: those the session touched lately, the
// session's folder, and the folders the command names (`cd X`, `git -C X`).
export async function watchedRoots($: EngineInterface, c: Ctx, command: string): Promise<string[]> {
  const roots = new Set([...c.w.repos].slice(-MAX_WATCHED_REPOS))
  for (const dir of [c.w.cwd, ...commandDirs(command).map(d => absolute(c.w.cwd, d))]) {
    const place = await repoAt($, c, dir)
    if (place !== null) roots.add(place.root)
  }
  return [...roots]
}

// What a shell command changed, by comparing the repos before and after it.
export async function recordCommand(
  $: EngineInterface,
  c: Ctx,
  agent: string,
  roots: readonly string[],
  before: ReadonlyArray<RepoState | null>,
  after: ReadonlyArray<RepoState | null>,
): Promise<void> {
  for (const [i, root] of roots.entries()) {
    const was = before[i]
    const now = after[i]
    if (was === null || was === undefined || now === null || now === undefined) continue
    const touched = changedPaths(was.status, now.status, was.hashes, now.hashes)
    if (touched.length > c.cfg.maxFilesPerCommand) {
      await alert($, c, repoName(root), c.t.tooManyFiles(touched.length))
    } else {
      track(c.w, agent, root, touched)
    }
  }
  await saveTracking($, c)
}

// ---------------------------------------------------------------- commit

async function gitDirOf($: EngineInterface, root: string): Promise<string | null> {
  const r = await git($, root, ['rev-parse', '--absolute-git-dir']).catch(() => null)
  const dir = out(r)
  return dir === '' ? null : normPath(dir)
}

// Mid-merge, mid-rebase or detached: nothing is committed, files wait.
async function isBusy($: EngineInterface, root: string, gitDir: string): Promise<boolean> {
  if ((await git($, root, ['symbolic-ref', '-q', 'HEAD'])).exitCode !== 0) return true
  for (const marker of BUSY_MARKERS) {
    if (await $.fs.exists(`${gitDir}/${marker}`)) return true
  }
  return false
}

async function unstage(
  $: EngineInterface,
  root: string,
  paths: readonly string[],
  hasHead: boolean,
  env?: Record<string, string>,
): Promise<boolean> {
  if (paths.length === 0) return true
  const args = hasHead ? ['reset', '-q'] : ['rm', '--cached', '-q']
  const r = await git($, root, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
    stdin: paths.join('\0'),
    ...(env === undefined ? {} : { env }),
  }).catch(() => null)
  return r !== null && r.exitCode === 0
}

// A commit is made in an index of its own, then the person's index catches up
// for its paths. A journal written before the commit lets the next run finish
// that catch-up if the process died in between.
async function writeJournal($: EngineInterface, path: string, head: string, paths: readonly string[]): Promise<void> {
  await $.fs.write(path, [head, ...paths].join('\0'))
}

// `$.fs` writes but never deletes: the host's own command does, `rm` or `del`.
async function removeFiles($: EngineInterface, c: Ctx, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const argv = c.w.isWindows
    ? ['cmd', '/d', '/c', 'del', '/f', '/q', ...paths.map(p => p.replace(/\//g, '\\'))]
    : ['rm', '-f', '--', ...paths]
  await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
}

async function clearJournal($: EngineInterface, c: Ctx, path: string): Promise<void> {
  await removeFiles($, c, [path])
}

export async function recoverJournal($: EngineInterface, c: Ctx, root: string, path: string): Promise<void> {
  if (!(await $.fs.exists(path))) return
  const text = String(await $.fs.read(path).catch(() => ''))
  if (text === '') return
  // The head comes first, empty on a branch with no commit yet.
  const [head = '', ...rest] = text.split('\0')
  const paths = rest.filter(p => p !== '')
  const now = out(await git($, root, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => null))
  // HEAD moved since the journal: the commit was made, its index catch-up was not.
  if (now !== '' && now !== head) await unstage($, root, paths, true)
  await clearJournal($, c, path)
}

// The staged patch of `paths`, in calls short enough for any command line;
// null when git failed or cut the output, so a scan never reads half of it.
async function cachedDiff(
  $: EngineInterface,
  root: string,
  paths: readonly string[],
  context: string,
  env: Record<string, string>,
): Promise<string | null> {
  let text = ''
  for (let i = 0; i < paths.length; i += PATHS_PER_CALL) {
    const r = await git(
      $,
      root,
      ['diff', '--cached', ...PATCH_FLAGS, context, '--', ...paths.slice(i, i + PATHS_PER_CALL)],
      { env },
    )
    if (r.exitCode !== 0 || r.isStdoutTruncated) return null
    text += r.stdout
  }
  return text
}

// Once per repo and session: the person's index looks left over from an older
// state of the repo. Only a warning: their index is never touched.
async function warnStaleIndex($: EngineInterface, c: Ctx, root: string, count: number): Promise<void> {
  if (count < STALE_INDEX_MIN || c.w.staleWarned.has(root)) return
  c.w.staleWarned.add(root)
  await alert($, c, repoName(root), c.t.staleIndex(count))
}

async function heldBackReason($: EngineInterface, c: Ctx, root: string, path: string, xy: string): Promise<string | null> {
  const forbidden = forbiddenFile(path)
  if (forbidden !== null) return c.t.heldBack(path, forbidden)
  if (xy !== '??') return null
  const st = await $.fs.stat(`${root}/${path}`).catch(() => null)
  return st !== null && st.kind === 'file' && st.size > MAX_NEW_FILE_BYTES
    ? c.t.tooBig(path, Math.round(st.size / 1_000_000))
    : null
}

// A model reply that repeats a key (seen in a removed or context line) is dropped.
const safeText = (text: CommitText, files: readonly string[]): CommitText =>
  [text.subject, text.body, ...text.warnings].some(x => x.split('\n').some(l => scanLine(l) !== null))
    ? { subject: fallbackSubject(files), body: '', warnings: [] }
    : text

async function trailerLines($: EngineInterface): Promise<string[]> {
  return trailers(await read($, attribution), prettyModel(await $.session.model()))
}

async function messageFor(
  $: EngineInterface,
  c: Ctx,
  ready: readonly string[],
  stat: string,
  diff: string,
  recent: readonly string[],
): Promise<CommitText> {
  const reply = await $.model
    .complete({
      model: c.cfg.commitModel,
      system: commitSystem({
        commitLanguage: c.cfg.commitLanguage,
        warningLanguage: c.t.warningLanguage,
        isBugCheck: c.cfg.isBugCheck,
      }),
      prompt: commitPrompt(stat, diff, recent),
      maxTokens: 500,
      effort: 'low',
      timeoutMs: 45_000,
    })
    .catch(() => null)
  const parsed = parseCommitReply(reply?.isAnswered === true ? reply.text : '', ready)
  return safeText(c.cfg.isBugCheck ? parsed : { ...parsed, warnings: [] }, ready)
}

export type CommitResult = { settled: string[]; sha: string | null }

// One commit of the tracked `paths` in `root`, built in an index of its own:
// what the scan reads is exactly what the commit holds, and the person's own
// index is touched only once the commit exists. Resolves the tracked paths
// settled (committed, already clean, or held back with an alert), the others
// staying pending, and the new commit when one was made.
export async function commitRepo($: EngineInterface, c: Ctx, root: string, paths: readonly string[]): Promise<CommitResult> {
  if (await $.fs.exists(`${root}/.no-auto-commit`)) return { settled: [...paths], sha: null }
  const gitDir = await gitDirOf($, root)
  if (gitDir === null || (await isBusy($, root, gitDir))) return { settled: [], sha: null }
  const index = `${gitDir}/${INDEX_FILE}${c.w.tag}`
  try {
    return await commitIn($, c, root, gitDir, index, paths)
  } finally {
    // Used up, whatever the outcome: the next commit seeds a new one from HEAD.
    if (await $.fs.exists(index).catch(() => true)) await removeFiles($, c, [index])
  }
}

async function commitIn(
  $: EngineInterface,
  c: Ctx,
  root: string,
  gitDir: string,
  index: string,
  paths: readonly string[],
): Promise<CommitResult> {
  const { t } = c
  const name = repoName(root)
  const none = (settled: string[]): CommitResult => ({ settled, sha: null })
  const journal = `${gitDir}/${JOURNAL_FILE}${c.w.tag}`
  await recoverJournal($, c, root, journal)

  const statusRaw = await statusText($, root)
  if (statusRaw === null) return none([])
  const status = parsePorcelain(statusRaw)
  await warnStaleIndex($, c, root, staleIndexCount(statusRaw))
  const isCaseInsensitive = out(await git($, root, ['config', '--bool', '--get', 'core.ignorecase'])) === 'true'
  const { found, missing } = matchStatus(paths, status, isCaseInsensitive)
  const settled = [...missing]
  const spellings = (p: string): string[] => found.get(p) ?? [p]

  const candidates: string[] = []
  for (const p of found.keys()) {
    const reason = await heldBackReason($, c, root, p, status.get(p) ?? '  ')
    if (reason === null) {
      candidates.push(p)
    } else {
      settled.push(...spellings(p))
      await alert($, c, name, reason)
    }
  }
  if (candidates.length === 0) return none(settled)

  const env = { GIT_INDEX_FILE: index }
  const head = out(await git($, root, ['rev-parse', '-q', '--verify', 'HEAD']))
  const hasHead = head !== ''
  const seed = await git($, root, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env })
  const add =
    seed.exitCode !== 0
      ? seed
      : await git($, root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          stdin: candidates.join('\0'),
          env,
        })
  if (add.exitCode !== 0) {
    await alert($, c, name, t.prepareFailed(firstLine(add.stderr)))
    return none(settled)
  }

  // Secret scan of exactly what the commit will hold.
  const scanned = await cachedDiff($, root, candidates, '-U0', env)
  const findings = scanned === null ? null : scanDiff(scanned)
  const known = new Set(candidates)
  if (findings === null || findings.some(f => !known.has(f.file))) {
    await alert($, c, name, t.scanFailed)
    return none([...settled, ...candidates.flatMap(spellings)])
  }
  const flagged = new Set(findings.map(f => f.file))
  for (const f of findings) await alert($, c, name, t.secret(f.file, f.pattern))
  if (flagged.size > 0 && !(await unstage($, root, [...flagged], hasHead, env))) {
    await alert($, c, name, t.dropFailed)
    return none([...settled, ...candidates.flatMap(spellings)])
  }
  const ready = candidates.filter(p => !flagged.has(p))
  settled.push(...[...flagged].flatMap(spellings))
  if (ready.length === 0) return none(settled)

  const diff = (await cachedDiff($, root, ready, '-U3', env)) ?? ''
  const stat = ready.map(p => `${status.get(p) ?? '  '} ${p}`).join('\n')
  // The repo's style: its latest subjects written by hand.
  const log = await git($, root, ['log', `-${RECENT_SUBJECTS}`, '--format=%s', '--invert-grep', `--grep=${AUTO_TRAILER}`]).catch(
    () => null,
  )
  const text = await messageFor($, c, ready, stat, diff, recentSubjects(out(log)))
  const message = `${commitMessage(text, await trailerLines($))}\n`

  // HEAD moved while the message was written: the index is stale, next turn retries.
  if (out(await git($, root, ['rev-parse', '-q', '--verify', 'HEAD'])) !== head) return none(settled)
  await writeJournal($, journal, head, ready)
  // Claude Code runs a mod's git with the repo's hooks off; two minutes covers a slow disk.
  const commit = await git($, root, ['commit', '-q', '-F', '-'], { env, stdin: message, timeoutMs: 120_000 }).catch(
    () => null,
  )
  if (commit === null || commit.exitCode !== 0) {
    await clearJournal($, c, journal)
    await alert($, c, name, t.commitRefused(firstLine(commit?.stderr || commit?.stdout) || t.timedOut))
    return none(settled)
  }

  // The commit must sit on the HEAD its index was built from and hold only the
  // scanned paths. A HEAD that moved during the commit (a commit from a
  // terminal or another session, a pull) would undo that work, and a hook
  // that staged more files (should hooks ever run) would slip them in: the
  // commit is rolled back.
  const sha = out(await git($, root, ['rev-parse', 'HEAD']))
  // Our index holds the tree just committed: a HEAD with another tree is a
  // commit that landed right after ours, never ours to roll back.
  const tree = out(await git($, root, ['write-tree'], { env }))
  const headTree = sha === '' ? '' : out(await git($, root, ['rev-parse', `${sha}^{tree}`]))
  if (tree === '' || headTree !== tree) {
    if (await unstage($, root, ready, true)) await clearJournal($, c, journal)
    await alert($, c, name, t.headRaced)
    return none(settled)
  }
  const parent = out(await git($, root, ['rev-parse', '-q', '--verify', 'HEAD^']))
  const allowed = new Set(ready)
  const strays = (await filesOf($, root, sha)).filter(f => !allowed.has(f))
  if (parent !== head || strays.length > 0) {
    if (sha !== '') {
      await git(
        $,
        root,
        parent === '' ? ['update-ref', '-d', 'HEAD', sha] : ['update-ref', '-m', 'autocommit: rollback', 'HEAD', parent, sha],
      )
    }
    await clearJournal($, c, journal)
    if (strays.length === 0) {
      await alert($, c, name, t.headMoved)
      return none(settled)
    }
    // The hook would do it again on every try: the files are left to the person.
    await alert($, c, name, t.hookStaged(strays.slice(0, 3).join(', ')))
    return none([...settled, ...ready.flatMap(spellings)])
  }

  // The person's index catches up with the new commit for these paths only.
  if (await unstage($, root, ready, true)) {
    await clearJournal($, c, journal)
  } else {
    await alert($, c, name, t.indexStale(ready.slice(0, 3).join(' ')))
  }
  const short = sha.slice(0, 7)
  const entry: CommitLogEntry = { at: Date.now(), root, sha, subject: text.subject, files: ready.length }
  await update($, commits, s => ({ ...s, made: s.made + 1, log: [...s.log, entry].slice(-KEPT_LOG) }))
  $.ui.toast(t.committed(name, short, text.subject), { timeoutMs: 6000 })
  for (const warning of text.warnings) await alert($, c, name, t.bug(short, warning))
  return { settled: [...settled, ...ready.flatMap(spellings)], sha }
}

// ---------------------------------------------------------------- push

// The configured pre-push check, `{root}` and `{files}` (a file listing the
// paths the push changes, one per line) filled in. Empty: no check.
async function prePushCheck($: EngineInterface, c: Ctx, root: string, gitDir: string, files: readonly string[]): Promise<boolean> {
  if (c.cfg.prePushCommand === '') return true
  const listPath = `${gitDir}/${PUSH_LIST_FILE}${c.w.tag}`
  await $.fs.write(listPath, `${files.join('\n')}\n`)
  const argv = splitArgs(c.cfg.prePushCommand).map(a => a.split('{root}').join(root).split('{files}').join(listPath))
  const r = argv.length === 0 ? null : await $.process.run(argv, { cwd: root, timeoutMs: 120_000 }).catch(() => null)
  await removeFiles($, c, [listPath])
  return argv.length === 0 || (r !== null && r.exitCode === 0)
}

// Pushes `root` once the commits it carries pass our scan of their patches
// and the configured pre-push check. Unasked, only to the remotes `autoPush`
// names.
export async function pushRepo($: EngineInterface, c: Ctx, root: string, isAsked: boolean): Promise<void> {
  const { t } = c
  const name = repoName(root)
  const branch = out(await git($, root, ['symbolic-ref', '-q', '--short', 'HEAD']))
  if (branch === '') return
  const remote = out(await git($, root, ['config', '--get', `branch.${branch}.remote`]))
  const merge = out(await git($, root, ['config', '--get', `branch.${branch}.merge`]))
  if (remote === '' || remote === '.' || merge === '') {
    if (isAsked) await alert($, c, name, t.noUpstream)
    return
  }
  const url = out(await git($, root, ['remote', 'get-url', '--push', remote]))
  if (!isAsked && !matchesRemote(url, c.cfg.autoPush)) return

  const ahead = Number(out(await git($, root, ['rev-list', '--count', '@{u}..HEAD']))) || 0
  if (ahead === 0) return

  const patches = await git($, root, ['log', '-p', ...PATCH_FLAGS, '-U0', '--format=', '@{u}..HEAD'])
  const changed = await git($, root, ['diff', '--name-only', '-z', '@{u}..HEAD'])
  const gitDir = await gitDirOf($, root)
  if (patches.exitCode !== 0 || patches.isStdoutTruncated || changed.exitCode !== 0 || gitDir === null) {
    await alert($, c, name, t.unreadable)
    return
  }
  const leak = scanDiff(patches.stdout)[0]
  if (leak !== undefined) {
    await alert($, c, name, t.pushSecret(leak.pattern, leak.file))
    return
  }
  const files = changed.stdout.split('\0').filter(f => f !== '')
  if (!(await prePushCheck($, c, root, gitDir, files))) {
    await alert($, c, name, t.prePushFailed)
    return
  }
  const push = await git($, root, ['push', '--quiet', remote, `HEAD:${merge}`], { timeoutMs: 180_000 }).catch(
    () => null,
  )
  if (push === null || push.exitCode !== 0) {
    await alert($, c, name, t.pushRefused(firstLine(push?.stderr) || t.timedOut))
    return
  }
  $.ui.toast(t.pushed(name, ahead), { timeoutMs: 6000 })
}

async function aheadCount($: EngineInterface, roots: Iterable<string>): Promise<number> {
  let total = 0
  for (const root of roots) {
    const r = await git($, root, ['rev-list', '--count', '@{u}..HEAD']).catch(() => null)
    total += Number(out(r)) || 0
  }
  return total
}

// ---------------------------------------------------------------- drain

// Commits what the agents of the queue changed, one commit per agent and
// repo (a subagent's work and the main loop's each get their own message),
// then pushes where allowed. A pause holds the commits, never an asked push.
async function drainOnce($: EngineInterface, c: Ctx): Promise<void> {
  const { w } = c
  await update($, commits, s => ({ ...s, isBusy: true }))
  try {
    if (!w.isPaused) {
      const jobs: Array<{ root: string; paths: string[] }> = []
      for (const agent of w.queue) {
        for (const [root, paths] of w.tracked.get(agent) ?? []) jobs.push({ root, paths: [...paths] })
      }
      w.queue.clear()
      // A path edited again while its commit is being made stays tracked.
      const seen = new Map<string, number>()
      for (const { root, paths } of jobs) {
        for (const p of paths) seen.set(editKey(root, p), w.edits.get(editKey(root, p)) ?? 0)
      }

      // A path two agents changed goes with the first commit; the second
      // finds it clean and lets it go.
      const committed = new Set<string>()
      for (const { root, paths } of jobs) {
        const r = await commitRepo($, c, root, paths).catch(async (err: unknown): Promise<CommitResult> => {
          await alert($, c, repoName(root), c.t.failed(firstLine(String(err))))
          return { settled: [], sha: null }
        })
        forget(w, root, r.settled, seen)
        if (r.sha !== null) committed.add(root)
      }
      for (const root of committed) await pushRepo($, c, root, false).catch(() => undefined)
    }

    if (w.isPushAsked) {
      w.isPushAsked = false
      const cwdPlace = await repoAt($, c, w.cwd)
      const targets = new Set([...w.repos, ...(cwdPlace === null ? [] : [cwdPlace.root])])
      for (const root of targets) await pushRepo($, c, root, true).catch(() => undefined)
    }
  } finally {
    await saveTracking($, c).catch(() => undefined)
    const toPush = await aheadCount($, w.repos).catch(() => 0)
    await update($, commits, s => ({ ...s, isBusy: false, toPush, pending: pendingCount(w) }))
  }
}

// Never two at once: a call while one runs does nothing (the timer calls
// again), and a caller that must see its own work through awaits `w.running`.
export async function drain($: EngineInterface, c: Ctx): Promise<void> {
  if (c.w.running !== null || c.w.gitCommands > 0) return
  if ((c.w.queue.size === 0 || c.w.isPaused) && !c.w.isPushAsked) return
  const run: Promise<void> = drainOnce($, c).finally(() => {
    if (c.w.running === run) c.w.running = null
  })
  c.w.running = run
  await run
}

// Undo and squash rewrite HEAD: they wait for a running commit, and the next
// drain waits for them.
async function exclusive($: EngineInterface, c: Ctx, job: 'undo' | 'squash'): Promise<string> {
  while (c.w.running !== null) await c.w.running.catch(() => undefined)
  const run = job === 'undo' ? undoLast($, c) : squashSession($, c)
  const slot = run.then(
    () => undefined,
    () => undefined,
  )
  c.w.running = slot
  try {
    return await run
  } finally {
    if (c.w.running === slot) c.w.running = null
  }
}

// ---------------------------------------------------------------- undo, squash

// Commits on HEAD that no remote-tracking branch holds.
async function unpushed($: EngineInterface, root: string): Promise<Set<string>> {
  const r = await git($, root, ['rev-list', '--max-count=1000', 'HEAD', '--not', '--remotes']).catch(() => null)
  return new Set(out(r).split('\n').filter(x => x !== ''))
}

async function filesOf($: EngineInterface, root: string, sha: string): Promise<string[]> {
  const r = await git($, root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha])
  return r.exitCode === 0 ? r.stdout.split('\0').filter(f => f !== '') : []
}

// Drops the session's last auto-commit when nothing came after it and it was
// never pushed: HEAD steps back, the files keep their content, uncommitted.
export async function undoLast($: EngineInterface, c: Ctx): Promise<string> {
  const { t } = c
  const log = (await read($, commits)).log
  const last = log[log.length - 1]
  if (last === undefined) return t.undoNothing
  const root = last.root
  const name = repoName(root)
  const gitDir = await gitDirOf($, root)
  if (gitDir === null || (await isBusy($, root, gitDir))) return t.undoBusy(name)
  if (out(await git($, root, ['rev-parse', 'HEAD'])) !== last.sha) return t.undoMoved(name)
  if (!(await unpushed($, root)).has(last.sha)) return t.undoPushed(name)
  const parent = out(await git($, root, ['rev-parse', '-q', '--verify', `${last.sha}^`]))
  if (parent === '') return t.undoRoot(name)

  const files = await filesOf($, root, last.sha)
  const moved = await git($, root, ['update-ref', '-m', 'autocommit: undo', 'HEAD', parent, last.sha])
  if (moved.exitCode !== 0) return t.undoFailed(name, firstLine(moved.stderr))
  // The index follows HEAD back for these files: their changes show as unstaged.
  if (!(await unstage($, root, files, true))) await alert($, c, name, t.indexStale(files.slice(0, 3).join(' ')))
  await update($, commits, s => ({ ...s, made: Math.max(0, s.made - 1), log: s.log.filter(e => e.sha !== last.sha) }))
  return t.undone(name, last.sha.slice(0, 7), last.subject, files.length)
}

// Folds the session's unpushed auto-commits sitting in a row at HEAD into one
// commit with the same tree: no file, index or working tree is touched.
async function squashRepo($: EngineInterface, c: Ctx, root: string, log: readonly CommitLogEntry[]): Promise<string | null> {
  const { t } = c
  const name = repoName(root)
  const ours = new Map(log.filter(e => e.root === root).map(e => [e.sha, e]))
  if (ours.size < 2) return null
  const gitDir = await gitDirOf($, root)
  if (gitDir === null || (await isBusy($, root, gitDir))) return null

  const free = await unpushed($, root)
  const chain = out(await git($, root, ['rev-list', '--first-parent', `--max-count=${ours.size + 1}`, 'HEAD']))
    .split('\n')
    .filter(x => x !== '')
  const run: CommitLogEntry[] = []
  for (const sha of chain) {
    const entry = ours.get(sha)
    if (entry === undefined || !free.has(sha)) break
    run.push(entry)
  }
  if (run.length < 2) return null
  run.reverse()
  const oldest = run[0]
  const head = run[run.length - 1]
  if (oldest === undefined || head === undefined) return null
  const base = out(await git($, root, ['rev-parse', '-q', '--verify', `${oldest.sha}^`]))

  const subjects = run.map(e => e.subject)
  const stat = out(await git($, root, ['diff', '--stat=100', base === '' ? EMPTY_TREE : base, head.sha]))
  const reply = await $.model
    .complete({
      model: c.cfg.commitModel,
      system: squashSystem(c.cfg.commitLanguage),
      prompt: squashPrompt(subjects, stat),
      maxTokens: 400,
      effort: 'low',
      timeoutMs: 45_000,
    })
    .catch(() => null)
  const answer = reply?.isAnswered === true && /"subject"\s*:/.test(reply.text) ? reply.text : ''
  const parsed = parseCommitReply(answer, [])
  const isLeaky = [parsed.subject, parsed.body].some(x => x.split('\n').some(l => scanLine(l) !== null))
  const isModel = answer !== '' && !isLeaky
  const subject = isModel ? parsed.subject : `${subjects[0] ?? 'chore: squash'} (+${run.length - 1})`.slice(0, 72)
  const summary = isModel && parsed.body !== '' ? [parsed.body, ''] : []
  const body = [...summary, t.squashedHeader, ...subjects.map(x => `- ${x}`)].join('\n')
  const message = commitMessage({ subject, body }, await trailerLines($))

  const made = await git($, root, ['commit-tree', `${head.sha}^{tree}`, ...(base === '' ? [] : ['-p', base]), '-F', '-'], {
    stdin: `${message}\n`,
  })
  const sha = out(made)
  if (sha === '') return t.squashFailed(name, firstLine(made.stderr))
  const moved = await git($, root, ['update-ref', '-m', 'autocommit: squash', 'HEAD', sha, head.sha])
  if (moved.exitCode !== 0) return t.squashFailed(name, firstLine(moved.stderr))

  const folded = new Set(run.map(e => e.sha))
  const files = (await filesOf($, root, sha)).length
  await update($, commits, s => ({
    ...s,
    made: Math.max(1, s.made - run.length + 1),
    log: [...s.log.filter(e => !folded.has(e.sha)), { at: Date.now(), root, sha, subject, files }].slice(-KEPT_LOG),
  }))
  return t.squashed(name, run.length, sha.slice(0, 7), subject)
}

export async function squashSession($: EngineInterface, c: Ctx): Promise<string> {
  const log = (await read($, commits)).log
  const roots = [...new Set(log.map(e => e.root))]
  const results: string[] = []
  for (const root of roots) {
    const r = await squashRepo($, c, root, log).catch((err: unknown) => c.t.squashFailed(repoName(root), firstLine(String(err))))
    if (r !== null) results.push(r)
  }
  return results.length === 0 ? c.t.squashNothing : results.join('\n')
}

// ---------------------------------------------------------------- report

export const commitsReport = (c: Ctx, s: CommitState): string => {
  const { t, w } = c
  const ago = (at: number): string => t.ago(Math.round((Date.now() - at) / 60_000))
  const lines = [t.report(s.isPaused, s.made, s.toPush, s.pending)]
  if (c.cfg.autoPush.length > 0) lines.push(t.autoPushTo(c.cfg.autoPush.join(', ')))
  if (s.log.length > 0) {
    lines.push('', t.latest)
    for (const e of s.log.slice(-10)) {
      lines.push(`  ${e.sha.slice(0, 7)}  ${repoName(e.root)}  ${e.subject}  (${t.files(e.files)}, ${ago(e.at)})`)
    }
  }
  if (s.alerts.length > 0) {
    lines.push('', t.alerts)
    for (const a of s.alerts.slice(-10)) {
      lines.push(`  ⚠ ${t.alert(a.repo, a.text).slice(2)}${a.count > 1 ? ` (x${a.count})` : ''} (${ago(a.at)})`)
    }
  }
  const waiting: string[] = []
  for (const [agent, repos] of w.tracked) {
    for (const [root, paths] of repos) {
      const who = agent === MAIN ? t.session : t.agent(agent.slice(0, 8))
      const shown = [...paths].slice(0, 5).join(', ')
      waiting.push(`  ${repoName(root)} (${who}): ${shown}${paths.size > 5 ? t.more(paths.size - 5) : ''}`)
    }
  }
  if (waiting.length > 0) lines.push('', t.waitingFor, ...waiting)
  lines.push('', t.help)
  return lines.join('\n')
}

// ================================================================ hooks

const BAR_CELLS = 20
const NARROW_BAR_CELLS = 10
const NARROW_COLUMNS = 100
const REFRESH_MS = 2000

export const shortTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

export const barCells = (tokens: number, max: number, cells = BAR_CELLS): number =>
  Math.min(cells, Math.max(0, Math.round((tokens / max) * cells)))

export const barColor = (percent: number): string => (percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green')

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const sameSnap = (a: Snapshot | null, b: Snapshot): boolean =>
  a !== null &&
  a.model === b.model &&
  a.effort === b.effort &&
  a.tokens === b.tokens &&
  a.max === b.max &&
  a.isRemoteOn === b.isRemoteOn &&
  a.remoteClients === b.remoteClients

// Model, effort, context against the auto-compact window, Remote Control.
async function refresh($: EngineInterface, liveEffort: string | null): Promise<void> {
  const [model, usage, settings, surfaces, rows] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.settings.read(),
    $.session.surfaces(),
    $.config.list(),
  ])

  const compactWindow = settings.autoCompactWindow
  const max =
    typeof compactWindow === 'number' && compactWindow > 0
      ? Math.min(compactWindow, usage.context.window)
      : usage.context.window

  const modelSettings = asRecord(asRecord(settings.modelSettings)[model])
  const fallbackEffort = modelSettings.effortLevel ?? settings.effortLevel
  const effort = liveEffort ?? (typeof fallbackEffort === 'string' ? fallbackEffort : null)

  const remoteClients = surfaces.filter(s => s !== 'terminal').length
  const remoteRow = rows.find(r => typeof r.value === 'boolean' && /remote/i.test(`${r.key} ${r.label}`))
  const startupSetting = settings.remoteControlAtStartup
  const configured =
    remoteRow !== undefined
      ? (remoteRow.value as boolean)
      : typeof startupSetting === 'boolean'
        ? startupSetting
        : null
  const isRemoteOn = remoteClients > 0 ? true : configured

  const next: Snapshot = { model, effort, tokens: usage.context.tokens ?? null, max, isRemoteOn, remoteClients }
  if (!sameSnap(await read($, snap), next)) await update($, snap, () => next)
}

// Commits right after a turn ends, outside the turn's own dispatch; the
// two-second timer is the safety net.
function drainSoon($: EngineInterface, c: Ctx): void {
  $.clock.after(50, () => void drain($, c).catch(() => undefined))
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const t = strings(cfg.language)
  const w = newWork()
  const c: Ctx = { w, cfg, t }
  // Effort seen on the main loop's last request; null until the first one.
  let liveEffort: string | null = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    w.cwd = normPath(e.cwd)
    w.isInteractive = e.isInteractive
    w.tag = tagOf(await $.session.id().catch(() => ''))
    w.isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
    // A reload (settings changed, mod updated) picks up what was pending.
    await loadTracking($, c)
    await update($, commits, s => ({ ...s, isBusy: false, pending: pendingCount(w) }))
    await $.command.register({
      name: 'commits',
      description:
        cfg.language === 'fr'
          ? 'Commits auto : historique, alertes, pause, annuler, fusionner, pousser'
          : 'Auto-commits: history, alerts, pause, undo, squash, push',
      argumentHint: cfg.language === 'fr' ? '[pause|reprendre|tout|annuler|fusionner|pousser]' : '[pause|resume|now|undo|squash|push]',
    })
    if (cfg.bar !== 'off') await refresh($, liveEffort).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => {
      if (cfg.bar !== 'off') void refresh($, liveEffort).catch(() => undefined)
      void drain($, c).catch(() => undefined)
    })
    if (w.queue.size > 0) drainSoon($, c)
    return result
  })

  // The main loop works from its turn's start to its end (a subagent's run
  // raises no turn.start).
  on('turn.start', async (_$, e, next) => {
    w.isMainWorking = true
    return next(e)
  })

  on('turn.step', async function* (_$, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) liveEffort = String(e.effort)
    return yield* next(e)
  })

  // The commit trailer as Claude Code composes it with the person's settings.
  on('attribution.text', { kind: 'commit' }, async ($, e, next) => {
    const result = await next(e)
    if ((await read($, attribution)) !== result.text) await update($, attribution, () => result.text)
    return result
  })

  // Who changed what: an edit names its file; a shell command is judged by
  // the status and content of the watched repos before and after it.
  on('tool.call', async ($, e, next) => {
    const agent = e.agentId ?? MAIN
    w.idle.delete(agent)
    if (agent === MAIN) w.isMainWorking = true
    const tool = String(e.tool)
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const result = await next(e)
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
      const file = tool === 'NotebookEdit' ? input.notebook_path : input.file_path
      if (result.deny === undefined && result.isError !== true && typeof file === 'string') {
        await trackFile($, c, agent, file).catch(() => undefined)
      }
      return result
    }
    if (tool !== 'Bash' && tool !== 'PowerShell') return next(e)
    const input = e as unknown as { command?: unknown; run_in_background?: unknown }
    const command = typeof input.command === 'string' ? input.command : ''
    if (command === '' || input.run_in_background === true || isReadOnlyCommand(command)) return next(e)

    // Claude's own git command (a commit, a checkout) never runs beside one
    // of ours, and none of ours starts while it runs: they would fight over
    // the index lock, or ours would be built on a HEAD that is gone.
    const isGit = /\bgit\b/.test(command)
    if (isGit) {
      while (w.running !== null) await w.running.catch(() => undefined)
      w.gitCommands++
    }
    try {
      const roots = await watchedRoots($, c, command).catch(() => [] as string[])
      const before = await Promise.all(roots.map(r => stateOf($, r)))
      const result = await next(e)
      if (result.deny !== undefined || result.isReadOnly === true || roots.length === 0) return result
      const after = await Promise.all(roots.map(r => stateOf($, r)))
      await recordCommand($, c, agent, roots, before, after).catch(() => undefined)
      return result
    } finally {
      if (isGit) w.gitCommands--
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agent = e.agentId ?? MAIN
    if (agent === MAIN) w.isMainWorking = false
    if (e.reason !== 'answer') return result
    w.idle.add(agent)
    // A subagent done while the main loop still works (waiting for it, or
    // going on): its files wait for the main turn's end, so a commit Claude
    // makes of them meanwhile comes first and keeps its message. Headless
    // (claude -p), they go at once: the process may end with no main answer.
    if (agent !== MAIN && w.isMainWorking && w.isInteractive) return result
    // This agent's files, and those every idle agent left pending (a
    // subagent that ended during the main turn, a commit refused or rolled
    // back), whose turn will not end again.
    for (const a of w.tracked.keys()) {
      if (w.idle.has(a)) w.queue.add(a)
    }
    if (w.queue.size > 0) {
      await saveTracking($, c).catch(() => undefined)
      if (w.isInteractive) {
        drainSoon($, c)
      } else {
        // Without a person (claude -p) the process ends with the turn: commit
        // now, after any run already under way.
        while (w.running !== null) await w.running.catch(() => undefined)
        await drain($, c).catch(() => undefined)
      }
    }
    return result
  })

  on('command.run', { command: 'commits' }, async ($, e) => {
    const action = actionOf(e.args)
    switch (action) {
      case 'pause':
      case 'resume': {
        const isPaused = action === 'pause'
        w.isPaused = isPaused
        await update($, commits, s => ({ ...s, isPaused }))
        if (!isPaused) drainSoon($, c)
        return { text: isPaused ? t.isPaused : t.resumed }
      }
      case 'now': {
        for (const agent of w.tracked.keys()) w.queue.add(agent)
        await saveTracking($, c)
        drainSoon($, c)
        return { text: t.now(pendingCount(w)) }
      }
      case 'push':
        w.isPushAsked = true
        drainSoon($, c)
        return { text: t.pushStarted }
      case 'undo':
        return { text: await exclusive($, c, 'undo') }
      case 'squash':
        return { text: await exclusive($, c, 'squash') }
      default: {
        const s = await read($, commits)
        await update($, commits, x => ({ ...x, unseen: 0 }))
        return { text: commitsReport(c, s) }
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (cfg.bar === 'off' || e.props.hasSurvey) return next(e)
    const s = await read($, snap)
    if (s === null) return next(e)
    const c = await read($, commits)

    // What the plugins beneath draw here (Claude Code's own notices): drawn
    // above the band so it never hides them.
    const beneath = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const cells = isNarrow ? NARROW_BAR_CELLS : BAR_CELLS
    const percent = s.tokens === null ? null : Math.round((s.tokens / s.max) * 100)
    const filled = s.tokens === null ? 0 : barCells(s.tokens, s.max, cells)
    const commitParts = [
      t.made(c.made),
      ...(c.toPush > 0 ? [t.toPush(c.toPush)] : []),
      ...(c.pending > 0 ? [t.pending(c.pending)] : []),
    ].join(' · ')
    const isFull = cfg.bar === 'full'

    const band = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {isFull ? <Text bold>{prettyModel(s.model)}</Text> : null}
        {isFull ? (
          <Text>
            <Text dimColor>{`${t.effort} `}</Text>
            {s.effort ?? '?'}
          </Text>
        ) : null}
        <Box flexDirection="row">
          <Text dimColor>{`${t.context} `}</Text>
          <Text color={barColor(percent ?? 0)}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(cells - filled)}</Text>
          <Text>
            {percent === null
              ? ` ${t.waiting} / ${shortTokens(s.max)}`
              : ` ${shortTokens(s.tokens ?? 0)} / ${shortTokens(s.max)} (${t.percent(percent)})`}
          </Text>
        </Box>
        {isFull && s.isRemoteOn !== null ? (
          <Text>
            <Text dimColor>{`${t.rc} `}</Text>
            {s.isRemoteOn ? (
              <Text color="green">
                {t.rcOn}
                {s.remoteClients > 0 ? t.devices(s.remoteClients) : ''}
              </Text>
            ) : (
              <Text dimColor>{t.rcOff}</Text>
            )}
          </Text>
        ) : null}
        <Text>
          <Text dimColor>{`${t.commits} `}</Text>
          {c.isPaused ? <Text color="yellow">{t.paused}</Text> : commitParts}
          {c.isBusy ? <Text dimColor> …</Text> : null}
          {c.unseen > 0 ? <Text color="red">{` ⚠ ${c.unseen}`}</Text> : null}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {beneath}
        {band}
      </Box>
    )
  })
}
