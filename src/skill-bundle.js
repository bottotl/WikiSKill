"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const sortFiles = (files) => Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));

const readSkillFiles = async (root) => {
  const files = {};
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill bundles do not allow symlinks: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files[path.relative(root, target).split(path.sep).join("/")] = await fs.readFile(target, "utf8");
    }
  };
  await walk(root);
  return files;
};

const skillBundleDigest = (files) => digest(json(sortFiles(files)));
const skillSetDigest = (inventory) => digest(json(inventory));
const initialPurpose = (sourcePath, baseDigest) => [
  "# Purpose",
  "",
  `- Source path: ${sourcePath}`,
  `- Base digest: ${baseDigest}`,
  "- Wiki pattern: none recorded at run creation.",
  ""
].join("\n");
const materializeSkillFiles = (files, sourcePath) => {
  if (Object.hasOwn(files, "PURPOSE.md")) return sortFiles(files);
  return sortFiles({ ...files, "PURPOSE.md": initialPurpose(sourcePath, skillBundleDigest(files)) });
};

module.exports = { initialPurpose, materializeSkillFiles, readSkillFiles, skillBundleDigest, skillSetDigest };
