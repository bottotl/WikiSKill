"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const { createInterface } = require("node:readline");
const safeRelative = value => {
  if (typeof value !== "string" || !value || value.includes("\\") || path.isAbsolute(value) || value.includes("\0") || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Repository snapshot inventory paths must be safe relative paths.");
  return value;
};
const validateSnapshotRef = ref => {
  if (!ref || Object.keys(ref).sort().join(",") !== "digest,path" || !path.isAbsolute(ref.path || "") || !/^sha256:[a-f0-9]{64}$/u.test(ref.digest || "")) throw new Error("Invalid repositorySnapshot reference.");
};
async function* readRepositorySnapshot(ref) {
  validateSnapshotRef(ref);
  const handle = await fs.open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Repository snapshot must be a regular file.");
    const hash = crypto.createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    if (`sha256:${hash.digest("hex")}` !== ref.digest) throw new Error("Repository snapshot digest drift.");
    const stream = handle.createReadStream({ start: 0, autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let first = true; const names = new Set();
    try {
      for await (const line of lines) {
        const file = JSON.parse(line);
        if (first) { if (file.schema !== "wikiskill.repository-snapshot.v1") throw new Error("Invalid repository snapshot."); first = false; continue; }
        if (typeof file.path !== "string" || !file.path || file.path.includes("\\") || path.isAbsolute(file.path) || file.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || file.path.includes("\0") || names.has(file.path)) throw new Error("Unsafe repository snapshot path.");
        if (!["100644", "100755"].includes(file.mode) || typeof file.content !== "string" || Buffer.from(file.content, "base64").toString("base64") !== file.content) throw new Error("Unsupported repository snapshot entry.");
        names.add(file.path); yield file;
      }
      if (first) throw new Error("Repository snapshot is empty.");
    } finally { lines.close(); stream.destroy(); }
  } finally { await handle.close(); }
}
const materializeRepositorySnapshot = async (root, ref) => {
  for await (const file of readRepositorySnapshot(ref)) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(file.content, "base64"), { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
};
const snapshotDependencyFiles = async ref => {
  const files = {};
  for await (const file of readRepositorySnapshot(ref)) if (["package.json", "package-lock.json"].includes(path.posix.basename(file.path))) files[file.path] = Buffer.from(file.content, "base64").toString("utf8");
  return files;
};
const createRepositorySnapshot = async ({ root: rootInput, output: outputInput, paths }) => {
  if (!path.isAbsolute(rootInput || "") || !path.isAbsolute(outputInput || "")) throw new Error("Repository snapshot root and output must be absolute paths.");
  const root = await fs.realpath(rootInput);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Repository snapshot root must be a non-symlink directory.");
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("Repository snapshot inventory must list at least one path.");
  const inventory = [...new Set(paths.map(safeRelative))].sort();
  if (inventory.length !== paths.length) throw new Error("Repository snapshot inventory paths must be unique.");
  const entries = [];
  for (const relative of inventory) {
    const target = path.join(root, relative);
    const real = await fs.realpath(target).catch(() => null);
    const stat = await fs.lstat(target).catch(() => null);
    if (!real || real !== target || !stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Repository snapshot path must be an existing regular non-symlink file: ${relative}`);
    entries.push({ relative, target, mode: stat.mode & 0o111 ? "100755" : "100644" });
  }
  const output = path.resolve(outputInput);
  if (await fs.access(output).then(() => true, () => false)) throw new Error("Repository snapshot output already exists.");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${crypto.randomUUID()}.tmp`);
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const append = async value => { const bytes = Buffer.from(value, "utf8"); hash.update(bytes); await handle.write(bytes); };
  try {
    await append(`${JSON.stringify({ schema: "wikiskill.repository-snapshot.v1" })}\n`);
    for (const entry of entries) {
      const content = await fs.readFile(entry.target);
      await append(`${JSON.stringify({ path: entry.relative, mode: entry.mode, content: content.toString("base64") })}\n`);
    }
    await handle.sync();
    await handle.close();
    await fs.link(temporary, output);
    await fs.rm(temporary);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { schema: "wikiskill.repository-snapshot-receipt.v1", path: output, digest: `sha256:${hash.digest("hex")}`, fileCount: entries.length };
};
module.exports = { createRepositorySnapshot, validateSnapshotRef, readRepositorySnapshot, materializeRepositorySnapshot, snapshotDependencyFiles };
