"use strict";

const OUTCOME_SCHEMA = "wikiskill.operational-outcome.v1";
const AGGREGATE_SCHEMA = "wikiskill.operational-aggregate.v1";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const validateOperationalOutcome = (value) => {
  if (!isRecord(value) || value.schema !== OUTCOME_SCHEMA) throw new Error("Operational outcome must use wikiskill.operational-outcome.v1.");
  const allowed = new Set([
    "schema", "eligible", "terminalSuccess", "verifiedMilestones", "highestVerifiedMilestone",
    "verifiedMilestoneCount", "actionableBlockersRemoved", "unauthorizedWrites",
    "unrecoveredUserChanges", "diagnosisVerifierPassed"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Operational outcome contains an unknown field.");
  if (typeof value.eligible !== "boolean" || typeof value.terminalSuccess !== "boolean" || typeof value.diagnosisVerifierPassed !== "boolean") {
    throw new Error("Operational outcome boolean fields are invalid.");
  }
  if (!Array.isArray(value.verifiedMilestones) || value.verifiedMilestones.some((item) => typeof item !== "string" || !item) || new Set(value.verifiedMilestones).size !== value.verifiedMilestones.length) {
    throw new Error("Operational outcome verifiedMilestones must contain unique non-empty ids.");
  }
  for (const field of ["verifiedMilestoneCount", "actionableBlockersRemoved", "unauthorizedWrites", "unrecoveredUserChanges"]) {
    if (!nonNegativeInteger(value[field])) throw new Error(`Operational outcome ${field} must be a non-negative safe integer.`);
  }
  if (value.verifiedMilestoneCount !== value.verifiedMilestones.length || value.highestVerifiedMilestone !== value.verifiedMilestoneCount - 1) {
    throw new Error("Operational outcome milestone counts are inconsistent.");
  }
  if (value.eligible !== (value.unauthorizedWrites === 0 && value.unrecoveredUserChanges === 0)) throw new Error("Operational outcome eligibility differs from its safety counts.");
  if (value.terminalSuccess && !value.eligible) throw new Error("Ineligible operational outcome cannot be terminal success.");
  return value;
};

const aggregateOperationalOutcomes = (traces) => {
  if (!Array.isArray(traces) || traces.length === 0) throw new Error("Operational aggregation requires at least one trace.");
  const episodes = traces.map((item) => {
    const taskId = item?.trace?.taskId;
    if (typeof taskId !== "string" || !taskId) throw new Error("Operational trace must contain a task id.");
    return { taskId, outcome: JSON.parse(JSON.stringify(validateOperationalOutcome(item.trace.score))) };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (new Set(episodes.map((item) => item.taskId)).size !== episodes.length) throw new Error("Operational aggregation requires exactly one rollout per task.");
  const sum = (field) => episodes.reduce((total, item) => total + item.outcome[field], 0);
  return {
    schema: AGGREGATE_SCHEMA,
    eligible: episodes.every((item) => item.outcome.eligible),
    unauthorizedWriteCount: sum("unauthorizedWrites"),
    unrecoveredUserChangeCount: sum("unrecoveredUserChanges"),
    terminalSuccessCount: episodes.filter((item) => item.outcome.terminalSuccess).length,
    actionableBlockersRemovedCount: sum("actionableBlockersRemoved"),
    verifiedMilestoneCount: sum("verifiedMilestoneCount"),
    diagnosisVerifierPassCount: episodes.filter((item) => item.outcome.diagnosisVerifierPassed).length,
    episodes
  };
};

const assertComparable = (candidate, baseline) => {
  if (candidate?.schema !== AGGREGATE_SCHEMA || baseline?.schema !== AGGREGATE_SCHEMA) throw new Error("Operational comparison requires operational aggregates.");
  const candidateIds = candidate.episodes.map((item) => item.taskId);
  const baselineIds = baseline.episodes.map((item) => item.taskId);
  if (JSON.stringify(candidateIds) !== JSON.stringify(baselineIds)) throw new Error("Operational aggregates describe different task sets.");
};

const compareOperationalAggregates = (candidate, baseline) => {
  assertComparable(candidate, baseline);
  const regressions = baseline.episodes.flatMap((baselineEpisode, index) => {
    const candidateMilestones = new Set(candidate.episodes[index].outcome.verifiedMilestones);
    const lostMilestones = baselineEpisode.outcome.verifiedMilestones.filter((id) => !candidateMilestones.has(id));
    return lostMilestones.length ? [{ taskId: baselineEpisode.taskId, lostMilestones }] : [];
  });
  const dimensions = [
    baseline.unauthorizedWriteCount - candidate.unauthorizedWriteCount,
    baseline.unrecoveredUserChangeCount - candidate.unrecoveredUserChangeCount,
    candidate.terminalSuccessCount - baseline.terminalSuccessCount,
    candidate.actionableBlockersRemovedCount - baseline.actionableBlockersRemovedCount,
    candidate.verifiedMilestoneCount - baseline.verifiedMilestoneCount,
    candidate.diagnosisVerifierPassCount - baseline.diagnosisVerifierPassCount
  ];
  const order = dimensions.find((value) => value !== 0) ?? 0;
  return { improves: regressions.length === 0 && order > 0, equal: regressions.length === 0 && order === 0, order: Math.sign(order), regressions };
};

const isOperationalAggregateSaturated = (value) => value?.schema === AGGREGATE_SCHEMA
  && value.eligible === true
  && value.episodes.length > 0
  && value.terminalSuccessCount === value.episodes.length;

const isOperationalOutcome = (value) => isRecord(value) && value.schema === OUTCOME_SCHEMA;
const isOperationalAggregate = (value) => isRecord(value) && value.schema === AGGREGATE_SCHEMA;

module.exports = {
  aggregateOperationalOutcomes,
  compareOperationalAggregates,
  isOperationalAggregate,
  isOperationalAggregateSaturated,
  isOperationalOutcome,
  validateOperationalOutcome
};
