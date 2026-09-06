# CLI Configuration Evolution Demo

This demo exercises WikiSkill with a real Codex run. It evolves a conservative
`execctl-v2` Skill using isolated command-scored CLI configuration migrations.

Each task exposes `config/execctl.json`. Training tasks also include a visible
runbook; validation and test tasks do not. The evaluator is a private Node
command: it checks the resulting config and permits edits only to that file.
The inference agent does not receive the dataset or evaluator command in its
isolated checkout.

Run the no-network preparation check:

```sh
npm run demo:check
```

Run one live experiment with an available Codex model:

```sh
npm run demo:live -- --model gpt-5.6-terra
```

The runner uses the public `wikiskill` commands, retains the full run under
`artifacts/<run-id>/`, and applies an accepted candidate to that artifact's
workspace. The committed Skill remains the baseline. A live run exits nonzero
when no candidate yields both a strict validation improvement and a positive
test gain; its evidence is still retained for inspection.
