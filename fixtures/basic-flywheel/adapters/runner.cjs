"use strict";

module.exports = async ({ task, skills }) => ({
  prediction: {
    value: skills.target["target-skill"]["SKILL.md"].includes("improved")
      ? "improved"
      : "old"
  },
  events: [
    { type: "observation", text: task.id },
    { type: "assistant", text: "fixture completed" }
  ]
});
