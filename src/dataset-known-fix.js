"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createCommandExitScorer } = require("./command-scorer");
const { validateDataset } = require("./index");
const { prepareTaskDependencies } = require("./task-dependencies");

const safeRelative = (value) => {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.split(/[\\/]/u).includes("..") || value.includes("\0")) throw new Error(`Dataset sandbox path is unsafe: ${String(value)}`);
  return value.split(path.sep).join("/");
};

const materialize = async (root, sandbox) => {
  for (const [relativeInput, value] of Object.entries(sandbox || {})) {
    const relative = safeRelative(relativeInput);
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (typeof value === "string") await fs.writeFile(target, value, "utf8");
    else await fs.writeFile(target, Buffer.from(value.content, "base64"));
  }
};

const git = (cwd, args) => {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
};

const prepare = async (root, task) => {
  await fs.mkdir(root, { recursive: true });
  await materialize(root, task.sandbox);
  await prepareTaskDependencies(root, task.sandbox);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "wikiskill@example.invalid"]);
  git(root, ["config", "user.name", "WikiSkill"]);
  await fs.writeFile(path.join(root, ".git", "info", "exclude"), "node_modules/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--allow-empty", "-qm", "task baseline"]);
};

const verifyKnownFixDataset = async (input) => {
  const datasetPath = path.resolve(input.datasetPath);
  const patchPath = path.resolve(input.patchPath);
  for (const [label, target] of [["dataset", datasetPath], ["known fix patch", patchPath]]) {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  }
  if (input.scorerRef !== "builtin:command-exit-v1") throw new Error("Known-fix verification currently requires builtin:command-exit-v1.");
  const dataset = validateDataset(JSON.parse(await fs.readFile(datasetPath, "utf8")));
  if (dataset.tasks.some((task) => task.evaluator.capabilityRef !== input.scorerRef)) throw new Error("Every dataset task evaluator must match the known-fix scorer.");
  const patch = await fs.readFile(patchPath);
  if (patch.length === 0) throw new Error("Known fix patch must not be empty.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-known-fix-"));
  const scorer = createCommandExitScorer();
  const cases = [];
  try {
    const frozenPatchPath = path.join(root, "known-fix.patch");
    await fs.writeFile(frozenPatchPath, patch, { flag: "wx" });
    for (const [index, task] of dataset.tasks.entries()) {
      const baselineRoot = path.join(root, `${index}-baseline`);
      const fixedRoot = path.join(root, `${index}-fixed`);
      await prepare(baselineRoot, task);
      await prepare(fixedRoot, task);
      const baseline = await scorer({ taskId: task.id, prediction: null, privateInput: task.groundTruth, environment: baselineRoot, workdir: baselineRoot, split: task.split, iteration: 0 });
      const applied = childProcess.spawnSync("git", ["apply", "--binary", frozenPatchPath], { cwd: fixedRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (applied.status !== 0) throw new Error(`Known fix patch does not apply to task ${task.id}: ${(applied.stderr || applied.stdout).trim()}`);
      const fixed = await scorer({ taskId: task.id, prediction: null, privateInput: task.groundTruth, environment: fixedRoot, workdir: fixedRoot, split: task.split, iteration: 0 });
      cases.push({ taskId: task.id, split: task.split, baselineScore: baseline.score, fixedScore: fixed.score, baselineEvidence: baseline.evidence, fixedEvidence: fixed.evidence });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  const failures = cases.flatMap((item) => item.baselineScore !== 0 || item.fixedScore !== 1
    ? [`Task ${item.taskId} must score baseline=0 and known-fix=1; received ${item.baselineScore}/${item.fixedScore}.`]
    : []);
  return {
    schema: "wikiskill.known-fix-verification.v1",
    datasetDigest: dataset.digest,
    patchDigest: `sha256:${crypto.createHash("sha256").update(patch).digest("hex")}`,
    scorerRef: input.scorerRef,
    cases,
    verdict: failures.length ? "failed" : "passed",
    failures
  };
};

module.exports = { verifyKnownFixDataset };
