"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const core = require("./index");
const { auditRun } = require("./audit/run");
const { createRuntimeAdapter, loadWorkspace, treeDigest } = require("./evolution");
const { createBuiltinCapabilityRegistry, runnerRefForProvider, validateBuiltinScorerInput } = require("./runtime-capabilities");
const { createProviderLaunchBudget } = require("./provider-launch-budget");
const { aggregateOperationalOutcomes, compareOperationalAggregates, isOperationalOutcome } = require("./operational-outcome");
const { readSkillFiles, skillSetDigest } = require("./skill-bundle");

const HEX64 = /^[0-9a-f]{64}$/u;
const REPLAY_SCORER = "builtin:operational-milestone-v1";
const REPLAY_TIMEOUT_DEFAULT_MS = 7_200_000;
const readJson = async (target) => JSON.parse(await fs.readFile(target, "utf8"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const digestHex = (value) => crypto.createHash("sha256").update(value).digest("hex");
const contains = (root, child) => child === root || child.startsWith(`${root}${path.sep}`);

const physicalTarget = async (target) => {
  const missing = [];
  let current = path.resolve(target);
  while (!(await fs.lstat(current).catch(() => null))) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const realAncestor = await fs.realpath(current);
  return missing.length ? path.join(realAncestor, ...missing) : realAncestor;
};

const listTraceFiles = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
    }
  };
  await visit(root);
  return files.sort();
};

const collectAuditedSessions = async ({ runRoot, manifest, state }) => {
  const runtime = manifest.runtime;
  const blockers = [];
  const sourceOf = () => ({ sessions: new Map(), launches: new Map() });
  const inference = { sessions: sourceOf(), invocations: sourceOf(), traces: sourceOf(), evidence: sourceOf() };
  const learning = { sessions: sourceOf(), invocations: sourceOf(), evidence: sourceOf() };
  const identityOf = (entry, label) => {
    const provider = entry?.provider;
    if (!provider || typeof provider.ref !== "string" || !provider.ref.trim() || typeof provider.modelId !== "string" || !provider.modelId.trim() || typeof provider.sessionId !== "string" || !provider.sessionId.trim()) {
      blockers.push(`${label} carries no usable Provider session identity.`);
      return null;
    }
    const identity = { ref: provider.ref.trim(), modelId: provider.modelId.trim(), sessionId: provider.sessionId.trim() };
    if (identity.ref !== runtime.runnerRef || identity.modelId !== runtime.modelId) {
      blockers.push(`${label} Provider identity differs from the frozen runtime cohort: ${identity.ref}/${identity.modelId}.`);
      return null;
    }
    return identity;
  };
  const record = (source, identity, launchRef, meta, label) => {
    const key = `${identity.ref}\0${identity.sessionId}`;
    if (source.sessions.has(key)) blockers.push(`Provider session appears more than once in ${label}: ${key.split("\0").join("/")}.`);
    else source.sessions.set(key, label);
    if (launchRef === undefined) return;
    if (typeof launchRef !== "string" || !launchRef.trim()) {
      blockers.push(`${label} carries no launch reference.`);
      return;
    }
    const value = JSON.stringify([key, meta]);
    if (source.launches.has(launchRef)) blockers.push(`Provider launch appears more than once in ${label}: ${launchRef}.`);
    else source.launches.set(launchRef, value);
  };
  const inferenceMeta = (value) => [value.taskId, value.split, value.phase, value.iteration, value.rollout];

  if (!Array.isArray(state.runtimeSessions)) blockers.push("Run state is missing its runtimeSessions evidence.");
  for (const [index, entry] of (Array.isArray(state.runtimeSessions) ? state.runtimeSessions : []).entries()) {
    const label = `run state runtimeSessions entry ${index}`;
    const identity = identityOf(entry, label);
    if (!identity) continue;
    if (entry.kind === "inference") record(inference.sessions, identity, undefined, null, label);
    else if (entry.kind === "learning") record(learning.sessions, identity, undefined, null, label);
    else blockers.push(`${label} declares an unknown session kind: ${String(entry.kind)}.`);
  }
  for (const [index, entry] of (Array.isArray(state.inferenceInvocations) ? state.inferenceInvocations : []).entries()) {
    const label = `run state inference invocation ${String(entry?.launchRef ?? index)}`;
    const identity = identityOf(entry, label);
    if (identity) record(inference.invocations, identity, entry.launchRef, inferenceMeta(entry), label);
  }
  for (const [index, entry] of (Array.isArray(state.learningInvocations) ? state.learningInvocations : []).entries()) {
    const label = `run state learning invocation ${String(entry?.launchRef ?? index)}`;
    const identity = identityOf(entry, label);
    if (identity) record(learning.invocations, identity, entry.launchRef, [entry.role], label);
  }
  for (const file of await listTraceFiles(path.join(runRoot, "raw", "traces"))) {
    const relative = path.relative(runRoot, file).split(path.sep).join("/");
    let trace = null;
    try {
      trace = await readJson(file);
    } catch {
      blockers.push(`Raw trace cannot be parsed: ${relative}`);
      continue;
    }
    const label = `Raw trace ${String(trace?.id ?? relative)}`;
    const identity = identityOf(trace, label);
    if (identity) record(inference.traces, identity, trace.launchRef, inferenceMeta(trace), label);
  }
  let runtimeEvidence = null;
  try {
    runtimeEvidence = await readJson(path.join(runRoot, "result", "runtime-evidence.json"));
  } catch {
    blockers.push("Run result runtime-evidence.json is missing or unreadable.");
  }
  if (runtimeEvidence) {
    if (runtimeEvidence.schema !== "wikiskill.runtime-evidence.v2" || runtimeEvidence.runId !== manifest.runId) blockers.push("Run runtime evidence identity is invalid.");
    if (!Array.isArray(runtimeEvidence.inference)) blockers.push("Run runtime evidence is missing its inference records.");
    else for (const [index, entry] of runtimeEvidence.inference.entries()) {
      const label = `run runtime evidence inference record ${String(entry?.launchRef ?? index)}`;
      const identity = identityOf(entry, label);
      if (identity) record(inference.evidence, identity, entry.launchRef, inferenceMeta(entry), label);
    }
    if (!Array.isArray(runtimeEvidence.learning)) blockers.push("Run runtime evidence is missing its learning records.");
    else for (const [index, entry] of runtimeEvidence.learning.entries()) {
      const label = `run runtime evidence learning record ${String(entry?.launchRef ?? index)}`;
      const identity = identityOf(entry, label);
      if (identity) record(learning.evidence, identity, entry.launchRef, [entry.role], label);
    }
  }

  const sortedKeys = (source) => [...source.sessions.keys()].sort();
  const sameSessions = (left, right, leftLabel, rightLabel) => {
    if (JSON.stringify(sortedKeys(left)) !== JSON.stringify(sortedKeys(right))) {
      blockers.push(`Provider session evidence differs between ${leftLabel} and ${rightLabel}; sessions are missing, duplicated, or were removed.`);
    }
  };
  const sameLaunches = (left, right, leftLabel, rightLabel) => {
    const leftRefs = [...left.launches.keys()].sort();
    if (JSON.stringify(leftRefs) !== JSON.stringify([...right.launches.keys()].sort())) {
      blockers.push(`Provider launch evidence differs between ${leftLabel} and ${rightLabel}; launches are missing or duplicated.`);
      return;
    }
    for (const [launchRef, value] of left.launches) if (right.launches.get(launchRef) !== value) {
      blockers.push(`Provider session or task binding for launch ${launchRef} differs between ${leftLabel} and ${rightLabel}.`);
    }
  };
  sameLaunches(inference.invocations, inference.traces, "run state inference invocations", "Raw traces");
  sameLaunches(inference.invocations, inference.evidence, "run state inference invocations", "run runtime evidence");
  sameSessions(inference.sessions, inference.invocations, "run state runtimeSessions", "run state inference invocations");
  sameSessions(inference.traces, inference.invocations, "Raw traces", "run state inference invocations");
  sameSessions(inference.evidence, inference.invocations, "run runtime evidence", "run state inference invocations");
  sameLaunches(learning.invocations, learning.evidence, "run state learning invocations", "run runtime evidence");
  sameSessions(learning.sessions, learning.invocations, "run state runtimeSessions", "run state learning invocations");
  sameSessions(learning.evidence, learning.invocations, "run runtime evidence", "run state learning invocations");
  const keys = new Set([
    ...inference.sessions.sessions.keys(), ...inference.invocations.sessions.keys(), ...inference.traces.sessions.keys(), ...inference.evidence.sessions.keys(),
    ...learning.sessions.sessions.keys(), ...learning.invocations.sessions.keys(), ...learning.evidence.sessions.keys()
  ]);
  return { blockers, keys };
};

const readSkillTrees = async (root) => {
  const trees = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Replay Skill root has an invalid entry: ${path.join(root, entry.name)}`);
    trees[entry.name] = await readSkillFiles(path.join(root, entry.name));
  }
  return trees;
};

const replayCandidateScore = async ({ runRoot: runRootInput, workspace: workspaceInput, candidate, output: outputInput, runnerTimeoutMs, timeoutMs, abortSignal } = {}) => {
  const blockers = [];
  const warnings = [];
  const runRoot = path.resolve(runRootInput);
  const output = path.resolve(outputInput);
  const fail = (nextActions) => ({ data: null, warnings, blockers: [...new Set(blockers)], nextActions });

  const manifest = await readJson(path.join(runRoot, "manifest.json"));
  const state = await readJson(path.join(runRoot, "runs", "state.json"));
  const runtime = manifest.runtime;

  if (!manifest.runtime) blockers.push("Replay supports only runs with a frozen runtime cohort; this run lacks manifest.runtime identity.");
  if (manifest.runnerModule || manifest.agentRunner || manifest.adapterModule) blockers.push("Replay does not support module-declared runner or adapter components; only frozen runtime-cohort runs can be replayed.");
  if (!manifest.frozenComponents) blockers.push("Replay requires the run frozen component digests; manifest.frozenComponents is missing.");
  if (runtime && runtime.scorerRef !== REPLAY_SCORER) blockers.push(`Replay supports only ${REPLAY_SCORER} held-out scoring; this run froze ${String(runtime.scorerRef)}, which replay cannot independently re-execute.`);
  if (blockers.length) return fail(["Re-run the evolution through the runtime-cohort CLI path with the operational milestone scorer, then request a replay."]);

  for (const key of ["provider", "modelId", "reasoningEffort", "scorerRef", "toolProfile"]) {
    if (typeof runtime[key] !== "string" || !runtime[key].trim()) blockers.push(`Run runtime cohort identity is missing ${key}.`);
  }
  if (blockers.length) return fail([]);
  if (!["codex", "claude"].includes(runtime.provider)) blockers.push(`Replay has no runner capability for provider: ${runtime.provider}.`);
  if (runnerRefForProvider(runtime.provider) !== runtime.runnerRef) blockers.push("Run runtime runner ref does not match its provider.");
  if (runtime.toolProfile !== "workspace") blockers.push("Replay requires the workspace tool profile for operational held-out evaluation.");
  if (manifest.evaluationRolloutsPerTask !== 1) blockers.push("Replay supports exactly one evaluation rollout per held-out task.");
  if (runnerTimeoutMs !== undefined && (!/^\d+$/u.test(runnerTimeoutMs) || Number(runnerTimeoutMs) < 1_000 || Number(runnerTimeoutMs) > 3_600_000)) blockers.push("Replay --runner-timeout-ms must be between 1000 and 3600000.");
  const wallClockMs = timeoutMs === undefined ? REPLAY_TIMEOUT_DEFAULT_MS : Number(timeoutMs);
  if (timeoutMs !== undefined && (!/^\d+$/u.test(String(timeoutMs)) || !Number.isSafeInteger(wallClockMs) || wallClockMs < 1_000 || wallClockMs > REPLAY_TIMEOUT_DEFAULT_MS)) {
    blockers.push(`Replay --timeout-ms must be between 1000 and ${REPLAY_TIMEOUT_DEFAULT_MS} milliseconds and never exceeds the default total wall-clock budget.`);
  }
  if (blockers.length) return fail([]);

  const audit = auditRun(runRoot, { workspace: workspaceInput, candidate });
  blockers.push(...audit.blockers);
  if (blockers.length) return fail(["Resolve the run audit blockers before requesting an independent replay."]);
  warnings.push(...audit.warnings);

  const audited = await collectAuditedSessions({ runRoot, manifest, state });
  blockers.push(...audited.blockers);
  if (blockers.length) return fail(["The audited run Provider session evidence is incomplete or inconsistent across state, Raw traces, and runtime evidence; replay refuses to treat it as the fresh-session baseline."]);

  const { workspace, config } = await loadWorkspace(workspaceInput);
  const evolutionConfig = config.evolution || {};
  const runnerConfig = {
    ...(evolutionConfig.runtime?.runnerConfig || {}),
    ...(runnerTimeoutMs === undefined ? {} : { timeoutMs: Number(runnerTimeoutMs) }),
    reasoningEffort: runtime.reasoningEffort
  };
  const scorerConfig = evolutionConfig.runtime?.scorerConfig || {};
  const model = { id: runtime.modelId, reasoningEffort: runtime.reasoningEffort };
  if (digest(JSON.stringify({ descriptor: runtime.runner, config: runnerConfig })) !== manifest.frozenComponents.runner) {
    blockers.push("Rebuilt runner configuration does not match the run frozen runner component; pass the original --runner-timeout-ms if the run used one.");
  }
  if (digest(JSON.stringify({ descriptor: runtime.scorer, config: scorerConfig })) !== manifest.frozenComponents.adapter) {
    blockers.push("Rebuilt scorer configuration does not match the run frozen adapter component.");
  }
  if (digest(JSON.stringify(model)) !== manifest.frozenComponents.model) blockers.push("Rebuilt model identity does not match the run frozen model component.");
  if (blockers.length) return fail(["Replay refuses to score with a component identity that differs from the audited run."]);

  const taskSetPath = path.join(runRoot, "tasks", "task-set.json");
  const taskSetText = await fs.readFile(taskSetPath, "utf8");
  const datasetFileDigest = digest(taskSetText);
  if (typeof manifest.dataset?.taskSetDigest !== "string" || !HEX64.test(manifest.dataset.taskSetDigest)) {
    blockers.push("Replay requires the run frozen task-set byte digest (manifest.dataset.taskSetDigest); this run predates that evidence, so the held-out task content cannot be verified.");
  } else if (digestHex(taskSetText) !== manifest.dataset.taskSetDigest) {
    blockers.push("Frozen task-set bytes differ from the run manifest digest; the held-out tasks may have drifted after the audited run.");
  }
  if (blockers.length) return fail(["The frozen held-out tasks cannot be verified for replay; re-run the evolution to freeze fresh task-set evidence."]);
  const dataset = core.validateDataset(JSON.parse(taskSetText));
  const testTasks = dataset.tasks.filter((task) => task.split === "test");
  const recordedTestTaskIds = [...new Set((state.inferenceInvocations || []).filter((item) => item.split === "test" && item.phase === "baseline_test").map((item) => item.taskId))].sort();
  if (JSON.stringify(testTasks.map((task) => task.id).sort()) !== JSON.stringify(recordedTestTaskIds)) blockers.push("Frozen test split differs from the audited run test invocations.");
  if (!testTasks.length) blockers.push("Replay requires held-out test tasks.");
  if (testTasks.some((task) => task.evaluator.capabilityRef !== runtime.scorerRef)) blockers.push("Held-out task scorer refs differ from the frozen runtime cohort.");
  for (const task of testTasks) {
    try { validateBuiltinScorerInput(runtime.scorerRef, task.groundTruth); } catch (error) {
      blockers.push(`Frozen held-out task ${task.id} cannot be scored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (blockers.length) return fail([]);

  const outputStat = await fs.lstat(output).catch(() => null);
  if (outputStat) blockers.push(`Replay output directory already exists: ${output}.`);
  let protectedRoots = [];
  try {
    protectedRoots = [
      { label: "the audited run tree", root: await fs.realpath(runRoot) },
      { label: "the Workspace .wikiskill authority tree (skills, wiki, candidates, Raw)", root: await fs.realpath(path.join(workspace, ".wikiskill")) }
    ];
    const plannedOutput = await physicalTarget(output);
    for (const { label, root } of protectedRoots) if (contains(root, plannedOutput)) blockers.push(`Replay --output must live physically outside ${label}.`);
  } catch (error) {
    blockers.push(`Replay --output path cannot be resolved physically: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (blockers.length) return fail(["Pass a fresh output directory outside the audited run tree and the Workspace authority trees for each independent replay."]);

  const staged = await readJson(path.join(workspace, ".wikiskill", "candidates", candidate, "candidate.json"));
  const candidateRoot = path.join(workspace, ".wikiskill", "candidates", candidate);
  const runRootDigestBefore = treeDigest(runRoot);
  const candidateDigestBefore = treeDigest(candidateRoot);
  const replayId = `replay-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const outputParent = path.dirname(output);
  const physicalParent = await fs.realpath(outputParent).catch(() => null);
  if (!physicalParent) {
    blockers.push(`Replay --output parent directory does not exist; the host must create the dedicated parent in advance: ${outputParent}.`);
    return fail(["Create the dedicated output parent directory outside the audited run tree and the Workspace authority trees first, then replay into a fresh directory inside it."]);
  }
  const outputRoot = path.join(physicalParent, path.basename(output));
  for (const { label, root } of protectedRoots) if (contains(root, outputRoot)) {
    blockers.push(`Replay --output must live physically outside ${label}.`);
    return fail(["Pass a fresh output directory outside the audited run tree and the Workspace authority trees for each independent replay."]);
  }
  try {
    await fs.mkdir(outputRoot);
  } catch (error) {
    blockers.push(`Replay output directory could not be created exclusively: ${error instanceof Error ? error.message : String(error)}`);
    return fail(["Pass a fresh output directory outside the audited run tree and the Workspace authority trees for each independent replay."]);
  }
  const realOutput = await fs.realpath(outputRoot).catch(() => null);
  if (realOutput !== outputRoot || protectedRoots.some(({ root }) => contains(root, realOutput))) {
    blockers.push("Replay output directory resolves through a symlink after creation; replay must write only into the fresh physical directory it created.");
    return fail(["Pass a fresh output directory outside the audited run tree and the Workspace authority trees for each independent replay."]);
  }

  const budget = createProviderLaunchBudget({
    root: path.join(outputRoot, "accounting"),
    runId: replayId,
    provider: runtime.provider,
    modelId: runtime.modelId,
    reasoningEffort: runtime.reasoningEffort,
    limit: runtime.launchBudget?.limit && Number.isSafeInteger(runtime.launchBudget.limit) && runtime.launchBudget.limit >= 1 ? runtime.launchBudget.limit : 10_000
  });
  const registry = createBuiltinCapabilityRegistry();
  const resolvedRunner = registry.resolveRunner(runnerRefForProvider(runtime.provider), { ...runnerConfig, providerLaunchBudget: budget });
  const resolvedScorer = registry.resolveScorer(runtime.scorerRef, scorerConfig);
  if (JSON.stringify(resolvedRunner.descriptor) !== JSON.stringify(runtime.runner)) {
    blockers.push("Current runner implementation digest differs from the frozen run runner identity.");
  }
  if (JSON.stringify(resolvedScorer.descriptor) !== JSON.stringify(runtime.scorer)) {
    blockers.push("Current scorer implementation digest differs from the frozen run scorer identity.");
  }
  if (blockers.length) return fail(["Update this WikiSkill installation to the frozen implementation, or re-evolve the candidate with it."]);

  const runner = resolvedRunner.run;
  const adapter = createRuntimeAdapter({ scorerRef: runtime.scorerRef, toolProfile: runtime.toolProfile, score: (input) => resolvedScorer.score(input) });
  const inferenceInvocations = [];
  const providerSessions = new Set();
  const auditedSessionKeys = audited.keys;
  const recordInferenceInvocation = async (value) => {
    if (!value.provider || typeof value.provider.ref !== "string" || !value.provider.ref.trim() || typeof value.provider.sessionId !== "string" || !value.provider.sessionId.trim()) {
      throw new Error(`Replay launch ${value.launchRef} reported no usable Provider session identity; fresh independent scoring cannot be certified.`);
    }
    if (value.provider.ref !== runtime.runnerRef || value.provider.modelId !== runtime.modelId) {
      throw new Error(`Replay launch ${value.launchRef} Provider identity differs from the frozen cohort: ${value.provider.ref}/${String(value.provider.modelId)}.`);
    }
    const sessionKey = `${value.provider.ref}\0${value.provider.sessionId}`;
    if (auditedSessionKeys.has(sessionKey)) throw new Error(`Provider session was reused from the audited run: ${value.provider.ref}/${value.provider.sessionId}; a replay must start fresh Provider sessions.`);
    if (providerSessions.has(sessionKey)) throw new Error(`Provider session was reused within one replay: ${value.provider.ref}/${value.provider.sessionId}`);
    providerSessions.add(sessionKey);
    inferenceInvocations.push({ schema: "wikiskill.inference-invocation.v1", launchRef: value.launchRef, taskId: value.taskId, split: value.split, phase: value.phase, iteration: value.iteration, rollout: value.rollout, provider: value.provider });
  };

  const contextRoot = path.join(runRoot, "skills", "context");
  const contextTrees = await readSkillTrees(contextRoot);
  const wallClock = new AbortController();
  let wallClockExpired = false;
  const forwardAbort = () => wallClock.abort();
  if (abortSignal) {
    if (abortSignal.aborted) wallClock.abort();
    else abortSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const cancelledByOperator = () => abortSignal?.aborted === true;
  const wallClockTimer = setTimeout(() => {
    wallClockExpired = true;
    wallClock.abort();
  }, wallClockMs);
  const runSide = async (side) => {
    const targetRoot = path.join(runRoot, ...side.skillPath);
    const inventory = await core.inspectMaterializedSkillSet([targetRoot, contextRoot]);
    const skillSet = skillSetDigest(inventory);
    const skills = { target: await readSkillTrees(targetRoot), context: contextTrees };
    const traces = [];
    for (const task of testTasks) {
      if (wallClock.signal.aborted) throw new Error(`Replay was ${wallClockExpired ? "cut off by its total wall-clock budget" : "cancelled by the operator"} before ${side.name} held-out task ${task.id}.`);
      traces.push(await core.makeTrace({
        runRoot: outputRoot,
        task,
        split: "test",
        phase: side.phase,
        iteration: 0,
        attempt: 1,
        rollout: 1,
        skillDigest: skillSet,
        skills,
        adapter,
        runner,
        model,
        abortSignal: wallClock.signal,
        wiki: null,
        traceDirectory: side.name,
        recordInferenceInvocation
      }));
    }
    if (!traces.every((item) => isOperationalOutcome(item.trace.score))) throw new Error(`${side.name} replay produced a non-operational held-out outcome.`);
    return {
      phase: side.phase,
      taskCount: testTasks.length,
      skillSetDigest: skillSet,
      aggregate: aggregateOperationalOutcomes(traces.map((item) => ({ trace: item.trace }))),
      traces: traces.map((item) => item.path),
      evaluations: traces.map((item) => item.trace.evaluationRef)
    };
  };

  let sides;
  try {
    sides = { baseline: await runSide({ name: "baseline", phase: "baseline_test", skillPath: ["skills", "snapshots"] }), candidate: await runSide({ name: "candidate", phase: "final_test", skillPath: ["result", "skills"] }) };
  } catch (error) {
    if (cancelledByOperator()) {
      blockers.push("Replay was cancelled by an operator interrupt (SIGINT or SIGTERM); the running Provider launch was terminated and later launches were blocked.");
      return fail(["Rerun `wikiskill run replay-score` into a fresh output directory once the operator is ready."]);
    }
    if (wallClockExpired) blockers.push(`Replay exceeded its total wall-clock budget of ${wallClockMs}ms; the running Provider launch was interrupted and later launches were blocked.`);
    else blockers.push(`Replay execution failed: ${error instanceof Error ? error.message : String(error)}`);
    return fail(["Inspect the replay output directory, fix the provider or dataset cause, then replay into a fresh directory."]);
  } finally {
    clearTimeout(wallClockTimer);
    if (abortSignal) abortSignal.removeEventListener("abort", forwardAbort);
  }

  if (treeDigest(runRoot) !== runRootDigestBefore) blockers.push("The audited run tree changed during replay; replay evidence is void.");
  if (treeDigest(candidateRoot) !== candidateDigestBefore) blockers.push("The staged candidate tree changed during replay; replay evidence is void.");
  if (blockers.length) return fail(["The audited run or staged candidate trees changed during replay; this replay is void and must be repeated into a fresh directory."]);

  const comparison = compareOperationalAggregates(sides.candidate.aggregate, sides.baseline.aggregate);
  const regression = comparison.regressions.length > 0 || comparison.order < 0;
  if (regression) blockers.push("Held-out replay regression: the replayed candidate scored below the replayed baseline on the frozen test split.");

  const replay = {
    schema: "wikiskill.replay-score.v1",
    replayId,
    createdAt: new Date().toISOString(),
    run: { runId: manifest.runId, runRoot, status: state.status, datasetDigest: manifest.dataset.digest, ...(manifest.configDigest ? { configDigest: manifest.configDigest } : {}) },
    candidate: { candidateId: staged.candidateId, targetSkill: staged.targetSkill, status: staged.status, baselineDigest: staged.baselineDigest ?? null, resultDigest: staged.resultDigest ?? null },
    skills: { baselineSkillSetDigest: sides.baseline.skillSetDigest, candidateSkillSetDigest: sides.candidate.skillSetDigest },
    dataset: { fileDigest: datasetFileDigest, manifestDigest: manifest.dataset.digest, taskSetDigest: manifest.dataset.taskSetDigest, adapter: manifest.dataset.adapter ?? null, testTaskIds: testTasks.map((task) => task.id) },
    runtime: { provider: runtime.provider, modelId: runtime.modelId, reasoningEffort: runtime.reasoningEffort, toolProfile: runtime.toolProfile, runner: runtime.runner, scorer: runtime.scorer, launchBudget: budget.snapshot(), wallClockMs },
    sides,
    verdict: { comparison, regression, regressions: comparison.regressions },
    inferenceInvocations,
    evidence: { replayRoot: outputRoot, providerSessionCount: providerSessions.size, auditedRuntimeSessionCount: (state.runtimeSessions || []).length, auditedSessionKeyCount: auditedSessionKeys.size, providerLaunchLedger: "accounting/provider-launches.jsonl", sourceAudit: { runId: manifest.runId, candidateId: staged.candidateId, blockers: audit.blockers } }
  };
  await fs.writeFile(path.join(outputRoot, "replay.json"), json(replay));
  warnings.push("Replay scores are fresh executions of the frozen held-out split; they are independent evidence and may differ from the persisted run audit scores.");
  return {
    data: replay,
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
    nextActions: regression
      ? ["The replayed candidate regressed on the held-out split; do not publish this candidate from this replay."]
      : ["Consume replay.json in the output directory as fresh machine-readable candidate scoring evidence."]
  };
};

module.exports = { replayCandidateScore };
