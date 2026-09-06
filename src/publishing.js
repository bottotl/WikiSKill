"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONFIG_SCHEMA = "wikiskill.workspace.v1";

const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const exists = async (target) => fs.access(target).then(() => true, () => false);

const loadWorkspace = async (workspaceInput) => {
  if (typeof workspaceInput !== "string" || !workspaceInput.trim()) throw new Error("Workspace path is required.");
  const workspace = path.resolve(workspaceInput);
  const config = JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill", "config.json"), "utf8"));
  if (config.schema !== CONFIG_SCHEMA || !SAFE_ID.test(config.workspaceId)) throw new Error("Workspace has an invalid WikiSkill config.");
  return { workspace, config };
};

const sortedFiles = async (root) => {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill bundle root must be a non-symlink directory.");
  const files = [];
  const visit = async (directory) => {
    const folded = new Set();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const key = entry.name.toLocaleLowerCase("en-US");
      if (folded.has(key)) throw new Error(`Case-colliding Skill path: ${path.relative(root, path.join(directory, entry.name))}`);
      folded.add(key);
      const target = path.join(directory, entry.name);
      const child = await fs.lstat(target);
      if (child.isSymbolicLink()) throw new Error(`Skill bundle path must not be a symlink: ${path.relative(root, target)}`);
      if (child.isDirectory()) await visit(target);
      else if (child.isFile()) files.push(target);
      else throw new Error(`Unsupported Skill bundle entry: ${path.relative(root, target)}`);
    }
  };
  await visit(root);
  return files.sort();
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
const treeDigestOrNull = async (root) => await exists(root) ? treeDigest(root) : null;

const fileMap = async (root) => {
  const result = {};
  if (!await exists(root)) return result;
  for (const file of await sortedFiles(root)) result[path.relative(root, file).split(path.sep).join("/")] = await fs.readFile(file, "utf8");
  return result;
};

const copyWritableTree = async (source, destination) => {
  await fs.mkdir(destination, { recursive: true, mode: 0o755 });
  for (const file of await sortedFiles(source)) {
    const target = path.join(destination, path.relative(source, file));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await fs.copyFile(file, target);
    await fs.chmod(target, 0o644);
  }
};

const sealReadOnly = async (target) => {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) await sealReadOnly(path.join(target, entry));
    await fs.chmod(target, 0o555);
  } else await fs.chmod(target, 0o444);
};

const loadCandidate = async (workspace, candidateId) => {
  if (!SAFE_ID.test(candidateId || "")) throw new Error("Candidate id must be a safe identifier.");
  const root = path.join(workspace, ".wikiskill", "candidates", candidateId);
  const candidate = JSON.parse(await fs.readFile(path.join(root, "candidate.json"), "utf8"));
  if (candidate.schema !== "wikiskill.candidate.v1" || candidate.candidateId !== candidateId || !SAFE_ID.test(candidate.targetSkill || "") || candidate.status !== "validation_accepted") throw new Error("Candidate manifest is invalid.");
  const skillRoot = path.join(root, "skill");
  if (await treeDigest(skillRoot) !== candidate.resultDigest) throw new Error("Candidate result digest is invalid.");
  const expectedId = `candidate-${digest(`${candidate.targetSkill}\0${candidate.baselineDigest}\0${candidate.resultDigest}`).slice("sha256:".length, "sha256:".length + 24)}`;
  if (expectedId !== candidateId) throw new Error("Candidate identity digest is invalid.");
  return { candidate, skillRoot };
};

const buildDiff = async (beforeRoot, afterRoot, targetSkill) => {
  const before = await fileMap(beforeRoot);
  const after = await fileMap(afterRoot);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changedPaths = paths.filter((file) => before[file] !== after[file]).map((file) => `.wikiskill/skills/${targetSkill}/${file}`);
  const diff = paths.filter((file) => before[file] !== after[file]).map((file) => [
    `--- a/.wikiskill/skills/${targetSkill}/${file}`,
    `+++ b/.wikiskill/skills/${targetSkill}/${file}`,
    "@@",
    ...(before[file] || "").replace(/\n$/u, "").split("\n").filter((line) => line || before[file]).map((line) => `-${line}`),
    ...(after[file] || "").replace(/\n$/u, "").split("\n").filter((line) => line || after[file]).map((line) => `+${line}`),
    ""
  ].join("\n")).join("\n");
  return { changedPaths, diff };
};

async function diffCandidate(workspaceInput, candidateId) {
  const { workspace } = await loadWorkspace(workspaceInput);
  const { candidate, skillRoot } = await loadCandidate(workspace, candidateId);
  const liveRoot = path.join(workspace, ".wikiskill", "skills", candidate.targetSkill);
  if (await treeDigestOrNull(liveRoot) !== candidate.baselineDigest) throw new Error("Live Skill digest differs from the candidate baseline.");
  return { candidate, ...(await buildDiff(liveRoot, skillRoot, candidate.targetSkill)) };
}

async function applyCandidate(workspaceInput, candidateId, { dryRun = false } = {}) {
  const { workspace, config } = await loadWorkspace(workspaceInput);
  const preview = await diffCandidate(workspace, candidateId);
  if (dryRun) return { ...preview, dryRun: true };
  const { candidate, skillRoot } = await loadCandidate(workspace, candidateId);
  const liveRoot = path.join(workspace, ".wikiskill", "skills", candidate.targetSkill);
  const runtime = path.join(workspace, ".wikiskill", "runtime");
  const receiptId = `receipt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const receiptRoot = path.join(workspace, ".wikiskill", "receipts", receiptId);
  const stage = path.join(runtime, `.apply-${receiptId}`);
  const backup = path.join(runtime, `.backup-${receiptId}`);
  const receiptStage = path.join(runtime, `.receipt-${receiptId}`);
  const created = !await exists(liveRoot);
  await copyWritableTree(skillRoot, stage);
  if (await treeDigestOrNull(liveRoot) !== candidate.baselineDigest) { await fs.rm(stage, { recursive: true, force: true }); throw new Error("Live Skill changed during candidate apply."); }
  if (created) await fs.mkdir(receiptStage, { recursive: true });
  else await copyWritableTree(liveRoot, path.join(receiptStage, "before"));
  try {
    if (!created) await fs.rename(liveRoot, backup);
    await fs.rename(stage, liveRoot);
    if (await treeDigest(liveRoot) !== candidate.resultDigest) throw new Error("Applied Skill digest does not match the candidate.");
    const receipt = {
      schema: "wikiskill.apply-receipt.v1",
      receiptId,
      workspaceId: config.workspaceId,
      candidateId,
      targetSkill: candidate.targetSkill,
      beforeDigest: candidate.baselineDigest,
      afterDigest: candidate.resultDigest,
      created,
      appliedAt: new Date().toISOString(),
      changedPaths: preview.changedPaths
    };
    await fs.writeFile(path.join(receiptStage, "receipt.json"), json(receipt), { flag: "wx" });
    await fs.rename(receiptStage, receiptRoot);
    await sealReadOnly(receiptRoot);
    await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return { candidateId, receipt, changedPaths: preview.changedPaths, dryRun: false };
  } catch (error) {
    await fs.rm(liveRoot, { recursive: true, force: true });
    if (await exists(backup)) await fs.rename(backup, liveRoot);
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(receiptStage, { recursive: true, force: true });
    await fs.rm(receiptRoot, { recursive: true, force: true });
    throw error;
  }
}

async function rollbackReceipt(workspaceInput, receiptId) {
  const { workspace, config } = await loadWorkspace(workspaceInput);
  if (!SAFE_ID.test(receiptId || "")) throw new Error("Receipt id must be a safe identifier.");
  const receiptRoot = path.join(workspace, ".wikiskill", "receipts", receiptId);
  const receipt = JSON.parse(await fs.readFile(path.join(receiptRoot, "receipt.json"), "utf8"));
  if (receipt.schema !== "wikiskill.apply-receipt.v1" || receipt.receiptId !== receiptId || receipt.workspaceId !== config.workspaceId) throw new Error("Apply receipt identity is invalid.");
  const before = path.join(receiptRoot, "before");
  if (receipt.created !== true && await treeDigest(before) !== receipt.beforeDigest) throw new Error("Rollback snapshot digest is invalid.");
  const liveRoot = path.join(workspace, ".wikiskill", "skills", receipt.targetSkill);
  if (await treeDigest(liveRoot) !== receipt.afterDigest) throw new Error("Live Skill digest differs from the applied receipt.");
  const rollbackId = `rollback-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const runtime = path.join(workspace, ".wikiskill", "runtime");
  const stage = path.join(runtime, `.rollback-${rollbackId}`);
  const backup = path.join(runtime, `.rollback-backup-${rollbackId}`);
  if (receipt.created !== true) await copyWritableTree(before, stage);
  const rollbackRoot = path.join(workspace, ".wikiskill", "receipts", rollbackId);
  const rollbackStage = path.join(runtime, `.rollback-receipt-${rollbackId}`);
  await fs.mkdir(rollbackStage);
  const rollback = { schema: "wikiskill.rollback-receipt.v1", receiptId: rollbackId, revertedReceiptId: receiptId, workspaceId: config.workspaceId, targetSkill: receipt.targetSkill, beforeDigest: receipt.afterDigest, afterDigest: receipt.beforeDigest, removedCreatedSkill: receipt.created === true, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(rollbackStage, "receipt.json"), json(rollback), { flag: "wx" });
  try {
    await fs.rename(liveRoot, backup);
    if (receipt.created !== true) await fs.rename(stage, liveRoot);
    if (await treeDigestOrNull(liveRoot) !== receipt.beforeDigest) throw new Error("Rolled-back Skill digest is invalid.");
    await fs.rename(rollbackStage, rollbackRoot);
    await sealReadOnly(rollbackRoot);
    await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return rollback;
  } catch (error) {
    await fs.rm(liveRoot, { recursive: true, force: true });
    if (await exists(backup)) await fs.rename(backup, liveRoot);
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(rollbackStage, { recursive: true, force: true });
    await fs.rm(rollbackRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { applyCandidate, diffCandidate, rollbackReceipt };
