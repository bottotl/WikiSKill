"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { execute } = require("../src/cli");
const { getContextSkill, listContextSkillReceipts, prepareContext, recordContextSkillUse } = require("../src/context");
const { inspectEvolutionBaseline } = require("../src/evolution");
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
  assert.match(frozen.files["PURPOSE.md"], /Source path: [.]+wikiskill\/skills\/review-code/u);
  const receipt = await recordContextSkillUse(workspace, prepared.contextId, "review-code");
  assert.equal(receipt.bundleDigest, frozen.bundleDigest);
  assert.equal(await fs.access(path.join(workspace, ".wikiskill", "runtime", "contexts", prepared.contextId, "receipts", `${receipt.receiptId}.json`)).then(() => true), true);
  assert.deepEqual((await listContextSkillReceipts(workspace, prepared.contextId)).receipts, [receipt]);
});

test("context and evolution baseline freeze the same materialized active Skill set", async () => {
  const { workspace } = await setup();
  const prepared = await prepareContext(workspace);
  const baseline = await inspectEvolutionBaseline(workspace, "review-code");
  assert.deepEqual(baseline.activeSkills, prepared.skills.inventory);
  assert.equal(baseline.activeSkillSetDigest, prepared.skills.bundleDigest);
});

test("uses one stable Skill-set digest across independent frozen contexts", async () => {
  const { workspace, skillRoot } = await setup();
  const first = await prepareContext(workspace);
  const second = await prepareContext(workspace);
  assert.notEqual(first.contextId, second.contextId);
  assert.notEqual(first.contractDigest, second.contractDigest);
  assert.match(first.skills.bundleDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.skills.bundleDigest, second.skills.bundleDigest);

  await fs.appendFile(path.join(skillRoot, "SKILL.md"), "\nNew stable guidance.\n");
  const changed = await prepareContext(workspace);
  assert.notEqual(changed.skills.bundleDigest, first.skills.bundleDigest);
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
  const receipts = await invoke(["context", "receipts", "--workspace", workspace, "--context", prepared.contextId, "--json"]);
  assert.equal(skill.skillId, "review-code");
  assert.equal(receipt.contextId, prepared.contextId);
  assert.deepEqual(receipts.receipts.map((item) => item.skillId), ["review-code"]);
});

test("rejects missing Skills and context traversal", async () => {
  const { workspace } = await setup();
  const prepared = await prepareContext(workspace);
  await assert.rejects(getContextSkill(workspace, prepared.contextId, "missing"), /not present/u);
  await assert.rejects(getContextSkill(workspace, "../escape", "review-code"), /must be safe/u);
});
