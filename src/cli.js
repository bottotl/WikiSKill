"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const core = require("./index");
const { proposeCandidate, reviewCandidate, listCandidates } = require("./publishing");

const HELP = `wikiskill init <workspace> [--mode direct|zero-source-write] [--dry-run] --json
wikiskill doctor --workspace <workspace> --json
wikiskill uninstall --workspace <workspace> [--dry-run] --json
wikiskill context prepare --workspace <workspace> --json
wikiskill context skill-get --workspace <workspace> --context <id> --skill <id> --json
wikiskill context receipt --workspace <workspace> --context <id> --skill <id> --json
wikiskill context receipts --workspace <workspace> --context <id> --json
wikiskill evolution baseline --workspace <workspace> --target <skill-id> [--empty] --json
wikiskill experiment prepare --workspace <workspace> --target <skill-id> --dataset <dataset.json> --scorer <ref> [--empty] --json
wikiskill experiment audit --dataset <dataset.json> --target <skill-id> [--skill-context <context.json>] [--baseline <baseline.json>] [--mode publishable|smoke] [--empty] --json
wikiskill experiment audit --experiment <experiment.json> --json
wikiskill experiment run --workspace <workspace> --target <skill-id> --dataset <dataset.json> --scorer <ref> [--runtime-profile <profile.json> | --provider codex|claude --model <id> --reasoning-effort <level> --tool-profile none|workspace --iterations <K> --max-provider-launches <count>] [--empty] [--run-id <id>] --json-events
wikiskill run audit --run-root <run-root> --workspace <workspace> --json
wikiskill bootstrap install|uninstall --workspace <repo> --command <context-command> [--dry-run] --json
wikiskill dataset validate --dataset <dataset.json> --scorer <ref> --json
wikiskill dataset compile-commit --input <source.json> --provider codex|claude --model <id> --reasoning-effort <level> --json
wikiskill dataset verify-known-fix --dataset <dataset.json> --scorer <ref> --patch <changes.patch> --json
wikiskill evolve --experiment <experiment.json> [--runtime-profile <profile.json> | --provider codex|claude --model <id> --reasoning-effort <level> --tool-profile none|workspace --iterations <K> --max-provider-launches <count>] [--runner-timeout-ms <ms>] [--run-id <id>] --json-events
wikiskill status --workspace <workspace> --run <id> [--state-root <dir>] --json
wikiskill configure --workspace <workspace> --input <evolution-config.json> [--dry-run] --json
wikiskill candidate diff --workspace <workspace> --candidate <id> --json
wikiskill candidate list --workspace <workspace> [--limit <n>] [--cursor <id>] --json
wikiskill candidate propose --workspace <workspace> --input <proposal.json> --json
wikiskill candidate review --workspace <workspace> --candidate <id> --input <review.json> --json
wikiskill candidate apply --workspace <workspace> --candidate <id> [--dry-run] --json
wikiskill rollback --workspace <workspace> --receipt <id> --json
`;

const SUBCOMMANDS = Object.freeze({
  candidate: new Set(["diff", "apply", "propose", "review", "list"]),
  context: new Set(["prepare", "skill-get", "receipt", "receipts"]),
  evolution: new Set(["baseline"]),
  experiment: new Set(["prepare", "audit", "run"]),
  run: new Set(["audit"]),
  bootstrap: new Set(["install", "uninstall"]),
  dataset: new Set(["validate", "verify-known-fix", "compile-commit", "recommend-commit"]),
});

const VALUE_FLAGS = Object.freeze({
  "--limit": "limit",
  "--cursor": "cursor",
  "--run-id": "runId",
  "--run": "run",
  "--workspace": "workspace",
  "--expected-workspace-id": "expectedWorkspaceId",
  "--mode": "mode",
  "--input": "input",
  "--dataset": "datasetPath",
  "--experiment": "experimentPath",
  "--runtime-profile": "runtimeProfilePath",
  "--skill-context": "skillContextPath",
  "--baseline": "baselinePath",
  "--run-root": "runRoot",
  "--expected-dataset-digest": "expectedDatasetDigest",
  "--expected-target-skill-digest": "expectedTargetSkillDigest",
  "--expected-active-skill-set-digest": "expectedActiveSkillSetDigest",
  "--expected-wiki-digest": "expectedWikiDigest",
  "--target": "target",
  "--candidate": "candidate",
  "--provider": "provider",
  "--model": "modelId",
  "--reasoning-effort": "reasoningEffort",
  "--scorer": "scorerRef",
  "--patch": "patchPath",
  "--tool-profile": "toolProfile",
  "--iterations": "iterationLimit",
  "--max-provider-launches": "maxProviderLaunches",
  "--runner-timeout-ms": "runnerTimeoutMs",
  "--receipt": "receipt",
  "--state-root": "stateRoot",
  "--context": "contextId",
  "--skill": "skillId",
  "--command": "bootstrapCommand"
});

const parse = (argv) => {
  const options = { json: false, jsonEvents: false, command: argv[0] };
  const subcommands = SUBCOMMANDS[options.command];
  if (subcommands?.has(argv[1])) options.subcommand = argv[1];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (index === 1 && flag === options.subcommand) continue;
    if (options.command === "init" && index === 1 && !flag.startsWith("--")) {
      options.workspace = flag;
      continue;
    }
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag === "--json-events") {
      options.jsonEvents = true;
      continue;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--empty") {
      options.empty = true;
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    options[key] = value;
  }
  return options;
};

const output = (value, code, io) => {
  io.stdout(`${JSON.stringify(value)}\n`);
  return code;
};

const runEvolutionCommand = async (options, io, abortSignal, onRunId) => {
  const runOptions = {
    ...options,
    abortSignal,
    onEvent: (event) => {
      if (typeof event.runId === "string") onRunId(event.runId);
      io.stdout(`${JSON.stringify(event)}\n`);
    }
  };
  return core.evolveWorkspace(options.workspace, options.target, runOptions);
};

const validateDatasetFile = async (datasetPathInput, scorerRef) => {
  const datasetPath = path.resolve(datasetPathInput);
  const dataset = core.validateDataset(JSON.parse(await fs.readFile(datasetPath, "utf8")));
  if (dataset.tasks.some((task) => task.evaluator.capabilityRef !== scorerRef)) throw new Error("Every dataset task evaluator must match --scorer.");
  const { validateBuiltinScorerInput } = require("./runtime-capabilities");
  for (const task of dataset.tasks) validateBuiltinScorerInput(scorerRef, task.groundTruth);
  return { datasetPath, dataset };
};

const readExperiment = async (input) => {
  const experimentPath = path.resolve(input);
  const parsed = JSON.parse(await fs.readFile(experimentPath, "utf8"));
  const experiment = parsed?.success === true && parsed.data ? parsed.data : parsed;
  if (experiment?.schema !== "wikiskill.experiment.v1") throw new Error("Experiment artifact schema must be wikiskill.experiment.v1.");
  return { experimentPath, experiment };
};

const applyRuntimeProfile = async (options) => {
  if (!options.runtimeProfilePath) return options;
  if (options.command !== "evolve" && !(options.command === "experiment" && options.subcommand === "run")) throw new Error("--runtime-profile is supported only by evolve and experiment run.");
  const explicit = ["provider", "modelId", "reasoningEffort", "toolProfile", "iterationLimit", "maxProviderLaunches", "runnerTimeoutMs"].filter((key) => options[key] !== undefined);
  if (explicit.length) throw new Error("--runtime-profile cannot be combined with explicit runtime flags.");
  const profile = JSON.parse(await fs.readFile(path.resolve(options.runtimeProfilePath), "utf8"));
  const allowed = new Set(["schema", "provider", "model", "reasoningEffort", "toolProfile", "iterations", "maxProviderLaunches", "runnerTimeoutMs"]);
  if (profile?.schema !== "wikiskill.runtime-profile.v1" || Object.keys(profile).some((key) => !allowed.has(key))) throw new Error("Runtime profile must use wikiskill.runtime-profile.v1 with only supported fields.");
  for (const key of ["provider", "model", "reasoningEffort", "toolProfile", "iterations", "maxProviderLaunches"]) if (profile[key] === undefined) throw new Error(`Runtime profile requires ${key}.`);
  return Object.assign(options, {
    provider: profile.provider,
    modelId: profile.model,
    reasoningEffort: profile.reasoningEffort,
    toolProfile: profile.toolProfile,
    iterationLimit: String(profile.iterations),
    maxProviderLaunches: String(profile.maxProviderLaunches),
    ...(profile.runnerTimeoutMs === undefined ? {} : { runnerTimeoutMs: String(profile.runnerTimeoutMs) })
  });
};

const applyExperiment = (options, experiment) => Object.assign(options, {
  workspace: experiment.workspace,
  target: experiment.targetSkill,
  datasetPath: experiment.datasetPath,
  scorerRef: experiment.scorerRef,
  empty: experiment.empty === true,
  expectedWorkspaceId: experiment.baseline?.workspaceId,
  expectedDatasetDigest: experiment.datasetDigest,
  expectedTargetSkillDigest: experiment.baseline?.targetSkillDigest ?? undefined,
  expectedActiveSkillSetDigest: experiment.baseline?.activeSkillSetDigest,
  expectedWikiDigest: experiment.baseline?.wikiDigest
});

const validateEvolutionLaunch = (options) => {
  const runtime = [options.provider, options.modelId, options.reasoningEffort, options.scorerRef, options.toolProfile, options.iterationLimit, options.maxProviderLaunches];
  if (runtime.some((value) => value === undefined)) throw new Error("Evolution requires --provider, --model, --reasoning-effort, --scorer, --tool-profile, --iterations, and --max-provider-launches.");
  if (options.toolProfile !== "none" && options.toolProfile !== "workspace") throw new Error("Evolution --tool-profile must be none or workspace.");
  if (!/^\d+$/u.test(options.iterationLimit) || !Number.isSafeInteger(Number(options.iterationLimit)) || Number(options.iterationLimit) < 1) throw new Error("Evolution --iterations must be a positive safe integer.");
  if (!/^\d+$/u.test(options.maxProviderLaunches) || Number(options.maxProviderLaunches) < 1 || Number(options.maxProviderLaunches) > 10_000) throw new Error("Evolution --max-provider-launches must be between 1 and 10000.");
  if (options.runnerTimeoutMs !== undefined && (!/^\d+$/u.test(options.runnerTimeoutMs) || Number(options.runnerTimeoutMs) < 1_000 || Number(options.runnerTimeoutMs) > 3_600_000)) throw new Error("Evolution --runner-timeout-ms must be between 1000 and 3600000.");
  if (!options.expectedWorkspaceId) throw new Error("evolve --dataset requires --expected-workspace-id from evolution baseline.");
  if (!options.expectedDatasetDigest) throw new Error("evolve --dataset requires --expected-dataset-digest from dataset validate.");
  if (!options.empty && !options.expectedTargetSkillDigest) throw new Error("evolve --dataset requires --expected-target-skill-digest from evolution baseline.");
  if (!options.expectedActiveSkillSetDigest) throw new Error("evolve --dataset requires --expected-active-skill-set-digest from evolution baseline.");
  if (!options.expectedWikiDigest) throw new Error("evolve --dataset requires --expected-wiki-digest from evolution baseline.");
};

const prepareExperiment = async (options) => {
  if (!options.workspace || !options.datasetPath || !options.target || !options.scorerRef) throw new Error("experiment prepare requires --workspace, --dataset, --target, and --scorer.");
  const { datasetPath, dataset } = await validateDatasetFile(options.datasetPath, options.scorerRef);
  const skillContext = await core.prepareContext(options.workspace);
  const baseline = await core.inspectEvolutionBaseline(options.workspace, options.target, { empty: options.empty === true });
  const result = require("./audit/experiment").auditExperiment({ tasks: dataset.tasks, targetSkill: options.target, skillContext, baseline, mode: "publishable", empty: options.empty === true });
  const experiment = { schema: "wikiskill.experiment.v1", workspace: path.resolve(options.workspace), datasetPath, datasetDigest: dataset.digest, scorerRef: options.scorerRef, targetSkill: options.target, empty: options.empty === true, skillContext, baseline, preparedAt: new Date().toISOString() };
  return { experiment, result };
};

async function execute(argv, io = { stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) }) {
  let emittedRunId;
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      io.stdout(HELP);
      return argv.length ? 0 : 1;
    }
    const options = parse(argv);
    await applyRuntimeProfile(options);
    if (options.command === "evolve" && options.experimentPath) {
      const conflicts = ["workspace", "target", "datasetPath", "scorerRef", "expectedWorkspaceId", "expectedDatasetDigest", "expectedTargetSkillDigest", "expectedActiveSkillSetDigest", "expectedWikiDigest"].filter((key) => options[key] !== undefined);
      if (conflicts.length) throw new Error("evolve --experiment cannot be combined with explicit experiment authority flags.");
      const { experiment } = await readExperiment(options.experimentPath);
      applyExperiment(options, experiment);
    }
    if (!options.json && !options.jsonEvents) throw new Error("Commands require --json (or --json-events for evolve).");
    let data;
    if (options.command === "init") data = await core.initWorkspace(options.workspace, options);
    else if (options.command === "doctor") {
      data = await core.doctorWorkspace(options.workspace);
      if (data.blockers.length) {
        return output(core.ENVELOPE(data, [], data.blockers, ["Run wikiskill init <workspace> --dry-run --json, review the diff, then apply init."]), 1, io);
      }
    } else if (options.command === "uninstall") data = await core.uninstallWorkspace(options.workspace, options);
    else if (options.command === "evolve") {
      if (!options.jsonEvents) throw new Error("evolve requires --json-events.");
      if (options.datasetPath) {
        validateEvolutionLaunch(options);
      }
      data = await withAbort((signal) => runEvolutionCommand(options, io, signal, (id) => { emittedRunId = id; }));
      io.stdout(`${JSON.stringify({ schema: "wikiskill.event.v1", type: "evolution.result", runId: data.runId, data })}\n`);
      return 0;
    } else if (options.command === "configure") {
      data = await core.configureEvolution(options.workspace, JSON.parse(await fs.readFile(path.resolve(options.input), "utf8")), options);
    } else if (options.command === "context") {
      if (options.subcommand === "prepare") data = await core.prepareContext(options.workspace);
      else if (options.subcommand === "skill-get") data = await core.getContextSkill(options.workspace, options.contextId, options.skillId);
      else if (options.subcommand === "receipt") data = await core.recordContextSkillUse(options.workspace, options.contextId, options.skillId);
      else if (options.subcommand === "receipts") data = await core.listContextSkillReceipts(options.workspace, options.contextId);
      else throw new Error("Only `context prepare`, `context skill-get`, `context receipt`, and `context receipts` are supported.");
    } else if (options.command === "evolution") {
      if (options.subcommand !== "baseline") throw new Error("Only `evolution baseline` is supported.");
      data = await core.inspectEvolutionBaseline(options.workspace, options.target, { empty: options.empty === true });
    } else if (options.command === "experiment") {
      const auditExperiment = require("./audit/experiment").auditExperiment;
      if (options.subcommand === "prepare") {
        const prepared = await prepareExperiment(options);
        return output(core.ENVELOPE(prepared.experiment, prepared.result.warnings, prepared.result.blockers, prepared.result.blockers.length ? ["Resolve the experiment preparation blockers and prepare a new artifact."] : []), prepared.result.blockers.length ? 1 : 0, io);
      }
      if (options.subcommand === "run") {
        if (!options.jsonEvents) throw new Error("experiment run requires --json-events.");
        const prepared = await prepareExperiment(options);
        if (prepared.result.blockers.length) return output({ schema: "wikiskill.event.v1", type: "experiment.failed", blockers: prepared.result.blockers }, 1, io);
        io.stdout(`${JSON.stringify({ schema: "wikiskill.event.v1", type: "experiment.prepared", data: prepared.experiment, warnings: prepared.result.warnings })}\n`);
        const runOptions = applyExperiment({ ...options }, prepared.experiment);
        validateEvolutionLaunch(runOptions);
        const evolved = await withAbort((signal) => runEvolutionCommand(runOptions, io, signal, (id) => { emittedRunId = id; }));
        const audit = require("./audit/run").auditRun(evolved.runRoot, { workspace: prepared.experiment.workspace });
        if (audit.blockers.length) return output({ schema: "wikiskill.event.v1", type: "experiment.failed", runId: evolved.runId, blockers: audit.blockers }, 1, io);
        io.stdout(`${JSON.stringify({ schema: "wikiskill.event.v1", type: "experiment.result", runId: evolved.runId, data: { evolution: evolved, audit: audit.data }, warnings: audit.warnings })}\n`);
        return 0;
      }
      if (options.subcommand !== "audit") throw new Error("Only `experiment prepare`, `experiment audit`, and `experiment run` are supported.");
      let datasetPath;
      let dataset;
      let targetSkill;
      let skillContext;
      let baseline;
      let mode = options.mode || "publishable";
      let empty = options.empty === true;
      let experimentPath;
      if (options.experimentPath) {
        const loaded = await readExperiment(options.experimentPath);
        experimentPath = loaded.experimentPath;
        const experiment = loaded.experiment;
        ({ datasetPath, dataset } = await validateDatasetFile(experiment.datasetPath, experiment.scorerRef));
        if (dataset.digest !== experiment.datasetDigest) throw new Error("Experiment dataset digest differs from the prepared artifact.");
        targetSkill = experiment.targetSkill;
        skillContext = experiment.skillContext;
        baseline = experiment.baseline;
        empty = experiment.empty === true;
      } else {
        if (!options.datasetPath || !options.target) throw new Error("experiment audit requires --experiment or --dataset and --target.");
        datasetPath = path.resolve(options.datasetPath);
        dataset = core.validateDataset(JSON.parse(await fs.readFile(datasetPath, "utf8")));
        targetSkill = options.target;
        const skillContextPath = options.skillContextPath ? path.resolve(options.skillContextPath) : undefined;
        const baselinePath = options.baselinePath ? path.resolve(options.baselinePath) : undefined;
        skillContext = skillContextPath ? JSON.parse(await fs.readFile(skillContextPath, "utf8")) : null;
        baseline = baselinePath ? JSON.parse(await fs.readFile(baselinePath, "utf8")) : null;
      }
      const result = auditExperiment({
        tasks: dataset.tasks,
        targetSkill,
        skillContext,
        baseline,
        mode,
        empty
      });
      data = { schema: "wikiskill.experiment-audit.v1", datasetPath, targetSkill, mode, splitCounts: result.splitCounts, ...(experimentPath ? { experimentPath } : {}) };
      return output(core.ENVELOPE(data, result.warnings, result.blockers, result.blockers.length ? ["Resolve every blocker, then rerun the canonical dataset validation and experiment audit."] : []), result.blockers.length ? 1 : 0, io);
    } else if (options.command === "run") {
      if (options.subcommand !== "audit" || !options.runRoot || !options.workspace) throw new Error("run audit requires --run-root and --workspace.");
      const result = require("./audit/run").auditRun(path.resolve(options.runRoot), { workspace: path.resolve(options.workspace) });
      data = { schema: "wikiskill.run-audit.v1", ...result.data };
      return output(core.ENVELOPE(data, result.warnings, result.blockers, result.blockers.length ? ["Resolve the run evidence blockers before candidate publication."] : []), result.blockers.length ? 1 : 0, io);
    } else if (options.command === "bootstrap") {
      if (options.subcommand !== "install" && options.subcommand !== "uninstall") throw new Error("Only `bootstrap install` and `bootstrap uninstall` are supported.");
      if (typeof options.bootstrapCommand !== "string" || !options.bootstrapCommand.trim()) throw new Error("bootstrap requires --command.");
      data = await core.updateBootstrap(options.workspace, options.subcommand, { command: options.bootstrapCommand, dryRun: options.dryRun });
    } else if (options.command === "dataset") {
      if (options.subcommand === "recommend-commit") {
        data = await require("./commit-compiler").recommendCommit(options);
      } else if (options.subcommand === "compile-commit") {
        data = await require("./commit-compiler").compileCommit(options);
      } else if (options.subcommand === "verify-known-fix") {
        if (!options.datasetPath || !options.scorerRef || !options.patchPath) throw new Error("dataset verify-known-fix requires --dataset, --scorer, and --patch.");
        data = await require("./dataset-known-fix").verifyKnownFixDataset({ datasetPath: options.datasetPath, scorerRef: options.scorerRef, patchPath: options.patchPath });
        if (data.verdict !== "passed") return output(core.ENVELOPE(data, [], data.failures, []), 1, io);
      } else if (options.subcommand !== "validate") throw new Error("Only `dataset validate` and `dataset verify-known-fix` are supported.");
      else {
      if (!options.datasetPath || !options.scorerRef) throw new Error("dataset validate requires --dataset and --scorer.");
      const { datasetPath, dataset } = await validateDatasetFile(options.datasetPath, options.scorerRef);
      data = {
        schema: "wikiskill.dataset-validation.v1",
        datasetPath,
        digest: dataset.digest,
        scorerRef: options.scorerRef,
        splitCounts: Object.fromEntries(["train", "val", "test"].map((split) => [split, dataset.tasks.filter((task) => task.split === split).length]))
      };
      }
    } else if (options.command === "candidate") {
      if (options.subcommand === "diff") data = await core.diffCandidate(options.workspace, options.candidate);
      else if (options.subcommand === "apply") data = await core.applyCandidate(options.workspace, options.candidate, options);
      else if (options.subcommand === "propose") data = await proposeCandidate(options.workspace, JSON.parse(await fs.readFile(options.input, "utf8")));
      else if (options.subcommand === "review") data = await reviewCandidate(options.workspace, options.candidate, JSON.parse(await fs.readFile(options.input, "utf8")));
      else if (options.subcommand === "list") data = await listCandidates(options.workspace, { limit: options.limit, cursor: options.cursor });
      else throw new Error("Unknown candidate command.");
    } else if (options.command === "status") data = await core.statusWorkspaceEvolution(options.workspace, options.run, options);
    else if (options.command === "rollback") data = await core.rollbackReceipt(options.workspace, options.receipt);
    else throw new Error(`Unknown command: ${options.command}`);
    return output(core.ENVELOPE(data), 0, io);
  } catch (error) {
    const blockers = error.blockers || [error instanceof Error ? error.message : String(error)];
    if (argv.includes("--json-events") && (argv[0] === "evolve" || (argv[0] === "experiment" && argv[1] === "run"))) {
      return output({ schema: "wikiskill.event.v1", type: argv[0] === "evolve" ? "evolution.failed" : "experiment.failed", ...(emittedRunId ? { runId: emittedRunId } : {}), blockers }, 1, io);
    }
    return output(core.ENVELOPE(null, [], blockers, []), 1, io);
  }
}

async function withAbort(operation) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const main = (argv) => {
  execute(argv).then((code) => {
    process.exitCode = code;
  });
};

module.exports = { HELP, execute, main, parse };
