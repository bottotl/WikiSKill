"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMaintainer, createProposer } = require("../src/codex-learning");

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => undefined;
  return child;
};

const responseSpawn = (response, verifyPrompt) => (_executable, args) => {
  const finalPath = args[args.indexOf("-o") + 1];
  const child = fakeChild();
  child.stdin.end = (prompt) => {
    verifyPrompt(prompt, args);
    fs.writeFileSync(finalPath, JSON.stringify(response), "utf8");
    child.emit("close", 0, null);
  };
  return child;
};

const responseSequenceSpawn = (responses, verifyPrompt) => {
  let index = 0;
  return (_executable, args) => {
    const finalPath = args[args.indexOf("-o") + 1];
    const child = fakeChild();
    child.stdin.end = (prompt) => {
      verifyPrompt(prompt, args, index);
      fs.writeFileSync(finalPath, JSON.stringify(responses[index]), "utf8");
      index += 1;
      child.emit("close", 0, null);
    };
    return child;
  };
};

test("Codex maintainer turns sampled training evidence into constrained Wiki writes", async (t) => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-codex-maintainer-"));
  t.after(() => fs.rmSync(wikiRoot, { recursive: true, force: true }));
  const patterns = [];
  const logs = [];
  const maintainer = createMaintainer({ timeoutMs: 1_000 }, {
    spawn: responseSpawn({
      appendLog: "observed a stable fallback pattern",
      patterns: [{ name: "gate-fallback.md", content: "# Gate Fallback\n" }]
    }, (prompt, args) => {
      assert.ok(args.includes("read-only"));
      assert.ok(args.includes("--skip-git-repo-check"));
      assert.equal(args.includes("--ignore-user-config"), false);
      assert.match(prompt, /Wiki Maintainer/u);
      assert.match(prompt, /training-1/u);
      assert.match(prompt, /existing pattern/u);
    })
  });
  await maintainer({
    wikiRoot,
    existingWiki: { index: "# Wiki\n", log: "existing pattern\n", skillImpact: "", patterns: {} },
    sampledTraces: [{ taskId: "training-1", split: "train", iteration: 1, score: 0, executionLog: "failed trace" }],
    writePattern: (name, content) => patterns.push({ name, content }),
    patchPattern: () => { throw new Error("unexpected patch"); },
    appendLog: (content) => logs.push(content)
  });
  assert.deepEqual(patterns, [{ name: "gate-fallback.md", content: "# Gate Fallback\n" }]);
  assert.deepEqual(logs, ["observed a stable fallback pattern"]);
});

test("Codex proposer reads four constrained training traces before returning one proposal", async (t) => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-codex-proposer-"));
  t.after(() => fs.rmSync(wikiRoot, { recursive: true, force: true }));
  const readIds = [];
  const proposer = createProposer({ timeoutMs: 1_000 }, {
    spawn: responseSequenceSpawn([
      { traceReads: ["trace-4", "trace-2", "trace-1", "trace-3"] },
      { action: "patch", skillId: "gate-skill", files: { "SKILL.md": "# Gate\nImproved fallback.\n" } }
    ], (prompt, args, index) => {
      assert.ok(args.includes("read-only"));
      assert.ok(args.includes("--skip-git-repo-check"));
      assert.equal(args.includes("--ignore-user-config"), false);
      if (index === 0) {
        assert.match(prompt, /Available Training Trajectories/u);
        assert.doesNotMatch(prompt, /body-4/u);
      } else {
        assert.match(prompt, /Restricted Trace Reads/u);
        assert.match(prompt, /body-4/u);
        assert.match(prompt, /validation\/test/u);
      }
    })
  });
  const proposal = await proposer({
    wikiRoot,
    wiki: { index: "# Wiki\n", log: "", skillImpact: "", patterns: {} },
    skills: { target: { "gate-skill": { "SKILL.md": "# Gate\n" } }, context: {} },
    training: [],
    availableTraces: ["trace-1", "trace-2", "trace-3", "trace-4"].map((id) => ({ id, score: 0 })),
    readTrace: (id) => {
      readIds.push(id);
      return { id, events: [{ type: "assistant", text: `body-${id.slice(-1)}` }] };
    }
  });
  assert.deepEqual(readIds, ["trace-4", "trace-2", "trace-1", "trace-3"]);
  assert.deepEqual(proposal.traceReads, ["trace-4", "trace-2", "trace-1", "trace-3"]);
  assert.equal(proposal.skillId, "gate-skill");
});
