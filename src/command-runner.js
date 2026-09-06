"use strict";

const { spawn } = require("node:child_process");

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const validateSpec = (spec) => {
  if (!spec || spec.id !== "command" || typeof spec.command !== "string" || !spec.command.trim()) {
    throw new Error("agentRunner must declare id=command and a non-empty command.");
  }
  if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string"))) {
    throw new Error("agentRunner.args must be an array of strings.");
  }
  if (spec.env !== undefined && (typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env) || Object.values(spec.env).some((value) => typeof value !== "string"))) {
    throw new Error("agentRunner.env must be Record<string,string>.");
  }
  return { command: spec.command, args: spec.args || [], env: spec.env || {} };
};

const createCommandRunner = (spec) => {
  const resolved = validateSpec(spec);
  return ({ systemPrompt, input, workdir, tools, model, abortSignal }) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("Agent runner aborted before launch."));
      return;
    }
    const child = spawn(resolved.command, resolved.args, {
      cwd: workdir,
      env: { ...process.env, ...resolved.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const append = (chunk, destination) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        rejectOnce(new Error("Agent runner output exceeded 10 MiB."));
        return;
      }
      if (destination === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const abort = () => child.kill("SIGTERM");
    abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.once("error", rejectOnce);
    child.once("close", (code, signal) => {
      abortSignal?.removeEventListener("abort", abort);
      if (settled) return;
      if (abortSignal?.aborted) {
        rejectOnce(new Error("Agent runner aborted."));
        return;
      }
      if (code !== 0) {
        rejectOnce(new Error(`Agent runner exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolveOnce(result);
      } catch (error) {
        rejectOnce(new Error(`Agent runner must write one JSON result to stdout: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(`${JSON.stringify({ schema: "wikiskill.agent-runner-input.v1", systemPrompt, taskInput: input, workdir, tools, model })}\n`);
  });
};

module.exports = { createCommandRunner };
