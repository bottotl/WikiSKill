"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const literal = value => JSON.stringify(value);
const subpath = value => `(subpath ${literal(value)})`;
const resolveExecutable = async executable => {
  if (path.isAbsolute(executable)) return fs.realpath(executable);
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(directory, executable);
    if (await fs.access(file, require("node:fs").constants.X_OK).then(() => true, () => false)) return fs.realpath(file);
  }
  throw new Error(`Inference executable is unavailable: ${executable}`);
};
const prepareIsolatedCommand = async ({ executable, args, workdir, environment, isolation, temporaryRoot, provider }) => {
  if (!isolation) return { executable, args, environment };
  if (process.platform !== "darwin" || !await fs.access("/usr/bin/sandbox-exec").then(() => true, () => false)) throw new Error("Knowledge-isolated inference requires the macOS sandbox-exec backend; no permissive fallback is allowed.");
  const binary = await resolveExecutable(executable);
  const root = await fs.realpath(workdir);
  const temporary = await fs.realpath(temporaryRoot);
  const configRoot = path.join(temporary, "provider");
  await fs.mkdir(configRoot, { recursive: true });
  const providerEnv = { ...environment, TMPDIR: temporary };
  // Carry credentials, never source sessions, MCP configuration, skills or memory.
  if (provider === "codex") {
    const original = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    for (const name of ["auth.json"]) {
      await fs.copyFile(path.join(original, name), path.join(configRoot, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    providerEnv.CODEX_HOME = configRoot;
  } else {
    const original = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    await fs.copyFile(path.join(original, ".credentials.json"), path.join(configRoot, ".credentials.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    providerEnv.CLAUDE_CONFIG_DIR = configRoot;
  }
  const readable = [root, temporary, "/System", "/usr", "/bin", "/sbin", "/Library", "/dev", "/private/etc", "/private/preboot", "/private/var/db/dyld", "/opt/homebrew", path.dirname(binary)];
  const exclusions = readable.map(item => `(require-not ${subpath(item)})`).join(" ");
  const profile = [
    "(version 1)", "(allow default)",
    `(deny file-read-data (require-all (require-not (literal "/")) ${exclusions}))`,
    `(deny file-write* (require-all (require-not ${subpath(root)}) (require-not ${subpath(temporary)}) (require-not (subpath "/dev"))))`,
    `(deny file-write* ${subpath(path.join(root, ".jft0m", "knowledge"))})`,
    `(deny file-write* ${subpath(path.join(root, ".jft0m", "skill-context"))})`,
    // Even when a development executable lives under a protected tree, deny its private siblings.
    ...isolation.deniedRoots.map(item => `(deny file-read* (require-all ${subpath(item)} (require-not ${subpath(root)}) (require-not ${subpath(temporary)})))`),
    '(deny network-outbound (remote ip "localhost:*"))',
    `(allow network-outbound (remote ip "localhost:${isolation.readerPort}"))`,
    '(deny file-read* (regex "/[.][wW][iI][kK][iI][sS][kK][iI][lL][lL](/|$)"))',
    "(deny mach-lookup)",
    '(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.networkd") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))',
    "(deny process-info*)",
    "(allow process-info* (target self))",
    "(deny appleevent-send)",
    "(deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\"))"
  ].join("\n");
  const profilePath = path.join(temporary, "inference.sb");
  await fs.writeFile(profilePath, profile);
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, "/bin/cat", isolation.privateProbe], { encoding: "utf8" });
  if (probe.error || probe.status === 0 || !probe.stderr.includes("Operation not permitted")) throw new Error(`Inference isolation preflight failed: ${probe.stderr || probe.error?.message || `probe status=${probe.status} signal=${probe.signal}`}`);
  return { executable: "/usr/bin/sandbox-exec", args: ["-f", profilePath, binary, ...args], environment: providerEnv, isolationEvidence: { backend: "macos-seatbelt", privateReadDenied: true } };
};
module.exports = { prepareIsolatedCommand };
