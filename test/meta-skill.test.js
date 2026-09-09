"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { auditExperiment } = require("../src/audit/experiment");
const { auditRun } = require("../src/audit/run");
const { validateDataset } = require("../src");

const exactTask = (id, split, instruction) => ({
  id,
  split,
  input: { instruction },
  groundTruth: { schema: "wikiskill.scorer.exact-output.v1", expected: { value: id } },
  evaluator: { capabilityRef: "builtin:exact-output-v1" }
});

test("bundled evolution Skill ships its routed references without executable audit logic", () => {
  const root = path.join(__dirname, "..", "skills", "wikiskill-evolution");
  for (const relative of [
    "SKILL.md",
    "references/evolution-guidelines.md"
  ]) assert.equal(fs.statSync(path.join(root, relative)).isFile(), true, relative);
  assert.equal(fs.statSync(path.join(__dirname, "..", "docs", "architecture", "host-integration.md")).isFile(), true);
  const manifest = require("../package.json");
  assert.equal(manifest.files.includes("skills"), true);
  assert.equal(manifest.files.includes("docs"), true);
});

test("experiment audit accepts a structurally valid smoke and reports sample-size warnings", () => {
  const dataset = validateDataset({
      schema: "wikiskill.dataset.v1",
      tasks: [
        exactTask("train-1", "train", "Diagnose build log A."),
        exactTask("val-1", "val", "Diagnose build log B."),
        exactTask("test-1", "test", "Diagnose build log C.")
      ]
    });
  const result = auditExperiment({
    tasks: dataset.tasks,
    targetSkill: "repo-validation",
    mode: "smoke"
  });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.splitCounts, { train: 1, val: 1, test: 1 });
  assert.equal(result.warnings.filter((warning) => /only one/u.test(warning)).length, 3);
});

test("experiment audit remains domain-agnostic for scorer-specific task fields", () => {
  const train = exactTask("train-1", "train", "Perform domain validation.");
  train.groundTruth.allowedPaths = [
    "skills/repo-validation/SKILL.md",
    "skills/repo-validation/runner.js",
    "skills/repo-validation/runner.test.js",
    "contract.md",
    "reference.md",
    "workflow.md",
    "adapter.js",
    "adapter.test.js",
    "README.md"
  ];
  const dataset = validateDataset({
      schema: "wikiskill.dataset.v1",
      tasks: [
        train,
        exactTask("val-1", "val", "Perform domain validation."),
        exactTask("test-1", "test", "Perform held-out validation.")
      ]
    });
  const result = auditExperiment({
    tasks: dataset.tasks,
    targetSkill: "repo-validation",
    mode: "smoke"
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.warnings.some((warning) => /allowedPaths|target Skill/u.test(warning)), false);
});

test("official experiment audit CLI returns a stable nonzero blocker envelope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-meta-skill-"));
  const datasetPath = path.join(root, "dataset.json");
  fs.writeFileSync(datasetPath, JSON.stringify({ schema: "wikiskill.dataset.v1", tasks: [] }));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "wikiskill"),
    "experiment", "audit", "--dataset", datasetPath,
    "--target", "repo-validation",
    "--mode", "smoke",
    "--json"
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.data, null);
  assert.equal(output.success, false);
  assert.equal(output.blockers.length, 4);
});

test("official experiment audit CLI exposes the Meta-Skill audit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-experiment-cli-"));
  const datasetPath = path.join(root, "dataset.json");
  fs.writeFileSync(datasetPath, JSON.stringify({ schema: "wikiskill.dataset.v1", tasks: [
    exactTask("train-1", "train", "Train"),
    exactTask("val-1", "val", "Validate"),
    exactTask("test-1", "test", "Test")
  ] }));
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "wikiskill"), "experiment", "audit", "--dataset", datasetPath, "--target", "repo-validation", "--mode", "smoke", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.success, true);
  assert.equal(output.data.schema, "wikiskill.experiment-audit.v1");
});

test("runtime profile rejects incomplete or ambiguous runtime selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-runtime-profile-"));
  const profilePath = path.join(root, "profile.json");
  fs.writeFileSync(profilePath, JSON.stringify({ schema: "wikiskill.runtime-profile.v1", provider: "claude", model: "model-1", reasoningEffort: "low", toolProfile: "none", iterations: 1 }));
  const incomplete = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "wikiskill"), "experiment", "run", "--runtime-profile", profilePath, "--json-events"], { encoding: "utf8" });
  assert.equal(incomplete.status, 1);
  assert.match(JSON.parse(incomplete.stdout).blockers[0], /maxProviderLaunches/u);

  fs.writeFileSync(profilePath, JSON.stringify({ schema: "wikiskill.runtime-profile.v1", provider: "claude", model: "model-1", reasoningEffort: "low", toolProfile: "none", iterations: 1, maxProviderLaunches: 10 }));
  const ambiguous = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "wikiskill"), "experiment", "run", "--runtime-profile", profilePath, "--provider", "claude", "--json-events"], { encoding: "utf8" });
  assert.equal(ambiguous.status, 1);
  assert.match(JSON.parse(ambiguous.stdout).blockers[0], /cannot be combined/u);
});

test("publishable audit requires and validates the complete active Skill context", () => {
  const skillDigest = `sha256:${"a".repeat(64)}`;
  const inventory = [
    { id: "repo-validation", bundleDigest: skillDigest },
    { id: "context-helper", bundleDigest: `sha256:${"c".repeat(64)}` }
  ];
  const bundleDigest = `sha256:${require("node:crypto").createHash("sha256").update(`${JSON.stringify(inventory, null, 2)}\n`).digest("hex")}`;
  const workspaceId = "workspace-1";
  const dataset = validateDataset({
      schema: "wikiskill.dataset.v1",
      tasks: [
        exactTask("train-1", "train", "Perform domain task A."),
        exactTask("val-1", "val", "Perform domain task B."),
        exactTask("test-1", "test", "Perform domain task C.")
      ]
    });
  const result = auditExperiment({
    tasks: dataset.tasks,
    targetSkill: "repo-validation",
    mode: "publishable",
    skillContext: {
      workspaceId,
      skills: {
        bundleDigest,
        inventory
      }
    },
    baseline: {
      schema: "wikiskill.evolution-baseline.v1",
      workspaceId,
      targetSkill: "repo-validation",
      targetSkillDigest: skillDigest,
      activeSkills: inventory,
      activeSkillSetDigest: bundleDigest,
      wikiDigest: `sha256:${"d".repeat(64)}`
    }
  });
  assert.deepEqual(result.blockers, []);
});

test("terminal run audit verifies the Raw receipt, strict gating, final-only test, and training-only proposal reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-run-audit-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-run-audit-workspace-"));
  fs.mkdirSync(path.join(root, "runs", "proposals"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks"));
  fs.mkdirSync(path.join(root, "result"));
  fs.mkdirSync(path.join(root, "raw", "traces", "iter-01", "train"), { recursive: true });
  fs.mkdirSync(path.join(root, "raw", "traces", "iter-01-candidate", "val"), { recursive: true });
  fs.mkdirSync(path.join(root, "raw", "traces", "final-baseline", "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "raw", "traces", "final", "test"), { recursive: true });
  const activeSkills = [
    { id: "context-helper", bundleDigest: `sha256:${"b".repeat(64)}` },
    { id: "repo-validation", bundleDigest: `sha256:${"a".repeat(64)}` }
  ];
  const activeSkillSetDigest = `sha256:${require("node:crypto").createHash("sha256").update(`${JSON.stringify(activeSkills, null, 2)}\n`).digest("hex")}`;
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    runId: "run-1",
    rawReferencePrefix: ".wikiskill/raw/evolutions/run-1",
    targetSkills: [{ id: "repo-validation", digest: "a".repeat(64) }],
    contextSkills: [{ id: "context-helper", digest: "b".repeat(64) }],
    activeSkills,
    activeSkillSetDigest
  }));
  fs.writeFileSync(path.join(root, "tasks", "task-set.json"), JSON.stringify({
    tasks: [
      { id: "train-1", split: "train" },
      { id: "val-1", split: "val" },
      { id: "test-1", split: "test" }
    ]
  }));
  const provider = (sessionId) => ({ ref: "provider:test", modelId: "model-1", sessionId });
  const writeTrace = (relative, trace) => fs.writeFileSync(path.join(root, "raw", "traces", relative), JSON.stringify({ schema: "wikiskill.trajectory.v1", attempt: 1, rollout: 1, ...trace }));
  writeTrace(path.join("iter-01", "train", "train-1.json"), { id: "train-trace", taskId: "train-1", split: "train", phase: "training", iteration: 1, launchRef: "inference:iter-01:train:train-1:1", provider: provider("session-1") });
  writeTrace(path.join("iter-01-candidate", "val", "val-1.json"), { id: "val-trace", taskId: "val-1", split: "val", phase: "candidate_validation", iteration: 1, launchRef: "inference:iter-01-candidate:val:val-1:1", provider: provider("session-2") });
  writeTrace(path.join("final-baseline", "test", "test-1.json"), { id: "baseline-test-trace", taskId: "test-1", split: "test", phase: "baseline_test", iteration: 2, launchRef: "inference:final-baseline:test:test-1:1", provider: provider("session-3") });
  writeTrace(path.join("final", "test", "test-1.json"), { id: "test-trace", taskId: "test-1", split: "test", phase: "final_test", iteration: 2, launchRef: "inference:final:test:test-1:1", provider: provider("session-4") });
  fs.writeFileSync(path.join(root, "runs", "proposals", "proposal.json"), JSON.stringify({ action: "patch", traceReads: ["train-trace"] }));
  fs.writeFileSync(path.join(root, "runs", "state.json"), JSON.stringify({
    status: "completed",
    baselineValidationScore: 0,
    bestValidationScore: 1,
    baselineTestScore: 0,
    testScore: 1,
    runtimeSessions: [
      { kind: "inference", provider: provider("session-1") },
      { kind: "inference", provider: provider("session-2") },
      { kind: "inference", provider: provider("session-3") },
      { kind: "inference", provider: provider("session-4") },
      { kind: "learning", provider: provider("session-5") },
      { kind: "learning", provider: provider("session-6") }
    ],
    inferenceInvocations: [
      { launchRef: "inference:iter-01:train:train-1:1", taskId: "train-1", split: "train", phase: "training", iteration: 1, rollout: 1, provider: provider("session-1") },
      { launchRef: "inference:iter-01-candidate:val:val-1:1", taskId: "val-1", split: "val", phase: "candidate_validation", iteration: 1, rollout: 1, provider: provider("session-2") },
      { launchRef: "inference:final-baseline:test:test-1:1", taskId: "test-1", split: "test", phase: "baseline_test", iteration: 2, rollout: 1, provider: provider("session-3") },
      { launchRef: "inference:final:test:test-1:1", taskId: "test-1", split: "test", phase: "final_test", iteration: 2, rollout: 1, provider: provider("session-4") }
    ],
    learningInvocations: [
      { launchRef: "learning:1:1:maintainer", role: "maintainer", provider: provider("session-5") },
      { launchRef: "learning:1:1:proposer", role: "proposer", provider: provider("session-6") }
    ],
    proposalHistory: [{ iteration: 1, attempt: 1, accepted: true, candidateValidationScore: 1, proposalPath: "runs/proposals/proposal.json" }]
  }));

  const authorityRoot = path.join(workspace, ".wikiskill", "raw", "evolutions", "run-1");
  fs.mkdirSync(authorityRoot, { recursive: true });
  const rawDigest = `sha256:${"e".repeat(64)}`;
  fs.writeFileSync(path.join(authorityRoot, "manifest.json"), JSON.stringify({ schema: "wikiskill.evolution-raw.v1", runId: "run-1", rawDigest }));
  fs.writeFileSync(path.join(root, "result", "raw-authority.json"), JSON.stringify({ schema: "wikiskill.raw-authority-receipt.v1", runId: "run-1", rawRef: ".wikiskill/raw/evolutions/run-1", rawDigest }));
  const result = auditRun(root, { workspace });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.data.activeSkillSetDigest, activeSkillSetDigest);
  assert.equal(result.data.activeSkills.length, 2);
  const cli = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "wikiskill"), "run", "audit", "--run-root", root, "--workspace", workspace, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout || cli.stderr);
  assert.equal(JSON.parse(cli.stdout).data.schema, "wikiskill.run-audit.v1");
  fs.writeFileSync(path.join(root, "result", "raw-authority.json"), JSON.stringify({ schema: "wikiskill.raw-authority-receipt.v1", runId: "run-1", rawRef: ".wikiskill/raw/evolutions/run-1", rawDigest: `sha256:${"f".repeat(64)}` }));
  assert.equal(auditRun(root, { workspace }).blockers.some((blocker) => /receipt does not match/u.test(blocker)), true);
});
