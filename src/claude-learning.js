"use strict";

const { createClaudeRunner } = require("./claude-runner");

const modelFor = (config) => {
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("WikiSkill Claude learning requires a frozen model id.");
  return { id: config.model.trim() };
};

const MAINTAINER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "string" },
    appendLog: { type: "string" },
    patterns: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "content"], properties: { name: { type: "string" }, content: { type: "string" } } } },
    patternPatches: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "edits"], properties: {
      name: { type: "string" },
      edits: { type: "array", items: { type: "object", additionalProperties: false, required: ["op", "content"], properties: { op: { enum: ["append", "replace", "insert_after"] }, content: { type: "string" }, target: { type: "string" } } } }
    } } }
  }
};
const PROPOSER_SELECTION_SCHEMA = { type: "object", additionalProperties: false, required: ["traceReads"], properties: { traceReads: { type: "array", minItems: 4, uniqueItems: true, items: { type: "string" } } } };
const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { enum: ["patch", "create", "no_action"] },
    skillId: { type: "string" },
    files: { type: "object", additionalProperties: { type: "string" } }
  }
};

const schemaFor = (role) => role === "maintainer" ? MAINTAINER_SCHEMA : role === "proposer-select" ? PROPOSER_SELECTION_SCHEMA : PROPOSAL_SCHEMA;

const systemPromptFor = (role) => {
  if (role === "maintainer") return [
    "You are the WikiSkill Wiki Maintainer. Use only the supplied training evidence and existing Wiki. Never modify Skills or infer validation/test data.",
    "Return exactly one prediction object. Allowed fields are index (string), appendLog (string), patterns (array), and patternPatches (array). Omit unused fields.",
    "patterns must be an array of {name, content} objects, never an object map. patternPatches must be an array of {name, edits}; each edit is {op: append|replace|insert_after, content, target?}.",
    "Use patternPatches only when the pattern exists and every target exactly matches the supplied Existing Wiki text. Otherwise return the complete replacement in patterns; never guess a target."
  ].join("\n");
  if (role === "proposer-select") return [
    "You are the WikiSkill Skill Proposer selecting training evidence. Do not propose a Skill change in this phase.",
    "Return exactly one prediction object with one field: {traceReads:[...]}. Select at least four distinct ids from availableTraces."
  ].join("\n");
  return [
    "You are the WikiSkill Skill Proposer. Use only the supplied Wiki, current Skills, training outcomes, and selected training traces. Never infer validation/test data.",
    "Return exactly one prediction object with action patch, create, or no_action. For patch/create include one skillId and files object. Modify at most one target Skill."
  ].join("\n");
};

const runRole = async (role, config, input, workdir) => {
  const runner = createClaudeRunner(config);
  const result = await runner({ systemPrompt: systemPromptFor(role), input, workdir, tools: [], model: modelFor(config), predictionSchema: schemaFor(role) });
  const response = result.prediction;
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error(`WikiSkill Claude ${role} must return one response object as prediction.`);
  return response;
};

const createMaintainer = (config = {}) => async (input) => {
  const response = await runRole("maintainer", config, {
    iteration: input.iteration,
    existingWiki: input.existingWiki,
    sampledTraces: input.sampledTraces
  }, input.wikiRoot);
  const allowed = new Set(["index", "appendLog", "patterns", "patternPatches"]);
  if (Object.keys(response).some((key) => !allowed.has(key))) throw new Error("WikiSkill Claude maintainer returned an unknown field.");
  if (response.index !== undefined && typeof response.index !== "string") throw new Error("WikiSkill Claude maintainer index must be text.");
  if (response.appendLog !== undefined) {
    if (typeof response.appendLog !== "string") throw new Error("WikiSkill Claude maintainer appendLog must be text.");
    input.appendLog(response.appendLog);
  }
  if (response.patterns !== undefined) {
    if (!Array.isArray(response.patterns)) throw new Error("WikiSkill Claude maintainer patterns must be an array.");
    for (const pattern of response.patterns) {
      if (!pattern || typeof pattern.name !== "string" || typeof pattern.content !== "string") throw new Error("WikiSkill Claude maintainer pattern is invalid.");
      input.writePattern(pattern.name, pattern.content);
    }
  }
  if (response.patternPatches !== undefined) {
    if (!Array.isArray(response.patternPatches)) throw new Error("WikiSkill Claude maintainer patternPatches must be an array.");
    for (const patch of response.patternPatches) {
      if (!patch || typeof patch.name !== "string" || !Array.isArray(patch.edits)) throw new Error("WikiSkill Claude maintainer pattern patch is invalid.");
      input.patchPattern(patch.name, patch.edits);
    }
  }
  return response.index === undefined ? undefined : { index: response.index };
};

const createProposer = (config = {}) => async (input) => {
  const selection = await runRole("proposer-select", config, {
    phase: "select-training-trajectories",
    instruction: "Return prediction {traceReads:[...]} with at least four distinct ids selected from availableTraces. Do not propose a Skill change yet.",
    wiki: input.wiki,
    skills: input.skills,
    allowedNewSkillIds: input.allowedNewSkillIds || [],
    training: input.training,
    availableTraces: input.availableTraces
  }, input.wikiRoot);
  if (Object.keys(selection).some((key) => key !== "traceReads")) throw new Error("WikiSkill Claude proposer selection returned an unknown field.");
  if (!Array.isArray(selection.traceReads)) throw new Error("WikiSkill Claude proposer selection must return traceReads.");
  const selected = [...new Set(selection.traceReads)];
  const available = new Set(input.availableTraces.map((trace) => trace.id));
  if (selected.length < Math.min(4, input.availableTraces.length) || selected.some((id) => !available.has(id))) throw new Error("WikiSkill Claude proposer selected invalid training traces.");
  const traces = selected.map((id) => ({ id, trace: input.readTrace(id) }));
  const response = await runRole("proposer", config, {
    phase: "propose-skill-change",
    iteration: input.iteration,
    wiki: input.wiki,
    skills: input.skills,
    allowedNewSkillIds: input.allowedNewSkillIds || [],
    training: input.training,
    traceReads: traces
  }, input.wikiRoot);
  const allowed = new Set(["action", "skillId", "files"]);
  if (Object.keys(response).some((key) => !allowed.has(key))) throw new Error("WikiSkill Claude proposer returned an unknown field.");
  if (typeof response.action !== "string") throw new Error("WikiSkill Claude proposer response is missing action.");
  return { ...response, traceReads: selected };
};

module.exports = { createMaintainer, createProposer };
