"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { compileCommit, recommendCommit } = require("../src/commit-compiler");
test("commit compiler exposes source references to the preparation role and requests explicit scenarios", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-compile-test-"));
  try {
    const input = path.join(root, "source.json");
    await fs.writeFile(input, JSON.stringify({ schema: "jft0m.commitCompilationSource.v1", practiceRoot: root, patchPath: path.join(root, "fix.patch"), knowledgeRoot: path.join(root, "knowledge") }));
    const result = await compileCommit({ input, provider: "codex", modelId: "fixture", reasoningEffort: "medium" }, async request => {
      assert.equal(request.workdir, root); assert.deepEqual(request.tools, ["workspace"]);
      assert.equal(request.input.patchPath, path.join(root, "fix.patch"));
      assert.match(request.systemPrompt, /不执行代码修改或评分命令/);
      assert.ok(request.predictionSchema.required.includes("cases"));
      return { prediction: { blockers: ["Need original requirement"] }, usage: { input_tokens: 10 }, events: [] };
    });
    assert.deepEqual(result.draft.blockers, ["Need original requirement"]);
    assert.equal(result.usage.input_tokens, 10);
    await fs.writeFile(input, JSON.stringify({ schema: "jft0m.commitRecommendationSource.v1", commits: [{ sha: "a".repeat(40), subject: "Fix behavior" }] }));
    const recommendation = await recommendCommit({ input, provider: "codex", modelId: "fixture", reasoningEffort: "medium" }, async request => {
      assert.deepEqual(request.tools, []); assert.equal(request.input.commits.length, 1);
      return { prediction: { recommendations: [{ sha: "a".repeat(40), reason: "Focused behavior" }] } };
    });
    assert.equal(recommendation.recommendations.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
