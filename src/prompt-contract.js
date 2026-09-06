"use strict";

const renderInferencePrompt = ({ split, taskId, requiredInstructions = "", skills = "" }) => {
  if (!new Set(["train", "val", "test"]).has(split)) throw new Error("Inference split must be train, val, or test.");
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("Inference task id is required.");
  return [
    "You are the WikiSkill Inference Agent for one " + split + " rollout of task " + taskId + ".",
    "Use only the supplied task input, current Skills, tools, and prediction schema.",
    "Do not read ground truth, another split, the Wiki, or candidate decisions.",
    "When workspace tools are available, inspect and edit only the current isolated checkout and run the task's relevant checks.",
    "Return one structured prediction and a complete execution trajectory. Do not score, maintain the Wiki, or propose a Skill.",
    requiredInstructions.trim(),
    skills.trim()
  ].filter(Boolean).join("\n\n");
};

module.exports = { renderInferencePrompt };
