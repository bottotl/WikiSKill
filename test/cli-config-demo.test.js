"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCommandExitScorer } = require("../src/command-scorer");
const { validateDataset } = require("../src");

const packageRoot = path.resolve(__dirname, "..");
const demoRoot = path.join(packageRoot, "examples", "cli-config-evolution");
const datasetPath = path.join(demoRoot, "dataset.json");
const runnerPath = path.join(demoRoot, "scripts", "run-live.cjs");

const migrate = (source) => ({
  ...source,
  command: "execctl",
  args: ["run", "--format=json", "--", source.command, ...source.args],
  env: { ...source.env, EXECCTL_NONINTERACTIVE: "1" }
});

const initializeGit = (workdir) => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "wikiskill@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "WikiSkill"], { cwd: workdir });
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "baseline"], { cwd: workdir });
};

test("CLI configuration demo has a valid non-leaking 4/2/2 dataset", async () => {
  const dataset = validateDataset(JSON.parse(await fs.readFile(datasetPath, "utf8")));
  assert.deepEqual(Object.fromEntries(["train", "val", "test"].map((split) => [split, dataset.tasks.filter((task) => task.split === split).length])), {
    train: 4,
    val: 2,
    test: 2
  });
  for (const task of dataset.tasks) {
    assert.equal(task.evaluator.capabilityRef, "builtin:command-exit-v1");
    assert.deepEqual(task.groundTruth.allowedPaths, ["config/execctl.json"]);
    assert.equal(Object.hasOwn(task.sandbox, "config/execctl.json"), true);
    assert.equal(Object.hasOwn(task.sandbox, "RUNBOOK.md"), task.split === "train");
  }
});

test("every private CLI configuration checker rejects its baseline and accepts the migration contract", async () => {
  const dataset = validateDataset(JSON.parse(await fs.readFile(datasetPath, "utf8")));
  const scorer = createCommandExitScorer();
  for (const task of dataset.tasks) {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-cli-demo-"));
    await fs.mkdir(path.join(workdir, "config"));
    const configPath = path.join(workdir, "config", "execctl.json");
    await fs.writeFile(configPath, task.sandbox["config/execctl.json"], "utf8");
    initializeGit(workdir);
    const baseline = await scorer({ workdir, privateInput: task.groundTruth });
    assert.equal(baseline.score, 0, task.id);
    const source = JSON.parse(task.sandbox["config/execctl.json"]);
    await fs.writeFile(configPath, `${JSON.stringify(migrate(source), null, 2)}\n`, "utf8");
    const evolved = await scorer({ workdir, privateInput: task.groundTruth });
    assert.equal(evolved.score, 1, task.id);
  }
});

test("demo dry-run initializes an isolated workspace without calling Codex", async () => {
  const artifactParent = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-cli-demo-artifacts-"));
  const result = spawnSync(process.execPath, [runnerPath, "--dry-run", "--output-root", artifactParent, "--run-id", "dry-run"], {
    cwd: packageRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.status, "prepared");
  assert.equal(await fs.access(path.join(artifactParent, "dry-run", "workspace", ".wikiskill", "skills", "execctl-v2", "SKILL.md")).then(() => true), true);
});
