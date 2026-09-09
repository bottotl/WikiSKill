"use strict";

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const validateCommandExitInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema !== "wikiskill.scorer.command-exit.v1") {
    throw new Error("builtin:command-exit-v1 requires wikiskill.scorer.command-exit.v1 privateInput.");
  }
  const allowed = new Set(["schema", "command", "timeoutMs", "allowedPaths"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("command-exit scorer privateInput contains an unknown field.");
  if (!Array.isArray(input.command) || input.command.length === 0 || input.command.some((value) => typeof value !== "string" || !value)) {
    throw new Error("command-exit scorer command must be a non-empty string array.");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error("command-exit scorer timeoutMs must be between 1000 and 600000.");
  const allowedPaths = input.allowedPaths ?? [];
  if (!Array.isArray(allowedPaths) || allowedPaths.some((value) => typeof value !== "string" || !value || path.isAbsolute(value) || path.posix.normalize(value.replaceAll("\\", "/")) !== value.replaceAll("\\", "/") || value.startsWith("../"))) {
    throw new Error("command-exit scorer allowedPaths must contain safe relative paths.");
  }
  return { command: [...input.command], timeoutMs, allowedPaths: [...new Set(allowedPaths)] };
};

const changedPaths = (workdir) => {
  const result = spawnSync("git", ["-C", workdir, "status", "--porcelain=v1", "-z"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("command-exit scorer requires an isolated Git checkout.");
  const records = result.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/u.test(status) && records[index + 1]) paths.push(records[++index]);
  }
  return paths.sort();
};

const terminate = (child, signal) => {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited.
    }
  }
  try { child.kill(signal); } catch { /* Process already exited. */ }
};

const run = ({ command, timeoutMs, workdir, environment = {} }) => new Promise((resolve, reject) => {
  const overrides = environment && typeof environment === "object" && !Array.isArray(environment) ? environment : {};
  const childEnvironment = { ...process.env, ...overrides };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawn(command[0], command.slice(1), {
    cwd: workdir,
    env: childEnvironment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let timedOut = false;
  let exceeded = false;
  let settled = false;
  let killTimer;
  const append = (chunk, stream) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) {
      exceeded = true;
      terminate(child, "SIGTERM");
      killTimer ||= setTimeout(() => terminate(child, "SIGKILL"), 500);
      return;
    }
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child, "SIGTERM");
    killTimer = setTimeout(() => terminate(child, "SIGKILL"), 500);
  }, timeoutMs);
  child.stdout.on("data", (chunk) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk) => append(chunk, "stderr"));
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    reject(error);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    resolve({ code, signal, stdout, stderr, timedOut, exceeded });
  });
});

const createCommandExitScorer = () => async ({ privateInput, workdir, environment }) => {
  const plan = validateCommandExitInput(privateInput);
  const result = await run({ ...plan, workdir, environment });
  const changes = changedPaths(workdir);
  const disallowedPaths = plan.allowedPaths.length ? changes.filter((value) => !plan.allowedPaths.includes(value)) : [];
  const passed = result.code === 0 && !result.timedOut && !result.exceeded && disallowedPaths.length === 0;
  return {
    score: passed ? 1 : 0,
    evidence: {
      command: plan.command,
      changedPaths: changes,
      disallowedPaths,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      outputExceeded: result.exceeded,
      stdout: result.stdout,
      stderr: result.stderr
    }
  };
};

module.exports = { createCommandExitScorer, validateCommandExitInput };
