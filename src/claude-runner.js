"use strict";

const { spawn } = require("node:child_process");
const { createCleanProviderEnvironment } = require("./clean-environment");

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CODING_OUTPUT_BYTES = 32 * 1024 * 1024;
const outputSchema = (predictionSchema = { type: "string" }) => JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["prediction"],
  properties: { prediction: predictionSchema }
});
const parseJsonLines = (value) => value.trim().split(/\r?\n/u).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`Claude runner returned invalid stream JSON at line ${index + 1}.`); }
});
const runnerError = (message, diagnostics) => {
  const error = new Error(message);
  error.wikiskillDiagnostics = diagnostics;
  return error;
};

const streamEvents = (records) => records.flatMap((record) => {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];
  if (record.type === "assistant") return content.flatMap((item) => {
    if (item?.type === "text" && typeof item.text === "string") return [{ type: "assistant", text: item.text }];
    if (item?.type === "tool_use" && typeof item.name === "string") return [{ type: "tool_call", tool: item.name, input: item.input ?? null }];
    return [];
  });
  if (record.type === "user") return content.flatMap((item) => item?.type === "tool_result"
    ? [{ type: "tool_result", toolUseId: item.tool_use_id ?? null, output: typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? null), isError: item.is_error === true }]
    : []);
  return [];
});

const createClaudeRunner = (config = {}) => {
  const executable = typeof config.executable === "string" && config.executable.trim() ? config.executable.trim() : "claude";
  const executableArgs = config.executableArgs === undefined ? [] : config.executableArgs;
  const timeoutMs = config.timeoutMs ?? 300_000;
  if (!Array.isArray(executableArgs) || executableArgs.some((item) => typeof item !== "string")) throw new Error("Claude runner executableArgs must be a string array.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("Claude runner timeoutMs must be an integer of at least 1000 milliseconds.");
  const run = ({ systemPrompt, input, workdir, tools, model, abortSignal, environment, predictionSchema, launchRef, providerRole = "inference", preparedIsolation }) => new Promise((resolve, reject) => {
    if (!model || typeof model.id !== "string" || !model.id.trim()) return reject(new Error("Claude runner requires a model id."));
    if (!Array.isArray(tools) || tools.some((tool) => tool !== "workspace")) return reject(new Error("Claude runner tools must be empty or workspace."));
    if (abortSignal?.aborted) return reject(new Error("Claude runner aborted before launch."));
    const development = tools.includes("workspace");
    const prompt = [
      `Task input:\n${JSON.stringify(input)}`,
      ...(development ? ["Finish with a best-effort patch and structured result. When public tests are absent, use the repository evidence and available checks instead of waiting for hidden evaluation details."] : []),
      "Return one structured prediction. Do not include private evaluation assumptions."
    ].join("\n");
    const maxOutputBytes = development ? MAX_CODING_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    const taskTimeoutMs = development && config.timeoutMs === undefined ? 600_000 : timeoutMs;
    const permissionArgs = development && config.readOnly !== true ? ["--dangerously-skip-permissions"] : ["--permission-mode", "dontAsk"];
    const toolList = development ? config.readOnly === true ? "Read,Glob,Grep" : "Bash,Edit,Read,Glob,Grep,Write" : "";
    const args = [...executableArgs, "-p", prompt, "--output-format", development ? "stream-json" : "json", ...(development ? ["--verbose"] : []), "--json-schema", outputSchema(predictionSchema), "--append-system-prompt", systemPrompt, "--model", model.id.trim(), ...(config.reasoningEffort ? ["--effort", config.reasoningEffort] : []), "--tools", toolList, ...permissionArgs, "--no-session-persistence"];
    let providerEnvironment;
    try {
      providerEnvironment = createCleanProviderEnvironment(process.env, environment, config.env);
    } catch (error) {
      return reject(error);
    }
    try {
      config.providerLaunchBudget?.consume({ launchRef, role: providerRole, provider: "claude", modelId: model.id.trim(), reasoningEffort: config.reasoningEffort, executable, args });
    } catch (error) {
      return reject(error);
    }
    const child = spawn(preparedIsolation ? "/usr/bin/sandbox-exec" : executable, preparedIsolation ? ["-f", preparedIsolation.profilePath, preparedIsolation.binary, ...args] : args, { cwd: workdir, env: preparedIsolation?.environment ?? providerEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback) => { if (!settled) { settled = true; clearTimeout(timeout); abortSignal?.removeEventListener("abort", abort); callback(); } };
    const append = (chunk, stream) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { child.kill("SIGTERM"); finish(() => reject(runnerError(`Claude runner output exceeded ${development ? "32" : "2"} MiB.`, { stdout, stderr, outputExceeded: true, timedOut: false }))); return; }
      if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    const abort = () => child.kill("SIGTERM");
    const timeout = setTimeout(() => { child.kill("SIGTERM"); finish(() => reject(runnerError(`Claude runner timed out after ${taskTimeoutMs}ms.`, { stdout, stderr, outputExceeded: false, timedOut: true }))); }, taskTimeoutMs);
    abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (abortSignal?.aborted) return reject(runnerError("Claude runner aborted.", { stdout, stderr, exitCode: code, aborted: true }));
      if (code !== 0) return reject(runnerError(`Claude runner exited with code ${code ?? "null"}: ${stderr.trim()}`, { stdout, stderr, exitCode: code }));
      let result;
      let events;
      try {
        if (development) {
          const records = parseJsonLines(stdout);
          result = records.findLast((record) => record.type === "result");
          events = streamEvents(records);
        } else {
          result = JSON.parse(stdout);
          events = [{ type: "assistant", text: typeof result.result === "string" ? result.result : "" }];
        }
      } catch (error) { return reject(new Error(`Claude runner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)); }
      if (result?.subtype !== "success" || result.is_error !== false || result.terminal_reason !== "completed" || typeof result.session_id !== "string" || !result.structured_output || typeof result.structured_output !== "object" || !Object.hasOwn(result.structured_output, "prediction")) return reject(new Error("Claude runner result does not match the verified structured output contract."));
      return resolve({ ...(preparedIsolation ? { isolationEvidence: preparedIsolation.isolationEvidence } : {}), prediction: result.structured_output.prediction, ...(result.usage ? { usage: result.usage } : {}), events, provider: { ref: "provider:claude", modelId: model.id.trim(), sessionId: result.session_id } });
    }));
  });
  return async input => {
    if (!input.isolation) return run(input);
    const fs = require("node:fs/promises"); const path = require("node:path");
    const temporaryRoot = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "wikiskill-claude-isolated-"));
    try {
      const prepared = await require("./inference-isolation").prepareIsolatedCommand({ executable, args: [], workdir: input.workdir, environment: createCleanProviderEnvironment(process.env, input.environment, config.env), isolation: input.isolation, temporaryRoot, provider: "claude" });
      return await run({ ...input, preparedIsolation: { profilePath: prepared.args[1], binary: prepared.args[2], environment: prepared.environment, isolationEvidence: prepared.isolationEvidence } });
    } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }); }
  };
};

module.exports = { createClaudeRunner };
