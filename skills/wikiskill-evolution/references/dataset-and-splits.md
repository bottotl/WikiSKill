# Dataset and Split Design

## Contract Alignment

For each task, review these elements as one contract:

| Element | Must define |
| --- | --- |
| Task input | The real work, available evidence, and explicit constraints |
| Environment | Files, tools, services, and starting state visible to the Agent |
| Output | The observable answer or workspace state |
| Scorer | How correctness and prohibited behavior are measured |
| Write scope | Paths the domain task is actually authorized to change |

Terminology must be exact. If two stages apply different rules to the same value, encode the stage in the fixture and expectation instead of using one ambiguous phrase.

Do not ask for a broad workflow change while permitting only a narrow implementation file. Conversely, do not grant broad repository writes when the task only requires one output artifact.

## Split Independence

- Training supplies trajectories to the Wiki Maintainer and Skill Proposer.
- Validation selects or rejects candidates.
- Test measures the final result and must not influence proposals or acceptance.

Use distinct task instances across splits. Renaming one fixture or changing an incidental string does not make it independent. A dataset derived from one commit may be useful as a harness smoke, but it is weak evidence of generalization unless it yields genuinely different held-out tasks.

Give every task a stable `lineageKey` identifying its originating task or episode. A publishable experiment must not reuse one lineage across splits. The preflight treats missing lineage as a blocker in publishable mode and as a warning in explicit smoke mode.

Prefer several real episodes representing both success and failure. With a small validation set, repeat the whole frozen experiment when the decision matters; do not reuse test feedback to tune the candidate.

## Scoring

Preserve separate evidence for:

- task correctness;
- required evidence completeness;
- prohibited side effects;
- authorized write scope;
- execution efficiency when it is part of the contract.

A final binary score may require all mandatory dimensions, but diagnostics must identify which dimension failed. `disallowedPaths` is meaningful only when the task and its allowed paths agree.

For command-scored tasks, use an argv array and a bounded timeout. Keep private expectations in `groundTruth`; pass only task input and the public output schema to the Inference Agent.

## Preflight Review

The audit script catches structural defects and suspicious experiment shapes. Human review must still confirm semantic facts it cannot infer, including stage-specific state rules, fixture realism, task independence, and whether the scorer observes the intended user outcome.
