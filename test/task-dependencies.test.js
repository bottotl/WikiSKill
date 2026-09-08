const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareTaskDependencies } = require('../src/task-dependencies');

test('npm preparation uses the frozen lockfile without running package scripts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikiskill-dependencies-'));
  try {
    const manifest = JSON.stringify({name:'isolated-fixture',version:'1.0.0',scripts:{postinstall:'node -e "process.exit(42)"'}});
    const lock = JSON.stringify({name:'isolated-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'isolated-fixture',version:'1.0.0',hasInstallScript:true}}});
    await fs.writeFile(path.join(root,'package.json'),manifest);
    await fs.writeFile(path.join(root,'package-lock.json'),lock);
    const receipts = await prepareTaskDependencies(root,{'package.json':manifest,'package-lock.json':lock});
    assert.equal(receipts.length,1);
    assert.equal(receipts[0].exitCode,0);
    await assert.rejects(prepareTaskDependencies(root,{'package-lock.json':lock}),/requires frozen/);
    assert.deepEqual(await prepareTaskDependencies(root,{}),[]);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
