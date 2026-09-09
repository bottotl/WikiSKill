"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCleanProviderEnvironment } = require("./clean-environment");

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;

const timeoutFor = (config) => {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("WikiSkill Codex learning timeoutMs must be an integer of at least 1000 milliseconds.");
  }
  return timeoutMs;
};

const terminate = (child) => {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through when a process group is unavailable.
    }
  }
  child.kill("SIGTERM");
};

const executeCodex = (spawn, executable, args, prompt, cwd, timeoutMs, env) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(executable, args, {
      cwd,
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
  let settled = false;
  let exitFallback;
  const settle = (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (exitFallback !== undefined) clearTimeout(exitFallback);
    resolve({ code: code ?? 1, signal, stdout, stderr });
  };
  const append = (chunk, stream) => {
    const text = String(chunk);
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > MAX_OUTPUT_BYTES) {
      stderr += "WikiSkill Codex learning output exceeded 2 MiB.";
      terminate(child);
      settle(1, "SIGTERM");
      return;
    }
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  const timeout = setTimeout(() => {
    stderr += `WikiSkill Codex learning timed out after ${timeoutMs}ms.`;
    terminate(child);
    exitFallback = setTimeout(() => settle(1, "SIGTERM"), 200);
  }, timeoutMs);
  child.stdout.on("data", (chunk) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk) => append(chunk, "stderr"));
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (exitFallback !== undefined) clearTimeout(exitFallback);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    exitFallback = setTimeout(() => settle(code, signal), 200);
  });
  child.once("close", (code, signal) => settle(code, signal));
  child.stdin.end(prompt);
});

const parseObject = (value, role) => {
  try {
    const parsed = JSON.parse(value.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw new Error(`WikiSkill Codex ${role} must return one JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const providerFromJsonl = (stdout, role, modelId) => {
  const events = stdout.trim().split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`WikiSkill Codex ${role} returned invalid JSONL at line ${index + 1}.`); }
  });
  const sessions = events.flatMap((event) => event?.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.trim() ? [event.thread_id.trim()] : []);
  if (sessions.length !== 1 || events.filter((event) => event?.type === "turn.completed").length !== 1 || events.some((event) => event?.type === "turn.failed")) {
    throw new Error(`WikiSkill Codex ${role} did not return one successful session.`);
  }
  return { ref: "provider:codex", modelId, sessionId: sessions[0] };
};

const runLearningTurn = async (role, launchRef, config, prompt, cwd, deps = {}) => {
  const executable = typeof config.executable === "string" && config.executable.trim() ? config.executable.trim() : "codex";
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("WikiSkill Codex learning requires a frozen model id.");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `wikiskill-${role}-`));
  const outputPath = path.join(temporaryRoot, "output.json");
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "-C",
    cwd,
    "-o",
    outputPath,
    ...(config.useConfiguredModel || typeof config.model !== "string" || !config.model.trim() ? [] : ["-m", config.model.trim()]),
    ...(config.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`] : []),
    "-"
  ];
  try {
    const providerEnvironment = createCleanProviderEnvironment(process.env, config.env);
    const providerPrompt = "生成过程说明及所有新生成的自然语言内容使用简体中文，包括 Wiki 标题、正文、日志、模式总结，以及 Skill 的 description、说明和步骤。代码、命令、路径、URL、稳定 ID、schema 字段和枚举、专有名称、必要原文引用及补丁匹配 target 保持原样，不得翻译机器合同或改变匹配语义。\n\n" + prompt;
    config.providerLaunchBudget?.consume({ launchRef, role, provider: "codex", modelId: config.model.trim(), reasoningEffort: config.reasoningEffort, executable, args });
    const result = await executeCodex(
      deps.spawn ?? childProcess.spawn,
      executable,
      args,
      providerPrompt,
      cwd,
      timeoutFor(config),
      providerEnvironment
    );
    if (result.code !== 0) throw new Error(`WikiSkill Codex ${role} exited with code ${result.code}: ${(result.stderr || result.stdout).trim()}`);
    if (!fs.existsSync(outputPath)) throw new Error(`WikiSkill Codex ${role} did not produce a final response.`);
    const response = parseObject(fs.readFileSync(outputPath, "utf8"), role);
    return { response, provider: providerFromJsonl(result.stdout, role, config.model.trim()) };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

const maintainerPrompt = (input) => [
  "你是 WikiSkill Wiki Maintainer。根据本轮采样的 training trajectories 和完整现有 Wiki，增量维护可复用的行为模式；不得写入或修改任何 Skill。",
  "每条 executionLog 已在注入前按 15000 字符限制，Raw trace 仍由 WikiSkill 保存。不得读取或推测 validation/test 的任务内容、答案或执行轨迹；可以使用现有 Wiki 的 skill-impact.md 中记录的 validation 汇总分数、候选 diff 与接受/拒绝结果。test 分数不参与候选选择。",
  "只返回一个 JSON object，字段可选：index(string，完整替换 Wiki index)、appendLog(string)、patterns([{name,content}])、patternPatches([{name,edits}])。pattern 名必须是相对 Markdown 路径，edits 使用 append、replace 或 insert_after。",
  "仅当 pattern 已存在且 edit.target 与 Existing Wiki 中的正文逐字匹配时使用 patternPatches；不确定时用 patterns 返回该文件的完整新正文，不得猜测 target。",
  "## Existing Wiki",
  JSON.stringify(input.existingWiki),
  "## Sampled Training Trajectories",
  JSON.stringify(input.sampledTraces)
].join("\n\n");

const traceSelectionPrompt = (input) => [
  "你是 WikiSkill Skill Proposer。先选择需要检查的 training trajectories，不要在这一步提出 Skill 修改。",
  "只返回一个 JSON object：{traceReads:[...]}。必须从 Available Training Trajectories 中选择至少 4 个不同 id。",
  "## Wiki",
  JSON.stringify(input.wiki),
  "## Current Skills",
  JSON.stringify(input.skills),
  "## Allowed New Skill IDs",
  JSON.stringify(input.allowedNewSkillIds || []),
  "## Training Outcome Summary",
  JSON.stringify(input.training),
  "## Available Training Trajectories",
  JSON.stringify(input.availableTraces)
].join("\n\n");

const proposerPrompt = (input) => [
  "你是 WikiSkill Skill Proposer。根据 Wiki、当前 Skills 和本轮 training 结果提出一个原子候选。可以参考 skill-impact.md 中的 validation 汇总分数、候选 diff 与接受/拒绝结果；不得读取或推测 validation/test 的任务内容、答案或执行轨迹，test 分数不参与候选选择。",
  "你先前自主选择的 training traces 已通过受限读取接口提供。只能修改一个 target Skill，context Skill 永远只读。",
  "只返回一个 JSON object：{action:'patch'|'create'|'no_action',skillId?,files?,traceReads:[...] }。create 时 files 必须包含 SKILL.md 和 PURPOSE.md；PURPOSE.md 应引用支持本次创建的 Wiki pattern。patch 时 files 包含该单一 Skill 的完整候选文件内容，并在依据发生变化时同步 PURPOSE.md；没有可证明的通用改进时返回 no_action。",
  "## Wiki",
  JSON.stringify(input.wiki),
  "## Current Skills",
  JSON.stringify(input.skills),
  "## Allowed New Skill IDs",
  JSON.stringify(input.allowedNewSkillIds || []),
  "## Training Outcome Summary",
  JSON.stringify(input.training),
  "## Restricted Trace Reads",
  JSON.stringify(input.readTraces)
].join("\n\n");

const createMaintainer = (config = {}, deps = {}) => async (input) => {
  const launchRef = `learning:${input.attempt}:${input.iteration}:maintainer`;
  const turn = await runLearningTurn("maintainer", launchRef, config, maintainerPrompt(input), input.wikiRoot, deps);
  const response = turn.response;
  await input.recordInvocation?.({ schema: "wikiskill.learning-invocation.v1", launchRef, role: "maintainer", provider: turn.provider });
  let index;
  if (response.index !== undefined) {
    if (typeof response.index !== "string") throw new Error("WikiSkill Codex maintainer index must be text.");
    index = response.index;
  }
  if (response.appendLog !== undefined) {
    if (typeof response.appendLog !== "string") throw new Error("WikiSkill Codex maintainer appendLog must be text.");
    input.appendLog(response.appendLog);
  }
  if (response.patterns !== undefined) {
    if (!Array.isArray(response.patterns)) throw new Error("WikiSkill Codex maintainer patterns must be an array.");
    for (const pattern of response.patterns) {
      if (!pattern || typeof pattern.name !== "string" || typeof pattern.content !== "string") throw new Error("WikiSkill Codex maintainer pattern is invalid.");
      input.writePattern(pattern.name, pattern.content);
    }
  }
  if (response.patternPatches !== undefined) {
    if (!Array.isArray(response.patternPatches)) throw new Error("WikiSkill Codex maintainer patternPatches must be an array.");
    for (const patch of response.patternPatches) {
      if (!patch || typeof patch.name !== "string" || !Array.isArray(patch.edits)) throw new Error("WikiSkill Codex maintainer pattern patch is invalid.");
      input.patchPattern(patch.name, patch.edits);
    }
  }
  return index === undefined ? undefined : { index };
};

const createProposer = (config = {}, deps = {}) => async (input) => {
  const selectionLaunchRef = `learning:${input.attempt}:${input.iteration}:proposer-select`;
  const selectionTurn = await runLearningTurn("proposer-select", selectionLaunchRef, config, traceSelectionPrompt(input), input.wikiRoot, deps);
  const selection = selectionTurn.response;
  await input.recordInvocation?.({ schema: "wikiskill.learning-invocation.v1", launchRef: selectionLaunchRef, role: "proposer-select", provider: selectionTurn.provider });
  if (!Array.isArray(selection.traceReads)) throw new Error("WikiSkill Codex proposer selection must return traceReads.");
  const selected = [...new Set(selection.traceReads)];
  const available = new Set(input.availableTraces.map((trace) => trace.id));
  if (selected.length < Math.min(4, input.availableTraces.length) || selected.some((id) => !available.has(id))) throw new Error("WikiSkill Codex proposer selected invalid training traces.");
  const readTraces = selected.map((id) => ({ id, trace: input.readTrace(id) }));
  const proposalLaunchRef = `learning:${input.attempt}:${input.iteration}:proposer`;
  const proposalTurn = await runLearningTurn("proposer", proposalLaunchRef, config, proposerPrompt({ ...input, readTraces }), input.wikiRoot, deps);
  const response = proposalTurn.response;
  await input.recordInvocation?.({ schema: "wikiskill.learning-invocation.v1", launchRef: proposalLaunchRef, role: "proposer", provider: proposalTurn.provider });
  if (typeof response.action !== "string") throw new Error("WikiSkill Codex proposer response is missing action.");
  return {
    ...response,
    traceReads: selected
  };
};

module.exports = { createMaintainer, createProposer };
