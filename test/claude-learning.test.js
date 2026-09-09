"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMaintainer, createProposer } = require("../src/claude-learning");

test("Claude proposer uses the frozen model and reads only selected training traces", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-claude-learning-"));
const script = path.join(workdir, "fake-claude.cjs");
  await fs.writeFile(script, `const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]).properties.prediction;
const model = args[args.indexOf("--model") + 1];
if (!systemPrompt.includes("自然语言内容使用简体中文") || !systemPrompt.includes("补丁匹配 target 保持原样")) process.exit(6);
if (model !== "frozen-model") process.exit(2);
const selection = prompt.includes("select-training-trajectories");
if ((selection && !systemPrompt.includes("one field: {traceReads")) || (!selection && (!systemPrompt.includes("action patch, create, or no_action") || !systemPrompt.includes("PURPOSE.md")))) process.exit(4);
if ((selection && schema.required[0] !== "traceReads") || (!selection && schema.required[0] !== "action")) process.exit(5);
if ((selection && prompt.includes("selected-trace-body")) || (!selection && !prompt.includes("selected-trace-body"))) process.exit(3);
const prediction = selection ? {traceReads:["trace-2"]} : {action:"no_action"};
process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,terminal_reason:"completed",session_id:"learning-session",result:"proposal",structured_output:{prediction}}));
`);
  const proposer = createProposer({ model: "frozen-model", executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });
  const traceReads = ["trace-2"];
  const proposal = await proposer({
    wikiRoot: workdir,
    iteration: 1,
    wiki: {},
    skills: {},
    training: [],
    availableTraces: ["trace-1", "trace-2", "trace-3", "trace-4"].map((id) => ({ id, score: 0 })),
    readTrace: (id) => ({ id, body: "selected-trace-body" })
  });
  assert.deepEqual(proposal, { action: "no_action", traceReads });
});

test("Claude maintainer prompt requires pattern arrays", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-claude-maintainer-"));
  const script = path.join(workdir, "fake-claude.cjs");
  await fs.writeFile(script, `const args = process.argv.slice(2);
const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]).properties.prediction;
if (!systemPrompt.includes("patterns must be an array of {name, content}")) process.exit(2);
if (schema.properties.patterns.type !== "array" || schema.additionalProperties !== false) process.exit(3);
process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,terminal_reason:"completed",session_id:"maintainer-session",result:"maintained",structured_output:{prediction:{patterns:[{name:"rule.md",content:"# Rule\\n"}],appendLog:"updated"}}}));
`);
  const patterns = [];
  const logs = [];
  const maintainer = createMaintainer({ model: "frozen-model", executable: process.execPath, executableArgs: [script], timeoutMs: 10_000 });
  await maintainer({
    wikiRoot: workdir,
    iteration: 1,
    existingWiki: {},
    sampledTraces: [],
    writePattern: (name, content) => patterns.push({ name, content }),
    patchPattern: () => {},
    appendLog: (content) => logs.push(content)
  });
  assert.deepEqual(patterns, [{ name: "rule.md", content: "# Rule\n" }]);
  assert.deepEqual(logs, ["updated"]);
});
