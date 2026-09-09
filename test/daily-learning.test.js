"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { initWorkspace } = require("../src/workspace");
const { proposeCandidate, reviewCandidate, listCandidates, applyCandidate, rollbackReceipt } = require("../src/publishing");
const { prepareContext, getContextSkill } = require("../src/context");

test("daily candidate is pending without scores, requires digest-bound review and publishes to next context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-daily-"));
  try {
    await initWorkspace(root, { mode: "zero-source-write" });
    const original = await prepareContext(root);
    const input = { targetSkill: "check-contract", baselineDigest: null, summary: "验证契约", reason: "避免重复遗漏", evidenceRefs: ["test:passed"], files: [{ path: "SKILL.md", content: "---\nname: check-contract\ndescription: Verify contract changes.\n---\n\nRun contract tests.\n" }] };
    const { candidate } = await proposeCandidate(root, input);
    assert.equal(candidate.status, "pending_review"); assert.equal(candidate.candidateValidationScore, undefined);
    await assert.rejects(applyCandidate(root, candidate.candidateId), /explicit review/u);
    await assert.rejects(reviewCandidate(root, candidate.candidateId, { verdict: "approved", reviewer: "owner", reason: "reviewed", expectedDigest: "wrong" }), /digest/u);
    await reviewCandidate(root, candidate.candidateId, { verdict: "approved", reviewer: "owner", reason: "reviewed", expectedDigest: candidate.resultDigest });
    const applied = await applyCandidate(root, candidate.candidateId);
    assert.equal((await applyCandidate(root, candidate.candidateId)).receipt.receiptId, applied.receipt.receiptId);
    assert.equal((await listCandidates(root)).items[0].status, "applied");
    await assert.rejects(getContextSkill(root, original.contextId, input.targetSkill), /not present/u);
    const next = await prepareContext(root);
    assert.match((await getContextSkill(root, next.contextId, input.targetSkill)).files["SKILL.md"], /Run contract tests/u);
    await fs.writeFile(path.join(root, ".wikiskill/wiki/index.md"), "# 已整理的长期模式\n");
    await initWorkspace(root, { mode: "zero-source-write" });
    assert.match(await fs.readFile(path.join(root, ".wikiskill/wiki/index.md"), "utf8"), /长期模式/u);
    await rollbackReceipt(root, applied.receipt.receiptId);
    await assert.rejects(fs.access(path.join(root, ".wikiskill/skills/check-contract/SKILL.md")));
    await reviewCandidate(root, candidate.candidateId, { verdict: "rejected", reviewer: "owner", reason: "withdrawn", expectedDigest: candidate.resultDigest });
    await assert.rejects(applyCandidate(root, candidate.candidateId), /rejected/u);
  } finally {
    const writable = async directory => { await fs.chmod(directory, 0o755); for (const item of await fs.readdir(directory, { withFileTypes: true })) if (item.isDirectory()) await writable(path.join(directory, item.name)); };
    await writable(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});
