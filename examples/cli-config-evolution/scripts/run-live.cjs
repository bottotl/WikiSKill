"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const demoRoot = path.resolve(__dirname, "..");
const packageRoot = path.resolve(demoRoot, "..", "..");
const cli = path.join(packageRoot, "bin", "wikiskill");
const datasetPath = path.join(demoRoot, "dataset.json");
const seedSkillRoot = path.join(demoRoot, "skills", "execctl-v2");
const targetSkill = "execctl-v2";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const usage = "Usage: node examples/cli-config-evolution/scripts/run-live.cjs [--dry-run] [--model <id>] [--output-root <dir>] [--run-id <id>]";

const parse = (argv) => {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!new Set(["--model", "--output-root", "--run-id"]).has(flag)) throw new Error(`Unknown option: ${flag}\n${usage}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.\n${usage}`);
    options[{ "--model": "model", "--output-root": "outputRoot", "--run-id": "runId" }[flag]] = value;
  }
  if (options.runId && !SAFE_ID.test(options.runId)) throw new Error("--run-id must be a safe identifier.");
  if (!options.dryRun && !options.model) throw new Error(`--model is required for a live Codex run.\n${usage}`);
  return options;
};

const invoke = (args, env) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024
  });
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  if (result.status !== 0) {
    const message = events.at(-1)?.blockers?.join("; ") || result.stderr.trim() || "wikiskill command failed";
    throw new Error(`${args[0]} failed: ${message}`);
  }
  return events;
};

const createRunId = () => `live-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const writeSummary = async (root, summary) => {
  await fs.writeFile(path.join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
};

async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const runId = options.runId || createRunId();
  const outputRoot = path.resolve(options.outputRoot || path.join(demoRoot, "artifacts"), runId);
  const workspace = path.join(outputRoot, "workspace");
  const stateRoot = path.join(outputRoot, "state");
  const env = { ...process.env, WIKISKILL_HOME: stateRoot };
  const summary = {
    schema: "wikiskill.demo-result.v1",
    runId,
    outputRoot,
    workspace,
    stateRoot,
    status: "preparing"
  };

  try {
    await fs.mkdir(path.dirname(outputRoot), { recursive: true });
    await fs.mkdir(outputRoot, { recursive: false });
    await fs.mkdir(workspace);
    invoke(["init", workspace, "--mode", "zero-source-write", "--json"], env);
    await fs.cp(seedSkillRoot, path.join(workspace, ".wikiskill", "skills", targetSkill), { recursive: true });
    invoke(["doctor", "--workspace", workspace, "--json"], env);

    if (options.dryRun) {
      summary.status = "prepared";
      summary.dryRun = true;
      await writeSummary(outputRoot, summary);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return summary;
    }

    const evolution = invoke([
      "evolve", "--workspace", workspace,
      "--target", targetSkill,
      "--dataset", datasetPath,
      "--provider", "codex",
      "--model", options.model,
      "--scorer", "builtin:command-exit-v1",
      "--run-id", runId,
      "--json-events"
    ], env).at(-1);
    const result = evolution?.type === "evolution.result" ? evolution.data : null;
    if (!result) throw new Error("evolve did not emit an evolution.result event.");
    const status = invoke(["status", "--workspace", workspace, "--run", runId, "--json"], env).at(-1);
    summary.model = options.model;
    summary.evolution = {
      rawRef: result.rawRef,
      wiki: result.wiki,
      baselineValidationScore: result.state.baselineValidationScore,
      finalValidationScore: result.state.bestValidationScore,
      baselineTestScore: result.state.baselineTestScore,
      testScore: result.state.testScore,
      testGain: result.state.testGain,
      acceptedIterations: result.state.acceptedIterations,
      status: status.data.state.status
    };

    if (result.candidate) {
      const candidateId = result.candidate.candidateId;
      const diff = invoke(["candidate", "diff", "--workspace", workspace, "--candidate", candidateId, "--json"], env).at(-1).data;
      const expectedPrefix = `.wikiskill/skills/${targetSkill}/`;
      if (!diff.changedPaths.includes(`${expectedPrefix}SKILL.md`) || diff.changedPaths.some((changed) => !changed.startsWith(expectedPrefix))) {
        throw new Error("Candidate changed files outside the target Skill authority.");
      }
      const preview = invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidateId, "--dry-run", "--json"], env).at(-1).data;
      const applied = invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidateId, "--json"], env).at(-1).data;
      summary.candidate = {
        candidateId,
        changedPaths: diff.changedPaths,
        dryRun: preview.dryRun,
        receiptId: applied.receipt.receiptId,
        appliedSkillPath: path.join(workspace, ".wikiskill", "skills", targetSkill, "SKILL.md")
      };
    }

    const qualityPassed = Boolean(
      result.candidate
      && result.state.acceptedIterations.length > 0
      && result.state.bestValidationScore > result.state.baselineValidationScore
      && result.state.testScore > result.state.baselineTestScore
    );
    summary.status = qualityPassed ? "passed" : "inconclusive";
    summary.qualityPassed = qualityPassed;
    await writeSummary(outputRoot, summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (!qualityPassed) throw new Error("Live run completed without a strict validation and test improvement; retained artifacts are inconclusive.");
    return summary;
  } catch (error) {
    if (summary.status !== "inconclusive") summary.status = "failed";
    summary.error = error instanceof Error ? error.message : String(error);
    await writeSummary(outputRoot, summary).catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parse };
