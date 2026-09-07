"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCleanProviderEnvironment } = require("./clean-environment");

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const PREDICTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prediction"],
  properties: { prediction: {} }
};
const JSONL_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error"
]);

const parseJsonLines = (stdout) => stdout.trim().split("\n").filter(Boolean).map((line, index) => {
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw new Error(`Codex runner returned invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || !JSONL_EVENT_TYPES.has(record.type)) {
    throw new Error(`Unsupported Codex JSONL event type: ${String(record?.type)}`);
  }
  return record;
});

const validateTranscript = (records) => {
  const threads = records.filter((record) => record.type === "thread.started");
  if (records[0]?.type !== "thread.started" || threads.length !== 1 || typeof threads[0].thread_id !== "string" || !threads[0].thread_id.trim()) {
    throw new Error("Codex runner requires exactly one leading thread.started event with thread_id.");
  }
  const starts = records.filter((record) => record.type === "turn.started");
  if (starts.length !== 1 || records.indexOf(starts[0]) <= 0) throw new Error("Codex runner requires exactly one turn.started event after thread.started.");
  const terminals = records.filter((record) => record.type === "turn.completed" || record.type === "turn.failed");
  if (terminals.length !== 1 || records.at(-1) !== terminals[0]) {
    const providerError = records.findLast((record) => record.type === "error");
    if (providerError) throw new Error(`Codex error without a terminal turn: ${typeof providerError.message === "string" ? providerError.message : "unknown error"}`);
    throw new Error("Codex runner requires exactly one final turn.completed or turn.failed event.");
  }
  return { thread: threads[0], terminal: terminals[0] };
};

const runnerError = (message, diagnostics) => {
  const error = new Error(message);
  error.wikiskillDiagnostics = diagnostics;
  return error;
};

const signalProcessGroup = (child, signal) => {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have exited or failed before its process group was created.
    }
  }
  try { child.kill(signal); } catch { /* The process is already gone. */ }
};

const executeCodex = ({ executable, args, workdir, env, prompt, timeoutMs, abortSignal }) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(executable, args, {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
  } catch (error) {
    reject(error);
    return;
  }
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let termination;
  let settled = false;
  let killTimer;
  const diagnostics = (code, signal) => ({
    stdout,
    stderr,
    timedOut: termination?.kind === "timeout",
    aborted: termination?.kind === "abort",
    ...(typeof code === "number" ? { exitCode: code } : {}),
    ...(typeof signal === "string" ? { signal } : {})
  });
  const cleanup = () => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    abortSignal?.removeEventListener("abort", abort);
  };
  const terminate = (kind, message) => {
    if (termination) return;
    termination = { kind, message };
    signalProcessGroup(child, "SIGTERM");
    killTimer = setTimeout(() => {
      signalProcessGroup(child, "SIGKILL");
      killTimer = undefined;
    }, KILL_GRACE_MS);
  };
  const abort = () => terminate("abort", "Codex runner aborted.");
  const timeout = setTimeout(() => terminate("timeout", `Codex runner timed out after ${timeoutMs}ms.`), timeoutMs);
  const append = (chunk, stream) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      terminate("output", "Codex runner output exceeded 2 MiB.");
      return;
    }
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  if (abortSignal?.aborted) abort();
  child.stdout.on("data", (chunk) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk) => append(chunk, "stderr"));
  child.stdin.on("error", () => {});
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (termination) reject(runnerError(termination.message, diagnostics(code, signal)));
    else resolve({ code, signal, stdout, stderr });
  });
  child.stdin.end(prompt);
});

const createCodexRunner = (config = {}) => {
  const executable = typeof config.executable === "string" && config.executable.trim() ? config.executable.trim() : "codex";
  const executableArgs = config.executableArgs === undefined ? [] : config.executableArgs;
  const timeoutMs = config.timeoutMs ?? 300_000;
  if (!Array.isArray(executableArgs) || executableArgs.some((value) => typeof value !== "string")) throw new Error("Codex runner executableArgs must be a string array.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("Codex runner timeoutMs must be an integer of at least 1000 milliseconds.");

  return async ({ systemPrompt, input, workdir, tools, model, abortSignal, environment, predictionSchema }) => {
    if (!model || typeof model.id !== "string" || !model.id.trim()) throw new Error("Codex runner requires a model id.");
    if (!Array.isArray(tools) || tools.some((tool) => tool !== "workspace")) throw new Error("Codex runner tools must be empty or workspace.");
    const taskTimeoutMs = tools.includes("workspace") && config.timeoutMs === undefined ? 600_000 : timeoutMs;
    if (abortSignal?.aborted) throw new Error("Codex runner aborted before launch.");
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-runner-"));
    const schemaPath = path.join(temporaryRoot, "prediction.schema.json");
    const outputPath = path.join(temporaryRoot, "prediction.json");
    await fs.writeFile(schemaPath, JSON.stringify({ ...PREDICTION_SCHEMA, properties: { prediction: predictionSchema || {} } }));
    const args = [
      ...executableArgs, "exec", "--ephemeral", "--skip-git-repo-check",
      ...(tools.includes("workspace") ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "read-only"]), "--json",
      "-C", workdir, "--output-schema", schemaPath, "-o", outputPath,
      "-m", model.id.trim(), "-"
    ];
    const prompt = [
      String(systemPrompt || ""),
      "Task input:",
      JSON.stringify(input),
      "Return one structured prediction. Do not include private evaluation assumptions."
    ].filter(Boolean).join("\n\n");

    try {
      if (abortSignal?.aborted) throw new Error("Codex runner aborted before launch.");
      const result = await executeCodex({
        executable,
        args,
        workdir,
        env: createCleanProviderEnvironment(process.env, environment, config.env),
        prompt,
        timeoutMs: taskTimeoutMs,
        abortSignal
      });
      let records;
      let transcript;
      try {
        records = result.stdout.trim() ? parseJsonLines(result.stdout) : [];
        transcript = records.length ? validateTranscript(records) : null;
      } catch (error) {
        throw runnerError(error instanceof Error ? error.message : String(error), { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, signal: result.signal });
      }
      if (transcript?.terminal.type === "turn.failed") {
        const exit = result.code === 0 ? "" : ` (process exited with code ${result.code ?? "null"})`;
        throw runnerError(`Codex turn failed: ${typeof transcript.terminal.error?.message === "string" ? transcript.terminal.error.message : "unknown failure"}${exit}`, { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, signal: result.signal });
      }
      if (result.code !== 0) throw runnerError(`Codex runner exited with code ${result.code ?? "null"}: ${result.stderr.trim()}`, { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, signal: result.signal });
      if (!transcript || transcript.terminal.type !== "turn.completed") throw new Error("Codex runner result does not match the verified JSONL completion contract.");
      let structured;
      try {
        structured = JSON.parse(await fs.readFile(outputPath, "utf8"));
      } catch {
        throw new Error("Codex runner final output does not match the prediction schema.");
      }
      if (!structured || typeof structured !== "object" || Array.isArray(structured) || Object.keys(structured).length !== 1 || !Object.hasOwn(structured, "prediction")) {
        throw new Error("Codex runner final output does not match the prediction schema.");
      }
      const events = records.flatMap((record) => {
        if (record.type !== "item.completed") return [];
        if (record.item?.type === "agent_message" && typeof record.item.text === "string") return [{ type: "assistant", text: record.item.text }];
        if (record.item?.type === "command_execution" && typeof record.item.command === "string") return [
          { type: "tool_call", tool: "shell", input: { command: record.item.command } },
          { type: "tool_result", tool: "shell", output: String(record.item.aggregated_output || ""), exitCode: record.item.exit_code ?? null }
        ];
        return [];
      });
      return {
        prediction: structured.prediction,
        events,
        provider: { ref: "provider:codex", modelId: model.id.trim(), threadId: transcript.thread.thread_id }
      };
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  };
};

module.exports = { createCodexRunner };
