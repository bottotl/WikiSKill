"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const BOOTSTRAP_START = "<!-- wikiskill-bootstrap:start -->";
const BOOTSTRAP_END = "<!-- wikiskill-bootstrap:end -->";
const CLAUDE_IMPORT = "@AGENTS.md";
const CONFIG_SCHEMA = "wikiskill.workspace.v1";
const bootstrapContent = (command) => [
  BOOTSTRAP_START,
  "## WikiSkill",
  "",
  "Before starting a user task, prepare the frozen Agent context:",
  "",
  "```sh",
  command,
  "```",
  "",
  "Follow the returned instructions and use only the frozen Skill snapshot for this session.",
  "Record Skill consumption with the returned receipt command. Do not read WikiSkill Wiki, candidates, ground truth, or evaluation evidence during the user task.",
  BOOTSTRAP_END
].join("\n");
const DEFAULT_CONTEXT_COMMAND = "wikiskill context prepare --workspace . --json";
const BOOTSTRAP = bootstrapContent(DEFAULT_CONTEXT_COMMAND);

const DIRECTORIES = ["raw", "wiki/patterns", "skills", "candidates", "receipts", "runtime"];
const INITIAL_FILES = {
  ".gitignore": "/raw/\n/candidates/\n/receipts/\n/runtime/\n",
  "wiki/index.md": "# WikiSkill Index\n",
  "wiki/log.md": "# Evolution Log\n",
  "wiki/skill-impact.md": "# Skill Impact\n"
};

const exists = async (target) => fs.access(target).then(() => true, () => false);
const readText = async (target) => await exists(target) ? fs.readFile(target, "utf8") : "";

const resolveWorkspace = async (input) => {
  if (typeof input !== "string" || !input.trim()) throw new Error("Workspace path is required.");
  const workspace = path.resolve(input);
  const stat = await fs.lstat(workspace).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be an existing non-symlink directory.");
  return workspace;
};

const replaceManagedBlock = (current, bootstrap = BOOTSTRAP) => {
  const start = current.indexOf(BOOTSTRAP_START);
  const end = current.indexOf(BOOTSTRAP_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) throw new Error("AGENTS.md contains an incomplete WikiSkill managed block.");
  if (start === -1) return current.trimEnd() + (current.trim() ? "\n\n" : "") + bootstrap + "\n";
  return current.slice(0, start) + bootstrap + current.slice(end + BOOTSTRAP_END.length);
};

const removeManagedBlock = (current, expectedBootstrap = BOOTSTRAP) => {
  const start = current.indexOf(BOOTSTRAP_START);
  const end = current.indexOf(BOOTSTRAP_END);
  if (start === -1 && end === -1) return current;
  if (start === -1 || end < start) throw new Error("AGENTS.md contains an incomplete WikiSkill managed block.");
  if (current.slice(start, end + BOOTSTRAP_END.length) !== expectedBootstrap) throw new Error("AGENTS.md WikiSkill managed block was edited; automatic uninstall is blocked.");
  const before = current.slice(0, start).trimEnd();
  const after = current.slice(end + BOOTSTRAP_END.length).trimStart();
  return (before + (before && after ? "\n\n" : "") + after).replace(/\n*$/u, "\n");
};

const addClaudeImport = (current) => current.split(/\r?\n/u).some((line) => line.trim() === CLAUDE_IMPORT)
  ? current
  : current.trimEnd() + (current.trim() ? "\n\n" : "") + CLAUDE_IMPORT + "\n";

const removeClaudeImport = (current) => {
  const lines = current.split(/\r?\n/u);
  const count = lines.filter((line) => line.trim() === CLAUDE_IMPORT).length;
  if (count === 0) return current;
  if (count !== 1) throw new Error("CLAUDE.md contains multiple WikiSkill imports; automatic uninstall is blocked.");
  return lines.filter((line) => line.trim() !== CLAUDE_IMPORT).join("\n").trimEnd() + "\n";
};

const renderDiff = (relative, before, after) => {
  if (before === after) return "";
  return [
    "--- a/" + relative,
    "+++ b/" + relative,
    "@@",
    ...before.replace(/\n$/u, "").split("\n").filter(Boolean).map((line) => "-" + line),
    ...after.replace(/\n$/u, "").split("\n").filter(Boolean).map((line) => "+" + line),
    ""
  ].join("\n");
};

const assertSafePaths = async (workspace) => {
  const root = path.join(workspace, ".wikiskill");
  const targets = [
    root,
    ...DIRECTORIES.map((relative) => path.join(root, relative)),
    ...Object.keys(INITIAL_FILES).map((relative) => path.join(root, relative)),
    path.join(root, "config.json"),
    path.join(workspace, "AGENTS.md"),
    path.join(workspace, "CLAUDE.md")
  ];
  for (const target of targets) {
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error("WikiSkill installation path must not be a symlink: " + path.relative(workspace, target));
  }
};

async function initWorkspace(input, options = {}) {
  const dryRun = options.dryRun === true;
  const mode = options.mode || "direct";
  if (!new Set(["direct", "zero-source-write"]).has(mode)) throw new Error("WikiSkill init mode must be direct or zero-source-write.");
  const workspace = await resolveWorkspace(input);
  await assertSafePaths(workspace);
  const root = path.join(workspace, ".wikiskill");
  const configPath = path.join(root, "config.json");
  const existingConfig = await exists(configPath) ? JSON.parse(await fs.readFile(configPath, "utf8")) : null;
  if (existingConfig && (existingConfig.schema !== CONFIG_SCHEMA || existingConfig.liveSkillsPath !== ".wikiskill/skills" || existingConfig.bootstrapMode !== mode)) {
    throw new Error("Workspace has an incompatible WikiSkill config.");
  }
  const config = existingConfig || {
    schema: CONFIG_SCHEMA,
    workspaceId: crypto.randomUUID(),
    liveSkillsPath: ".wikiskill/skills",
    bootstrapMode: mode
  };
  const desired = { ...INITIAL_FILES, "config.json": JSON.stringify(config, null, 2) + "\n" };
  if (mode === "direct") {
    desired["../AGENTS.md"] = replaceManagedBlock(await readText(path.join(workspace, "AGENTS.md")));
    desired["../CLAUDE.md"] = addClaudeImport(await readText(path.join(workspace, "CLAUDE.md")));
  }
  const fileChanges = [];
  for (const [relative, content] of Object.entries(desired)) {
    const target = path.resolve(root, relative);
    if (Object.hasOwn(INITIAL_FILES, relative) && await exists(target)) continue;
    const before = await readText(target);
    if (before !== content) {
      const display = path.relative(workspace, target).split(path.sep).join("/");
      fileChanges.push({ path: display, operation: before ? "update" : "create", diff: renderDiff(display, before, content), content });
    }
  }
  const missingDirectories = [];
  for (const relative of DIRECTORIES) if (!await exists(path.join(root, relative))) missingDirectories.push(relative);
  if (!dryRun) {
    for (const relative of DIRECTORIES) await fs.mkdir(path.join(root, relative), { recursive: true });
    for (const change of fileChanges) {
      const target = path.join(workspace, change.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, change.content, "utf8");
    }
  }
  return {
    workspace,
    workspaceId: config.workspaceId,
    liveSkillsPath: path.join(root, "skills"),
    dryRun,
    changes: [
      ...missingDirectories.map((relative) => ({ path: ".wikiskill/" + relative, operation: "create-directory" })),
      ...fileChanges.map(({ content: _content, ...change }) => change)
    ]
  };
}

async function doctorWorkspace(input) {
  const workspace = await resolveWorkspace(input);
  const root = path.join(workspace, ".wikiskill");
  const checks = [];
  const config = await fs.readFile(path.join(root, "config.json"), "utf8").then(JSON.parse, () => null);
  checks.push({ id: "workspace.config", ok: config?.schema === CONFIG_SCHEMA && config.liveSkillsPath === ".wikiskill/skills" });
  for (const relative of DIRECTORIES) {
    const ok = await fs.lstat(path.join(root, relative)).then((stat) => stat.isDirectory() && !stat.isSymbolicLink(), () => false);
    checks.push({ id: "directory." + relative, ok });
  }
  if (config?.bootstrapMode === "direct") {
    checks.push({ id: "bootstrap.agents", ok: (await readText(path.join(workspace, "AGENTS.md"))).includes(BOOTSTRAP) });
    checks.push({ id: "bootstrap.claude", ok: (await readText(path.join(workspace, "CLAUDE.md"))).split(/\r?\n/u).filter((line) => line.trim() === CLAUDE_IMPORT).length === 1 });
  }
  return {
    workspace,
    workspaceId: config?.workspaceId ?? null,
    liveSkillsPath: path.join(root, "skills"),
    checks,
    blockers: checks.filter((check) => !check.ok).map((check) => "Failed check: " + check.id)
  };
}

async function uninstallWorkspace(input, options = {}) {
  const dryRun = options.dryRun === true;
  const workspace = await resolveWorkspace(input);
  const config = JSON.parse(await fs.readFile(path.join(workspace, ".wikiskill", "config.json"), "utf8"));
  if (config.schema !== CONFIG_SCHEMA) throw new Error("Workspace does not contain a supported WikiSkill installation.");
  const changes = [];
  if (config.bootstrapMode === "direct") {
    for (const [relative, update] of [["AGENTS.md", removeManagedBlock], ["CLAUDE.md", removeClaudeImport]]) {
      const target = path.join(workspace, relative);
      const before = await readText(target);
      const after = update(before);
      if (before !== after) changes.push({ path: relative, operation: after.trim() ? "update" : "delete", diff: renderDiff(relative, before, after), content: after });
    }
  }
  if (!dryRun) {
    for (const change of changes) {
      const target = path.join(workspace, change.path);
      if (change.operation === "delete") await fs.rm(target);
      else await fs.writeFile(target, change.content, "utf8");
    }
  }
  return { workspace, dryRun, preservedState: ".wikiskill/", changes: changes.map(({ content: _content, ...change }) => change) };
}

const bootstrapPlan = async (workspace, command, operation) => {
  const agentsPath = path.join(workspace, "AGENTS.md");
  const claudePath = path.join(workspace, "CLAUDE.md");
  for (const target of [agentsPath, claudePath]) {
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error("WikiSkill bootstrap instruction path must not be a symlink: " + path.basename(target));
  }
  const bootstrap = bootstrapContent(command);
  const beforeAgents = await readText(agentsPath);
  const beforeClaude = await readText(claudePath);
  const afterAgents = operation === "install" ? replaceManagedBlock(beforeAgents, bootstrap) : removeManagedBlock(beforeAgents, bootstrap);
  const afterClaude = operation === "install" ? addClaudeImport(beforeClaude) : removeClaudeImport(beforeClaude);
  return [
    { path: "AGENTS.md", before: beforeAgents, after: afterAgents },
    { path: "CLAUDE.md", before: beforeClaude, after: afterClaude }
  ].filter((item) => item.before !== item.after).map((item) => ({
    path: item.path,
    operation: item.after.trim() ? (item.before ? "update" : "create") : "delete",
    diff: renderDiff(item.path, item.before, item.after),
    content: item.after
  }));
};

async function updateBootstrap(input, operation, options = {}) {
  if (operation !== "install" && operation !== "uninstall") throw new Error("WikiSkill bootstrap operation must be install or uninstall.");
  const workspace = await resolveWorkspace(input);
  const command = typeof options.command === "string" && options.command.trim() ? options.command.trim() : DEFAULT_CONTEXT_COMMAND;
  if (/\r|\n/u.test(command) || command.includes("```") || command.includes(BOOTSTRAP_START) || command.includes(BOOTSTRAP_END)) throw new Error("WikiSkill bootstrap command must be one safe Markdown line.");
  const dryRun = options.dryRun === true;
  const changes = await bootstrapPlan(workspace, command, operation);
  if (!dryRun) {
    for (const change of changes) {
      const target = path.join(workspace, change.path);
      if (change.operation === "delete") await fs.rm(target);
      else await fs.writeFile(target, change.content, "utf8");
    }
  }
  return { workspace, operation, command, dryRun, changes: changes.map(({ content: _content, ...change }) => change) };
}

module.exports = { BOOTSTRAP, doctorWorkspace, initWorkspace, uninstallWorkspace, updateBootstrap };
