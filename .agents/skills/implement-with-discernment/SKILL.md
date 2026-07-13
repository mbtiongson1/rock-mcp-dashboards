---
name: implement-with-discernment
description: Use when an implementation plan is ready and execution could be direct, delegated to workers, or split between both approaches.
---

# Implement with Discernment

## Overview

Choose the simplest execution mode that preserves quality. Delegation is useful for independent work or context isolation, but coordination and review have real cost.

Announce the selected mode and the reason before implementation.

## Choose a mode

| Signal | Direct | Delegated | Hybrid |
|---|---|---|---|
| Plan size | 1–3 small tasks | Several substantial tasks | Mixed sizes |
| Dependency | Tight sequence | Mostly independent | Some shared foundations |
| File overlap | High | Disjoint | Split after shared edits |
| Context | Fits comfortably | Each task needs focused context | Only some tasks need isolation |
| Review need | One integrated pass | Per-task review is valuable | Targeted per-task review |

Use **direct** when work is small, tightly coupled, or likely to require repeated cross-file decisions.

Use **delegated** when multiple tasks are independently executable, their file ownership is clear, and the environment exposes worker or subagent tools.

Use **hybrid** when direct foundation work will unblock independent tasks, or only part of the plan benefits from a separate context.

Do not select a mode by model nickname, pricing claim, or assumed capability tier. Use the actual tools and models available in the current environment.

## Direct execution

1. Confirm the branch or isolated worktree and repository instructions.
2. Execute plan tasks in dependency order.
3. Verify each meaningful checkpoint before continuing.
4. Run the complete required validation and inspect the final diff.

## Delegated execution

1. Build a task table with dependencies, owned files, validation, and integration order.
2. Dispatch only ready tasks. Never give two concurrent writers the same worktree or overlapping files.
3. Give each worker the smallest sufficient context and an observable completion contract.
4. Review each result for scope and behavior, then run its validation independently.
5. Integrate reviewed work in dependency order and rerun the full suite.

Prefer the current environment's native worker/subagent tools when they exist. If they do not, use a separately invoked worker such as `codex exec` only when its CLI is installed and authenticated. For Codex CLI delegation, use the `codex-delegate` skill when available. If that companion skill or another verified safe delegation workflow is unavailable, say so briefly and use direct mode; do not reconstruct security-sensitive CLI flags from memory or block execution.

Review does not require named private agent roles. Use an available fresh worker for an independent review when feasible; otherwise perform a separate review pass yourself after clearing the implementation checklist.

## Hybrid execution

1. Mark shared, coupled, or prerequisite tasks as direct.
2. Mark independent, disjoint tasks as delegated.
3. Complete and verify prerequisites first.
4. Dispatch the widest safe wave supported by available worker capacity.
5. Review, integrate, and run full validation after every wave.

## Worker brief

Every delegated task should state:

- one outcome and its acceptance criteria;
- exact workspace/worktree and branch;
- repository instructions to read;
- owned and protected files;
- allowed local and external side effects;
- exact validation commands; and
- the required final report shape.

If a worker needs broader authority or a materially different design, it must report the blocker rather than expand scope.

## Completion gate

Before reporting completion:

1. Inspect all worker diffs and commits; do not rely on worker claims.
2. Confirm every plan item and acceptance criterion against the integrated tree.
3. Run fresh tests, lint, typecheck, build, or artifact validation appropriate to the change.
4. Report exact commands, results, skipped checks, and remaining concerns.
5. Push, open a PR, merge, deploy, or message externally only when the user authorized that action.

## Red flags

- Delegating a tiny coupled change with more coordination than implementation.
- Keeping many independent tasks in one long context until quality degrades.
- Concurrent writers sharing a worktree, lockfile, generated output, or config.
- Depending on worker tools, roles, or model tiers that are not available.
- Accepting a worker's success report without inspecting and verifying its work.
- Expanding sandbox, credential, network, or remote-write authority for convenience.
