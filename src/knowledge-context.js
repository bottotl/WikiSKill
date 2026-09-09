"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { constants } = require("node:fs");
const hash = value => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const safePath = relative => {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".wikiskill" || p.toLowerCase() === ".git")) throw new Error("Knowledge path escapes the frozen library.");
  return relative;
};
const readFile = async (root, relative) => {
  let current = root;
  for (const part of safePath(relative).split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Knowledge symlinks are forbidden.");
  }
  const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) throw new Error("Knowledge must be a regular file."); return await handle.readFile(); }
  finally { await handle.close(); }
};
const validateKnowledgeRef = value => {
  if (!value || typeof value.libraryId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u.test(value.libraryId) || !path.isAbsolute(value.rootPath || "") || !/^sha256:[a-f0-9]{64}$/u.test(value.digest || "") || !Array.isArray(value.deniedRoots) || !value.deniedRoots.length || value.deniedRoots.some(root => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("Invalid frozen TeamKnowledge reference.");
};
const prepareKnowledgeContext = async (ref, workdir, skills = {}) => {
  validateKnowledgeRef(ref);
  const manifest = JSON.parse(await readFile(ref.rootPath, ".jft0m-copy.json"));
  if (manifest.schema !== "jft0m.teamKnowledgeCopy.v1" || manifest.libraryId !== ref.libraryId || manifest.digest !== ref.digest || hash(JSON.stringify({ libraryId: manifest.libraryId, revision: manifest.revision, files: manifest.files })) !== ref.digest) throw new Error("Frozen TeamKnowledge manifest drift.");
  const root = path.join(workdir, ".jft0m", "knowledge", "sources", ref.libraryId);
  await fs.mkdir(root, { recursive: true });
  const inventory = new Map();
  for (const file of manifest.files) {
    const bytes = await readFile(ref.rootPath, file.path);
    if (hash(bytes) !== file.digest) throw new Error(`Frozen TeamKnowledge content drift: ${file.path}`);
    const destination = path.join(root, safePath(file.path));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
    inventory.set(file.path, file.digest);
  }
  for (const required of ["README.md", "indexes/disclosure.yaml"]) if (!inventory.has(required)) throw new Error(`Knowledge entry is missing: ${required}`);
  const skillRoot = path.join(workdir, ".jft0m", "skill-context");
  const skillEntries = [];
  for (const [id, files] of Object.entries({ ...(skills.target || {}), ...(skills.context || {}) })) {
    safePath(id);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(skillRoot, id, safePath(relative));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: "wx", mode: 0o444 });
    }
    skillEntries.push(`${id}: .jft0m/skill-context/${id}/SKILL.md`);
  }
  const exclude = path.join(workdir, ".git", "info", "exclude");
  await fs.appendFile(exclude, "\n/.jft0m/knowledge/\n/.jft0m/skill-context/\n");
  const token = crypto.randomBytes(24).toString("hex");
  const receipts = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/read") throw new Error("Only the frozen read endpoint is available.");
      const relative = safePath(url.searchParams.get("path"));
      const expected = inventory.get(relative);
      if (!expected) throw new Error("Path is not in the frozen knowledge inventory.");
      const bytes = await readFile(root, relative);
      if (hash(bytes) !== expected) throw new Error("Knowledge copy was modified.");
      const receipt = { id: crypto.randomUUID(), libraryId: ref.libraryId, path: relative, digest: expected, snapshotDigest: ref.digest };
      receipts.push(receipt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ receipt, content: bytes.toString("utf8") }));
    } catch (error) { res.writeHead(422, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  const instructions = [
    ...(skillEntries.length ? [`本轮 Skill 资源只读副本：\n${skillEntries.join("\n")}`] : []),
    `本任务绑定当前团队知识资料的冻结副本：${ref.libraryId}，版本摘要 ${ref.digest}。`,
    "本次训练的冻结绑定优先于历史代码中的 TeamKnowledge 真源定位指令；其余工程规则继续遵守。",
    "开始修改代码前，必须通过下列只读入口读取 README.md 和 indexes/disclosure.yaml，再按任务相关链接逐步读取资料。",
    `curl --fail --silent --get -H 'Authorization: Bearer ${token}' --data-urlencode 'path=README.md' http://127.0.0.1:${port}/read`,
    "读取其他资料时只替换 path 参数。响应含实际文件内容和执行器回执。引用资料时说明哪些判断受其影响；没有相关资料时如实说明。",
    "不得读取知识真源、演化 Wiki、学习轨迹、候选和私有评分材料；不能调用真源解析或其他服务绕过冻结资料入口。"
  ].join("\n");
  return {
    instructions,
    isolation: { deniedRoots: ref.deniedRoots, readerPort: port, privateProbe: path.join(ref.rootPath, ".jft0m-copy.json") },
    verify(events, evidence) {
      const seatbelt = evidence?.backend === "macos-seatbelt" && evidence.privateReadDenied === true;
      const codexWorkspace = evidence?.backend === "codex-workspace-write" && evidence.privateReadDenied === false && evidence.brokerNetworkEnabled === true;
      if (!seatbelt && !codexWorkspace) throw new Error("Inference did not run with a verified knowledge-consumption boundary.");
      const outputs = (events || []).filter(event => event.type === "tool_result").map(event => typeof event.output === "string" ? event.output : JSON.stringify(event.output)).join("\n");
      const observed = receipts.filter(receipt => outputs.includes(receipt.id));
      for (const required of ["README.md", "indexes/disclosure.yaml"]) if (!observed.some(receipt => receipt.path === required)) throw new Error(`Required TeamKnowledge consumption evidence is missing: ${required}`);
      return { schema: "wikiskill.knowledge-consumption.v1", libraryId: ref.libraryId, snapshotDigest: ref.digest, reads: observed, isolation: evidence };
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })
  };
};
module.exports = { validateKnowledgeRef, prepareKnowledgeContext };
