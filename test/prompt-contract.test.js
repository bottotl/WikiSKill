"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { renderInferencePrompt } = require("../src/prompt-contract");

test("Inference Agent prompt states its actual task and information boundary", () => {
  const prompt = renderInferencePrompt({
    split: "val",
    taskId: "task-1",
    requiredInstructions: "Return the requested value.",
    skills: "## Skill: transform\nUse the documented rule."
  });
  assert.match(prompt, /Inference Agent.*val rollout.*task-1/u);
  assert.match(prompt, /Do not read ground truth, another split, the Wiki/u);
  assert.match(prompt, /Return the requested value/u);
  assert.match(prompt, /## Skill: transform/u);
});

test("Inference Agent prompt rejects an invalid split or task id", () => {
  assert.throws(() => renderInferencePrompt({ split: "holdout", taskId: "task" }), /split must be train, val, or test/u);
  assert.throws(() => renderInferencePrompt({ split: "train", taskId: "" }), /task id is required/u);
});
