"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { execute } = require("../src/cli");
const { getContextSkill, prepareContext, recordContextSkillUse } = require("../src/context");
const { initWorkspace } = require("../src/workspace");

const setup = async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-context-"));
  await initWorkspace(workspace, { mode: "zero-source-write" });
  const skillRoot = path.join(workspace, ".wikiskill", "skills", "review-code");
  await fs.mkdir(skillRoot);
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Review Code\n\nUse baseline guidance.\n");
  return { workspace, skillRoot };
};

test("prepares an immutable Skill context and records consumption", async () => {
  const { workspace, skillRoot } = await setup();
  const prepared = await prepareContext(workspace);
  assert.equal(prepared.skills.inventory.length, 1);
  assert.match(prepared.contractDigest, /^sha256:[0-9a-f]{64}$/u);
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Review Code\n\nUse changed live guidance.\n");
  const frozen = await getContextSkill(workspace, prepared.contextId, "review-code");
  assert.match(frozen.files["SKILL.md"], /baseline guidance/u);
  assert.doesNotMatch(frozen.files["SKILL.md"], /changed live guidance/u);
  const receipt = await recordContextSkillUse(workspace, prepared.contextId, "review-code");
  assert.equal(receipt.bundleDigest, frozen.bundleDigest);
  assert.equal(await fs.access(path.join(workspace, ".wikiskill", "runtime", "contexts", prepared.contextId, "receipts", `${receipt.receiptId}.json`)).then(() => true), true);
});

test("context CLI exposes prepare, skill-get, and receipt", async () => {
  const { workspace } = await setup();
  const invoke = async (args) => {
    const lines = [];
    const code = await execute(args, { stdout: (line) => lines.push(line), stderr: () => {} });
    assert.equal(code, 0, lines.join(""));
    return JSON.parse(lines.join("")).data;
  };
  const prepared = await invoke(["context", "prepare", "--workspace", workspace, "--json"]);
  const skill = await invoke(["context", "skill-get", "--workspace", workspace, "--context", prepared.contextId, "--skill", "review-code", "--json"]);
  const receipt = await invoke(["context", "receipt", "--workspace", workspace, "--context", prepared.contextId, "--skill", "review-code", "--json"]);
  assert.equal(skill.skillId, "review-code");
  assert.equal(receipt.contextId, prepared.contextId);
});

test("rejects missing Skills and context traversal", async () => {
  const { workspace } = await setup();
  const prepared = await prepareContext(workspace);
  await assert.rejects(getContextSkill(workspace, prepared.contextId, "missing"), /not present/u);
  await assert.rejects(getContextSkill(workspace, "../escape", "review-code"), /must be safe/u);
});
