"use strict";

const fs = require("node:fs");
const path = require("node:path");

const createProviderLaunchBudget = ({ root, runId, provider, modelId, reasoningEffort, limit }) => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Provider launch limit must be a positive integer.");
  for (const [key, value] of Object.entries({ root, runId, provider, modelId, reasoningEffort })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be non-empty text.`);
  }
  const ledgerPath = path.join(path.resolve(root), "provider-launches.jsonl");
  const launches = fs.existsSync(ledgerPath)
    ? fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    : [];
  const refs = new Set();
  for (const [index, launch] of launches.entries()) {
    if (launch.runId !== runId || launch.index !== index + 1 || launch.provider !== provider
      || launch.modelId !== modelId || launch.reasoningEffort !== reasoningEffort || refs.has(launch.launchRef)) {
      throw new Error("Provider launch record does not match this run.");
    }
    refs.add(launch.launchRef);
  }
  if (launches.length > limit) throw new Error("Existing launches exceed the configured budget.");
  const snapshot = () => ({
    schema: "wikiskill.provider-launch-budget.v1", unit: "provider_launches",
    limit, used: launches.length, remaining: limit - launches.length,
    launches: launches.map(launch => ({ ...launch, args: [...launch.args] }))
  });
  return Object.freeze({
    consume(launch) {
      if (launches.length >= limit) throw new Error(`Provider launch budget exhausted at ${limit} launches.`);
      if (typeof launch.launchRef !== "string" || !launch.launchRef || refs.has(launch.launchRef)) throw new Error("Provider launchRef is missing or duplicated.");
      if (launch.provider !== provider || launch.modelId !== modelId || launch.reasoningEffort !== reasoningEffort) throw new Error("Provider launch differs from the frozen provider/model/reasoning cohort.");
      if (!Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== "string")) throw new Error("Provider launch args must be strings.");
      if (launch.args.some(arg => ["resume", "fork", "--resume", "--continue", "--fork-session"].includes(arg))) throw new Error("Evolution must start a new Provider session.");
      const record = {
        schema: "wikiskill.provider-launch.v1", index: launches.length + 1, runId,
        launchRef: launch.launchRef, role: launch.role, provider, modelId, reasoningEffort,
        executable: launch.executable, args: [...launch.args]
      };
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.appendFileSync(ledgerPath, JSON.stringify(record) + "\n");
      launches.push(record);
      refs.add(record.launchRef);
      return record;
    },
    snapshot,
    ledgerPath
  });
};

module.exports = { createProviderLaunchBudget };
