"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createBuiltinCapabilityRegistry, learningRefForProvider, runnerRefForProvider } = require("./runtime-capabilities");
const { createProviderLaunchBudget } = require("./provider-launch-budget");
const { prepareTaskDependencies } = require("./task-dependencies");
const { materializeSkillFiles, readSkillFiles, skillBundleDigest, skillSetDigest } = require("./skill-bundle");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONFIG_SCHEMA = "wikiskill.workspace.v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const exists = async (target) => fs.access(target).then(() => true, () => false);

const sortedFiles = async (root) => {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`WikiSkill authority root must be a non-symlink directory: ${root}`);
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`WikiSkill authority path must not be a symlink: ${path.relative(root, target)}`);
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) files.push(target);
      else throw new Error(`Unsupported WikiSkill authority entry: ${path.relative(root, target)}`);
    }
  };
  await visit(root);
  return files.sort();
};

const copyTree = async (source, destination) => {
  await fs.mkdir(destination, { recursive: true });
  for (const file of await sortedFiles(source)) {
    const target = path.join(destination, path.relative(source, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
  }
};

const treeDigest = async (root) => {
  const chunks = [];
  for (const file of await sortedFiles(root)) {
    chunks.push(Buffer.from(`${path.relative(root, file).split(path.sep).join("/")}\0`));
    chunks.push(await fs.readFile(file));
    chunks.push(Buffer.from("\0"));
  }
  return digest(Buffer.concat(chunks));
};

const sealReadOnly = async (target) => {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) await sealReadOnly(path.join(target, entry));
    await fs.chmod(target, 0o555);
  } else await fs.chmod(target, 0o444);
};

const loadWorkspace = async (workspaceInput) => {
  if (typeof workspaceInput !== "string" || !workspaceInput.trim()) throw new Error("Workspace path is required.");
  const workspace = path.resolve(workspaceInput);
  const config = JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill", "config.json"), "utf8"));
  if (config.schema !== CONFIG_SCHEMA || !SAFE_ID.test(config.workspaceId) || config.liveSkillsPath !== ".wikiskill/skills") throw new Error("Workspace has an invalid WikiSkill config.");
  return { workspace, config };
};

const inspectActiveSkills = async (skillsRoot, { empty = false } = {}) => {
  if (empty) return [];
  const inventory = [];
  for (const entry of (await fs.readdir(skillsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_ID.test(entry.name)) throw new Error(`Invalid live Skill entry: ${entry.name}`);
    const sourceFiles = await readSkillFiles(path.join(skillsRoot, entry.name));
    if (typeof sourceFiles["SKILL.md"] !== "string") throw new Error(`Live Skill is missing SKILL.md: ${entry.name}`);
    const files = materializeSkillFiles(sourceFiles, `.wikiskill/skills/${entry.name}`);
    inventory.push({ id: entry.name, bundleDigest: skillBundleDigest(files) });
  }
  return inventory;
};

async function inspectEvolutionBaseline(workspaceInput, targetSkill, { empty = false } = {}) {
  if (!SAFE_ID.test(targetSkill || "")) throw new Error("Evolution target must be a safe Skill id.");
  const { workspace, config } = await loadWorkspace(workspaceInput);
  const targetRoot = path.join(workspace, ".wikiskill", "skills", targetSkill);
  const targetExists = await exists(path.join(targetRoot, "SKILL.md"));
  if (empty && targetExists) throw new Error(`Empty evolution target already exists: ${targetSkill}`);
  if (!empty && !targetExists) throw new Error(`Live target Skill does not exist: ${targetSkill}`);
  const activeSkills = await inspectActiveSkills(path.join(workspace, ".wikiskill", "skills"), { empty });
  return {
    schema: "wikiskill.evolution-baseline.v1",
    workspaceId: config.workspaceId,
    targetSkill,
    targetSkillDigest: empty ? null : await treeDigest(targetRoot),
    activeSkills,
    activeSkillSetDigest: skillSetDigest(activeSkills),
    wikiDigest: await treeDigest(path.join(workspace, ".wikiskill", "wiki"))
  };
}

const initializeSourceRepo = async (workspace, sourceRoot, { empty = false } = {}) => {
  await fs.mkdir(sourceRoot, { recursive: true });
  const skillsRoot = path.join(sourceRoot, ".wikiskill", "skills");
  await fs.mkdir(skillsRoot, { recursive: true });
  if (!empty) await copyTree(path.join(workspace, ".wikiskill", "skills"), skillsRoot);
  await copyTree(path.join(workspace, ".wikiskill", "wiki"), path.join(sourceRoot, ".wikiskill", "wiki"));
  execFileSync("git", ["init", "-q", "-b", "main", sourceRoot]);
  execFileSync("git", ["-C", sourceRoot, "config", "user.email", "wikiskill@example.invalid"]);
  execFileSync("git", ["-C", sourceRoot, "config", "user.name", "WikiSkill"]);
  execFileSync("git", ["-C", sourceRoot, "add", "-f", ".wikiskill/skills"]);
  execFileSync("git", ["-C", sourceRoot, "commit", "--allow-empty", "-qm", "freeze live skills"]);
};

const persistEvolutionRaw = async (workspace, runRoot, runId) => {
  const rawAuthority = path.join(workspace, ".wikiskill", "raw", "evolutions");
  await fs.mkdir(rawAuthority, { recursive: true });
  const finalRoot = path.join(rawAuthority, runId);
  if (await exists(finalRoot)) throw new Error(`Evolution Raw already exists and is immutable: ${runId}`);
  const staging = path.join(rawAuthority, `.staging-${crypto.randomUUID()}`);
  await copyTree(path.join(runRoot, "raw"), path.join(staging, "raw"));
  await fs.writeFile(path.join(staging, "manifest.json"), json({ schema: "wikiskill.evolution-raw.v1", runId, rawDigest: await treeDigest(path.join(staging, "raw")) }), { flag: "wx" });
  await fs.rename(staging, finalRoot);
  await sealReadOnly(finalRoot);
  return `.wikiskill/raw/evolutions/${runId}`;
};

const syncPersistentWiki = async (workspace, runRoot, baselineDigest) => {
  const live = path.join(workspace, ".wikiskill", "wiki");
  const evolved = path.join(runRoot, "wiki");
  const evolvedDigest = await treeDigest(evolved);
  if (evolvedDigest === baselineDigest) return { changed: false, digest: evolvedDigest };
  if (await treeDigest(live) !== baselineDigest) throw new Error("Persistent Wiki changed during evolution; automatic merge is blocked.");
  const runtime = path.join(workspace, ".wikiskill", "runtime");
  const stage = path.join(runtime, `.wiki-stage-${crypto.randomUUID()}`);
  const backup = path.join(runtime, `.wiki-backup-${crypto.randomUUID()}`);
  await copyTree(evolved, stage);
  try {
    await fs.rename(live, backup);
    await fs.rename(stage, live);
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await exists(live)) && await exists(backup)) await fs.rename(backup, live);
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
  return { changed: true, digest: evolvedDigest };
};

const stageCandidate = async (workspace, runRoot, targetSkill, baselineDigest, state) => {
  if (!state.acceptedIterations?.length) return null;
  const source = path.join(runRoot, "result", "skills", targetSkill);
  const resultDigest = await treeDigest(source);
  const candidateId = `candidate-${digest(`${targetSkill}\0${baselineDigest}\0${resultDigest}`).slice("sha256:".length, "sha256:".length + 24)}`;
  const finalRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
  if (await exists(finalRoot)) return JSON.parse(await fs.readFile(path.join(finalRoot, "candidate.json"), "utf8"));
  const staging = path.join(workspace, ".wikiskill", "candidates", `.staging-${crypto.randomUUID()}`);
  await copyTree(source, path.join(staging, "skill"));
  const runManifest = JSON.parse(await fs.readFile(path.join(runRoot, "manifest.json"), "utf8"));
  const candidate = {
    schema: "wikiskill.candidate.v1",
    candidateId,
    targetSkill,
    status: "validation_accepted",
    baselineDigest,
    resultDigest,
    runId: path.basename(runRoot),
    baselineValidationScore: state.baselineValidationScore,
    candidateValidationScore: state.bestValidationScore,
    testScore: state.testScore,
    acceptedIterations: state.acceptedIterations,
    configDigest: runManifest.configDigest,
    frozenComponents: runManifest.frozenComponents,
    ...(runManifest.runtime ? { runtime: runManifest.runtime } : {})
  };
  await fs.writeFile(path.join(staging, "candidate.json"), json(candidate), { flag: "wx" });
  await fs.rename(staging, finalRoot);
  await sealReadOnly(finalRoot);
  return candidate;
};

const absoluteModule = (workspace, value) => typeof value === "string" ? path.resolve(workspace, value) : value;

const validateModulePath = async (workspace, value, label) => {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) throw new Error(`${label} must be a repository-relative module path.`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized !== value.replaceAll("\\", "/") || normalized.startsWith("../") || normalized === "..") throw new Error(`${label} is unsafe.`);
  const target = path.resolve(workspace, normalized);
  if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error(`${label} escapes the workspace.`);
  let current = workspace;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw new Error(`${label} must resolve through non-symlink workspace paths.`);
  }
  if (!(await fs.lstat(target)).isFile()) throw new Error(`${label} must resolve to a file.`);
  return normalized;
};

async function configureEvolution(workspaceInput, input, { dryRun = false } = {}) {
  const { workspace, config } = await loadWorkspace(workspaceInput);
  if (!input || input.schema !== "wikiskill.evolution-config.v1") throw new Error("Evolution config schema must be wikiskill.evolution-config.v1.");
  const evolution = {
    adapterModule: await validateModulePath(workspace, input.adapterModule, "adapterModule"),
    ...(input.adapterConfig === undefined ? {} : { adapterConfig: input.adapterConfig }),
    ...(input.runnerModule ? { runnerModule: await validateModulePath(workspace, input.runnerModule, "runnerModule") } : {}),
    ...(input.agentRunner ? { agentRunner: input.agentRunner } : {}),
    ...(input.runnerConfig === undefined ? {} : { runnerConfig: input.runnerConfig }),
    ...(input.maintainerModule ? { maintainerModule: await validateModulePath(workspace, input.maintainerModule, "maintainerModule") } : {}),
    ...(input.proposerModule ? { proposerModule: await validateModulePath(workspace, input.proposerModule, "proposerModule") } : {}),
    ...(input.learningAgent ? { learningAgent: input.learningAgent } : {}),
    model: input.model,
    iterationLimit: input.iterationLimit ?? 3
  };
  if (!evolution.runnerModule && !evolution.agentRunner) throw new Error("Evolution config requires runnerModule or agentRunner.");
  if ((!evolution.maintainerModule || !evolution.proposerModule) && !evolution.learningAgent) throw new Error("Evolution config requires Maintainer and Proposer modules or a learningAgent.");
  if (!evolution.model || typeof evolution.model.id !== "string" || !evolution.model.id.trim()) throw new Error("Evolution config requires a model id.");
  if (!Number.isSafeInteger(evolution.iterationLimit) || evolution.iterationLimit < 1) throw new Error("Evolution config iterationLimit must be a positive safe integer.");
  JSON.stringify(evolution);
  const previous = json(config);
  const next = json({ ...config, evolution });
  const result = { workspace, dryRun, previousDigest: digest(previous), nextDigest: digest(next), changed: previous !== next };
  if (!dryRun && result.changed) {
    const target = path.join(workspace, ".wikiskill", "config.json");
    const temporary = path.join(workspace, ".wikiskill", "runtime", `config-${crypto.randomUUID()}.json`);
    await fs.writeFile(temporary, next, { flag: "wx" });
    await fs.rename(temporary, target);
  }
  return result;
}

const componentDigest = async (direct, modulePath, config) => {
  const implementation = modulePath ? await fs.readFile(modulePath) : Buffer.from(String(direct));
  return digest(Buffer.concat([implementation, Buffer.from("\0"), Buffer.from(JSON.stringify(config ?? null))]));
};

const loadExplicitDataset = async (datasetPath, runtimeInput) => {
  const target = path.resolve(datasetPath);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("Explicit dataset must be a non-symlink file.");
  if (!new Set(["codex", "claude"]).has(runtimeInput.provider)) throw new Error("Explicit dataset Provider must be codex or claude.");
  if (typeof runtimeInput.modelId !== "string" || !runtimeInput.modelId.trim() || typeof runtimeInput.scorerRef !== "string" || !runtimeInput.scorerRef.trim()) {
    throw new Error("Explicit dataset requires model and scorer identities.");
  }
  if (runtimeInput.toolProfile !== "none" && runtimeInput.toolProfile !== "workspace") throw new Error("Explicit dataset tool profile must be none or workspace.");
  if (runtimeInput.scorerRef === "builtin:command-exit-v1" && runtimeInput.toolProfile !== "workspace") throw new Error("builtin:command-exit-v1 requires the workspace tool profile.");
  if (runtimeInput.scorerRef === "builtin:exact-output-v1" && runtimeInput.toolProfile !== "none") throw new Error("builtin:exact-output-v1 requires the none tool profile.");
  const core = require("./index");
  const dataset = core.validateDataset(JSON.parse(await fs.readFile(target, "utf8")));
  if (dataset.tasks.some((task) => task.evaluator.capabilityRef !== runtimeInput.scorerRef)) {
    throw new Error("Every explicit dataset task evaluator must match --scorer.");
  }
  return {
    dataset,
    selection: {
      datasetId: `dataset-${dataset.digest.slice("sha256:".length, "sha256:".length + 24)}`,
      datasetDigest: dataset.digest,
      cohort: { provider: runtimeInput.provider, modelId: runtimeInput.modelId, reasoningEffort: runtimeInput.reasoningEffort, scorerRef: runtimeInput.scorerRef, toolProfile: runtimeInput.toolProfile }
    }
  };
};

const initializeTaskRepository = async (workdir, sandbox) => {
  await prepareTaskDependencies(workdir, sandbox);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "wikiskill@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "WikiSkill"], { cwd: workdir });
  await fs.writeFile(path.join(workdir, ".git", "info", "exclude"), "node_modules/\n");
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "初始化练习仓库"], { cwd: workdir });
  return workdir;
};

async function evolveWorkspace(workspaceInput, targetSkill, options = {}) {
  const { workspace, config } = await loadWorkspace(workspaceInput);
  const observedBaseline = await inspectEvolutionBaseline(workspace, targetSkill, { empty: options.empty === true });
  const targetRoot = path.join(workspace, ".wikiskill", "skills", targetSkill);
  const runId = options.runId || `evolve-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  if (!SAFE_ID.test(runId)) throw new Error("Evolution run id must be a safe identifier.");
  if (options.expectedWorkspaceId !== undefined && observedBaseline.workspaceId !== options.expectedWorkspaceId) {
    throw new Error("WikiSkill workspace identity differs from the prepared baseline; evolution launch is blocked.");
  }
  if (!options.datasetPath) throw new Error("Evolution requires --dataset.");
  const reasoningEffort = typeof options.reasoningEffort === "string" && options.reasoningEffort.trim() ? options.reasoningEffort.trim() : "unspecified";
  if (!/^[A-Za-z0-9._-]+$/u.test(reasoningEffort)) throw new Error("Evolution reasoning effort must be a safe identifier.");
  const maxProviderLaunches = options.maxProviderLaunches === undefined ? 10_000 : Number(options.maxProviderLaunches);
  if (!Number.isSafeInteger(maxProviderLaunches) || maxProviderLaunches < 1 || maxProviderLaunches > 10_000) throw new Error("Evolution max Provider launches must be between 1 and 10000.");
  const stateRoot = path.resolve(options.stateRoot || process.env.WIKISKILL_HOME || path.join(os.homedir(), ".wikiskill"));
  const launchBudget = createProviderLaunchBudget({
    root: path.join(stateRoot, "workspaces", config.workspaceId, "evolutions", runId, "accounting"),
    runId,
    provider: options.provider,
    modelId: options.modelId,
    reasoningEffort,
    limit: maxProviderLaunches
  });
  const toolProfile = options.toolProfile ?? (options.scorerRef === "builtin:command-exit-v1" ? "workspace" : "none");
  const explicit = await loadExplicitDataset(options.datasetPath, { provider: options.provider, modelId: options.modelId, reasoningEffort, scorerRef: options.scorerRef, toolProfile });
  const selection = explicit.selection;
  if (options.expectedDatasetDigest !== undefined) {
    if (typeof options.expectedDatasetDigest !== "string" || !/^[0-9a-f]{64}$/u.test(options.expectedDatasetDigest)) {
      throw new Error("Expected dataset digest must be a lowercase SHA-256 hex digest.");
    }
    if (selection.datasetDigest !== options.expectedDatasetDigest) {
      throw new Error("Dataset digest differs from the prepared input; evolution launch is blocked.");
    }
  }
  if (options.expectedTargetSkillDigest !== undefined) {
    if (typeof options.expectedTargetSkillDigest !== "string" || !SHA256.test(options.expectedTargetSkillDigest)) {
      throw new Error("Expected target Skill digest must be a sha256 digest.");
    }
    if (observedBaseline.targetSkillDigest !== options.expectedTargetSkillDigest) {
      throw new Error("Target Skill digest differs from the prepared baseline; evolution launch is blocked.");
    }
  }
  if (options.expectedActiveSkillSetDigest !== undefined) {
    if (typeof options.expectedActiveSkillSetDigest !== "string" || !SHA256.test(options.expectedActiveSkillSetDigest)) {
      throw new Error("Expected active Skill-set digest must be a sha256 digest.");
    }
    if (observedBaseline.activeSkillSetDigest !== options.expectedActiveSkillSetDigest) {
      throw new Error("Active Skill set differs from the prepared baseline; evolution launch is blocked.");
    }
  }
  if (options.expectedWikiDigest !== undefined) {
    if (typeof options.expectedWikiDigest !== "string" || !SHA256.test(options.expectedWikiDigest)) {
      throw new Error("Expected Wiki digest must be a sha256 digest.");
    }
    if (observedBaseline.wikiDigest !== options.expectedWikiDigest) {
      throw new Error("Wiki digest differs from the prepared baseline; evolution launch is blocked.");
    }
  }
  options.onEvent?.({
    schema: "wikiskill.event.v1",
    type: "evolution.dataset-selected",
    runId,
    targetSkill,
    selection: "dataset-file",
    datasetId: selection.datasetId,
    datasetDigest: selection.datasetDigest,
    cohort: selection.cohort
  });
  const tasks = explicit.dataset.tasks;
  const evolution = config.evolution || {};
  const adapterModule = evolution.adapterModule ? absoluteModule(workspace, await validateModulePath(workspace, evolution.adapterModule, "adapterModule")) : undefined;
  const runnerModule = evolution.runnerModule ? absoluteModule(workspace, await validateModulePath(workspace, evolution.runnerModule, "runnerModule")) : undefined;
  const maintainerModule = evolution.maintainerModule ? absoluteModule(workspace, await validateModulePath(workspace, evolution.maintainerModule, "maintainerModule")) : undefined;
  const proposerModule = evolution.proposerModule ? absoluteModule(workspace, await validateModulePath(workspace, evolution.proposerModule, "proposerModule")) : undefined;
  const learningAgent = options.learningAgent || evolution.learningAgent;
  const registry = options.capabilityRegistry || createBuiltinCapabilityRegistry();
  let runtime;
  let runtimeRunner;
  let runtimeRunnerFrozenConfig;
  let runtimeAdapter;
  let runtimeLearning;
  let runtimeLearningConfig;
  let runtimeLearningFrozenConfig;
  if (!options.adapter && !adapterModule && !options.runner && !runnerModule && !evolution.agentRunner) {
    const runnerRef = runnerRefForProvider(selection.cohort.provider);
    runtimeRunnerFrozenConfig = {
      ...(evolution.runtime?.runnerConfig || {}),
      ...(options.runnerTimeoutMs === undefined ? {} : { timeoutMs: Number(options.runnerTimeoutMs) }),
      reasoningEffort
    };
    const resolvedRunner = registry.resolveRunner(runnerRef, {
      ...runtimeRunnerFrozenConfig,
      providerLaunchBudget: launchBudget
    });
    const resolvedScorer = registry.resolveScorer(selection.cohort.scorerRef, evolution.runtime?.scorerConfig || {});
    runtime = { runnerRef, scorerRef: selection.cohort.scorerRef, provider: selection.cohort.provider, modelId: selection.cohort.modelId, reasoningEffort, toolProfile, launchBudget: { unit: "provider_launches", limit: maxProviderLaunches }, runner: resolvedRunner.descriptor, scorer: resolvedScorer.descriptor };
    runtimeRunner = resolvedRunner.run;
    runtimeAdapter = {
      prepareEnvironment: async ({ workdir, task }) => runtime.scorerRef === "builtin:command-exit-v1" ? initializeTaskRepository(workdir, task.repositorySnapshot ? await require("./repository-snapshot").snapshotDependencyFiles(task.repositorySnapshot) : task.sandbox) : workdir,
      resolveTools: () => runtime.toolProfile === "workspace" ? ["workspace"] : [],
      disposeEnvironment: ({ workdir }) => runtime.scorerRef === "builtin:command-exit-v1" ? fs.rm(workdir, { recursive: true, force: true }) : undefined,
      score: ({ task, prediction, groundTruth, environment, workdir, split, iteration }) => {
        if (task.evaluator.capabilityRef !== runtime.scorerRef) throw new Error(`Task scorer ref differs from the frozen runtime cohort: ${task.id}`);
        return resolvedScorer.score({ taskId: task.id, prediction, privateInput: groundTruth, environment, workdir, split, iteration });
      }
    };
  }
  if ((!options.maintainer && !maintainerModule && !learningAgent) || (!options.proposer && !proposerModule && !learningAgent)) {
    const learningAgentRef = runtime?.provider ? learningRefForProvider(runtime.provider) : "builtin:codex-cli-v1";
    runtimeLearningFrozenConfig = {
      ...(evolution.runtime?.learningAgentConfig || {}),
      ...(runtime?.modelId ? { model: runtime.modelId } : {}),
      reasoningEffort
    };
    runtimeLearningConfig = {
      ...runtimeLearningFrozenConfig,
      providerLaunchBudget: launchBudget
    };
    const resolvedLearning = registry.resolveLearningAgent(learningAgentRef, runtimeLearningConfig);
    runtimeLearning = resolvedLearning;
    runtime = {
      ...(runtime || {}),
      learningAgentRef,
      learningAgent: resolvedLearning.descriptor
    };
  }
  const model = options.model || evolution.model || (runtime ? { id: runtime.modelId, reasoningEffort } : undefined);
  if (!options.adapter && !adapterModule && !runtimeAdapter) throw new Error("Evolution requires a configured adapter or resolvable runtime scorer capability.");
  if (!options.runner && !runnerModule && !evolution.agentRunner && !runtimeRunner) throw new Error("Evolution requires a configured Agent runner or resolvable runtime runner capability.");
  if (!options.maintainer && !maintainerModule && !learningAgent && !runtimeLearning) throw new Error("Evolution requires a configured Wiki Maintainer.");
  if (!options.proposer && !proposerModule && !learningAgent && !runtimeLearning) throw new Error("Evolution requires a configured Skill Proposer.");
  if (!model || typeof model.id !== "string" || !model.id.trim()) throw new Error("Evolution requires a frozen model identity.");
  if (runtime) {
    const capabilities = [
      ...(runtime.runner ? [{ kind: "runner", ...runtime.runner }] : []),
      ...(runtime.scorer ? [{ kind: "scorer", ...runtime.scorer }] : []),
      ...(runtime.learningAgent ? [{ kind: "learning-agent", ...runtime.learningAgent }] : [])
    ];
    options.onEvent?.({
      schema: "wikiskill.event.v1",
      type: "evolution.runtime-selected",
      runId,
      selection: {
        provider: runtime.provider,
        modelId: runtime.modelId,
        reasoningEffort: runtime.reasoningEffort,
        toolProfile: runtime.toolProfile,
        launchBudget: runtime.launchBudget,
        runnerRef: runtime.runnerRef,
        scorerRef: runtime.scorerRef,
        ...(runtime.learningAgentRef ? { learningAgentRef: runtime.learningAgentRef } : {})
      },
      capabilities
    });
  }
  const iterationLimit = Number(options.iterationLimit ?? evolution.iterationLimit ?? 3);
  if (!Number.isSafeInteger(iterationLimit) || iterationLimit < 1) throw new Error("Evolution iteration limit must be a positive safe integer.");
  const frozenComponents = {
    adapter: runtime ? digest(JSON.stringify({ descriptor: runtime.scorer, config: evolution.runtime?.scorerConfig || {} })) : await componentDigest(options.adapter, adapterModule, evolution.adapterConfig),
    runner: runtime ? digest(JSON.stringify({ descriptor: runtime.runner, config: runtimeRunnerFrozenConfig || {} })) : await componentDigest(options.runner || evolution.agentRunner, runnerModule, evolution.runnerConfig),
    maintainer: runtimeLearning ? digest(JSON.stringify({ descriptor: runtimeLearning.descriptor, config: runtimeLearningFrozenConfig })) : await componentDigest(options.maintainer || learningAgent, maintainerModule, learningAgent),
    proposer: runtimeLearning ? digest(JSON.stringify({ descriptor: runtimeLearning.descriptor, config: runtimeLearningFrozenConfig })) : await componentDigest(options.proposer || learningAgent, proposerModule, learningAgent),
    model: digest(JSON.stringify(model))
  };
  // 当前实验设置：小型代码任务重复采样以提供四条真实训练轨迹；不是论文规定的通用采样次数。
  const rolloutPolicy = runtime?.scorerRef === "builtin:command-exit-v1"
    ? { trainingRolloutsPerTask: Math.max(1, Math.ceil(4 / tasks.filter(task => task.split === "train").length)), evaluationRolloutsPerTask: 1 }
    : runtimeRunner && runtimeAdapter
      ? { trainingRolloutsPerTask: 2, evaluationRolloutsPerTask: 3 }
    : { trainingRolloutsPerTask: 1, evaluationRolloutsPerTask: 1 };
  const splitCount = (split) => tasks.filter((task) => task.split === split).length;
  const estimatedProviderLaunches = splitCount("val") * rolloutPolicy.evaluationRolloutsPerTask
    + iterationLimit * (splitCount("train") * rolloutPolicy.trainingRolloutsPerTask + 3 + splitCount("val") * rolloutPolicy.evaluationRolloutsPerTask)
    + splitCount("test") * rolloutPolicy.evaluationRolloutsPerTask * 2;
  options.onEvent?.({ schema: "wikiskill.event.v1", type: "evolution.launch-budget-selected", runId, budget: launchBudget.snapshot(), estimatedProviderLaunches });
  if (Object.values(frozenComponents).some((value) => !SHA256.test(value))) throw new Error("Evolution component digest could not be frozen.");
  const sourceRoot = path.join(stateRoot, "workspaces", config.workspaceId, "evolutions", runId, "source");
  await initializeSourceRepo(workspace, sourceRoot, { empty: options.empty === true });
  const baselineSkillDigest = options.empty ? null : await treeDigest(path.join(sourceRoot, ".wikiskill", "skills", targetSkill));
  const activeSkills = await inspectActiveSkills(path.join(sourceRoot, ".wikiskill", "skills"), { empty: options.empty === true });
  const activeSkillSetDigest = skillSetDigest(activeSkills);
  const baselineWikiDigest = await treeDigest(path.join(sourceRoot, ".wikiskill", "wiki"));
  try {
    if (options.expectedTargetSkillDigest !== undefined && baselineSkillDigest !== options.expectedTargetSkillDigest) {
      throw new Error("Frozen target Skill digest differs from the prepared baseline; evolution launch is blocked.");
    }
    if (options.expectedActiveSkillSetDigest !== undefined && activeSkillSetDigest !== options.expectedActiveSkillSetDigest) {
      throw new Error("Frozen active Skill set differs from the prepared baseline; evolution launch is blocked.");
    }
    if (options.expectedWikiDigest !== undefined && baselineWikiDigest !== options.expectedWikiDigest) {
      throw new Error("Frozen Wiki digest differs from the prepared baseline; evolution launch is blocked.");
    }
  } catch (error) {
    await fs.rm(path.dirname(sourceRoot), { recursive: true, force: true });
    throw error;
  }
  const allSkillDirectories = (await fs.readdir(path.join(sourceRoot, ".wikiskill", "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const runConfig = {
    repo: sourceRoot,
    skillRoots: [".wikiskill/skills"],
    targetSkills: options.empty ? [] : [targetSkill],
    contextSkills: options.empty ? [] : allSkillDirectories.filter((id) => id !== targetSkill),
    expectedActiveSkillSetDigest: activeSkillSetDigest,
    ...(options.empty ? { mode: "empty", newSkillRoot: ".wikiskill/skills", newSkillIds: [targetSkill] } : {}),
    dataset: { ...explicit.dataset, adapter: { source: "explicit-file", digest: explicit.dataset.digest } },
    stateRoot: path.join(stateRoot, "engine"),
    runId,
    iterationLimit,
    ...rolloutPolicy,
    adapterModule,
    adapterConfig: evolution.adapterConfig,
    runnerModule,
    runnerConfig: evolution.runnerConfig,
    agentRunner: evolution.agentRunner,
    maintainerModule,
    proposerModule,
    learningAgent,
    model,
    ...(runtime ? { runtime } : {}),
    frozenComponents,
    configDigest: digest(json({ datasetDigest: selection.datasetDigest, targetSkill, baselineSkillDigest, activeSkillSetDigest, baselineWikiDigest, frozenComponents, rolloutPolicy, reasoningEffort, toolProfile, launchBudget: { unit: "provider_launches", limit: maxProviderLaunches } })),
    rawReferencePrefix: `.wikiskill/raw/evolutions/${runId}`
  };
  const core = require("./index");
  const manifest = await core.createRun(runConfig);
  await fs.rm(path.join(manifest.runRoot, "wiki"), { recursive: true, force: true });
  await copyTree(path.join(sourceRoot, ".wikiskill", "wiki"), path.join(manifest.runRoot, "wiki"));
  await fs.mkdir(path.join(manifest.runRoot, "wiki", "patterns"), { recursive: true });
  options.onEvent?.({ schema: "wikiskill.event.v1", type: "evolution.created", runId, datasetId: selection.datasetId });
  let completed;
  let runError;
  try {
    completed = await core.runEvolution(manifest.runRoot, {
      ...options,
      ...(runtimeRunner ? { runner: runtimeRunner } : {}),
      ...(runtimeAdapter ? { adapter: runtimeAdapter } : {}),
      ...(runtimeLearning && !options.maintainer ? { maintainer: runtimeLearning.maintainer } : {}),
      ...(runtimeLearning && !options.proposer ? { proposer: runtimeLearning.proposer } : {}),
      providerLaunchBudget: launchBudget
    });
  } catch (error) {
    runError = error;
  }
  const rawRef = await persistEvolutionRaw(workspace, manifest.runRoot, runId);
  const wiki = await syncPersistentWiki(workspace, manifest.runRoot, baselineWikiDigest);
  if (runError) throw runError;
  const candidate = await stageCandidate(workspace, manifest.runRoot, targetSkill, baselineSkillDigest, completed.state);
  options.onEvent?.({ schema: "wikiskill.event.v1", type: "evolution.completed", runId, candidateId: candidate?.candidateId ?? null });
  return { runId, runRoot: manifest.runRoot, datasetId: selection.datasetId, rawRef, wiki, candidate, state: completed.state, launchBudget: launchBudget.snapshot(), runtimeEvidenceDigest: completed.runtimeEvidenceDigest };
}

async function statusWorkspaceEvolution(workspaceInput, runId, options = {}) {
  if (!SAFE_ID.test(runId || "")) throw new Error("Evolution run id must be a safe identifier.");
  const { config } = await loadWorkspace(workspaceInput);
  const root = await fs.realpath(path.resolve(options.stateRoot || process.env.WIKISKILL_HOME || path.join(os.homedir(), ".wikiskill")));
  const core = require("./index");
  const status = await core.statusRun(runId, path.join(root, "engine"));
  const expectedSource = path.join(root, "workspaces", config.workspaceId, "evolutions", runId, "source");
  if (path.resolve(status.manifest.repo) !== expectedSource) throw new Error("Evolution run does not belong to this workspace identity.");
  const resultPath = path.join(status.runRoot, "result", "result.json");
  const result = await fs.readFile(resultPath, "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let runtimeEvidence;
  if (result) {
    const hasRuntimeRef = typeof result.runtimeEvidence === "string";
    const hasRuntimeDigest = typeof result.runtimeEvidenceDigest === "string";
    if (hasRuntimeRef !== hasRuntimeDigest) throw new Error("WikiSkill result has an incomplete runtime evidence reference.");
    if (hasRuntimeRef) {
      if (result.runtimeEvidence !== "runtime-evidence.json" || !SHA256.test(result.runtimeEvidenceDigest)) throw new Error("WikiSkill result runtime evidence reference is invalid.");
      const runtimeText = await fs.readFile(path.join(status.runRoot, "result", result.runtimeEvidence), "utf8");
      if (digest(runtimeText) !== result.runtimeEvidenceDigest) throw new Error("WikiSkill runtime evidence digest mismatch.");
      runtimeEvidence = JSON.parse(runtimeText);
      if (runtimeEvidence?.schema !== "wikiskill.runtime-evidence.v2" || runtimeEvidence.runId !== runId) throw new Error("WikiSkill runtime evidence identity is invalid.");
    }
  }
  const runtime = status.manifest.runtime;
  const launchBudget = runtime?.launchBudget ? createProviderLaunchBudget({ root: path.join(root, "workspaces", config.workspaceId, "evolutions", runId, "accounting"), runId, provider: runtime.provider, modelId: runtime.modelId, reasoningEffort: runtime.reasoningEffort, limit: runtime.launchBudget.limit }).snapshot() : undefined;
  return { runId, ...(launchBudget ? { launchBudget } : {}), manifest: status.manifest, state: status.state, ...(result ? { result } : {}), ...(runtimeEvidence ? { runtimeEvidence } : {}) };
}

module.exports = { configureEvolution, evolveWorkspace, inspectEvolutionBaseline, statusWorkspaceEvolution };
