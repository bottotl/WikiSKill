"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProviderLaunchBudget } = require("../src/provider-launch-budget");

test("counts launches, restores records, and enforces the configured budget", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-budget-"));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const config = {root,runId:"run-1",provider:"codex",modelId:"model-1",reasoningEffort:"low",limit:1};
  const launch = {launchRef:"inference:1",role:"inference",provider:"codex",modelId:"model-1",reasoningEffort:"low",executable:"codex",args:["exec","--ephemeral"]};
  const budget = createProviderLaunchBudget(config);
  assert.throws(() => budget.consume({...launch,modelId:"other"}), /frozen/);
  assert.throws(() => budget.consume({...launch,args:["exec","resume","source"]}), /new Provider session/);
  budget.consume(launch);
  assert.equal(budget.snapshot().used,1);
  assert.throws(() => budget.consume({...launch,launchRef:"inference:2"}), /exhausted/);
  assert.deepEqual(createProviderLaunchBudget(config).snapshot(),budget.snapshot());
});
