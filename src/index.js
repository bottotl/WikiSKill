"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createCommandRunner } = require("./command-runner");
const { doctorWorkspace, initWorkspace, uninstallWorkspace, updateBootstrap } = require("./workspace");
const { configureEvolution, evolveWorkspace, inspectEvolutionBaseline, statusWorkspaceEvolution } = require("./evolution");
const { applyCandidate, diffCandidate, rollbackReceipt } = require("./publishing");
const { renderInferencePrompt } = require("./prompt-contract");
const { getContextSkill, listContextSkillReceipts, prepareContext, recordContextSkillUse } = require("./context");
const { initialPurpose, readSkillFiles, skillBundleDigest, skillSetDigest } = require("./skill-bundle");

const ENGINE_VERSION = require("../package.json").version;
const DATASET_SCHEMA = "wikiskill.dataset.v1";
const TRAJECTORY_SCHEMA = "wikiskill.trajectory.v1";
const INFERENCE_PHASES = new Set(["baseline_validation", "training", "candidate_validation", "baseline_test", "final_test"]);
const ENVELOPE = (data, warnings = [], blockers = [], nextActions = []) => ({
  success: blockers.length === 0,
  data,
  warnings,
  blockers,
  nextActions
});

class WikiSkillError extends Error {
  constructor(message, blockers = [message]) {
    super(message);
    this.name = "WikiSkillError";
    this.blockers = blockers;
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const digestText = (value) => sha256(Buffer.from(value, "utf8"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const exists = async (target) => fsp.access(target).then(() => true).catch(() => false);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validRunId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const normalizeRelative = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new WikiSkillError(`${label} must be a non-empty relative path.`);
  const normalized = value.replaceAll(path.sep, "/");
  if (normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new WikiSkillError(`${label} must not escape its declared root.`);
  }
  return normalized === "." ? "" : normalized;
};
const assertNoSymlink = async (root, relative) => {
  let current = path.resolve(root);
  for (const part of relative.split("/")) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) throw new WikiSkillError(`Symlink destination is not allowed: ${relative}`);
  }
};
const sortedFiles = async (root) => {
  const result = [];
  const walk = async (current) => {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new WikiSkillError(`Symlink is not allowed in Skill resources: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) result.push(target);
    }
  };
  await walk(root);
  return result;
};
const fileDigestMap = async (root) => {
  const map = {};
  for (const file of await sortedFiles(root)) map[path.relative(root, file).split(path.sep).join("/")] = digestText(await fsp.readFile(file, "utf8"));
  return map;
};
const fileContentMap = async (root) => {
  const map = {};
  for (const file of await sortedFiles(root)) map[path.relative(root, file).split(path.sep).join("/")] = await fsp.readFile(file, "utf8");
  return map;
};
const digestMap = (map) => sha256(json(map));

function validateDataset(dataset) {
  const blockers = [];
  if (!isRecord(dataset) || dataset.schema !== DATASET_SCHEMA) blockers.push(`dataset.schema must equal ${DATASET_SCHEMA}.`);
  if (!Array.isArray(dataset?.tasks) || dataset.tasks.length === 0) blockers.push("dataset.tasks must be a non-empty array.");
  const ids = new Map();
  const taskPairFingerprints = new Map();
  for (const [index, task] of (dataset?.tasks || []).entries()) {
    const prefix = `tasks[${index}]`;
    if (!isRecord(task)) { blockers.push(`${prefix} must be an object.`); continue; }
    if (typeof task.id !== "string" || !task.id.trim()) blockers.push(`${prefix}.id must be non-empty text.`);
    else if (ids.has(task.id)) blockers.push(`duplicate task id: ${task.id}.`);
    else ids.set(task.id, index);
    if (!["train", "val", "test"].includes(task.split)) blockers.push(`${prefix}.split must be train, val, or test.`);
    if (!("input" in task) || task.input === undefined) blockers.push(`${prefix}.input is required and may contain any serializable domain payload.`);
    if (task.taskContext !== undefined && (typeof task.taskContext !== "string" || !task.taskContext.trim())) blockers.push(`${prefix}.taskContext must be non-empty text when supplied.`);
    if (task.knowledge !== undefined) {
      try { require("./knowledge-context").validateKnowledgeRef(task.knowledge); } catch (error) { blockers.push(error.message); }
    }
    if (task.repositorySnapshot !== undefined) {
      try { require("./repository-snapshot").validateSnapshotRef(task.repositorySnapshot); } catch (error) { blockers.push(error.message); }
      if (task.sandbox !== undefined) blockers.push("repositorySnapshot and sandbox are mutually exclusive.");
    }
    if (task.sandbox !== undefined && !isRecord(task.sandbox)) blockers.push(`${prefix}.sandbox must be Record<string,string> when supplied.`);
    else for (const [key, value] of Object.entries(task.sandbox || {})) {
      try { normalizeRelative(key, `${prefix}.sandbox key`); } catch (error) { blockers.push(error.message); }
      const binary = isRecord(value) && value.encoding === "base64" && typeof value.content === "string" && Object.keys(value).length === 2;
      if (typeof value !== "string" && !binary) blockers.push(`${prefix}.sandbox[${JSON.stringify(key)}] expected string or base64 file content.`);
    }
    if (!("groundTruth" in task) || task.groundTruth === undefined) blockers.push(`${prefix}.groundTruth is required and may contain any serializable domain payload.`);
    if (!isRecord(task.evaluator) || typeof task.evaluator.capabilityRef !== "string" || !task.evaluator.capabilityRef.trim()) blockers.push(`${prefix}.evaluator.capabilityRef must be non-empty text.`);
    if (task.outputSchema !== undefined && !isRecord(task.outputSchema)) blockers.push(`${prefix}.outputSchema must be a JSON Schema object when supplied.`);
    const pairFingerprint = sha256(json({ input: task.input, groundTruth: task.groundTruth, sandbox: task.sandbox || {}, repositorySnapshot: task.repositorySnapshot?.digest }));
    if (taskPairFingerprints.has(pairFingerprint) && taskPairFingerprints.get(pairFingerprint) !== task.split) blockers.push(`cross-split task-pair leakage between ${taskPairFingerprints.get(pairFingerprint)} and ${task.split}.`);
    else taskPairFingerprints.set(pairFingerprint, task.split);
  }
  const splits = new Set((dataset?.tasks || []).map((task) => task?.split));
  for (const split of ["train", "val", "test"]) if (!splits.has(split)) blockers.push(`dataset must contain a ${split} split.`);
  if (blockers.length) throw new WikiSkillError("Invalid WikiSkill dataset.", blockers);
  return {
    schema: DATASET_SCHEMA,
    domain: typeof dataset.domain === "string" ? dataset.domain : "opaque-domain",
    adapter: dataset.adapter || null,
    tasks: dataset.tasks.map((task) => JSON.parse(JSON.stringify(task))),
    digest: digestText(json(dataset))
  };
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new WikiSkillError((result.stderr || "git command failed").trim());
  return result.stdout.trim();
}
function gitOptional(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
async function resolveGitRoot(repo) {
  const input = path.resolve(repo);
  const root = path.resolve(git(input, ["rev-parse", "--show-toplevel"]));
  return await fsp.realpath(root);
}
async function inspectRepository({ repo, skillRoots }) {
  const root = await resolveGitRoot(repo);
  if (!Array.isArray(skillRoots) || skillRoots.length === 0) throw new WikiSkillError("At least one explicit --skill-root is required.");
  const skills = [];
  const seenPaths = new Set();
  const seenNames = new Map();
  for (const rawRoot of skillRoots) {
    const relativeRoot = normalizeRelative(rawRoot, "skill root");
    const absoluteRoot = path.resolve(root, relativeRoot);
    const declaredRoot = await fsp.lstat(absoluteRoot).catch(() => { throw new WikiSkillError(`Skill root does not exist: ${rawRoot}`); });
    if (declaredRoot.isSymbolicLink()) throw new WikiSkillError(`Skill root must not be a symlink: ${rawRoot}`);
    const realRoot = await fsp.realpath(absoluteRoot).catch(() => { throw new WikiSkillError(`Skill root does not exist: ${rawRoot}`); });
    if (realRoot !== root && !realRoot.startsWith(`${root}${path.sep}`)) throw new WikiSkillError(`Skill root escapes Git repository: ${rawRoot}`);
    const stat = await fsp.stat(realRoot);
    const candidates = stat.isDirectory() && await exists(path.join(realRoot, "SKILL.md"))
      ? [realRoot]
      : stat.isDirectory() ? (await fsp.readdir(realRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(realRoot, entry.name)) : [];
    if (candidates.length === 0) throw new WikiSkillError(`No Skill directories containing SKILL.md found under ${rawRoot}.`);
    for (const candidate of candidates) {
      const candidateStat = await fsp.lstat(candidate);
      if (candidateStat.isSymbolicLink()) throw new WikiSkillError(`Skill directory must not be a symlink: ${candidate}`);
      const candidateReal = await fsp.realpath(candidate);
      if (!candidateReal.startsWith(`${root}${path.sep}`) || !(await exists(path.join(candidateReal, "SKILL.md")))) continue;
      const relativePath = path.relative(root, candidateReal).split(path.sep).join("/");
      if (seenPaths.has(relativePath)) { throw new WikiSkillError(`Duplicate Skill path: ${relativePath}`); }
      seenPaths.add(relativePath);
      const skillText = await fsp.readFile(path.join(candidateReal, "SKILL.md"), "utf8");
      const name = path.basename(candidateReal);
      if (seenNames.has(name)) throw new WikiSkillError(`Duplicate Skill name ${name}: ${seenNames.get(name)} and ${relativePath}`);
      seenNames.set(name, relativePath);
      const files = await fileDigestMap(candidateReal);
      skills.push({ id: name, name, path: relativePath, description: skillText.split(/\n/).find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() || "", files, digest: digestMap(files), gitStatus: git(root, ["status", "--short", "--", relativePath]) });
    }
  }
  return {
    repo: root,
    baseCommit: git(root, ["rev-parse", "HEAD"]),
    ...(gitOptional(root, ["remote", "get-url", "origin"]) ? { remoteIdentity: gitOptional(root, ["remote", "get-url", "origin"]) } : {}),
    skills
  };
}

async function copyTree(source, destination) {
  await fsp.mkdir(destination, { recursive: true });
  for (const file of await sortedFiles(source)) {
    const relative = path.relative(source, file);
    const target = path.join(destination, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(file, target);
  }
}
async function writeInitialPurpose(destination, skill) {
  const purposePath = path.join(destination, "PURPOSE.md");
  if (await exists(purposePath)) return;
  const files = await readSkillFiles(destination);
  await fsp.writeFile(purposePath, initialPurpose(skill.path, skillBundleDigest(files)), "utf8");
}

const inspectMaterializedSkillSet = async (roots) => {
  const inventory = [];
  for (const root of roots) {
    for (const entry of (await fsp.readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      if (inventory.some((skill) => skill.id === entry.name)) throw new WikiSkillError(`Duplicate active Skill id: ${entry.name}.`);
      inventory.push({ id: entry.name, bundleDigest: skillBundleDigest(await readSkillFiles(path.join(root, entry.name))) });
    }
  }
  return inventory.sort((left, right) => left.id.localeCompare(right.id));
};
async function writeTextFile(root, relative, content) {
  const safe = normalizeRelative(relative, "sandbox path");
  const target = path.resolve(root, safe);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new WikiSkillError(`Sandbox path escapes environment: ${relative}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
}
const defaultRunner = async ({ task, skills, tools }) => ({
  prediction: { text: task.taskContext || JSON.stringify(task.input) },
  events: [{ type: "observation", text: task.taskContext || JSON.stringify(task.input) }, { type: "assistant", text: "completed" }],
  tools: tools || [],
  skillCount: Object.keys(skills?.target || {}).length
});
const defaultAdapter = {
  validateDataset: () => undefined,
  prepareEnvironment: async ({ workdir }) => workdir,
  renderTask: ({ task }) => task.input,
  resolveTools: () => [],
  extractPrediction: ({ result }) => result.prediction,
  score: ({ prediction, groundTruth }) => ({ score: JSON.stringify(prediction) === JSON.stringify(groundTruth) ? 1 : 0, evidence: { default: true } }),
  disposeEnvironment: async () => undefined
};
const loadModule = (value, base) => {
  if (!value) return null;
  const target = path.isAbsolute(value) ? value : path.resolve(base, value);
  return require(target);
};
const splitTasks = (dataset, split) => dataset.tasks.filter((task) => task.split === split);
const scoreRange = (score) => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1;
const renderSkillPrompt = (skills) => Object.entries({ ...(skills.target || {}), ...(skills.context || {}) })
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([id, files]) => {
    const contents = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
    return [`## Skill: ${id}`, ...contents.map(([file, content]) => `### ${file}\n${content}`)].join("\n");
  })
  .join("\n\n");
const resolveRunner = (options, manifest) => {
  if (options.runner) return options.runner;
  const spec = options.agentRunner || manifest.agentRunner;
  if (spec) return createCommandRunner(spec);
  const loaded = loadModule(options.runnerModule || manifest.runnerModule, process.cwd());
  if (loaded && typeof loaded.createRunner === "function") return loaded.createRunner(options.runnerConfig ?? manifest.runnerConfig ?? {});
  return loaded || defaultRunner;
};
const resolveAdapter = (options, manifest) => {
  if (options.adapter) return options.adapter;
  const loaded = loadModule(options.adapterModule || manifest.adapterModule, process.cwd());
  if (loaded && typeof loaded.createAdapter === "function") return loaded.createAdapter(options.adapterConfig ?? manifest.adapterConfig ?? {});
  return loaded || defaultAdapter;
};
const resolveLearningRole = (role, options, manifest) => {
  const direct = role === "maintainer" ? options.maintainer : options.proposer;
  if (direct) return direct;
  const modulePath = role === "maintainer"
    ? options.maintainerModule || manifest.maintainerModule
    : options.proposerModule || manifest.proposerModule;
  if (modulePath) {
    const loaded = loadModule(modulePath, process.cwd());
    if (typeof loaded === "function") return loaded;
    const factory = role === "maintainer" ? loaded?.createMaintainer : loaded?.createProposer;
    if (typeof factory === "function") return factory();
    throw new WikiSkillError(`${role} module must export a function or create${role === "maintainer" ? "Maintainer" : "Proposer"}.`);
  }
  const learningAgent = options.learningAgent || manifest.learningAgent;
  if (!isRecord(learningAgent) || learningAgent.id !== "codex") return undefined;
  const config = learningAgent.config === undefined ? {} : learningAgent.config;
  if (!isRecord(config)) throw new WikiSkillError("learningAgent.config must be an object when supplied.");
  const builtin = require("./codex-learning");
  return role === "maintainer" ? builtin.createMaintainer(config) : builtin.createProposer(config);
};

const runnerDiagnostics = (error) => {
  if (!error || typeof error !== "object" || !isRecord(error.wikiskillDiagnostics)) return undefined;
  const source = error.wikiskillDiagnostics;
  const summary = {};
  for (const key of ["stdout", "stderr"]) {
    if (typeof source[key] === "string") summary[key] = source[key].slice(-120_000);
  }
  for (const key of ["timedOut", "aborted", "exitCode", "signal"]) {
    if (typeof source[key] === "boolean" || typeof source[key] === "number" || typeof source[key] === "string") summary[key] = source[key];
  }
  return Object.keys(summary).length ? summary : undefined;
};

const captureWorkspaceChanges = (workdir) => {
  const inside = spawnSync("git", ["-C", workdir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0) return null;
  spawnSync("git", ["-C", workdir, "add", "-N", "."], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", workdir, "status", "--short"], { encoding: "utf8" });
  const diff = spawnSync("git", ["-C", workdir, "diff", "--no-ext-diff", "--binary"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (status.status !== 0 || diff.status !== 0) throw new WikiSkillError("Failed to capture isolated workspace changes.");
  return { status: status.stdout, diff: diff.stdout, diffDigest: digestText(diff.stdout) };
};

const persistFailedAttempt = async ({ runRoot, attemptId, task, split, iteration, rollout, skillDigest, error }) => {
  const filename = `${sha256(attemptId)}.json`;
  const target = path.join(runRoot, "raw", "failures", `attempt-${String(iteration).padStart(2, "0")}`, filename);
  const artifact = {
    schema: "wikiskill.failed-attempt.v1",
    attemptId,
    taskId: task.id,
    split,
    iteration,
    rollout,
    skillSetDigest: skillDigest,
    error: { message: error instanceof Error ? error.message : String(error) },
    ...(runnerDiagnostics(error) ? { runnerDiagnostics: runnerDiagnostics(error) } : {})
  };
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, json(artifact), { encoding: "utf8", flag: "wx" });
    return path.relative(runRoot, target).split(path.sep).join("/");
  } catch {
    return undefined;
  }
};

async function makeTrace({ runRoot, task, split, phase, iteration, attempt, rollout = 1, skillDigest, skills, adapter, runner, model, abortSignal, wiki, traceDirectory, recordInferenceInvocation }) {
  if (!INFERENCE_PHASES.has(phase)) throw new WikiSkillError(`Inference phase is invalid: ${String(phase)}`);
  const attemptId = `${String(attempt ?? 1).padStart(2, "0")}-${String(iteration).padStart(2, "0")}-${split}-${task.id}-${rollout}`;
  const phaseId = (traceDirectory || `iter-${String(iteration).padStart(2, "0")}`).split(/[\\/]/u).join("-");
  const workdir = path.join(runRoot, "environments", `${phaseId}-${attemptId}`);
  await fsp.mkdir(workdir, { recursive: true });
  if (task.repositorySnapshot) await require("./repository-snapshot").materializeRepositorySnapshot(workdir, task.repositorySnapshot);
  for (const [relative, content] of Object.entries(task.sandbox || {})) {
    if (typeof content === "string") await writeTextFile(workdir, relative, content);
    else {
      const safe = normalizeRelative(relative, "sandbox path");
      const target = path.resolve(workdir, safe);
      if (!target.startsWith(`${path.resolve(workdir)}${path.sep}`)) throw new WikiSkillError(`Sandbox path escapes environment: ${relative}`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, Buffer.from(content.content, "base64"));
    }
  }
  const visibleTask = {
    id: task.id,
    split: task.split,
    ...(task.title === undefined ? {} : { title: task.title }),
    input: task.input,
    ...(task.outputSchema === undefined ? {} : { outputSchema: task.outputSchema }),
    ...(task.taskContext === undefined ? {} : { taskContext: task.taskContext }),
    ...(task.sandbox === undefined ? {} : { sandbox: task.sandbox }),
    ...(task.repositorySnapshot === undefined ? {} : { repositorySnapshot: task.repositorySnapshot })
  };
  const adapterConfig = adapter.config;
  let environment;
  let environmentWorkdir = workdir;
  let knowledgeContext;
  try {
    environment = await (adapter.prepareEnvironment || defaultAdapter.prepareEnvironment)({ task: visibleTask, split, iteration, workdir, adapterConfig });
    environmentWorkdir = typeof environment === "string" ? environment : environment?.workdir ?? workdir;
    const tools = await (adapter.resolveTools || defaultAdapter.resolveTools)({ task: visibleTask, environment, workdir: environmentWorkdir, split, iteration, adapterConfig });
    const input = await (adapter.renderTask || defaultAdapter.renderTask)({ task: visibleTask, skills, wiki, split, iteration, adapterConfig });
    const executionContext = await adapter.materializeExecutionContext?.({
      task: visibleTask,
      skills,
      wiki,
      environment,
      workdir: environmentWorkdir,
      split,
      phase,
      iteration,
      adapterConfig
    });
    if (executionContext !== undefined && (!isRecord(executionContext) || (executionContext.requiredInstructions !== undefined && typeof executionContext.requiredInstructions !== "string"))) {
      throw new WikiSkillError("Adapter materializeExecutionContext must return an object with optional requiredInstructions.");
    }
    if (executionContext?.environment !== undefined && (!isRecord(executionContext.environment) || Object.values(executionContext.environment).some((value) => typeof value !== "string"))) {
      throw new WikiSkillError("Adapter materializeExecutionContext.environment must be a string map.");
    }
    if (task.knowledge) knowledgeContext = await require("./knowledge-context").prepareKnowledgeContext(task.knowledge, environmentWorkdir, skills);
    const systemPrompt = renderInferencePrompt({
      split,
      taskId: task.id,
      requiredInstructions: [executionContext?.requiredInstructions || "", knowledgeContext?.instructions || ""].filter(Boolean).join("\n\n"),
      skills: renderSkillPrompt(skills)
    });
    const launchRef = `inference:${phaseId}:${split}:${task.id}:${rollout}`;
    const result = await runner({
      task: visibleTask,
      input,
      systemPrompt,
      skills,
      tools,
      workdir: environmentWorkdir,
      model,
      predictionSchema: task.outputSchema,
      abortSignal,
      split,
      iteration,
      launchRef,
      ...(knowledgeContext ? { isolation: knowledgeContext.isolation } : {}),
      ...(executionContext?.environment ? { environment: executionContext.environment } : {})
    });
    const knowledgeConsumption = knowledgeContext?.verify(result.events, result.isolationEvidence);
    const provider = result.provider ? normalizeProviderSession(result.provider, "Inference") : undefined;
    if (provider) await recordInferenceInvocation?.({ launchRef, taskId: task.id, split, phase, iteration, rollout, provider });
    const prediction = await (adapter.extractPrediction || defaultAdapter.extractPrediction)({ task: visibleTask, result, split, iteration, adapterConfig });
    const evaluated = await (adapter.score || defaultAdapter.score)({ task, prediction, groundTruth: task.groundTruth, environment, workdir: environmentWorkdir, split, iteration, adapterConfig });
    if (!scoreRange(evaluated?.score)) throw new WikiSkillError(`Evaluator returned invalid score for ${task.id}.`);
    if (!isRecord(result) || !Array.isArray(result.events) || result.events.some((event) => !isRecord(event) || !["observation", "assistant", "tool_call", "tool_result"].includes(event.type))) {
      throw new WikiSkillError(`Agent runner returned an invalid trajectory for ${task.id}.`);
    }
    const workspaceChanges = captureWorkspaceChanges(environmentWorkdir);
    const trajectoryId = attemptId;
    const traceFile = rollout === 1 ? `${task.id}.json` : `${task.id}-rollout-${rollout}.json`;
    const evaluationPath = path.join(runRoot, "raw", "evaluations", traceDirectory || `iter-${String(iteration).padStart(2, "0")}`, split, traceFile);
    const evaluationContent = json({ schema: "wikiskill.private-evaluation.v1", traceId: trajectoryId, capabilityRef: task.evaluator.capabilityRef, score: evaluated.score, evidence: evaluated.evidence || {} });
    await fsp.mkdir(path.dirname(evaluationPath), { recursive: true });
    await fsp.writeFile(evaluationPath, evaluationContent, { encoding: "utf8", flag: "wx" });
    const trace = {
      schema: TRAJECTORY_SCHEMA,
      id: trajectoryId,
      taskId: task.id,
      split,
      phase,
      iteration,
      attempt,
      rollout,
      skillSetDigest: skillDigest,
      events: result.events,
      ...(result.usage ? { providerUsage: result.usage } : {}),
      ...(knowledgeConsumption ? { knowledgeConsumption } : {}),
      ...(provider ? { provider } : {}),
      ...(provider ? { launchRef } : {}),
      prediction,
      score: evaluated.score,
      ...(workspaceChanges ? { workspace: workspaceChanges } : {}),
      ...(task.evaluator.capabilityRef === "builtin:command-exit-v1" ? { verification: evaluated.evidence || {} } : {}),
      evaluationRef: path.relative(runRoot, evaluationPath).split(path.sep).join("/"),
      evaluationDigest: `sha256:${sha256(evaluationContent)}`
    };
    const tracePath = path.join(runRoot, "raw", "traces", traceDirectory || `iter-${String(iteration).padStart(2, "0")}`, split, traceFile);
    await fsp.mkdir(path.dirname(tracePath), { recursive: true });
    await fsp.writeFile(tracePath, json(trace), { encoding: "utf8", flag: "wx" });
    return { trace, path: path.relative(runRoot, tracePath).split(path.sep).join("/") };
  } catch (error) {
    const failureArtifactPath = await persistFailedAttempt({ runRoot, attemptId, task: visibleTask, split, iteration, rollout, skillDigest, error });
    if (failureArtifactPath && error && typeof error === "object") {
      error.wikiskillFailureArtifactPath = failureArtifactPath;
    }
    throw error;
  } finally {
    await knowledgeContext?.close();
    await (adapter.disposeEnvironment || defaultAdapter.disposeEnvironment)({ task: visibleTask, environment, split, iteration, workdir: environmentWorkdir, adapterConfig });
  }
}
const aggregate = (traces) => traces.length ? traces.reduce((sum, item) => sum + item.trace.score, 0) / traces.length : 0;
const sampleTraces = (traces) => [...traces.filter((item) => item.trace.score < 1).slice(0, 5), ...traces.filter((item) => item.trace.score >= 1).slice(0, 3)];
const capLearningText = (value, limit) => {
  if (typeof value !== "string" || value.length <= limit) return value;
  const head = Math.floor(limit / 4);
  return `${value.slice(0, head)}\n[...learning projection truncated...]\n${value.slice(-(limit - head))}`;
};
const traceForLearning = (trace) => ({
  schema: trace.schema,
  id: trace.id,
  taskId: trace.taskId,
  split: trace.split,
  iteration: trace.iteration,
  rollout: trace.rollout,
  score: trace.score,
  ...(trace.verification ? { verification: {
    commandDigest: sha256(json(trace.verification.command || [])),
    exitCode: trace.verification.exitCode,
    signal: trace.verification.signal,
    timedOut: trace.verification.timedOut,
    outputExceeded: trace.verification.outputExceeded,
    changedPaths: trace.verification.changedPaths,
    disallowedPaths: trace.verification.disallowedPaths,
    stdout: capLearningText(trace.verification.stdout, 9_000),
    stderr: capLearningText(trace.verification.stderr, 4_000)
  } } : {}),
  ...(trace.workspace ? { workspace: { ...trace.workspace, diff: capLearningText(trace.workspace.diff, 8_000) } } : {}),
  prediction: trace.prediction,
  events: trace.events.map((event) => ({
    ...event,
    ...(typeof event.text === "string" ? { text: capLearningText(event.text, 2_000) } : {}),
    ...(typeof event.output === "string" ? { output: capLearningText(event.output, 3_000) } : {})
  }))
});
const traceForMaintainer = (item) => {
  const raw = json(traceForLearning(item.trace));
  if (raw.length <= 15000) return raw;
  const suffix = "\n[truncated for maintainer injection]";
  return `${raw.slice(0, 15000 - suffix.length)}${suffix}`;
};
const normalizeProviderSession = (value, label) => {
  if (!isRecord(value) || typeof value.ref !== "string" || !value.ref.trim() || typeof value.modelId !== "string" || !value.modelId.trim()) {
    throw new WikiSkillError(`${label} Provider identity is invalid.`);
  }
  const sessionId = typeof value.threadId === "string" && value.threadId.trim()
    ? value.threadId.trim()
    : typeof value.sessionId === "string" && value.sessionId.trim()
      ? value.sessionId.trim()
      : undefined;
  if (!sessionId) throw new WikiSkillError(`${label} Provider session id is missing.`);
  return { ref: value.ref.trim(), modelId: value.modelId.trim(), sessionId };
};
const wikiIterationLines = (sampled, rawReferencePrefix) => sampled.map((item) => `- ${item.trace.id} (${item.trace.score >= 1 ? "success" : "failure"}, score=${item.trace.score})\n  raw: ${rawReferencePrefix ? `${rawReferencePrefix}/${item.path}` : item.path}`);
async function appendWikiLog(runRoot, iteration, sampled, rawReferencePrefix) {
  const wiki = path.join(runRoot, "wiki");
  const log = path.join(wiki, "log.md");
  await fsp.appendFile(log, `\n## Iteration ${iteration}\n${wikiIterationLines(sampled, rawReferencePrefix).join("\n")}\n`, "utf8");
}
async function appendWikiIndex(runRoot, iteration, sampled) {
  const wiki = path.join(runRoot, "wiki");
  const indexPath = path.join(wiki, "index.md");
  const index = await fsp.readFile(indexPath, "utf8");
  await fsp.writeFile(indexPath, `${index.trimEnd()}\n\n- Iteration ${iteration}: ${sampled.length} sampled training trajectories.\n`, "utf8");
}
async function appendWiki(runRoot, iteration, sampled, rawReferencePrefix) {
  await appendWikiLog(runRoot, iteration, sampled, rawReferencePrefix);
  await appendWikiIndex(runRoot, iteration, sampled);
}
const applyPatternEdits = (content, edits) => {
  if (!Array.isArray(edits) || edits.length === 0) throw new WikiSkillError("Maintainer pattern patch requires one or more edits.");
  let next = content;
  for (const edit of edits) {
    if (!isRecord(edit) || !["append", "replace", "insert_after"].includes(edit.op) || typeof edit.content !== "string") {
      throw new WikiSkillError("Maintainer pattern edit is invalid.");
    }
    if (edit.op === "append") { next += edit.content; continue; }
    if (typeof edit.target !== "string" || !edit.target || !next.includes(edit.target)) {
      throw new WikiSkillError("Maintainer pattern edit target must be an exact existing substring.");
    }
    next = edit.op === "replace"
      ? next.replace(edit.target, edit.content)
      : next.replace(edit.target, `${edit.target}${edit.content}`);
  }
  return next;
};
const readWikiPatterns = async (runRoot) => {
  const root = path.join(runRoot, "wiki", "patterns");
  const patterns = {};
  for (const file of await sortedFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    patterns[relative] = await fsp.readFile(file, "utf8");
  }
  return patterns;
};
async function runMaintainer(runRoot, iteration, sampled, options) {
  const maintainer = resolveLearningRole("maintainer", options, options.manifest);
  if (!maintainer) { await appendWiki(runRoot, iteration, sampled, options.manifest.rawReferencePrefix); return; }
  const writes = [];
  const result = await maintainer({
    iteration,
    attempt: options.attempt,
    wikiRoot: path.join(runRoot, "wiki"),
    sampledTraces: sampled.map((item) => ({
      taskId: item.trace.taskId,
      split: item.trace.split,
      iteration: item.trace.iteration,
      score: item.trace.score,
      executionLog: traceForMaintainer(item)
    })),
    existingWiki: {
      index: await fsp.readFile(path.join(runRoot, "wiki", "index.md"), "utf8"),
      log: await fsp.readFile(path.join(runRoot, "wiki", "log.md"), "utf8"),
      skillImpact: await fsp.readFile(path.join(runRoot, "wiki", "skill-impact.md"), "utf8"),
      patterns: await readWikiPatterns(runRoot)
    },
    recordInvocation: options.recordLearningInvocation,
    writePattern: (name, content) => { normalizeRelative(name, "pattern name"); if (typeof content !== "string") throw new WikiSkillError("Maintainer pattern content must be text."); writes.push({ name, content }); },
    patchPattern: (name, edits) => { normalizeRelative(name, "pattern name"); writes.push({ name, edits }); },
    appendLog: (content) => { if (typeof content !== "string") throw new WikiSkillError("Maintainer log content must be text."); writes.push({ name: "__log__", content }); }
  });
  if (result?.index && typeof result.index === "string") writes.push({ name: "__index__", content: result.index });
  const liveWiki = path.join(runRoot, "wiki");
  const transactionRoot = path.join(runRoot, "runtime", `wiki-maintainer-${crypto.randomUUID()}`);
  const stagedRunRoot = path.join(transactionRoot, "staged");
  const stagedWiki = path.join(stagedRunRoot, "wiki");
  const backupWiki = path.join(transactionRoot, "backup");
  await copyTree(liveWiki, stagedWiki);
  try {
    for (const write of writes) {
      if (write.name === "__log__") await fsp.appendFile(path.join(stagedWiki, "log.md"), `\n${write.content}\n`, "utf8");
      else if (write.name === "__index__") await fsp.writeFile(path.join(stagedWiki, "index.md"), write.content, "utf8");
      else {
        const target = path.join(stagedWiki, "patterns", write.name);
        if (write.edits) {
          if (!(await exists(target))) throw new WikiSkillError(`Maintainer cannot patch a missing pattern: ${write.name}`);
          const previous = await fsp.readFile(target, "utf8");
          await fsp.writeFile(target, applyPatternEdits(previous, write.edits), "utf8");
        } else {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, write.content, "utf8");
        }
      }
    }
    const hasIndexUpdate = writes.some((write) => write.name === "__index__");
    const hasLogUpdate = writes.some((write) => write.name === "__log__");
    if (!hasIndexUpdate) await appendWikiIndex(stagedRunRoot, iteration, sampled);
    if (!hasLogUpdate) await appendWikiLog(stagedRunRoot, iteration, sampled, options.manifest.rawReferencePrefix);
    await fsp.rename(liveWiki, backupWiki);
    try {
      await fsp.rename(stagedWiki, liveWiki);
    } catch (error) {
      await fsp.rename(backupWiki, liveWiki);
      throw error;
    }
    await fsp.rm(backupWiki, { recursive: true, force: true });
  } finally {
    await fsp.rm(transactionRoot, { recursive: true, force: true });
  }
}
const validSkillId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const normalizeProjectedSkill = (value, index) => {
  if (!isRecord(value) || !validSkillId(value.id)) throw new WikiSkillError(`projectedSkills[${index}].id must be a safe Skill id.`);
  const destination = normalizeRelative(value.destination, `projectedSkills[${index}].destination`);
  if (path.posix.basename(destination) !== value.id) throw new WikiSkillError(`projectedSkills[${index}].destination must end with ${value.id}.`);
  const mode = value.mode === undefined ? "target" : value.mode;
  if (mode !== "target" && mode !== "context") throw new WikiSkillError(`projectedSkills[${index}].mode must be target or context.`);
  if (!isRecord(value.files) || typeof value.files["SKILL.md"] !== "string" || typeof value.files["PURPOSE.md"] !== "string") {
    throw new WikiSkillError(`projectedSkills[${index}] must include text SKILL.md and PURPOSE.md.`);
  }
  const files = {};
  for (const [relative, content] of Object.entries(value.files)) {
    normalizeRelative(relative, `projectedSkills[${index}].files`);
    if (typeof content !== "string") throw new WikiSkillError(`projectedSkills[${index}].files[${JSON.stringify(relative)}] must contain text.`);
    files[relative] = content;
  }
  return { id: value.id, destination, mode, files };
};
const writeProjectedSkill = async (root, projected) => {
  const destination = path.join(root, projected.id);
  for (const [relative, content] of Object.entries(projected.files)) await writeTextFile(destination, relative, content);
  return destination;
};
const projectedSkillDescriptor = (skill) => ({
  id: skill.id,
  name: skill.id,
  path: skill.destination,
  files: {},
  digest: digestMap(Object.fromEntries(Object.entries(skill.files).map(([file, content]) => [file, digestText(content)]))),
  projected: true
});
const proposalToFiles = (proposal, policy) => {
  if (!isRecord(proposal) || !["no_action", "create", "patch"].includes(proposal.action)) throw new WikiSkillError("Proposal action must be no_action, create, or patch.");
  if (proposal.action === "no_action") return [];
  if (!validSkillId(proposal.skillId) || !isRecord(proposal.files) || Object.keys(proposal.files).length === 0) throw new WikiSkillError("Skill proposal requires one safe skillId and non-empty files.");
  if (proposal.action === "patch" && !policy.targetIds.has(proposal.skillId)) throw new WikiSkillError(`Proposal may only modify one selected target Skill: ${proposal.skillId}.`);
  if (proposal.action === "create") {
    if (!policy.newSkillRoot) throw new WikiSkillError("Creating a Skill requires an explicit newSkillRoot.");
    if (policy.allowedNewSkillIds.size && !policy.allowedNewSkillIds.has(proposal.skillId)) throw new WikiSkillError(`Proposal may only create the requested Skill: ${proposal.skillId}.`);
    if (policy.existingSkillIds.has(proposal.skillId)) throw new WikiSkillError(`New Skill already exists in this evolution: ${proposal.skillId}.`);
    if (typeof proposal.files["SKILL.md"] !== "string" || typeof proposal.files["PURPOSE.md"] !== "string") throw new WikiSkillError("A created Skill must include SKILL.md and PURPOSE.md.");
  }
  return Object.entries(proposal.files).map(([relative, content]) => {
    normalizeRelative(relative, "proposal file");
    if (typeof content !== "string") throw new WikiSkillError(`Proposal file ${relative} must contain text.`);
    return [relative, content];
  });
};
async function applyProposal(activeRoot, proposal, policy) {
  const files = proposalToFiles(proposal, policy);
  if (proposal.action === "no_action") return;
  const target = path.join(activeRoot, proposal.skillId);
  await fsp.mkdir(target, { recursive: true });
  for (const [relative, content] of files) await writeTextFile(target, relative, content);
}

const proposalImpactDiff = async (activeRoot, candidateRoot, proposal, manifest) => {
  if (proposal.action === "no_action" || !proposal.skillId) return "";
  const existing = manifest.targetSkills.find((skill) => skill.id === proposal.skillId);
  const sourcePath = existing?.path ?? path.join(manifest.newSkillRoot || "", proposal.skillId).split(path.sep).join("/");
  const previousRoot = path.join(activeRoot, proposal.skillId);
  const nextRoot = path.join(candidateRoot, proposal.skillId);
  const before = await exists(previousRoot) ? await fileContentMap(previousRoot) : {};
  const after = await exists(nextRoot) ? await fileContentMap(nextRoot) : {};
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const blocks = [];
  for (const file of [...files].sort()) {
    if (before[file] === after[file]) continue;
    const oldPath = `${sourcePath}/${file}`;
    const removed = (before[file] ?? "").split("\n").map((line) => line ? `-${line}` : "-").join("\n");
    const added = (after[file] ?? "").split("\n").map((line) => line ? `+${line}` : "+").join("\n");
    blocks.push(`diff --git a/${oldPath} b/${oldPath}\n--- a/${oldPath}\n+++ b/${oldPath}\n@@\n${removed}\n${added}\n`);
  }
  return blocks.join("");
};

const appendSkillImpact = async ({ runRoot, iteration, attempt, proposal, baseline, candidate, accepted, activeRoot, candidateRoot, manifest }) => {
  const diff = await proposalImpactDiff(activeRoot, candidateRoot, proposal, manifest);
  const impact = [
    `## Iteration ${iteration} / Attempt ${attempt}`,
    `- target: ${proposal.skillId ?? "none"}`,
    `- proposal: ${proposal.action}`,
    `- baseline: ${baseline}`,
    `- candidate: ${candidate}`,
    `- verdict: ${accepted ? "accepted" : "rejected"}`,
    "",
    "```json",
    json(proposal).trimEnd(),
    "```",
    ...(diff ? ["", "```diff", diff.trimEnd(), "```"] : []),
    ""
  ].join("\n");
  await fsp.appendFile(path.join(runRoot, "wiki", "skill-impact.md"), `${impact}\n`, "utf8");
  return diff;
};

async function createRun(config) {
  const projectedSkills = (config.projectedSkills || []).map(normalizeProjectedSkill);
  let inspection;
  if (config.mode === "empty" || (projectedSkills.length > 0 && (config.skillRoots || []).length === 0)) {
    const repo = await resolveGitRoot(config.repo);
    inspection = {
      repo,
      baseCommit: git(repo, ["rev-parse", "HEAD"]),
      ...(gitOptional(repo, ["remote", "get-url", "origin"]) ? { remoteIdentity: gitOptional(repo, ["remote", "get-url", "origin"]) } : {}),
      skills: []
    };
  } else inspection = await inspectRepository({ repo: config.repo, skillRoots: config.skillRoots || [] });
  if (config.baseCommit !== undefined && config.baseCommit !== inspection.baseCommit) {
    throw new WikiSkillError(`Repository HEAD does not match requested baseCommit: ${config.baseCommit}.`);
  }
  const datasetInput = typeof config.dataset === "string" ? JSON.parse(await fsp.readFile(path.resolve(config.dataset), "utf8")) : config.dataset;
  const dataset = validateDataset(datasetInput);
  if (config.configDigest !== undefined && (typeof config.configDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(config.configDigest))) {
    throw new WikiSkillError("configDigest must be a sha256 digest when supplied.");
  }
  if (config.agentRunner) createCommandRunner(config.agentRunner);
  const trainingRolloutsPerTask = config.trainingRolloutsPerTask === undefined ? 1 : Number(config.trainingRolloutsPerTask);
  if (!Number.isInteger(trainingRolloutsPerTask) || trainingRolloutsPerTask < 1 || trainingRolloutsPerTask > 10) throw new WikiSkillError("trainingRolloutsPerTask must be an integer between 1 and 10.");
  const evaluationRolloutsPerTask = config.evaluationRolloutsPerTask === undefined ? 1 : Number(config.evaluationRolloutsPerTask);
  if (!Number.isInteger(evaluationRolloutsPerTask) || evaluationRolloutsPerTask < 1 || evaluationRolloutsPerTask > 10) throw new WikiSkillError("evaluationRolloutsPerTask must be an integer between 1 and 10.");
  const targetIds = new Set((config.targetSkills || []).map((item) => typeof item === "string" ? item : item.id));
  const contextIds = new Set((config.contextSkills || []).map((item) => typeof item === "string" ? item : item.id));
  const selected = inspection.skills.filter((skill) => targetIds.has(skill.id) || contextIds.has(skill.id));
  if (config.mode !== "empty" && targetIds.size === 0 && contextIds.size === 0 && projectedSkills.length === 0) throw new WikiSkillError("run requires explicit targetSkills, contextSkills, or projectedSkills selection.");
  if (selected.length !== targetIds.size + contextIds.size) throw new WikiSkillError("Selected Skill id is not present in the inspected roots.");
  const targetSkills = selected.filter((skill) => targetIds.has(skill.id));
  const contextSkills = selected.filter((skill) => contextIds.has(skill.id));
  const selectedIds = new Set(selected.map((skill) => skill.id));
  const projectedIds = new Set();
  for (const projected of projectedSkills) {
    if (selectedIds.has(projected.id) || projectedIds.has(projected.id)) throw new WikiSkillError(`Projected Skill id conflicts with selected Skill: ${projected.id}.`);
    projectedIds.add(projected.id);
  }
  const projectedTargetSkills = projectedSkills.filter((skill) => skill.mode === "target").map(projectedSkillDescriptor);
  const projectedContextSkills = projectedSkills.filter((skill) => skill.mode === "context").map(projectedSkillDescriptor);
  const newSkillRoot = config.newSkillRoot === undefined ? undefined : normalizeRelative(config.newSkillRoot, "newSkillRoot");
  const newSkillIds = config.newSkillIds === undefined ? [] : config.newSkillIds;
  if (!Array.isArray(newSkillIds) || newSkillIds.some((id) => !validSkillId(id))) throw new WikiSkillError("newSkillIds must contain safe Skill ids.");
  if (targetSkills.some((skill) => contextIds.has(skill.id))) throw new WikiSkillError("A Skill cannot be both target and context.");
  if (!config.allowDirtyTargets && targetSkills.some((skill) => skill.gitStatus)) throw new WikiSkillError("Target Skill has uncommitted changes; use allowDirtyTargets only when explicitly intended.");
  const home = path.resolve(config.stateRoot || process.env.WIKISKILL_HOME || path.join(os.homedir(), ".wikiskill"));
  const repoFingerprint = sha256(inspection.repo).slice(0, 16);
  if (config.runId !== undefined && !validRunId(config.runId)) throw new WikiSkillError("runId must be a safe path segment.");
  const runId = config.runId || `run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const runRoot = path.join(home, "projects", repoFingerprint, "runs", runId);
  if (await exists(runRoot)) throw new WikiSkillError(`Run already exists: ${runId}`);
  const activeRoot = path.join(runRoot, "skills", "active");
  const contextRoot = path.join(runRoot, "skills", "context");
  const snapshotRoot = path.join(runRoot, "skills", "snapshots");
  await Promise.all([fsp.mkdir(activeRoot, { recursive: true }), fsp.mkdir(contextRoot, { recursive: true }), fsp.mkdir(snapshotRoot, { recursive: true })]);
  for (const skill of targetSkills) {
    const destination = path.join(activeRoot, skill.id);
    await copyTree(path.join(inspection.repo, skill.path), destination);
    await writeInitialPurpose(destination, skill);
  }
  for (const skill of contextSkills) {
    const destination = path.join(contextRoot, skill.id);
    await copyTree(path.join(inspection.repo, skill.path), destination);
    await writeInitialPurpose(destination, skill);
  }
  for (const projected of projectedSkills) await writeProjectedSkill(projected.mode === "target" ? activeRoot : contextRoot, projected);
  const activeSkills = await inspectMaterializedSkillSet([activeRoot, contextRoot]);
  const activeSkillSetDigest = skillSetDigest(activeSkills);
  if (config.expectedActiveSkillSetDigest !== undefined) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(config.expectedActiveSkillSetDigest)) throw new WikiSkillError("expectedActiveSkillSetDigest must be a sha256 digest when supplied.");
    if (config.expectedActiveSkillSetDigest !== activeSkillSetDigest) throw new WikiSkillError("Created run active Skill set differs from the frozen evolution baseline.");
  }
  for (const skill of [...targetSkills, ...projectedTargetSkills]) {
    const source = path.join(activeRoot, skill.id);
    await copyTree(source, path.join(snapshotRoot, skill.id));
  }
  await fsp.mkdir(path.join(runRoot, "raw", "traces"), { recursive: true });
  await fsp.mkdir(path.join(runRoot, "runs", "proposals"), { recursive: true });
  await fsp.mkdir(path.join(runRoot, "wiki", "patterns"), { recursive: true });
  await fsp.mkdir(path.join(runRoot, "dataset"), { recursive: true });
  await fsp.mkdir(path.join(runRoot, "source"), { recursive: true });
  await fsp.writeFile(path.join(runRoot, "wiki", "index.md"), "# Pattern Index\n\n_No patterns yet._\n");
  await fsp.writeFile(path.join(runRoot, "wiki", "log.md"), "# Evolution Log\n");
  await fsp.writeFile(path.join(runRoot, "wiki", "skill-impact.md"), "# Skill Impact\n");
  await fsp.mkdir(path.join(runRoot, "tasks"), { recursive: true });
  await fsp.writeFile(path.join(runRoot, "tasks", "task-set.json"), json(dataset));
  await fsp.writeFile(path.join(runRoot, "dataset", "dataset.json"), json(dataset));
  const sourceSkills = [
    ...targetSkills.map((skill) => ({ id: skill.id, role: "target", path: skill.path, files: skill.files })),
    ...contextSkills.map((skill) => ({ id: skill.id, role: "context", path: skill.path, files: skill.files })),
    ...projectedSkills.map((skill) => ({ id: skill.id, role: skill.mode, path: skill.destination, projection: true, files: Object.fromEntries(Object.entries(skill.files).map(([file, content]) => [file, digestText(content)])) }))
  ];
  await fsp.writeFile(path.join(runRoot, "source", "skill-map.json"), json({
    schema: "wikiskill.source-skill-map.v1",
    repo: inspection.repo,
    baseCommit: inspection.baseCommit,
    ...(inspection.remoteIdentity ? { remoteIdentity: inspection.remoteIdentity } : {}),
    skills: sourceSkills.map(({ files: _ignored, ...skill }) => skill)
  }));
  await fsp.writeFile(path.join(runRoot, "source", "baseline-digests.json"), json({
    schema: "wikiskill.baseline-digests.v1",
    repo: inspection.repo,
    baseCommit: inspection.baseCommit,
    skills: sourceSkills.map((skill) => ({ id: skill.id, role: skill.role, path: skill.path, files: skill.files }))
  }));
  const workspaceOnlyFiles = Object.fromEntries(targetSkills
    .filter((skill) => !("PURPOSE.md" in skill.files))
    .map((skill) => [skill.id, ["PURPOSE.md"]]));
  const manifest = {
    schema: "wikiskill.run.v1",
    runId,
    ...(config.retryOf ? { retryOf: config.retryOf } : {}),
    ...(config.reworkOf ? { reworkOf: config.reworkOf } : {}),
    runRoot,
    repo: inspection.repo,
    repoIdentity: `commit:${inspection.baseCommit}`,
    baseCommit: inspection.baseCommit,
    ...(inspection.remoteIdentity ? { remoteIdentity: inspection.remoteIdentity } : {}),
    targetSkills: [...targetSkills, ...projectedTargetSkills],
    contextSkills: [...contextSkills, ...projectedContextSkills],
    activeSkills,
    activeSkillSetDigest,
    ...(newSkillRoot ? { newSkillRoot } : {}),
    ...(newSkillIds.length ? { newSkillIds: [...new Set(newSkillIds)] } : {}),
    workspaceOnlyFiles,
    engine: { version: ENGINE_VERSION },
    ...(config.configDigest ? { configDigest: config.configDigest } : {}),
    dataset: { digest: dataset.digest, adapter: dataset.adapter },
    adapterModule: config.adapterModule,
    adapterConfig: config.adapterConfig,
    adapterDigest: digestText(json({ adapter: dataset.adapter, adapterModule: config.adapterModule, adapterConfig: config.adapterConfig })),
    runnerModule: config.runnerModule,
    runnerConfig: config.runnerConfig,
    agentRunner: config.agentRunner,
    runnerDigest: digestText(json({ runnerModule: config.runnerModule, runnerConfig: config.runnerConfig, agentRunner: config.agentRunner })),
    model: config.model,
    modelDigest: digestText(json(config.model ?? null)),
    ...(config.runtime ? { runtime: config.runtime } : {}),
    ...(config.frozenComponents ? { frozenComponents: config.frozenComponents } : {}),
    maintainerModule: config.maintainerModule,
    proposerModule: config.proposerModule,
    learningAgent: config.learningAgent,
    trainingRolloutsPerTask,
    evaluationRolloutsPerTask,
    iterationLimit: Math.min(20, Math.max(1, Number(config.iterationLimit || 1))),
    mode: config.mode === "empty" ? "empty" : "seeded",
    ...(config.rawReferencePrefix ? { rawReferencePrefix: config.rawReferencePrefix } : {}),
    createdAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(runRoot, "manifest.json"), json(manifest));
  await fsp.writeFile(path.join(runRoot, "runs", "state.json"), json({ schema: "wikiskill.state.v1", status: "created", iteration: 0, bestValidationScore: null, acceptedIterations: [] }));
  return manifest;
}

async function readRun(run) { const manifest = JSON.parse(await fsp.readFile(path.join(run, "manifest.json"), "utf8")); const state = JSON.parse(await fsp.readFile(path.join(run, "runs", "state.json"), "utf8")); return { manifest, state }; }
async function resolveRun(runOrId, stateRoot) {
  if (path.isAbsolute(runOrId) && await exists(path.join(runOrId, "manifest.json"))) return path.resolve(runOrId);
  const home = path.resolve(stateRoot || process.env.WIKISKILL_HOME || path.join(os.homedir(), ".wikiskill"));
  const matches = [];
  const projects = await fsp.readdir(path.join(home, "projects"), { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((item) => item.isDirectory())) {
    const candidate = path.join(home, "projects", project.name, "runs", runOrId);
    if (await exists(path.join(candidate, "manifest.json"))) matches.push(candidate);
  }
  if (matches.length !== 1) throw new WikiSkillError(matches.length ? `Run id is ambiguous: ${runOrId}` : `Run not found: ${runOrId}`);
  return matches[0];
}
const activeSkillDigest = async (activeRoot, contextRoot) => skillSetDigest(await inspectMaterializedSkillSet([activeRoot, contextRoot]));
async function runEvolution(runOrId, options = {}) {
  const runRoot = await resolveRun(runOrId, options.stateRoot);
  const { manifest } = await readRun(runRoot);
  const dataset = validateDataset(JSON.parse(await fsp.readFile(path.join(runRoot, "tasks", "task-set.json"), "utf8")));
  const adapter = resolveAdapter(options, manifest);
  const runner = resolveRunner(options, manifest);
  const model = options.model ?? manifest.model;
  const abortSignal = options.abortSignal;
  const trainingRolloutsPerTask = manifest.trainingRolloutsPerTask ?? 1;
  const evaluationRolloutsPerTask = manifest.evaluationRolloutsPerTask ?? 1;
  await adapter.validateDataset?.(dataset);
  const statePath = path.join(runRoot, "runs", "state.json");
  let state = JSON.parse(await fsp.readFile(statePath, "utf8"));
  const activeRoot = path.join(runRoot, "skills", "active");
  const contextRoot = path.join(runRoot, "skills", "context");
  const readSkills = async (targetRoot) => {
    const result = {};
    for (const id of await fsp.readdir(targetRoot).catch(() => [])) result[id] = await fileContentMap(path.join(targetRoot, id));
    return result;
  };
  const skills = async (targetRoot = activeRoot) => ({ target: await readSkills(targetRoot), context: await readSkills(contextRoot) });
  const targetIds = new Set(manifest.targetSkills.map((skill) => skill.id));
  const proposalPolicy = () => ({
    targetIds,
    newSkillRoot: manifest.newSkillRoot,
    allowedNewSkillIds: new Set(manifest.newSkillIds || []),
    existingSkillIds: new Set([...(manifest.targetSkills || []).map((skill) => skill.id), ...(state.createdSkills || []).map((skill) => skill.id)])
  });
  const attempt = (Number.isInteger(state.attempt) ? state.attempt : 0) + 1;
  const traceDirectory = (name) => attempt === 1 ? name : path.join(`attempt-${String(attempt).padStart(2, "0")}`, name);
  state.attempt = attempt;
  state.status = "running";
  state.blockers = [];
  await fsp.writeFile(statePath, json(state));
  const registerRuntimeSession = async (kind, providerInput) => {
    const provider = normalizeProviderSession(providerInput, `${kind} invocation`);
    const existing = state.runtimeSessions || [];
    if (existing.some((item) => item.provider.ref === provider.ref && item.provider.sessionId === provider.sessionId)) {
      throw new WikiSkillError(`Provider session was reused within one evolution run: ${provider.ref}/${provider.sessionId}`);
    }
    state.runtimeSessions = [...existing, { kind, provider }];
    await fsp.writeFile(statePath, json(state));
    return provider;
  };
  const recordInferenceInvocation = async (value) => {
    const provider = await registerRuntimeSession("inference", value.provider);
    if (!INFERENCE_PHASES.has(value.phase)) throw new WikiSkillError(`Inference invocation phase is invalid: ${String(value.phase)}`);
    state.inferenceInvocations = [...(state.inferenceInvocations || []), { schema: "wikiskill.inference-invocation.v1", launchRef: value.launchRef, taskId: value.taskId, split: value.split, phase: value.phase, iteration: value.iteration, rollout: value.rollout, provider }];
    await fsp.writeFile(statePath, json(state));
  };
  const recordLearningInvocation = async (value) => {
    if (!isRecord(value) || value.schema !== "wikiskill.learning-invocation.v1" || !["maintainer", "proposer-select", "proposer"].includes(value.role) || typeof value.launchRef !== "string" || !value.launchRef.trim()) {
      throw new WikiSkillError("Learning invocation receipt is invalid.");
    }
    const provider = await registerRuntimeSession("learning", value.provider);
    const existing = state.learningInvocations || [];
    state.learningInvocations = [...existing, { schema: "wikiskill.learning-invocation.v1", launchRef: value.launchRef.trim(), role: value.role, provider }];
    await fsp.writeFile(statePath, json(state));
  };
  try {
    if (state.bestValidationScore === null) {
      const valBaseline = [];
      for (const task of splitTasks(dataset, "val")) {
        for (let rollout = 1; rollout <= evaluationRolloutsPerTask; rollout += 1) valBaseline.push(await makeTrace({ runRoot, task, split: "val", phase: "baseline_validation", iteration: 0, attempt, rollout, skillDigest: await activeSkillDigest(activeRoot, contextRoot), skills: await skills(), adapter, runner, model, abortSignal, wiki: null, traceDirectory: traceDirectory("iter-00"), recordInferenceInvocation }));
      }
      state.bestValidationScore = aggregate(valBaseline);
      state.baselineValidationScore = state.bestValidationScore;
      await fsp.writeFile(statePath, json(state));
    }
    const max = Math.min(manifest.iterationLimit, options.iterationLimit || manifest.iterationLimit);
    for (let iteration = Math.max(1, state.iteration + 1); iteration <= max; iteration += 1) {
      if (state.bestValidationScore === 1) {
        state.earlyStopped = true;
        state.earlyStopReason = "validation_score_perfect";
        break;
      }
      const train = [];
      const trainTasks = splitTasks(dataset, "train");
      for (const task of trainTasks) {
        for (let rollout = 1; rollout <= trainingRolloutsPerTask; rollout += 1) {
          train.push(await makeTrace({ runRoot, task, split: "train", phase: "training", iteration, attempt, rollout, skillDigest: await activeSkillDigest(activeRoot, contextRoot), skills: await skills(), adapter, runner, model, abortSignal, wiki: undefined, traceDirectory: traceDirectory(`iter-${String(iteration).padStart(2, "0")}`), recordInferenceInvocation }));
        }
      }
      if (train.length < 4) throw new WikiSkillError("The configured training rollout produced fewer than four trajectories required by the Proposer trace-read contract.");
      const sampled = sampleTraces(train);
      await runMaintainer(runRoot, iteration, sampled, { ...options, manifest, attempt, recordLearningInvocation });
      const availableTraces = train.map((item) => ({
        id: item.trace.id,
        taskId: item.trace.taskId,
        score: item.trace.score
      }));
      const readIds = new Set();
      const readTrace = (taskId) => {
        const found = train.find((item) => item.trace.id === taskId);
        if (found) readIds.add(taskId);
        return found ? traceForLearning(found.trace) : undefined;
      };
      const proposer = resolveLearningRole("proposer", options, manifest);
      if (!proposer) {
        throw new WikiSkillError("Validation score is below 1.0 but no WikiSkill proposer is configured. Supply learningAgent, proposerModule, or a proposer function.");
      }
      const proposal = await proposer({ iteration, attempt, wikiRoot: path.join(runRoot, "wiki"), skills: await skills(), allowedNewSkillIds: manifest.newSkillIds || [], recordInvocation: recordLearningInvocation, training: train.map((item) => {
        const sourceTask = dataset.tasks.find((candidate) => candidate.id === item.trace.taskId);
        const groundTruthSummary = sourceTask?.evaluator.capabilityRef === "builtin:command-exit-v1"
          ? JSON.stringify({ schema: sourceTask.groundTruth.schema, allowedPaths: sourceTask.groundTruth.allowedPaths || [], passed: item.trace.score === 1 })
          : JSON.stringify(sourceTask?.groundTruth);
        return { trajectoryId: item.trace.id, taskId: item.trace.taskId, prediction: item.trace.prediction, groundTruthSummary, score: item.trace.score };
      }), availableTraces, readTrace });
      const requestedTraceReads = Array.isArray(proposal?.traceReads) ? [...new Set(proposal.traceReads)] : [];
      const minimumTraceReads = Math.min(4, train.length);
      if (requestedTraceReads.length < minimumTraceReads || requestedTraceReads.some((id) => !availableTraces.some((trace) => trace.id === id))) {
        throw new WikiSkillError(`Proposer must select at least ${minimumTraceReads} available training traces.`);
      }
      if (requestedTraceReads.some((id) => !readIds.has(id))) throw new WikiSkillError("Proposer declared a training trace that it did not read.");
      const proposalPath = path.join(runRoot, "runs", "proposals", `iter-${String(iteration).padStart(2, "0")}-attempt-${String(attempt).padStart(2, "0")}.json`);
      await fsp.writeFile(proposalPath, json(proposal));
      const candidateRoot = path.join(runRoot, "skills", "candidate");
      await fsp.rm(candidateRoot, { recursive: true, force: true });
      await copyTree(activeRoot, candidateRoot);
      await applyProposal(candidateRoot, proposal, proposalPolicy());
      const candidateTraces = [];
      for (const task of splitTasks(dataset, "val")) {
        for (let rollout = 1; rollout <= evaluationRolloutsPerTask; rollout += 1) candidateTraces.push(await makeTrace({ runRoot, task, split: "val", phase: "candidate_validation", iteration, attempt, rollout, skillDigest: await activeSkillDigest(candidateRoot, contextRoot), skills: await skills(candidateRoot), adapter, runner, model, abortSignal, wiki: null, traceDirectory: traceDirectory(`iter-${String(iteration).padStart(2, "0")}-candidate`), recordInferenceInvocation }));
      }
      const candidateScore = aggregate(candidateTraces);
      const accepted = candidateScore > state.bestValidationScore;
      const proposalDiff = await appendSkillImpact({
        runRoot,
        iteration,
        attempt,
        proposal,
        baseline: state.bestValidationScore,
        candidate: candidateScore,
        accepted,
        activeRoot,
        candidateRoot,
        manifest
      });
      state.proposalHistory = [
        ...(state.proposalHistory || []),
        {
          iteration,
          attempt,
          action: proposal.action,
          ...(proposal.skillId ? { skillId: proposal.skillId } : {}),
          baselineValidationScore: state.bestValidationScore,
          candidateValidationScore: candidateScore,
          accepted,
          proposalPath: path.relative(runRoot, proposalPath).split(path.sep).join("/"),
          proposalDiffDigest: digestText(proposalDiff)
        }
      ];
      if (accepted) {
        await fsp.rm(activeRoot, { recursive: true, force: true });
        await fsp.rename(candidateRoot, activeRoot);
        state.bestValidationScore = candidateScore;
        state.acceptedIterations.push(iteration);
        if (proposal.action === "create") state.createdSkills = [...(state.createdSkills || []), { id: proposal.skillId, sourcePath: path.join(manifest.newSkillRoot, proposal.skillId).split(path.sep).join("/") }];
      }
      state.iteration = iteration;
      await fsp.writeFile(statePath, json(state));
    }
    const baselineTest = [];
    const baselineRoot = path.join(runRoot, "skills", "snapshots");
    for (const task of splitTasks(dataset, "test")) {
      for (let rollout = 1; rollout <= evaluationRolloutsPerTask; rollout += 1) baselineTest.push(await makeTrace({ runRoot, task, split: "test", phase: "baseline_test", iteration: state.iteration + 1, attempt, rollout, skillDigest: await activeSkillDigest(baselineRoot, contextRoot), skills: await skills(baselineRoot), adapter, runner, model, abortSignal, wiki: null, traceDirectory: traceDirectory("final-baseline"), recordInferenceInvocation }));
    }
    state.baselineTestScore = aggregate(baselineTest);
    const test = [];
    for (const task of splitTasks(dataset, "test")) {
      for (let rollout = 1; rollout <= evaluationRolloutsPerTask; rollout += 1) test.push(await makeTrace({ runRoot, task, split: "test", phase: "final_test", iteration: state.iteration + 1, attempt, rollout, skillDigest: await activeSkillDigest(activeRoot, contextRoot), skills: await skills(), adapter, runner, model, abortSignal, wiki: null, traceDirectory: traceDirectory("final"), recordInferenceInvocation }));
    }
    state.testScore = aggregate(test);
    state.testGain = state.testScore - state.baselineTestScore;
    state.status = "completed";
    if (options.providerLaunchBudget?.snapshot) state.providerLaunchBudget = options.providerLaunchBudget.snapshot();
    await fsp.writeFile(statePath, json(state));
    const resultBundle = await createResultBundle(runRoot, manifest, state);
    return { ...manifest, state, ...resultBundle };
  } catch (error) {
    state.status = abortSignal?.aborted ? "stopped" : "blocked";
    state.blockers = [error instanceof Error ? error.message : String(error)];
    if (options.providerLaunchBudget?.snapshot) state.providerLaunchBudget = options.providerLaunchBudget.snapshot();
    const failureArtifactPath = error && typeof error === "object" && typeof error.wikiskillFailureArtifactPath === "string"
      ? error.wikiskillFailureArtifactPath
      : undefined;
    if (failureArtifactPath) state.failureArtifacts = [...new Set([...(state.failureArtifacts || []), failureArtifactPath])];
    await fsp.writeFile(statePath, json(state));
    throw error;
  }
}

async function createResultBundle(runRoot, manifest, state) {
  const resultRoot = path.join(runRoot, "result");
  await fsp.rm(resultRoot, { recursive: true, force: true });
  await fsp.mkdir(path.join(resultRoot, "skills"), { recursive: true });
  await copyTree(path.join(runRoot, "skills", "active"), path.join(resultRoot, "skills"));
  const entries = [];
  for (const skill of [...manifest.targetSkills]) {
    if (skill.projected && state.acceptedIterations.length === 0) continue;
    const final = path.join(resultRoot, "skills", skill.id);
    const workspaceOnly = new Set(manifest.workspaceOnlyFiles?.[skill.id] || []);
    const finalFiles = Object.fromEntries(Object.entries(await fileDigestMap(final)).filter(([file]) => !workspaceOnly.has(file)));
    const changedFiles = skill.projected
      ? Object.keys(finalFiles)
      : Object.keys(finalFiles).filter((file) => finalFiles[file] !== skill.files[file]);
    const deletedFiles = Object.keys(skill.files).filter((file) => !(file in finalFiles));
    entries.push({ operation: skill.projected ? "create" : "update", skillId: skill.id, sourcePath: skill.path, baselineFiles: skill.files, finalFiles, files: changedFiles, deletedFiles });
  }
  for (const created of state.createdSkills || []) {
    const final = path.join(resultRoot, "skills", created.id);
    const finalFiles = await fileDigestMap(final);
    entries.push({ operation: "create", skillId: created.id, sourcePath: created.sourcePath, baselineFiles: {}, finalFiles, files: Object.keys(finalFiles), deletedFiles: [] });
  }
  const patchBody = await buildPatch(runRoot, manifest, entries, false);
  const reversePatchBody = await buildPatch(runRoot, manifest, entries, true);
  const patchDigest = digestText(patchBody);
  const reversePatchDigest = digestText(reversePatchBody);
  const applyManifest = {
    schema: "wikiskill.apply-manifest.v1",
    runId: manifest.runId,
    repo: manifest.repo,
    repoIdentity: manifest.repoIdentity,
    baseCommit: manifest.baseCommit,
    ...(manifest.remoteIdentity ? { remoteIdentity: manifest.remoteIdentity } : {}),
    engine: manifest.engine,
    dataset: manifest.dataset,
    ...(manifest.configDigest ? { configDigest: manifest.configDigest } : {}),
    adapterDigest: manifest.adapterDigest,
    runnerDigest: manifest.runnerDigest,
    modelDigest: manifest.modelDigest,
    proposalHistory: state.proposalHistory || [],
    acceptedIterations: state.acceptedIterations,
    baselineValidationScore: state.baselineValidationScore,
    finalValidationScore: state.bestValidationScore,
    testScore: state.testScore,
    entries,
    changesPatchDigest: patchDigest,
    reversePatchDigest
  };
  const applyManifestDigest = digestText(json(applyManifest));
  const semanticResult = {
    engine: manifest.engine,
    ...(manifest.configDigest ? { configDigest: manifest.configDigest } : {}),
    dataset: manifest.dataset,
    adapterDigest: manifest.adapterDigest,
    runnerDigest: manifest.runnerDigest,
    modelDigest: manifest.modelDigest,
    proposalHistory: (state.proposalHistory || []).map(({ proposalPath: _path, ...entry }) => entry),
    baselineValidationScore: state.baselineValidationScore,
    finalValidationScore: state.bestValidationScore,
    testScore: state.testScore,
    acceptedIterations: state.acceptedIterations,
    earlyStopped: state.earlyStopped === true,
    ...(state.earlyStopReason ? { earlyStopReason: state.earlyStopReason } : {}),
    changesPatchDigest: patchDigest,
    reversePatchDigest
  };
  const semanticResultDigest = digestText(json(semanticResult));
  const inference = [];
  for (const tracePath of await sortedFiles(path.join(runRoot, "raw", "traces"))) {
    const trace = JSON.parse(await fsp.readFile(tracePath, "utf8"));
    if (trace.provider) inference.push({ launchRef: trace.launchRef, traceId: trace.id, traceRef: path.relative(runRoot, tracePath).split(path.sep).join("/"), taskId: trace.taskId, split: trace.split, phase: trace.phase, iteration: trace.iteration, rollout: trace.rollout, provider: trace.provider });
  }
  const runtimeEvidence = {
    schema: "wikiskill.runtime-evidence.v2",
    runId: manifest.runId,
    inference,
    learning: state.learningInvocations || [],
    cohort: manifest.runtime ? {
      provider: manifest.runtime.provider,
      modelId: manifest.runtime.modelId,
      reasoningEffort: manifest.runtime.reasoningEffort,
      scorerRef: manifest.runtime.scorerRef,
      toolProfile: manifest.runtime.toolProfile
    } : null,
    launchBudget: state.providerLaunchBudget
  };
  const runtimeEvidenceText = json(runtimeEvidence);
  const runtimeEvidenceDigest = `sha256:${sha256(runtimeEvidenceText)}`;
  await fsp.writeFile(path.join(resultRoot, "runtime-evidence.json"), runtimeEvidenceText);
  const result = { schema: "wikiskill.result.v1", runId: manifest.runId, ...semanticResult, semanticResultDigest, applyManifestDigest, applyManifest: "apply-manifest.json", runtimeEvidence: "runtime-evidence.json", runtimeEvidenceDigest };
  await fsp.writeFile(path.join(resultRoot, "result.json"), json(result));
  await fsp.writeFile(path.join(resultRoot, "apply-manifest.json"), json(applyManifest));
  await fsp.writeFile(path.join(resultRoot, "wiki-summary.md"), await fsp.readFile(path.join(runRoot, "wiki", "index.md"), "utf8"));
  await fsp.writeFile(path.join(resultRoot, "changes.patch"), patchBody);
  await fsp.writeFile(path.join(resultRoot, "reverse.patch"), reversePatchBody);
  return { runtimeEvidenceDigest };
}

async function buildPatch(runRoot, manifest, entries, reverse) {
  const blocks = [];
  for (const entry of entries) {
    const baselineRoot = path.join(runRoot, "skills", "snapshots", entry.skillId);
    const finalRoot = path.join(runRoot, "result", "skills", entry.skillId);
    const files = new Set([...Object.keys(entry.baselineFiles), ...Object.keys(entry.finalFiles)]);
    for (const file of [...files].sort()) {
      const before = entry.operation === "create"
        ? ""
        : await exists(path.join(baselineRoot, file)) ? await fsp.readFile(path.join(baselineRoot, file), "utf8") : "";
      const after = await exists(path.join(finalRoot, file)) ? await fsp.readFile(path.join(finalRoot, file), "utf8") : "";
      if (before === after) continue;
      const oldPath = `${entry.sourcePath}/${file}`;
      const newPath = `${entry.sourcePath}/${file}`;
      const from = reverse ? after : before;
      const to = reverse ? before : after;
      const removed = from.split("\n").map((line) => line ? `-${line}` : "-").join("\n");
      const added = to.split("\n").map((line) => line ? `+${line}` : "+").join("\n");
      blocks.push(`diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n@@\n${removed}\n${added}\n`);
    }
  }
  return blocks.join("");
}

async function applyRun(runOrId, { repo, dryRun = false, stateRoot } = {}) {
  const runRoot = await resolveRun(runOrId, stateRoot);
  const { manifest, state } = await readRun(runRoot);
  if (state.status !== "completed") throw new WikiSkillError("Only a completed run can be applied.");
  const targetRoot = await resolveGitRoot(repo);
  if (git(targetRoot, ["rev-parse", "HEAD"]) !== manifest.baseCommit) throw new WikiSkillError("Repository identity does not match the frozen run commit.");
  const bundle = JSON.parse(await fsp.readFile(path.join(runRoot, "result", "apply-manifest.json"), "utf8"));
  const result = JSON.parse(await fsp.readFile(path.join(runRoot, "result", "result.json"), "utf8"));
  if (digestText(json(bundle)) !== result.applyManifestDigest) throw new WikiSkillError("Result manifest integrity check failed.");
  const changesPatch = await fsp.readFile(path.join(runRoot, "result", "changes.patch"), "utf8");
  const reversePatch = await fsp.readFile(path.join(runRoot, "result", "reverse.patch"), "utf8");
  if (digestText(changesPatch) !== bundle.changesPatchDigest || digestText(reversePatch) !== bundle.reversePatchDigest) throw new WikiSkillError("Result patch integrity check failed.");
  const changes = [];
  for (const entry of bundle.entries) {
    const relative = normalizeRelative(entry.sourcePath, "destination");
    const destination = path.resolve(targetRoot, relative);
    if (!destination.startsWith(`${targetRoot}${path.sep}`) || !destination.startsWith(`${path.resolve(targetRoot, path.dirname(relative))}${path.sep}`)) throw new WikiSkillError(`Destination escapes repository: ${relative}`);
    await assertNoSymlink(targetRoot, relative);
    if (entry.operation === "create" && await exists(destination)) throw new WikiSkillError(`New Skill destination already exists: ${relative}.`);
    // A selected target is an atomic apply unit even when its accepted final
    // files happen to be unchanged. Check every frozen source file first.
    for (const [file, baselineDigest] of Object.entries(entry.baselineFiles)) {
      normalizeRelative(file, "baseline file");
      const destinationFile = path.join(targetRoot, relative, file);
      await assertNoSymlink(targetRoot, path.join(relative, file).split(path.sep).join("/"));
      const currentDigest = await exists(destinationFile) ? digestText(await fsp.readFile(destinationFile, "utf8")) : null;
      if (currentDigest !== baselineDigest) throw new WikiSkillError(`Target digest conflict at ${path.join(relative, file)}.`);
    }
    const normalizedFiles = new Set();
    for (const file of [...entry.files, ...(entry.deletedFiles || [])]) {
      const folded = file.toLocaleLowerCase();
      if (normalizedFiles.has(folded)) throw new WikiSkillError(`Case-normalization collision in result: ${path.join(relative, file)}.`);
      normalizedFiles.add(folded);
    }
    const sourceDirectory = path.join(runRoot, "result", "skills", entry.skillId);
    for (const file of entry.files) {
      normalizeRelative(file, "result file");
      const source = path.join(sourceDirectory, file);
      const dest = path.join(targetRoot, relative, file);
      await assertNoSymlink(targetRoot, path.join(relative, file).split(path.sep).join("/"));
      const currentDigest = await exists(dest) ? digestText(await fsp.readFile(dest, "utf8")) : null;
      const baselineDigest = entry.baselineFiles[file] || null;
      if (currentDigest !== baselineDigest) throw new WikiSkillError(`Target digest conflict at ${path.join(relative, file)}.`);
      const finalDigest = entry.finalFiles[file];
      if (finalDigest !== digestText(await fsp.readFile(source, "utf8"))) throw new WikiSkillError(`Result digest integrity failure at ${path.join(relative, file)}.`);
      changes.push({ source, dest, relative: path.join(relative, file).split(path.sep).join("/"), content: await fsp.readFile(source, "utf8"), baselineDigest, finalDigest });
    }
    for (const file of entry.deletedFiles || []) {
      normalizeRelative(file, "deleted result file");
      const dest = path.join(targetRoot, relative, file);
      await assertNoSymlink(targetRoot, path.join(relative, file).split(path.sep).join("/"));
      const currentDigest = await exists(dest) ? digestText(await fsp.readFile(dest, "utf8")) : null;
      if (currentDigest !== entry.baselineFiles[file]) throw new WikiSkillError(`Target digest conflict at ${path.join(relative, file)}.`);
      changes.push({ dest, relative: path.join(relative, file).split(path.sep).join("/"), deleted: true, baselineDigest: entry.baselineFiles[file] });
    }
  }
  const payload = { runId: manifest.runId, repo: targetRoot, changedPaths: changes.map((item) => item.relative), diff: changes.map((item) => `--- ${item.relative}\n+++ ${item.relative}\n`).join(""), dryRun };
  if (dryRun) return payload;
  const journal = path.join(runRoot, "result", "apply-journal.json");
  const staging = path.join(targetRoot, `.wikiskill-apply-${manifest.runId}-${process.pid}-${Date.now()}`);
  const backups = [];
  const createdDirectories = [];
  await fsp.mkdir(staging, { recursive: true });
  try {
    for (const [index, item] of changes.entries()) {
      if (item.deleted) continue;
      item.stagedPath = path.join(staging, "new", String(index));
      await fsp.mkdir(path.dirname(item.stagedPath), { recursive: true });
      await fsp.writeFile(item.stagedPath, item.content, "utf8");
      if (digestText(await fsp.readFile(item.stagedPath, "utf8")) !== item.finalDigest) throw new WikiSkillError(`Staged final digest mismatch at ${item.relative}.`);
    }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
  await fsp.writeFile(journal, json({ schema: "wikiskill.apply-journal.v1", status: "applying", runId: manifest.runId, staging, changedPaths: payload.changedPaths }));
  try {
    for (const [index, item] of changes.entries()) {
      let directory = path.dirname(item.dest);
      const missing = [];
      while (directory !== targetRoot && !(await exists(directory))) { missing.push(directory); directory = path.dirname(directory); }
      await fsp.mkdir(path.dirname(item.dest), { recursive: true });
      createdDirectories.push(...missing);
      const current = await exists(item.dest) ? digestText(await fsp.readFile(item.dest, "utf8")) : null;
      if (current !== (item.baselineDigest || null)) throw new WikiSkillError(`Target changed during apply at ${item.relative}.`);
      const backupPath = path.join(staging, "backup", String(index));
      if (await exists(item.dest)) {
        await fsp.mkdir(path.dirname(backupPath), { recursive: true });
        await fsp.rename(item.dest, backupPath);
        backups.push({ dest: item.dest, backupPath });
      } else backups.push({ dest: item.dest });
      if (!item.deleted) await fsp.rename(item.stagedPath, item.dest);
    }
    const postApplyDigests = {};
    for (const item of changes) {
      const actual = await exists(item.dest) ? digestText(await fsp.readFile(item.dest, "utf8")) : null;
      const expected = item.deleted ? null : digestText(item.content);
      if (actual !== expected) throw new WikiSkillError(`Post-apply digest mismatch at ${item.relative}.`);
      postApplyDigests[item.relative] = actual;
    }
    const receipt = { schema: "wikiskill.apply-receipt.v1", id: `receipt-${Date.now()}`, runId: manifest.runId, runRoot, repo: targetRoot, changedPaths: payload.changedPaths, postApplyDigests, reversePatchDigest: bundle.reversePatchDigest, createdAt: new Date().toISOString() };
    await fsp.writeFile(journal, json(receipt));
    await fsp.writeFile(path.join(runRoot, "result", "apply-receipt.json"), json(receipt));
    await fsp.rm(staging, { recursive: true, force: true });
    return { ...payload, receipt };
  } catch (error) {
    const recoveryErrors = [];
    for (const backup of [...backups].reverse()) {
      try {
        await fsp.rm(backup.dest, { force: true });
        if (backup.backupPath && await exists(backup.backupPath)) await fsp.rename(backup.backupPath, backup.dest);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
      }
    }
    for (const directory of createdDirectories.sort((a, b) => b.length - a.length)) await fsp.rm(directory, { recursive: false, force: true }).catch(() => undefined);
    if (recoveryErrors.length) {
      await fsp.writeFile(journal, json({ schema: "wikiskill.apply-journal.v1", status: "recovery_failed", staging, recoveryErrors, changedPaths: payload.changedPaths }));
      throw new WikiSkillError(`Apply failed and recovery was incomplete: ${recoveryErrors.join("; ")}`);
    }
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.writeFile(journal, json({ schema: "wikiskill.apply-journal.v1", status: "rolled_back", changedPaths: payload.changedPaths }));
    throw error;
  }
}

async function resolveReceipt(receiptId, stateRoot) {
  if (path.isAbsolute(receiptId) && await exists(receiptId)) return receiptId;
  const home = path.resolve(stateRoot || process.env.WIKISKILL_HOME || path.join(os.homedir(), ".wikiskill"));
  const found = [];
  const projects = await fsp.readdir(path.join(home, "projects"), { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((item) => item.isDirectory())) {
    const runs = await fsp.readdir(path.join(home, "projects", project.name, "runs"), { withFileTypes: true }).catch(() => []);
    for (const run of runs.filter((item) => item.isDirectory())) {
      const candidate = path.join(home, "projects", project.name, "runs", run.name, "result", "apply-receipt.json");
      if (await exists(candidate)) {
        const receipt = JSON.parse(await fsp.readFile(candidate, "utf8"));
        if (receipt.id === receiptId) found.push(candidate);
      }
    }
  }
  if (found.length !== 1) throw new WikiSkillError(found.length ? `Receipt id is ambiguous: ${receiptId}` : `Receipt not found: ${receiptId}`);
  return found[0];
}

async function rollbackRun(receiptId, { stateRoot } = {}) {
  const receiptPath = await resolveReceipt(receiptId, stateRoot);
  const receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8"));
  const runRoot = receipt.runRoot;
  const { manifest } = await readRun(runRoot);
  const bundle = JSON.parse(await fsp.readFile(path.join(runRoot, "result", "apply-manifest.json"), "utf8"));
  const reversePatch = await fsp.readFile(path.join(runRoot, "result", "reverse.patch"), "utf8");
  if (digestText(reversePatch) !== receipt.reversePatchDigest || digestText(reversePatch) !== bundle.reversePatchDigest) throw new WikiSkillError("Reverse patch integrity check failed.");
  const repo = await resolveGitRoot(receipt.repo);
  const restore = [];
  for (const entry of bundle.entries) {
    const baselineRoot = path.join(runRoot, "skills", "snapshots", entry.skillId);
    for (const file of [...entry.files, ...(entry.deletedFiles || [])]) {
      const relative = path.join(entry.sourcePath, file).split(path.sep).join("/");
      const destination = path.join(repo, entry.sourcePath, file);
      const actual = await exists(destination) ? digestText(await fsp.readFile(destination, "utf8")) : null;
      if (actual !== (receipt.postApplyDigests[relative] || null)) throw new WikiSkillError(`Rollback digest conflict at ${relative}.`);
      const baseline = path.join(baselineRoot, file);
      restore.push({ destination, relative, content: await exists(baseline) ? await fsp.readFile(baseline, "utf8") : undefined });
    }
  }
  for (const item of restore) {
    await fsp.mkdir(path.dirname(item.destination), { recursive: true });
    if (item.content === undefined) await fsp.rm(item.destination, { force: true }); else await fsp.writeFile(item.destination, item.content, "utf8");
  }
  return { receiptId: receipt.id, repo, changedPaths: restore.map((item) => item.relative) };
}

async function exportWiki(runOrId, { repo, destination, dryRun = false, stateRoot } = {}) {
  const runRoot = await resolveRun(runOrId, stateRoot);
  const { manifest } = await readRun(runRoot);
  const targetRoot = await resolveGitRoot(repo);
  if (targetRoot !== manifest.repo) throw new WikiSkillError("Repository identity does not match the run source.");
  const relative = normalizeRelative(destination, "Wiki destination");
  const target = path.resolve(targetRoot, relative);
  if (!target.startsWith(`${targetRoot}${path.sep}`)) throw new WikiSkillError("Wiki destination escapes repository.");
  await assertNoSymlink(targetRoot, relative);
  const files = [];
  for (const file of await sortedFiles(path.join(runRoot, "wiki"))) files.push({ source: file, relative: path.relative(path.join(runRoot, "wiki"), file).split(path.sep).join("/"), destination: path.join(target, path.relative(path.join(runRoot, "wiki"), file)) });
  const payload = { runId: manifest.runId, repo: targetRoot, destination: relative, changedPaths: files.map((item) => path.join(relative, item.relative).split(path.sep).join("/")), dryRun };
  if (dryRun) return payload;
  for (const file of files) { await fsp.mkdir(path.dirname(file.destination), { recursive: true }); await fsp.copyFile(file.source, file.destination); }
  return payload;
}

async function statusRun(runOrId, stateRoot) { const runRoot = await resolveRun(runOrId, stateRoot); return { runRoot, ...(await readRun(runRoot)) }; }
async function diffRun(runOrId, stateRoot) {
  const runRoot = await resolveRun(runOrId, stateRoot);
  const { state } = await readRun(runRoot);
  if (state.status !== "completed") throw new WikiSkillError("Only a completed run can produce a diff.");
  const result = JSON.parse(await fsp.readFile(path.join(runRoot, "result", "result.json"), "utf8"));
  const manifest = JSON.parse(await fsp.readFile(path.join(runRoot, "result", "apply-manifest.json"), "utf8"));
  return { result, manifest, changedPaths: manifest.entries.flatMap((entry) => entry.files.map((file) => path.join(entry.sourcePath, file).split(path.sep).join("/"))) };
}
async function retryRun(runOrId, options = {}) { return runEvolution(runOrId, options); }

module.exports = { DATASET_SCHEMA, TRAJECTORY_SCHEMA, ENVELOPE, WikiSkillError, validateDataset, inspectRepository, createRun, runEvolution, retryRun, statusRun, diffRun, applyRun, rollbackRun, exportWiki, digestText, doctorWorkspace, initWorkspace, uninstallWorkspace, updateBootstrap, renderInferencePrompt, configureEvolution, evolveWorkspace, inspectEvolutionBaseline, statusWorkspaceEvolution, applyCandidate, diffCandidate, rollbackReceipt, prepareContext, getContextSkill, listContextSkillReceipts, recordContextSkillUse };
