"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCodexRunner } = require("../src/codex-runner");

const waitForFile = async (target, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(target).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for readiness marker: ${target}`);
};

test("Codex runner executes a tool-free task with a frozen model and returns the structured prediction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-runner-"));
  const workdir = path.join(root, "workdir");
  const capturePath = path.join(root, "capture.json");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  const schemaPath = valueAfter("--output-schema");
  const outputPath = valueAfter("-o");
  fs.writeFileSync(process.env.WIKISKILL_TEST_CAPTURE, JSON.stringify({ args, prompt, schema: JSON.parse(fs.readFileSync(schemaPath, "utf8")), schemaPath, outputPath, cwd: process.cwd() }));
  fs.writeFileSync(outputPath, JSON.stringify({ prediction: { value: "answer" } }));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-123" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "done" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\\n");
});

`);

  const runner = createCodexRunner({
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 10_000,
    env: { WIKISKILL_TEST_CAPTURE: capturePath }
  });
  const result = await runner({
    systemPrompt: "SYSTEM SKILL",
    input: { request: "solve" },
    workdir,
    tools: [],
    model: { id: "frozen-model" },
    predictionSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } }
  });

  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
  assert.deepEqual(capture.args, [
    "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json",
    "-C", workdir, "--output-schema", capture.schemaPath, "-o", capture.outputPath,
    "-m", "frozen-model", "-"
  ]);
  assert.match(capture.prompt, /SYSTEM SKILL/u);
  assert.match(capture.prompt, /\{"request":"solve"\}/u);
  assert.deepEqual(capture.schema.required, ["prediction"]);
  assert.deepEqual(capture.schema.properties.prediction.required, ["value"]);
  assert.equal(await fs.realpath(capture.cwd), await fs.realpath(workdir));
  assert.deepEqual(result.prediction, { value: "answer" });
  assert.deepEqual(result.provider, { ref: "provider:codex", modelId: "frozen-model", threadId: "thread-123" });
  assert.equal(result.events.some((event) => event.type === "assistant" && event.text === "done"), true);
  await assert.rejects(fs.access(capture.schemaPath));
  await assert.rejects(fs.access(capture.outputPath));
});

test("Codex coding mode uses workspace-write and records command events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-coding-"));
  const workdir = path.join(root, "workdir");
  const capturePath = path.join(root, "capture.json");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
let prompt = "";
process.stdin.on("data", (chunk) => prompt += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(valueAfter("-o"), JSON.stringify({prediction:{summary:"fixed"}}));
  fs.writeFileSync(process.env.WIKISKILL_TEST_CAPTURE, JSON.stringify({args, prompt}));
  for (const record of [
    {type:"thread.started",thread_id:"coding-thread"},
    {type:"turn.started"},
    {type:"item.completed",item:{id:"cmd",type:"command_execution",command:"node --test",aggregated_output:"ok",exit_code:0,status:"completed"}},
    {type:"item.completed",item:{id:"answer",type:"agent_message",text:"fixed"}},
    {type:"turn.completed",usage:{}}
  ]) process.stdout.write(JSON.stringify(record) + "\\n");
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], env: { WIKISKILL_TEST_CAPTURE: capturePath }, timeoutMs: 10_000 });
  const result = await runner({ systemPrompt: "coding", input: { task: "fix" }, workdir, tools: ["workspace"], model: { id: "model" } });
  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
  assert.equal(capture.args.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(capture.args.includes("--sandbox"), false);
  assert.deepEqual(result.events.slice(0, 2), [
    { type: "tool_call", tool: "shell", input: { command: "node --test" } },
    { type: "tool_result", tool: "shell", output: "ok", exitCode: 0 }
  ]);
});

test("Codex runner rejects source-session environment overlays before launch", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-clean-env-"));
  const runner = createCodexRunner({
    executable: "must-not-launch",
    env: { JFT0M_AGENT_CONVERSATION_ID: "source-conversation" },
    timeoutMs: 10_000
  });
  await assert.rejects(runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "model" } }), /must not define source-session environment key/u);
});

test("Codex runner rejects JSONL schema drift instead of accepting an unknown event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-schema-drift-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(valueAfter("-o"), JSON.stringify({ prediction: "wrongly accepted" }));
  for (const record of [
    { type: "thread.started", thread_id: "thread-drift" },
    { type: "turn.started" },
    { type: "future.protocol.event" },
    { type: "turn.completed", usage: {} }
  ]) process.stdout.write(JSON.stringify(record) + "\\n");
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /unsupported Codex JSONL event type: future\.protocol\.event/iu
  );
});

test("Codex runner rejects an official turn.failed terminal event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-turn-failed-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-failed" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "model request failed" } }) + "\\n");
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /Codex turn failed: model request failed/u
  );
});

test("Codex runner accepts a completed turn after a transient reconnect error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-reconnect-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(output, JSON.stringify({prediction:{value:"recovered"}}));
  for (const record of [
    {type:"thread.started",thread_id:"thread-reconnect"},
    {type:"turn.started"},
    {type:"error",message:"Reconnecting... 1/5"},
    {type:"item.completed",item:{type:"agent_message",text:"recovered"}},
    {type:"turn.completed",usage:{}}
  ]) process.stdout.write(JSON.stringify(record) + "\\n");
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });
  const result = await runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "model" } });
  assert.deepEqual(result.prediction, { value: "recovered" });
});

test("Codex runner preserves JSONL diagnostics when reconnect has no terminal turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-reconnect-fail-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `process.stdin.resume();process.stdin.on("end",()=>{for(const record of [{type:"thread.started",thread_id:"thread"},{type:"turn.started"},{type:"error",message:"Reconnecting... 1/5"}])process.stdout.write(JSON.stringify(record)+"\\n")});\n`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });
  await assert.rejects(runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "model" } }), (error) => {
    assert.match(error.message, /error without a terminal turn/u);
    assert.match(error.wikiskillDiagnostics.stdout, /Reconnecting/u);
    assert.equal(error.wikiskillDiagnostics.exitCode, 0);
    return true;
  });
});

test("Codex runner preserves turn.failed diagnostics on a nonzero process exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-nonzero-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-nonzero" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "quota exhausted" } }) + "\\n");
  process.stderr.write("provider unavailable\\n");
  process.exitCode = 7;
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /Codex turn failed: quota exhausted \(process exited with code 7\)/u
  );
});

test("Codex runner terminates a process that exceeds its timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-timeout-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
process.stdin.resume();
process.stdin.on("end", () => setTimeout(() => process.exit(0), 1300));
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 1_000 });
  const startedAt = Date.now();

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /Codex runner timed out after 1000ms/u
  );
  assert.ok(Date.now() - startedAt < 1_250, "timeout must not wait for natural process exit");
});

test("Codex runner abort kills the process group and cleans temporary files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-abort-"));
  const workdir = path.join(root, "workdir");
  const capturePath = path.join(root, "capture.json");
  const markerPath = path.join(root, "orphan-marker");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
fs.writeFileSync(process.env.WIKISKILL_TEST_CAPTURE, JSON.stringify({ schemaPath: valueAfter("--output-schema"), outputPath: valueAfter("-o") }));
spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.env.WIKISKILL_TEST_MARKER, 'orphan'), 600)"], { stdio: "ignore" });
process.stdin.resume();
setTimeout(() => {}, 10_000);
`);
  const controller = new AbortController();
  const runner = createCodexRunner({
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 10_000,
    env: { WIKISKILL_TEST_CAPTURE: capturePath, WIKISKILL_TEST_MARKER: markerPath }
  });
  const pending = runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" }, abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  const error = await pending.then(() => null, (caught) => caught);
  assert.match(error.message, /Codex runner aborted/u);
  assert.equal(error.wikiskillDiagnostics.aborted, true);
  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
  await assert.rejects(fs.access(capture.schemaPath));
  await assert.rejects(fs.access(capture.outputPath));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(fs.access(markerPath));
});

test("Codex runner cancels SIGKILL escalation after the child closes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-close-kill-"));
  const workdir = path.join(root, "workdir");
  const readyPath = path.join(root, "survivor-ready");
  const markerPath = path.join(root, "survivor-marker");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.WIKISKILL_TEST_READY, 'ready'); setTimeout(() => { fs.writeFileSync(process.env.WIKISKILL_TEST_MARKER, 'survived'); process.exit(0); }, 600)"], { stdio: "ignore" });
process.stdin.resume();
setTimeout(() => {}, 10_000);
`);
  const controller = new AbortController();
  const runner = createCodexRunner({
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 10_000,
    env: { WIKISKILL_TEST_READY: readyPath, WIKISKILL_TEST_MARKER: markerPath }
  });
  const pending = runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" }, abortSignal: controller.signal });
  await waitForFile(readyPath);
  controller.abort();

  await assert.rejects(pending, /Codex runner aborted/u);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await fs.readFile(markerPath, "utf8"), "survived");
});

test("Codex runner rejects combined stdout and stderr above 2 MiB", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-output-limit-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("x".repeat(1024 * 1024 + 1));
  process.stderr.write("y".repeat(1024 * 1024 + 1));
  setTimeout(() => {}, 10_000);
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /Codex runner output exceeded 2 MiB/u
  );
});

test("Codex runner rejects an ambiguous thread identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-thread-id-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(valueAfter("-o"), JSON.stringify({ prediction: "ambiguous" }));
  for (const record of [
    { type: "thread.started", thread_id: "thread-one" },
    { type: "thread.started", thread_id: "thread-two" },
    { type: "turn.started" },
    { type: "turn.completed", usage: {} }
  ]) process.stdout.write(JSON.stringify(record) + "\\n");
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /exactly one leading thread\.started event/u
  );
});

test("Codex runner independently enforces the final output schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-codex-output-schema-"));
  const workdir = path.join(root, "workdir");
  const script = path.join(root, "fake-codex.cjs");
  await fs.mkdir(workdir);
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(valueAfter("-o"), JSON.stringify({ prediction: "answer", unexpected: true }));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-output-schema" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
});
`);
  const runner = createCodexRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });

  await assert.rejects(
    runner({ systemPrompt: "skill", input: {}, workdir, tools: [], model: { id: "frozen-model" } }),
    /final output does not match the prediction schema/u
  );
});
