"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { aggregateOperationalOutcomes, compareOperationalAggregates, isOperationalAggregateSaturated } = require("../src/operational-outcome");

const outcome = ({ milestones, terminal = false, removed = 0, diagnosis = true }) => ({
  schema: "wikiskill.operational-outcome.v1",
  eligible: true,
  terminalSuccess: terminal,
  verifiedMilestones: milestones,
  highestVerifiedMilestone: milestones.length - 1,
  verifiedMilestoneCount: milestones.length,
  actionableBlockersRemoved: removed,
  unauthorizedWrites: 0,
  unrecoveredUserChanges: 0,
  diagnosisVerifierPassed: diagnosis
});

const trace = (taskId, score) => ({ trace: { taskId, score } });

test("operational aggregate accepts a strict milestone improvement without episode regression", () => {
  const baseline = aggregateOperationalOutcomes([
    trace("val-a", outcome({ milestones: ["M0", "M1"], removed: 1 })),
    trace("val-b", outcome({ milestones: ["M0"], diagnosis: false }))
  ]);
  const candidate = aggregateOperationalOutcomes([
    trace("val-a", outcome({ milestones: ["M0", "M1", "M2"], removed: 1 })),
    trace("val-b", outcome({ milestones: ["M0", "M1"], removed: 1 }))
  ]);

  const comparison = compareOperationalAggregates(candidate, baseline);
  assert.equal(comparison.improves, true);
  assert.deepEqual(comparison.regressions, []);
  assert.equal(candidate.verifiedMilestoneCount, 5);
  assert.equal(candidate.actionableBlockersRemovedCount, 2);
  assert.equal(isOperationalAggregateSaturated(candidate), false);
});

test("operational aggregate rejects aggregate gain when one episode loses a milestone", () => {
  const baseline = aggregateOperationalOutcomes([
    trace("val-a", outcome({ milestones: ["M0", "M1", "M2"] })),
    trace("val-b", outcome({ milestones: ["M0"] }))
  ]);
  const candidate = aggregateOperationalOutcomes([
    trace("val-a", outcome({ milestones: ["M0", "M1"] })),
    trace("val-b", outcome({ milestones: ["M0", "M1", "M2", "M3"], terminal: true }))
  ]);

  const comparison = compareOperationalAggregates(candidate, baseline);
  assert.equal(comparison.improves, false);
  assert.deepEqual(comparison.regressions, [{ taskId: "val-a", lostMilestones: ["M2"] }]);
});

test("operational aggregate is saturated only when every episode reaches terminal success", () => {
  const aggregate = aggregateOperationalOutcomes([
    trace("val-a", outcome({ milestones: ["M0", "M1"], terminal: true })),
    trace("val-b", outcome({ milestones: ["M0"], terminal: true }))
  ]);
  assert.equal(isOperationalAggregateSaturated(aggregate), true);
});
