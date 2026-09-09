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
  if (candidate.schema !== "wikiskill.candidate.v1" || candidate.candidateId !== candidateId || !SAFE_ID.test(candidate.targetSkill || "") || !["validation_accepted", "pending_review"].includes(candidate.status)) throw new Error("Candidate manifest is invalid.");
  if (candidate.status === "pending_review" && candidate.origin !== "daily_learning") throw new Error("Pending candidate requires daily learning provenance.");
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

async function applyCandidateUnlocked(workspaceInput, candidateId, { dryRun = false } = {}) {
  const { workspace, config } = await loadWorkspace(workspaceInput);
  const loaded = await loadCandidate(workspace, candidateId);
  if (!dryRun && await treeDigestOrNull(path.join(workspace, ".wikiskill", "skills", loaded.candidate.targetSkill)) === loaded.candidate.resultDigest) {
    for (const entry of await fs.readdir(path.join(workspace, ".wikiskill", "receipts"))) {
      if (!SAFE_ID.test(entry)) continue;
      const file = path.join(workspace, ".wikiskill", "receipts", entry, "receipt.json");
      if (!await exists(file)) continue;
      const receipt = JSON.parse(await fs.readFile(file, "utf8"));
      if (receipt.schema === "wikiskill.apply-receipt.v1" && receipt.candidateId === candidateId && receipt.afterDigest === loaded.candidate.resultDigest) return { candidateId, receipt, changedPaths: receipt.changedPaths, dryRun: false, reused: true };
    }
  }
  const preview = await diffCandidate(workspace, candidateId);
  if (dryRun) return { ...preview, dryRun: true };
  const review = await readReview(workspace, candidateId);
  if (review?.verdict === "rejected") throw new Error("Candidate was rejected.");
  if (preview.candidate.origin === "daily_learning" && (review?.verdict !== "approved" || review.resultDigest !== preview.candidate.resultDigest)) throw new Error("Daily learning candidate requires explicit review before publication.");
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

async function applyCandidate(workspaceInput, candidateId, options = {}) {
  if (options.dryRun) return applyCandidateUnlocked(workspaceInput, candidateId, options);
  const { workspace } = await loadWorkspace(workspaceInput);
  const lockPath = path.join(workspace, ".wikiskill", "runtime", "publish.lock");
  const lock = await fs.open(lockPath, "wx").catch(() => { throw new Error("Another Skill publication is active; inspect publish.lock if interrupted."); });
  await lock.writeFile(json({ pid: process.pid, candidateId }));
  try { return await applyCandidateUnlocked(workspaceInput, candidateId, options); }
  finally { await lock.close(); await fs.unlink(lockPath); }
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

const reviewPath = (workspace, id) => path.join(workspace, ".wikiskill", "runtime", "candidate-reviews", `${id}.json`);
const readReview = async (workspace, id) => {
  try { return JSON.parse(await fs.readFile(reviewPath(workspace, id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

async function proposeCandidate(workspaceInput, input) {
  const { workspace } = await loadWorkspace(workspaceInput);
  if (!input || !SAFE_ID.test(input.targetSkill || "") || !Array.isArray(input.files) || !input.files.length) throw new Error("A target Skill and files are required.");
  for (const key of ["summary", "reason"]) if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`${key} is required.`);
  if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim())) throw new Error("Learning evidence references are required.");
  const liveRoot = path.join(workspace, ".wikiskill", "skills", input.targetSkill);
  const baselineDigest = await treeDigestOrNull(liveRoot);
  if (input.baselineDigest !== baselineDigest) throw new Error("Live Skill changed; read its current baseline before proposing.");
  if (input.supersedes !== undefined) {
    const previous = (await loadCandidate(workspace, input.supersedes)).candidate;
    if (previous.origin !== "daily_learning" || previous.targetSkill !== input.targetSkill || previous.baselineDigest !== baselineDigest || (await readReview(workspace, input.supersedes))?.verdict === "approved") throw new Error("Only a matching pending daily proposal may be revised.");
  }
  if (baselineDigest !== null) {
    const receipts = await fs.readdir(path.join(workspace, ".wikiskill", "receipts"));
    let owned = false;
    for (const id of receipts.filter(id => SAFE_ID.test(id))) {
      const file = path.join(workspace, ".wikiskill", "receipts", id, "receipt.json");
      if (!await exists(file)) continue;
      const receipt = JSON.parse(await fs.readFile(file, "utf8"));
      if (receipt.schema === "wikiskill.apply-receipt.v1" && receipt.targetSkill === input.targetSkill && receipt.afterDigest === baselineDigest) owned = true;
    }
    if (!owned) throw new Error("This Skill has no matching managed publication receipt; preserve user or externally installed content.");
  }
  const seen = new Set();
  for (const file of input.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string" || file.path.includes("\\") || file.path.split("/").some(part => !part || part.startsWith(".")) || path.isAbsolute(file.path)) throw new Error("Unsafe Skill file path.");
    if (!/^(SKILL\.md|PURPOSE\.md|(?:references|scripts|assets)\/.+)$/u.test(file.path) || seen.has(file.path.toLowerCase())) throw new Error("Unsupported or duplicate Skill file.");
    seen.add(file.path.toLowerCase());
  }
  const entry = input.files.find(file => file.path === "SKILL.md");
  const frontmatter = entry?.content.match(/^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/u)?.[1];
  const declaredName = frontmatter?.match(/^name:[ \t]*([A-Za-z0-9._-]+)[ \t]*$/mu)?.[1];
  if (!frontmatter || declaredName !== input.targetSkill || !/^description:[ \t]*\S/mu.test(frontmatter)) throw new Error("SKILL.md must declare its exact name and description in frontmatter.");
  const stage = path.join(workspace, ".wikiskill", "runtime", `proposal-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(stage, "skill"), { recursive: true });
  try {
    for (const file of input.files) {
      const target = path.join(stage, "skill", file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, { flag: "wx" });
    }
    const resultDigest = await treeDigest(path.join(stage, "skill"));
    if (resultDigest === baselineDigest) return { candidate: null, noChange: true };
    const candidateId = `candidate-${digest(`${input.targetSkill}\0${baselineDigest}\0${resultDigest}`).slice(7, 31)}`;
    const finalRoot = path.join(workspace, ".wikiskill", "candidates", candidateId);
    if (await exists(finalRoot)) return { candidate: (await loadCandidate(workspace, candidateId)).candidate, reused: true };
    const candidate = { schema: "wikiskill.candidate.v1", candidateId, targetSkill: input.targetSkill, status: "pending_review", origin: "daily_learning", baselineDigest, resultDigest, summary: input.summary, reason: input.reason, evidenceRefs: input.evidenceRefs, createdAt: new Date().toISOString() };
    await fs.writeFile(path.join(stage, "candidate.json"), json(candidate), { flag: "wx" });
    await fs.rename(stage, finalRoot);
    await sealReadOnly(finalRoot);
    if (input.supersedes && input.supersedes !== candidateId) {
      const previous = (await loadCandidate(workspace, input.supersedes)).candidate;
      await reviewCandidate(workspace, input.supersedes, { verdict: "rejected", reviewer: "daily-learning-revision", reason: `被新候选 ${candidateId} 替代。`, expectedDigest: previous.resultDigest });
    }
    return { candidate, reused: false };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

async function reviewCandidate(workspaceInput, candidateId, input) {
  const { workspace } = await loadWorkspace(workspaceInput);
  const { candidate } = await loadCandidate(workspace, candidateId);
  if (!input || !["approved", "rejected"].includes(input.verdict) || typeof input.reviewer !== "string" || !input.reviewer.trim() || typeof input.reason !== "string" || !input.reason.trim()) throw new Error("Review requires verdict, reviewer and reason.");
  if (input.expectedDigest !== candidate.resultDigest) throw new Error("Review digest does not match the displayed candidate.");
  if (input.verdict === "approved") await diffCandidate(workspace, candidateId);
  const review = { verdict: input.verdict, reviewer: input.reviewer, reason: input.reason, resultDigest: candidate.resultDigest, reviewedAt: new Date().toISOString() };
  const target = reviewPath(workspace, candidateId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stage = `${target}.${crypto.randomUUID()}`;
  await fs.writeFile(stage, json(review));
  await fs.rename(stage, target);
  return { candidate, review };
}

async function listCandidates(workspaceInput, { limit = 20, cursor = "" } = {}) {
  const { workspace } = await loadWorkspace(workspaceInput);
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) throw new Error("limit must be between 1 and 100.");
  const ids = (await fs.readdir(path.join(workspace, ".wikiskill", "candidates"))).filter(id => id.startsWith("candidate-") && SAFE_ID.test(id) && id > cursor).sort();
  const items = [];
  const appliedDigests = new Map();
  for (const id of await fs.readdir(path.join(workspace, ".wikiskill", "receipts"))) {
    if (!SAFE_ID.test(id)) continue;
    const file = path.join(workspace, ".wikiskill", "receipts", id, "receipt.json");
    if (!await exists(file)) continue;
    const receipt = JSON.parse(await fs.readFile(file, "utf8"));
    if (receipt.schema === "wikiskill.apply-receipt.v1") appliedDigests.set(receipt.candidateId, receipt.afterDigest);
  }
  for (const id of ids.slice(0, Number(limit))) {
    const { candidate, skillRoot } = await loadCandidate(workspace, id);
    const currentDigest = await treeDigestOrNull(path.join(workspace, ".wikiskill", "skills", candidate.targetSkill));
    const review = await readReview(workspace, id);
    const status = currentDigest === candidate.resultDigest && appliedDigests.get(id) === currentDigest ? "applied" : review?.verdict === "rejected" ? "rejected" : currentDigest !== candidate.baselineDigest ? "stale" : review?.verdict === "approved" ? "approved" : candidate.status;
    items.push({ ...candidate, status, review, files: await fileMap(skillRoot) });
  }
  return { items, nextCursor: ids.length > Number(limit) ? ids[Number(limit) - 1] : null };
}

module.exports = { applyCandidate, diffCandidate, rollbackReceipt, proposeCandidate, reviewCandidate, listCandidates };
