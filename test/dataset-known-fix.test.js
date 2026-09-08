"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execute } = require("../src/cli");

test("known-fix CLI requires every case to reject baseline and accept the patch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-known-fix-test-"));
  try {
    const datasetPath = path.join(root, "dataset.json");
    const patchPath = path.join(root, "fix.patch");
    const tasks = ["train", "val", "test"].map((split, index) => ({
      id: split, split, input: { case: index },
      sandbox: { "value.cjs": "module.exports = false;\n", "check.cjs": "process.exit(require('./value.cjs') ? 0 : 1);\n" },
      groundTruth: { schema: "wikiskill.scorer.command-exit.v1", command: [process.execPath, "check.cjs"], allowedPaths: ["value.cjs"] },
      evaluator: { capabilityRef: "builtin:command-exit-v1" }
    }));
    await fs.writeFile(datasetPath, JSON.stringify({ schema: "wikiskill.dataset.v1", tasks }));
    await fs.writeFile(patchPath, "diff --git a/value.cjs b/value.cjs\n--- a/value.cjs\n+++ b/value.cjs\n@@ -1 +1 @@\n-module.exports = false;\n+module.exports = true;\n");
    const invoke = async () => {
      const output = [];
      const code = await execute(["dataset", "verify-known-fix", "--dataset", datasetPath, "--patch", patchPath, "--scorer", "builtin:command-exit-v1", "--json"], { stdout: (s) => output.push(s), stderr: () => {} });
      return { code, result: JSON.parse(output.join("")) };
    };
    const valid = await invoke();
    assert.equal(valid.code, 0, JSON.stringify(valid.result));
    assert.deepEqual(valid.result.data.cases.map((c) => [c.baselineScore, c.fixedScore]), [[0, 1], [0, 1], [0, 1]]);
    tasks[2].sandbox["check.cjs"] = "process.exit(0);\n";
    await fs.writeFile(datasetPath, JSON.stringify({ schema: "wikiskill.dataset.v1", tasks }));
    const invalid = await invoke();
    assert.equal(invalid.code, 1);
    assert.match(invalid.result.blockers.join(" "), /baseline=0 and known-fix=1/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
