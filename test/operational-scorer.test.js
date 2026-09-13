"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createOperationalMilestoneScorer } = require("../src/operational-scorer");
const { createBuiltinCapabilityRegistry } = require("../src/runtime-capabilities");

const initialize = (workdir) => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "wikiskill@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "WikiSkill"], { cwd: workdir });
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "baseline"], { cwd: workdir });
};

test("operational scorer derives an eligible milestone outcome from verifier evidence", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-operational-score-"));
  await fs.writeFile(path.join(workdir, "artifact.json"), "{}\n");
  await fs.writeFile(path.join(workdir, "verify.cjs"), `
process.stdout.write(JSON.stringify({
  schema: "wikiskill.operational-verifier.v1",
  verifiedMilestones: ["M0", "M1", "M2"],
  actionableBlockersRemoved: 1,
  diagnosisVerifierPassed: true,
  unrecoveredUserChanges: 0,
  evidenceRefs: ["artifact.json"]
}));
`);
  initialize(workdir);
  await fs.writeFile(path.join(workdir, "artifact.json"), "{\"passed\":true}\n");

  const result = await createOperationalMilestoneScorer()({
    workdir,
    privateInput: {
      schema: "wikiskill.scorer.operational-milestone.v1",
      command: [process.execPath, "verify.cjs"],
      milestoneOrder: ["M0", "M1", "M2", "M3"],
      allowedPaths: ["artifact.json"]
    }
  });

  assert.deepEqual(result.score, {
    schema: "wikiskill.operational-outcome.v1",
    eligible: true,
    terminalSuccess: false,
    verifiedMilestones: ["M0", "M1", "M2"],
    highestVerifiedMilestone: 2,
    verifiedMilestoneCount: 3,
    actionableBlockersRemoved: 1,
    unauthorizedWrites: 0,
    unrecoveredUserChanges: 0,
    diagnosisVerifierPassed: true
  });
  assert.deepEqual(result.evidence.disallowedPaths, []);
  assert.equal(result.evidence.verifier.exitCode, 0);
});

test("operational scorer rejects a verifier that mutates the isolated workspace", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-operational-score-"));
  await fs.writeFile(path.join(workdir, "artifact.json"), "{}\n");
  await fs.writeFile(path.join(workdir, "verify.cjs"), `
const fs = require("node:fs");
fs.writeFileSync("artifact.json", "mutated by verifier\\n");
process.stdout.write(JSON.stringify({
  schema: "wikiskill.operational-verifier.v1",
  verifiedMilestones: ["M0"],
  actionableBlockersRemoved: 0,
  diagnosisVerifierPassed: true,
  unrecoveredUserChanges: 0,
  evidenceRefs: ["artifact.json"]
}));
`);
  initialize(workdir);

  await assert.rejects(createOperationalMilestoneScorer()({
    workdir,
    privateInput: {
      schema: "wikiskill.scorer.operational-milestone.v1",
      command: [process.execPath, "verify.cjs"],
      milestoneOrder: ["M0"],
      allowedPaths: ["artifact.json"]
    }
  }), /verifier must not mutate/u);
});

test("builtin registry exposes the operational milestone scorer", () => {
  const resolved = createBuiltinCapabilityRegistry().resolveScorer("builtin:operational-milestone-v1", {});
  assert.equal(resolved.descriptor.apiVersion, "wikiskill.scorer.v1");
  assert.match(resolved.descriptor.implementationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(typeof resolved.score, "function");
});

test("operational scorer rejects missing verifier evidence", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-operational-score-"));
  await fs.writeFile(path.join(workdir, "verify.cjs"), `
process.stdout.write(JSON.stringify({
  schema: "wikiskill.operational-verifier.v1",
  verifiedMilestones: ["M0"],
  actionableBlockersRemoved: 0,
  diagnosisVerifierPassed: true,
  unrecoveredUserChanges: 0,
  evidenceRefs: ["missing.json"]
}));
`);
  initialize(workdir);

  await assert.rejects(createOperationalMilestoneScorer()({
    workdir,
    privateInput: {
      schema: "wikiskill.scorer.operational-milestone.v1",
      command: [process.execPath, "verify.cjs"],
      milestoneOrder: ["M0"]
    }
  }), /evidence ref must be an existing non-symlink file/u);
});
