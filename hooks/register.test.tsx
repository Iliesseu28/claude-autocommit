import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { barCells, barColor, forget, newWork, shortTokens, track } from './register'

// A whole session against a git repo held in memory: the hooks below stand
// for the engine and answer every call the mod makes.

const ROOT = '/repo'
const GIT_DIR = '/repo/.git'
const BASE = '0'.repeat(40)
// Built from pieces so this file never holds a whole key.
const KEY = ['ghp', '_', 'Ab1'.repeat(12)].join('')

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const USAGE = {
  startedAt: 0,
  context: { tokens: 120_000, window: 1_000_000, percent: 12 },
  rateLimits: [],
}

const SETTINGS = { autoCompactWindow: 300_000, effortLevel: 'xhigh', remoteControlAtStartup: true }

const MODEL_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const run = (stdout = '', exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

type Commit = { parent: string | null; files: string[]; patch: string; subject: string }
type Call = { args: string[]; stdin: string; isTempIndex: boolean }

const patchOf = (file: string, lines: readonly string[]): string =>
  `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n${lines.map(l => `+${l}`).join('\n')}\n`

// The engine resolves a path for the host it runs on (`C:\repo` on Windows).
const posix = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// The repo, the engine nouns the mod reads, and what it did.
function fakeWorld(on: On, surfaces: readonly string[] = ['terminal']) {
  const clock = mock.clock(on)
  const w = {
    status: new Map<string, string>(),
    versions: new Map<string, number>(),
    lines: new Map<string, string[]>(),
    commits: new Map<string, Commit>([[BASE, { parent: null, files: ['README.md'], patch: '', subject: 'init' }]]),
    head: BASE,
    count: 0,
    pushed: new Set([BASE]),
    hasUpstream: false,
    url: 'git@github.com:me/notes.git',
    isDetached: false,
    commitError: '',
    // What runs while `git commit` does: a commit from elsewhere, a hook's `git add`.
    beforeCommit: (): void => undefined,
    hookAdds: [] as string[],
    staged: new Set<string>(),
    calls: [] as Call[],
    userResets: [] as string[][],
    checks: [] as string[][],
    checkExit: 0,
    files: new Map<string, string>(),
    markers: new Set<string>(),
    toasts: [] as string[],
    models: 0,
    warnings: [] as string[],
    onBash: (_command: string): void => undefined,
  }

  const touch = (path: string, xy = ' M', lines: readonly string[] = ['changed']): void => {
    w.status.set(path, xy)
    w.versions.set(path, (w.versions.get(path) ?? 0) + 1)
    w.lines.set(path, [...lines])
  }
  const chain = (): string[] => {
    const out: string[] = []
    for (let s: string | null = w.head; s !== null; s = w.commits.get(s)?.parent ?? null) out.push(s)
    return out
  }
  const unpushed = (): string[] => chain().filter(s => !w.pushed.has(s))
  const nextSha = (): string => String(++w.count).repeat(40).slice(0, 40)
  const subjectAt = (path: string): string => (w.files.get(path) ?? '').split('\n')[0] ?? ''
  const callsOf = (sub: string): Call[] => w.calls.filter(c => c.args[0] === sub)

  const git = (dir: string, args: string[], stdin: string, isTempIndex: boolean) => {
    w.calls.push({ args, stdin, isTempIndex })
    if (dir !== ROOT && !dir.startsWith(`${ROOT}/`)) return run('', 128, 'fatal: not a git repository')
    const [sub = '', ...rest] = args
    const last = rest[rest.length - 1] ?? ''
    switch (sub) {
      case 'rev-parse': {
        if (rest.includes('--show-toplevel')) return run(`${ROOT}\n${dir === ROOT ? '' : `${dir.slice(ROOT.length + 1)}/`}\n`)
        if (rest.includes('--absolute-git-dir')) return run(`${GIT_DIR}\n`)
        if (last.endsWith('^')) {
          const ref = last.slice(0, -1)
          const parent = w.commits.get(ref === 'HEAD' ? w.head : ref)?.parent ?? null
          return parent === null ? run('', 1) : run(`${parent}\n`)
        }
        return run(`${w.head}\n`)
      }
      case 'symbolic-ref':
        if (w.isDetached) return run('', 1)
        return run(rest.includes('--short') ? 'main\n' : 'refs/heads/main\n')
      case 'config':
        if (last === 'core.ignorecase') return run('false\n')
        if (!w.hasUpstream) return run('', 1)
        return run(last === 'branch.main.remote' ? 'origin\n' : 'refs/heads/main\n')
      case 'remote':
        return run(`${w.url}\n`)
      case 'status':
        return run([...w.status].map(([p, xy]) => `${xy} ${p}\0`).join(''))
      case 'hash-object':
        return run(`${stdin.split('\n').filter(p => p !== '').map(p => `h${w.versions.get(p) ?? 0}`).join('\n')}\n`)
      case 'read-tree':
        w.staged.clear()
        return run()
      case 'add':
        for (const p of stdin.split('\0')) w.staged.add(p)
        return run()
      case 'reset': {
        const paths = stdin.split('\0').filter(p => p !== '')
        if (isTempIndex) for (const p of paths) w.staged.delete(p)
        else w.userResets.push(paths)
        return run()
      }
      case 'diff': {
        if (rest[0] === '--cached') {
          const asked = rest.slice(rest.indexOf('--') + 1)
          return run(asked.filter(p => w.staged.has(p)).map(p => patchOf(p, w.lines.get(p) ?? [])).join(''))
        }
        if (rest.includes('--name-only')) return run(unpushed().flatMap(s => w.commits.get(s)?.files ?? []).join('\0'))
        return run(' a.ts | 1 +\n')
      }
      case 'commit': {
        if (w.commitError !== '') return run('', 1, w.commitError)
        w.beforeCommit()
        for (const f of w.hookAdds) w.staged.add(f)
        const files = [...w.staged].sort()
        const sha = nextSha()
        const patch = files.map(f => patchOf(f, w.lines.get(f) ?? [])).join('')
        w.commits.set(sha, { parent: w.head, files, patch, subject: subjectAt(last) })
        w.head = sha
        for (const f of files) w.status.delete(f)
        w.staged.clear()
        return run()
      }
      case 'commit-tree': {
        const base = rest.includes('-p') ? (rest[rest.indexOf('-p') + 1] ?? null) : null
        const files = new Set<string>()
        for (const s of chain()) {
          if (s === base) break
          for (const f of w.commits.get(s)?.files ?? []) files.add(f)
        }
        const sha = nextSha()
        w.commits.set(sha, { parent: base, files: [...files].sort(), patch: '', subject: subjectAt(last) })
        return run(`${sha}\n`)
      }
      case 'update-ref': {
        const [, , , to = '', from = ''] = rest
        if (from !== w.head) return run('', 1, 'cannot lock ref HEAD')
        // Stepping back to the parent leaves the commit's changes in the working tree.
        const left = w.commits.get(from)
        if (left?.parent === to) for (const f of left.files) w.status.set(f, ' M')
        w.head = to
        return run()
      }
      case 'rev-list': {
        if (rest.includes('--count')) return w.hasUpstream ? run(`${unpushed().length}\n`) : run('', 128, 'no upstream')
        if (rest.includes('--not')) return run(unpushed().join('\n'))
        const max = Number(rest.find(a => a.startsWith('--max-count='))?.split('=')[1] ?? '1000')
        return run(chain().slice(0, max).join('\n'))
      }
      case 'log':
        return run(unpushed().map(s => w.commits.get(s)?.patch ?? '').join(''))
      case 'diff-tree':
        return run((w.commits.get(last)?.files ?? []).join('\0'))
      case 'push':
        for (const s of chain()) w.pushed.add(s)
        return run()
      default:
        return run()
    }
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: USAGE }))
  on('settings.read', () => ({ value: SETTINGS }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('config.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('attribution.text', (_$, e) => ({ text: e.text }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(posix(e.path)) || w.markers.has(posix(e.path)) }))
  on('fs.read', (_$, e) => ({ value: w.files.get(posix(e.path)) ?? '' }))
  on('fs.write', (_$, e) => {
    w.files.set(posix(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 40, mtimeMs: 0, isLink: false } }))
  on('model.complete', (_$, e) => {
    w.models++
    const text = (e.system ?? '').startsWith('You merge')
      ? '{"subject":"feat: add the three notes","body":"Grouped the session work."}'
      : JSON.stringify({ subject: 'feat: update the notes', body: '', warnings: w.warnings })
    return { value: { isAnswered: true as const, text, usage: MODEL_USAGE } }
  })
  on('tool.call', (_$, e) => {
    const input = e as unknown as { tool: string; command?: string }
    if (input.tool === 'Bash') w.onBash(input.command ?? '')
    return { result: { type: 'create' }, text: 'done' } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', (_$, e) => {
    const { Box, Text } = _$.ui.resolve(e)
    return (
      <Box>
        <Text>NOTICE BENEATH</Text>
      </Box>
    )
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] !== 'git') {
      w.checks.push(argv)
      return { value: run('', w.checkExit, w.checkExit === 0 ? '' : 'check failed') }
    }
    const at = argv.indexOf('-C')
    return {
      value: git(argv[at + 1] ?? '', argv.slice(at + 2), e.init?.stdin ?? '', e.init?.env?.GIT_INDEX_FILE !== undefined),
    }
  })

  return { w, touch, chain, callsOf, clock }
}


const start = (isInteractive = false) => ({ cwd: ROOT, surface: 'terminal' as const, isInteractive })
const write = (path: string, agentId?: string) => ({
  tool: 'Write' as const,
  file_path: `${ROOT}/${path}`,
  content: 'x',
  ...(agentId === undefined ? {} : { agentId }),
})
const turnEnd = (agentId?: string) => ({
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})
const commits = (args = '') => ({
  command: 'commits',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

async function bandText($: Engine, surface: 'terminal' | 'desktop' = 'terminal', columns = 120): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'autocommit',
    surface,
    component: 'AbovePrompt',
    props: { ...PROPS, bodyColumns: columns },
  })
  return (await ui.findAll({})).map(el => el.text).join(' ')
}

async function report($: Engine, args = ''): Promise<string> {
  return (await $.command.run(commits(args))).text ?? ''
}

// ---------------------------------------------------------------- band

test('bar helpers', () => {
  expect(shortTokens(120_400)).toBe('120k')
  expect(shortTokens(900)).toBe('900')
  expect(barCells(150_000, 300_000)).toBe(10)
  expect(barCells(900_000, 300_000)).toBe(20)
  expect(barCells(150_000, 300_000, 10)).toBe(5)
  expect([barColor(50), barColor(70), barColor(90)]).toEqual(['green', 'yellow', 'red'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band on ${surface}: model, effort, context, Remote Control, commits`, async ($, on) => {
    fakeWorld(on, ['terminal', 'mobile'])
    await $.session.start({ ...start(true), surface })
    const text = await bandText($, surface)
    for (const part of ['Opus 5.5', 'xhigh', '120k / 300k (40%)', 'on (1 device)', 'commits', '0 auto', 'NOTICE BENEATH']) {
      expect([part, text.includes(part)]).toEqual([part, true])
    }
    expect(text.includes('░'.repeat(12))).toBe(true)
    // A narrow window gets a shorter gauge.
    expect((await bandText($, surface, 80)).includes('░'.repeat(7))).toBe(false)
  })

  test(`band in French on ${surface}`, { options: { language: 'fr' } }, async ($, on) => {
    fakeWorld(on, ['terminal', 'mobile'])
    await $.session.start({ ...start(true), surface })
    const text = await bandText($, surface)
    expect(text).toContain('contexte')
    expect(text).toContain('120k / 300k (40 %)')
    expect(text).toContain('actif (1 appareil)')
  })
}

test('compact band drops model, effort and RC; off draws nothing of ours', { options: { bar: 'compact' } }, async ($, on) => {
  fakeWorld(on)
  await $.session.start(start(true))
  const text = await bandText($)
  expect(text).toContain('context')
  expect(text).not.toContain('Opus 5.5')
  expect(text).not.toContain('xhigh')
})

test('bar off leaves the place to what is beneath', { options: { bar: 'off' } }, async ($, on) => {
  fakeWorld(on)
  await $.session.start(start(true))
  const text = await bandText($)
  expect(text).toContain('NOTICE BENEATH')
  expect(text).not.toContain('context')
})

// ---------------------------------------------------------------- commit

test('end of turn: one commit of the session files, secret and .env held back', async ($, on) => {
  const { w, touch, callsOf } = fakeWorld(on)
  w.warnings = ['console.log left in a.ts']
  touch('other.ts')
  await $.session.start(start())
  await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: Bot <bot@example.com>' })

  touch('src/a.ts', ' M', ['console.log("debug")'])
  await $.tool.call(write('src/a.ts'))
  touch('src/leak.ts', '??', [`export const t = "${KEY}"`])
  await $.tool.call(write('src/leak.ts'))
  touch('.env', '??', ['TOKEN=x'])
  await $.tool.call(write('.env'))
  await $.turn.complete(turnEnd())

  // Built in an index of its own: the .env never reaches it, the leak is dropped.
  expect(callsOf('read-tree').map(c => c.isTempIndex)).toEqual([true])
  expect(callsOf('add').map(c => [c.stdin.split('\0').sort(), c.isTempIndex])).toEqual([[['src/a.ts', 'src/leak.ts'], true]])
  expect(callsOf('commit').map(c => c.isTempIndex)).toEqual([true])
  expect(w.commits.get(w.head)?.files).toEqual(['src/a.ts'])
  // The person's own index catches up for the committed file only.
  expect(w.userResets).toEqual([['src/a.ts']])
  // The foreign file and the held-back ones stay as they were.
  expect([...w.status.keys()].sort()).toEqual(['.env', 'other.ts', 'src/leak.ts'])

  const message = w.files.get(`${GIT_DIR}/AUTOCOMMIT_MSG`) ?? ''
  expect(message).toContain('feat: update the notes')
  expect(message).toContain('Auto-commit: claude-autocommit')
  expect(message).toContain('Co-Authored-By: Bot <bot@example.com>')
  expect(message).not.toContain('noreply@anthropic.com')
  expect(message).not.toContain(KEY)
  expect(w.files.get(`${GIT_DIR}/AUTOCOMMIT_RESET`)).toBe('')
  expect(w.toasts).toContain('✓ repo 1111111  feat: update the notes')

  expect(await bandText($)).toContain('⚠ 3')
  const text = await report($)
  expect(text).toContain('1 commit this session, 0 to push, 0 files pending')
  expect(text).toContain('1111111  repo  feat: update the notes  (1 file, just now)')
  expect(text).toContain('src/leak.ts: possible secret (GitHub token), not committed')
  expect(text).toContain('.env: .env file, never committed')
  expect(text).toContain('possible bug (1111111): console.log left in a.ts')
  expect(text).not.toContain(KEY)
  // Reading the report clears the alert count.
  expect(await bandText($)).not.toContain('⚠')
})

test('the default trailer names the session model', async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  expect(w.files.get(`${GIT_DIR}/AUTOCOMMIT_MSG`)).toContain('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')
})

test('shell commands: changes are found by comparing the repo before and after', { options: { maxFilesPerCommand: 3 } }, async ($, on) => {
  const { w, touch, callsOf } = fakeWorld(on)
  touch('foreign.ts')
  await $.session.start(start())

  w.onBash = () => {
    touch('b.ts')
    touch('c.ts', '??')
  }
  await $.tool.call({ tool: 'Bash', command: 'npm run format' })

  // A read-only command is not snapshotted at all.
  w.onBash = () => undefined
  const statusCalls = callsOf('status').length
  await $.tool.call({ tool: 'Bash', command: 'git status && git log --oneline -5' })
  expect(callsOf('status').length).toBe(statusCalls)

  // A command that changes too many files at once is reported, not committed.
  w.onBash = () => {
    for (const f of ['g1.ts', 'g2.ts', 'g3.ts', 'g4.ts']) touch(f, '??')
  }
  await $.tool.call({ tool: 'Bash', command: 'npm run codegen' })
  await $.turn.complete(turnEnd())

  expect(w.commits.get(w.head)?.files).toEqual(['b.ts', 'c.ts'])
  expect(w.status.has('foreign.ts')).toBe(true)
  expect(await report($)).toContain('a command changed 4 files at once, not auto-committed')
})

test("a subagent's files wait for the end of its own turn", async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  touch('main.ts')
  await $.tool.call(write('main.ts'))
  touch('agent.ts')
  await $.tool.call(write('agent.ts', 'agent-1234567890'))

  await $.turn.complete(turnEnd())
  expect(w.commits.get(w.head)?.files).toEqual(['main.ts'])
  const text = await report($)
  expect(text).toContain('1 file pending')
  expect(text).toContain('repo (agent agent-12): agent.ts')

  await $.turn.complete(turnEnd('agent-1234567890'))
  expect(w.commits.get(w.head)?.files).toEqual(['agent.ts'])
  expect(await report($)).toContain('2 commits this session, 0 to push, 0 files pending')
})

test('a refused commit (pre-commit hook) keeps the files pending', async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  w.commitError = 'lint failed: 2 errors'
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  expect(w.head).toBe(BASE)
  expect(w.files.get(`${GIT_DIR}/AUTOCOMMIT_RESET`)).toBe('')
  const text = await report($)
  expect(text).toContain('commit refused (lint failed: 2 errors)')
  expect(text).toContain('1 file pending')
})

test('a commit made elsewhere during ours: ours is rolled back, retried next turn', async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  const theirs = 'f'.repeat(40)
  w.beforeCommit = () => {
    w.commits.set(theirs, { parent: w.head, files: ['mine.md'], patch: '', subject: 'mine' })
    w.head = theirs
    w.beforeCommit = () => undefined
  }
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  // The person's commit stays on top; nothing of theirs went into ours.
  expect(w.head).toBe(theirs)
  expect(w.userResets).toEqual([])
  expect(w.files.get(`${GIT_DIR}/AUTOCOMMIT_RESET`)).toBe('')
  const text = await report($)
  expect(text).toContain('HEAD moved during the commit, undone; retrying next turn')
  expect(text).toContain('1 file pending')

  await $.turn.complete(turnEnd())
  expect(w.commits.get(w.head)?.parent).toBe(theirs)
  expect(w.commits.get(w.head)?.files).toEqual(['a.ts'])
})

test('a hook that stages other files: the commit is rolled back, the files left', async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  w.hookAdds = ['generated.lock']
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  expect(w.head).toBe(BASE)
  expect(w.status.has('a.ts')).toBe(true)
  const text = await report($)
  expect(text).toContain('a git hook staged other files (generated.lock): commit undone, left uncommitted')
  expect(text).toContain('0 files pending')
})

test("a subagent's refused files are retried at a later turn end", async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  w.commitError = 'lint failed'
  touch('agent.ts')
  await $.tool.call(write('agent.ts', 'agent-1'))
  await $.turn.complete(turnEnd('agent-1'))
  expect(w.head).toBe(BASE)

  w.commitError = ''
  await $.turn.complete(turnEnd())
  expect(w.commits.get(w.head)?.files).toEqual(['agent.ts'])
})

test('a path edited again while its commit is made stays tracked', () => {
  const w = newWork()
  track(w, 'main', ROOT, ['a.ts', 'b.ts'])
  const seen = new Map([
    [`${ROOT}\0a.ts`, 1],
    [`${ROOT}\0b.ts`, 1],
  ])
  track(w, 'main', ROOT, ['a.ts'])
  forget(w, ROOT, ['a.ts', 'b.ts'], seen)
  expect([...(w.tracked.get('main')?.get(ROOT) ?? [])]).toEqual(['a.ts'])
})

test('nothing is committed mid-rebase or detached, or with .no-auto-commit', async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  w.isDetached = true
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  expect(w.head).toBe(BASE)
  expect(await report($)).toContain('1 file pending')

  w.isDetached = false
  w.markers.add(`${ROOT}/.no-auto-commit`)
  await $.turn.complete(turnEnd())
  expect(w.head).toBe(BASE)
  // Opted out: the file is let go, not kept pending forever.
  expect(await report($)).toContain('0 files pending')
})

test('pause holds the commits, resume sends them', async ($, on) => {
  const { w, touch, clock, callsOf } = fakeWorld(on)
  await $.session.start(start())
  expect(await report($, 'pause')).toBe('Auto-commits paused (files are still tracked).')
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  // The timer does not keep asking git or the model while paused.
  const statusCalls = callsOf('status').length
  await clock.advance(10_000)
  expect(callsOf('status').length).toBe(statusCalls)
  expect(w.models).toBe(0)
  expect(w.head).toBe(BASE)
  expect(await bandText($)).toContain('paused')
  expect(await report($)).toContain('Auto-commits: PAUSED. 0 commits this session, 0 to push, 1 file pending.')

  expect(await report($, 'resume')).toBe('Auto-commits resumed.')
  await clock.advance(100)
  expect(w.commits.get(w.head)?.files).toEqual(['a.ts'])
})

// ---------------------------------------------------------------- undo, squash

test('squash folds the session commits into one, undo steps back', async ($, on) => {
  const { w, touch, callsOf, chain } = fakeWorld(on)
  await $.session.start(start())
  for (const f of ['a.ts', 'b.ts', 'c.ts']) {
    touch(f)
    await $.tool.call(write(f))
    await $.turn.complete(turnEnd())
  }
  const third = w.head
  expect(chain()).toHaveLength(4)

  expect(await report($, 'squash')).toBe('repo: 3 auto-commits squashed into 4444444 "feat: add the three notes".')
  expect(callsOf('commit-tree')[0]?.args.slice(0, 4)).toEqual(['commit-tree', `${third}^{tree}`, '-p', BASE])
  expect(chain()).toEqual(['4'.repeat(40), BASE])
  const message = w.files.get(`${GIT_DIR}/AUTOCOMMIT_MSG`) ?? ''
  expect(message).toContain('Squashed commits:\n- feat: update the notes')
  expect(await bandText($)).toContain('1 auto')

  expect(await report($, 'undo')).toBe(
    'Undone repo 4444444 "feat: add the three notes". Its 3 files stay changed in the working tree, uncommitted.',
  )
  expect(w.head).toBe(BASE)
  expect(w.userResets[w.userResets.length - 1]).toEqual(['a.ts', 'b.ts', 'c.ts'])
  expect(await report($, 'undo')).toBe('No auto-commit to undo in this session.')
})

test('undo refuses a pushed commit and one that is no longer HEAD', async ($, on) => {
  const { w, touch } = fakeWorld(on)
  await $.session.start(start())
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  w.pushed.add(w.head)
  expect(await report($, 'undo')).toBe('repo: the last auto-commit is already pushed, nothing undone (use git revert).')
  w.head = BASE
  expect(await report($, 'undo')).toBe('repo: HEAD is no longer the last auto-commit, nothing undone.')
})

// ---------------------------------------------------------------- push

test(
  'auto-push to a listed remote runs the pre-push check first',
  { options: { autoPush: 'me/notes', prePushCommand: 'check-secrets {root} --list {files}' } },
  async ($, on) => {
    const { w, touch, callsOf } = fakeWorld(on)
    w.hasUpstream = true
    await $.session.start(start())
    touch('a.ts')
    await $.tool.call(write('a.ts'))
    await $.turn.complete(turnEnd())

    expect(w.checks).toEqual([['check-secrets', ROOT, '--list', `${GIT_DIR}/AUTOCOMMIT_PUSH_LIST`]])
    expect(w.files.get(`${GIT_DIR}/AUTOCOMMIT_PUSH_LIST`)).toBe('a.ts\n')
    expect(callsOf('push').map(c => c.args)).toEqual([['push', '--quiet', 'origin', 'HEAD:refs/heads/main']])
    expect(w.toasts).toContain('↑ repo: 1 commit pushed')

    // A failing check blocks the push; the commit waits, counted in the band.
    w.checkExit = 1
    touch('b.ts')
    await $.tool.call(write('b.ts'))
    await $.turn.complete(turnEnd())
    expect(callsOf('push')).toHaveLength(1)
    expect(await bandText($)).toContain('1 to push')
    expect(await report($)).toContain('push blocked: the pre-push check failed')
  },
)

test('no auto-push to an unlisted remote; /commits push asks for it', async ($, on) => {
  const { w, touch, callsOf, clock } = fakeWorld(on)
  w.hasUpstream = true
  await $.session.start(start())
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  expect(callsOf('push')).toEqual([])

  expect(await report($, 'push')).toContain('Pushing the session')
  await clock.advance(100)
  expect(callsOf('push')).toHaveLength(1)
})

test('a push carrying a secret in an earlier commit is blocked', { options: { autoPush: '*' } }, async ($, on) => {
  const { w, touch, callsOf } = fakeWorld(on)
  w.hasUpstream = true
  // A commit the person made by hand, with a key in it, not pushed yet.
  w.commits.set('9'.repeat(40), { parent: BASE, files: ['old.ts'], patch: patchOf('old.ts', [`k = "${KEY}"`]), subject: 'wip' })
  w.head = '9'.repeat(40)
  await $.session.start(start())
  touch('a.ts')
  await $.tool.call(write('a.ts'))
  await $.turn.complete(turnEnd())
  expect(callsOf('push')).toEqual([])
  expect(await report($)).toContain('push blocked: possible secret (GitHub token) in old.ts')
})
