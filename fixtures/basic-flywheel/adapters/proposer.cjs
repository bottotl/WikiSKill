"use strict";

module.exports = async ({ availableTraces, readTrace }) => {
  const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
  traceReads.forEach(readTrace);
  return {
    action: "patch",
    skillId: "target-skill",
    traceReads,
    files: {
      "SKILL.md": "---\nname: target-skill\ndescription: Deterministic fixture target.\n---\n\nUse the improved procedure.\n"
    }
  };
};
