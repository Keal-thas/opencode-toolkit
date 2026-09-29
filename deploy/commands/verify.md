---
description: Independent review of the current changes in a fresh subagent session (usage: /verify <what the change should do>)
agent: verifier
subtask: true
---

Verify that the working tree does what this claim says. Claim: $ARGUMENTS

If the claim is empty, infer the intent from the diff and commit messages below and say what you inferred.

Working tree status:
!`git status --short`

Uncommitted changes:
!`git diff HEAD`

Recent commits on this branch:
!`git log --oneline -10`
