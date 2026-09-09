# Gating and Publication

## Interpret the Run

Use the full state and evidence, not the top-level process status alone:

- `completed` means the loop reached a terminal result; it does not imply improvement.
- `no_action` means the proposer found no supported atomic change.
- A rejected proposal may still add useful Wiki knowledge.
- A candidate exists only after its validation score strictly exceeds the best prior validation score.
- Test gain reports held-out behavior and must not be used to choose or revise the candidate.

Inspect every proposal's changed paths and validation evidence. Reject a change that improves the headline score by weakening an invariant, changing the scorer, broadening permissions, or encoding a fixture-specific answer.

## Publish Deliberately

Evolution stages an accepted candidate; it does not update the live Skill automatically.

1. Run `wikiskill candidate diff` and review the complete bundle.
2. Verify the terminal run audit, including the manifest's complete active Skill-set digest.
3. Run `wikiskill candidate apply --dry-run` and verify the live baseline has not drifted.
4. Apply the candidate and retain the receipt.
5. Prepare a fresh context before checking that a later task consumes the new live Skill.
6. Use `wikiskill rollback` with the receipt if the published Skill must be restored.

When a host or plugin repository also packages a copy of the Skill, treat that source tree as a separate publication surface. A carrier receipt does not update package source, and a source commit does not update the carrier. Reconcile them explicitly after candidate review.

## Valid No-Candidate Outcome

Do not force a candidate by changing the dataset or acceptance threshold after a `no_action` or rejection. Preserve the Raw trajectories, Wiki patterns, and impact record. Decide whether the evidence reveals a Skill gap, a dataset defect, or a deterministic product defect, then create a new experiment only when its inputs can be frozen independently.
