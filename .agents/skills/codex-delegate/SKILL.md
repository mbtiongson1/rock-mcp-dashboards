---
name: codex-delegate
description: Use when delegating implementation, testing, refactoring, or review work to the Codex CLI through a non-interactive `codex exec` run.
---

# Delegate to the Codex CLI

## Overview

Give a Codex worker one bounded task in an isolated worktree, with a writable sandbox and no interactive approvals. Treat its result as an untrusted draft: inspect the diff and verify it yourself before any remote action.

## Prepare the worker

1. Create or reuse a dedicated git worktree on a task branch. A worktree prevents git contention; it is not a security boundary.
2. Keep secrets out of the worktree. Do not copy or symlink `.env`, credentials, SSH agents, cloud config, production data, or host sockets into it.
   `workspace-write` limits writes; do not assume it makes every host-readable secret unreadable. If sensitive files remain accessible to the Codex process and the task is not trusted, use a disposable external isolation boundary or do not delegate.
3. Write a prompt file outside the worker's writable root when practical. Include the exact worktree, branch, owned files, protected paths, allowed side effects, and validation commands.
4. Check the installed CLI before relying on flags:

   ```bash
   codex --version
   codex exec --help
   ```

5. Use the account's configured model by default. Add `--model <verified-model-id>` only when the user selected a model that the current installation/account exposes. Do not invent model IDs or choose from stale benchmark or pricing tables.

## Safe non-interactive invocation

Use `workspace-write` with approvals disabled. Ignore user config so a personal full-access default cannot silently widen the worker's authority; strict config makes unknown overrides fail closed.

```bash
codex exec \
  --ignore-user-config \
  --strict-config \
  --sandbox workspace-write \
  -c 'approval_policy="never"' \
  -c 'shell_environment_policy.inherit="core"' \
  -C "$WORKTREE" \
  - < "$PROMPT_FILE"
```

`approval_policy="never"` makes the run non-interactive; it does not grant access outside the sandbox. A command needing more authority should fail and be reported. Do not weaken the sandbox merely to make a failing command pass.

If the task needs a package registry or another network destination, enable only the documented, scoped network access available in the installed Codex version or prepare dependencies before dispatch. Do not grant unrestricted host access as a networking workaround.

## Prompt contract

Use this shape:

```markdown
# Task
<one bounded outcome>

You are working only in <absolute worktree> on branch <branch>.
Read <AGENTS.md or other repository instructions> before editing.

## Requirements
1. <observable behavior>
2. <tests or acceptance criteria>

## Boundaries
- In scope: <files and behaviors>
- Do not modify: <credentials, generated files, unrelated paths>
- Allowed side effects: edits inside the worktree only
- Do not push, open or merge a PR, deploy, send messages, alter remote state,
  or access credentials.
- Do not commit unless this prompt explicitly requests a local commit.

## Verification
Run: <exact commands>
Finish with changed files, verification results, and any blockers.
Make reasonable implementation decisions within this brief. If completion
requires broader authority or a materially different design, stop and report
the blocker instead of expanding scope.
```

Do not tell a worker to “never ask questions” without a boundary. That wording can encourage guessing through decisions that need user authority.

## Review and integrate

After the process exits:

1. Read its final message; exit code zero alone does not prove the requested outcome.
2. Inspect `git status`, the complete diff, and any commits.
3. Check for unexpected files, secret material, scope expansion, destructive commands, and skipped tests.
4. Run the required validation independently in the worktree.
5. Only the caller may authorize pushing, opening a PR, deploying, or other external side effects.

For follow-up work, prefer the explicit session ID:

```bash
cd "$WORKTREE"
codex exec resume "$SESSION_ID" \
  --ignore-user-config \
  --strict-config \
  -c 'approval_policy="never"' \
  -c 'sandbox_mode="workspace-write"' \
  -c 'shell_environment_policy.inherit="core"' \
  - < "$FOLLOWUP_PROMPT"
```

Run resume from the original worktree. Avoid `--last` when multiple sessions may exist.

## Parallel workers

Never run two writers in the same worktree. Parallelize only tasks that have:

- separate worktrees and branches;
- no unmet data dependency;
- disjoint owned files, including shared config and lockfiles; and
- an integration order plus a final full validation pass.

Otherwise, serialize the workers.

## Full-access exception

`--dangerously-bypass-approvals-and-sandbox` (also known as `--yolo` in some CLI versions) is not a worktree convenience. Use it only when the Codex process itself runs inside an explicit, disposable container or VM boundary that has:

- no host filesystem mounts beyond disposable task data;
- no host credentials, agents, sockets, or production secrets;
- no production network path; and
- an independent resource and teardown boundary.

A normal laptop checkout, git worktree, shell prompt, Docker bind mount of the host repo, or prompt-only guardrail does not satisfy this exception. If the external isolation cannot be demonstrated, keep `workspace-write`.

## Common mistakes

| Mistake | Correction |
|---|---|
| Symlinking the main checkout's `.env` | Use fixtures or explicitly scoped non-production values only when required. |
| Treating a worktree as a sandbox | Use it for git isolation; keep the Codex sandbox enabled and secrets outside the process's readable environment. |
| Hard-coding a model slug | Use configured availability or a user-selected, verified ID. |
| Trusting exit code or the final message | Inspect the diff and rerun verification. |
| Giving network or full-host access for convenience | Narrow the task or provision an external isolation boundary. |
