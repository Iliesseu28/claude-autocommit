import type { Language } from './config'

const s = (n: number): string => (n === 1 ? '' : 's')
// French keeps the singular for 0 and 1.
const frS = (n: number): string => (n > 1 ? 's' : '')

const en = {
  // Band above the prompt
  effort: 'effort',
  context: 'context',
  waiting: 'waiting',
  rc: 'RC',
  rcOn: 'on',
  rcOff: 'off',
  rcUnknown: '?',
  devices: (n: number) => ` (${n} device${s(n)})`,
  commits: 'commits',
  made: (n: number) => `${n} auto`,
  toPush: (n: number) => `${n} to push`,
  pending: (n: number) => `${n} pending`,
  paused: 'paused',
  percent: (p: number) => `${p}%`,

  // Toasts and alerts
  committed: (repo: string, sha: string, subject: string) => `✓ ${repo} ${sha}  ${subject}`,
  alert: (repo: string, text: string) => `⚠ ${repo}: ${text}`,
  pushed: (repo: string, n: number) => `↑ ${repo}: ${n} commit${s(n)} pushed`,
  heldBack: (file: string, why: string) => `${file}: ${why}, never committed`,
  tooBig: (file: string, mb: number) => `${file}: new file of ${mb} MB, too big to auto-commit`,
  prepareFailed: (err: string) => `could not prepare the commit (${err}), retrying next turn`,
  scanFailed: 'secret scan failed, nothing committed',
  secret: (file: string, kind: string) => `${file}: possible secret (${kind}), not committed`,
  dropFailed: 'could not drop the suspect file, nothing committed',
  commitRefused: (err: string) => `commit refused (${err})`,
  indexStale: (paths: string) => `index not refreshed, run: git reset -q -- ${paths}`,
  bug: (sha: string, text: string) => `possible bug (${sha}): ${text}`,
  tooManyFiles: (n: number) => `a command changed ${n} files at once, not auto-committed`,
  failed: (err: string) => `auto-commit error (${err})`,
  noUpstream: 'no upstream branch, nothing pushed',
  unreadable: 'commits to push are unreadable, nothing pushed',
  pushSecret: (kind: string, file: string) => `push blocked: possible secret (${kind}) in ${file}`,
  prePushFailed: 'push blocked: the pre-push check failed',
  pushRefused: (err: string) => `push refused (${err})`,
  timedOut: 'timed out',
  warningLanguage: 'English',

  // /commits
  report: (paused: boolean, made: number, toPush: number, pending: number) =>
    `Auto-commits: ${paused ? 'PAUSED' : 'on'}. ${made} commit${s(made)} this session, ${toPush} to push, ${pending} file${s(pending)} pending.`,
  latest: 'Latest commits:',
  alerts: 'Alerts:',
  waitingFor: 'Pending (committed when their agent\'s turn ends):',
  session: 'session',
  agent: (id: string) => `agent ${id}`,
  more: (n: number) => ` and ${n} more`,
  files: (n: number) => `${n} file${s(n)}`,
  ago: (min: number) => (min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`),
  autoPushTo: (patterns: string) => `Auto-push to: ${patterns}`,
  help: '/commits pause | resume | now | undo | squash | push',
  isPaused: 'Auto-commits paused (files are still tracked).',
  resumed: 'Auto-commits resumed.',
  now: (n: number) => `Committing ${n} pending file${s(n)} now.`,
  pushStarted: 'Pushing the session\'s repos: secret scan of the outgoing commits, the pre-push check if set, then git push. Results come as notifications and in /commits.',

  // /commits undo
  undoNothing: 'No auto-commit to undo in this session.',
  undoMoved: (repo: string) => `${repo}: HEAD is no longer the last auto-commit, nothing undone.`,
  undoPushed: (repo: string) => `${repo}: the last auto-commit is already pushed, nothing undone (use git revert).`,
  undoRoot: (repo: string) => `${repo}: the last auto-commit is the first commit of the repo, nothing undone.`,
  undoBusy: (repo: string) => `${repo}: a merge, rebase or detached HEAD is in progress, nothing undone.`,
  undoFailed: (repo: string, err: string) => `${repo}: undo failed (${err}).`,
  undone: (repo: string, sha: string, subject: string, n: number) =>
    `Undone ${repo} ${sha} "${subject}". Its ${n} file${s(n)} stay changed in the working tree, uncommitted.`,

  // /commits squash
  squashNothing: 'Nothing to squash: no repo has two or more unpushed auto-commits in a row at HEAD.',
  squashed: (repo: string, n: number, sha: string, subject: string) =>
    `${repo}: ${n} auto-commits squashed into ${sha} "${subject}".`,
  squashFailed: (repo: string, err: string) => `${repo}: squash failed (${err}).`,
  squashedHeader: 'Squashed commits:',
}

export type Strings = typeof en

const fr: Strings = {
  effort: 'effort',
  context: 'contexte',
  waiting: 'en attente',
  rc: 'RC',
  rcOn: 'actif',
  rcOff: 'coupé',
  rcUnknown: 'inconnu',
  devices: n => ` (${n} appareil${frS(n)})`,
  commits: 'commits',
  made: n => `${n} auto`,
  toPush: n => `${n} à pousser`,
  pending: n => `${n} en attente`,
  paused: 'en pause',
  percent: p => `${p} %`,

  committed: (repo, sha, subject) => `✓ ${repo} ${sha}  ${subject}`,
  alert: (repo, text) => `⚠ ${repo} : ${text}`,
  pushed: (repo, n) => `↑ ${repo} : ${n} commit${frS(n)} poussé${frS(n)}`,
  heldBack: (file, why) => `${file} : ${why}, jamais commité`,
  tooBig: (file, mb) => `${file} : nouveau fichier de ${mb} Mo, trop gros pour un commit auto`,
  prepareFailed: err => `préparation du commit impossible (${err}), nouvel essai au prochain tour`,
  scanFailed: 'scan des secrets impossible, rien commité',
  secret: (file, kind) => `${file} : secret possible (${kind}), pas commité`,
  dropFailed: 'retrait du fichier suspect impossible, rien commité',
  commitRefused: err => `commit refusé (${err})`,
  indexStale: paths => `index pas mis à jour, lancer : git reset -q -- ${paths}`,
  bug: (sha, text) => `bug possible (${sha}) : ${text}`,
  tooManyFiles: n => `une commande a changé ${n} fichiers d'un coup, pas de commit auto pour eux`,
  failed: err => `erreur du commit auto (${err})`,
  noUpstream: 'pas de branche distante suivie, rien poussé',
  unreadable: 'commits à pousser illisibles, rien poussé',
  pushSecret: (kind, file) => `push bloqué : secret possible (${kind}) dans ${file}`,
  prePushFailed: 'push bloqué : la vérification avant push a échoué',
  pushRefused: err => `push refusé (${err})`,
  timedOut: 'délai dépassé',
  warningLanguage: 'simple French',

  report: (paused, made, toPush, pending) =>
    `Commits auto : ${paused ? 'EN PAUSE' : 'actifs'}. ${made} commit${frS(made)} dans la session, ${toPush} à pousser, ${pending} fichier${frS(pending)} en attente.`,
  latest: 'Derniers commits :',
  alerts: 'Alertes :',
  waitingFor: 'En attente (commités à la fin du tour de leur agent) :',
  session: 'session',
  agent: id => `agent ${id}`,
  more: n => ` et ${n} autre${frS(n)}`,
  files: n => `${n} fichier${frS(n)}`,
  ago: min => (min < 1 ? "à l'instant" : min < 60 ? `il y a ${min} min` : `il y a ${Math.round(min / 60)} h`),
  autoPushTo: patterns => `Push automatique vers : ${patterns}`,
  help: '/commits pause | reprendre | tout | annuler | fusionner | pousser',
  isPaused: 'Commits auto en pause (le suivi des fichiers continue).',
  resumed: 'Commits auto repris.',
  now: n => `${n} fichier${frS(n)} en attente commité${frS(n)} tout de suite.`,
  pushStarted: 'Push lancé : scan des commits sortants, vérification avant push si réglée, puis git push. Résultat en notification et dans /commits.',

  undoNothing: 'Aucun commit auto à annuler dans cette session.',
  undoMoved: repo => `${repo} : HEAD n'est plus le dernier commit auto, rien annulé.`,
  undoPushed: repo => `${repo} : le dernier commit auto est déjà poussé, rien annulé (utiliser git revert).`,
  undoRoot: repo => `${repo} : le dernier commit auto est le premier du dépôt, rien annulé.`,
  undoBusy: repo => `${repo} : merge, rebase ou HEAD détachée en cours, rien annulé.`,
  undoFailed: (repo, err) => `${repo} : annulation impossible (${err}).`,
  undone: (repo, sha, subject, n) =>
    `Annulé : ${repo} ${sha} « ${subject} ». Ses ${n} fichier${frS(n)} restent modifié${frS(n)} dans le dossier, non commité${frS(n)}.`,

  squashNothing: 'Rien à fusionner : aucun dépôt n\'a au moins deux commits auto non poussés à la suite en tête.',
  squashed: (repo, n, sha, subject) => `${repo} : ${n} commits auto fusionnés en ${sha} « ${subject} ».`,
  squashFailed: (repo, err) => `${repo} : fusion impossible (${err}).`,
  squashedHeader: 'Commits fusionnés :',
}

export const strings = (language: Language): Strings => (language === 'fr' ? fr : en)

// Subcommands of /commits, French words included, to one action.
export type Action = 'report' | 'pause' | 'resume' | 'now' | 'undo' | 'squash' | 'push'

const ACTIONS: Record<string, Action> = {
  '': 'report',
  status: 'report',
  pause: 'pause',
  resume: 'resume',
  reprendre: 'resume',
  now: 'now',
  tout: 'now',
  undo: 'undo',
  annuler: 'undo',
  squash: 'squash',
  fusionner: 'squash',
  push: 'push',
  pousser: 'push',
}

export const actionOf = (args: string): Action | null => ACTIONS[args.trim().toLowerCase()] ?? null
