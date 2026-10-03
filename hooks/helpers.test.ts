import { expect, test } from 'claude-code/testing'

import { readConfig } from './config'
import {
  changedPaths,
  commandDirs,
  commitMessage,
  commitSystem,
  fallbackSubject,
  isReadOnlyCommand,
  matchStatus,
  matchesRemote,
  normPath,
  parseCommitReply,
  parsePorcelain,
  prettyModel,
  splitArgs,
  splitDiff,
  trailers,
  trimDiff,
  zipHashes,
} from './git'
import { actionOf, strings } from './i18n'
import { forbiddenFile, scanDiff, scanLine } from './secrets'

// Fake keys are built from pieces so this file never holds one whole.
const fake = (...parts: string[]): string => parts.join('')

test('paths and porcelain', () => {
  expect(normPath('C:\\work\\me\\repo\\')).toBe('C:/work/me/repo')
  const z = ' M src/a.ts\0?? new file.txt\0R  b.ts\0old b.ts\0'
  const status = parsePorcelain(z)
  expect(status.get('src/a.ts')).toBe(' M')
  expect(status.get('new file.txt')).toBe('??')
  expect(status.get('b.ts')).toBe('R ')
  expect(status.get('old b.ts')).toBe('D ')
})

test('changedPaths counts new paths and moved content, not index-only moves', () => {
  const before = new Map([['a', ' M'], ['b', ' M']])
  const after = new Map([['a', 'M '], ['b', ' M'], ['c', '??']])
  expect(changedPaths(before, after)).toEqual(['c'])
  const h0 = new Map([['a', '1'], ['b', '2']])
  const h1 = new Map([['a', '1'], ['b', '3'], ['c', '4']])
  expect(changedPaths(before, after, h0, h1)).toEqual(['b', 'c'])
  expect(zipHashes(['a', 'b'], 'x\ny\n')?.get('b')).toBe('y')
  expect(zipHashes(['a', 'b'], 'x\n')).toBeNull()
})

test('matchStatus finds a tracked path whatever its case on a case-insensitive disk', () => {
  const status = new Map([['README.md', ' M'], ['src/App.ts', '??']])
  const folded = matchStatus(['readme.md', 'src/App.ts', 'gone.ts'], status, true)
  expect([...folded.found.entries()]).toEqual([['README.md', ['readme.md']], ['src/App.ts', ['src/App.ts']]])
  expect(folded.missing).toEqual(['gone.ts'])
  expect(matchStatus(['readme.md'], status, false).missing).toEqual(['readme.md'])
})

test('read-only commands skip the before/after snapshot, anything doubtful does not', () => {
  for (const cmd of [
    'ls -la',
    'git status && git log --oneline -5',
    'cat a.txt | grep foo | wc -l',
    'git -C ../other diff HEAD~1',
    'find . -name "*.ts"',
    'sed -n 1,20p file.ts',
    'Get-ChildItem -Recurse | Select-String foo',
  ]) {
    expect([cmd, isReadOnlyCommand(cmd)]).toEqual([cmd, true])
  }
  for (const cmd of [
    'npm test',
    'echo hi > a.txt',
    'sed -i s/a/b/ f',
    'git commit -m x',
    'git branch -D old',
    'git config user.name x',
    'find . -name "*.tmp" -delete',
    'cat $(ls)',
    'bash -c "touch x"',
    'ls | xargs rm',
  ]) {
    expect([cmd, isReadOnlyCommand(cmd)]).toEqual([cmd, false])
  }
})

test('commandDirs and splitArgs', () => {
  expect(commandDirs('cd "my app" && git -C ../lib status; Set-Location C:\\x')).toEqual(['my app', '../lib', 'C:\\x'])
  expect(commandDirs('cd $HOME && cd -')).toEqual([])
  expect(splitArgs('python "C:/My Scripts/check.py" {root} --list={files}')).toEqual([
    'python',
    'C:/My Scripts/check.py',
    '{root}',
    '--list={files}',
  ])
})

test('matchesRemote matches whole path segments only', () => {
  const ssh = 'git@github.com:me/notes.git'
  const https = 'https://github.com/me/notes'
  expect(matchesRemote(ssh, ['me/notes'])).toBe(true)
  expect(matchesRemote(https, ['github.com/me/notes'])).toBe(true)
  expect(matchesRemote(https, ['github.com/me'])).toBe(true)
  expect(matchesRemote(ssh, ['github.com/me'])).toBe(true)
  expect(matchesRemote(https, ['notes'])).toBe(true)
  expect(matchesRemote('https://github.com/me/notes-old', ['me/notes'])).toBe(false)
  expect(matchesRemote('https://github.com/me/mynotes', ['notes'])).toBe(false)
  expect(matchesRemote(https, [])).toBe(false)
  expect(matchesRemote(https, ['*'])).toBe(true)
})

test('commit reply parsing, fallback and message layout', () => {
  const files = ['src/a.ts', 'src/b.ts']
  const good = parseCommitReply(
    'Sure: {"subject":"feat(api): add reset \u2014 endpoint","body":"Users were locked out.","warnings":["console.log left","",3]}',
    files,
  )
  expect(good.subject).toBe('feat(api): add reset, endpoint')
  expect(good.warnings).toEqual(['console.log left'])
  expect(parseCommitReply('not json', files).subject).toBe('chore: update a.ts and 1 more')
  expect(fallbackSubject(['docs/x.md'])).toBe('chore: update x.md')
  expect(parseCommitReply(`{"subject":"${'x'.repeat(100)}"}`, files).subject).toHaveLength(72)

  const msg = commitMessage(good, trailers(null, 'Opus 5.5'))
  expect(msg).toBe(
    'feat(api): add reset, endpoint\n\nUsers were locked out.\n\nAuto-commit: claude-autocommit\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  )
  // The person's own attribution wins; an empty one means none.
  expect(trailers('Co-Authored-By: Bot <b@x>', 'Opus 5.5')).toEqual(['Auto-commit: claude-autocommit', 'Co-Authored-By: Bot <b@x>'])
  expect(trailers('', 'Opus 5.5')).toEqual(['Auto-commit: claude-autocommit'])
})

test('prompts carry the configured languages', () => {
  const sys = commitSystem({ commitLanguage: 'German', warningLanguage: 'simple French', isBugCheck: true })
  expect(sys).toContain('in German')
  expect(sys).toContain('in simple French')
  expect(commitSystem({ commitLanguage: 'English', warningLanguage: 'English', isBugCheck: false })).toContain(
    'always an empty array',
  )
  const big = `diff --git a/x b/x\n${'+line\n'.repeat(2000)}`
  expect(trimDiff(big).length < 3_100).toBe(true)
})

test('prettyModel', () => {
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4')
  expect(prettyModel('my-model')).toBe('my-model')
})

test('secret scan: real-looking keys caught, placeholders and anon keys let through', () => {
  const caught: Array<[string, string]> = [
    ['GitHub token', `token = "${fake('ghp_', 'Ab1'.repeat(12))}"`],
    ['AWS access key', `AWS_ACCESS_KEY_ID=${fake('AKIA', 'ABCDEFGHIJ', 'KLMNOP')}`],
    ['Anthropic API key', `key: ${fake('sk-ant-', 'api03-', 'x1Y2'.repeat(8))}`],
    ['Stripe live key', `${fake('sk_live_', 'a1B2c3D4e5')}`],
    ['Slack token', `${fake('xoxb-', '1234567890-abcdef')}`],
    ['private key block', fake('-----BEGIN RSA ', 'PRIVATE KEY-----')],
    ['Google API key', fake('AIza', 'Sy', 'A1b2C3d4'.repeat(4))],
  ]
  for (const [kind, line] of caught) expect([kind, scanLine(line)]).toEqual([kind, kind])

  expect(scanLine(`token = "${fake('ghp_', 'x'.repeat(36))}"`)).toBeNull()
  expect(scanLine(`key = "{{${fake('sk_live_', 'a1B2c3D4e5')}}}"`)).toBeNull()
  expect(scanLine(`${fake('ghp_', 'Ab1'.repeat(12))} // secret-scan:ignore`)).toBeNull()
  // A placeholder first on the line does not hide a real key after it.
  expect(scanLine(`${fake('ghp_', 'x'.repeat(36))} ${fake('ghp_', 'Ab1'.repeat(12))}`)).toBe('GitHub token')

  const jwt = (payload: object): string =>
    ['eyJhbGciOiJIUzI1NiJ9', btoa(JSON.stringify(payload)).replace(/=+$/, ''), 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.')
  expect(scanLine(`anon = "${jwt({ role: 'anon', iss: 'supabase', ref: 'abcdefghijkl' })}"`)).toBeNull()
  expect(scanLine(`svc = "${jwt({ role: 'service_role', iss: 'supabase', ref: 'abcdefghijkl' })}"`)).toBe(
    'JWT (not an anon key)',
  )
})

test('secret scan reads added lines only, file by file', () => {
  const key = fake('ghp_', 'Ab1'.repeat(12))
  const diff = [
    'diff --git a/my file.ts b/my file.ts',
    '@@ -1 +1 @@',
    `-const t = "${key}"`,
    '+const t = process.env.TOKEN',
    'diff --git a/b.ts b/b.ts',
    '@@ -0,0 +1 @@',
    `+const t = "${key}"`,
    '',
  ].join('\n')
  expect(splitDiff(diff).map(p => p.file)).toEqual(['my file.ts', 'b.ts'])
  expect(scanDiff(diff)).toEqual([{ file: 'b.ts', pattern: 'GitHub token' }])
})

test('forbidden files', () => {
  expect(forbiddenFile('.env')).toBe('.env file')
  expect(forbiddenFile('app/.env.production')).toBe('.env file')
  expect(forbiddenFile('.env.example')).toBeNull()
  expect(forbiddenFile('keys/AuthKey_ABC.p8')).toBe('Apple .p8 key')
  expect(forbiddenFile('home/.ssh/id_ed25519')).toBe('SSH private key')
  expect(forbiddenFile('firebase-service-account.json')).toBe('Google service account')
  expect(forbiddenFile('.claude/settings.json')).toBeNull()
  expect(forbiddenFile('.claude/settings.local.json')).toBe('Claude Code local settings')
})

test('config defaults and parsing', () => {
  const d = readConfig({})
  expect(d).toEqual({
    language: 'en',
    commitModel: 'haiku',
    commitLanguage: 'English',
    isBugCheck: true,
    autoPush: [],
    prePushCommand: '',
    bar: 'full',
    maxFilesPerCommand: 40,
  })
  const c = readConfig({ language: 'fr', autoPush: 'me/notes, me/dots  *', bar: 'nope', maxFilesPerCommand: 0, bugCheck: false })
  expect(c.language).toBe('fr')
  expect(c.autoPush).toEqual(['me/notes', 'me/dots', '*'])
  expect(c.bar).toBe('full')
  expect(c.maxFilesPerCommand).toBe(40)
  expect(c.isBugCheck).toBe(false)
})

test('strings: French has every key, no long dash anywhere, subcommands in both languages', () => {
  const en = strings('en')
  const fr = strings('fr')
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort())
  const all = (x: Record<string, unknown>): string =>
    Object.values(x)
      .map(v => (typeof v === 'function' ? String((v as (...a: unknown[]) => unknown)('a', 2, 'b', 3)) : String(v)))
      .join('\n')
  for (const text of [all(en), all(fr)]) expect(/[\u2014\u2013\u2015]/.test(text)).toBe(false)
  expect(actionOf('')).toBe('report')
  expect(actionOf(' Reprendre ')).toBe('resume')
  expect(actionOf('tout')).toBe('now')
  expect(actionOf('annuler')).toBe('undo')
  expect(actionOf('squash')).toBe('squash')
  expect(actionOf('pousser')).toBe('push')
  expect(actionOf('what')).toBeNull()
})
