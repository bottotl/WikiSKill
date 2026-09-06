# WikiSkill

WikiSkill is a standalone implementation of the paper's Raw -> Wiki -> Skills evolution loop. It does not import or start jft0m.

For a deterministic product check, use the shipped `fixtures/basic-flywheel/`
material and run `npm run acceptance`. This fixture proves the complete product
flow; it does not claim real-model quality or reproduce the paper's statistics.

The implementation keeps three responsibilities separate:

- `.wikiskill/raw/` stores immutable execution trajectories.
- `.wikiskill/wiki/` stores persistent patterns and evolution history.
- `.wikiskill/skills/` stores the current active procedural Skills.

## Install And Initialize

```sh
npm install --global ./wikiskill
wikiskill init . --dry-run --json
wikiskill init . --json
wikiskill doctor --workspace . --json
```

Direct initialization maintains a marked WikiSkill block in `AGENTS.md` and a thin `@AGENTS.md` import in `CLAUDE.md`. Use `--mode zero-source-write` when repository instruction files must remain unchanged.

`.wikiskill/skills/` is the only live Skill source. Each evolution run freezes the current Skill set before executing any rollout.

## Evolution Loop

WikiSkill implements the paper loop in this order:

1. Evaluate the current Skills on the complete validation split to establish `R_best`.
2. Run the Inference Agent on every training task with the current Skills.
3. Store complete training trajectories under Raw.
4. Let the Wiki Maintainer incrementally update patterns, index, and logs from sampled training trajectories.
5. Let the Skill Proposer inspect the Wiki and training trajectories and produce one atomic Skill proposal or `no_action`.
6. Evaluate the candidate on the complete validation split.
7. Accept only when `R_candidate > R_best`; otherwise roll back Skills while retaining Wiki updates.
8. Run the complete test split once after the loop ends.

For development-value evaluation, the final stage also runs the frozen baseline Skill on the same held-out test split without feeding either result back into the Wiki or proposal loop. Run state reports `baselineTestScore`, evolved `testScore`, and `testGain`.

The Inference Agent receives the task, available tools, and current Skills. It does not receive the Wiki, ground truth, or another split. The Maintainer cannot modify Skills. The Proposer cannot read validation or test evidence. The scorer is deterministic and does not call an Agent.

The shortest paper-reproduction path uses an explicit `wikiskill.dataset.v1` file. Every task declares `split`, `input`, `groundTruth`, and an evaluator capability ref. For the built-in exact-output scorer, use this complete task shape:

```json
{
  "schema": "wikiskill.dataset.v1",
  "domain": "example",
  "tasks": [
    {
      "id": "train-1",
      "split": "train",
      "input": { "instruction": "Return the transformed value", "value": "example" },
      "outputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["value"],
        "properties": { "value": { "type": "string" } }
      },
      "groundTruth": {
        "schema": "wikiskill.scorer.exact-output.v1",
        "expected": { "value": "expected prediction" }
      },
      "evaluator": { "capabilityRef": "builtin:exact-output-v1" }
    }
  ]
}
```

Add distinct tasks for all three splits; the one-task array above documents the field contract only. `outputSchema` is public and constrains the JSON type and shape of `prediction` without containing the answer. `groundTruth.expected` must have exactly the same JSON value and shape as the Agent's `prediction`. WikiSkill passes `input` and `outputSchema` to the Inference Agent and keeps `groundTruth` for the scorer and training outcome summary.

```sh
wikiskill evolve --workspace . --target <skill-id> --dataset dataset.json --provider claude --model <model-id> --scorer builtin:exact-output-v1 --json-events
wikiskill status --workspace . --run <run-id> --json
```

To reproduce the paper's empty-S0/W0 start, choose a new target Skill id and add `--empty`. The Proposer must create that first Skill; WikiSkill rejects `--empty` when the target already exists:

```sh
wikiskill evolve --workspace . --target <new-skill-id> --dataset dataset.json --provider claude --model <model-id> --scorer builtin:exact-output-v1 --empty --json-events
```

The selected scorer must match every task's `evaluator.capabilityRef`. Advanced custom runners, scorers, Maintainers, and Proposers can be configured separately; an explicit dataset enters the evolution loop directly without episode preprocessing.

The runtime registry includes Codex and Claude runners plus their Wiki Maintainer and Skill Proposer adapters. Each Agent role receives its own prompt and bounded input. The Proposer first sees only the Wiki, current Skills, training outcome summary, and available trajectory IDs. It chooses at least four IDs itself; only those trajectory bodies are read before a second proposal turn. The harness does not preselect four traces or preload their bodies. Fake runners and fixture datasets are only deterministic protocol tests; they are not evidence of real Agent behavior.

## Dataset Contract

A dataset must contain at least one task in each of `train`, `val`, and `test`. Task IDs are unique, and an identical `(input, groundTruth, sandbox)` pair cannot cross splits. Validation and test task data is used only by their rollout and scorer calls; it is not exposed to Maintainer or Proposer prompts. Only training ground truth appears in the training outcome summary used by the Proposer. Fixture datasets use the same contract and must be reported as fixture evidence by the caller.

## Candidate Publishing

Evolution stages a candidate instead of changing the live Skill immediately:

```sh
wikiskill candidate diff --workspace . --candidate <id> --json
wikiskill candidate apply --workspace . --candidate <id> --dry-run --json
wikiskill candidate apply --workspace . --candidate <id> --json
wikiskill rollback --workspace . --receipt <id> --json
```

Apply checks the live Skill digest and writes only `.wikiskill/skills/<id>/`. Rollback restores Skills but never rolls back Raw or Wiki.

## Coding Tasks

Use `builtin:command-exit-v1` when correctness is determined by a real build or test command rather than an answer value. WikiSkill writes each task's `sandbox` files into a fresh isolated Git repository, enables workspace editing for the selected Codex or Claude runner, and runs the frozen command after the Agent exits.

```json
{
  "id": "fix-return-value",
  "split": "train",
  "input": {
    "instruction": "Fix the implementation so the tests pass. Inspect the repository and run relevant checks."
  },
  "outputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["summary"],
    "properties": { "summary": { "type": "string" } }
  },
  "sandbox": {
    "value.js": "module.exports = () => 'wrong';\n",
    "value.test.cjs": "/* executable test file */\n"
  },
  "groundTruth": {
    "schema": "wikiskill.scorer.command-exit.v1",
    "command": ["node", "--test", "value.test.cjs"],
    "timeoutMs": 120000
  },
  "evaluator": { "capabilityRef": "builtin:command-exit-v1" }
}
```

The command is an argument array and is executed directly without a shell. Its working directory is the isolated task checkout. Raw trajectories include Provider tool events, Git status/diff, and verifier command, exit code, stdout, and stderr. The verification command remains scorer input; task instructions should still tell the coding Agent which ordinary project checks it is expected to run.

Command-scored coding cohorts run one rollout per task. Use multiple independent train/validation/test tasks for evidence rather than repeatedly spending full coding sessions on the same mutation.

## Standalone Verification

```sh
npm test
npm run acceptance
npm pack --dry-run --json
```

`npm run acceptance` exercises initialization, an explicit fixture dataset, strict validation gating, Wiki persistence, candidate apply/rollback, and temporary-state cleanup from the installed package. Its output is explicitly `protocol-fixture-not-real-agent-evidence`.

A release check must also install the generated tarball in a directory outside the source repository. Packaged files must not import or read private resources from the host monorepo.

Production trust systems such as cryptographic role leases, signer services, transcript ownership proofs, multi-tenant isolation, and organizational approval are intentionally outside this paper-reproduction package.
