"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { prepareKnowledgeContext } = require("../src/knowledge-context");
const { prepareIsolatedCommand } = require("../src/inference-isolation");
const hash = value => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const fixture = async fn => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-knowledge-test-"));
  const source = path.join(root, "source"); const work = path.join(root, "work"); const temporaryRoot = path.join(root, "temp");
  await fs.mkdir(path.join(source, "indexes"), { recursive: true }); await fs.mkdir(work); await fs.mkdir(temporaryRoot);
  execFileSync("git", ["init", "-q", work]);
  const files = [{ path: "README.md", text: "# Team docs\nRead indexes/disclosure.yaml." }, { path: "indexes/disclosure.yaml", text: "nodes: []\n" }];
  for (const file of files) await fs.writeFile(path.join(source, file.path), file.text);
  const data = { libraryId: "team", revision: 1, files: files.map(file => ({ path: file.path, digest: hash(file.text) })) };
  const digest = hash(JSON.stringify(data));
  await fs.writeFile(path.join(source, ".jft0m-copy.json"), JSON.stringify({ schema: "jft0m.teamKnowledgeCopy.v1", ...data, frozenAt: new Date().toISOString(), digest }));
  try { await fn({ root, source, work, temporaryRoot, ref: { libraryId: "team", rootPath: source, digest, deniedRoots: [source] } }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
};
test("knowledge consumption requires actual authenticated read outputs, not a self-reported receipt", () => fixture(async ({ work, ref }) => {
  const context = await prepareKnowledgeContext(ref, work);
  try {
    assert.throws(() => context.verify([{ type: "assistant", text: "I read everything" }], { backend: "macos-seatbelt", privateReadDenied: true }), /consumption evidence/);
    const token = context.instructions.match(/Bearer ([a-f0-9]+)/)[1];
    const base = `http://127.0.0.1:${context.isolation.readerPort}`;
    const forbidden = await fetch(`${base}/read?path=.wikiskill/wiki/index.md`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(forbidden.status, 422);
    const events = [];
    for (const file of ["README.md", "indexes/disclosure.yaml"]) {
      const result = await fetch(`${base}/read?path=${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(result.status, 200); events.push({ type: "tool_result", output: await result.text() });
    }
    const receipt = context.verify(events, { backend: "macos-seatbelt", privateReadDenied: true });
    assert.equal(receipt.reads.length, 2); assert.equal(receipt.snapshotDigest, ref.digest);
    const codexReceipt = context.verify(events, { backend: "codex-workspace-write", privateReadDenied: false, brokerNetworkEnabled: true });
    assert.equal(codexReceipt.reads.length, 2);
    assert.throws(() => context.verify(events, undefined), /verified knowledge-consumption boundary/);
  } finally { await context.close(); }
}));
test("native sandbox denies source, wiki, symlink escape and knowledge writes while allowing code edits", { skip: process.platform !== "darwin" }, () => fixture(async ({ source, work, temporaryRoot, ref }) => {
  const context = await prepareKnowledgeContext(ref, work);
  try {
    await fs.mkdir(path.join(work, ".wikiskill", "wiki"), { recursive: true });
    await fs.writeFile(path.join(work, ".wikiskill", "wiki", "secret.md"), "private");
    await fs.symlink(source, path.join(work, "escape"));
    const commands = [
      `const fs=require('fs'); fs.writeFileSync('answer.txt','ok'); console.log(fs.readFileSync('answer.txt','utf8'));`,
      `require('fs').readFileSync(${JSON.stringify(path.join(source, "README.md"))})`,
      "require('fs').readFileSync('.wikiskill/wiki/secret.md')",
      "require('fs').readFileSync('escape/README.md')",
      "require('fs').writeFileSync('.jft0m/knowledge/sources/team/README.md','tamper')"
    ];
    for (const [index, script] of commands.entries()) {
      const prepared = await prepareIsolatedCommand({ executable: process.execPath, args: ["-e", script], workdir: work, environment: process.env, isolation: context.isolation, temporaryRoot, provider: "codex" });
      const result = spawnSync(prepared.executable, prepared.args, { cwd: work, env: prepared.environment, encoding: "utf8" });
      if (index === 0) assert.equal(result.status, 0, result.stderr);
      else { assert.notEqual(result.status, 0); assert.match(result.stderr, /EPERM|Operation not permitted/); }
    }
  } finally { await context.close(); }
}));
