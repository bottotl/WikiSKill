"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const exists = (target) => fs.access(target).then(() => true, () => false);

const resolveWorkspace = async (input) => {
  if (typeof input !== "string" || !input.trim()) throw new Error("Workspace path is required.");
  const workspace = path.resolve(input);
  const stat = await fs.lstat(workspace).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be an existing non-symlink directory.");
  const config = JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill", "config.json"), "utf8"));
  if (config.schema !== "wikiskill.workspace.v1" || typeof config.workspaceId !== "string") throw new Error("Workspace is not initialized.");
  return { workspace, config };
};

const readTree = async (root) => {
  const files = {};
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill snapshots do not allow symlinks: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files[path.relative(root, target).split(path.sep).join("/")] = await fs.readFile(target, "utf8");
    }
  };
  await walk(root);
  return files;
};

const readContext = async (workspace, contextId) => {
  if (!SAFE_ID.test(contextId || "")) throw new Error("context id must be safe text.");
  const root = path.join(workspace, ".wikiskill", "runtime", "contexts", contextId);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schema !== "wikiskill.context.v1" || manifest.contextId !== contextId) throw new Error("Context manifest is invalid.");
  return { root, manifest };
};

async function prepareContext(input) {
  const { workspace, config } = await resolveWorkspace(input);
  const liveRoot = path.join(workspace, config.liveSkillsPath);
  const skills = [];
  for (const entry of (await fs.readdir(liveRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_ID.test(entry.name)) throw new Error(`Invalid live Skill entry: ${entry.name}`);
    const files = await readTree(path.join(liveRoot, entry.name));
    if (typeof files["SKILL.md"] !== "string") throw new Error(`Live Skill is missing SKILL.md: ${entry.name}`);
    skills.push({ id: entry.name, files, bundleDigest: digest(json(files)) });
  }
  const contextId = `context-${crypto.randomUUID()}`;
  const contextsRoot = path.join(workspace, ".wikiskill", "runtime", "contexts");
  const staging = path.join(contextsRoot, `.staging-${contextId}`);
  const target = path.join(contextsRoot, contextId);
  await fs.mkdir(path.join(staging, "skills"), { recursive: true });
  try {
    for (const skill of skills) {
      for (const [relative, content] of Object.entries(skill.files)) {
        const destination = path.join(staging, "skills", skill.id, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content, { encoding: "utf8", flag: "wx" });
      }
    }
    const inventory = skills.map(({ id, bundleDigest }) => ({ id, bundleDigest }));
    const skillSetDigest = digest(json(inventory));
    const manifest = {
      schema: "wikiskill.context.v1",
      contextId,
      workspaceId: config.workspaceId,
      createdAt: new Date().toISOString(),
      inventory
    };
    const manifestText = json(manifest);
    await fs.writeFile(path.join(staging, "manifest.json"), manifestText, { flag: "wx" });
    await fs.mkdir(path.join(staging, "receipts"));
    await fs.rename(staging, target);
    const contractDigest = digest(manifestText);
    return {
      contextId,
      workspaceId: config.workspaceId,
      contextRef: `wikiskill-context:${config.workspaceId}:${contextId}`,
      contractDigest,
      instructions: "Use only Skills from this frozen context. Read a Skill with skills.getCommand and record every consumed Skill with skills.usedCommand.",
      skills: {
        bundleDigest: skillSetDigest,
        inventory: manifest.inventory,
        getCommand: ["wikiskill", "context", "skill-get", "--workspace", workspace, "--context", contextId, "--skill", "<skill-id>", "--json"],
        usedCommand: ["wikiskill", "context", "receipt", "--workspace", workspace, "--context", contextId, "--skill", "<skill-id>", "--json"]
      }
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function getContextSkill(input, contextId, skillId) {
  const { workspace } = await resolveWorkspace(input);
  if (!SAFE_ID.test(skillId || "")) throw new Error("skill id must be safe text.");
  const context = await readContext(workspace, contextId);
  const descriptor = context.manifest.inventory.find((skill) => skill.id === skillId);
  if (!descriptor) throw new Error(`Skill is not present in the frozen context: ${skillId}`);
  const files = await readTree(path.join(context.root, "skills", skillId));
  if (digest(json(files)) !== descriptor.bundleDigest) throw new Error(`Frozen Skill digest mismatch: ${skillId}`);
  return { contextId, skillId, bundleDigest: descriptor.bundleDigest, files };
}

async function recordContextSkillUse(input, contextId, skillId) {
  const { workspace } = await resolveWorkspace(input);
  if (!SAFE_ID.test(skillId || "")) throw new Error("skill id must be safe text.");
  const context = await readContext(workspace, contextId);
  const descriptor = context.manifest.inventory.find((skill) => skill.id === skillId);
  if (!descriptor) throw new Error(`Skill is not present in the frozen context: ${skillId}`);
  const receipt = {
    schema: "wikiskill.context-skill-receipt.v1",
    receiptId: `receipt-${crypto.randomUUID()}`,
    contextId,
    skillId,
    bundleDigest: descriptor.bundleDigest,
    usedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(context.root, "receipts", `${receipt.receiptId}.json`), json(receipt), { flag: "wx" });
  return receipt;
}

async function listContextSkillReceipts(input, contextId) {
  const { workspace } = await resolveWorkspace(input);
  const context = await readContext(workspace, contextId);
  const entries = await fs.readdir(path.join(context.root, "receipts"), { withFileTypes: true });
  const receipts = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const receipt = JSON.parse(await fs.readFile(path.join(context.root, "receipts", entry.name), "utf8"));
    const descriptor = context.manifest.inventory.find((skill) => skill.id === receipt.skillId);
    if (receipt.schema !== "wikiskill.context-skill-receipt.v1" || receipt.contextId !== contextId || !descriptor || receipt.bundleDigest !== descriptor.bundleDigest) throw new Error(`Context Skill receipt is invalid: ${entry.name}`);
    receipts.push(receipt);
  }
  return { contextId, receipts };
}

module.exports = { getContextSkill, listContextSkillReceipts, prepareContext, recordContextSkillUse };
