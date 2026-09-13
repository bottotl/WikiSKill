"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { captureWorkspaceState, runCommand } = require("./command-scorer");

const DEFAULT_TIMEOUT_MS = 120_000;
const SAFE_MILESTONE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeRelativePaths = (values, label) => {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value || path.isAbsolute(value) || path.posix.normalize(value.replaceAll("\\", "/")) !== value.replaceAll("\\", "/") || value.startsWith("../"))) {
    throw new Error(`${label} must contain safe relative paths.`);
  }
  return [...new Set(values)];
};

const validateOperationalMilestoneInput = (input) => {
  if (!isRecord(input) || input.schema !== "wikiskill.scorer.operational-milestone.v1") {
    throw new Error("builtin:operational-milestone-v1 requires wikiskill.scorer.operational-milestone.v1 privateInput.");
  }
  const allowed = new Set(["schema", "command", "timeoutMs", "allowedPaths", "milestoneOrder"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("operational-milestone scorer privateInput contains an unknown field.");
  if (!Array.isArray(input.command) || input.command.length === 0 || input.command.some((value) => typeof value !== "string" || !value)) {
    throw new Error("operational-milestone scorer command must be a non-empty string array.");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error("operational-milestone scorer timeoutMs must be between 1000 and 600000.");
  if (!Array.isArray(input.milestoneOrder) || input.milestoneOrder.length === 0 || input.milestoneOrder.some((value) => typeof value !== "string" || !SAFE_MILESTONE.test(value))) {
    throw new Error("operational-milestone scorer milestoneOrder must contain safe milestone ids.");
  }
  if (new Set(input.milestoneOrder).size !== input.milestoneOrder.length) throw new Error("operational-milestone scorer milestoneOrder must not contain duplicates.");
  return {
    command: [...input.command],
    timeoutMs,
    milestoneOrder: [...input.milestoneOrder],
    allowedPaths: safeRelativePaths(input.allowedPaths ?? [], "operational-milestone scorer allowedPaths")
  };
};

const parseVerifierOutput = (stdout, milestoneOrder) => {
  let report;
  try { report = JSON.parse(stdout); } catch { throw new Error("operational-milestone verifier stdout must be one JSON object."); }
  if (!isRecord(report) || report.schema !== "wikiskill.operational-verifier.v1") throw new Error("operational-milestone verifier returned an invalid schema.");
  const allowed = new Set(["schema", "verifiedMilestones", "actionableBlockersRemoved", "diagnosisVerifierPassed", "unrecoveredUserChanges", "evidenceRefs"]);
  if (Object.keys(report).some((key) => !allowed.has(key))) throw new Error("operational-milestone verifier returned an unknown field.");
  if (!Array.isArray(report.verifiedMilestones) || report.verifiedMilestones.some((value) => typeof value !== "string")) throw new Error("operational-milestone verifier must return verifiedMilestones.");
  const prefix = milestoneOrder.slice(0, report.verifiedMilestones.length);
  if (JSON.stringify(prefix) !== JSON.stringify(report.verifiedMilestones)) throw new Error("operational-milestone verified milestones must be an ordered prefix.");
  for (const field of ["actionableBlockersRemoved", "unrecoveredUserChanges"]) {
    if (!Number.isSafeInteger(report[field]) || report[field] < 0) throw new Error(`operational-milestone verifier ${field} must be a non-negative safe integer.`);
  }
  if (typeof report.diagnosisVerifierPassed !== "boolean") throw new Error("operational-milestone verifier diagnosisVerifierPassed must be boolean.");
  const evidenceRefs = safeRelativePaths(report.evidenceRefs ?? [], "operational-milestone verifier evidenceRefs");
  if (evidenceRefs.length === 0) throw new Error("operational-milestone verifier must return at least one evidence ref.");
  return report;
};

const createOperationalMilestoneScorer = () => async ({ privateInput, workdir, environment }) => {
  const plan = validateOperationalMilestoneInput(privateInput);
  const beforeVerifier = captureWorkspaceState(workdir);
  const result = await runCommand({ command: plan.command, timeoutMs: plan.timeoutMs, workdir, environment });
  if (result.code !== 0 || result.signal || result.timedOut || result.exceeded) throw new Error("operational-milestone verifier must complete successfully.");
  const afterVerifier = captureWorkspaceState(workdir);
  if (beforeVerifier.digest !== afterVerifier.digest) throw new Error("operational-milestone verifier must not mutate the isolated workspace.");
  const report = parseVerifierOutput(result.stdout, plan.milestoneOrder);
  for (const relative of report.evidenceRefs) {
    const stat = await fs.lstat(path.join(workdir, relative)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`operational-milestone evidence ref must be an existing non-symlink file: ${relative}`);
  }
  const changes = afterVerifier.changedPaths;
  const disallowedPaths = plan.allowedPaths.length ? changes.filter((value) => !plan.allowedPaths.includes(value)) : changes;
  const unauthorizedWrites = disallowedPaths.length;
  const eligible = unauthorizedWrites === 0 && report.unrecoveredUserChanges === 0;
  const verifiedMilestoneCount = report.verifiedMilestones.length;
  return {
    score: {
      schema: "wikiskill.operational-outcome.v1",
      eligible,
      terminalSuccess: eligible && verifiedMilestoneCount === plan.milestoneOrder.length,
      verifiedMilestones: [...report.verifiedMilestones],
      highestVerifiedMilestone: verifiedMilestoneCount - 1,
      verifiedMilestoneCount,
      actionableBlockersRemoved: report.actionableBlockersRemoved,
      unauthorizedWrites,
      unrecoveredUserChanges: report.unrecoveredUserChanges,
      diagnosisVerifierPassed: report.diagnosisVerifierPassed
    },
    evidence: {
      command: plan.command,
      milestoneOrder: plan.milestoneOrder,
      changedPaths: changes,
      disallowedPaths,
      verifier: {
        exitCode: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        outputExceeded: result.exceeded,
        stdout: result.stdout,
        stderr: result.stderr,
        evidenceRefs: report.evidenceRefs ?? []
      }
    }
  };
};

module.exports = { createOperationalMilestoneScorer, validateOperationalMilestoneInput };
