"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createBuiltinCapabilityRegistry, createCapabilityRegistry, learningRefForProvider, runnerRefForProvider } = require("../src/runtime-capabilities");

test("sealed runtime registry resolves runner and scorer capabilities by exact ref", () => {
  const registry = createCapabilityRegistry();
  const runner = () => ({ prediction: "ok", events: [] });
  const scorer = () => ({ score: 1, evidence: {} });
  registry.registerRunner({ ref: "provider:claude", apiVersion: "wikiskill.runner.v1", implementationVersion: "1", implementationDigest: `sha256:${"a".repeat(64)}` }, () => runner);
  registry.registerScorer({ ref: "scorer:exact-output", apiVersion: "wikiskill.scorer.v1", implementationVersion: "1", implementationDigest: `sha256:${"b".repeat(64)}` }, () => scorer);
  registry.seal();

  assert.equal(registry.resolveRunner("provider:claude", {}).run, runner);
  assert.equal(registry.resolveScorer("scorer:exact-output", {}).score, scorer);
  assert.deepEqual(registry.snapshot().map((item) => item.ref), ["provider:claude", "scorer:exact-output"]);
});

test("built-in exact-output scorer resolves by ref and keeps expected output private", async () => {
  const registry = createBuiltinCapabilityRegistry();
  assert.equal(typeof registry.resolveRunner("provider:claude", {}).run, "function");
  const scorer = registry.resolveScorer("builtin:exact-output-v1", {}).score;
  const matched = await scorer({ prediction: { answer: [1, 2] }, privateInput: { schema: "wikiskill.scorer.exact-output.v1", expected: { answer: [1, 2] } } });
  const missed = await scorer({ prediction: { answer: [2, 1] }, privateInput: { schema: "wikiskill.scorer.exact-output.v1", expected: { answer: [1, 2] } } });
  assert.deepEqual(matched, { score: 1, evidence: { matched: true } });
  assert.deepEqual(missed, { score: 0, evidence: { matched: false } });
  assert.equal(JSON.stringify(matched).includes("answer"), false);
});

test("built-in command-exit scorer is registered with its shipped implementation digest", () => {
  const registry = createBuiltinCapabilityRegistry();
  const descriptor = registry.snapshot().find((item) => item.ref === "builtin:command-exit-v1");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "command-scorer.js"));
  const expected = `sha256:${crypto.createHash("sha256").update(Buffer.concat([source, Buffer.from("\0")])).digest("hex")}`;
  assert.equal(typeof registry.resolveScorer("builtin:command-exit-v1", {}).score, "function");
  assert.equal(descriptor.implementationDigest, expected);
});

test("built-in Claude learning descriptor digests its complete shipped implementation", () => {
  const registry = createBuiltinCapabilityRegistry();
  const descriptor = registry.snapshot().find((item) => item.ref === "provider:claude-learning");
  const sources = ["claude-learning.js", "claude-runner.js"].map((file) => fs.readFileSync(path.join(__dirname, "..", "src", file)));
  const expected = `sha256:${crypto.createHash("sha256").update(Buffer.concat(sources.flatMap((source) => [source, Buffer.from("\0")]))).digest("hex")}`;
  assert.equal(descriptor.implementationDigest, expected);
});

test("built-in Codex runner is sealed under the exact provider ref with its implementation digest", () => {
  const registry = createBuiltinCapabilityRegistry();
  const descriptor = registry.snapshot().find((item) => item.ref === "provider:codex");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "codex-runner.js"));
  const expected = `sha256:${crypto.createHash("sha256").update(Buffer.concat([source, Buffer.from("\0")])).digest("hex")}`;

  assert.equal(runnerRefForProvider("codex"), "provider:codex");
  assert.equal(learningRefForProvider("codex"), "builtin:codex-cli-v1");
  assert.equal(typeof registry.resolveRunner("provider:codex", {}).run, "function");
  assert.equal(descriptor.implementationDigest, expected);
});
