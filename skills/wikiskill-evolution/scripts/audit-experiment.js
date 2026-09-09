#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateDataset } = require("../../../src");
const { skillSetDigest } = require("../../../src/skill-bundle");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const META_TASK = /(?:\b(?:optimi[sz]e|improve|modify|update|evolve)\b.{0,80}\bskill\b|\bskill\b.{0,80}\b(?:optimi[sz]e|improve|modify|update|evolve)\b|(?:优化|修改|更新|演化).{0,40}(?:Skill|技能))/iu;

const parseArgs = (argv) => {
  const options = { json: false, mode: "publishable", empty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--empty") options.empty = true;
    else if (arg === "--dataset") options.dataset = argv[++index];
    else if (arg === "--target-skill") options.targetSkill = argv[++index];
    else if (arg === "--skill-context") options.skillContext = argv[++index];
    else if (arg === "--baseline") options.baseline = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.dataset) throw new Error("--dataset is required");
  if (!SAFE_ID.test(options.targetSkill || "")) throw new Error("--target-skill must be a safe Skill id");
  if (!new Set(["publishable", "smoke"]).has(options.mode)) throw new Error("--mode must be publishable or smoke");
  if (options.mode === "publishable" && (!options.skillContext || !options.baseline)) throw new Error("--skill-context and --baseline are required in publishable mode");
  return options;
};

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(textOf).join("\n");
  return "";
};

const validateSkillContext = (value, targetSkill, empty) => {
  const context = value?.success === true && value.data ? value.data : value;
  const skills = context?.skills;
  if (!skills || !SHA256.test(skills.bundleDigest || "") || !Array.isArray(skills.inventory)) return "Skill context must contain a sha256 bundleDigest and inventory.";
  if (skills.inventory.some((entry) => !SAFE_ID.test(entry?.id || "") || !SHA256.test(entry?.bundleDigest || ""))) return "Skill context inventory contains an invalid Skill id or digest.";
  if (new Set(skills.inventory.map((entry) => entry.id)).size !== skills.inventory.length) return "Skill context inventory contains duplicate Skill ids.";
  const computedBundleDigest = skillSetDigest(skills.inventory);
  if (computedBundleDigest !== skills.bundleDigest) return "Skill context bundleDigest does not match its inventory.";
  const hasTarget = skills.inventory.some((entry) => entry.id === targetSkill);
  if (empty && skills.inventory.length > 0) return "Empty evolution requires an empty active Skill context.";
  if (!empty && !hasTarget) return "Active Skill context does not include the target Skill.";
  return null;
};

const validateBaseline = (value, targetSkill, skillContext, empty) => {
  const baseline = value?.success === true && value.data ? value.data : value;
  if (baseline?.schema !== "wikiskill.evolution-baseline.v1" || baseline.targetSkill !== targetSkill) return "Evolution baseline does not match the target Skill.";
  if (!SHA256.test(baseline.activeSkillSetDigest || "") || !Array.isArray(baseline.activeSkills)) return "Evolution baseline must contain an active Skill inventory and set digest.";
  if (baseline.activeSkills.some((entry) => !SAFE_ID.test(entry?.id || "") || !SHA256.test(entry?.bundleDigest || ""))) return "Evolution baseline active Skill inventory is invalid.";
  if (new Set(baseline.activeSkills.map((entry) => entry.id)).size !== baseline.activeSkills.length) return "Evolution baseline contains duplicate active Skill ids.";
  if (skillSetDigest(baseline.activeSkills) !== baseline.activeSkillSetDigest) return "Evolution baseline active Skill-set digest does not match its inventory.";
  if (empty && (baseline.targetSkillDigest !== null || baseline.activeSkills.length > 0)) return "Empty evolution baseline must have no target or active Skills.";
  if (!empty && !SHA256.test(baseline.targetSkillDigest || "")) return "Seeded evolution baseline must contain the target Skill digest.";
  const context = skillContext?.success === true && skillContext.data ? skillContext.data : skillContext;
  if (context && (context.workspaceId !== baseline.workspaceId || context.skills?.bundleDigest !== baseline.activeSkillSetDigest)) return "Skill context and evolution baseline do not describe the same workspace and active Skill set.";
  return null;
};

const audit = ({ dataset, targetSkill, skillContext, baseline, mode = "publishable", empty = false }) => {
  const blockers = [];
  const warnings = [];
  const strict = mode === "publishable";
  if (!new Set(["publishable", "smoke"]).has(mode)) blockers.push("Audit mode must be publishable or smoke.");
  if (skillContext) {
    const contextError = validateSkillContext(skillContext, targetSkill, empty);
    if (contextError) blockers.push(contextError);
  } else if (strict) blockers.push("Publishable experiments require a frozen active Skill context.");
  else warnings.push("Smoke has no frozen active Skill context; it cannot support candidate publication.");
  if (baseline) {
    const baselineError = validateBaseline(baseline, targetSkill, skillContext, empty);
    if (baselineError) blockers.push(baselineError);
  } else if (strict) blockers.push("Publishable experiments require a frozen evolution baseline.");
  else warnings.push("Smoke has no frozen evolution baseline; it cannot support candidate publication.");
  let tasks;
  try {
    tasks = validateDataset(dataset).tasks;
  } catch (error) {
    blockers.push(...(Array.isArray(error?.blockers) ? error.blockers : [error instanceof Error ? error.message : String(error)]));
    return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], splitCounts: {} };
  }
  const lineages = new Map();
  const splitCounts = { train: 0, val: 0, test: 0 };
  for (const task of tasks) {
    const label = task.id;
    splitCounts[task.split] += 1;
    const taskText = textOf(task?.input);
    if (META_TASK.test(taskText)) warnings.push(`${label}: input may ask the Inference Agent to optimize a Skill instead of perform domain work; review the role boundary.`);
    if (typeof task?.lineageKey !== "string" || !task.lineageKey.trim()) {
      warnings.push(`${label}: no lineageKey is available; verify split independence from source provenance.`);
    } else {
      const priorLineage = lineages.get(task.lineageKey);
      if (priorLineage && priorLineage.split !== task?.split) blockers.push(`${label}: lineageKey ${task.lineageKey} crosses ${priorLineage.split}/${task?.split}.`);
      else if (!priorLineage) lineages.set(task.lineageKey, { id: label, split: task?.split });
    }
    const allowedPaths = task?.groundTruth?.allowedPaths;
    if (task?.groundTruth?.schema === "wikiskill.scorer.command-exit.v1") {
      if (!Array.isArray(task.groundTruth.command) || task.groundTruth.command.length === 0 || task.groundTruth.command.some((part) => typeof part !== "string")) blockers.push(`${label}: command-exit groundTruth requires a non-empty argv command.`);
      if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) blockers.push(`${label}: command-exit groundTruth requires explicit allowedPaths.`);
    }
    if (Array.isArray(allowedPaths)) {
      const targetPattern = new RegExp(`(?:^|/)${targetSkill.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:/|$)`, "u");
      const skillPaths = allowedPaths.filter((entry) => typeof entry === "string" && targetPattern.test(entry));
      if (skillPaths.length) warnings.push(`${label}: allowedPaths may expose the target Skill to the task checkout (${skillPaths.join(", ")}); review the path semantics.`);
      if (allowedPaths.length > 8) warnings.push(`${label}: allowedPaths contains ${allowedPaths.length} entries; review whether the task contract is too broad.`);
    }
  }
  for (const split of Object.keys(splitCounts)) {
    if (splitCounts[split] === 1) warnings.push(`Dataset has only one ${split} task; treat results as a smoke unless independence is established externally.`);
  }
  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], splitCounts };
};

const main = () => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const datasetPath = path.resolve(options.dataset);
    const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
    const skillContext = options.skillContext ? JSON.parse(fs.readFileSync(path.resolve(options.skillContext), "utf8")) : null;
    const baseline = options.baseline ? JSON.parse(fs.readFileSync(path.resolve(options.baseline), "utf8")) : null;
    const result = audit({ dataset, targetSkill: options.targetSkill, skillContext, baseline, mode: options.mode, empty: options.empty });
    const output = {
      schema: "wikiskill.experiment-audit.v1",
      success: result.blockers.length === 0,
      data: { datasetPath, targetSkill: options.targetSkill, mode: options.mode, splitCounts: result.splitCounts, ...(options.skillContext ? { skillContextPath: path.resolve(options.skillContext) } : {}), ...(options.baseline ? { baselinePath: path.resolve(options.baseline) } : {}) },
      warnings: result.warnings,
      blockers: result.blockers,
      nextActions: result.blockers.length ? ["Resolve every blocker, then rerun the audit and wikiskill dataset validate."] : result.warnings.length ? ["Review each warning before freezing the experiment."] : []
    };
    process.stdout.write(`${JSON.stringify(output, null, options.json ? 2 : 0)}\n`);
    process.exitCode = output.success ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: "wikiskill.experiment-audit.v1", success: false, data: null, warnings: [], blockers: [error instanceof Error ? error.message : String(error)], nextActions: [] })}\n`);
    process.exitCode = 1;
  }
};

if (require.main === module) main();

module.exports = { audit, parseArgs };
