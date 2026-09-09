"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.dirname(require.resolve("../package.json"));
const cli = path.join(packageRoot, "bin", "wikiskill");
const fixtureRoot = path.join(packageRoot, "fixtures", "basic-flywheel");

const invoke = (args, env) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split("\n").map(JSON.parse);
};

const removeTemporaryTree = async (root) => {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    await fs.chmod(root, 0o700).catch(() => undefined);
    for (const entry of await fs.readdir(root)) await removeTemporaryTree(path.join(root, entry));
  } else {
    await fs.chmod(root, 0o600).catch(() => undefined);
  }
  await fs.rm(root, { recursive: true, force: true });
};

const main = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-installed-acceptance-"));
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const env = { ...process.env, WIKISKILL_HOME: stateRoot };
  await fs.mkdir(workspace);
  try {
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /experiment prepare .*--dataset/u);
    assert.match(help.stdout, /experiment run .*--dataset/u);
    assert.match(help.stdout, /evolve --experiment/u);
    assert.doesNotMatch(help.stdout, /foreground|episode|dataset create|fixture-evolve/u);

    const preview = invoke(["init", workspace, "--mode", "zero-source-write", "--dry-run", "--json"], env)[0];
    assert.equal(preview.success, true);
    assert.equal(await fs.access(path.join(workspace, ".wikiskill")).then(() => true, () => false), false);
    assert.equal(invoke(["init", workspace, "--mode", "zero-source-write", "--json"], env)[0].success, true);
    assert.equal(invoke(["doctor", "--workspace", workspace, "--json"], env)[0].success, true);

    const skillRoot = path.join(workspace, ".wikiskill", "skills", "target-skill");
    await fs.mkdir(skillRoot);
    const baseline = await fs.readFile(path.join(fixtureRoot, "skill", "SKILL.md"), "utf8");
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), baseline);
    await fs.cp(path.join(fixtureRoot, "adapters"), path.join(workspace, "adapters"), { recursive: true });
    const configPath = path.join(fixtureRoot, "evolution-config.json");
    assert.equal(invoke(["configure", "--workspace", workspace, "--input", configPath, "--json"], env)[0].success, true);

    const datasetPath = path.join(fixtureRoot, "dataset.json");
    const fixtureDataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
    assert.deepEqual(Object.fromEntries(["train", "val", "test"].map((split) => [split, fixtureDataset.tasks.filter((task) => task.split === split).length])), { train: 4, val: 2, test: 2 });
    const events = invoke([
      "experiment", "run",
      "--workspace", workspace,
      "--target", "target-skill",
      "--dataset", datasetPath,
      "--scorer", "scorer:fixture",
      "--provider", "claude",
      "--model", "fixture-model",
      "--reasoning-effort", "low",
      "--tool-profile", "none",
      "--iterations", "2",
      "--max-provider-launches", "24",
      "--run-id", "installed-acceptance",
      "--json-events"
    ], env);
    assert.equal(events[0].type, "experiment.prepared");
    assert.equal(events.find((event) => event.type === "evolution.launch-budget-selected").estimatedProviderLaunches, 24);
    assert.equal(events.at(-1).data.audit.status, "completed");
    const result = events.at(-1).data.evolution;
    assert.equal(result.state.baselineValidationScore, 0);
    assert.equal(result.state.bestValidationScore, 1);
    assert.deepEqual(result.state.proposalHistory.map((entry) => entry.candidateValidationScore), [0.5, 1]);
    assert.deepEqual(result.state.proposalHistory.map((entry) => entry.accepted), [true, true]);
    assert.deepEqual(result.state.acceptedIterations, [1, 2]);
    assert.equal(result.state.baselineTestScore, 0);
    assert.equal(result.state.testScore, 1);
    assert.equal(result.state.testGain, 1);
    assert.equal(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"), baseline);
    const wikiPattern = await fs.readFile(path.join(workspace, ".wikiskill", "wiki", "patterns", "trajectory-outcomes.md"), "utf8");
    assert.match(wikiPattern, /Iteration 1/u);
    assert.match(wikiPattern, /Iteration 2/u);

    const status = invoke(["status", "--workspace", workspace, "--run", result.runId, "--json"], env)[0];
    assert.equal(status.data.state.status, "completed");
    const candidateId = result.candidate.candidateId;
    assert.equal(invoke(["candidate", "diff", "--workspace", workspace, "--candidate", candidateId, "--json"], env)[0].success, true);
    assert.equal(invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidateId, "--dry-run", "--json"], env)[0].data.dryRun, true);
    const applied = invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidateId, "--json"], env)[0];
    const appliedSkill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    assert.match(appliedSkill, /alpha => ALPHA_READY/u);
    assert.match(appliedSkill, /beta => BETA_READY/u);
    const rolledBack = invoke(["rollback", "--workspace", workspace, "--receipt", applied.data.receipt.receiptId, "--json"], env)[0];
    assert.equal(rolledBack.success, true);
    assert.equal(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"), baseline);

    process.stdout.write(`${JSON.stringify({
      success: true,
      data: {
        schema: "wikiskill.black-box-acceptance.v1",
        evidenceClass: "protocol-fixture-not-real-agent-evidence",
        datasetPath: "explicit",
        baselineValidationScore: result.state.baselineValidationScore,
        candidateValidationScores: result.state.proposalHistory.map((entry) => entry.candidateValidationScore),
        acceptedIterations: result.state.acceptedIterations,
        baselineTestScore: result.state.baselineTestScore,
        testScore: result.state.testScore,
        testGain: result.state.testGain,
        wikiRetained: true,
        rollbackVerified: true
      }
    })}\n`);
  } finally {
    await removeTemporaryTree(root);
  }
};

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
