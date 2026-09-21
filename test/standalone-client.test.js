"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { resolveStandaloneWikiSkillExecutable, WikiSkillStandaloneClient } = require("../src/standalone-client");

test("standalone client resolves the executable shipped by its package", () => {
  assert.equal(resolveStandaloneWikiSkillExecutable({}), path.resolve(__dirname, "..", "bin", "wikiskill"));
});

test("standalone client rejects a successful payload from a failing process", async () => {
  const client = new WikiSkillStandaloneClient({ execute: async () => ({
    code: 1,
    stdout: JSON.stringify({ success: true, data: {}, warnings: [], blockers: [], nextActions: [] }),
    stderr: ""
  }) });
  const result = await client.invoke(["doctor", "--workspace", "/tmp/workspace", "--json"]);
  assert.equal(result.success, false);
  assert.match(result.blockers[0], /code 1/u);
});
