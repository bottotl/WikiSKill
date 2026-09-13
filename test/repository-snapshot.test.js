"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRepositorySnapshot, materializeRepositorySnapshot } = require("../src/repository-snapshot");
const { execute } = require("../src/cli");

test("creates a deterministic binary-safe repository snapshot from an explicit inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-source-"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-output-"));
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "script.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 255, 1]));
  const output = path.join(outputRoot, "snapshot.jsonl");

  const result = await createRepositorySnapshot({ root, output, paths: ["nested/script.sh", "binary.bin"] });
  assert.equal(result.fileCount, 2);
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/u);

  const restored = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-restored-"));
  await materializeRepositorySnapshot(restored, { path: output, digest: result.digest });
  assert.deepEqual(await fs.readFile(path.join(restored, "binary.bin")), Buffer.from([0, 255, 1]));
  assert.ok((await fs.stat(path.join(restored, "nested", "script.sh"))).mode & 0o111);
});

test("repository snapshot refuses symlinks and implicit directory traversal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-source-"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-output-"));
  await fs.writeFile(path.join(root, "outside.txt"), "outside\n");
  await fs.symlink("outside.txt", path.join(root, "link.txt"));
  await assert.rejects(createRepositorySnapshot({ root, output: path.join(outputRoot, "snapshot.jsonl"), paths: ["link.txt"] }), /regular non-symlink file/u);
  await assert.rejects(createRepositorySnapshot({ root, output: path.join(outputRoot, "snapshot-2.jsonl"), paths: ["../outside.txt"] }), /safe relative/u);
});

test("public CLI creates a repository snapshot from a frozen inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-source-"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-snapshot-output-"));
  await fs.writeFile(path.join(root, "input.txt"), "frozen\n");
  const inventory = path.join(outputRoot, "inventory.json");
  const output = path.join(outputRoot, "snapshot.jsonl");
  await fs.writeFile(inventory, JSON.stringify({ schema: "wikiskill.repository-snapshot-inventory.v1", paths: ["input.txt"] }));
  const lines = [];
  const code = await execute(["repository", "snapshot", "--repo", root, "--inventory", inventory, "--output", output, "--json"], { stdout: line => lines.push(line), stderr: () => {} });
  assert.equal(code, 0, lines.join(""));
  const result = JSON.parse(lines.join(""));
  assert.equal(result.success, true);
  assert.equal(result.data.fileCount, 1);
  assert.equal(result.data.path, output);
});
