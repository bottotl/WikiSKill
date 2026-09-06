"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { execute } = require("../src/cli");
const { BOOTSTRAP, doctorWorkspace, initWorkspace, uninstallWorkspace, updateBootstrap } = require("../src/workspace");

const temporaryWorkspace = () => fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-workspace-"));

test("init dry-run reports changes without writing", async () => {
  const workspace = await temporaryWorkspace();
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "# Existing rules\n");
  const before = await fs.readdir(workspace);
  const result = await initWorkspace(workspace, { dryRun: true });
  assert.deepEqual(await fs.readdir(workspace), before);
  assert.match(result.changes.find((change) => change.path === "AGENTS.md").diff, /Existing rules[\s\S]*wikiskill-bootstrap:start/u);
  assert.equal(result.changes.some((change) => change.path === ".wikiskill/config.json"), true);
});

test("init creates only the minimal workspace and preserves Provider rules", async () => {
  const workspace = await temporaryWorkspace();
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "# Owner rules\n");
  await fs.writeFile(path.join(workspace, "CLAUDE.md"), "# Claude rules\n");
  await initWorkspace(workspace);
  const config = JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill/config.json"), "utf8"));
  assert.equal(config.liveSkillsPath, ".wikiskill/skills");
  assert.equal(config.bootstrapMode, "direct");
  assert.deepEqual(await fs.readdir(path.join(workspace, ".wikiskill")), [".gitignore", "candidates", "config.json", "raw", "receipts", "runtime", "skills", "wiki"]);
  assert.deepEqual(await fs.readdir(path.join(workspace, ".wikiskill", "raw")), []);
  assert.match(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8"), /# Owner rules[\s\S]*wikiskill context prepare/u);
  assert.equal(await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8"), "# Claude rules\n\n@AGENTS.md\n");
  assert.deepEqual((await initWorkspace(workspace)).changes, []);
  assert.deepEqual((await doctorWorkspace(workspace)).blockers, []);
});

test("bootstrap tells the foreground Agent to consume only its frozen Skill context", async () => {
  const workspace = await temporaryWorkspace();
  await initWorkspace(workspace);
  const agents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  for (const text of ["prepare the frozen Agent context", "frozen Skill snapshot", "receipt command", "ground truth"]) assert.match(agents, new RegExp(text, "u"));
  assert.equal(agents.includes(BOOTSTRAP), true);
  assert.equal(await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
});

test("bootstrap install manages repo instructions without creating a second WikiSkill workspace", async () => {
  const workspace = await temporaryWorkspace();
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "# Owner rules\n");
  const command = "jft0m workspace harness prepare-context --repo . --json";
  const preview = await updateBootstrap(workspace, "install", { command, dryRun: true });
  assert.deepEqual(preview.changes.map((change) => change.path), ["AGENTS.md", "CLAUDE.md"]);
  await assert.rejects(fs.access(path.join(workspace, ".wikiskill")));
  await updateBootstrap(workspace, "install", { command });
  assert.match(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8"), /jft0m workspace harness prepare-context --repo \. --json/u);
  assert.equal(await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.deepEqual((await updateBootstrap(workspace, "install", { command })).changes, []);
  await updateBootstrap(workspace, "uninstall", { command });
  assert.equal(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Owner rules\n");
  await assert.rejects(fs.access(path.join(workspace, "CLAUDE.md")));
  await assert.rejects(fs.access(path.join(workspace, ".wikiskill")));
});

test("bootstrap uninstall blocks if its managed command was edited", async () => {
  const workspace = await temporaryWorkspace();
  const command = "jft0m workspace harness prepare-context --repo . --json";
  await updateBootstrap(workspace, "install", { command });
  const agentsPath = path.join(workspace, "AGENTS.md");
  await fs.writeFile(agentsPath, (await fs.readFile(agentsPath, "utf8")).replace("prepare-context", "changed-command"));
  await assert.rejects(updateBootstrap(workspace, "uninstall", { command }), /managed block was edited/u);
});

test("public bootstrap CLI requires one explicit command and supports dry-run", async () => {
  const workspace = await temporaryWorkspace();
  const lines = [];
  const code = await execute(["bootstrap", "install", "--workspace", workspace, "--command", "jft0m workspace harness prepare-context --repo . --json", "--dry-run", "--json"], { stdout: (line) => lines.push(line), stderr: () => {} });
  assert.equal(code, 0);
  assert.equal(JSON.parse(lines.join("")).data.dryRun, true);
  await assert.rejects(fs.access(path.join(workspace, "AGENTS.md")));
});

test("zero-source-write init leaves instruction files untouched", async () => {
  const workspace = await temporaryWorkspace();
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "# Owner rules\n");
  await initWorkspace(workspace, { mode: "zero-source-write" });
  assert.equal(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Owner rules\n");
  await assert.rejects(fs.access(path.join(workspace, "CLAUDE.md")));
  assert.deepEqual((await doctorWorkspace(workspace)).blockers, []);
});

test("doctor returns a nonzero CLI result for an uninitialized workspace", async () => {
  const workspace = await temporaryWorkspace();
  const lines = [];
  const code = await execute(["doctor", "--workspace", workspace, "--json"], { stdout: (line) => lines.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.equal(JSON.parse(lines.join("")).blockers.includes("Failed check: workspace.config"), true);
});

test("uninstall removes unchanged bootstrap content and preserves state", async () => {
  const workspace = await temporaryWorkspace();
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "# Owner rules\n");
  await fs.writeFile(path.join(workspace, "CLAUDE.md"), "# Claude rules\n");
  await initWorkspace(workspace);
  const preview = await uninstallWorkspace(workspace, { dryRun: true });
  assert.deepEqual(preview.changes.map((change) => change.path), ["AGENTS.md", "CLAUDE.md"]);
  await uninstallWorkspace(workspace);
  assert.equal(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Owner rules\n");
  assert.equal(await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8"), "# Claude rules\n");
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill/config.json"), "utf8")).schema, "wikiskill.workspace.v1");
});

test("uninstall blocks when the managed block was edited", async () => {
  const workspace = await temporaryWorkspace();
  await initWorkspace(workspace);
  const agentsPath = path.join(workspace, "AGENTS.md");
  await fs.writeFile(agentsPath, (await fs.readFile(agentsPath, "utf8")).replace("prepare the frozen Agent context", "modified managed instruction"));
  await assert.rejects(uninstallWorkspace(workspace), /managed block was edited/u);
});

test("init rejects symlinked installation paths", async () => {
  const workspace = await temporaryWorkspace();
  const outside = await temporaryWorkspace();
  await fs.symlink(outside, path.join(workspace, ".wikiskill"));
  await assert.rejects(initWorkspace(workspace), /must not be a symlink/u);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("init rejects an incompatible existing config", async () => {
  const workspace = await temporaryWorkspace();
  await fs.mkdir(path.join(workspace, ".wikiskill"));
  await fs.writeFile(path.join(workspace, ".wikiskill/config.json"), "{}\n");
  await assert.rejects(initWorkspace(workspace), /incompatible/u);
  await assert.rejects(fs.access(path.join(workspace, "AGENTS.md")));
});

test("standalone package has no host-monorepo dependency", async () => {
  const packageRoot = path.resolve(__dirname, "..");
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  for (const file of (await fs.readdir(path.join(packageRoot, "src"))).filter((name) => name.endsWith(".js"))) {
    const source = await fs.readFile(path.join(packageRoot, "src", file), "utf8");
    assert.doesNotMatch(source, /(?:require|import)\s*\(?["'][^"']*(?:server|web|desktop|plugin-store|jft0m)[^"']*["']/u);
  }
});

test("README documents the complete exact-output dataset task contract", async () => {
  const readme = await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /"groundTruth"[\s\S]*"schema": "wikiskill\.scorer\.exact-output\.v1"[\s\S]*"expected"/u);
  assert.match(readme, /"outputSchema"[\s\S]*"additionalProperties": false/u);
  assert.match(readme, /groundTruth\.expected.*相同 JSON 值和结构/u);
  assert.match(readme, /只把 `input` 和 `outputSchema` 传给 Inference Agent/u);
});

test("README documents command-scored coding tasks", async () => {
  const readme = await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /builtin:command-exit-v1/u);
  assert.match(readme, /"command": \["node", "--test", "value\.test\.cjs"\]/u);
  assert.match(readme, /直接执行且不经过 shell/u);
  assert.match(readme, /Git status\/diff 和[\s\S]*verifier command/u);
});
