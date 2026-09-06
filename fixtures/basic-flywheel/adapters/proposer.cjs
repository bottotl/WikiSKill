"use strict";

module.exports = async ({ availableTraces, readTrace, training, skills }) => {
  const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
  const traces = Object.fromEntries(traceReads.map((id) => [id, readTrace(id)]));
  const current = skills.target["target-skill"]["SKILL.md"];
  const known = new Map([...current.matchAll(/^- ([a-z-]+) => (\S+)$/gmu)].map((match) => [match[1], match[2]]));
  const examples = new Map();
  for (const outcome of training) {
    const trace = traces[outcome.trajectoryId];
    const observation = trace?.events.find((event) => event.type === "observation");
    const category = JSON.parse(observation.text).category;
    const expected = JSON.parse(outcome.groundTruthSummary).expected;
    examples.set(category, expected);
  }
  const next = [...examples].filter(([category]) => !known.has(category)).sort(([left], [right]) => left.localeCompare(right))[0];
  if (!next) return { action: "no_action", traceReads };
  known.set(next[0], next[1]);
  const rules = [...known].sort(([left], [right]) => left.localeCompare(right)).map(([category, value]) => `- ${category} => ${value}`).join("\n");
  return {
    action: "patch",
    skillId: "target-skill",
    traceReads,
    files: {
      "SKILL.md": `---\nname: target-skill\ndescription: Apply only evidence-derived category mappings.\n---\n\nReturn the mapped value for the task category. Return UNKNOWN when no mapping is listed.\n\n## Rules\n${rules}\n`
    }
  };
};
