"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  validateDataset,
  inspectRepository,
  createRun,
  runEvolution,
  diffRun,
  applyRun,
  rollbackRun,
  exportWiki,
  digestText
} = require("../src");

const readFourTraces = ({ availableTraces, readTrace }) => {
  const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
  traceReads.forEach(readTrace);
  return traceReads;
};

const makeRepo = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await fs.mkdir(path.join(root, ".agents", "skills", "one"), { recursive: true });
  await fs.mkdir(path.join(root, ".claude", "skills", "two"), { recursive: true });
  await fs.writeFile(path.join(root, ".agents", "skills", "one", "SKILL.md"), "# One\nAlways inspect the source before editing.\n");
  await fs.writeFile(path.join(root, ".claude", "skills", "two", "SKILL.md"), "# Two\nKeep changes focused.\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=WikiSkill", "-c", "user.email=wikiskill@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  return root;
};

const task = (id, split, groundTruth = { value: "ok" }) => ({
  id,
  split,
  title: id,
  input: { taskId: id, instruction: `Perform ${id}` },
  taskContext: `Perform ${id}`,
  sandbox: { "input.txt": `input-${id}` },
  groundTruth: { ...groundTruth, taskId: id },
  evaluator: { capabilityRef: "adapter:test" }
});

test("accepts explicit base64 sandbox files and rejects malformed non-text values", () => {
  assert.doesNotThrow(() => validateDataset({ schema: "wikiskill.dataset.v1", tasks: [
    { ...task("train", "train"), sandbox: { "input.bin": { encoding: "base64", content: "AAEC" } } },
    task("val", "val"), task("test", "test")
  ] }));
  for (const value of [{ bad: true }, { encoding: "base64" }, { encoding: "hex", content: "00" }, ["bad"], 3, false, null]) {
    const dataset = { schema: "wikiskill.dataset.v1", tasks: [
      { ...task("train", "train"), sandbox: { "input.txt": value } },
      task("val", "val"),
      task("test", "test")
    ] };
    assert.throws(() => validateDataset(dataset), (error) => error.blockers.some((item) => item.includes("expected string or base64")));
  }
});

test("rejects only a duplicated task pair across splits, not a repeated answer alone", () => {
  const duplicate = task("same", "train", { answer: "A" });
  assert.throws(() => validateDataset({
    schema: "wikiskill.dataset.v1",
    tasks: [duplicate, { ...duplicate, id: "same-val", split: "val" }, task("test", "test", { answer: "A" })]
  }), (error) => error.blockers.some((item) => item.includes("task-pair leakage")));
  assert.doesNotThrow(() => validateDataset({
    schema: "wikiskill.dataset.v1",
    tasks: [task("train", "train", { answer: "A" }), task("val", "val", { answer: "A" }), task("test", "test", { answer: "A" })]
  }));
});

test("passes an opaque non-text task input to a domain adapter without creating a sandbox", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [
    { id: "train-1", split: "train", input: { records: [1, 2] }, groundTruth: { answer: "no" }, evaluator: { capabilityRef: "adapter:test" } },
    { id: "train-2", split: "train", input: { records: [3, 4] }, groundTruth: { answer: "no" }, evaluator: { capabilityRef: "adapter:test" } },
    { id: "train-3", split: "train", input: { records: [5, 6] }, groundTruth: { answer: "no" }, evaluator: { capabilityRef: "adapter:test" } },
    { id: "train-4", split: "train", input: { records: [7, 8] }, groundTruth: { answer: "no" }, evaluator: { capabilityRef: "adapter:test" } },
    { id: "val", split: "val", input: { records: [9, 10] }, groundTruth: { answer: "no" }, evaluator: { capabilityRef: "adapter:test" } },
    { id: "test", split: "test", input: { records: [11, 12] }, groundTruth: { answer: "no" }, evaluator: { capabilityRef: "adapter:test" } }
  ] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-opaque-input" });
  const adapter = {
    renderTask: ({ task: current }) => current.input,
    extractPrediction: ({ result }) => result.prediction,
    score: () => ({ score: 0 })
  };
  await runEvolution(manifest.runRoot, {
    adapter,
    runner: async ({ task: current, input }) => {
      assert.deepEqual(input, current.input);
      assert.equal("sandbox" in current, false);
      return { prediction: { answer: "no" }, events: [] };
    },
    proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; }
  });
});

test("blocks an imperfect validation run that has no configured Skill proposer", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [
    task("train-1", "train", { expected: "new" }),
    task("train-2", "train", { expected: "new" }),
    task("train-3", "train", { expected: "new" }),
    task("train-4", "train", { expected: "new" }),
    task("val", "val", { expected: "new" }),
    task("test", "test", { expected: "new" })
  ] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-missing-proposer" });
  const adapter = { extractPrediction: ({ result }) => result.prediction, score: () => ({ score: 0 }) };
  await assert.rejects(
    runEvolution(manifest.runRoot, { adapter, runner: async () => ({ prediction: { value: "old" }, events: [] }) }),
    /no WikiSkill proposer is configured/
  );
  await assert.rejects(diffRun(manifest.runRoot), /Only a completed run can produce a diff/);
});

test("persists a failed rollout diagnostic without exposing ground truth", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-failure-artifact" });
  const failure = new Error("runner timeout");
  failure.wikiskillDiagnostics = { stdout: "partial command output", stderr: "timeout detail", timedOut: true, exitCode: 1 };
  await assert.rejects(runEvolution(manifest.runRoot, { runner: async () => { throw failure; } }), /runner timeout/);
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs", "state.json"), "utf8"));
  assert.equal(state.failureArtifacts.length, 1);
  const artifact = JSON.parse(await fs.readFile(path.join(manifest.runRoot, state.failureArtifacts[0]), "utf8"));
  assert.equal(artifact.runnerDiagnostics.stdout, "partial command output");
  assert.equal(artifact.runnerDiagnostics.timedOut, true);
  assert.equal("groundTruth" in artifact, false);
});

test("rejects a run id that could escape the isolated WikiSkill state root", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train", "train"), task("val", "val"), task("test", "test")] };
  await assert.rejects(
    () => createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "../escape" }),
    /safe path segment/
  );
});

test("inspects only explicitly supplied Skill roots and reports digests", async () => {
  const repo = await makeRepo();
  const result = await inspectRepository({ repo, skillRoots: [".agents/skills", ".claude/skills"] });
  assert.equal(result.skills.length, 2);
  assert.deepEqual(result.skills.map((skill) => skill.path), [".agents/skills/one", ".claude/skills/two"]);
  assert.equal(result.skills[0].files["SKILL.md"], digestText("# One\nAlways inspect the source before editing.\n"));
});

test("rejects an explicit Skill root that is a symlink even when it stays inside the repo", async () => {
  const repo = await makeRepo();
  await fs.symlink(path.join(repo, ".agents", "skills"), path.join(repo, ".agents", "linked-skills"));
  await assert.rejects(() => inspectRepository({ repo, skillRoots: [".agents/linked-skills"] }), /Skill root must not be a symlink/);
});

test("runs seeded evolution with strict validation gate and isolated workspace", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const config = { repo, skillRoots: [".agents/skills"], targetSkills: ["one"], contextSkills: [], dataset, stateRoot, iterationLimit: 2, runId: "run-test" };
  const manifest = await createRun(config);
  assert.equal(await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8"), "# One\nAlways inspect the source before editing.\n");
  const sourceMap = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "source/skill-map.json"), "utf8"));
  const baselineDigests = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "source/baseline-digests.json"), "utf8"));
  assert.equal(sourceMap.skills.find((skill) => skill.id === "one").role, "target");
  assert.equal(baselineDigests.skills.find((skill) => skill.id === "one").files["SKILL.md"], digestText("# One\nAlways inspect the source before editing.\n"));
  assert.equal(await fs.readFile(path.join(manifest.runRoot, "dataset/dataset.json"), "utf8"), await fs.readFile(path.join(manifest.runRoot, "tasks/task-set.json"), "utf8"));
  assert.match(await fs.readFile(path.join(manifest.runRoot, "skills/active/one/PURPOSE.md"), "utf8"), /Source path: .agents\/skills\/one/);
  assert.equal(await fs.access(path.join(repo, ".agents/skills/one/PURPOSE.md")).then(() => true).catch(() => false), false);
  const runner = async ({ task: current }) => ({ prediction: { value: "ok" }, events: [{ type: "assistant", text: current.id }] });
  const adapter = { renderTask: ({ task: current }) => current.taskContext, extractPrediction: ({ result }) => result.prediction, score: ({ prediction, groundTruth }) => ({ score: prediction.value === groundTruth.value ? 1 : 0, evidence: { match: true } }) };
  await runEvolution(manifest.runRoot, { runner, adapter, proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(state.status, "completed");
  assert.equal(state.bestValidationScore, 1);
  assert.equal(state.testScore, 1);
  assert.equal(state.earlyStopped, true);
  assert.equal(await fs.access(path.join(manifest.runRoot, "raw/traces/iter-00/val/val.json")).then(() => true), true);
  assert.equal(await fs.access(path.join(manifest.runRoot, "result/result.json")).then(() => true), true);
  const result = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "result/result.json"), "utf8"));
  assert.equal(result.engine.version, "0.1.0");
  assert.match(result.adapterDigest, /^[0-9a-f]{64}$/);
});

test("emits the same semantic result digest for equivalent isolated executions", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const base = { repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, configDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" };
  const first = await createRun({ ...base, runId: "equivalent-a" });
  const second = await createRun({ ...base, runId: "equivalent-b" });
  const proposer = async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; };
  await runEvolution(first.runRoot, { proposer });
  await runEvolution(second.runRoot, { proposer });
  const firstResult = JSON.parse(await fs.readFile(path.join(first.runRoot, "result/result.json"), "utf8"));
  const secondResult = JSON.parse(await fs.readFile(path.join(second.runRoot, "result/result.json"), "utf8"));
  assert.equal(firstResult.configDigest, base.configDigest);
  assert.equal(firstResult.semanticResultDigest, secondResult.semanticResultDigest);
  assert.notEqual(firstResult.applyManifestDigest, secondResult.applyManifestDigest);
});

test("apply dry-run is zero-write on target digest conflict", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train", { value: "updated" }), task("train-2", "train", { value: "updated" }), task("train-3", "train", { value: "updated" }), task("train-4", "train", { value: "updated" }), task("val", "val", { value: "updated" }), task("test", "test", { value: "updated" })] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-conflict" });
  const runner = async ({ task: current, skills }) => ({ prediction: { value: Object.values(skills.target.one || {}).some((text) => text.includes("Updated")) ? "updated" : "ok" }, events: [{ type: "assistant", text: current.id }] });
  const adapter = { extractPrediction: ({ result }) => result.prediction, score: ({ prediction, groundTruth }) => ({ score: prediction.value === groundTruth.value ? 1 : 0 }) };
  await runEvolution(manifest.runRoot, { runner, adapter, proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "patch", skillId: "one", files: { "SKILL.md": "# One\nUpdated guidance.\n" }, traceReads }; } });
  const original = await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8");
  await fs.writeFile(path.join(repo, ".agents/skills/one/SKILL.md"), `${original}concurrent change\n`);
  await assert.rejects(() => applyRun(manifest.runRoot, { repo, dryRun: true }), /Target digest conflict/);
  assert.equal(await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8"), `${original}concurrent change\n`);
});

test("accepts only a strict validation improvement and never mutates context Skill", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [
    { ...task("train-1", "train", { value: "improved" }), sandbox: { "input.txt": "train-input-1" } },
    { ...task("train-2", "train", { value: "improved" }), sandbox: { "input.txt": "train-input-2" } },
    { ...task("train-3", "train", { value: "improved" }), sandbox: { "input.txt": "train-input-3" } },
    { ...task("train-4", "train", { value: "improved" }), sandbox: { "input.txt": "train-input-4" } },
    { ...task("val", "val", { value: "improved" }), sandbox: { "input.txt": "val-input" } },
    { ...task("test", "test", { value: "improved" }), sandbox: { "input.txt": "test-input" } }
  ] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills", ".claude/skills"], targetSkills: ["one"], contextSkills: ["two"], dataset, stateRoot, runId: "run-strict" });
  const runner = async ({ task: current, skills }) => ({ prediction: { value: Object.values(skills.target.one || {}).some((text) => text.includes("Updated")) ? "improved" : "old" }, events: [{ type: "assistant", text: current.id }] });
  const adapter = { extractPrediction: ({ result }) => result.prediction, score: ({ prediction, groundTruth }) => ({ score: prediction.value === groundTruth.value ? 1 : 0 }) };
  await runEvolution(manifest.runRoot, { runner, adapter, iterationLimit: 1, proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "patch", skillId: "one", files: { "SKILL.md": "# One\nUpdated guidance.\n" }, traceReads }; } });
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.deepEqual(state.acceptedIterations, [1]);
  assert.equal(state.bestValidationScore, 1);
  assert.equal(await fs.readFile(path.join(manifest.runRoot, "skills/context/two/SKILL.md"), "utf8"), "# Two\nKeep changes focused.\n");
  const dryRun = await applyRun(manifest.runRoot, { repo, dryRun: true });
  assert.deepEqual(dryRun.changedPaths, [".agents/skills/one/SKILL.md"]);
  const applied = await applyRun(manifest.runRoot, { repo });
  assert.equal((await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8")).includes("Updated guidance."), true);
  const result = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "result/result.json"), "utf8"));
  const applyManifest = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "result/apply-manifest.json"), "utf8"));
  assert.equal(result.proposalHistory[0].skillId, "one");
  assert.equal(result.proposalHistory[0].accepted, true);
  assert.equal(applyManifest.proposalHistory[0].candidateValidationScore, 1);
  await rollbackRun(applied.receipt.id, { stateRoot });
  assert.equal(await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8"), "# One\nAlways inspect the source before editing.\n");
});

test("rejects equal-score proposal while retaining Wiki evidence", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train", { value: "ok" }), task("train-2", "train", { value: "ok" }), task("train-3", "train", { value: "ok" }), task("train-4", "train", { value: "ok" }), task("val", "val", { value: "ok" }), task("test", "test", { value: "ok" })] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-equal" });
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "patch", skillId: "one", files: { "SKILL.md": "# One\nEquivalent.\n" }, traceReads }; } });
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.deepEqual(state.acceptedIterations, []);
  const impact = await fs.readFile(path.join(manifest.runRoot, "wiki/skill-impact.md"), "utf8");
  assert.match(impact, /verdict: rejected/);
  assert.match(impact, /target: one/);
  assert.match(impact, /"skillId": "one"/);
  assert.match(impact, /diff --git a\/\.agents\/skills\/one\/SKILL.md/);
});

test("supports paper conformance empty-S0 mode without inspecting Skills", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [
    task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")
  ] };
  const manifest = await createRun({ repo, mode: "empty", targetSkills: [], contextSkills: [], dataset, stateRoot, runId: "run-empty" });
  assert.equal(manifest.mode, "empty");
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(state.status, "completed");
});

test("never exposes groundTruth or evaluator to the inference runner", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const outputSchema = { type: "object", required: ["value"], properties: { value: { type: "string" } } };
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")].map((item) => ({ ...item, outputSchema })) };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-isolation" });
  const runner = async ({ task: visible, systemPrompt, predictionSchema }) => {
    assert.equal("groundTruth" in visible, false);
    assert.equal("evaluator" in visible, false);
    assert.deepEqual(visible.outputSchema, outputSchema);
    assert.deepEqual(predictionSchema, outputSchema);
    assert.match(systemPrompt, /WikiSkill Inference Agent/u);
    assert.match(systemPrompt, /Do not read ground truth/u);
    return { prediction: { value: "ok" }, events: [] };
  };
  await runEvolution(manifest.runRoot, { runner, proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
});

test("maintainer writes only through the Wiki write contract", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-maintainer" });
  const privateMarker = "private-scorer-evidence-must-not-leak";
  await runEvolution(manifest.runRoot, {
    adapter: { score: () => ({ score: 0, evidence: { privateMarker } }) },
    maintainer: async ({ sampledTraces, writePattern, appendLog }) => {
      assert.equal(sampledTraces.length, 4);
      assert.equal("groundTruth" in sampledTraces[0], false);
      assert.equal(JSON.stringify(sampledTraces).includes(privateMarker), false);
      writePattern("observed.md", "# Observed\n");
      appendLog("maintainer completed");
    },
    proposer: async (input) => {
      const traceReads = readFourTraces(input);
      assert.equal(JSON.stringify(traceReads.map(input.readTrace)).includes(privateMarker), false);
      return { action: "no_action", traceReads };
    }
  });
  assert.equal(await fs.readFile(path.join(manifest.runRoot, "wiki/patterns/observed.md"), "utf8"), "# Observed\n");
  assert.match(await fs.readFile(path.join(manifest.runRoot, "wiki/log.md"), "utf8"), /maintainer completed/);
});

test("maintainer validation failure leaves the Wiki unchanged", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-maintainer-atomic" });
  const wikiFiles = ["index.md", "log.md", "skill-impact.md"];
  const before = await Promise.all(wikiFiles.map((file) => fs.readFile(path.join(manifest.runRoot, "wiki", file), "utf8")));
  await assert.rejects(runEvolution(manifest.runRoot, {
    maintainer: async ({ appendLog, patchPattern }) => {
      appendLog("must not be committed");
      patchPattern("missing.md", [{ op: "replace", target: "missing", content: "invalid" }]);
    },
    proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; }
  }), /cannot patch a missing pattern/u);
  assert.deepEqual(await Promise.all(wikiFiles.map((file) => fs.readFile(path.join(manifest.runRoot, "wiki", file), "utf8"))), before);
  assert.deepEqual(await fs.readdir(path.join(manifest.runRoot, "wiki", "patterns")), []);
});

test("compounds the Wiki across iterations and patches an existing pattern incrementally", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train", { value: "unmatched" }), task("train-2", "train", { value: "unmatched" }), task("train-3", "train", { value: "unmatched" }), task("train-4", "train", { value: "unmatched" }), task("val", "val", { value: "unmatched" }), task("test", "test", { value: "unmatched" })] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-wiki-compounds", iterationLimit: 2 });
  await runEvolution(manifest.runRoot, {
    maintainer: async ({ iteration, existingWiki, writePattern, patchPattern, appendLog }) => {
      if (iteration === 1) {
        writePattern("observed.md", "# Observed\nInitial evidence.\n");
        appendLog("first maintainer pass");
      } else {
        assert.match(existingWiki.index, /Iteration 1/);
        assert.match(existingWiki.log, /first maintainer pass/);
        assert.match(existingWiki.patterns["observed.md"], /Initial evidence/);
        patchPattern("observed.md", [{ op: "insert_after", target: "Initial evidence.\n", content: "Refined evidence.\n" }]);
        appendLog("second maintainer pass");
      }
    },
    proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; }
  });
  const index = await fs.readFile(path.join(manifest.runRoot, "wiki/index.md"), "utf8");
  const log = await fs.readFile(path.join(manifest.runRoot, "wiki/log.md"), "utf8");
  const pattern = await fs.readFile(path.join(manifest.runRoot, "wiki/patterns/observed.md"), "utf8");
  assert.match(index, /Iteration 1/);
  assert.match(index, /Iteration 2/);
  assert.match(log, /first maintainer pass/);
  assert.match(log, /second maintainer pass/);
  assert.match(pattern, /Refined evidence/);
});

test("default Wiki log records immutable Raw references rather than copying trace bodies", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train", { value: "unmatched" }), task("train-2", "train", { value: "unmatched" }), task("train-3", "train", { value: "unmatched" }), task("train-4", "train", { value: "unmatched" }), task("val", "val", { value: "unmatched" }), task("test", "test", { value: "unmatched" })] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-wiki-raw-separation" });
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const log = await fs.readFile(path.join(manifest.runRoot, "wiki/log.md"), "utf8");
  assert.match(log, /raw: raw\/traces\/iter-01\/train\/train-1.json/);
  assert.doesNotMatch(log, /"events"/);
});

test("caps Maintainer event text without truncating the immutable Raw trace", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-cap" });
  const largeText = "x".repeat(20_000);
  await runEvolution(manifest.runRoot, {
    runner: async () => ({ prediction: { value: "ignored" }, events: [{ type: "assistant", text: largeText }] }),
    maintainer: async ({ sampledTraces }) => {
      assert.ok(sampledTraces.every((trace) => trace.executionLog.length <= 15_000));
      assert.ok(sampledTraces.every((trace) => !trace.executionLog.includes(largeText)));
      assert.ok(sampledTraces.every((trace) => trace.executionLog.includes("learning projection truncated")));
    },
    proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; }
  });
  const raw = await fs.readFile(path.join(manifest.runRoot, "raw/traces/iter-01/train/train-1.json"), "utf8");
  assert.ok(raw.length > 20_000);
});

test("exports Wiki only when explicitly requested", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-export" });
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const dryRun = await exportWiki(manifest.runRoot, { repo, destination: "docs/wikiskill", dryRun: true });
  assert.ok(dryRun.changedPaths.includes("docs/wikiskill/index.md"));
  assert.equal(await fs.access(path.join(repo, "docs/wikiskill/index.md")).then(() => true).catch(() => false), false);
  await exportWiki(manifest.runRoot, { repo, destination: "docs/wikiskill" });
  assert.match(await fs.readFile(path.join(repo, "docs/wikiskill/index.md"), "utf8"), /Pattern Index/);
});

test("checks every target before writing any target", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills", ".claude/skills"], targetSkills: ["one", "two"], dataset, stateRoot, runId: "run-atomic-preflight" });
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "patch", skillId: "one", files: { "SKILL.md": "# One\nUpdated.\n" }, traceReads }; } });
  const oneBefore = await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8");
  await fs.writeFile(path.join(repo, ".claude/skills/two/SKILL.md"), "# Two\nConcurrent.\n");
  await assert.rejects(() => applyRun(manifest.runRoot, { repo, dryRun: true }), /Target digest conflict/);
  assert.equal(await fs.readFile(path.join(repo, ".agents/skills/one/SKILL.md"), "utf8"), oneBefore);
});

test("retries a blocked run from its checkpoint with a fresh immutable attempt", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-retry" });
  await assert.rejects(() => runEvolution(manifest.runRoot, {
    proposer: async ({ availableTraces }) => ({ action: "no_action", traceReads: availableTraces.slice(0, 4).map(({ id }) => id) })
  }), /declared a training trace that it did not read/);
  const blocked = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(blocked.status, "blocked");
  await runEvolution(manifest.runRoot, {
    proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; }
  });
  const completed = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.blockers, []);
  assert.equal(await fs.access(path.join(manifest.runRoot, "raw/traces/iter-01/train/train-1.json")).then(() => true), true);
  assert.equal(await fs.access(path.join(manifest.runRoot, "raw/traces/attempt-02/iter-01/train/train-1.json")).then(() => true), true);
});

test("persists stopped state when the Agent runner observes cancellation", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-cancelled" });
  const controller = new AbortController();
  const runner = ({ abortSignal }) => new Promise((_resolve, reject) => {
    if (abortSignal?.aborted) { reject(new Error("cancelled by test")); return; }
    abortSignal?.addEventListener("abort", () => reject(new Error("cancelled by test")), { once: true });
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => runEvolution(manifest.runRoot, { runner, abortSignal: controller.signal }));
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(state.status, "stopped");
});

test("disposes an isolated environment when the runner fails", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-cleanup-on-failure" });
  let disposeCount = 0;
  const adapter = {
    prepareEnvironment: ({ workdir }) => ({ workdir }),
    disposeEnvironment: () => { disposeCount += 1; },
    extractPrediction: ({ result }) => result.prediction,
    score: () => ({ score: 0 })
  };
  await assert.rejects(() => runEvolution(manifest.runRoot, { adapter, runner: async () => { throw new Error("runner failed"); } }));
  assert.equal(disposeCount, 1);
});

test("materializes the current Skill set in every isolated evaluation environment", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], dataset, stateRoot, runId: "run-materialize-context" });
  const injected = [];
  const prompts = [];
  const adapter = {
    materializeExecutionContext: ({ skills, workdir }) => {
      injected.push({ skills, workdir });
      return {
        requiredInstructions: "Read the immutable workflow contract before editing.",
        environment: { WIKISKILL_TEST_CONTEXT: "injected" }
      };
    },
    extractPrediction: ({ result }) => result.prediction,
    score: () => ({ score: 1 })
  };
  await runEvolution(manifest.runRoot, {
    adapter,
    runner: async ({ systemPrompt, environment }) => {
      prompts.push(systemPrompt);
      assert.deepEqual(environment, { WIKISKILL_TEST_CONTEXT: "injected" });
      return { prediction: { value: "ok" }, events: [] };
    },
    proposer: async (input) => {
      const traceReads = readFourTraces(input);
      return { action: "no_action", traceReads };
    }
  });
  assert.equal(injected.length, 3);
  assert.equal(injected[0].skills.target.one["SKILL.md"], "# One\nAlways inspect the source before editing.\n");
  assert.ok(prompts.every((prompt) => prompt.startsWith("You are the WikiSkill Inference Agent")));
  assert.ok(prompts.every((prompt) => prompt.includes("Read the immutable workflow contract before editing.")));
});

test("creates a new Skill only inside the declared newSkillRoot", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [
    { ...task("train-1", "train", { value: "new" }), sandbox: { "input.txt": "train-one" } },
    { ...task("train-2", "train", { value: "new" }), sandbox: { "input.txt": "train-two" } },
    { ...task("train-3", "train", { value: "new" }), sandbox: { "input.txt": "train-three" } },
    { ...task("train-4", "train", { value: "new" }), sandbox: { "input.txt": "train-four" } },
    { ...task("val", "val", { value: "new" }), sandbox: { "input.txt": "val-new" } },
    { ...task("test", "test", { value: "new" }), sandbox: { "input.txt": "test-new" } }
  ] };
  const manifest = await createRun({ repo, skillRoots: [".agents/skills"], targetSkills: ["one"], newSkillRoot: ".agents/skills", dataset, stateRoot, runId: "run-create" });
  const runner = async ({ skills }) => ({ prediction: { value: skills.target["new-skill"] ? "new" : "old" }, events: [] });
  const adapter = { extractPrediction: ({ result }) => result.prediction, score: ({ prediction, groundTruth }) => ({ score: prediction.value === groundTruth.value ? 1 : 0 }) };
  await runEvolution(manifest.runRoot, { runner, adapter, proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "create", skillId: "new-skill", files: { "SKILL.md": "# New Skill\n" }, traceReads }; } });
  const dryRun = await applyRun(manifest.runRoot, { repo, dryRun: true });
  assert.ok(dryRun.changedPaths.includes(".agents/skills/new-skill/SKILL.md"));
  assert.equal(await fs.access(path.join(repo, ".agents/skills/new-skill")).then(() => true).catch(() => false), false);
});

test("does not expose an unaccepted projected Workflow Skill through apply output", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({
    repo,
    skillRoots: [".agents/skills"],
    targetSkills: ["one"],
    projectedSkills: [{
      id: "workflow-seed",
      destination: ".agents/skills/workflow-seed",
      mode: "target",
      files: {
        "SKILL.md": "# Workflow Seed\n",
        "PURPOSE.md": "# Purpose\nWorkflow projection.\n",
        "references/source-manifest.json": "{\"source\":\"opaque\"}\n"
      }
    }],
    dataset,
    stateRoot,
    runId: "run-projected"
  });
  const runner = async ({ skills }) => ({ prediction: { value: skills.target["workflow-seed"] ? "ok" : "missing" }, events: [] });
  const adapter = { extractPrediction: ({ result }) => result.prediction, score: ({ prediction }) => ({ score: prediction.value === "ok" ? 1 : 0 }) };
  await runEvolution(manifest.runRoot, { runner, adapter, proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const dryRun = await applyRun(manifest.runRoot, { repo, dryRun: true });
  assert.deepEqual(dryRun.changedPaths, []);
  assert.equal(await fs.access(path.join(repo, ".agents/skills/workflow-seed")).then(() => true).catch(() => false), false);
});

test("allows a projected Skill to be the only explicit seeded selection", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({
    repo,
    projectedSkills: [{ id: "workflow-only", destination: ".agents/skills/workflow-only", files: { "SKILL.md": "# Workflow\n", "PURPOSE.md": "# Purpose\n" } }],
    dataset,
    stateRoot,
    runId: "run-projected-only"
  });
  assert.deepEqual(manifest.targetSkills.map((skill) => skill.id), ["workflow-only"]);
  assert.equal(await fs.access(path.join(manifest.runRoot, "skills/active/workflow-only/SKILL.md")).then(() => true), true);
});

test("creates four independently auditable training trajectories from configured rollouts", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({
    repo,
    skillRoots: [".agents/skills"],
    targetSkills: ["one"],
    dataset,
    stateRoot,
    runId: "run-multiple-trajectories",
    trainingRolloutsPerTask: 4
  });
  const read = [];
  await runEvolution(manifest.runRoot, {
    proposer: async (input) => {
      const traceReads = input.availableTraces.slice(0, 4).map(({ id }) => id);
      traceReads.forEach((id) => { read.push(id); input.readTrace(id); });
      return { action: "no_action", traceReads };
    }
  });
  assert.equal(new Set(read).size, 4);
  for (let rollout = 1; rollout <= 4; rollout += 1) {
    const file = rollout === 1 ? "train.json" : `train-rollout-${rollout}.json`;
    assert.equal(await fs.access(path.join(manifest.runRoot, "raw/traces/iter-01/train", file)).then(() => true), true);
  }
});

test("evaluates validation and final test with the frozen rollout count", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({
    repo,
    skillRoots: [".agents/skills"],
    targetSkills: ["one"],
    dataset,
    stateRoot,
    runId: "run-evaluation-rollouts",
    evaluationRolloutsPerTask: 3
  });
  assert.equal(manifest.evaluationRolloutsPerTask, 3);
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  for (const split of ["val", "test"]) {
    const directory = split === "val" ? "raw/traces/iter-00/val" : "raw/traces/final/test";
    assert.deepEqual((await fs.readdir(path.join(manifest.runRoot, directory))).sort(), [split === "val" ? "val-rollout-2.json" : "test-rollout-2.json", split === "val" ? "val-rollout-3.json" : "test-rollout-3.json", `${split}.json`].sort());
  }
});

test("command runner executes an external standalone Agent process with isolated input", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const runnerScript = [
    "let raw = '';",
    "process.stdin.on('data', (chunk) => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    "  const input = JSON.parse(raw);",
    "  if (JSON.stringify(input).includes('groundTruth') || !input.systemPrompt.includes('Skill: one') || input.model.id !== 'standalone-model' || typeof input.taskInput?.taskId !== 'string') process.exit(2);",
    "  process.stdout.write(JSON.stringify({ prediction: { value: 'ignored' }, events: [{ type: 'observation', text: input.taskInput }, { type: 'assistant', text: 'done' }] }));",
    "});"
  ].join("\n");
  const manifest = await createRun({
    repo,
    skillRoots: [".agents/skills"],
    targetSkills: ["one"],
    dataset,
    stateRoot,
    runId: "run-command-runner",
    model: { id: "standalone-model" },
    agentRunner: { id: "command", command: process.execPath, args: ["-e", runnerScript] }
  });
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(state.status, "completed");
});

test("creates a configured external domain adapter module", async () => {
  const repo = await makeRepo();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-state-"));
  const adapterModule = path.join(stateRoot, "adapter.cjs");
  await fs.writeFile(adapterModule, [
    "module.exports.createAdapter = (config) => {",
    "  if (config.marker !== 'configured') throw new Error('adapter config was not passed');",
    "  return {",
    "    renderTask: ({ task }) => task.taskContext,",
    "    extractPrediction: ({ result }) => result.prediction,",
    "    score: () => ({ score: 0, evidence: { configured: true } })",
    "  };",
    "};"
  ].join("\n"), "utf8");
  const dataset = { schema: "wikiskill.dataset.v1", tasks: [task("train-1", "train"), task("train-2", "train"), task("train-3", "train"), task("train-4", "train"), task("val", "val"), task("test", "test")] };
  const manifest = await createRun({
    repo,
    skillRoots: [".agents/skills"],
    targetSkills: ["one"],
    dataset,
    stateRoot,
    runId: "run-adapter-factory",
    adapterModule,
    adapterConfig: { marker: "configured" }
  });
  await runEvolution(manifest.runRoot, { proposer: async (input) => { const traceReads = readFourTraces(input); return { action: "no_action", traceReads }; } });
  const state = JSON.parse(await fs.readFile(path.join(manifest.runRoot, "runs/state.json"), "utf8"));
  assert.equal(state.status, "completed");
});
