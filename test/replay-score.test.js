"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { execute } = require("../src/cli");
const { replayCandidateScore } = require("../src/replay-score");
const { evolveWorkspace, treeDigest } = require("../src/evolution");
const { createCodexRunner } = require("../src/codex-runner");
const { createCapabilityRegistry } = require("../src/runtime-capabilities");
const { createOperationalMilestoneScorer } = require("../src/operational-scorer");
const { initWorkspace } = require("../src/workspace");
const { auditRun } = require("../src/audit/run");

const FAKE_CODEX = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const workdir = valueAfter("-C");
  const improved = prompt.includes("improved procedure");
  const regress = fs.existsSync(path.join(__dirname, "regress-marker"));
  const level = improved ? (regress ? 0 : 3) : 1;
  fs.writeFileSync(path.join(workdir, "progress.json"), JSON.stringify({ level }) + "\\n");
  fs.writeFileSync(valueAfter("-o"), JSON.stringify({ prediction: { summary: improved ? "advanced" : "diagnosed" } }));
  const threadId = "thread-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  for (const record of [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }
  ]) process.stdout.write(JSON.stringify(record) + "\\n");
});
`;

const FAKE_CODEX_COMMAND_EXIT = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const workdir = valueAfter("-C");
  fs.writeFileSync(path.join(workdir, "done.json"), JSON.stringify({ done: true }) + "\\n");
  fs.writeFileSync(valueAfter("-o"), JSON.stringify({ prediction: { summary: "completed" } }));
  const threadId = "thread-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  for (const record of [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }
  ]) process.stdout.write(JSON.stringify(record) + "\\n");
});
`;

const FAKE_CODEX_HANG = `
const fs = require("node:fs");
const path = require("node:path");
process.on("SIGTERM", () => { fs.appendFileSync(path.join(__dirname, "hang-signals.log"), "term\\n"); });
fs.appendFileSync(path.join(__dirname, "hang-pids.log"), process.pid + "\\n");
setInterval(() => {}, 1000);
`;

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
  operational: { episodeRef: `episode:${id}`, objective: "terminal_success", requiredMilestones: ["M0", "M1", "M2"] },
  evaluator: { capabilityRef: "builtin:operational-milestone-v1" }
});

const commandExitTask = (id, split) => ({
  id,
  split,
  input: { instruction: "Create done.json to satisfy the frozen checker.", caseId: id },
  outputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } },
  sandbox: {
    "check.cjs": "process.exit(require('node:fs').existsSync('done.json') ? 0 : 1);\n"
  },
  groundTruth: {
    schema: "wikiskill.scorer.command-exit.v1",
    command: [process.execPath, "check.cjs"],
    allowedPaths: ["done.json"]
  },
  evaluator: { capabilityRef: "builtin:command-exit-v1" }
});

const maintainer = async ({ writePattern }) => { writePattern("ops.md", "# Operations\n\nUse verifier evidence.\n"); };
const proposer = async ({ availableTraces, readTrace }) => {
  const traceReads = availableTraces.map((item) => item.id);
  traceReads.forEach(readTrace);
  return {
    action: "patch",
    skillId: "target-skill",
    traceReads,
    files: { "SKILL.md": "---\nname: target-skill\ndescription: Advance progress.\n---\n\nUse the improved procedure: set level to 3.\n" }
  };
};

const makeWritable = async (target) => {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    await fs.chmod(target, 0o755).catch(() => undefined);
    for (const entry of await fs.readdir(target)) await makeWritable(path.join(target, entry));
  } else await fs.chmod(target, 0o644).catch(() => undefined);
};

const fixture = async ({ scorerRef = "builtin:operational-milestone-v1" } = {}) => {
  const commandExit = scorerRef === "builtin:command-exit-v1";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-replay-"));
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await fs.mkdir(workspace);
  await initWorkspace(workspace, { mode: "zero-source-write" });
  if (!commandExit) {
    const skillRoot = path.join(workspace, ".wikiskill", "skills", "target-skill");
    await fs.mkdir(skillRoot);
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: target-skill\ndescription: Advance progress.\n---\n\nUse the old procedure.\n");
  } else {
    const skillRoot = path.join(workspace, ".wikiskill", "skills", "target-skill");
    await fs.mkdir(skillRoot);
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: target-skill\ndescription: Complete the check.\n---\n\nCreate done.json.\n");
  }
  const scriptPath = path.join(root, commandExit ? "fake-codex-command-exit.cjs" : "fake-codex.cjs");
  await fs.writeFile(scriptPath, commandExit ? FAKE_CODEX_COMMAND_EXIT : FAKE_CODEX);
  const taskFor = commandExit ? commandExitTask : operationalTask;
  const datasetPath = path.join(root, "dataset.json");
  await fs.writeFile(datasetPath, `${JSON.stringify({
    schema: "wikiskill.dataset.v1",
    domain: "replay-fixture",
    tasks: [
      taskFor("op-train-1", "train"), taskFor("op-train-2", "train"),
      taskFor("op-val-1", "val"), taskFor("op-val-2", "val"),
      taskFor("op-test-1", "test")
    ]
  }, null, 2)}\n`);
  const configPath = path.join(workspace, ".wikiskill", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.evolution = { ...(config.evolution || {}), runtime: { runnerConfig: { executable: process.execPath, executableArgs: [scriptPath], timeoutMs: 60_000 } } };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { root, workspace, stateRoot, datasetPath, scriptPath };
};

const evolve = (fx, { runId, registry, scorerRef = "builtin:operational-milestone-v1" } = {}) => evolveWorkspace(fx.workspace, "target-skill", {
  datasetPath: fx.datasetPath,
  provider: "codex",
  modelId: "fixture-model",
  scorerRef,
  stateRoot: fx.stateRoot,
  runId,
  iterationLimit: 1,
  ...(registry ? { capabilityRegistry: registry } : {}),
  maintainer,
  proposer
});

const cli = async (args) => {
  const lines = [];
  const code = await execute([...args, "--json"], { stdout: (line) => lines.push(line), stderr: () => {} });
  return { code, envelope: JSON.parse(lines.join("")) };
};

const waitFor = async (predicate, { timeoutMs = 30_000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
};

const replayArgs = (fx, candidateId, output) => ["run", "replay-score", "--run-root", fx.runRoot, "--workspace", fx.workspace, "--candidate", candidateId, "--output", output];

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const stripTaskSetEvidence = async (runRoot) => {
  const RESULT_SEMANTIC_KEYS = ["engine", "configDigest", "dataset", "adapterDigest", "runnerDigest", "modelDigest", "proposalHistory", "baselineValidationScore", "finalValidationScore", "testScore", "acceptedIterations", "earlyStopped", "earlyStopReason", "changesPatchDigest", "reversePatchDigest"];
  const manifestPath = path.join(runRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.dataset.taskSetDigest;
  await fs.writeFile(manifestPath, canonicalJson(manifest));
  const applyPath = path.join(runRoot, "result", "apply-manifest.json");
  const apply = JSON.parse(await fs.readFile(applyPath, "utf8"));
  delete apply.dataset.taskSetDigest;
  await fs.writeFile(applyPath, canonicalJson(apply));
  const resultPath = path.join(runRoot, "result", "result.json");
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  delete result.dataset.taskSetDigest;
  result.applyManifestDigest = sha256Hex(canonicalJson(apply));
  const semantic = {};
  for (const key of RESULT_SEMANTIC_KEYS) if (key in result) semantic[key] = result[key];
  result.semanticResultDigest = sha256Hex(canonicalJson(semantic));
  await fs.writeFile(resultPath, canonicalJson(result));
};

test("replay-score re-executes baseline and candidate held-out inference with the real scorer", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-main" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    fx.runRoot = evolved.runRoot;
    const runRootDigest = treeDigest(evolved.runRoot);
    const candidateRoot = path.join(fx.workspace, ".wikiskill", "candidates", candidateId);
    const candidateDigest = treeDigest(candidateRoot);
    const manifest = JSON.parse(await fs.readFile(path.join(evolved.runRoot, "manifest.json"), "utf8"));
    const output = path.join(fx.root, "replay-out");

    const { code, envelope } = await cli(replayArgs(fx, candidateId, output));
    assert.equal(code, 0, JSON.stringify(envelope));
    assert.equal(envelope.success, true);
    const data = envelope.data;
    assert.equal(data.schema, "wikiskill.replay-score.v1");
    assert.equal(data.run.runId, "replay-main");
    assert.equal(data.run.datasetDigest, manifest.dataset.digest);
    assert.equal(data.dataset.fileDigest, `sha256:${sha256Hex(await fs.readFile(path.join(evolved.runRoot, "tasks", "task-set.json")))}`);
    assert.equal(data.dataset.taskSetDigest, manifest.dataset.taskSetDigest);
    assert.deepEqual(data.dataset.testTaskIds, ["op-test-1"]);
    assert.notEqual(data.skills.baselineSkillSetDigest, data.skills.candidateSkillSetDigest);
    assert.equal(data.runtime.provider, "codex");
    assert.equal(data.runtime.modelId, "fixture-model");
    assert.equal(data.runtime.runner.ref, "provider:codex");
    assert.equal(data.runtime.runner.implementationDigest, manifest.runtime.runner.implementationDigest);
    assert.equal(data.runtime.scorer.ref, "builtin:operational-milestone-v1");
    assert.equal(data.runtime.scorer.implementationDigest, manifest.runtime.scorer.implementationDigest);

    assert.equal(data.sides.baseline.aggregate.verifiedMilestoneCount, 1);
    assert.equal(data.sides.baseline.aggregate.terminalSuccessCount, 0);
    assert.equal(data.sides.candidate.aggregate.verifiedMilestoneCount, 3);
    assert.equal(data.sides.candidate.aggregate.terminalSuccessCount, 1);
    assert.equal(data.verdict.regression, false);
    assert.equal(data.verdict.comparison.improves, true);
    assert.equal(data.inferenceInvocations.length, 2);
    assert.equal(data.inferenceInvocations.every((item) => item.provider?.ref === "provider:codex" && typeof item.provider?.sessionId === "string" && item.provider.sessionId.length > 0), true);
    assert.equal(data.runtime.wallClockMs, 7_200_000);
    assert.equal(data.evidence.providerSessionCount, 2);
    assert.equal(data.evidence.auditedRuntimeSessionCount, (JSON.parse(await fs.readFile(path.join(evolved.runRoot, "runs", "state.json"), "utf8")).runtimeSessions || []).length);
    assert.equal(data.evidence.auditedSessionKeyCount, data.evidence.auditedRuntimeSessionCount);

    for (const side of ["baseline", "candidate"]) {
      const trace = JSON.parse(await fs.readFile(path.join(output, "raw", "traces", side, "test", "op-test-1.json"), "utf8"));
      assert.equal(trace.split, "test");
      assert.equal(trace.phase, side === "baseline" ? "baseline_test" : "final_test");
      assert.equal(trace.skillSetDigest, side === "baseline" ? data.skills.baselineSkillSetDigest : data.skills.candidateSkillSetDigest);
      assert.equal(trace.verification.verifier.exitCode, 0);
      assert.deepEqual(trace.verification.milestoneOrder, ["M0", "M1", "M2"]);
      await fs.access(path.join(output, ...trace.evaluationRef.split("/")));
    }
    const ledger = (await fs.readFile(path.join(output, "accounting", "provider-launches.jsonl"), "utf8")).trim().split("\n");
    assert.equal(ledger.length, 2);
    assert.equal(JSON.parse(ledger[0]).provider, "codex");
    assert.equal(await fs.access(path.join(output, "raw", "traces", "baseline", "train")).then(() => true, () => false), false);
    const replayFile = JSON.parse(await fs.readFile(path.join(output, "replay.json"), "utf8"));
    assert.equal(replayFile.replayId, data.replayId);
    assert.deepEqual(replayFile.verdict.comparison, data.verdict.comparison);

    assert.equal(treeDigest(evolved.runRoot), runRootDigest);
    assert.equal(treeDigest(candidateRoot), candidateDigest);
    assert.match(await fs.readFile(path.join(fx.workspace, ".wikiskill", "skills", "target-skill", "SKILL.md"), "utf8"), /old procedure/u);

    const rerun = await cli(replayArgs(fx, candidateId, output));
    assert.equal(rerun.code, 1);
    assert.match(rerun.envelope.blockers.join("\n"), /already exists/u);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score reports a fresh held-out regression with a non-zero exit code", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-regress" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    await fs.writeFile(path.join(fx.root, "regress-marker"), "");
    const output = path.join(fx.root, "replay-out");
    const { code, envelope } = await cli(replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output));
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /Held-out replay regression/u);
    const data = envelope.data;
    assert.equal(data.verdict.regression, true);
    assert.deepEqual(data.verdict.comparison.regressions, [{ taskId: "op-test-1", lostMilestones: ["M0"] }]);
    assert.equal(data.sides.baseline.aggregate.verifiedMilestoneCount, 1);
    assert.equal(data.sides.candidate.aggregate.verifiedMilestoneCount, 0);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score rejects a foreign workspace candidate and refuses to trust the caller", async () => {
  const fx = await fixture();
  const foreign = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-foreign" });
    const candidateId = evolved.candidate.candidateId;
    const { code, envelope } = await cli(["run", "replay-score", "--run-root", evolved.runRoot, "--workspace", foreign.workspace, "--candidate", candidateId, "--output", path.join(fx.root, "out"), "--json"]);
    assert.equal(code, 1);
    assert.match(envelope.blockers.join("\n"), /Candidate cannot be verified/u);
    assert.equal(await fs.access(path.join(fx.root, "out")).then(() => true, () => false), false);
  } finally {
    for (const root of [fx.root, foreign.root]) {
      await makeWritable(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("replay-score fails closed on drifted runner implementations and missing runtime identity", async () => {
  const drift = await fixture();
  const identity = await fixture();
  try {
    const registry = createCapabilityRegistry();
    registry.registerRunner({ ref: "provider:codex", apiVersion: "wikiskill.runner.v1", implementationVersion: "test", implementationDigest: `sha256:${"a".repeat(64)}` }, () => createCodexRunner({ executable: process.execPath, executableArgs: [drift.scriptPath], timeoutMs: 60_000, reasoningEffort: "unspecified" }));
    registry.registerScorer({ ref: "builtin:operational-milestone-v1", apiVersion: "wikiskill.scorer.v1", implementationVersion: "test", implementationDigest: `sha256:${"b".repeat(64)}` }, () => createOperationalMilestoneScorer());
    registry.seal();
    const drifted = await evolve(drift, { runId: "replay-drift", registry });
    const driftedCandidate = drifted.candidate.candidateId;
    assert.deepEqual(auditRun(drifted.runRoot, { workspace: drift.workspace, candidate: driftedCandidate }).blockers, []);
    const driftResult = await cli(replayArgs({ ...drift, runRoot: drifted.runRoot }, driftedCandidate, path.join(drift.root, "out")));
    assert.equal(driftResult.code, 1);
    assert.match(driftResult.envelope.blockers.join("\n"), /runner implementation digest differs from the frozen run/u);

    const evolved = await evolve(identity, { runId: "replay-identity" });
    const manifestPath = path.join(evolved.runRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.runtime;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const missing = await cli(replayArgs({ ...identity, runRoot: evolved.runRoot }, evolved.candidate.candidateId, path.join(identity.root, "out")));
    assert.equal(missing.code, 1);
    assert.match(missing.envelope.blockers.join("\n"), /lacks manifest\.runtime identity/u);

    const usage = await cli(["run", "replay-score", "--run-root", evolved.runRoot, "--workspace", identity.workspace, "--candidate", evolved.candidate.candidateId]);
    assert.equal(usage.code, 1);
    assert.match(usage.envelope.blockers.join("\n"), /requires --run-root, --workspace, --candidate, and --output/u);
  } finally {
    for (const root of [drift.root, identity.root]) {
      await makeWritable(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("replay-score blocks a frozen task-set rewrite that swaps the verifier under the same task id", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-verifier-swap" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const taskSetPath = path.join(evolved.runRoot, "tasks", "task-set.json");
    const taskSet = JSON.parse(await fs.readFile(taskSetPath, "utf8"));
    const testTask = taskSet.tasks.find((task) => task.id === "op-test-1");
    testTask.groundTruth.milestoneOrder = ["M0"];
    await fs.writeFile(taskSetPath, canonicalJson(taskSet));
    const output = path.join(fx.root, "replay-out");
    const { code, envelope } = await cli(replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output));
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /task-set bytes differ from the manifest frozen task-set digest/u);
    assert.equal(await fs.access(output).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score blocks a frozen task-set rewrite that swaps the sandbox under the same task id", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-sandbox-swap" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const taskSetPath = path.join(evolved.runRoot, "tasks", "task-set.json");
    const taskSet = JSON.parse(await fs.readFile(taskSetPath, "utf8"));
    const testTask = taskSet.tasks.find((task) => task.id === "op-test-1");
    testTask.sandbox["progress.json"] = "{\"level\":2}\n";
    await fs.writeFile(taskSetPath, canonicalJson(taskSet));
    const output = path.join(fx.root, "replay-out");
    const { code, envelope } = await cli(replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output));
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /task-set bytes differ from the manifest frozen task-set digest/u);
    assert.equal(await fs.access(output).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score refuses runs predating frozen task-set digests while run audit stays compatible", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-legacy" });
    const candidateId = evolved.candidate.candidateId;
    await stripTaskSetEvidence(evolved.runRoot);

    const audit = await cli(["run", "audit", "--run-root", evolved.runRoot, "--workspace", fx.workspace, "--candidate", candidateId, "--json"]);
    assert.equal(audit.code, 0, JSON.stringify(audit.envelope));
    assert.equal(audit.envelope.success, true);
    assert.match(audit.envelope.warnings.join("\n"), /predates frozen task-set byte digests/u);

    const output = path.join(fx.root, "replay-out");
    const replay = await cli(replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output));
    assert.equal(replay.code, 1);
    assert.equal(replay.envelope.success, false);
    assert.match(replay.envelope.blockers.join("\n"), /predates that evidence/u);
    assert.equal(await fs.access(output).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score fails closed on command-exit runs before any Provider launch", async () => {
  const fx = await fixture({ scorerRef: "builtin:command-exit-v1" });
  try {
    const evolved = await evolve(fx, { runId: "replay-command-exit", scorerRef: "builtin:command-exit-v1" });
    const output = path.join(fx.root, "replay-out");
    const { code, envelope } = await cli(["run", "replay-score", "--run-root", evolved.runRoot, "--workspace", fx.workspace, "--candidate", "candidate-irrelevant", "--output", output, "--json"]);
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /Replay supports only builtin:operational-milestone-v1/u);
    assert.match(envelope.blockers.join("\n"), /builtin:command-exit-v1/u);
    assert.equal(await fs.access(output).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score fails closed when the Provider reports no session identity", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-no-session" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    await fs.writeFile(fx.scriptPath, FAKE_CODEX.replace(/^\s*\{ type: "thread\.started", thread_id: threadId \},\r?\n/mu, ""));
    const output = path.join(fx.root, "replay-out");
    const { code, envelope } = await cli(replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output));
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /Replay execution failed/u);
    assert.match(envelope.blockers.join("\n"), /thread\.started/u);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score fails closed when a replay reuses a Provider session from the audited run", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-session-reuse" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const state = JSON.parse(await fs.readFile(path.join(evolved.runRoot, "runs", "state.json"), "utf8"));
    const auditedSessionId = state.runtimeSessions[0].provider.sessionId;
    await fs.writeFile(fx.scriptPath, FAKE_CODEX.replace(/const threadId = [^;]+;/u, `const threadId = ${JSON.stringify(auditedSessionId)};`));
    const output = path.join(fx.root, "replay-out");
    const { code, envelope } = await cli(replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output));
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /reused from the audited run/u);
    const replayEvidence = JSON.parse(await fs.readFile(path.join(output, "replay.json"), "utf8").catch(() => "null"));
    assert.equal(replayEvidence, null);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score cross-checks audited Provider session evidence across state, Raw traces, and runtime evidence before launching", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-session-evidence" });
    const candidateId = evolved.candidate.candidateId;
    const statePath = path.join(evolved.runRoot, "runs", "state.json");
    const evidencePath = path.join(evolved.runRoot, "result", "runtime-evidence.json");
    const pristineState = await fs.readFile(statePath, "utf8");
    const pristineEvidence = await fs.readFile(evidencePath, "utf8");
    const restore = async () => {
      await fs.writeFile(statePath, pristineState);
      await fs.writeFile(evidencePath, pristineEvidence);
    };
    const args = { ...fx, runRoot: evolved.runRoot };
    const replayInto = (name) => cli(replayArgs(args, candidateId, path.join(fx.root, name)));

    let state = JSON.parse(pristineState);
    state.runtimeSessions.pop();
    await fs.writeFile(statePath, canonicalJson(state));
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const deleted = await replayInto("out-deleted");
    assert.equal(deleted.code, 1);
    assert.match(deleted.envelope.blockers.join("\n"), /Provider session evidence differs between run state runtimeSessions and run state inference invocations/u);
    assert.equal(await fs.access(path.join(fx.root, "out-deleted")).then(() => true, () => false), false);

    await restore();
    state = JSON.parse(pristineState);
    state.runtimeSessions.push(state.runtimeSessions[0]);
    await fs.writeFile(statePath, canonicalJson(state));
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const duplicated = await replayInto("out-duplicated");
    assert.equal(duplicated.code, 1);
    assert.match(duplicated.envelope.blockers.join("\n"), /Provider session appears more than once in run state runtimeSessions/u);
    assert.equal(await fs.access(path.join(fx.root, "out-duplicated")).then(() => true, () => false), false);

    await restore();
    state = JSON.parse(pristineState);
    state.inferenceInvocations[0].provider.sessionId = "reusable-hidden-session";
    await fs.writeFile(statePath, canonicalJson(state));
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const rewritten = await replayInto("out-rewritten");
    assert.equal(rewritten.code, 1);
    assert.match(rewritten.envelope.blockers.join("\n"), /Provider session or task binding for launch .* differs between run state inference invocations and Raw traces/u);
    assert.equal(await fs.access(path.join(fx.root, "out-rewritten")).then(() => true, () => false), false);

    await restore();
    state = JSON.parse(pristineState);
    delete state.inferenceInvocations[1].provider;
    await fs.writeFile(statePath, canonicalJson(state));
    const stripped = await replayInto("out-stripped");
    assert.equal(stripped.code, 1);
    assert.match(stripped.envelope.blockers.join("\n"), /run state inference invocation .* carries no usable Provider session identity/u);
    assert.equal(await fs.access(path.join(fx.root, "out-stripped")).then(() => true, () => false), false);

    await restore();
    const evidence = JSON.parse(pristineEvidence);
    evidence.inference.pop();
    await fs.writeFile(evidencePath, canonicalJson(evidence));
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const removed = await replayInto("out-removed-evidence");
    assert.equal(removed.code, 1);
    assert.match(removed.envelope.blockers.join("\n"), /Provider launch evidence differs between run state inference invocations and run runtime evidence/u);
    assert.equal(await fs.access(path.join(fx.root, "out-removed-evidence")).then(() => true, () => false), false);

    await restore();
    const tracePath = path.join(evolved.runRoot, "raw", "traces", "final-baseline", "test", "op-test-1.json");
    const trace = JSON.parse(await fs.readFile(tracePath, "utf8"));
    trace.provider.sessionId = "forged-raw-session";
    await fs.writeFile(tracePath, canonicalJson(trace));
    assert.notDeepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const rawRewritten = await replayInto("out-raw-rewritten");
    assert.equal(rawRewritten.code, 1);
    assert.match(rawRewritten.envelope.blockers.join("\n"), /Terminal run Raw tree content differs from the persisted Raw authority/u);
    assert.equal(await fs.access(path.join(fx.root, "out-raw-rewritten")).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score enforces its total wall-clock budget by killing the running Provider launch and blocking later ones", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-wall-clock" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    await fs.writeFile(fx.scriptPath, FAKE_CODEX_HANG);
    const output = path.join(fx.root, "replay-out");
    const startedAt = Date.now();
    const { code, envelope } = await cli([...replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output), "--timeout-ms", "1000"]);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(code, 1);
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /Replay exceeded its total wall-clock budget of 1000ms/u);
    assert.equal(elapsedMs < 30_000, true);
    const pids = (await fs.readFile(path.join(fx.root, "hang-pids.log"), "utf8")).trim().split("\n").map(Number);
    assert.equal(pids.length, 1);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
    assert.equal(await fs.readFile(path.join(fx.root, "hang-signals.log"), "utf8").then((value) => value.trim()), "term");
    assert.equal(await fs.access(path.join(output, "replay.json")).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(output, "raw", "traces", "baseline", "test", "op-test-1.json")).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score merges an operator abort signal, terminating the running Provider launch and blocking later ones", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-operator-abort" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    await fs.writeFile(fx.scriptPath, FAKE_CODEX_HANG);
    const output = path.join(fx.root, "replay-out");
    const controller = new AbortController();
    const pending = replayCandidateScore({
      runRoot: evolved.runRoot,
      workspace: fx.workspace,
      candidate: candidateId,
      output,
      abortSignal: controller.signal
    });
    const pidsPath = path.join(fx.root, "hang-pids.log");
    const launched = await waitFor(() => fs.readFile(pidsPath, "utf8").then((value) => value.trim().length > 0, () => false));
    assert.equal(launched, true);
    controller.abort();
    const result = await pending;
    assert.equal(result.data, null);
    assert.match(result.blockers.join("\n"), /cancelled by an operator interrupt \(SIGINT or SIGTERM\)/u);
    const pids = (await fs.readFile(pidsPath, "utf8")).trim().split("\n").map(Number);
    assert.equal(pids.length, 1);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
    assert.equal(await fs.readFile(path.join(fx.root, "hang-signals.log"), "utf8").then((value) => value.trim()), "term");
    assert.equal(await fs.access(path.join(output, "replay.json")).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score CLI drains the Provider and exits non-zero with a cancelled blocker on SIGINT", async () => {
  const fx = await fixture();
  let child;
  try {
    const evolved = await evolve(fx, { runId: "replay-cli-sigint" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    await fs.writeFile(fx.scriptPath, FAKE_CODEX_HANG);
    const output = path.join(fx.root, "replay-out");
    child = childProcess.spawn(process.execPath, [path.join(__dirname, "..", "bin", "wikiskill"),
      ...replayArgs({ ...fx, runRoot: evolved.runRoot }, candidateId, output), "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const pidsPath = path.join(fx.root, "hang-pids.log");
    assert.equal(await waitFor(() => fs.readFile(pidsPath, "utf8").then((value) => value.trim().length > 0, () => false)), true);
    child.kill("SIGINT");
    const { code, signal } = await Promise.race([exited, waitFor(() => false, { timeoutMs: 30_000 }).then(() => ({ code: null, signal: "timeout" }))]);
    assert.equal(signal, null);
    assert.equal(code, 1);
    const envelope = JSON.parse(stdout.join(""));
    assert.equal(envelope.success, false);
    assert.match(envelope.blockers.join("\n"), /cancelled by an operator interrupt \(SIGINT or SIGTERM\)/u);
    const pids = (await fs.readFile(pidsPath, "utf8")).trim().split("\n").map(Number);
    assert.equal(pids.length, 1);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
    assert.equal(await fs.readFile(path.join(fx.root, "hang-signals.log"), "utf8").then((value) => value.trim()), "term");
    assert.equal(await fs.access(path.join(output, "replay.json")).then(() => true, () => false), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score accepts only wall-clock budgets between the minimum and the default cap", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-timeout-param" });
    const candidateId = evolved.candidate.candidateId;
    const args = { ...fx, runRoot: evolved.runRoot };
    for (const value of ["999", "7200001", "abc"]) {
      const result = await cli([...replayArgs(args, candidateId, path.join(fx.root, `out-${value}`)), "--timeout-ms", value]);
      assert.equal(result.code, 1, value);
      assert.match(result.envelope.blockers.join("\n"), /Replay --timeout-ms must be between 1000 and 7200000 milliseconds/u);
    }
    assert.equal(await fs.access(path.join(fx.root, "out-999")).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(fx.root, "out-7200001")).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score writes into an exclusive fresh directory under its controlled physical parent", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-physical-output" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const args = { ...fx, runRoot: evolved.runRoot };

    const nestedParent = path.join(fx.root, "nested", "deeper");
    await fs.mkdir(nestedParent, { recursive: true });
    const nested = path.join(nestedParent, "replay-out");
    const nestedResult = await cli(replayArgs(args, candidateId, nested));
    assert.equal(nestedResult.code, 0, JSON.stringify(nestedResult.envelope));
    await fs.access(path.join(nested, "replay.json"));
    assert.equal(nestedResult.envelope.data.evidence.replayRoot, await fs.realpath(nested));
    assert.equal(path.relative(nestedResult.envelope.data.evidence.replayRoot, await fs.realpath(path.join(nested, "accounting", "provider-launches.jsonl"))), path.join("accounting", "provider-launches.jsonl"));

    const linkParent = path.join(fx.root, "out-link");
    await fs.symlink(nestedParent, linkParent);
    const throughLink = path.join(linkParent, "replay-out-2");
    const linkedResult = await cli(replayArgs(args, candidateId, throughLink));
    assert.equal(linkedResult.code, 0, JSON.stringify(linkedResult.envelope));
    assert.equal(linkedResult.envelope.data.evidence.replayRoot, await fs.realpath(throughLink));
    await fs.access(path.join(throughLink, "replay.json"));
    await fs.access(path.join(fx.root, "nested", "deeper", "replay-out-2", "replay.json"));
    assert.equal(path.relative(linkedResult.envelope.data.evidence.replayRoot, await fs.realpath(path.join(nestedParent, "replay-out-2", "accounting", "provider-launches.jsonl"))), path.join("accounting", "provider-launches.jsonl"));

    const rerun = await cli(replayArgs(args, candidateId, throughLink));
    assert.equal(rerun.code, 1);
    assert.match(rerun.envelope.blockers.join("\n"), /already exists/u);
    await fs.rm(linkParent);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score rejects output paths inside protected trees, including symlinked parents, without polluting them", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-placement" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const args = { ...fx, runRoot: evolved.runRoot };
    const runRootDigest = treeDigest(evolved.runRoot);

    const insideRun = await cli(replayArgs(args, candidateId, path.join(evolved.runRoot, "replay-out")));
    assert.equal(insideRun.code, 1);
    assert.match(insideRun.envelope.blockers.join("\n"), /must live physically outside the audited run tree/u);

    const insideAuthority = await cli(replayArgs(args, candidateId, path.join(fx.workspace, ".wikiskill", "raw", "replay-out")));
    assert.equal(insideAuthority.code, 1);
    assert.match(insideAuthority.envelope.blockers.join("\n"), /must live physically outside the Workspace \.wikiskill authority tree/u);

    const linkPath = path.join(fx.root, "run-link");
    await fs.symlink(evolved.runRoot, linkPath);
    const throughSymlink = await cli(replayArgs(args, candidateId, path.join(linkPath, "replay-out")));
    assert.equal(throughSymlink.code, 1);
    assert.match(throughSymlink.envelope.blockers.join("\n"), /must live physically outside the audited run tree/u);
    await fs.rm(linkPath);

    assert.equal(treeDigest(evolved.runRoot), runRootDigest);
    assert.equal(await fs.access(path.join(evolved.runRoot, "replay-out")).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(fx.workspace, ".wikiskill", "raw", "replay-out")).then(() => true, () => false), false);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("replay-score requires a host-created output parent and never creates path segments toward protected trees", async () => {
  const fx = await fixture();
  try {
    const evolved = await evolve(fx, { runId: "replay-parent-boundary" });
    const candidateId = evolved.candidate.candidateId;
    assert.deepEqual(auditRun(evolved.runRoot, { workspace: fx.workspace, candidate: candidateId }).blockers, []);
    const args = { ...fx, runRoot: evolved.runRoot };
    const runRootDigest = treeDigest(evolved.runRoot);

    const missingParent = await cli(replayArgs(args, candidateId, path.join(fx.root, "absent-parent", "replay-out")));
    assert.equal(missingParent.code, 1);
    assert.match(missingParent.envelope.blockers.join("\n"), /parent directory does not exist/u);
    assert.equal(await fs.access(path.join(fx.root, "absent-parent")).then(() => true, () => false), false);

    const insideRun = await cli(replayArgs(args, candidateId, path.join(evolved.runRoot, "absent-parent", "replay-out")));
    assert.equal(insideRun.code, 1);
    assert.match(insideRun.envelope.blockers.join("\n"), /must live physically outside the audited run tree/u);
    assert.equal(await fs.access(path.join(evolved.runRoot, "absent-parent")).then(() => true, () => false), false);

    const insideAuthority = await cli(replayArgs(args, candidateId, path.join(fx.workspace, ".wikiskill", "absent-parent", "replay-out")));
    assert.equal(insideAuthority.code, 1);
    assert.match(insideAuthority.envelope.blockers.join("\n"), /must live physically outside the Workspace \.wikiskill authority tree/u);
    assert.equal(await fs.access(path.join(fx.workspace, ".wikiskill", "absent-parent")).then(() => true, () => false), false);
    assert.equal(treeDigest(evolved.runRoot), runRootDigest);
  } finally {
    await makeWritable(fx.root);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});
