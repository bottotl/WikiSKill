"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { createCommandExitScorer } = require("../src/command-scorer");

const initialize = (workdir) => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "wikiskill@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "WikiSkill"], { cwd: workdir });
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "baseline"], { cwd: workdir });
};

test("command-exit scorer runs an argv command in the isolated checkout", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-command-score-"));
  await fs.writeFile(path.join(workdir, "check.cjs"), "process.stdout.write('verified\\n');\n");
  initialize(workdir);
  const scorer = createCommandExitScorer();
  const passed = await scorer({
    workdir,
    privateInput: { schema: "wikiskill.scorer.command-exit.v1", command: [process.execPath, "check.cjs"], timeoutMs: 5_000 }
  });
  assert.equal(passed.score, 1);
  assert.equal(passed.evidence.exitCode, 0);
  assert.equal(passed.evidence.stdout, "verified\n");
  assert.deepEqual(passed.evidence.command, [process.execPath, "check.cjs"]);
});

test("command-exit scorer returns failed evidence and rejects schema drift", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-command-score-"));
  initialize(workdir);
  const scorer = createCommandExitScorer();
  const failed = await scorer({
    workdir,
    privateInput: { schema: "wikiskill.scorer.command-exit.v1", command: [process.execPath, "-e", "process.stderr.write('failed'); process.exit(3)"] }
  });
  assert.equal(failed.score, 0);
  assert.equal(failed.evidence.exitCode, 3);
  assert.equal(failed.evidence.stderr, "failed");
  await assert.rejects(scorer({
    workdir,
    privateInput: { schema: "wikiskill.scorer.command-exit.v1", command: [process.execPath, "-v"], shell: true }
  }), /unknown field/u);
});

test("command-exit scorer rejects changes outside allowed paths", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-command-score-"));
  await fs.writeFile(path.join(workdir, "source.js"), "module.exports = 1;\n");
  await fs.writeFile(path.join(workdir, "source.test.cjs"), "process.exit(0);\n");
  initialize(workdir);
  await fs.writeFile(path.join(workdir, "source.test.cjs"), "// bypassed\nprocess.exit(0);\n");
  const result = await createCommandExitScorer()({
    workdir,
    privateInput: { schema: "wikiskill.scorer.command-exit.v1", command: [process.execPath, "source.test.cjs"], allowedPaths: ["source.js"] }
  });
  assert.equal(result.score, 0);
  assert.deepEqual(result.evidence.disallowedPaths, ["source.test.cjs"]);
});
