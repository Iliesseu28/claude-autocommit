# Changelog

## 1.1.0 (2026-10-05)

- Subagents: an agent that finishes while Claude is still working waits for the end of Claude's turn (an interrupted
  turn included), then gets a commit of its own (one per agent). Claude counts as working only inside its own turns. Files Claude committed by hand meanwhile are left alone, with no alert. Headless
  `claude -p` runs keep committing a subagent when it finishes.
- Commit messages follow the style of the repo's last 8 hand-written subjects (type words, scope, capitalization),
  in the configured language. Conventional Commits remains the default when there are none.
- Stale index warning: when git's own index holds 10 or more staged entries that differ from the disk (often an old
  index brought back by a folder sync), one alert per repo and session says how to see and clear them. Staged files the
  mod is about to commit itself are not counted. The index is never changed.
- Nothing left in `.git`: the message goes to git on stdin, and the private index, the push list and the reset journal
  are deleted instead of emptied.

## 1.0.0 (2026-10-03)

First public release.

- One commit per repo when Claude's turn ends, built in a private git index, with a Conventional Commits
  message written by Haiku from the diff (configurable model and language).
- Tracks Claude's own changes only: file edits by path, shell commands by comparing `git status` and content
  hashes before and after. Read-only commands skip the comparison.
- Subagents: each agent's files are committed when its own turn ends.
- Safe beside your own git work: a git command Claude runs never overlaps an auto-commit, each session keeps its own
  index file, and an auto-commit whose `HEAD` moved meanwhile is rolled back and retried, never someone else's commit.
- Secret guard on every commit and push: over 20 key formats, forbidden file names, new files over 5 MB.
- Optional bug alerts from the same model call.
- `/commits` report, `pause`, `resume`, `now`, `undo`, `squash`, `push` (English and French words).
- Opt-in auto-push per remote, with an optional pre-push command.
- A bar above the prompt: model, effort, context gauge, Remote Control, commit counters, alerts.
- Interface in English or French.
