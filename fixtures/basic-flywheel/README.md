# Basic Flywheel Fixture

This deterministic fixture proves the standalone product flow without claiming
real-model quality or paper-level statistical significance.

It exercises:

- an explicit 4 train / 2 validation / 2 test dataset;
- baseline validation score 0;
- four training trajectories and a persistent Wiki update;
- one atomic Skill proposal with strict validation gain to 1;
- frozen baseline test score 0 and evolved test score 1;
- candidate diff, dry-run apply, apply, and rollback.

Run the installed-package black-box flow:

```sh
npm run acceptance
```

The command creates an isolated temporary workspace and removes it after all
assertions pass. Files under `adapters/` are deterministic fixture roles, not
real Provider implementations.
