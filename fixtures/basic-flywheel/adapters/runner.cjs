"use strict";

module.exports = async ({ task, skills }) => {
  const skill = skills.target["target-skill"]["SKILL.md"];
  const mappings = Object.fromEntries([...skill.matchAll(/^- ([a-z-]+) => (\S+)$/gmu)].map((match) => [match[1], match[2]]));
  return {
    prediction: { value: mappings[task.input.category] || "UNKNOWN" },
  events: [
      { type: "observation", text: JSON.stringify(task.input) },
    { type: "assistant", text: "fixture completed" }
  ]
  };
};
