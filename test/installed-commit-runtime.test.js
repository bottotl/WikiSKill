"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const digest = value => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

test("copied standalone runtime replays binary snapshots and consumes knowledge through the Codex broker boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-installed-commit-"));
  try {
    const installed = path.join(root, "app-resources", "wikiskill");
    for (const entry of ["src", "bin", "package.json"]) await fs.cp(path.join(__dirname, "..", entry), path.join(installed, entry), { recursive: true });
    const workdir = path.join(root, "work"); const knowledgeRoot = path.join(root, "knowledge");
    await fs.mkdir(workdir); await fs.mkdir(path.join(knowledgeRoot, "indexes"), { recursive: true });
    const snapshotBytes = [JSON.stringify({ schema: "wikiskill.repository-snapshot.v1" }), JSON.stringify({ path: "image.bin", mode: "100644", content: "AP8B" }), JSON.stringify({ path: "entry.sh", mode: "100755", content: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64") }), ""].join("\n");
    const snapshotPath = path.join(root, "snapshot.jsonl"); await fs.writeFile(snapshotPath, snapshotBytes);
    const snapshotModule = require(path.join(installed, "src", "repository-snapshot.js"));
    await snapshotModule.materializeRepositorySnapshot(workdir, { path: snapshotPath, digest: digest(snapshotBytes) });
    assert.deepEqual(await fs.readFile(path.join(workdir, "image.bin")), Buffer.from([0, 255, 1]));
    assert.ok((await fs.stat(path.join(workdir, "entry.sh"))).mode & 0o111);
    await assert.rejects(snapshotModule.materializeRepositorySnapshot(workdir, { path: snapshotPath, digest: `sha256:${"0".repeat(64)}` }), /drift/);
    execFileSync("git", ["init", "-q", workdir]);
    const docs = [{ path: "README.md", content: "# API usage\nRead indexes/disclosure.yaml" }, { path: "indexes/disclosure.yaml", content: "nodes: []" }];
    for (const file of docs) await fs.writeFile(path.join(knowledgeRoot, file.path), file.content);
    const copy = { libraryId: "team", revision: 1, files: docs.map(file => ({ path: file.path, digest: digest(file.content) })) };
    const copyDigest = digest(JSON.stringify(copy));
    await fs.writeFile(path.join(knowledgeRoot, ".jft0m-copy.json"), JSON.stringify({ schema: "jft0m.teamKnowledgeCopy.v1", ...copy, digest: copyDigest }));
    const context = await require(path.join(installed, "src", "knowledge-context.js")).prepareKnowledgeContext({ libraryId: "team", rootPath: knowledgeRoot, digest: copyDigest, deniedRoots: [knowledgeRoot, installed] }, workdir, { context: { guide: { "SKILL.md": "Use the reference.", "references/api.md": "An API contract." } } });
    try {
      const fixture = path.join(workdir, "provider.cjs");
      await fs.writeFile(fixture, `
const fs=require('node:fs');
let input=''; process.stdin.on('data',part=>input+=part); process.stdin.on('end',async()=>{
  const token=input.match(/Bearer ([a-f0-9]+)/)[1]; const url=input.match(/http:\\/\\/127[.]0[.]0[.]1:\\d+\\/read/)[0];
  console.log(JSON.stringify({type:'thread.started',thread_id:'isolated-fixture'}));
  console.log(JSON.stringify({type:'turn.started'}));
  for(const file of ['README.md','indexes/disclosure.yaml']) {
    const response=await fetch(url+'?path='+encodeURIComponent(file),{headers:{authorization:'Bearer '+token}});
    if(!response.ok) throw new Error('read failed');
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'read frozen knowledge',aggregated_output:await response.text(),exit_code:0}}));
  }
  fs.writeFileSync('answer.txt','implemented');
  fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({prediction:'done'}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});
`);
      const runner = require(path.join(installed, "src", "codex-runner.js")).createCodexRunner({ executable: process.execPath, executableArgs: [fixture] });
      const result = await runner({ systemPrompt: context.instructions, input: "Use the docs and implement the change", tools: ["workspace"], model: { id: "fixture-model" }, workdir, isolation: context.isolation }).catch(error => { throw new Error(`${error.message}\n${error.wikiskillDiagnostics?.stderr || ""}`); });
      assert.equal(result.prediction, "done"); assert.deepEqual(result.isolationEvidence, { backend: "codex-workspace-write", privateReadDenied: false, brokerNetworkEnabled: true }); assert.equal(context.verify(result.events, result.isolationEvidence).reads.length, 2);
      assert.equal(await fs.readFile(path.join(workdir, "answer.txt"), "utf8"), "implemented");
      assert.equal(await fs.readFile(path.join(workdir, ".jft0m", "skill-context", "guide", "references", "api.md"), "utf8"), "An API contract.");
    } finally { await context.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
