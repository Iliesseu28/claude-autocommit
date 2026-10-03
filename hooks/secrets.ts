// Secret scan of what an auto-commit or a push would add. A finding names the
// file and the kind of key, never the value.

import { splitDiff } from './git'

export type SecretFinding = { file: string; pattern: string }

// Files never committed, whatever they hold.
const FORBIDDEN_FILES: ReadonlyArray<readonly [string, RegExp]> = [
  ['.env file', /(^|\/)\.env(\..+)?$/i],
  ['Apple .p8 key', /\.p8$/i],
  ['.pem key', /\.pem$/i],
  ['.p12 / .pfx certificate', /\.(p12|pfx)$/i],
  ['keystore', /\.(jks|keystore)$/i],
  ['SSH private key', /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i],
  ['Google service account', /(^|\/)[^/]*service[-_]?account[^/]*\.json$/i],
  ['.netrc', /(^|\/)[._]netrc$/i],
  ['Claude Code local settings', /(^|\/)\.claude\/settings\.local\.json$/i],
]

const CONTENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}/],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Stripe live key', /\b(sk|rk)_live_[A-Za-z0-9]{8,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{20,}\b/],
  ['secret key (sk_)', /\bsk_[A-Za-z0-9]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['Supabase access token', /\bsbp_[A-Za-z0-9]{20,}\b/],
  ['PostHog personal key', /\bphx_[A-Za-z0-9]{20,}\b/],
  ['Notion token', /\bntn_[A-Za-z0-9]{20,}\b/],
  ['Resend API key', /\bre_[A-Za-z0-9_]{20,}\b/],
  ['Sentry token', /\bsntry[su]_[A-Za-z0-9_.=-]{20,}/],
  ['xAI API key', /\bxai-[A-Za-z0-9]{40,}/],
  ['Telegram bot token', /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{30,}/],
]

const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
// Documentation values: a known prefix followed only by filler.
const PLACEHOLDER = /^(sk-ant-|sk-proj-|sk-|sk_live_|rk_live_|sk_|gh[pousr]_|github_pat_|glpat-|AIza|GOCSPX-|whsec_|xox[abprs]-|npm_|hf_|sbp_|phx_|ntn_|re_|sntry[su]_|xai-|AKIA|ASIA)[xX0*.…_-]+$/
const TEMPLATE_FILE = /\.(template|example|sample|dist)$/i

export const forbiddenFile = (path: string): string | null => {
  if (TEMPLATE_FILE.test(path)) return null
  for (const [name, re] of FORBIDDEN_FILES) if (re.test(path)) return name
  return null
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// base64url to text, enough to read a JWT payload; null when malformed.
const decodeBase64Url = (s: string): string | null => {
  let bits = 0
  let value = 0
  let out = ''
  for (const ch of s.replace(/=+$/, '')) {
    const n = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch)
    if (n === -1) return null
    value = ((value << 6) | n) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((value >> bits) & 0xff)
    }
  }
  return out
}

// A Supabase anon JWT is a public key: only a long JWT of another role counts.
const isSecretJwt = (token: string): boolean => {
  if (token.length < 60) return false
  const payload = token.split('.')[1]
  const json = payload === undefined ? null : decodeBase64Url(payload)
  if (json === null) return true
  try {
    const role = (JSON.parse(json) as { role?: unknown }).role
    return role !== 'anon'
  } catch {
    return true
  }
}

// Inside a {{VAR}} placeholder the match is a template, not a key.
const insidePlaceholder = (line: string, index: number): boolean => {
  const open = line.lastIndexOf('{{', index)
  return open !== -1 && line.indexOf('}}', open) >= index
}

export const scanLine = (line: string): string | null => {
  if (line.includes('secret-scan:ignore')) return null
  // Every match counts: a placeholder first on the line must not hide a real key after it.
  for (const [name, re] of CONTENT_PATTERNS) {
    for (const m of line.matchAll(new RegExp(re.source, 'g'))) {
      if (!PLACEHOLDER.test(m[0]) && !insidePlaceholder(line, m.index ?? 0)) return name
    }
  }
  for (const m of line.matchAll(JWT)) {
    if (isSecretJwt(m[0]) && !insidePlaceholder(line, m.index ?? 0)) return 'JWT (not an anon key)'
  }
  return null
}

// Added lines of a `git diff` only (after its first hunk header): what the
// commit would introduce. One finding per file is enough to hold it back.
export const scanDiff = (diff: string): SecretFinding[] =>
  splitDiff(diff).flatMap(({ file, text }) => {
    let isInHunk = false
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (line.startsWith('@@')) isInHunk = true
      if (!isInHunk || !line.startsWith('+')) continue
      const pattern = scanLine(line.slice(1))
      if (pattern !== null) return [{ file, pattern }]
    }
    return []
  })
