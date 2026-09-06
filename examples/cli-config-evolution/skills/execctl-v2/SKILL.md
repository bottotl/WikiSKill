---
name: execctl-v2
description: Safely migrate an isolated CLI configuration to execctl v2 when the visible task provides its target contract.
---

Inspect the target configuration and any migration documentation in the isolated
checkout before editing only the file named in the task.
Preserve unrelated configuration and existing argument order.

When a migration contract is not expressed in the visible task or source, do not
invent command names, flags, or environment variables. Report the ambiguity in
the requested summary instead.
