"use strict";

const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { execute } = require("../src/cli");
const { configureEvolution, evolveWorkspace, statusWorkspaceEvolution } = require("../src/evolution");
const { validateDataset } = require("../src/index");
const { createCapabilityRegistry } = require("../src/runtime-capabilities");
const { createCommandExitScorer } = require("../src/command-scorer");
const { initWorkspace } = require("../src/workspace");

const tasks = () => [
  ...[1, 2, 3, 4].map((index) => ({
    id: `train-${index}`,
    split: "train",
    input: { request: `Train ${index}` },
    outputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    groundTruth: { expected: "improved" },
    evaluator: { capabilityRef: "scorer:test" }
  })),
  { id: "validation", split: "val", input: { request: "Validate" }, outputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } }, groundTruth: { expected: "improved" }, evaluator: { capabilityRef: "scorer:test" } },
  { id: "test", split: "test", input: { request: "Test" }, outputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } }, groundTruth: { expected: "improved" }, evaluator: { capabilityRef: "scorer:test" } }
];

const setup = async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-evolution-workspace-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-evolution-state-"));
  await initWorkspace(workspace, { mode: "zero-source-write" });
  const skillRoot = path.join(workspace, ".wikiskill", "skills", "target-skill");
  await fs.mkdir(skillRoot);
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: target-skill\ndescription: Handle target tasks.\n---\n\nUse the old procedure.\n");
  const datasetPath = path.join(workspace, "dataset.json");
  await fs.writeFile(datasetPath, `${JSON.stringify({ schema: "wikiskill.dataset.v1", domain: "paper-test", tasks: tasks() }, null, 2)}\n`);
  return { workspace, stateRoot, skillRoot, datasetPath };
};

const setupEmpty = async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-empty-workspace-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-empty-state-"));
  await initWorkspace(workspace, { mode: "zero-source-write" });
  const datasetPath = path.join(workspace, "dataset.json");
  await fs.writeFile(datasetPath, `${JSON.stringify({ schema: "wikiskill.dataset.v1", domain: "empty-test", tasks: tasks() }, null, 2)}\n`);
  return { workspace, stateRoot, datasetPath };
};

const digestForDataset = async (datasetPath) => validateDataset(JSON.parse(await fs.readFile(datasetPath, "utf8"))).digest;

const baselineFor = async (workspace, targetSkill, empty = false) => {
  const output = [];
  const code = await execute(["evolution", "baseline", "--workspace", workspace, "--target", targetSkill, ...(empty ? ["--empty"] : []), "--json"], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 0, output.join(""));
  return JSON.parse(output.join("")).data;
};

const adapter = {
  prepareEnvironment: async ({ workdir }) => workdir,
  renderTask: ({ task }) => task.input,
  resolveTools: () => [],
  extractPrediction: ({ result }) => result.prediction,
  score: ({ prediction, groundTruth }) => ({ score: prediction.value === groundTruth.expected ? 1 : 0, evidence: { matched: true } }),
  disposeEnvironment: async () => undefined
};

const runner = async ({ task, skills }) => ({
  prediction: { value: skills.target["target-skill"]["SKILL.md"].includes("improved procedure") ? "improved" : "old" },
  events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
});

const maintainer = async ({ writePattern, appendLog }) => {
  writePattern("procedure.md", "# Procedure\n\nThe old procedure fails.\n");
  appendLog("Maintainer analyzed sampled training trajectories.");
};

const proposer = async ({ availableTraces, readTrace }) => {
  const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
  traceReads.forEach(readTrace);
  return {
    action: "patch",
    skillId: "target-skill",
    traceReads,
    files: {
      "SKILL.md": "---\nname: target-skill\ndescription: Handle target tasks.\n---\n\nUse the improved procedure.\n"
    }
  };
};

test("explicit dataset runs the paper loop and stages a strict-gain candidate", async () => {
  const { workspace, stateRoot, skillRoot, datasetPath } = await setup();
  const before = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "explicit-strict-gain",
    adapter,
    runner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  assert.match(result.datasetId, /^dataset-/u);
  assert.equal(result.state.baselineValidationScore, 0);
  assert.equal(result.state.bestValidationScore, 1);
  assert.equal(result.state.baselineTestScore, 0);
  assert.equal(result.state.testScore, 1);
  assert.equal(result.state.testGain, 1);
  assert.deepEqual(result.state.acceptedIterations, [1]);
  assert.equal(result.candidate.status, "validation_accepted");
  assert.equal(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"), before);
  assert.match(await fs.readFile(path.join(workspace, ".wikiskill/wiki/patterns/procedure.md"), "utf8"), /old procedure fails/u);
  assert.equal(await fs.access(path.join(workspace, result.rawRef, "raw", "traces")).then(() => true), true);
});

test("result indexes fresh Inference and learning-role Provider sessions", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  let inferenceIndex = 0;
  const auditedRunner = async (input) => ({
    ...(await runner(input)),
    provider: { ref: "provider:claude", modelId: "test-model", sessionId: `inference-session-${++inferenceIndex}` }
  });
  const auditedMaintainer = async (input) => {
    await input.recordInvocation({ schema: "wikiskill.learning-invocation.v1", launchRef: "learning:1:1:maintainer", role: "maintainer", provider: { ref: "provider:claude", modelId: "test-model", sessionId: "maintainer-session" } });
    return maintainer(input);
  };
  const auditedProposer = async (input) => {
    await input.recordInvocation({ schema: "wikiskill.learning-invocation.v1", launchRef: "learning:1:1:proposer-select", role: "proposer-select", provider: { ref: "provider:claude", modelId: "test-model", sessionId: "proposer-select-session" } });
    await input.recordInvocation({ schema: "wikiskill.learning-invocation.v1", launchRef: "learning:1:1:proposer", role: "proposer", provider: { ref: "provider:claude", modelId: "test-model", sessionId: "proposer-session" } });
    return proposer(input);
  };
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "runtime-session-evidence",
    adapter,
    runner: auditedRunner,
    maintainer: auditedMaintainer,
    proposer: auditedProposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  const runtimeEvidence = JSON.parse(await fs.readFile(path.join(result.runRoot, "result", "runtime-evidence.json"), "utf8"));
  assert.equal(runtimeEvidence.schema, "wikiskill.runtime-evidence.v1");
  assert.equal(runtimeEvidence.inference.length, inferenceIndex);
  assert.equal(new Set(runtimeEvidence.inference.map((item) => item.provider.sessionId)).size, inferenceIndex);
  assert.deepEqual(runtimeEvidence.learning.map((item) => item.role), ["maintainer", "proposer-select", "proposer"]);
  assert.equal(JSON.stringify(runtimeEvidence).includes("SYSTEM SKILL"), false);
  assert.match(result.runtimeEvidenceDigest, /^sha256:[0-9a-f]{64}$/u);
  const status = await statusWorkspaceEvolution(workspace, result.runId, { stateRoot });
  assert.deepEqual(status.runtimeEvidence, runtimeEvidence);

  await fs.writeFile(path.join(result.runRoot, "result", "runtime-evidence.json"), `${JSON.stringify({ ...runtimeEvidence, runId: "tampered" }, null, 2)}\n`);
  await assert.rejects(statusWorkspaceEvolution(workspace, result.runId, { stateRoot }), /runtime evidence digest mismatch/u);
});

test("blocks reuse of one Provider session across evolution invocations", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const reusedRunner = async (input) => ({
    ...(await runner(input)),
    provider: { ref: "provider:claude", modelId: "test-model", sessionId: "reused-session" }
  });
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "reused-runtime-session",
    adapter,
    runner: reusedRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  }), /Provider session was reused within one evolution run/u);
});

test("equal validation score rolls back Skills while retaining Wiki", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const equalAdapter = { ...adapter, score: () => ({ score: 0, evidence: { matched: false } }) };
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "explicit-equal-score",
    adapter: equalAdapter,
    runner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  assert.equal(result.state.baselineValidationScore, 0);
  assert.equal(result.state.bestValidationScore, 0);
  assert.deepEqual(result.state.acceptedIterations, []);
  assert.equal(result.candidate, null);
  assert.match(await fs.readFile(path.join(workspace, ".wikiskill/wiki/patterns/procedure.md"), "utf8"), /old procedure fails/u);
});

const writeModules = async (workspace) => {
  const root = path.join(workspace, "adapters");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "adapter.cjs"), `module.exports = {
    prepareEnvironment: async ({workdir}) => workdir,
    renderTask: ({task}) => task.input,
    resolveTools: () => [],
    extractPrediction: ({result}) => result.prediction,
    score: ({prediction, groundTruth}) => ({score: prediction.value === groundTruth.expected ? 1 : 0, evidence: {matched: true}}),
    disposeEnvironment: async () => undefined
  };\n`);
  await fs.writeFile(path.join(root, "runner.cjs"), `module.exports = async ({task, skills}) => ({prediction: {value: skills.target["target-skill"]?.["SKILL.md"]?.includes("improved procedure") ? "improved" : "old"}, events: [{type: "assistant", text: task.id}]});\n`);
  await fs.writeFile(path.join(root, "maintainer.cjs"), `module.exports = async ({writePattern}) => writePattern("cli.md", "# CLI\\n");\n`);
  await fs.writeFile(path.join(root, "proposer.cjs"), `module.exports = async ({availableTraces, readTrace, skills, allowedNewSkillIds}) => {
    const traceReads = availableTraces.slice(0, 4).map(({id}) => id);
    traceReads.forEach(readTrace);
    const skillId = skills.target["target-skill"] ? "target-skill" : allowedNewSkillIds[0];
    return {action: skills.target["target-skill"] ? "patch" : "create", skillId, traceReads, files: {"SKILL.md": "---\\nname: target-skill\\ndescription: Handle target tasks.\\n---\\n\\nUse the improved procedure.\\n"}};
  };\n`);
  return {
    schema: "wikiskill.evolution-config.v1",
    adapterModule: "adapters/adapter.cjs",
    runnerModule: "adapters/runner.cjs",
    maintainerModule: "adapters/maintainer.cjs",
    proposerModule: "adapters/proposer.cjs",
    model: { id: "test-model" },
    iterationLimit: 1
  };
};

test("public CLI runs an explicit dataset without creating dataset views", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  await configureEvolution(workspace, await writeModules(workspace));
  const datasetDigest = await digestForDataset(datasetPath);
  const baseline = await baselineFor(workspace, "target-skill");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", datasetDigest,
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--scorer", "scorer:test",
    "--state-root", stateRoot,
    "--run-id", "explicit-cli",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  const events = output.join("").trim().split("\n").map(JSON.parse);
  assert.equal(code, 0, JSON.stringify(events, null, 2));
  assert.equal(events[0].selection, "dataset-file");
  assert.equal(events.at(-1).data.state.bestValidationScore, 1);
  assert.equal(await fs.access(path.join(workspace, ".wikiskill/evaluations/datasets")).then(() => true, () => false), false);
});

test("public CLI inspects the clean-start Skill and Wiki baseline without creating evolution state", async () => {
  const { workspace, stateRoot } = await setup();
  const output = [];
  const code = await execute([
    "evolution", "baseline",
    "--workspace", workspace,
    "--target", "target-skill",
    "--json"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 0, output.join(""));
  const baseline = JSON.parse(output.join("")).data;
  assert.equal(baseline.schema, "wikiskill.evolution-baseline.v1");
  assert.equal(baseline.targetSkill, "target-skill");
  assert.match(baseline.targetSkillDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(baseline.wikiDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public CLI requires a prepared dataset digest", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--scorer", "scorer:test",
    "--state-root", stateRoot,
    "--run-id", "missing-prepared-digest",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /requires --expected-dataset-digest/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public CLI rejects a prepared dataset digest mismatch", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", "0".repeat(64),
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--scorer", "scorer:test",
    "--state-root", stateRoot,
    "--run-id", "mismatched-prepared-digest",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /Dataset digest differs from the prepared input/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public CLI rejects target Skill drift from the prepared baseline", async () => {
  const { workspace, stateRoot, skillRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  const datasetDigest = await digestForDataset(datasetPath);
  await fs.appendFile(path.join(skillRoot, "SKILL.md"), "\nUnreviewed drift.\n");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", datasetDigest,
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--scorer", "scorer:test",
    "--state-root", stateRoot,
    "--run-id", "target-skill-drift",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /Target Skill digest differs from the prepared baseline/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public CLI rejects persistent Wiki drift from the prepared baseline", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  const datasetDigest = await digestForDataset(datasetPath);
  await fs.appendFile(path.join(workspace, ".wikiskill", "wiki", "index.md"), "\nUnreviewed drift.\n");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", datasetDigest,
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--scorer", "scorer:test",
    "--state-root", stateRoot,
    "--run-id", "wiki-drift",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /Wiki digest differs from the prepared baseline/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("rechecks the actual frozen Skill snapshot after initial baseline validation", async () => {
  const { workspace, stateRoot, skillRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    expectedDatasetDigest: await digestForDataset(datasetPath),
    expectedWorkspaceId: baseline.workspaceId,
    expectedTargetSkillDigest: baseline.targetSkillDigest,
    expectedWikiDigest: baseline.wikiDigest,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "frozen-target-drift",
    adapter,
    runner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    onEvent: (event) => {
      if (event.type === "evolution.dataset-selected") fsSync.appendFileSync(path.join(skillRoot, "SKILL.md"), "\nConcurrent drift.\n");
    }
  }), /Frozen target Skill digest differs from the prepared baseline/u);
  assert.equal(await fs.access(path.join(stateRoot, "engine", "runs")).then(() => true, () => false), false);
});

test("rechecks the actual frozen Wiki snapshot after initial baseline validation", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    expectedDatasetDigest: await digestForDataset(datasetPath),
    expectedWorkspaceId: baseline.workspaceId,
    expectedTargetSkillDigest: baseline.targetSkillDigest,
    expectedWikiDigest: baseline.wikiDigest,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "frozen-wiki-drift",
    adapter,
    runner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    onEvent: (event) => {
      if (event.type === "evolution.dataset-selected") fsSync.appendFileSync(path.join(workspace, ".wikiskill", "wiki", "index.md"), "\nConcurrent drift.\n");
    }
  }), /Frozen Wiki digest differs from the prepared baseline/u);
  assert.equal(await fs.access(path.join(stateRoot, "engine", "runs")).then(() => true, () => false), false);
});

test("explicit dataset rejects a scorer mismatch before run creation", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:wrong",
    stateRoot
  }), /evaluator must match --scorer/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("explicit dataset rejects a prepared digest mismatch before run creation", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    expectedDatasetDigest: "0".repeat(64),
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot
  }), /Dataset digest differs from the prepared input/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public empty mode creates, applies, and rolls back the first Skill", async () => {
  const { workspace, stateRoot, datasetPath } = await setupEmpty();
  await configureEvolution(workspace, await writeModules(workspace));
  const datasetDigest = await digestForDataset(datasetPath);
  const baseline = await baselineFor(workspace, "target-skill", true);
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", datasetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--scorer", "scorer:test",
    "--state-root", stateRoot,
    "--run-id", "empty-cli",
    "--empty",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  const events = output.join("").trim().split("\n").map(JSON.parse);
  assert.equal(code, 0, JSON.stringify(events, null, 2));
  const candidate = events.at(-1).data.candidate;
  assert.equal(candidate.baselineDigest, null);
  assert.equal(candidate.status, "validation_accepted");
  const invoke = async (args) => {
    const lines = [];
    const resultCode = await execute(args, { stdout: (line) => lines.push(line), stderr: () => {} });
    assert.equal(resultCode, 0, lines.join(""));
    return JSON.parse(lines.join(""));
  };
  const diff = await invoke(["candidate", "diff", "--workspace", workspace, "--candidate", candidate.candidateId, "--json"]);
  assert.deepEqual(diff.data.changedPaths, [".wikiskill/skills/target-skill/SKILL.md"]);
  const applied = await invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidate.candidateId, "--json"]);
  assert.equal(applied.data.receipt.created, true);
  assert.match(await fs.readFile(path.join(workspace, ".wikiskill/skills/target-skill/SKILL.md"), "utf8"), /improved procedure/u);
  const rolledBack = await invoke(["rollback", "--workspace", workspace, "--receipt", applied.data.receipt.receiptId, "--json"]);
  assert.equal(rolledBack.data.removedCreatedSkill, true);
  assert.equal(await fs.access(path.join(workspace, ".wikiskill/skills/target-skill")).then(() => true, () => false), false);
});

test("explicit dataset resolves runner, scorer, and learning roles from the runtime registry", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const registry = createCapabilityRegistry();
  registry.registerRunner({ ref: "provider:claude", apiVersion: "wikiskill.runner.v1", implementationVersion: "test", implementationDigest: `sha256:${"a".repeat(64)}` }, () => runner);
  registry.registerScorer({ ref: "scorer:test", apiVersion: "wikiskill.scorer.v1", implementationVersion: "test", implementationDigest: `sha256:${"b".repeat(64)}` }, () => ({ prediction, privateInput }) => ({ score: prediction.value === privateInput.expected ? 1 : 0, evidence: { matched: true } }));
  registry.registerLearningAgent({ ref: "provider:claude-learning", apiVersion: "wikiskill.learning-agent.v1", implementationVersion: "test", implementationDigest: `sha256:${"c".repeat(64)}` }, () => ({ maintainer, proposer }));
  registry.seal();
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "explicit-registry",
    capabilityRegistry: registry,
    iterationLimit: 1
  });
  assert.equal(result.state.bestValidationScore, 1);
  assert.equal(result.candidate.runtime.runnerRef, "provider:claude");
  assert.equal(result.candidate.runtime.scorerRef, "scorer:test");
});

test("evolution requires an explicit dataset", async () => {
  const { workspace, stateRoot } = await setup();
  await assert.rejects(evolveWorkspace(workspace, "target-skill", { stateRoot }), /requires --dataset/u);
});

test("development runtime records code diff, tool events, and command verification", async () => {
  const { workspace, stateRoot, skillRoot } = await setup();
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: target-skill\ndescription: Fix return-value defects.\n---\n\nInspect the code.\n");
  const developmentTask = (id, split) => ({
    id,
    split,
    input: { instruction: "Fix value.js so the test passes, then return a short summary.", caseId: id },
    outputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } },
    sandbox: {
      "value.js": "module.exports = () => 'wrong';\n",
      "value.test.cjs": "const test=require('node:test');const assert=require('node:assert/strict');const value=require('./value');test('value',()=>assert.equal(value(),'correct'));\n"
    },
    groundTruth: { schema: "wikiskill.scorer.command-exit.v1", command: [process.execPath, "--test", "value.test.cjs"], timeoutMs: 10_000 },
    evaluator: { capabilityRef: "builtin:command-exit-v1" }
  });
  const developmentDataset = {
    schema: "wikiskill.dataset.v1",
    domain: "development-fixture",
    tasks: [
      ...[1, 2, 3, 4].map((index) => developmentTask(`dev-train-${index}`, "train")),
      developmentTask("dev-val-1", "val"),
      developmentTask("dev-val-2", "val"),
      developmentTask("dev-test-1", "test"),
      developmentTask("dev-test-2", "test")
    ]
  };
  const datasetPath = path.join(workspace, "development-dataset.json");
  await fs.writeFile(datasetPath, `${JSON.stringify(developmentDataset, null, 2)}\n`);
  const rolloutInputs = [];
  const codingRunner = async ({ task, workdir, skills, tools }) => {
    assert.deepEqual(tools, ["workspace"]);
    const improved = skills.target["target-skill"]["SKILL.md"].includes("Replace the wrong return value");
    rolloutInputs.push({ taskId: task.id, improved, workdir, initialSource: await fs.readFile(path.join(workdir, "value.js"), "utf8") });
    if (improved) await fs.writeFile(path.join(workdir, "value.js"), "module.exports = () => 'correct';\n");
    return { prediction: { summary: improved ? "fixed" : "inspected" }, events: [{ type: "tool_call", tool: "editor", input: { file: "value.js" } }, { type: "tool_result", output: improved ? "changed" : "unchanged" }] };
  };
  let maintainerProjection;
  const developmentMaintainer = async ({ sampledTraces, writePattern }) => {
    maintainerProjection = sampledTraces[0].executionLog;
    writePattern("development.md", "# Development\n\nUse verifier failures as evidence.\n");
  };
  let proposerProjection;
  let proposerTraining;
  const developmentProposer = async ({ availableTraces, readTrace, training }) => {
    const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
    proposerProjection = readTrace(traceReads[0]);
    traceReads.slice(1).forEach(readTrace);
    proposerTraining = training;
    return { action: "patch", skillId: "target-skill", traceReads, files: { "SKILL.md": "---\nname: target-skill\ndescription: Fix return-value defects.\n---\n\nReplace the wrong return value with the value required by the test.\n" } };
  };
  const registry = createCapabilityRegistry();
  registry.registerRunner({ ref: "provider:claude", apiVersion: "wikiskill.runner.v1", implementationVersion: "test", implementationDigest: `sha256:${"a".repeat(64)}` }, () => codingRunner);
  registry.registerScorer({ ref: "builtin:command-exit-v1", apiVersion: "wikiskill.scorer.v1", implementationVersion: "test", implementationDigest: `sha256:${"b".repeat(64)}` }, () => createCommandExitScorer());
  registry.registerLearningAgent({ ref: "provider:claude-learning", apiVersion: "wikiskill.learning-agent.v1", implementationVersion: "test", implementationDigest: `sha256:${"c".repeat(64)}` }, () => ({ maintainer: developmentMaintainer, proposer: developmentProposer }));
  registry.seal();
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "builtin:command-exit-v1",
    stateRoot,
    runId: "development-runtime",
    capabilityRegistry: registry,
    iterationLimit: 1
  });
  assert.equal(result.state.baselineValidationScore, 0);
  assert.equal(result.state.bestValidationScore, 1);
  assert.equal(result.state.testScore, 1);
  const trace = JSON.parse(await fs.readFile(path.join(workspace, result.rawRef, "raw", "traces", "iter-01-candidate", "val", "dev-val-1.json"), "utf8"));
  assert.match(trace.workspace.diff, /wrong[\s\S]*correct/u);
  assert.match(trace.workspace.diffDigest, /^[0-9a-f]{64}$/u);
  assert.equal(trace.events.some((event) => event.type === "tool_call"), true);
  assert.deepEqual(trace.verification.command, [process.execPath, "--test", "value.test.cjs"]);
  assert.equal(trace.verification.exitCode, 0);
  assert.match(maintainerProjection, /not ok/u);
  assert.doesNotMatch(maintainerProjection, /"command":\s*\[/u);
  assert.equal(proposerProjection.verification.command, undefined);
  assert.match(proposerProjection.verification.commandDigest, /^[0-9a-f]{64}$/u);
  assert.match(proposerProjection.verification.stdout, /not ok/u);
  assert.equal(JSON.stringify(proposerTraining).includes("value.test.cjs"), false);
  const baselineTest = rolloutInputs.find((item) => item.taskId === "dev-test-1" && !item.improved);
  const evolvedTest = rolloutInputs.find((item) => item.taskId === "dev-test-1" && item.improved);
  assert.notEqual(baselineTest.workdir, evolvedTest.workdir);
  assert.match(baselineTest.workdir, /final-baseline/u);
  assert.match(evolvedTest.workdir, /final-01/u);
  assert.equal(baselineTest.initialSource, "module.exports = () => 'wrong';\n");
  assert.equal(evolvedTest.initialSource, "module.exports = () => 'wrong';\n");
  assert.equal(await fs.access(baselineTest.workdir).then(() => true, () => false), false);
  assert.equal(await fs.access(evolvedTest.workdir).then(() => true, () => false), false);
});
