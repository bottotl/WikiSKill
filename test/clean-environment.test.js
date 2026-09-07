"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCleanProviderEnvironment } = require("../src/clean-environment");

test("removes source-session bindings from the inherited Provider environment", () => {
  const clean = createCleanProviderEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CODEX_THREAD_ID: "source-thread",
    HAPPY_CODEX_AUTO_ACCEPT_MCP_TOOLS: "jft0m-capability-bridge.profile.delegate",
    WORKSPACE_ROOT: "/tmp/source-workspace",
    JFT0M_AGENT_CONVERSATION_ID: "source-conversation",
    JFT0M_AGENT_TURN_ID: "source-turn",
    JFT0M_AGENT_HARNESS_TRACE_ID: "source-trace",
    JFT0M_CAPABILITY_SESSION_TOKEN: "source-token",
    JFT0M_MANAGED_RUN_PATH: "/tmp/source-run.json",
    JFT0M_GATEWAY_FILE: "/tmp/source-gateway.json",
    JFT0M_GLOBAL_MEMORY_ROOT: "/tmp/source-global-memory",
    JFT0M_MEMORY_ROOT: "/tmp/source-memory",
    JFT0M_STATE_HOME: "/tmp/source-state",
    JFT0M_WORKSPACE_ROOT: "/tmp/source-workspace-root",
    JFT0M_WORKSPACE_SESSION_INDEX_PATH: "/tmp/source-session-index.sqlite"
  });
  assert.deepEqual(clean, { PATH: "/usr/bin", HOME: "/tmp/home" });
});

test("rejects an overlay that tries to restore a source-session binding", () => {
  assert.throws(() => createCleanProviderEnvironment(
    { PATH: "/usr/bin", JFT0M_AGENT_CONVERSATION_ID: "inherited" },
    { SAFE_TASK_VALUE: "allowed" },
    { WORKSPACE_ROOT: "/tmp/restored-workspace" }
  ), /must not define source-session environment key/u);
});

test("preserves ordinary Provider credentials and explicit task environment", () => {
  assert.deepEqual(createCleanProviderEnvironment(
    { PATH: "/usr/bin", PROVIDER_API_KEY: "secret" },
    { TASK_FIXTURE: "one" },
    { RUNNER_OPTION: "two" }
  ), { PATH: "/usr/bin", PROVIDER_API_KEY: "secret", TASK_FIXTURE: "one", RUNNER_OPTION: "two" });
});
