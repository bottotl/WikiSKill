"use strict";

module.exports = async ({ availableTraces, readTrace }) => {
  const traceReads = availableTraces.slice(0, 4).map(({ id }) => id);
  for (const id of traceReads) readTrace(id);
  return { action: "no_action", traceReads };
};
