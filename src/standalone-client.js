"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function resolveStandaloneWikiSkillExecutable(env = process.env) {
  const configured = env.WIKISKILL_BIN?.trim();
  if (configured) return configured;
  const candidates = [
    env.JFT0M_RESOURCES_PATH?.trim()
      ? path.join(env.JFT0M_RESOURCES_PATH, "wikiskill", "bin", "wikiskill")
      : undefined,
    path.resolve(__dirname, "..", "bin", "wikiskill")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "wikiskill";
}

const execute = (executable, args) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

class WikiSkillStandaloneClient {
  constructor(options = {}) {
    this.executable = options.executable ?? resolveStandaloneWikiSkillExecutable();
    this.execute = options.execute ?? execute;
  }

  async invoke(args) {
    try {
      const result = await this.execute(this.executable, args);
      const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
      if (parsed && typeof parsed.success === "boolean" && Array.isArray(parsed.warnings) &&
          Array.isArray(parsed.blockers) && Array.isArray(parsed.nextActions)) {
        return {
          success: parsed.success && result.code === 0,
          data: parsed.data ?? null,
          warnings: parsed.warnings,
          blockers: result.code !== 0 && parsed.success
            ? [...parsed.blockers, `Standalone WikiSkill exited with code ${result.code}.`]
            : parsed.blockers,
          nextActions: parsed.nextActions
        };
      }
      return {
        success: false,
        data: null,
        warnings: [],
        blockers: [`Standalone WikiSkill executable is unavailable or returned invalid JSON: ${result.stderr.trim() || `exit ${result.code}`}`],
        nextActions: ["Install or configure the standalone WikiSkill executable, then retry."]
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        warnings: [],
        blockers: [`Standalone WikiSkill executable is unavailable: ${error instanceof Error ? error.message : String(error)}`],
        nextActions: ["Install or configure the standalone WikiSkill executable, then retry."]
      };
    }
  }
}

module.exports = { resolveStandaloneWikiSkillExecutable, WikiSkillStandaloneClient };
