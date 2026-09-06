"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyCandidate, diffCandidate, rollbackReceipt } = require("../src/publishing");
const { initWorkspace } = require("../src/workspace");
const { execute } = require("../src/cli");

const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

const treeDigest = async (root) => {
  const walk = async (directory) => (await fs.readdir(directory, { withFileTypes: true })).flatMap((entry) => entry.isDirectory() ? [] : [path.join(directory, entry.name)]);
  const files = (await walk(root)).sort();
  const chunks = [];
  for (const file of files) chunks.push(Buffer.from(`${path.relative(root, file)}\0`), await fs.readFile(file), Buffer.from("\0"));
  return digest(Buffer.concat(chunks));
};

const setup = async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-publishing-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-publishing-state-"));
  await initWorkspace(workspace, { mode: "zero-source-write" });
  const skillRoot = path.join(workspace, ".wikiskill/skills/target-skill");
  await fs.mkdir(skillRoot);
  const before = "---\nname: target-skill\ndescription: Handle target tasks.\n---\n\n# Target\n\nOld procedure.\n";
  const after = before.replace("Old procedure", "Improved procedure");
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), before);
  const baselineDigest = await treeDigest(skillRoot);
  const candidateSkill = path.join(workspace, ".wikiskill/candidates/staging-skill");
  await fs.mkdir(candidateSkill);
  await fs.writeFile(path.join(candidateSkill, "SKILL.md"), after);
  const resultDigest = await treeDigest(candidateSkill);
  const candidateId = `candidate-${digest(`target-skill\0${baselineDigest}\0${resultDigest}`).slice("sha256:".length, "sha256:".length + 24)}`;
  const candidateRoot = path.join(workspace, ".wikiskill/candidates", candidateId);
  await fs.mkdir(candidateRoot);
  await fs.rename(candidateSkill, path.join(candidateRoot, "skill"));
  await fs.writeFile(path.join(candidateRoot, "candidate.json"), JSON.stringify({ schema: "wikiskill.candidate.v1", candidateId, targetSkill: "target-skill", status: "validation_accepted", baselineDigest, resultDigest, runId: "run-1", baselineValidationScore: 0, candidateValidationScore: 1, testScore: 1, acceptedIterations: [1], configDigest: digest("config"), frozenComponents: { adapter: digest("adapter") } }));
  return { workspace, stateRoot, skillRoot, candidateId, before, after };
};

test("candidate dry-run is zero-write and apply targets only the live Skill authority", async () => {
  const { workspace, skillRoot, candidateId, before, after } = await setup();
  const preview = await applyCandidate(workspace, candidateId, { dryRun: true });
  assert.deepEqual(preview.changedPaths, [".wikiskill/skills/target-skill/SKILL.md"]);
  assert.equal(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"), before);
  const applied = await applyCandidate(workspace, candidateId);
  assert.equal(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"), after);
  assert.equal(typeof applied.receipt.appliedAt, "string");
  assert.equal(await fs.access(path.join(workspace, ".wikiskill/receipts", applied.receipt.receiptId, "before", "SKILL.md")).then(() => true), true);
});

test("digest drift blocks apply and rollback before live writes", async () => {
  const { workspace, candidateId, before } = await setup();
  const live = path.join(workspace, ".wikiskill/skills/target-skill/SKILL.md");
  await fs.writeFile(live, before.replace("Old", "Owner-edited"));
  await assert.rejects(applyCandidate(workspace, candidateId, { dryRun: true }), /differs from the candidate baseline/u);
  assert.match(await fs.readFile(live, "utf8"), /Owner-edited/u);
  await fs.writeFile(live, before);
  const applied = await applyCandidate(workspace, candidateId);
  await fs.writeFile(live, before.replace("Old", "Post-apply owner edit"));
  await assert.rejects(rollbackReceipt(workspace, applied.receipt.receiptId), /differs from the applied receipt/u);
  assert.match(await fs.readFile(live, "utf8"), /Post-apply owner edit/u);
});

test("candidate CLI diff, apply dry-run, apply, and rollback share the public contract", async () => {
  const { workspace, candidateId } = await setup();
  const invoke = async (args) => {
    const lines = [];
    const code = await execute(args, { stdout: (line) => lines.push(line), stderr: () => {} });
    return { code, value: JSON.parse(lines.join("")) };
  };
  assert.equal((await invoke(["candidate", "diff", "--workspace", workspace, "--candidate", candidateId, "--json"])).code, 0);
  assert.equal((await invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidateId, "--dry-run", "--json"])).value.data.dryRun, true);
  const applied = await invoke(["candidate", "apply", "--workspace", workspace, "--candidate", candidateId, "--json"]);
  assert.equal(applied.code, 0);
  const rolledBack = await invoke(["rollback", "--workspace", workspace, "--receipt", applied.value.data.receipt.receiptId, "--json"]);
  assert.equal(rolledBack.value.data.schema, "wikiskill.rollback-receipt.v1");
});
