import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { mergeOrderData, validateStoredOrderData } from '../src/order-data-sync.ts';

const data = (orders = {}) => ({
  version: 2,
  settings: { newItemPlacement: 'bottom', fallbackSort: 'name-last', persistOrderOnCreateDelete: true,
    enableDrag: true, guidBits: 64, scanDuplicateGuidsOnStartup: false, mergePairedFolderNotes: false },
  orderByFolder: orders, folderGuids: {}, fileGuids: {}, detachedFolderNotes: {},
  consumedManifestIds: [], guidBackups: [], folderNoteMergeOverrides: {}, transferReceipts: {},
});

test('three-way merge keeps independent folder edits and stops overlapping edits', () => {
  const base = data({ A: ['a', 'b'], B: ['c', 'd'] });
  const local = data({ A: ['b', 'a'], B: ['c', 'd'] });
  const disk = data({ A: ['a', 'b'], B: ['d', 'c'] });
  const merged = mergeOrderData(base, local, disk);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.data.orderByFolder, { A: ['b', 'a'], B: ['d', 'c'] });
  disk.orderByFolder.A = ['a'];
  const conflict = mergeOrderData(base, local, disk);
  assert.equal(conflict.data, null);
  assert.deepEqual(conflict.conflicts, ['orderByFolder.A']);
  const duplicate = mergeOrderData(data(), data(), data());
  assert.ok(duplicate.data);
  const localIdentity = data(); localIdentity.folderGuids.A = 'd-same';
  const diskIdentity = data(); diskIdentity.folderGuids.B = 'd-same';
  assert.deepEqual(mergeOrderData(data(), localIdentity, diskIdentity).conflicts, ['duplicateGuid.d-same']);
});

test('synced data validation rejects partial JSON and malformed mappings without discarding legacy data', () => {
  assert.throws(() => validateStoredOrderData('{'), SyntaxError);
  assert.throws(() => validateStoredOrderData('{}'), /缺少目录顺序/);
  assert.throws(() => validateStoredOrderData('{"version":3}'), /版本/);
  assert.throws(() => validateStoredOrderData('{"orderByFolder":{"x":"wrong"}}'), /目录顺序/);
  assert.throws(() => validateStoredOrderData('{"orderByFolder":{},"fileGuids":{"x":5}}'), /fileGuids/);
  assert.deepEqual(validateStoredOrderData('{"orderByFolder":{"__root__":["f-old"]}}').orderByFolder.__root__, ['f-old']);
  assert.deepEqual(validateStoredOrderData('\uFEFF{"orderByFolder":{}}').orderByFolder, {});
});

const compiled = await build({ entryPoints: ['main.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] });
class TFolder {}
class TFile {}
class Plugin {
  registerEvent() {}
  registerDomEvent() {}
  addCommand() {}
  addSettingTab() {}
  registerInterval(id) { clearInterval(id); }
}
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, crypto, btoa,
  TextEncoder, TextDecoder, document: { visibilityState: 'visible' },
  window: { setTimeout, clearTimeout, setInterval, clearInterval },
  require: () => ({ Plugin, TFolder, TFile, Modal: class {}, PluginSettingTab: class {},
    Notice: class {}, normalizePath: value => value, parseYaml: () => ({}), stringifyYaml: () => '' }),
});
const PluginClass = module.exports.default;

function fixture(initial) {
  const dataPath = '.obsidian/plugins/yuque-sorting/data.json';
  const files = new Map(initial === null ? [] : [[dataPath, initial]]);
  let writes = 0;
  const adapter = {
    exists: async path => files.has(path),
    read: async path => files.get(path),
    write: async (path, value) => { files.set(path, value); writes++; },
    process: async (path, callback) => { const next = callback(files.get(path)); files.set(path, next); writes++; return next; },
  };
  const plugin = new PluginClass();
  plugin.manifest = { id: 'yuque-sorting' };
  plugin.app = { vault: { configDir: '.obsidian', adapter, getAllLoadedFiles: () => [Object.assign(new TFolder(), { path: '', children: [] })] } };
  plugin.setupExplorer = () => {};
  plugin.refreshExplorer = () => {};
  plugin.clearUndoHistory = () => {};
  plugin.showStorageConflict = () => {};
  return { plugin, files, get raw() { return files.get(dataPath) ?? null; },
    set raw(value) { if (value === null) files.delete(dataPath); else files.set(dataPath, value); },
    get writes() { return writes; } };
}

test('first startup without data waits; a synced file is adopted without an empty local write', async () => {
  const state = fixture(null);
  await state.plugin.loadInitialOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'waiting');
  await state.plugin.reconcileVault(false);
  assert.equal(state.writes, 0);
  state.raw = JSON.stringify(data({ __root__: ['remote-first', 'remote-second'] }));
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'ready');
  assert.deepEqual(Array.from(state.plugin.data.orderByFolder.__root__), ['remote-first', 'remote-second']);
  assert.equal(state.writes, 0);
});

test('full plugin startup with no data does not create a competing file', async () => {
  const state = fixture(null);
  state.plugin.app.vault.on = () => ({});
  state.plugin.app.workspace = { layoutReady: true, on: () => ({}), onLayoutReady: callback => callback() };
  await state.plugin.onload();
  assert.equal(state.plugin.getOrderDataStatus(), 'waiting');
  assert.equal(state.writes, 0);
});

test('full plugin startup with existing synced data adopts it without replacing it', async () => {
  const original = JSON.stringify(data({ __root__: ['remote-first'] }));
  const state = fixture(original);
  state.plugin.app.vault.on = () => ({});
  state.plugin.app.workspace = { layoutReady: true, on: () => ({}), onLayoutReady: callback => callback() };
  await state.plugin.onload();
  assert.equal(state.plugin.getOrderDataStatus(), 'ready');
  assert.deepEqual(Array.from(state.plugin.data.orderByFolder.__root__), ['remote-first']);
  assert.equal(state.raw, original);
  assert.equal(state.writes, 0);
});

test('explicit local initialization writes only after user action', async () => {
  const state = fixture(null);
  await state.plugin.loadInitialOrderData();
  await state.plugin.initializeLocalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'ready');
  assert.equal(state.writes, 1);
  assert.equal(JSON.parse(state.raw).version, 2);
});

test('external change and a different local folder change merge before saving', async () => {
  const state = fixture(JSON.stringify(data({ A: ['a', 'b'], B: ['c', 'd'] })));
  await state.plugin.loadInitialOrderData();
  state.plugin.data.orderByFolder.A = ['b', 'a'];
  state.raw = JSON.stringify(data({ A: ['a', 'b'], B: ['d', 'c'] }));
  await state.plugin.persistOrderData();
  assert.deepEqual(JSON.parse(state.raw).orderByFolder, { A: ['b', 'a'], B: ['d', 'c'] });
  assert.equal(state.writes, 1);
  if (state.plugin.saveTimer !== null) clearTimeout(state.plugin.saveTimer);
});

test('an external update between read and atomic write is never overwritten', async () => {
  const state = fixture(JSON.stringify(data({ A: ['a', 'b'] })));
  await state.plugin.loadInitialOrderData();
  state.plugin.data.orderByFolder.A = ['b', 'a'];
  const cloud = JSON.stringify(data({ A: ['a'] }));
  state.plugin.app.vault.adapter.process = async (path, callback) => {
    state.raw = cloud;
    callback(state.raw);
  };
  await assert.rejects(state.plugin.persistOrderData(), /保存时排序数据又被外部更新/);
  assert.equal(state.raw, cloud);
  assert.equal(state.writes, 0);
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'blocked');
});

test('same-folder conflict, missing file and invalid JSON never overwrite disk', async () => {
  const initial = JSON.stringify(data({ A: ['a', 'b'] }));
  const conflict = fixture(initial);
  await conflict.plugin.loadInitialOrderData();
  conflict.plugin.data.orderByFolder.A = ['b', 'a'];
  conflict.raw = JSON.stringify(data({ A: ['a'] }));
  await assert.rejects(conflict.plugin.persistOrderData(), /冲突/);
  assert.equal(conflict.plugin.getOrderDataStatus(), 'blocked');
  assert.equal(conflict.writes, 0);

  for (const replacement of [null, '{']) {
    const state = fixture(initial);
    await state.plugin.loadInitialOrderData();
    state.raw = replacement;
    await assert.rejects(state.plugin.persistOrderData(), /冲突/);
    assert.equal(state.plugin.getOrderDataStatus(), 'blocked');
    assert.equal(state.writes, 0);
    assert.equal(state.raw, replacement);
  }
});

test('a partial sync write is ignored until the file becomes valid and stable', async () => {
  const state = fixture(null);
  await state.plugin.loadInitialOrderData();
  state.raw = '{';
  setTimeout(() => { state.raw = JSON.stringify(data({ __root__: ['from-cloud'] })); }, 100);
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'waiting');
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'ready');
  assert.equal(state.writes, 0);
});

test('invalid external JSON pauses writes and a later valid version resumes', async () => {
  const state = fixture(JSON.stringify(data({ __root__: ['old'] })));
  await state.plugin.loadInitialOrderData();
  state.raw = '{';
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'blocked');
  assert.equal(state.writes, 0);
  state.raw = JSON.stringify(data({ __root__: ['new'] }));
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'ready');
  assert.deepEqual(Array.from(state.plugin.data.orderByFolder.__root__), ['new']);
});

test('file deletion during a sync pause is replayed after valid data returns', async () => {
  const original = data({ __root__: ['f-old', 'f-keep'] });
  original.fileGuids['old.pdf'] = 'f-old';
  const state = fixture(JSON.stringify(original));
  state.plugin.app.workspace = { layoutReady: true };
  state.plugin.app.vault.getAbstractFileByPath = () => null;
  await state.plugin.loadInitialOrderData();
  state.raw = '{';
  await state.plugin.checkExternalOrderData();
  const deletedFile = Object.assign(new TFile(), { path: 'old.pdf', extension: 'pdf' });
  await state.plugin.handleDelete(deletedFile);
  state.raw = JSON.stringify(original);
  await state.plugin.checkExternalOrderData();
  assert.equal(state.plugin.getOrderDataStatus(), 'ready');
  assert.deepEqual(Array.from(state.plugin.data.orderByFolder.__root__), ['f-keep']);
  assert.equal(state.plugin.data.fileGuids['old.pdf'], undefined);
  if (state.plugin.saveTimer !== null) clearTimeout(state.plugin.saveTimer);
});

test('drag is rejected before touching files while initial sync is pending', async () => {
  const state = fixture(null);
  await state.plugin.loadInitialOrderData();
  let drops = 0;
  state.plugin.executeDrop = async () => { drops++; };
  await state.plugin.handleDrop('a.md', 'b.md', 'before');
  assert.equal(drops, 0);
  assert.equal(state.writes, 0);
});

test('both explicit conflict choices back up the discarded version first', async () => {
  for (const choice of ['disk', 'local']) {
    const state = fixture(JSON.stringify(data({ A: ['a', 'b'] })));
    await state.plugin.loadInitialOrderData();
    state.plugin.data.orderByFolder.A = ['b', 'a'];
    const cloud = JSON.stringify(data({ A: ['a'] }));
    state.raw = cloud;
    await assert.rejects(state.plugin.persistOrderData(), /冲突/);
    await state.plugin.resolveStorageConflict(choice);
    const backups = [...state.files].filter(([path]) => path.includes('data-recovery-'));
    assert.equal(backups.length, 1);
    assert.equal(state.plugin.getOrderDataStatus(), 'ready');
    assert.deepEqual(JSON.parse(state.raw).orderByFolder.A, choice === 'disk' ? ['a'] : ['b', 'a']);
    assert.deepEqual(JSON.parse(backups[0][1]).orderByFolder.A, choice === 'disk' ? ['b', 'a'] : ['a']);
  }
});
