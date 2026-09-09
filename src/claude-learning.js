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
    "你是 WikiSkill Wiki Maintainer。仅使用提供的训练证据与现有 Wiki，不得修改 Skills。可以参考 skill-impact.md 中的 validation 汇总分数、候选 diff 与接受/拒绝结果；不得读取或推测 validation/test 的任务内容、答案或执行轨迹，test 分数不参与候选选择。",
    "Return exactly one prediction object. Allowed fields are index (string), appendLog (string), patterns (array), and patternPatches (array). Omit unused fields.",
    "patterns must be an array of {name, content} objects, never an object map. patternPatches must be an array of {name, edits}; each edit is {op: append|replace|insert_after, content, target?}.",
    "Use patternPatches only when the pattern exists and every target exactly matches the supplied Existing Wiki text. Otherwise return the complete replacement in patterns; never guess a target."
  ].join("\n");
  if (role === "proposer-select") return [
    "You are the WikiSkill Skill Proposer selecting training evidence. Do not propose a Skill change in this phase.",
    "Return exactly one prediction object with one field: {traceReads:[...]}. Select at least four distinct ids from availableTraces."
  ].join("\n");
  return [
    "你是 WikiSkill Skill Proposer。仅使用提供的 Wiki、当前 Skills、训练结果与选定的训练轨迹。可以参考 skill-impact.md 中的 validation 汇总分数、候选 diff 与接受/拒绝结果；不得读取或推测 validation/test 的任务内容、答案或执行轨迹，test 分数不参与候选选择。",
    "Return exactly one prediction object with action patch, create, or no_action. For patch/create include one skillId and files object. A created Skill must include SKILL.md and PURPOSE.md; PURPOSE.md cites the supporting Wiki patterns. Update PURPOSE.md on a patch when its motivating patterns change. Modify at most one target Skill."
  ].join("\n");
};

const runRole = async (role, launchRef, config, input, workdir) => {
  const runner = createClaudeRunner(config);
  const languagePolicy = "生成过程说明及所有新生成的自然语言内容使用简体中文，包括 Wiki 标题、正文、日志、模式总结，以及 Skill 的 description、说明和步骤。代码、命令、路径、URL、稳定 ID、schema 字段和枚举、专有名称、必要原文引用及补丁匹配 target 保持原样，不得翻译机器合同或改变匹配语义。";
  const result = await runner({ systemPrompt: `${languagePolicy}\n\n${systemPromptFor(role)}`, input, workdir, tools: [], model: modelFor(config), predictionSchema: schemaFor(role), launchRef, providerRole: role });
  const response = result.prediction;
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error(`WikiSkill Claude ${role} must return one response object as prediction.`);
  return { response, provider: result.provider };
};

const createMaintainer = (config = {}) => async (input) => {
  const launchRef = `learning:${input.attempt}:${input.iteration}:maintainer`;
  const turn = await runRole("maintainer", launchRef, config, {
    iteration: input.iteration,
    existingWiki: input.existingWiki,
    sampledTraces: input.sampledTraces
  }, input.wikiRoot);
  const response = turn.response;
  await input.recordInvocation?.({ schema: "wikiskill.learning-invocation.v1", launchRef, role: "maintainer", provider: turn.provider });
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
  const selectionLaunchRef = `learning:${input.attempt}:${input.iteration}:proposer-select`;
  const selectionTurn = await runRole("proposer-select", selectionLaunchRef, config, {
    phase: "select-training-trajectories",
    instruction: "Return prediction {traceReads:[...]} with at least four distinct ids selected from availableTraces. Do not propose a Skill change yet.",
    wiki: input.wiki,
    skills: input.skills,
    allowedNewSkillIds: input.allowedNewSkillIds || [],
    training: input.training,
    availableTraces: input.availableTraces
  }, input.wikiRoot);
  const selection = selectionTurn.response;
  await input.recordInvocation?.({ schema: "wikiskill.learning-invocation.v1", launchRef: selectionLaunchRef, role: "proposer-select", provider: selectionTurn.provider });
  if (Object.keys(selection).some((key) => key !== "traceReads")) throw new Error("WikiSkill Claude proposer selection returned an unknown field.");
  if (!Array.isArray(selection.traceReads)) throw new Error("WikiSkill Claude proposer selection must return traceReads.");
  const selected = [...new Set(selection.traceReads)];
  const available = new Set(input.availableTraces.map((trace) => trace.id));
  if (selected.length < Math.min(4, input.availableTraces.length) || selected.some((id) => !available.has(id))) throw new Error("WikiSkill Claude proposer selected invalid training traces.");
  const traces = selected.map((id) => ({ id, trace: input.readTrace(id) }));
  const proposalLaunchRef = `learning:${input.attempt}:${input.iteration}:proposer`;
  const proposalTurn = await runRole("proposer", proposalLaunchRef, config, {
    phase: "propose-skill-change",
    iteration: input.iteration,
    wiki: input.wiki,
    skills: input.skills,
    allowedNewSkillIds: input.allowedNewSkillIds || [],
    training: input.training,
    traceReads: traces
  }, input.wikiRoot);
  const response = proposalTurn.response;
  await input.recordInvocation?.({ schema: "wikiskill.learning-invocation.v1", launchRef: proposalLaunchRef, role: "proposer", provider: proposalTurn.provider });
  const allowed = new Set(["action", "skillId", "files"]);
  if (Object.keys(response).some((key) => !allowed.has(key))) throw new Error("WikiSkill Claude proposer returned an unknown field.");
  if (typeof response.action !== "string") throw new Error("WikiSkill Claude proposer response is missing action.");
  return { ...response, traceReads: selected };
};

module.exports = { createMaintainer, createProposer };
