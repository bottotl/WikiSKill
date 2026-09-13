"use strict";

const { skillSetDigest } = require("../skill-bundle");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

const unwrap = (value) => value?.success === true && value.data ? value.data : value;

const validateSkillContext = (value, targetSkill, empty) => {
  const context = unwrap(value);
  const skills = context?.skills;
  if (!skills || !SHA256.test(skills.bundleDigest || "") || !Array.isArray(skills.inventory)) return "Skill context must contain a sha256 bundleDigest and inventory.";
  if (skills.inventory.some((entry) => !SAFE_ID.test(entry?.id || "") || !SHA256.test(entry?.bundleDigest || ""))) return "Skill context inventory contains an invalid Skill id or digest.";
  if (new Set(skills.inventory.map((entry) => entry.id)).size !== skills.inventory.length) return "Skill context inventory contains duplicate Skill ids.";
  if (skillSetDigest(skills.inventory) !== skills.bundleDigest) return "Skill context bundleDigest does not match its inventory.";
  const hasTarget = skills.inventory.some((entry) => entry.id === targetSkill);
  if (empty && skills.inventory.length > 0) return "Empty evolution requires an empty active Skill context.";
  if (!empty && !hasTarget) return "Active Skill context does not include the target Skill.";
  return null;
};

const validateBaseline = (value, targetSkill, skillContext, empty) => {
  const baseline = unwrap(value);
  if (baseline?.schema !== "wikiskill.evolution-baseline.v1" || baseline.targetSkill !== targetSkill) return "Evolution baseline does not match the target Skill.";
  if (!SHA256.test(baseline.activeSkillSetDigest || "") || !Array.isArray(baseline.activeSkills)) return "Evolution baseline must contain an active Skill inventory and set digest.";
  if (baseline.activeSkills.some((entry) => !SAFE_ID.test(entry?.id || "") || !SHA256.test(entry?.bundleDigest || ""))) return "Evolution baseline active Skill inventory is invalid.";
  if (new Set(baseline.activeSkills.map((entry) => entry.id)).size !== baseline.activeSkills.length) return "Evolution baseline contains duplicate active Skill ids.";
  if (skillSetDigest(baseline.activeSkills) !== baseline.activeSkillSetDigest) return "Evolution baseline active Skill-set digest does not match its inventory.";
  if (empty && (baseline.targetSkillDigest !== null || baseline.activeSkills.length > 0)) return "Empty evolution baseline must have no target or active Skills.";
  if (!empty && !SHA256.test(baseline.targetSkillDigest || "")) return "Seeded evolution baseline must contain the target Skill digest.";
  const context = unwrap(skillContext);
  if (context && (context.workspaceId !== baseline.workspaceId || context.skills?.bundleDigest !== baseline.activeSkillSetDigest)) return "Skill context and evolution baseline do not describe the same workspace and active Skill set.";
  return null;
};

const auditExperiment = ({ tasks, targetSkill, skillContext, baseline, mode = "publishable", empty = false }) => {
  const blockers = [];
  const warnings = [];
  const strict = mode === "publishable";
  if (!new Set(["publishable", "smoke"]).has(mode)) blockers.push("Audit mode must be publishable or smoke.");
  if (!SAFE_ID.test(targetSkill || "")) blockers.push("Target Skill must be a safe Skill id.");
  if (skillContext) {
    const error = validateSkillContext(skillContext, targetSkill, empty);
    if (error) blockers.push(error);
  } else if (strict) blockers.push("Publishable experiments require a frozen active Skill context.");
  else warnings.push("Smoke has no frozen active Skill context; it cannot support candidate publication.");
  if (baseline) {
    const error = validateBaseline(baseline, targetSkill, skillContext, empty);
    if (error) blockers.push(error);
  } else if (strict) blockers.push("Publishable experiments require a frozen evolution baseline.");
  else warnings.push("Smoke has no frozen evolution baseline; it cannot support candidate publication.");
  if (!Array.isArray(tasks)) blockers.push("Experiment audit requires a canonically validated task array.");
  const splitCounts = Object.fromEntries(["train", "val", "test"].map((split) => [split, (tasks || []).filter((task) => task.split === split).length]));
  const operational = (tasks || []).some((task) => task?.evaluator?.capabilityRef === "builtin:operational-milestone-v1");
  if (operational && strict && (splitCounts.train < 2 || splitCounts.val < 2 || splitCounts.test < 1)) {
    blockers.push("Operational experiments require at least 2 train and 2 val episodes plus 1 held-out test episode.");
  }
  if (operational && strict) {
    const operationalTasks = (tasks || []).filter((task) => task?.evaluator?.capabilityRef === "builtin:operational-milestone-v1");
    const episodeRefs = [];
    for (const task of operationalTasks) {
      const metadata = task.operational;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
        || typeof metadata.episodeRef !== "string" || !metadata.episodeRef.trim()
        || !["terminal_success", "repair_progress"].includes(metadata.objective)
        || !Array.isArray(metadata.requiredMilestones)
        || metadata.requiredMilestones.length === 0
        || metadata.requiredMilestones.some((value) => typeof value !== "string" || !value)) {
        blockers.push(`${task.id}: operational metadata must declare episodeRef, objective, and requiredMilestones.`);
        continue;
      }
      episodeRefs.push(metadata.episodeRef);
      if (JSON.stringify(metadata.requiredMilestones) !== JSON.stringify(task.groundTruth?.milestoneOrder)) blockers.push(`${task.id}: public requiredMilestones differ from the private scorer milestoneOrder.`);
    }
    if (new Set(episodeRefs).size !== episodeRefs.length) blockers.push("Operational episodeRef values must be unique across splits.");
    if (!operationalTasks.some((task) => task.operational?.objective === "repair_progress")) blockers.push("Operational experiments require at least one repair_progress episode.");
    if (!operationalTasks.some((task) => ["val", "test"].includes(task.split) && task.operational?.objective === "terminal_success")) blockers.push("Operational experiments require at least one validation or test terminal_success episode.");
  }
  for (const [split, count] of Object.entries(splitCounts)) if (count === 1) warnings.push(`Dataset has only one ${split} task; treat results as a smoke unless independence is established externally.`);
  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], splitCounts };
};

module.exports = { auditExperiment };
