"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const core = require("./index");

const HELP = `wikiskill init <workspace> [--mode direct|zero-source-write] [--dry-run] --json
wikiskill doctor --workspace <workspace> --json
wikiskill uninstall --workspace <workspace> [--dry-run] --json
wikiskill evolve --workspace <workspace> --target <skill-id> --dataset <dataset.json> --provider codex|claude --model <id> --scorer <ref> [--empty] [--run-id <id>] --json-events
wikiskill status --workspace <workspace> --run <id> [--state-root <dir>] --json
wikiskill configure --workspace <workspace> --input <evolution-config.json> [--dry-run] --json
wikiskill candidate diff --workspace <workspace> --candidate <id> --json
wikiskill candidate apply --workspace <workspace> --candidate <id> [--dry-run] --json
wikiskill rollback --workspace <workspace> --receipt <id> --json
`;

const SUBCOMMANDS = Object.freeze({
  candidate: new Set(["diff", "apply"])
});

const VALUE_FLAGS = Object.freeze({
  "--run-id": "runId",
  "--run": "run",
  "--workspace": "workspace",
  "--mode": "mode",
  "--input": "input",
  "--dataset": "datasetPath",
  "--target": "target",
  "--candidate": "candidate",
  "--provider": "provider",
  "--model": "modelId",
  "--scorer": "scorerRef",
  "--receipt": "receipt",
  "--state-root": "stateRoot"
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

async function execute(argv, io = { stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) }) {
  let emittedRunId;
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      io.stdout(HELP);
      return argv.length ? 0 : 1;
    }
    const options = parse(argv);
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
        const runtime = [options.provider, options.modelId, options.scorerRef];
        if (runtime.some((value) => value === undefined)) throw new Error("evolve --dataset requires --provider, --model, and --scorer.");
      }
      data = await withAbort((signal) => runEvolutionCommand(options, io, signal, (id) => { emittedRunId = id; }));
      io.stdout(`${JSON.stringify({ schema: "wikiskill.event.v1", type: "evolution.result", runId: data.runId, data })}\n`);
      return 0;
    } else if (options.command === "configure") {
      data = await core.configureEvolution(options.workspace, JSON.parse(await fs.readFile(path.resolve(options.input), "utf8")), options);
    } else if (options.command === "candidate") {
      if (options.subcommand === "diff") data = await core.diffCandidate(options.workspace, options.candidate);
      else if (options.subcommand === "apply") data = await core.applyCandidate(options.workspace, options.candidate, options);
      else throw new Error("Only `candidate diff` and `candidate apply` are supported.");
    } else if (options.command === "status") data = await core.statusWorkspaceEvolution(options.workspace, options.run, options);
    else if (options.command === "rollback") data = await core.rollbackReceipt(options.workspace, options.receipt);
    else throw new Error(`Unknown command: ${options.command}`);
    return output(core.ENVELOPE(data), 0, io);
  } catch (error) {
    const blockers = error.blockers || [error instanceof Error ? error.message : String(error)];
    if (argv[0] === "evolve" && argv.includes("--json-events")) {
      return output({ schema: "wikiskill.event.v1", type: "evolution.failed", ...(emittedRunId ? { runId: emittedRunId } : {}), blockers }, 1, io);
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
