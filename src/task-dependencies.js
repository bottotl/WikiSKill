"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

// Only npm lockfiles explicitly frozen in the task sandbox select an installer.
async function prepareTaskDependencies(workdir, sandbox = {}) {
  const receipts = [];
  for (const relative of Object.keys(sandbox).filter((name) => path.posix.basename(name) === "package-lock.json").sort()) {
    const directory = path.posix.dirname(relative);
    const manifest = path.posix.join(directory, "package.json");
    if (typeof sandbox[relative] !== "string" || typeof sandbox[manifest] !== "string") throw new Error(`Dependency preparation requires frozen package.json and package-lock.json: ${directory}`);
    const cwd = path.resolve(workdir, directory);
    const remainder = path.relative(path.resolve(workdir), cwd);
    if (remainder === ".." || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) throw new Error("Dependency directory escapes task workspace.");
    const args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    const result = await new Promise((resolve, reject) => {
      const child = spawn("npm", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_update_notifier: "false" } });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
      const collect = (chunk) => { output = (output + chunk.toString()).slice(-65536); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
    });
    if (result.code !== 0) throw new Error(`Locked npm dependency preparation failed in ${directory}: ${result.signal || result.code}\n${result.output}`);
    if (await fs.readFile(path.join(workdir, relative), "utf8") !== sandbox[relative]) throw new Error("Dependency installation changed the frozen lockfile.");
    receipts.push({ directory, command: ["npm", ...args], exitCode: 0, lockDigest: `sha256:${crypto.createHash("sha256").update(sandbox[relative]).digest("hex")}` });
  }
  return receipts;
}
module.exports = { prepareTaskDependencies };
