"use strict";

const SOURCE_SESSION_ENV_KEYS = Object.freeze([
  "CODEX_THREAD_ID",
  "HAPPY_CODEX_AUTO_ACCEPT_MCP_TOOLS",
  "WORKSPACE_ROOT",
  "JFT0M_AGENT_CONVERSATION_ID",
  "JFT0M_AGENT_TURN_ID",
  "JFT0M_AGENT_HARNESS_TRACE_ID",
  "JFT0M_AGENT_IDENTITY_MODE",
  "JFT0M_API_BASE",
  "JFT0M_CAPABILITY_SESSION_TOKEN",
  "JFT0M_CATALOG_SNAPSHOT_ID",
  "JFT0M_ENDPOINT",
  "JFT0M_EXECUTION_ATTEMPT_ID",
  "JFT0M_EXECUTION_ID",
  "JFT0M_EXECUTION_LEASE_GENERATION",
  "JFT0M_EXTERNAL_PROVIDER",
  "JFT0M_EXTERNAL_RUN_ID",
  "JFT0M_GATEWAY_FILE",
  "JFT0M_GLOBAL_MEMORY_ROOT",
  "JFT0M_INTERNAL_ENDPOINT",
  "JFT0M_MANAGED_RUN_PATH",
  "JFT0M_MEMORY_CONTEXT_ID",
  "JFT0M_MEMORY_PROJECT_ID",
  "JFT0M_MEMORY_ROOT",
  "JFT0M_MEMORY_SCOPE_ID",
  "JFT0M_MEMORY_SCOPE_TYPE",
  "JFT0M_RUN_ID",
  "JFT0M_STATE_HOME",
  "JFT0M_TURN_ID",
  "JFT0M_TURN_TOKEN",
  "JFT0M_WORKSPACE_PROJECT_ID",
  "JFT0M_WORKSPACE_ROOT",
  "JFT0M_WORKSPACE_SESSION_INDEX_PATH",
  "JFT0M_WORKSPACE_SCOPE_ID"
]);

const forbidden = new Set(SOURCE_SESSION_ENV_KEYS);

const createCleanProviderEnvironment = (baseEnvironment, ...overlays) => {
  const environment = { ...(baseEnvironment || {}) };
  for (const key of SOURCE_SESSION_ENV_KEYS) delete environment[key];
  for (const overlay of overlays) {
    for (const [key, value] of Object.entries(overlay || {})) {
      if (forbidden.has(key) && value !== undefined) {
        throw new Error(`WikiSkill Provider configuration must not define source-session environment key: ${key}`);
      }
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }
  return environment;
};

module.exports = { SOURCE_SESSION_ENV_KEYS, createCleanProviderEnvironment };
