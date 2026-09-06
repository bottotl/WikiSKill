"use strict";

module.exports = {
  prepareEnvironment: async ({ workdir }) => workdir,
  renderTask: ({ task }) => task.input,
  resolveTools: () => [],
  extractPrediction: ({ result }) => result.prediction,
  score: ({ prediction, groundTruth }) => ({
    score: prediction.value === groundTruth.expected ? 1 : 0,
    evidence: { matched: prediction.value === groundTruth.expected }
  }),
  disposeEnvironment: async () => undefined
};
