"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const execFileSync = require("node:child_process").execFileSync;
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { execute } = require("../src/cli");
const { configureEvolution, evolveWorkspace, statusWorkspaceEvolution, treeDigest } = require("../src/evolution");
const { createRun, runEvolution, validateDataset } = require("../src/index");
const { createCapabilityRegistry } = require("../src/runtime-capabilities");
const { createCommandExitScorer } = require("../src/command-scorer");
const { createOperationalMilestoneScorer } = require("../src/operational-scorer");
const { initWorkspace } = require("../src/workspace");
const { auditRun } = require("../src/audit/run");

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

const makeWritable = async (target) => {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    await fs.chmod(target, 0o755);
    for (const entry of await fs.readdir(target)) await makeWritable(path.join(target, entry));
  } else await fs.chmod(target, 0o644);
};

const firstFile = async (directory) => {
  const files = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await walk(directory);
  return files.sort()[0];
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
  assert.match(result.rawDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.state.acceptedIterations, [1]);
  assert.equal(result.candidate.status, "validation_accepted");
  assert.equal(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"), before);
  assert.match(await fs.readFile(path.join(workspace, ".wikiskill/wiki/patterns/procedure.md"), "utf8"), /old procedure fails/u);
  assert.equal(await fs.access(path.join(workspace, result.rawRef, "raw", "traces")).then(() => true), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.runRoot, "result", "raw-authority.json"), "utf8")).rawDigest, result.rawDigest);
});

test("operational outcomes stage a candidate only after strict milestone improvement", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const operationalRunner = async ({ task, skills }) => ({
    prediction: { improved: skills.target["target-skill"]["SKILL.md"].includes("improved procedure") },
    events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
  });
  const operationalAdapter = {
    ...adapter,
    score: ({ prediction }) => {
      const verifiedMilestones = prediction.improved ? ["M0", "M1", "M2"] : ["M0", "M1"];
      return {
        score: {
          schema: "wikiskill.operational-outcome.v1",
          eligible: true,
          terminalSuccess: prediction.improved,
          verifiedMilestones,
          highestVerifiedMilestone: verifiedMilestones.length - 1,
          verifiedMilestoneCount: verifiedMilestones.length,
          actionableBlockersRemoved: prediction.improved ? 1 : 0,
          unauthorizedWrites: 0,
          unrecoveredUserChanges: 0,
          diagnosisVerifierPassed: true
        },
        evidence: { source: "test-harness" }
      };
    }
  };

  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-strict-gain",
    adapter: operationalAdapter,
    runner: operationalRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });

  assert.equal(result.state.baselineValidationScore.schema, "wikiskill.operational-aggregate.v1");
  assert.equal(result.state.baselineValidationScore.verifiedMilestoneCount, 2);
  assert.equal(result.state.bestValidationScore.terminalSuccessCount, 1);
  assert.deepEqual(result.state.acceptedIterations, [1]);
  assert.equal(result.state.baselineTestScore.terminalSuccessCount, 0);
  assert.equal(result.state.testScore.terminalSuccessCount, 1);
  assert.equal(result.candidate.status, "validation_accepted");
});

test("operational held-out milestone regression prevents candidate staging", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const operationalRunner = async ({ task, skills }) => {
    const improved = skills.target["target-skill"]["SKILL.md"].includes("improved procedure");
    const regressedTest = task.split === "test" && improved;
    const verifiedMilestones = regressedTest ? ["M0"] : improved || task.split === "test" ? ["M0", "M1", "M2"] : ["M0", "M1"];
    return {
      prediction: { verifiedMilestones, terminalSuccess: verifiedMilestones.length === 3 },
      events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
    };
  };
  const operationalAdapter = {
    ...adapter,
    score: ({ prediction }) => ({
      score: {
        schema: "wikiskill.operational-outcome.v1",
        eligible: true,
        terminalSuccess: prediction.terminalSuccess,
        verifiedMilestones: prediction.verifiedMilestones,
        highestVerifiedMilestone: prediction.verifiedMilestones.length - 1,
        verifiedMilestoneCount: prediction.verifiedMilestones.length,
        actionableBlockersRemoved: 0,
        unauthorizedWrites: 0,
        unrecoveredUserChanges: 0,
        diagnosisVerifierPassed: true
      },
      evidence: { source: "test-harness" }
    })
  };

  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-heldout-regression",
    adapter: operationalAdapter,
    runner: operationalRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });

  assert.deepEqual(result.state.acceptedIterations, [1]);
  assert.deepEqual(result.state.testComparison.regressions, [{ taskId: "test", lostMilestones: ["M1", "M2"] }]);
  assert.equal(result.candidate, null);
});

test("run audit binds a staged operational candidate to its Raw authority, result, and Skill trees", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const operationalRunner = async ({ task, skills }) => ({
    prediction: { improved: skills.target["target-skill"]["SKILL.md"].includes("improved procedure") },
    events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
  });
  const operationalAdapter = {
    ...adapter,
    score: ({ prediction }) => {
      const verifiedMilestones = prediction.improved ? ["M0", "M1", "M2"] : ["M0", "M1"];
      return {
        score: {
          schema: "wikiskill.operational-outcome.v1",
          eligible: true,
          terminalSuccess: prediction.improved,
          verifiedMilestones,
          highestVerifiedMilestone: verifiedMilestones.length - 1,
          verifiedMilestoneCount: verifiedMilestones.length,
          actionableBlockersRemoved: prediction.improved ? 1 : 0,
          unauthorizedWrites: 0,
          unrecoveredUserChanges: 0,
          diagnosisVerifierPassed: true
        },
        evidence: { source: "test-harness" }
      };
    }
  };
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-candidate-audit",
    adapter: operationalAdapter,
    runner: operationalRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });

  const candidateId = result.candidate.candidateId;
  const audited = auditRun(result.runRoot, { workspace, candidate: candidateId });
  assert.deepEqual(audited.blockers, []);
  assert.equal(audited.data.rawDigest, result.rawDigest);
  assert.equal(audited.data.rawReference, ".wikiskill/raw/evolutions/operational-candidate-audit");
  assert.equal(audited.data.candidate.candidateId, candidateId);
  assert.equal(audited.data.candidate.runId, "operational-candidate-audit");
  assert.equal(audited.data.candidate.targetSkill, "target-skill");
  assert.equal(audited.data.candidate.resultDigest, result.candidate.resultDigest);
  assert.equal(audited.data.candidate.testScore.terminalSuccessCount, 1);
  assert.equal(audited.data.candidate.acceptedIterations.length, 1);
  assert.match(audited.warnings.join("\n"), /not an independent or unforgeable evaluation proof/u);

  const output = [];
  const code = await execute(["run", "audit", "--run-root", result.runRoot, "--workspace", workspace, "--candidate", candidateId, "--json"], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 0, output.join(""));
  const cliOutput = JSON.parse(output.join(""));
  assert.equal(cliOutput.data.schema, "wikiskill.run-audit.v1");
  assert.equal(cliOutput.data.candidate.candidateId, candidateId);
  assert.equal(cliOutput.data.rawDigest, result.rawDigest);

  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  await makeWritable(candidateRoot);
  const candidateManifestPath = path.join(candidateRoot, "candidate.json");
  const staged = JSON.parse(await fs.readFile(candidateManifestPath, "utf8"));

  await fs.writeFile(candidateManifestPath, `${JSON.stringify({ ...staged, runId: "operational-other-run" }, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Candidate run identity differs/u);

  await fs.writeFile(candidateManifestPath, `${JSON.stringify({ ...staged, testScore: { ...staged.testScore, terminalSuccessCount: staged.testScore.terminalSuccessCount + 1 } }, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Candidate test score differs/u);
  await fs.writeFile(candidateManifestPath, `${JSON.stringify(staged, null, 2)}\n`);

  const skillPath = path.join(candidateRoot, "skill", "SKILL.md");
  const skillText = await fs.readFile(skillPath, "utf8");
  await fs.writeFile(skillPath, `${skillText}\nTampered.\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Staged candidate Skill tree does not match/u);
  await fs.writeFile(skillPath, skillText);

  const forgedId = `candidate-${crypto.createHash("sha256").update("forged-candidate-identity").digest("hex").slice(0, 24)}`;
  const forgedRoot = path.join(workspace, ".wikiskill", "candidates", forgedId);
  await fs.mkdir(forgedRoot, { recursive: true });
  fsSync.cpSync(path.join(candidateRoot, "skill"), path.join(forgedRoot, "skill"), { recursive: true });
  await fs.writeFile(path.join(forgedRoot, "candidate.json"), `${JSON.stringify({ ...staged, candidateId: forgedId }, null, 2)}\n`);
  assert.deepEqual(auditRun(result.runRoot, { workspace, candidate: forgedId }).blockers, ["Candidate identity digest is invalid."]);

  await fs.writeFile(candidateManifestPath, `${JSON.stringify({ ...staged, baselineDigest: `sha256:${"0".repeat(64)}` }, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Candidate identity digest is invalid/u);
  await fs.writeFile(candidateManifestPath, `${JSON.stringify(staged, null, 2)}\n`);

  const authorityRawRoot = path.join(workspace, ".wikiskill", "raw", "evolutions", "operational-candidate-audit", "raw");
  await makeWritable(authorityRawRoot);
  const authorityTracePath = await firstFile(authorityRawRoot);
  const authorityTraceText = await fs.readFile(authorityTracePath, "utf8");
  const authorityTrace = JSON.parse(authorityTraceText);
  await fs.writeFile(authorityTracePath, JSON.stringify({ ...authorityTrace, prediction: { ...authorityTrace.prediction, improved: false } }));
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Persisted Raw authority tree content does not match/u);
  await fs.writeFile(authorityTracePath, authorityTraceText);

  const resultPath = path.join(result.runRoot, "result", "result.json");
  const resultJson = JSON.parse(await fs.readFile(resultPath, "utf8"));
  await fs.writeFile(resultPath, `${JSON.stringify({ ...resultJson, testScore: { ...resultJson.testScore, terminalSuccessCount: resultJson.testScore.terminalSuccessCount + 1 } }, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Run result scores differ from the terminal run state/u);
  await fs.writeFile(resultPath, `${JSON.stringify(resultJson, null, 2)}\n`);

  assert.deepEqual(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers, []);
});

test("run audit rejects a fabricated candidate for a held-out operational regression run", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const operationalRunner = async ({ task, skills }) => {
    const improved = skills.target["target-skill"]["SKILL.md"].includes("improved procedure");
    const regressedTest = task.split === "test" && improved;
    const verifiedMilestones = regressedTest ? ["M0"] : improved || task.split === "test" ? ["M0", "M1", "M2"] : ["M0", "M1"];
    return {
      prediction: { verifiedMilestones, terminalSuccess: verifiedMilestones.length === 3 },
      events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
    };
  };
  const operationalAdapter = {
    ...adapter,
    score: ({ prediction }) => ({
      score: {
        schema: "wikiskill.operational-outcome.v1",
        eligible: true,
        terminalSuccess: prediction.terminalSuccess,
        verifiedMilestones: prediction.verifiedMilestones,
        highestVerifiedMilestone: prediction.verifiedMilestones.length - 1,
        verifiedMilestoneCount: prediction.verifiedMilestones.length,
        actionableBlockersRemoved: 0,
        unauthorizedWrites: 0,
        unrecoveredUserChanges: 0,
        diagnosisVerifierPassed: true
      },
      evidence: { source: "test-harness" }
    })
  };
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-regression-audit",
    adapter: operationalAdapter,
    runner: operationalRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  assert.equal(result.candidate, null);
  assert.equal(result.state.candidateBlockedReason, "heldout_operational_regression");

  const { sortedFiles, treeDigest } = require("../src/evolution");
  const manifest = JSON.parse(await fs.readFile(path.join(result.runRoot, "manifest.json"), "utf8"));
  const targetSkill = "target-skill";
  const source = path.join(result.runRoot, "result", "skills", targetSkill);
  const snapshotRoot = path.join(result.runRoot, "skills", "snapshots", targetSkill);
  const workspaceOnly = new Set(manifest.workspaceOnlyFiles?.[targetSkill] || []);
  const baselineDigest = treeDigest(snapshotRoot, sortedFiles(snapshotRoot).filter((file) => !workspaceOnly.has(path.relative(snapshotRoot, file).split(path.sep).join("/"))));
  const resultDigest = treeDigest(source);
  const candidateId = `candidate-${crypto.createHash("sha256").update(`${targetSkill}\0${baselineDigest}\0${resultDigest}`).digest("hex").slice(0, 24)}`;
  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  await fs.mkdir(candidateRoot, { recursive: true });
  fsSync.cpSync(source, path.join(candidateRoot, "skill"), { recursive: true });
  await fs.writeFile(path.join(candidateRoot, "candidate.json"), `${JSON.stringify({
    schema: "wikiskill.candidate.v1",
    candidateId,
    targetSkill,
    status: "validation_accepted",
    baselineDigest,
    resultDigest,
    runId: "operational-regression-audit",
    baselineValidationScore: result.state.baselineValidationScore,
    candidateValidationScore: result.state.bestValidationScore,
    testScore: result.state.testScore,
    acceptedIterations: result.state.acceptedIterations,
    configDigest: manifest.configDigest,
    frozenComponents: manifest.frozenComponents
  }, null, 2)}\n`);

  const audited = auditRun(result.runRoot, { workspace, candidate: candidateId });
  assert.deepEqual(audited.blockers, ["Candidate run has a held-out operational regression and must not be published."]);
  assert.equal(audited.data.candidate.candidateId, candidateId);
});

const operationalAdapterFor = () => ({
  ...adapter,
  score: ({ prediction }) => {
    const verifiedMilestones = prediction.improved ? ["M0", "M1", "M2"] : ["M0", "M1"];
    return {
      score: {
        schema: "wikiskill.operational-outcome.v1",
        eligible: true,
        terminalSuccess: prediction.improved,
        verifiedMilestones,
        highestVerifiedMilestone: verifiedMilestones.length - 1,
        verifiedMilestoneCount: verifiedMilestones.length,
        actionableBlockersRemoved: prediction.improved ? 1 : 0,
        unauthorizedWrites: 0,
        unrecoveredUserChanges: 0,
        diagnosisVerifierPassed: true
      },
      evidence: { source: "test-harness" }
    };
  }
});

test("run audit accepts an empty-mode operational candidate by its uniquely declared new Skill", async () => {
  const { workspace, stateRoot, datasetPath } = await setupEmpty();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const emptyRunner = async ({ task, skills }) => ({
    prediction: { improved: Boolean(skills.target["target-skill"]?.["SKILL.md"]?.includes("improved procedure")) },
    events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
  });
  const createProposer = async ({ availableTraces, readTrace, allowedNewSkillIds }) => {
    const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
    traceReads.forEach(readTrace);
    return {
      action: "create",
      skillId: allowedNewSkillIds[0],
      traceReads,
      files: {
        "SKILL.md": "---\nname: target-skill\ndescription: Handle target tasks.\n---\n\nUse the improved procedure.\n",
        "PURPOSE.md": "# Purpose\n\n- Supporting pattern: procedure.md\n"
      }
    };
  };
  const result = await evolveWorkspace(workspace, "target-skill", {
    empty: true,
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "empty-operational-candidate-audit",
    adapter: operationalAdapterFor(),
    runner: emptyRunner,
    maintainer,
    proposer: createProposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  assert.equal(result.candidate.baselineDigest, null);
  const candidateId = result.candidate.candidateId;
  const audited = auditRun(result.runRoot, { workspace, candidate: candidateId });
  assert.deepEqual(audited.blockers, []);
  assert.equal(audited.data.candidate.targetSkill, "target-skill");
  assert.equal(audited.data.candidate.baselineDigest, null);
  assert.deepEqual(audited.data.candidate.acceptedIterations, [1]);
  assert.equal(audited.data.candidate.testScore.verifiedMilestoneCount, 3);
  assert.match(audited.warnings.join("\n"), /not an independent or unforgeable evaluation proof/u);

  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  await makeWritable(candidateRoot);
  const candidateManifestPath = path.join(candidateRoot, "candidate.json");
  const staged = JSON.parse(await fs.readFile(candidateManifestPath, "utf8"));
  await fs.writeFile(candidateManifestPath, `${JSON.stringify({ ...staged, targetSkill: "undeclared-skill" }, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Candidate target Skill is not declared by the audited run manifest/u);
  await fs.writeFile(candidateManifestPath, `${JSON.stringify({ ...staged, baselineDigest: staged.resultDigest }, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers.join("\n"), /Candidate baseline digest must be absent for an empty-mode run/u);
  await fs.writeFile(candidateManifestPath, `${JSON.stringify(staged, null, 2)}\n`);
  assert.deepEqual(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers, []);
});

test("run audit rejects a dual-tree candidate forgery with a recomputed identity", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const operationalRunner = async ({ task, skills }) => ({
    prediction: { improved: skills.target["target-skill"]["SKILL.md"].includes("improved procedure") },
    events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
  });
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-dual-tree-forgery",
    adapter: operationalAdapterFor(),
    runner: operationalRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  const candidateId = result.candidate.candidateId;
  assert.deepEqual(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers, []);

  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  const staged = JSON.parse(await fs.readFile(path.join(candidateRoot, "candidate.json"), "utf8"));
  const resultTree = path.join(result.runRoot, "result", "skills", "target-skill");
  await fs.writeFile(path.join(resultTree, "SKILL.md"), "---\nname: target-skill\ndescription: Forged.\n---\n\nForged procedure.\n");
  const forgedDigest = treeDigest(resultTree);
  const forgedId = `candidate-${crypto.createHash("sha256").update(`target-skill\0${staged.baselineDigest}\0${forgedDigest}`).digest("hex").slice(0, 24)}`;
  const forgedRoot = path.join(workspace, ".wikiskill", "candidates", forgedId);
  await fs.mkdir(forgedRoot, { recursive: true });
  fsSync.cpSync(resultTree, path.join(forgedRoot, "skill"), { recursive: true });
  await fs.writeFile(path.join(forgedRoot, "candidate.json"), `${JSON.stringify({ ...staged, candidateId: forgedId, resultDigest: forgedDigest }, null, 2)}\n`);
  const blockers = auditRun(result.runRoot, { workspace, candidate: forgedId }).blockers.join("\n");
  assert.equal(blockers.includes("Candidate identity digest is invalid."), false);
  assert.match(blockers, /Run apply manifest entry target-skill final files differ from the run result Skill tree/u);
  assert.match(blockers, /final test trajectory Skill set differs from the run result Skill trees/u);
  assert.match(blockers, /Staged candidate Skill files differ from the run apply manifest entry/u);
  assert.match(blockers, /Run result patches do not match the run Skill trees/u);
});

const ATTACK_SEMANTIC_KEYS = ["engine", "configDigest", "dataset", "adapterDigest", "runnerDigest", "modelDigest", "proposalHistory", "baselineValidationScore", "finalValidationScore", "testScore", "acceptedIterations", "earlyStopped", "earlyStopReason", "changesPatchDigest", "reversePatchDigest"];
const attackHex = (value) => crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const attackCanonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const attackPatch = (runRoot, entries, reverse) => {
  const blocks = [];
  for (const entry of entries) {
    const baselineRoot = path.join(runRoot, "skills", "snapshots", entry.skillId);
    const finalRoot = path.join(runRoot, "result", "skills", entry.skillId);
    const files = new Set([...Object.keys(entry.baselineFiles), ...Object.keys(entry.finalFiles)]);
    for (const file of [...files].sort()) {
      const before = entry.operation === "create" ? "" : fsSync.existsSync(path.join(baselineRoot, file)) ? fsSync.readFileSync(path.join(baselineRoot, file), "utf8") : "";
      const after = fsSync.existsSync(path.join(finalRoot, file)) ? fsSync.readFileSync(path.join(finalRoot, file), "utf8") : "";
      if (before === after) continue;
      const target = `${entry.sourcePath}/${file}`;
      const from = reverse ? after : before;
      const to = reverse ? before : after;
      const removed = from.split("\n").map((line) => line ? `-${line}` : "-").join("\n");
      const added = to.split("\n").map((line) => line ? `+${line}` : "+").join("\n");
      blocks.push(`diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n@@\n${removed}\n${added}\n`);
    }
  }
  return blocks.join("");
};

test("run audit stays fail-closed when a forged bundle recomputes every internal digest", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const operationalRunner = async ({ task, skills }) => ({
    prediction: { improved: skills.target["target-skill"]["SKILL.md"].includes("improved procedure") },
    events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
  });
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-fail-closed-entries",
    adapter: operationalAdapterFor(),
    runner: operationalRunner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    iterationLimit: 1
  });
  const runRoot = result.runRoot;
  const originalCandidateId = result.candidate.candidateId;
  assert.deepEqual(auditRun(runRoot, { workspace, candidate: originalCandidateId }).blockers, []);

  // Attacker forges both Skill trees, every bundle digest, both patches, and the candidate identity.
  const staged = JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill", "candidates", originalCandidateId, "candidate.json"), "utf8"));
  const forgedSkill = "---\nname: target-skill\ndescription: Forged.\n---\n\nForged procedure.\n";
  const forgedTree = path.join(runRoot, "result", "skills", "target-skill");
  await fs.writeFile(path.join(forgedTree, "SKILL.md"), forgedSkill);
  const forgedResultDigest = treeDigest(forgedTree);
  const forgedCandidateId = `candidate-${crypto.createHash("sha256").update(`target-skill\0${staged.baselineDigest}\0${forgedResultDigest}`).digest("hex").slice(0, 24)}`;
  const forgedCandidateRoot = path.join(workspace, ".wikiskill", "candidates", forgedCandidateId);
  await fs.mkdir(forgedCandidateRoot, { recursive: true });
  fsSync.cpSync(forgedTree, path.join(forgedCandidateRoot, "skill"), { recursive: true });
  await fs.writeFile(path.join(forgedCandidateRoot, "candidate.json"), attackCanonical({ ...staged, candidateId: forgedCandidateId, resultDigest: forgedResultDigest }));

  const originalBundle = JSON.parse(await fs.readFile(path.join(runRoot, "result", "apply-manifest.json"), "utf8"));
  const originalResult = JSON.parse(await fs.readFile(path.join(runRoot, "result", "result.json"), "utf8"));
  const forgedEntry = { ...originalBundle.entries[0], finalFiles: { "SKILL.md": attackHex(forgedSkill) }, files: ["SKILL.md"] };
  const rewriteArtifacts = async (bundle) => {
    const entries = Array.isArray(bundle.entries) ? bundle.entries : [];
    const changesPatch = attackPatch(runRoot, entries.filter((entry) => entry && typeof entry === "object" && typeof entry.skillId === "string"), false);
    const reversePatch = attackPatch(runRoot, entries.filter((entry) => entry && typeof entry === "object" && typeof entry.skillId === "string"), true);
    await fs.writeFile(path.join(runRoot, "result", "changes.patch"), changesPatch);
    await fs.writeFile(path.join(runRoot, "result", "reverse.patch"), reversePatch);
    const sealedBundle = { ...bundle, changesPatchDigest: attackHex(changesPatch), reversePatchDigest: attackHex(reversePatch) };
    await fs.writeFile(path.join(runRoot, "result", "apply-manifest.json"), attackCanonical(sealedBundle));
    const semantic = {};
    const sealedResult = { ...originalResult, changesPatchDigest: sealedBundle.changesPatchDigest, reversePatchDigest: sealedBundle.reversePatchDigest, applyManifestDigest: attackHex(attackCanonical(sealedBundle)) };
    for (const key of ATTACK_SEMANTIC_KEYS) if (key in sealedResult) semantic[key] = sealedResult[key];
    sealedResult.semanticResultDigest = attackHex(attackCanonical(semantic));
    await fs.writeFile(path.join(runRoot, "result", "result.json"), attackCanonical(sealedResult));
    return sealedBundle;
  };

  // A fully consistent forgery without any extra entry is still pinned to the Raw authority by the trajectory Skill sets.
  await rewriteArtifacts({ ...originalBundle, entries: [forgedEntry] });
  const consistentBlockers = auditRun(runRoot, { workspace, candidate: forgedCandidateId }).blockers;
  assert.equal(consistentBlockers.length, 1);
  assert.match(consistentBlockers.join("\n"), /final test trajectory Skill set differs from the run result Skill trees/u);

  // The published proposal history must mirror the terminal state minus proposalPath, even under a recomputed semantic digest.
  const historyTampered = JSON.parse(await fs.readFile(path.join(runRoot, "result", "result.json"), "utf8"));
  historyTampered.proposalHistory = (historyTampered.proposalHistory || []).map((entry) => ({ proposalPath: "runs/proposals/iter-01-attempt-01.json", ...entry }));
  const tamperedSemantic = {};
  for (const key of ATTACK_SEMANTIC_KEYS) if (key in historyTampered) tamperedSemantic[key] = historyTampered[key];
  historyTampered.semanticResultDigest = attackHex(attackCanonical(tamperedSemantic));
  await fs.writeFile(path.join(runRoot, "result", "result.json"), attackCanonical(historyTampered));
  assert.match(auditRun(runRoot, { workspace, candidate: forgedCandidateId }).blockers.join("\n"), /Run result proposal history differs from the terminal run state/u);

  const invalidEntryVariants = [
    ["a non-object entry", "not-an-entry", /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["an unsafe Skill id", { skillId: "../escape", operation: "update", sourcePath: "skills/ghost", baselineFiles: {}, finalFiles: {}, files: [], deletedFiles: [] }, /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["an unknown operation", { skillId: "ghost-skill", operation: "delete", sourcePath: "skills/ghost", baselineFiles: {}, finalFiles: {}, files: [], deletedFiles: [] }, /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["a non-digest file map", { skillId: "ghost-skill", operation: "update", sourcePath: "skills/ghost", baselineFiles: {}, finalFiles: { "SKILL.md": "not-a-digest" }, files: [], deletedFiles: [] }, /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["an escaping file key", { skillId: "ghost-skill", operation: "update", sourcePath: "skills/ghost", baselineFiles: {}, finalFiles: { "../evil.md": "a".repeat(64) }, files: [], deletedFiles: [] }, /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["an absolute source path", { skillId: "ghost-skill", operation: "update", sourcePath: "/etc/cron.d", baselineFiles: {}, finalFiles: {}, files: [], deletedFiles: [] }, /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["a non-array change list", { skillId: "ghost-skill", operation: "update", sourcePath: "skills/ghost", baselineFiles: {}, finalFiles: {}, files: "SKILL.md", deletedFiles: [] }, /Run apply manifest entry 1 does not declare a valid Skill change/u],
    ["a valid but undeclared entry", { skillId: "ghost-skill", operation: "create", sourcePath: ".wikiskill/skills/ghost-skill", baselineFiles: {}, finalFiles: {}, files: [], deletedFiles: [] }, /Run apply manifest entries do not match the declared target and created Skills/u]
  ];
  for (const [label, extraEntry, expected] of invalidEntryVariants) {
    const sealed = await rewriteArtifacts({ ...originalBundle, entries: [forgedEntry, extraEntry] });
    assert.equal(Array.isArray(sealed.entries), true);
    const blockers = auditRun(runRoot, { workspace, candidate: forgedCandidateId }).blockers;
    assert.equal(blockers.length === 0, false, `invalid extra entry (${label}) must not reach zero blockers`);
    assert.match(blockers.join("\n"), expected);
    assert.match(blockers.join("\n"), /final test trajectory Skill set differs from the run result Skill trees/u);
  }

  const nonArray = await rewriteArtifacts({ ...originalBundle, entries: { 0: forgedEntry } });
  assert.equal(Array.isArray(nonArray.entries), false);
  const nonArrayBlockers = auditRun(runRoot, { workspace, candidate: forgedCandidateId }).blockers;
  assert.equal(nonArrayBlockers.length === 0, false);
  assert.match(nonArrayBlockers.join("\n"), /Run apply manifest entries must be an array/u);
  assert.match(nonArrayBlockers.join("\n"), /Run apply manifest entries do not match the declared target and created Skills/u);
});

test("run audit accepts a genuine multi-Skill bundle with projection and creation", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-multi-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await fs.mkdir(path.join(repo, ".agents", "skills", "one"), { recursive: true });
  await fs.writeFile(path.join(repo, ".agents", "skills", "one", "SKILL.md"), "# One\nUse the old procedure.\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=WikiSkill", "-c", "user.email=wikiskill@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-multi-state-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-multi-workspace-"));
  const runId = "multi-skill-projection";
  const manifest = await createRun({
    repo,
    skillRoots: [".agents/skills"],
    targetSkills: ["one"],
    projectedSkills: [{ id: "proj-skill", destination: ".agents/skills/proj-skill", mode: "target", files: {
      "SKILL.md": "---\nname: proj-skill\ndescription: Projected helper.\n---\n\nProjected procedure.\n",
      "PURPOSE.md": "# Purpose\n\n- Projected at run creation.\n"
    } }],
    newSkillRoot: ".agents/skills",
    newSkillIds: ["born-skill"],
    dataset: { schema: "wikiskill.dataset.v1", tasks: tasks().map((task) => ({ ...task, evaluator: { capabilityRef: "adapter:test" } })) },
    stateRoot,
    runId,
    iterationLimit: 2,
    rawReferencePrefix: `.wikiskill/raw/evolutions/${runId}`
  });
  const milestoneAdapter = {
    ...adapter,
    score: ({ prediction }) => {
      const verifiedMilestones = prediction.verifiedMilestones;
      return {
        score: {
          schema: "wikiskill.operational-outcome.v1",
          eligible: true,
          terminalSuccess: verifiedMilestones.length === 3,
          verifiedMilestones,
          highestVerifiedMilestone: verifiedMilestones.length - 1,
          verifiedMilestoneCount: verifiedMilestones.length,
          actionableBlockersRemoved: 0,
          unauthorizedWrites: 0,
          unrecoveredUserChanges: 0,
          diagnosisVerifierPassed: true
        },
        evidence: { source: "test-harness" }
      };
    }
  };
  const multiRunner = async ({ task, skills }) => {
    const patched = Boolean(skills.target.one?.["SKILL.md"]?.includes("improved procedure"));
    const born = Boolean(skills.target["born-skill"]);
    const verifiedMilestones = born ? ["M0", "M1", "M2"] : patched ? ["M0", "M1"] : ["M0"];
    return {
      prediction: { verifiedMilestones, terminalSuccess: verifiedMilestones.length === 3 },
      events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
    };
  };
  const multiProposer = async ({ iteration, availableTraces, readTrace }) => {
    const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
    traceReads.forEach(readTrace);
    if (iteration === 1) return { action: "patch", skillId: "one", traceReads, files: { "SKILL.md": "# One\nUse the improved procedure.\n" } };
    return { action: "create", skillId: "born-skill", traceReads, files: {
      "SKILL.md": "---\nname: born-skill\ndescription: Born helper.\n---\n\nBorn procedure.\n",
      "PURPOSE.md": "# Purpose\n\n- Created by an accepted proposal.\n"
    } };
  };
  await runEvolution(manifest.runRoot, { adapter: milestoneAdapter, runner: multiRunner, maintainer, proposer: multiProposer });

  const runRoot = manifest.runRoot;
  const state = JSON.parse(await fs.readFile(path.join(runRoot, "runs", "state.json"), "utf8"));
  assert.deepEqual(state.acceptedIterations, [1, 2]);
  assert.deepEqual((state.createdSkills || []).map((created) => created.id), ["born-skill"]);
  const bundle = JSON.parse(await fs.readFile(path.join(runRoot, "result", "apply-manifest.json"), "utf8"));
  assert.deepEqual(bundle.entries.map((entry) => [entry.skillId, entry.operation, entry.sourcePath]), [
    ["one", "update", ".agents/skills/one"],
    ["proj-skill", "create", ".agents/skills/proj-skill"],
    ["born-skill", "create", ".agents/skills/born-skill"]
  ]);

  const authorityRoot = path.join(workspace, ".wikiskill", "raw", "evolutions", runId);
  await fs.mkdir(authorityRoot, { recursive: true });
  fsSync.cpSync(path.join(runRoot, "raw"), path.join(authorityRoot, "raw"), { recursive: true });
  const rawDigest = treeDigest(path.join(authorityRoot, "raw"));
  await fs.writeFile(path.join(authorityRoot, "manifest.json"), attackCanonical({ schema: "wikiskill.evolution-raw.v1", runId, rawDigest }));
  await fs.writeFile(path.join(runRoot, "result", "raw-authority.json"), attackCanonical({ schema: "wikiskill.raw-authority-receipt.v1", runId, rawRef: `.wikiskill/raw/evolutions/${runId}`, rawDigest }));

  const targetTree = path.join(runRoot, "result", "skills", "one");
  const resultDigest = treeDigest(targetTree);
  const baselineDigest = treeDigest(path.join(repo, ".agents", "skills", "one"));
  const candidateId = `candidate-${crypto.createHash("sha256").update(`one\0${baselineDigest}\0${resultDigest}`).digest("hex").slice(0, 24)}`;
  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  await fs.mkdir(candidateRoot, { recursive: true });
  fsSync.cpSync(targetTree, path.join(candidateRoot, "skill"), { recursive: true });
  await fs.writeFile(path.join(candidateRoot, "candidate.json"), attackCanonical({
    schema: "wikiskill.candidate.v1",
    candidateId,
    targetSkill: "one",
    status: "validation_accepted",
    baselineDigest,
    resultDigest,
    runId,
    baselineValidationScore: state.baselineValidationScore,
    candidateValidationScore: state.bestValidationScore,
    testScore: state.testScore,
    acceptedIterations: state.acceptedIterations,
    configDigest: manifest.configDigest,
    frozenComponents: manifest.frozenComponents
  }));
  const audited = auditRun(runRoot, { workspace, candidate: candidateId });
  assert.deepEqual(audited.blockers, []);
  assert.equal(audited.data.candidate.targetSkill, "one");
  assert.deepEqual(audited.data.candidate.acceptedIterations, [1, 2]);
});

test("run audit derives accepted iterations from the raw-verified proposal history", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const milestoneRunner = async ({ task, skills }) => ({
    prediction: { improved: skills.target["target-skill"]["SKILL.md"].includes("improved procedure") },
    events: [{ type: "observation", text: task.id }, { type: "assistant", text: "done" }]
  });
  const milestoneAdapter = {
    ...adapter,
    score: ({ prediction }) => {
      const verifiedMilestones = prediction.improved ? ["M0", "M1"] : ["M0"];
      return {
        score: {
          schema: "wikiskill.operational-outcome.v1",
          eligible: true,
          terminalSuccess: false,
          verifiedMilestones,
          highestVerifiedMilestone: verifiedMilestones.length - 1,
          verifiedMilestoneCount: verifiedMilestones.length,
          actionableBlockersRemoved: prediction.improved ? 1 : 0,
          unauthorizedWrites: 0,
          unrecoveredUserChanges: 0,
          diagnosisVerifierPassed: true
        },
        evidence: { source: "test-harness" }
      };
    }
  };
  const twoIterationProposer = async ({ iteration, availableTraces, readTrace }) => {
    const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
    traceReads.forEach(readTrace);
    const body = iteration === 1
      ? "---\nname: target-skill\ndescription: Handle target tasks.\n---\n\nUse the improved procedure.\n"
      : "---\nname: target-skill\ndescription: Handle target tasks.\n---\n\nUse the improved procedure.\n\nCosmetic note.\n";
    return { action: "patch", skillId: "target-skill", traceReads, files: { "SKILL.md": body } };
  };
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-history-derivation",
    adapter: milestoneAdapter,
    runner: milestoneRunner,
    maintainer,
    proposer: twoIterationProposer,
    model: { id: "test-model" },
    iterationLimit: 2
  });
  assert.deepEqual(result.state.acceptedIterations, [1]);
  assert.equal(result.state.proposalHistory.length, 2);
  assert.equal(result.state.proposalHistory[1].accepted, false);
  const candidateId = result.candidate.candidateId;
  assert.deepEqual(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers, []);

  const hex = (value) => crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
  const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const semanticKeys = ["engine", "configDigest", "dataset", "adapterDigest", "runnerDigest", "modelDigest", "proposalHistory", "baselineValidationScore", "finalValidationScore", "testScore", "acceptedIterations", "earlyStopped", "earlyStopReason", "changesPatchDigest", "reversePatchDigest"];
  const statePath = path.join(result.runRoot, "runs", "state.json");
  const stateJson = JSON.parse(await fs.readFile(statePath, "utf8"));
  await fs.writeFile(statePath, `${JSON.stringify({ ...stateJson, acceptedIterations: [1, 2] }, null, 2)}\n`);
  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  await makeWritable(candidateRoot);
  const candidateManifestPath = path.join(candidateRoot, "candidate.json");
  await fs.writeFile(candidateManifestPath, `${JSON.stringify({ ...JSON.parse(await fs.readFile(candidateManifestPath, "utf8")), acceptedIterations: [1, 2] }, null, 2)}\n`);
  const resultPath = path.join(result.runRoot, "result", "result.json");
  const bundlePath = path.join(result.runRoot, "result", "apply-manifest.json");
  const tamperedResult = { ...JSON.parse(await fs.readFile(resultPath, "utf8")), acceptedIterations: [1, 2] };
  const tamperedBundle = { ...JSON.parse(await fs.readFile(bundlePath, "utf8")), acceptedIterations: [1, 2] };
  tamperedResult.applyManifestDigest = hex(canonical(tamperedBundle));
  const semantic = {};
  for (const key of semanticKeys) if (key in tamperedResult) semantic[key] = tamperedResult[key];
  tamperedResult.semanticResultDigest = hex(canonical(semantic));
  await fs.writeFile(resultPath, `${JSON.stringify(tamperedResult, null, 2)}\n`);
  await fs.writeFile(bundlePath, `${JSON.stringify(tamperedBundle, null, 2)}\n`);
  assert.deepEqual(auditRun(result.runRoot, { workspace, candidate: candidateId }).blockers, ["Run state accepted iterations do not match the accepted proposal history."]);
});

test("terminal operational baseline reports dataset saturation without learning", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const terminalAdapter = {
    ...adapter,
    score: () => ({
      score: {
        schema: "wikiskill.operational-outcome.v1",
        eligible: true,
        terminalSuccess: true,
        verifiedMilestones: ["M0"],
        highestVerifiedMilestone: 0,
        verifiedMilestoneCount: 1,
        actionableBlockersRemoved: 0,
        unauthorizedWrites: 0,
        unrecoveredUserChanges: 0,
        diagnosisVerifierPassed: true
      }
    })
  };
  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-dataset-saturated",
    adapter: terminalAdapter,
    runner,
    maintainer: async () => { throw new Error("dataset saturation must skip Maintainer"); },
    proposer: async () => { throw new Error("dataset saturation must skip Proposer"); },
    model: { id: "test-model" },
    iterationLimit: 1
  });
  assert.equal(result.state.earlyStopped, true);
  assert.equal(result.state.earlyStopReason, "dataset_saturated");
  assert.deepEqual(result.state.acceptedIterations, []);
  assert.equal(result.candidate, null);
});

test("ineligible operational validation is retained as Raw evidence before blocking", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  for (const task of dataset.tasks) task.evaluator.capabilityRef = "scorer:operational-test";
  await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  const ineligibleAdapter = {
    ...adapter,
    score: () => ({
      score: {
        schema: "wikiskill.operational-outcome.v1",
        eligible: false,
        terminalSuccess: false,
        verifiedMilestones: [],
        highestVerifiedMilestone: -1,
        verifiedMilestoneCount: 0,
        actionableBlockersRemoved: 0,
        unauthorizedWrites: 1,
        unrecoveredUserChanges: 0,
        diagnosisVerifierPassed: false
      },
      evidence: { disallowedPaths: ["user-file"] }
    })
  };
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:operational-test",
    stateRoot,
    runId: "operational-ineligible",
    adapter: ineligibleAdapter,
    runner,
    maintainer: async () => { throw new Error("ineligible trace must not reach Maintainer"); },
    proposer: async () => { throw new Error("ineligible trace must not reach Proposer"); },
    model: { id: "test-model" },
    iterationLimit: 1
  }), /ineligible operational validation/u);
  const rawTrace = path.join(workspace, ".wikiskill", "raw", "evolutions", "operational-ineligible", "raw", "traces", "iter-00", "val", "validation.json");
  assert.equal(await fs.access(rawTrace).then(() => true, () => false), true);
  assert.equal(JSON.parse(await fs.readFile(rawTrace, "utf8")).score.eligible, false);
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
  assert.equal(runtimeEvidence.schema, "wikiskill.runtime-evidence.v2");
  assert.equal(runtimeEvidence.inference.length, inferenceIndex);
  assert.equal(new Set(runtimeEvidence.inference.map((item) => item.provider.sessionId)).size, inferenceIndex);
  assert.deepEqual(new Set(runtimeEvidence.inference.map((item) => item.phase)), new Set(["baseline_validation", "training", "candidate_validation", "baseline_test", "final_test"]));
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
    return {action: skills.target["target-skill"] ? "patch" : "create", skillId, traceReads, files: {"SKILL.md": "---\\nname: target-skill\\ndescription: Handle target tasks.\\n---\\n\\nUse the improved procedure.\\n", "PURPOSE.md": "# Purpose\\n\\n- Supporting pattern: cli.md\\n"}};
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
  await configureEvolution(workspace, { ...await writeModules(workspace), iterationLimit: 4 });
  const prepared = [];
  const prepareCode = await execute([
    "experiment", "prepare",
    "--workspace", workspace,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--scorer", "scorer:test",
    "--json"
  ], { stdout: (line) => prepared.push(line), stderr: () => {} });
  assert.equal(prepareCode, 0, prepared.join(""));
  const experimentPath = path.join(workspace, "experiment.json");
  await fs.writeFile(experimentPath, prepared.join(""));
  const output = [];
  const code = await execute([
    "evolve", "--experiment", experimentPath,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--tool-profile", "none",
    "--iterations", "4",
    "--max-provider-launches", "100",
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
  assert.deepEqual(baseline.activeSkills.map((skill) => skill.id), ["target-skill"]);
  assert.match(baseline.activeSkills[0].bundleDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(baseline.activeSkillSetDigest, /^sha256:[0-9a-f]{64}$/u);
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
    "--expected-active-skill-set-digest", baseline.activeSkillSetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
    "--state-root", stateRoot,
    "--run-id", "missing-prepared-digest",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /requires --expected-dataset-digest/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public CLI requires the prepared active Skill-set digest", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const baseline = await baselineFor(workspace, "target-skill");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", await digestForDataset(datasetPath),
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
    "--state-root", stateRoot,
    "--run-id", "missing-active-skill-set-digest",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /requires --expected-active-skill-set-digest/u);
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
    "--expected-active-skill-set-digest", baseline.activeSkillSetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
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
    "--expected-active-skill-set-digest", baseline.activeSkillSetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
    "--state-root", stateRoot,
    "--run-id", "target-skill-drift",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /Target Skill digest differs from the prepared baseline/u);
  assert.equal(await fs.access(path.join(stateRoot, "workspaces")).then(() => true, () => false), false);
});

test("public CLI rejects context Skill drift from the prepared baseline", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const contextRoot = path.join(workspace, ".wikiskill", "skills", "context-helper");
  await fs.mkdir(contextRoot);
  await fs.writeFile(path.join(contextRoot, "SKILL.md"), "---\nname: context-helper\ndescription: Supply context.\n---\n\nInitial context.\n");
  const baseline = await baselineFor(workspace, "target-skill");
  await fs.appendFile(path.join(contextRoot, "SKILL.md"), "\nUnreviewed drift.\n");
  const output = [];
  const code = await execute([
    "evolve", "--workspace", workspace,
    "--expected-workspace-id", baseline.workspaceId,
    "--target", "target-skill",
    "--dataset", datasetPath,
    "--expected-dataset-digest", await digestForDataset(datasetPath),
    "--expected-target-skill-digest", baseline.targetSkillDigest,
    "--expected-active-skill-set-digest", baseline.activeSkillSetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
    "--state-root", stateRoot,
    "--run-id", "context-skill-drift",
    "--json-events"
  ], { stdout: (line) => output.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(output.join(""), /Active Skill set differs from the prepared baseline/u);
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
    "--expected-active-skill-set-digest", baseline.activeSkillSetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
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
    expectedActiveSkillSetDigest: baseline.activeSkillSetDigest,
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

test("rechecks the actual frozen context Skill snapshot after initial baseline validation", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const contextRoot = path.join(workspace, ".wikiskill", "skills", "context-helper");
  await fs.mkdir(contextRoot);
  await fs.writeFile(path.join(contextRoot, "SKILL.md"), "---\nname: context-helper\ndescription: Supply context.\n---\n\nInitial context.\n");
  const baseline = await baselineFor(workspace, "target-skill");
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    expectedDatasetDigest: await digestForDataset(datasetPath),
    expectedWorkspaceId: baseline.workspaceId,
    expectedTargetSkillDigest: baseline.targetSkillDigest,
    expectedActiveSkillSetDigest: baseline.activeSkillSetDigest,
    expectedWikiDigest: baseline.wikiDigest,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "scorer:test",
    stateRoot,
    runId: "frozen-context-skill-drift",
    adapter,
    runner,
    maintainer,
    proposer,
    model: { id: "test-model" },
    onEvent: (event) => {
      if (event.type === "evolution.dataset-selected") fsSync.appendFileSync(path.join(contextRoot, "SKILL.md"), "\nConcurrent drift.\n");
    }
  }), /Frozen active Skill set differs from the prepared baseline/u);
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
    expectedActiveSkillSetDigest: baseline.activeSkillSetDigest,
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
    "--expected-active-skill-set-digest", baseline.activeSkillSetDigest,
    "--expected-wiki-digest", baseline.wikiDigest,
    "--provider", "claude",
    "--model", "test-model",
    "--reasoning-effort", "low",
    "--scorer", "scorer:test",
    "--tool-profile", "none",
    "--iterations", "1",
    "--max-provider-launches", "100",
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
  assert.deepEqual(diff.data.changedPaths, [".wikiskill/skills/target-skill/PURPOSE.md", ".wikiskill/skills/target-skill/SKILL.md"]);
  const applied = await invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidate.candidateId, "--json"]);
  assert.equal(applied.data.receipt.created, true);
  assert.match(await fs.readFile(path.join(workspace, ".wikiskill/skills/target-skill/SKILL.md"), "utf8"), /improved procedure/u);
  assert.match(await fs.readFile(path.join(workspace, ".wikiskill/skills/target-skill/PURPOSE.md"), "utf8"), /Supporting pattern/u);
  const rolledBack = await invoke(["rollback", "--workspace", workspace, "--receipt", applied.data.receipt.receiptId, "--json"]);
  assert.equal(rolledBack.data.removedCreatedSkill, true);
  assert.equal(await fs.access(path.join(workspace, ".wikiskill/skills/target-skill")).then(() => true, () => false), false);
});

test("explicit dataset resolves runner, scorer, and learning roles from the runtime registry", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  const registry = createCapabilityRegistry();
  let runnerConfig;
  registry.registerRunner({ ref: "provider:claude", apiVersion: "wikiskill.runner.v1", implementationVersion: "test", implementationDigest: `sha256:${"a".repeat(64)}` }, (config) => {
    runnerConfig = config;
    return runner;
  });
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
    iterationLimit: 1,
    runnerTimeoutMs: "1200000"
  });
  assert.equal(result.state.bestValidationScore, 1);
  assert.equal(result.candidate.runtime.runnerRef, "provider:claude");
  assert.equal(result.candidate.runtime.scorerRef, "scorer:test");
  assert.equal(runnerConfig.timeoutMs, 1_200_000);
  const runtimeEvidence = JSON.parse(await fs.readFile(path.join(result.runRoot, "result", "runtime-evidence.json"), "utf8"));
  assert.deepEqual(runtimeEvidence.cohort, { provider: "claude", modelId: "test-model", reasoningEffort: "unspecified", scorerRef: "scorer:test", toolProfile: "none" });
});

test("rejects a tool profile that conflicts with a built-in scorer", async () => {
  const { workspace, stateRoot, datasetPath } = await setup();
  await assert.rejects(evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    reasoningEffort: "low",
    scorerRef: "builtin:exact-output-v1",
    toolProfile: "workspace",
    maxProviderLaunches: 24,
    stateRoot,
    runId: "tool-profile-mismatch"
  }), /exact-output-v1 requires the none tool profile/u);
});

test("evolution requires an explicit dataset", async () => {
  const { workspace, stateRoot } = await setup();
  await assert.rejects(evolveWorkspace(workspace, "target-skill", { stateRoot }), /requires --dataset/u);
});

for (const limit of [9, 2]) {
  test(`starts below the worst-case estimate and accounts for actual launches with budget ${limit}`, async (t) => {
    const { workspace, stateRoot, datasetPath } = await setup();
    t.after(async () => {
      // 仅解封本测试生成的临时 Raw 归档，便于清理只读目录。
      require("node:child_process").execFileSync("chmod", ["-R", "u+w", workspace]);
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(stateRoot, { recursive: true, force: true });
    });
    const registry = createCapabilityRegistry();
    let launched = 0;
    registry.registerRunner({ ref: "provider:codex", apiVersion: "wikiskill.runner.v1", implementationVersion: "test", implementationDigest: `sha256:${"a".repeat(64)}` }, (config) => async ({ launchRef }) => {
      config.providerLaunchBudget.consume({ launchRef, role: "inference", provider: "codex", modelId: "test-model", reasoningEffort: "low", executable: "fixture", args: ["exec", "--ephemeral"] });
      launched += 1;
      return { prediction: { value: "improved" }, events: [{ type: "assistant", text: "fixture answer" }], provider: { ref: "provider:codex", modelId: "test-model", sessionId: `session-${launched}` } };
    });
    registry.registerScorer({ ref: "scorer:test", apiVersion: "wikiskill.scorer.v1", implementationVersion: "test", implementationDigest: `sha256:${"b".repeat(64)}` }, () => async () => ({ score: 1 }));
    registry.seal();
    const events = [];
    const runId = `actual-launch-budget-${limit}`;
    const run = evolveWorkspace(workspace, "target-skill", {
      datasetPath, provider: "codex", modelId: "test-model", reasoningEffort: "low", scorerRef: "scorer:test",
      maxProviderLaunches: limit, stateRoot, runId, capabilityRegistry: registry, iterationLimit: 4,
      maintainer: async () => { throw new Error("perfect baseline must skip learning"); },
      proposer: async () => { throw new Error("perfect baseline must skip learning"); },
      onEvent: (event) => events.push(event)
    });
    if (limit === 9) {
      const result = await run;
      assert.equal(result.state.status, "completed");
      assert.equal(result.state.earlyStopReason, "validation_score_perfect");
      assert.equal(result.state.testGain, 0);
      assert.equal(result.candidate, null);
    } else {
      await assert.rejects(run, /Provider launch budget exhausted/u);
    }
    const status = await statusWorkspaceEvolution(workspace, runId, { stateRoot });
    assert.equal(status.state.status, limit === 9 ? "completed" : "blocked");
    assert.equal(status.state.providerLaunchBudget.used, limit);
    assert.equal(launched, limit);
    assert.ok(events.find(event => event.type === "evolution.launch-budget-selected").estimatedProviderLaunches > limit);
  });
}

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
      "value.test.cjs": "const test=require('node:test');const assert=require('node:assert/strict');const value=require('./value');test('value',()=>assert.equal(value(),'correct'));\n",
      "asset.bin": { encoding: "base64", content: "AAEC" }
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
    assert.deepEqual(await fs.readFile(path.join(workdir, "asset.bin")), Buffer.from([0, 1, 2]));
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
  assert.doesNotMatch(maintainerProjection, /not ok/u);
  assert.doesNotMatch(maintainerProjection, /"command":\s*\[/u);
  assert.equal(proposerProjection.verification.command, undefined);
  assert.match(proposerProjection.verification.commandDigest, /^[0-9a-f]{64}$/u);
  assert.equal(proposerProjection.verification.stdout, undefined);
  assert.equal(proposerProjection.verification.stderr, undefined);
  assert.match(proposerProjection.verification.stdoutDigest, /^[0-9a-f]{64}$/u);
  assert.match(proposerProjection.verification.stderrDigest, /^[0-9a-f]{64}$/u);
  assert.ok(proposerProjection.verification.stdoutBytes > 0);
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

test("operational runtime scores externally verified workspace milestones", async () => {
  const { workspace, stateRoot } = await setup();
  const operationalTask = (id, split) => ({
    id,
    split,
    input: { instruction: "Advance the isolated workflow by updating progress.json.", caseId: id },
    outputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } },
    sandbox: {
      ".gitignore": "progress.json\n",
      "progress.json": "{\"level\":0}\n",
      "verify.cjs": `
const fs = require("node:fs");
const level = JSON.parse(fs.readFileSync("progress.json", "utf8")).level;
const order = ["M0", "M1", "M2"];
process.stdout.write(JSON.stringify({
  schema: "wikiskill.operational-verifier.v1",
  verifiedMilestones: order.slice(0, Math.max(0, Math.min(order.length, level))),
  actionableBlockersRemoved: level >= 3 ? 1 : 0,
  diagnosisVerifierPassed: level >= 1,
  unrecoveredUserChanges: 0,
  evidenceRefs: ["progress.json"]
}));
`
    },
    groundTruth: {
      schema: "wikiskill.scorer.operational-milestone.v1",
      command: [process.execPath, "verify.cjs"],
      milestoneOrder: ["M0", "M1", "M2"],
      allowedPaths: ["progress.json"]
    },
    operational: {
      episodeRef: `episode:${id}`,
      objective: id === "op-train-1" ? "repair_progress" : "terminal_success",
      requiredMilestones: ["M0", "M1", "M2"]
    },
    evaluator: { capabilityRef: "builtin:operational-milestone-v1" }
  });
  const datasetPath = path.join(workspace, "operational-dataset.json");
  await fs.writeFile(datasetPath, `${JSON.stringify({
    schema: "wikiskill.dataset.v1",
    domain: "operational-fixture",
    tasks: [
      operationalTask("op-train-1", "train"), operationalTask("op-train-2", "train"),
      operationalTask("op-val-1", "val"), operationalTask("op-val-2", "val"),
      operationalTask("op-test-1", "test")
    ]
  }, null, 2)}\n`);
  let launches = 0;
  let operationalProjection;
  const registry = createCapabilityRegistry();
  registry.registerRunner({ ref: "provider:claude", apiVersion: "wikiskill.runner.v1", implementationVersion: "test", implementationDigest: `sha256:${"a".repeat(64)}` }, () => async ({ task, workdir, skills, tools }) => {
    assert.deepEqual(tools, ["workspace"]);
    assert.deepEqual(task.operational.requiredMilestones, ["M0", "M1", "M2"]);
    const improved = skills.target["target-skill"]["SKILL.md"].includes("improved procedure");
    await fs.writeFile(path.join(workdir, "progress.json"), `${JSON.stringify({ level: improved ? 3 : 1 })}\n`);
    return {
      prediction: { summary: improved ? "advanced to terminal success" : "captured the initial diagnosis" },
      events: [{ type: "tool_call", tool: "editor", input: { file: "progress.json" } }, { type: "tool_result", tool: "editor", output: "updated" }],
      provider: { ref: "provider:claude", modelId: "test-model", sessionId: `op-session-${++launches}` }
    };
  });
  registry.registerScorer({ ref: "builtin:operational-milestone-v1", apiVersion: "wikiskill.scorer.v1", implementationVersion: "test", implementationDigest: `sha256:${"b".repeat(64)}` }, () => createOperationalMilestoneScorer());
  registry.registerLearningAgent({ ref: "provider:claude-learning", apiVersion: "wikiskill.learning-agent.v1", implementationVersion: "test", implementationDigest: `sha256:${"c".repeat(64)}` }, () => ({
    maintainer,
    proposer: async (input) => {
      operationalProjection = input.readTrace(input.availableTraces[0].id);
      return proposer(input);
    }
  }));
  registry.seal();

  const result = await evolveWorkspace(workspace, "target-skill", {
    datasetPath,
    provider: "claude",
    modelId: "test-model",
    scorerRef: "builtin:operational-milestone-v1",
    stateRoot,
    runId: "operational-runtime",
    capabilityRegistry: registry,
    iterationLimit: 1
  });

  assert.equal(result.state.baselineValidationScore.verifiedMilestoneCount, 2);
  assert.equal(result.state.bestValidationScore.verifiedMilestoneCount, 6);
  assert.equal(result.state.bestValidationScore.terminalSuccessCount, 2);
  assert.deepEqual(result.state.acceptedIterations, [1]);
  assert.equal(result.state.testComparison.improves, true);
  assert.equal(result.candidate.status, "validation_accepted");
  const trace = JSON.parse(await fs.readFile(path.join(workspace, result.rawRef, "raw", "traces", "iter-01-candidate", "val", "op-val-1.json"), "utf8"));
  assert.deepEqual(trace.verification.milestoneOrder, ["M0", "M1", "M2"]);
  assert.match(trace.workspace.diff, /"level":3/u);
  assert.deepEqual(operationalProjection.verification.milestoneOrder, ["M0", "M1", "M2"]);
  assert.equal(operationalProjection.verification.exitCode, 0);
  assert.equal(operationalProjection.verification.command, undefined);
  assert.deepEqual(auditRun(result.runRoot, { workspace }).blockers, []);

  const statePath = path.join(result.runRoot, "runs", "state.json");
  const tampered = JSON.parse(await fs.readFile(statePath, "utf8"));
  tampered.bestValidationScore.verifiedMilestoneCount += 1;
  await fs.writeFile(statePath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.match(auditRun(result.runRoot, { workspace }).blockers.join("\n"), /best validation aggregate does not match Raw traces/u);
});
