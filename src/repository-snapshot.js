"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const { createInterface } = require("node:readline");
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
module.exports = { validateSnapshotRef, readRepositorySnapshot, materializeRepositorySnapshot, snapshotDependencyFiles };
