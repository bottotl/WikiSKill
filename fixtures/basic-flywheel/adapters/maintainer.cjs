"use strict";

module.exports = async ({ iteration, sampledTraces, existingWiki, writePattern, appendLog }) => {
  const passed = sampledTraces.filter((trace) => trace.score === 1).length;
  const previous = existingWiki.patterns["trajectory-outcomes.md"] || "# Trajectory Outcomes\n";
  writePattern("trajectory-outcomes.md", `${previous}\n- Iteration ${iteration}: ${passed}/${sampledTraces.length} sampled traces passed.\n`);
  appendLog(`Maintainer recorded iteration ${iteration} training outcomes.`);
};
