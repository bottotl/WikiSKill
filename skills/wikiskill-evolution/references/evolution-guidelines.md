# Evolution Guidelines

## Role Separation

WikiSkill has four distinct responsibilities:

1. The Inference Agent solves a domain task using the active Skill and available task tools.
2. The Wiki Maintainer consolidates successful and failing training trajectories into persistent patterns.
3. The Skill Proposer reads the training evidence and Wiki, then proposes one atomic change to one Skill.
4. The validation gate accepts only a strict score improvement; otherwise it restores the prior Skill while retaining the Wiki.

An Inference task such as “optimize this Skill and runner” collapses roles 1 and 3. It measures how well an Agent rewrites the evaluation system, rather than how well the active Skill helps with domain work.

The paper injects the full content of every active Skill into each Inference Agent prompt. This removes triggering and retrieval as experimental variables. If a production host instead uses progressive disclosure, record that deviation and do not compare its result as a direct reproduction.

## Define the Task Distribution

Write tasks in the language of the work users need completed. Valid task shapes include diagnosing a failed build from supplied logs, transforming a spreadsheet while preserving formulas, retrieving cited evidence, or operating an application through its public tools.

For each task, align these elements as one contract:

| Element | Must define |
| --- | --- |
| Task input | The real work, available evidence, and explicit constraints |
| Environment | Files, tools, services, and starting state visible to the Agent |
| Output | The observable answer or workspace state |
| Scorer | How correctness and prohibited behavior are measured |
| Write scope | Paths the domain task is actually authorized to change |

Each task must have an observable result that a domain scorer can judge without reading hidden reasoning. Do not ask for a broad workflow change while permitting only a narrow implementation file, or grant broad writes for a narrow output.

## Split Independence

- Training supplies trajectories to the Wiki Maintainer and Skill Proposer.
- Validation selects or rejects candidates.
- Test measures the final result and must not influence proposals or acceptance.

Use distinct task instances across splits. Renaming a fixture or changing an incidental string does not make it independent. A dataset derived from one commit is useful as a harness smoke, but it is weak evidence of generalization unless it yields genuinely different held-out tasks.

When source provenance is available, add a stable `lineageKey` for the originating task or episode. The audit blocks a declared lineage that crosses splits and warns when lineage is absent; absence requires human or source-level evidence rather than failing an otherwise valid canonical dataset.

Prefer several real episodes representing both success and failure. With a small validation set, repeat the whole frozen experiment when the decision matters; never reuse test feedback to tune the candidate.

## Separate Product Engineering

Treat a deterministic platform defect as infrastructure work when the same input always produces the wrong result regardless of Skill guidance. Repair it with ordinary tests before freezing the experiment. Examples include truncated parser input, broken CLI argument forwarding, incorrect file locking, or a scorer that evaluates the wrong artifact.

A Skill may contain executable scripts, but the Inference Agent should consume their frozen versions during a rollout. The proposer may later change those resources as part of an atomic candidate. Do not let the task checkout silently edit the live Skill authority.

## Freeze Before Running

Record and verify:

- complete active Skill inventory, every Skill digest, and the combined Skill-set digest;
- target Skill digest or explicit empty target baseline;
- persistent Wiki digest;
- dataset digest and scorer identity;
- Provider, model, reasoning effort, and tool profile;
- iteration count, Provider launch budget, and any non-default runner timeout;
- domain adapter and runtime capability digests.

Any drift requires a new preparation step. Do not update an in-flight experiment to match an observed result. `context prepare` and `evolution baseline` use the same Skill-set digest, which `evolve` checks again when it creates the run snapshot.

The paper starts from `(S0, W0) = (empty, empty)`. Seeded evolution of an existing Skill is a useful product extension, but it is not the paper's reported experimental setup. Use an actual empty Skill and Wiki authority for reproduction claims.

## Scoring

Preserve separate evidence for task correctness, required evidence, prohibited side effects, authorized write scope, and execution efficiency when relevant. A binary score may require every mandatory dimension, but diagnostics should identify the failed dimension.

For command-scored tasks, use an argv array and bounded timeout. Keep private expectations in `groundTruth`; pass only task input and the public output schema to the Inference Agent.

## Interpret and Publish

- `completed` means the loop reached a terminal result; it does not imply improvement.
- `no_action` means the proposer found no supported atomic change.
- A rejected proposal may still add useful Wiki knowledge.
- A candidate exists only after its validation score strictly exceeds the best prior validation score.
- Test gain reports held-out behavior and must not be used to choose or revise the candidate.

Inspect every proposal's paths and validation evidence. Reject changes that improve the score by weakening an invariant, changing the scorer, broadening permissions, or encoding a fixture-specific answer.

Evolution stages an accepted candidate; it does not update the live Skill automatically:

1. Run `wikiskill candidate diff` and review the complete bundle.
2. Verify the terminal run audit.
3. Run `wikiskill candidate apply --dry-run` and verify the live baseline has not drifted.
4. Apply the candidate and retain the receipt.
5. Prepare a fresh context and confirm that a later task consumes the new live Skill.
6. Use `wikiskill rollback` with the receipt if the published Skill must be restored.

Do not force a candidate by changing the dataset or threshold after `no_action` or rejection. Preserve the Raw trajectories, Wiki patterns, and impact record, then decide whether the evidence reveals a Skill gap, dataset defect, or deterministic product defect.

When another repository packages a copy of the Skill, treat that source tree as a separate publication surface. Reconcile the carrier and packaged source explicitly after candidate review.
