"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const readJson = (target) => JSON.parse(fs.readFileSync(target, "utf8"));
const sha256 = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

const visitJson = (root) => {
  const files = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
    }
  };
  visit(root);
  return files.sort();
};

const auditRun = (runRoot, { workspace } = {}) => {
  const blockers = [];
  const warnings = [];
  const manifest = readJson(path.join(runRoot, "manifest.json"));
  const state = readJson(path.join(runRoot, "runs", "state.json"));
  const taskSet = readJson(path.join(runRoot, "tasks", "task-set.json"));
  if (state.status !== "completed") blockers.push(`Run status is ${String(state.status)}, expected completed.`);

  if (!workspace) blockers.push("Workspace is required to verify the immutable Raw authority.");
  else {
    const expectedRawRef = `.wikiskill/raw/evolutions/${manifest.runId}`;
    if (manifest.rawReferencePrefix !== expectedRawRef) blockers.push("Run manifest has an invalid Raw authority reference.");
    else {
      try {
        const authorityManifest = readJson(path.join(path.resolve(workspace), expectedRawRef, "manifest.json"));
        const receipt = readJson(path.join(runRoot, "result", "raw-authority.json"));
        if (authorityManifest.schema !== "wikiskill.evolution-raw.v1" || authorityManifest.runId !== manifest.runId || !SHA256.test(authorityManifest.rawDigest || "")) blockers.push("Persisted Raw authority manifest is invalid.");
        if (receipt.schema !== "wikiskill.raw-authority-receipt.v1" || receipt.runId !== manifest.runId || receipt.rawRef !== expectedRawRef || receipt.rawDigest !== authorityManifest.rawDigest) blockers.push("Terminal Raw authority receipt does not match its manifest.");
      } catch (error) {
        blockers.push(`Persisted Raw authority cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const selectedSkills = [...(manifest.targetSkills || []), ...(manifest.contextSkills || [])];
  const activeSkills = manifest.activeSkills || [];
  if (!Array.isArray(manifest.activeSkills) || activeSkills.some((skill) => typeof skill?.id !== "string" || !skill.id || !SHA256.test(skill.bundleDigest || ""))) blockers.push("Run manifest contains an invalid active Skill inventory.");
  if (new Set(activeSkills.map((skill) => skill.id)).size !== activeSkills.length) blockers.push("Run manifest contains duplicate active Skill ids.");
  if (selectedSkills.some((skill) => typeof skill?.id !== "string" || !skill.id || typeof skill.digest !== "string" || !/^[0-9a-f]{64}$/u.test(skill.digest))) blockers.push("Run manifest contains an invalid selected Skill descriptor.");
  const activeIds = activeSkills.map((skill) => skill.id).sort();
  const selectedIds = selectedSkills.map((skill) => skill.id).sort();
  if (JSON.stringify(activeIds) !== JSON.stringify(selectedIds)) blockers.push("Run manifest active Skill inventory differs from the selected target/context Skills.");
  const canonicalActiveSkills = activeSkills.map((skill) => ({ id: skill.id, bundleDigest: skill.bundleDigest })).sort((left, right) => left.id.localeCompare(right.id));
  const activeSkillSetDigest = sha256(`${JSON.stringify(canonicalActiveSkills, null, 2)}\n`);
  if (!SHA256.test(manifest.activeSkillSetDigest || "") || manifest.activeSkillSetDigest !== activeSkillSetDigest) blockers.push("Run manifest active Skill-set digest does not match its inventory.");

  const runtimeSessions = state.runtimeSessions || [];
  const phaseSplits = { baseline_validation: "val", training: "train", candidate_validation: "val", baseline_test: "test", final_test: "test" };
  const traces = visitJson(path.join(runRoot, "raw", "traces")).map(readJson);
  if (new Set(traces.map((trace) => trace.id)).size !== traces.length) blockers.push("Raw trajectories contain duplicate ids across iterations or attempts.");
  for (const trace of traces) if (phaseSplits[trace.phase] !== trace.split) blockers.push(`${trace.id}: trajectory phase ${String(trace.phase)} does not match split ${String(trace.split)}.`);
  const traceById = new Map(traces.map((trace) => [trace.id, trace]));

  const inferenceInvocations = state.inferenceInvocations || [];
  const learningInvocations = state.learningInvocations || [];
  let testPhaseStarted = false;
  for (const invocation of inferenceInvocations) {
    if (phaseSplits[invocation.phase] !== invocation.split) blockers.push(`${invocation.launchRef}: inference phase ${String(invocation.phase)} does not match split ${String(invocation.split)}.`);
    if (invocation.phase === "baseline_test" || invocation.phase === "final_test") testPhaseStarted = true;
    else if (testPhaseStarted) blockers.push(`${invocation.launchRef}: non-test inference ran after final test evaluation started.`);
  }

  let best = state.baselineValidationScore;
  for (const history of state.proposalHistory || []) {
    const improves = typeof history.candidateValidationScore === "number" && typeof best === "number" && history.candidateValidationScore > best;
    if (history.accepted !== improves) blockers.push(`Iteration ${history.iteration} acceptance does not match strict validation gain.`);
    if (history.accepted) best = history.candidateValidationScore;
    const proposal = readJson(path.join(runRoot, history.proposalPath));
    if (proposal.action !== "no_action" && (!Array.isArray(proposal.traceReads) || proposal.traceReads.length === 0)) blockers.push(`Iteration ${history.iteration} Skill-changing proposal reads no training trace.`);
    for (const traceId of proposal.traceReads || []) {
      const trace = traceById.get(traceId);
      if (!trace) blockers.push(`Proposal reads unknown trace ${traceId}.`);
      else if (trace.phase !== "training" || trace.split !== "train") blockers.push(`Proposal reads non-training trace ${traceId} (${trace.phase}/${trace.split}).`);
      else if (trace.iteration !== history.iteration || trace.attempt !== history.attempt) blockers.push(`Proposal reads trace ${traceId} from iteration/attempt ${trace.iteration}/${trace.attempt}, expected ${history.iteration}/${history.attempt}.`);
    }
  }

  if ((taskSet.tasks || []).some((task) => task.split === "test")) {
    const testInvocations = inferenceInvocations.filter((item) => item.split === "test");
    if (!testInvocations.length) blockers.push("Dataset has test tasks but the terminal run contains no test invocation.");
    for (const task of taskSet.tasks.filter((item) => item.split === "test")) {
      if (!testInvocations.some((item) => item.taskId === task.id && item.phase === "baseline_test")) blockers.push(`${task.id}: missing final baseline test invocation.`);
      if (!testInvocations.some((item) => item.taskId === task.id && item.phase === "final_test")) blockers.push(`${task.id}: missing final candidate test invocation.`);
    }
  }

  for (const field of ["baselineValidationScore", "bestValidationScore", "baselineTestScore", "testScore"]) {
    if (typeof state[field] !== "number" || !Number.isFinite(state[field]) || state[field] < 0 || state[field] > 1) blockers.push(`Run state ${field} must be a score between 0 and 1.`);
  }

  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    data: {
      runId: manifest.runId,
      status: state.status,
      activeSkillSetDigest,
      activeSkills: canonicalActiveSkills,
      runtimeSessionCount: runtimeSessions.length,
      inferenceInvocationCount: inferenceInvocations.length,
      learningInvocationCount: learningInvocations.length,
      baselineValidationScore: state.baselineValidationScore,
      bestValidationScore: state.bestValidationScore,
      baselineTestScore: state.baselineTestScore,
      testScore: state.testScore
    }
  };
};

module.exports = { auditRun };
