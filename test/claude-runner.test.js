"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createClaudeRunner } = require("../src/claude-runner");

test("Claude runner sends isolated task context and returns structured prediction", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-claude-runner-"));
  const canonicalWorkdir = await fs.realpath(workdir);
  const script = path.join(workdir, "fake-claude.cjs");
  await fs.writeFile(script, `const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const model = args[args.indexOf("--model") + 1];
if (!prompt.includes('"request":"read fact"') || systemPrompt !== "SYSTEM SKILL" || model !== "model-1" || process.cwd() !== ${JSON.stringify(canonicalWorkdir)} || schema.properties.prediction.required[0] !== "fact" || args[args.indexOf("--permission-mode") + 1] !== "dontAsk" || args.includes("--dangerously-skip-permissions")) process.exit(2);
process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,terminal_reason:"completed",session_id:"session-1",result:"answer",structured_output:{prediction:{fact:"READY"}}}));
`);
  const runner = createClaudeRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });
  const result = await runner({ systemPrompt: "SYSTEM SKILL", input: { request: "read fact" }, workdir, tools: [], model: { id: "model-1" }, predictionSchema: { type: "object", required: ["fact"], properties: { fact: { type: "string" } } } });
  assert.deepEqual(result.prediction, { fact: "READY" });
  assert.deepEqual(result.events, [{ type: "assistant", text: "answer" }]);
  assert.deepEqual(result.provider, { ref: "provider:claude", modelId: "model-1", sessionId: "session-1" });
});

test("Claude coding mode uses stream-json and records tool events", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-claude-coding-"));
  const script = path.join(workdir, "fake-claude.cjs");
  await fs.writeFile(script, `const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
if (!prompt.includes("best-effort patch") || args[args.indexOf("--output-format") + 1] !== "stream-json" || !args.includes("--verbose") || !args.includes("--dangerously-skip-permissions") || args.includes("--permission-mode") || args[args.indexOf("--tools") + 1] !== "Bash,Edit,Read,Glob,Grep,Write") process.exit(2);
const records = [
  {type:"assistant",session_id:"coding-session",message:{content:[{type:"thinking",thinking:"x".repeat(3 * 1024 * 1024)}]}},
  {type:"assistant",session_id:"coding-session",message:{content:[{type:"tool_use",id:"tool-1",name:"Bash",input:{command:"node --test"}}]}},
  {type:"user",session_id:"coding-session",message:{content:[{type:"tool_result",tool_use_id:"tool-1",content:"ok",is_error:false}]}},
  {type:"assistant",session_id:"coding-session",message:{content:[{type:"text",text:"fixed"}]}},
  {type:"result",subtype:"success",is_error:false,terminal_reason:"completed",session_id:"coding-session",result:"fixed",structured_output:{prediction:{summary:"fixed"}}}
];
process.stdout.write(records.map(JSON.stringify).join("\\n") + "\\n");
`);
  const runner = createClaudeRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });
  const result = await runner({ systemPrompt: "coding", input: { task: "fix" }, workdir, tools: ["workspace"], model: { id: "model" } });
  assert.deepEqual(result.prediction, { summary: "fixed" });
  assert.deepEqual(result.events, [
    { type: "tool_call", tool: "Bash", input: { command: "node --test" } },
    { type: "tool_result", toolUseId: "tool-1", output: "ok", isError: false },
    { type: "assistant", text: "fixed" }
  ]);
});

test("Claude runner preserves partial stream diagnostics on timeout", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-claude-timeout-"));
  const script = path.join(workdir, "fake-claude.cjs");
  await fs.writeFile(script, `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"partial analysis"}]}}) + "\\n"); process.stderr.write("provider detail\\n"); setInterval(() => {}, 1000);\n`);
  const runner = createClaudeRunner({ executable: process.execPath, executableArgs: [script], timeoutMs: 1_000 });
  await assert.rejects(
    runner({ systemPrompt: "coding", input: { task: "fix" }, workdir, tools: ["workspace"], model: { id: "model" } }),
    (error) => {
      assert.match(error.message, /timed out after 1000ms/u);
      assert.match(error.wikiskillDiagnostics.stdout, /partial analysis/u);
      assert.match(error.wikiskillDiagnostics.stderr, /provider detail/u);
      assert.equal(error.wikiskillDiagnostics.timedOut, true);
      return true;
    }
  );
});
