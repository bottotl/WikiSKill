"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createClaudeRunner } = require("./claude-runner");
const { createCodexRunner } = require("./codex-runner");
const codexLearning = require("./codex-learning");
const claudeLearning = require("./claude-learning");
const { createCommandExitScorer } = require("./command-scorer");

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const implementationDigestFor = (files) => `sha256:${crypto.createHash("sha256")
  .update(Buffer.concat(files.flatMap((file) => [fs.readFileSync(path.join(__dirname, file)), Buffer.from("\0")])))
  .digest("hex")}`;

const validateDescriptor = (kind, descriptor, factory) => {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error(`${kind} descriptor must be an object.`);
  if (typeof descriptor.ref !== "string" || !descriptor.ref.trim()) throw new Error(`${kind} capability ref must be non-empty text.`);
  if (descriptor.apiVersion !== `wikiskill.${kind}.v1`) throw new Error(`${kind} apiVersion must be wikiskill.${kind}.v1.`);
  if (typeof descriptor.implementationVersion !== "string" || !descriptor.implementationVersion.trim()) throw new Error(`${kind} implementationVersion must be non-empty text.`);
  if (!SHA256.test(descriptor.implementationDigest || "")) throw new Error(`${kind} implementationDigest must be sha256.`);
  if (typeof factory !== "function") throw new Error(`${kind} capability factory must be a function.`);
  return Object.freeze({ ...descriptor, ref: descriptor.ref.trim(), implementationVersion: descriptor.implementationVersion.trim() });
};

const createCapabilityRegistry = () => {
  const runners = new Map();
  const scorers = new Map();
  const learningAgents = new Map();
  let sealed = false;
  const register = (kind, map, descriptor, factory) => {
    if (sealed) throw new Error("Runtime capability registry is sealed.");
    const normalized = validateDescriptor(kind, descriptor, factory);
    if (runners.has(normalized.ref) || scorers.has(normalized.ref) || learningAgents.has(normalized.ref)) throw new Error(`Runtime capability ref is already registered: ${normalized.ref}`);
    map.set(normalized.ref, { descriptor: normalized, factory });
  };
  const resolve = (kind, map, ref, config) => {
    if (!sealed) throw new Error("Runtime capability registry must be sealed before resolution.");
    if (typeof ref !== "string" || !ref.trim()) throw new Error(`${kind} capability ref must be non-empty text.`);
    const entry = map.get(ref);
    if (!entry) throw new Error(`${kind} capability is not registered: ${ref}`);
    const implementation = entry.factory(config);
    if (typeof implementation !== "function") throw new Error(`${kind} capability factory must return a function.`);
    return kind === "runner" ? { descriptor: entry.descriptor, run: implementation } : { descriptor: entry.descriptor, score: implementation };
  };
  return Object.freeze({
    registerRunner: (descriptor, factory) => register("runner", runners, descriptor, factory),
    registerScorer: (descriptor, factory) => register("scorer", scorers, descriptor, factory),
    registerLearningAgent: (descriptor, factory) => register("learning-agent", learningAgents, descriptor, factory),
    seal: () => { sealed = true; },
    resolveRunner: (ref, config) => resolve("runner", runners, ref, config),
    resolveScorer: (ref, config) => resolve("scorer", scorers, ref, config),
    resolveLearningAgent: (ref, config) => {
      if (!sealed) throw new Error("Runtime capability registry must be sealed before resolution.");
      if (typeof ref !== "string" || !ref.trim()) throw new Error("learning-agent capability ref must be non-empty text.");
      const entry = learningAgents.get(ref);
      if (!entry) throw new Error(`learning-agent capability is not registered: ${ref}`);
      const implementation = entry.factory(config);
      if (!implementation || typeof implementation.maintainer !== "function" || typeof implementation.proposer !== "function") throw new Error("learning-agent capability factory must return maintainer and proposer functions.");
      return { descriptor: entry.descriptor, ...implementation };
    },
    snapshot: () => {
      if (!sealed) throw new Error("Runtime capability registry must be sealed before snapshot.");
      return [
        ...[...runners.values()].map((entry) => ({ kind: "runner", ...entry.descriptor })),
        ...[...scorers.values()].map((entry) => ({ kind: "scorer", ...entry.descriptor })),
        ...[...learningAgents.values()].map((entry) => ({ kind: "learning-agent", ...entry.descriptor }))
      ].sort((left, right) => left.ref.localeCompare(right.ref));
    }
  });
};

const exactOutputScorer = async ({ prediction, privateInput }) => {
  if (!privateInput || typeof privateInput !== "object" || Array.isArray(privateInput) || privateInput.schema !== "wikiskill.scorer.exact-output.v1" || !Object.hasOwn(privateInput, "expected")) {
    throw new Error("builtin:exact-output-v1 requires wikiskill.scorer.exact-output.v1 privateInput with expected.");
  }
  const matched = JSON.stringify(canonical(prediction)) === JSON.stringify(canonical(privateInput.expected));
  return { score: matched ? 1 : 0, evidence: { matched } };
};

const createBuiltinCapabilityRegistry = () => {
  const registry = createCapabilityRegistry();
  registry.registerRunner({
    ref: "provider:codex",
    apiVersion: "wikiskill.runner.v1",
    implementationVersion: "1",
    implementationDigest: implementationDigestFor(["codex-runner.js", "clean-environment.js"])
  }, (config) => createCodexRunner(config));
  registry.registerRunner({
    ref: "provider:claude",
    apiVersion: "wikiskill.runner.v1",
    implementationVersion: "1",
    implementationDigest: implementationDigestFor(["claude-runner.js", "inference-isolation.js", "clean-environment.js"])
  }, (config) => createClaudeRunner(config));
  registry.registerScorer({
    ref: "builtin:exact-output-v1",
    apiVersion: "wikiskill.scorer.v1",
    implementationVersion: "1",
    implementationDigest: implementationDigestFor(["runtime-capabilities.js"])
  }, () => exactOutputScorer);
  registry.registerScorer({
    ref: "builtin:command-exit-v1",
    apiVersion: "wikiskill.scorer.v1",
    implementationVersion: "1",
    implementationDigest: implementationDigestFor(["command-scorer.js"])
  }, () => createCommandExitScorer());
  registry.registerLearningAgent({
    ref: "builtin:codex-cli-v1",
    apiVersion: "wikiskill.learning-agent.v1",
    implementationVersion: "1",
    implementationDigest: implementationDigestFor(["codex-learning.js"])
  }, (config) => ({ maintainer: codexLearning.createMaintainer(config), proposer: codexLearning.createProposer(config) }));
  registry.registerLearningAgent({
    ref: "provider:claude-learning",
    apiVersion: "wikiskill.learning-agent.v1",
    implementationVersion: "1",
    implementationDigest: implementationDigestFor(["claude-learning.js", "claude-runner.js"])
  }, (config) => ({ maintainer: claudeLearning.createMaintainer(config), proposer: claudeLearning.createProposer(config) }));
  registry.seal();
  return registry;
};

const scoreWithBuiltin = async (ref, input) => {
  const registry = createBuiltinCapabilityRegistry();
  return registry.resolveScorer(ref, {}).score(input);
};

const runnerRefForProvider = (provider) => {
  const refs = { codex: "provider:codex", claude: "provider:claude" };
  const ref = refs[provider];
  if (!ref) throw new Error(`No runtime runner capability is declared for recorded Provider: ${String(provider)}`);
  return ref;
};

const learningRefForProvider = (provider) => {
  const refs = { codex: "builtin:codex-cli-v1", claude: "provider:claude-learning" };
  const ref = refs[provider];
  if (!ref) throw new Error(`No learning-agent capability is declared for recorded Provider: ${String(provider)}`);
  return ref;
};

module.exports = { createBuiltinCapabilityRegistry, createCapabilityRegistry, learningRefForProvider, runnerRefForProvider, scoreWithBuiltin };
