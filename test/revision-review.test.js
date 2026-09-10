"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { initWorkspace } = require("../src/workspace");
const { proposeCandidate, reviewCandidate, listCandidates, applyCandidate } = require("../src/publishing");

const proposal = text => ({ targetSkill: "check-contract", baselineDigest: null, summary: "验证契约", reason: "避免遗漏", evidenceRefs: ["test:passed"], files: [{ path: "SKILL.md", content: `---\nname: check-contract\ndescription: Verify contracts.\n---\n${text}\n` }] });
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-review-"));
  try { await initWorkspace(root, { mode: "zero-source-write" }); await run(root); }
  finally {
    const writable = async dir => { await fs.chmod(dir, 0o755); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    await writable(root); await fs.rm(root, { recursive: true, force: true });
  }
}

test("requested changes are digest-bound, idempotent, block apply, and preserve a revision chain", () => fixture(async root => {
  const { candidate: first } = await proposeCandidate(root, proposal("First"));
  const feedback = { verdict: "changes_requested", reviewer: "owner", reason: "补充边界验证", expectedDigest: first.resultDigest };
  await assert.rejects(reviewCandidate(root, first.candidateId, { ...feedback, reason: "" }), /reason/);
  await assert.rejects(reviewCandidate(root, first.candidateId, { ...feedback, expectedDigest: undefined }), /digest/);
  await assert.rejects(reviewCandidate(root, first.candidateId, { ...feedback, reviewer: "" }), /reviewer/);
  const reviewed = await reviewCandidate(root, first.candidateId, feedback);
  const repeated = await reviewCandidate(root, first.candidateId, feedback);
  assert.equal(repeated.reused, true); assert.deepEqual(repeated.review, reviewed.review);
  assert.equal((await listCandidates(root)).items[0].status, "changes_requested");
  await assert.rejects(applyCandidate(root, first.candidateId), /changes requested/);
  const input = { ...proposal("Second with boundaries"), supersedes: first.candidateId };
  const revised = await proposeCandidate(root, input);
  assert.equal(revised.candidate.supersedes, first.candidateId);
  assert.equal(revised.candidate.revisionFeedback.reason, feedback.reason);
  assert.equal(revised.candidate.revisionFeedback.resultDigest, first.resultDigest);
  assert.equal((await proposeCandidate(root, input)).reused, true);
  const old = (await listCandidates(root)).items.find(item => item.candidateId === first.candidateId);
  assert.equal(old.status, "superseded"); assert.equal(old.supersededBy, revised.candidate.candidateId);
  assert.equal(old.review.verdict, "changes_requested"); assert.equal(old.review.reason, feedback.reason);
  await assert.rejects(applyCandidate(root, first.candidateId), /superseded/);
  await assert.rejects(reviewCandidate(root, first.candidateId, { ...feedback, verdict: "approved" }), /superseded/);
  await assert.rejects(proposeCandidate(root, { ...proposal("Third"), supersedes: first.candidateId }), /replacement/);
  await reviewCandidate(root, revised.candidate.candidateId, { ...feedback, verdict: "approved", expectedDigest: revised.candidate.resultDigest });
  await assert.rejects(proposeCandidate(root, { ...proposal("Third"), supersedes: revised.candidate.candidateId }), /pending or changes_requested/);
}));

test("pending revisions retain lineage, rejected and stale baselines cannot be revised", () => fixture(async root => {
  const { candidate } = await proposeCandidate(root, proposal("one"));
  const next = await proposeCandidate(root, { ...proposal("two"), supersedes: candidate.candidateId });
  assert.equal(next.candidate.revisionFeedback, null);
  await reviewCandidate(root, next.candidate.candidateId, { verdict: "rejected", reviewer: "owner", reason: "not needed", expectedDigest: next.candidate.resultDigest });
  await assert.rejects(proposeCandidate(root, { ...proposal("three"), supersedes: next.candidate.candidateId }), /pending or changes_requested/);
  const live = path.join(root, ".wikiskill/skills/check-contract");
  await fs.mkdir(live); await fs.writeFile(path.join(live, "SKILL.md"), "external change");
  await assert.rejects(proposeCandidate(root, { ...proposal("three"), supersedes: candidate.candidateId }), /Live Skill changed/);
}));

test("CLI requests changes, reports status, refuses apply and accepts a linked revision", () => fixture(async root => {
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, "../bin/wikiskill"), ...args, "--workspace", root, "--json"], { encoding: "utf8" });
  const { candidate } = await proposeCandidate(root, proposal("first"));
  const input = path.join(root, "review.json");
  await fs.writeFile(input, JSON.stringify({ verdict: "changes_requested", reviewer: "owner", reason: "add verification", expectedDigest: candidate.resultDigest }));
  const reviewed = cli("candidate", "review", "--candidate", candidate.candidateId, "--input", input);
  assert.equal(reviewed.status, 0, reviewed.stderr); assert.equal(JSON.parse(reviewed.stdout).data.review.verdict, "changes_requested");
  assert.equal(JSON.parse(cli("candidate", "list").stdout).data.items[0].status, "changes_requested");
  assert.notEqual(cli("candidate", "apply", "--candidate", candidate.candidateId).status, 0);
  await fs.writeFile(input, JSON.stringify({ ...proposal("second"), supersedes: candidate.candidateId }));
  const revised = cli("candidate", "propose", "--input", input);
  assert.equal(revised.status, 0, revised.stderr); assert.equal(JSON.parse(revised.stdout).data.candidate.supersedes, candidate.candidateId);
}));
