import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const compiled = await build({ entryPoints: ['main.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] });
class TFolder {}
class TFile {}
class Plugin {
  registerDomEvent(_document, name, callback) { this.handlers[name] = callback; }
}
const module = { exports: {} };
const document = {};
const modalChoice = { accept: true, copyMode: 'number' };
const confirmationMessages = [];
const simpleYaml = text => Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes(':')).map(line => {
  const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}));
vm.runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, document, console, setTimeout,
  crypto, btoa, TextEncoder, TextDecoder, window: { setTimeout, clearTimeout, require: name => name === 'fs' ? fs : path },
  require: () => ({ Plugin, TFolder, TFile, Modal: class { open() {
    if (this.resolveChoice) { confirmationMessages.push(this.message); modalChoice.beforeResolve?.(); }
    this.resolveChoice?.(modalChoice.accept);
    this.resolveChoices?.(modalChoice.accept ? new Map(this.names.map(name => [name, { mode: modalChoice.copyMode }])) : null);
  } }, PluginSettingTab: class {}, Notice: class {}, normalizePath: value => value,
  parseYaml: simpleYaml, stringifyYaml: value => Object.entries(value).map(([key, val]) => `${key}: ${val}`).join('\n') }),
});
const PluginClass = module.exports.default;
function fixture() {
  const plugin = new PluginClass();
  plugin.handlers = {};
  plugin.data = { settings: { enableDrag: true, newItemPlacement: 'bottom', guidBits: 64 }, orderByFolder: {}, folderGuids: {}, fileGuids: {} };
  plugin.getExplorerContainer = () => null;
  plugin.explorerItem = target => target;
  plugin.pathFromElement = item => item.path;
  plugin.clearDragState = () => { plugin.dragSourcePath = ''; };
  plugin.dropPosition = () => 'after';
  plugin.queueSave = () => {};
  plugin.refreshExplorer = () => {};
  plugin.app = { workspace: { layoutReady: true } };
  return plugin;
}

async function autoCopyFixture(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yq-plugin-copy-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('yq-plugin-copy-'));
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, 'source'), target = path.join(dir, 'target');
  await fs.promises.mkdir(source);
  const backupBase = path.join(target, '.obsidian', 'plugins', 'yuque-order-drag');
  await fs.promises.mkdir(backupBase, { recursive: true });
  await fs.promises.writeFile(path.join(target, 'keep.md'), '---\nguid: f-keep\n---\nkeep');
  await fs.promises.writeFile(path.join(target, 'last.md'), '---\nguid: f-last\n---\nlast');
  await fs.promises.writeFile(path.join(source, 'new.md'), '---\nguid: f-new\n---\nnew');
  const plugin = fixture(); plugin.data.orderByFolder.__root__ = ['f-last', 'f-keep'];
  plugin.data.folderNoteMergeOverrides = {}; plugin.manifest = { id: 'yuque-order-drag' };
  plugin.app.workspace.iterateAllLeaves = () => {};
  const index = () => {
    const root = Object.assign(new TFolder(), { path: '/', name: '', children: [] });
    const items = [root], pending = [root];
    while (pending.length) {
      const parent = pending.pop();
      const relative = parent.path === '/' ? '' : parent.path;
      for (const name of fs.readdirSync(path.join(target, relative))) {
        if (name.startsWith('.')) continue;
        const rel = relative ? relative + '/' + name : name;
        const stat = fs.statSync(path.join(target, rel));
        const item = Object.assign(stat.isDirectory() ? new TFolder() : new TFile(), { path: rel, name, parent });
        if (item instanceof TFolder) { item.children = []; pending.push(item); }
        else { item.extension = path.extname(name).slice(1); item.stat = { size: stat.size, mtime: stat.mtimeMs }; }
        parent.children.push(item); items.push(item);
      }
    }
    return items;
  };
  plugin.app.vault = { configDir: '.obsidian', adapter: { getBasePath: () => target },
    getAllLoadedFiles: index, getRoot: () => index()[0], getAbstractFileByPath: rel => index().find(item => item.path === rel),
    read: file => fs.promises.readFile(path.join(target, file.path), 'utf8') };
  plugin.app.metadataCache = { getFileCache: file => ({ frontmatter: simpleYaml(fs.readFileSync(path.join(target, file.path), 'utf8')) }) };
  plugin.flushSave = async () => {};
  let saves = 0, refreshes = 0;
  plugin.saveData = async () => { saves++; };
  plugin.refreshExplorer = () => { refreshes++; };
  return { plugin, source, target, backupBase, counts: () => ({ saves, refreshes }) };
}

test('automatic copy installs content at configured position, keeps source unchanged and commits once', async t => {
  const { plugin, source, target, counts } = await autoCopyFixture(t);
  await plugin.copyLocalDirectory(source, '');
  assert.equal(await fs.promises.readFile(path.join(source, 'new.md'), 'utf8'), '---\nguid: f-new\n---\nnew');
  assert.equal(await fs.promises.readFile(path.join(target, 'new.md'), 'utf8'), '---\nguid: f-new\n---\nnew');
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['f-last', 'f-keep', 'f-new']);
  assert.deepEqual(counts(), { saves: 1, refreshes: 1 });
  assert.equal(plugin.autoCopyPreparing, false);
});
test('automatic replacement retains sibling slot and backs up the replaced file', async t => {
  const { plugin, source, target, backupBase } = await autoCopyFixture(t);
  await fs.promises.rename(path.join(source, 'new.md'), path.join(source, 'keep.md'));
  modalChoice.copyMode = 'replace';
  try { await plugin.copyLocalDirectory(source, ''); } finally { modalChoice.copyMode = 'number'; }
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['f-last', 'f-new']);
  assert.equal(await fs.promises.readFile(path.join(target, 'keep.md'), 'utf8'), '---\nguid: f-new\n---\nnew');
  const job = (await fs.promises.readdir(backupBase)).find(name => name.startsWith('local-copy-'));
  assert.equal(await fs.promises.readFile(path.join(backupBase, job, 'originals', 'keep.md'), 'utf8'), '---\nguid: f-keep\n---\nkeep');
});
test('automatic copy cancellation creates neither files nor recovery directory', async t => {
  const { plugin, source, target, backupBase, counts } = await autoCopyFixture(t);
  modalChoice.accept = false;
  try { await plugin.copyLocalDirectory(source, ''); } finally { modalChoice.accept = true; }
  assert.equal(fs.existsSync(path.join(target, 'new.md')), false);
  assert.deepEqual(await fs.promises.readdir(backupBase), []);
  assert.deepEqual(counts(), { saves: 0, refreshes: 0 });
});
test('repeating automatic copy numbers the incoming duplicate and assigns a distinct GUID', async t => {
  const { plugin, source, target } = await autoCopyFixture(t);
  await plugin.copyLocalDirectory(source, '');
  await plugin.copyLocalDirectory(source, '');
  const text = await fs.promises.readFile(path.join(target, '001-new.md'), 'utf8');
  assert.match(text, /guid: f-[A-Za-z0-9]+/); assert.ok(!text.includes('guid: f-new\n'));
  assert.equal(new Set(plugin.data.orderByFolder.__root__).size, 4);
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__).slice(0, 3), ['f-last', 'f-keep', 'f-new']);
});
test('automatic copy failed data save restores target contents and original order', async t => {
  const { plugin, source, target } = await autoCopyFixture(t);
  const before = JSON.stringify(plugin.data); let calls = 0;
  plugin.saveData = async () => { if (++calls === 1) throw new Error('disk full'); };
  await assert.rejects(plugin.copyLocalDirectory(source, ''), /已回滚/);
  assert.equal(fs.existsSync(path.join(target, 'new.md')), false);
  assert.equal(JSON.stringify(plugin.data), before);
  assert.equal(plugin.transferInProgress, false);
});
test('automatic copy rejects overlapping source and target before creating a backup', async t => {
  const { plugin, target, backupBase } = await autoCopyFixture(t);
  await assert.rejects(plugin.copyLocalDirectory(target, ''), /互相包含/);
  assert.deepEqual(await fs.promises.readdir(backupBase), []);
});
async function manifestFixture(t) {
  const state = await autoCopyFixture(t);
  const { plugin, target } = state;
  await fs.promises.mkdir(path.join(target, 'kb'));
  await fs.promises.writeFile(path.join(target, 'kb', 'a.md'), '---\nguid: f-aaaaaaaaaaa\n---\na');
  await fs.promises.writeFile(path.join(target, 'kb', 'b.md'), '---\nguid: f-bbbbbbbbbbb\n---\nb');
  await fs.promises.writeFile(path.join(target, 'kb', '_yuque_order.json'), JSON.stringify({ version: 2, exportId: 'test-export', guidBits: 64, resources: [], directories: [{ path: '', items: [
    { path: 'b.md', kind: 'file', guid: 'f-bbbbbbbbbbb' }, { path: 'a.md', kind: 'file', guid: 'f-aaaaaaaaaaa' },
  ] }] }));
  plugin.data.folderGuids.kb = 'd-kkkkkkkkkkk';
  plugin.data.fileGuids['kb/_yuque_order.json'] = 'f-manifest';
  plugin.data.orderByFolder['d-kkkkkkkkkkk'] = ['f-aaaaaaaaaaa', 'f-bbbbbbbbbbb', 'f-manifest'];
  plugin.data.consumedManifestIds = ['test-export'];
  plugin.app.vault.getFiles = () => plugin.app.vault.getAllLoadedFiles().filter(item => item instanceof TFile);
  plugin.forceSave = () => plugin.saveData(plugin.data);
  return state;
}
test('manifest restore always previews order differences and cancellation writes nothing', async t => {
  const { plugin, counts } = await manifestFixture(t);
  const before = JSON.stringify(plugin.data);
  modalChoice.accept = false;
  try { await plugin.requestManifestImport(); } finally { modalChoice.accept = true; }
  assert.equal(JSON.stringify(plugin.data), before);
  assert.deepEqual(counts(), { saves: 0, refreshes: 0 });
  assert.match(confirmationMessages.at(-1), /1 个目录的顺序将变化/);
  assert.match(confirmationMessages.at(-1), /当前 \[a.md → b.md/);
  assert.match(confirmationMessages.at(-1), /恢复后 \[b.md → a.md/);
});
test('confirmed manifest restore applies order and unchanged order still asks for confirmation', async t => {
  const { plugin, counts } = await manifestFixture(t);
  await plugin.requestManifestImport();
  assert.deepEqual(Array.from(plugin.data.orderByFolder['d-kkkkkkkkkkk']).slice(0, 2), ['f-bbbbbbbbbbb', 'f-aaaaaaaaaaa']);
  assert.deepEqual(counts(), { saves: 1, refreshes: 1 });
  modalChoice.accept = false;
  try { await plugin.requestManifestImport(); } finally { modalChoice.accept = true; }
  assert.match(confirmationMessages.at(-1), /0 个目录的顺序将变化/);
  assert.deepEqual(counts(), { saves: 1, refreshes: 1 });
});
test('manifest restore does not apply a preview after the user changes order during confirmation', async t => {
  const { plugin, counts } = await manifestFixture(t);
  modalChoice.beforeResolve = () => { plugin.data.orderByFolder['d-kkkkkkkkkkk'] = ['f-manifest', 'f-aaaaaaaaaaa', 'f-bbbbbbbbbbb']; };
  try { await plugin.requestManifestImport(); } finally { delete modalChoice.beforeResolve; }
  assert.equal(plugin.data.orderByFolder['d-kkkkkkkkkkk'][0], 'f-manifest');
  assert.deepEqual(counts(), { saves: 0, refreshes: 0 });
});
test('manifest restore reports unreadable manifests as unparseable without format jargon', async (t) => {
  const { plugin, target } = await manifestFixture(t);
  await fs.promises.mkdir(path.join(target, 'kb', 'legacy'));
  await fs.promises.writeFile(path.join(target, 'kb', 'legacy', '_yuque_order.json'), JSON.stringify({ version: 1, tree: [] }));
  await fs.promises.mkdir(path.join(target, 'kb', 'broken'));
  await fs.promises.writeFile(path.join(target, 'kb', 'broken', '_yuque_order.json'), '{ oops');
  modalChoice.accept = false;
  try { await plugin.requestManifestImport(); } finally { modalChoice.accept = true; }
  const message = confirmationMessages.at(-1);
  assert.match(message, /kb\/legacy\/_yuque_order\.json：无法解析/);
  assert.match(message, /kb\/broken\/_yuque_order\.json：无法解析/);
  assert.doesNotMatch(message, /v2/);
  // 已消费清单再次执行时只按路径匹配，文案必须把这一点和它的后果说清楚。
  assert.match(message, /匹配只看清单中的路径/);
  assert.match(message, /同一路径若已换成另一个文件/);
});
test('absolute missing nested target is created with GUIDs and keeps root siblings in place', async t => {
  const { plugin, source, target, counts } = await autoCopyFixture(t);
  await plugin.copyLocalDirectory(source, path.join(target, 'notes', 'imported'));
  assert.equal(fs.existsSync(path.join(target, 'notes', 'imported', 'new.md')), true);
  const first = plugin.data.folderGuids.notes, second = plugin.data.folderGuids['notes/imported'];
  assert.match(first, /^d-/); assert.match(second, /^d-/);
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['f-last', 'f-keep', first]);
  assert.deepEqual(Array.from(plugin.data.orderByFolder[first]), [second]);
  assert.deepEqual(Array.from(plugin.data.orderByFolder[second]), ['f-new']);
  assert.deepEqual(counts(), { saves: 1, refreshes: 1 });
});
test('cancel does not create missing destination and failed save removes only new empty directories', async t => {
  const { plugin, source, target } = await autoCopyFixture(t);
  modalChoice.accept = false;
  try { await plugin.copyLocalDirectory(source, 'new/nested'); } finally { modalChoice.accept = true; }
  assert.equal(fs.existsSync(path.join(target, 'new')), false);
  let calls = 0; plugin.saveData = async () => { if (++calls === 1) throw new Error('disk full'); };
  await assert.rejects(plugin.copyLocalDirectory(source, 'new/nested'), /已回滚/);
  assert.equal(fs.existsSync(path.join(target, 'new')), false);
  assert.equal(fs.existsSync(path.join(target, 'keep.md')), true);
});


test('index audit excludes slash root and preserves its legacy ordering key', async () => {
  const plugin = fixture();
  const root = Object.assign(new TFolder(), { path: '/', parent: null });
  const folder = Object.assign(new TFolder(), { path: 'book', parent: root });
  const file = Object.assign(new TFile(), { path: 'book/a.png', extension: 'png', parent: folder });
  plugin.app.vault = { getAllLoadedFiles: () => [root, folder, file] };
  plugin.data.folderGuids = { '/': 'legacy-root', book: 'folder' };
  plugin.data.fileGuids = { 'book/a.png': 'file' };
  plugin.data.orderByFolder = { 'legacy-root': ['folder'], folder: ['file'] };
  assert.equal(plugin.collectUnindexedItems().length, 0);
  assert.equal(await plugin.ensureFolderGuid(root), null);
  assert.deepEqual(Array.from(plugin.data.orderByFolder['legacy-root']), ['folder']);
  plugin.data.orderByFolder.folder = [];
  assert.deepEqual(Array.from(plugin.collectUnindexedItems(), item => item.path), ['book/a.png']);
});

test('owned drag events cannot reach native folder drag handlers; only the selected file is submitted', async () => {
  const plugin = fixture();
  plugin.installDragHandlers();
  let stopped = 0;
  const event = { target: { path: 'A/file.md', classList: { add() {} } }, dataTransfer: { setData() {} }, stopImmediatePropagation() { stopped++; }, preventDefault() {} };
  plugin.handlers.dragstart(event);
  let args;
  plugin.handleDrop = async (...values) => { args = values; };
  plugin.handlers.drop({ ...event, target: { path: 'B/target.md' } });
  assert.equal(stopped, 2);
  assert.deepEqual(args, ['A/file.md', 'B/target.md', 'after']);
  assert.equal(plugin.dragSourcePath, '');
});
test('overlapping drop calls execute once and failure releases the lock', async () => {
  const plugin = fixture();
  let release;
  let calls = 0;
  plugin.executeDrop = async () => { calls++; await new Promise(resolve => { release = resolve; }); };
  const first = plugin.handleDrop('a', 'b', 'after');
  await plugin.handleDrop('a', 'b', 'after');
  assert.equal(calls, 1);
  release();
  await first;
  plugin.executeDrop = async () => { throw new Error('move failed'); };
  await assert.rejects(plugin.handleDrop('a', 'b', 'after'), /move failed/);
  assert.equal(plugin.dropInProgress, false);
});
test('duplicate file rename does not move the GUID after a subsequently added sibling', async () => {
  const plugin = fixture();
  const parent = Object.assign(new TFolder(), { path: 'B' });
  const file = Object.assign(new TFile(), { path: 'B/image.png', extension: 'png', parent });
  plugin.data.folderGuids.B = 'b';
  plugin.data.fileGuids['A/image.png'] = 'image';
  plugin.data.orderByFolder = { a: ['first', 'image', 'last'], b: ['target'] };
  plugin.ensureFolderGuid = async () => 'b';
  await plugin.handleRename(file, 'A/image.png');
  plugin.data.orderByFolder.b.push('new');
  await plugin.handleRename(file, 'A/image.png');
  assert.deepEqual(Array.from(plugin.data.orderByFolder.a), ['first', 'last']);
  assert.deepEqual(Array.from(plugin.data.orderByFolder.b), ['target', 'image', 'new']);
});

test('moving a folder note out must not remove the remaining folder from its parent order', async () => {
  const plugin = fixture();
  const parent = Object.assign(new TFolder(), { path: 'B' });
  const file = Object.assign(new TFile(), { path: 'B/A.md', basename: 'A', extension: 'md', parent });
  plugin.data.folderGuids = { A: 'd:folder0000', B: 'd:parent0000' };
  plugin.guidByPath.set('A/A.md', 'f:note000000');
  plugin.data.orderByFolder = { __root__: ['before', 'd:folder0000', 'after'], 'd:folder0000': ['f:note000000', 'child'], 'd:parent0000': ['target'] };
  plugin.ensureFolderGuid = async () => 'b';
  await plugin.handleRename(file, 'A/A.md');
  const folderGuid = plugin.data.folderGuids.A;
  assert.equal(folderGuid, 'd:folder0000');
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['before', folderGuid, 'after']);
  assert.deepEqual(Array.from(plugin.data.orderByFolder[folderGuid]), ['child']);
  assert.equal(plugin.guidByPath.get('B/A.md'), 'f:note000000');
});

function folderNoteFixture() {
  const plugin = fixture();
  const root = Object.assign(new TFolder(), { path: '', name: '', parent: null, children: [] });
  const folder = Object.assign(new TFolder(), { path: 'A', name: 'A', parent: root, children: [] });
  const note = Object.assign(new TFile(), { path: 'A/A.md', name: 'A.md', basename: 'A', extension: 'md', parent: folder });
  const target = Object.assign(new TFile(), { path: 'target.md', name: 'target.md', basename: 'target', extension: 'md', parent: root });
  folder.children = [note]; root.children = [folder, target];
  const files = [root, folder, note, target];
  plugin.data.folderGuids = { A: 'd:folder0000' };
  plugin.data.orderByFolder = { __root__: ['before', 'd:folder0000', 'target', 'after'], 'd:folder0000': ['f:note000000', 'child'] };
  plugin.guidByPath.set(note.path, 'f:note000000'); plugin.guidByPath.set(target.path, 'target');
  plugin.ensureFileGuid = async file => plugin.guidByPath.get(file.path);
  plugin.flushSave = async () => {};
  plugin.rememberDragUndo = record => { plugin.lastDragUndo = record; };
  plugin.app.vault = { getAbstractFileByPath: path => files.find(file => file.path === path) || null };
  plugin.app.fileManager = { renameFile: async (file, path) => {
    file.parent.children = file.parent.children.filter(child => child !== file);
    file.path = path;
    file.parent = path.includes('/') ? folder : root;
    file.parent.children.push(file);
  } };
  return { plugin, root, folder, note, target };
}

for (const position of ['before', 'after']) {
  test(`folder note separation: exact ${position} drop and undo preserve folder and child order`, async () => {
    const { plugin, folder, note } = folderNoteFixture();
    await plugin.handleDrop(note.path, 'target.md', position);
    const independent = plugin.data.folderGuids.A;
    assert.equal(folder.path, 'A'); assert.equal(note.path, 'A.md');
    assert.equal(independent, 'd:folder0000');
    assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), position === 'before'
      ? ['before', independent, 'f:note000000', 'target', 'after'] : ['before', independent, 'target', 'f:note000000', 'after']);
    await plugin.ensureFolderGuid(folder);
    assert.equal(plugin.data.folderGuids.A, independent, 'sibling note must not reattach on reconciliation');
    plugin.data = JSON.parse(JSON.stringify(plugin.data));
    await plugin.ensureFolderGuid(folder);
    assert.equal(plugin.data.folderGuids.A, independent, 'persisted separation survives reload');
    await plugin.undoLastDrag();
    assert.equal(note.path, 'A/A.md'); assert.equal(plugin.data.folderGuids.A, independent);
    assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['before', independent, 'target', 'after']);
    assert.deepEqual(Array.from(plugin.data.orderByFolder[independent]), ['f:note000000', 'child']);
  });
}

test('failed folder note move leaves identity and order untouched', async () => {
  const { plugin, note } = folderNoteFixture();
  const before = JSON.stringify(plugin.data);
  plugin.app.fileManager.renameFile = async () => { throw new Error('locked'); };
  await plugin.handleDrop(note.path, 'target.md', 'after');
  assert.equal(JSON.stringify(plugin.data), before);
  assert.equal(plugin.pendingDropPlacements.size, 0);
});

test('drop beside the former owning folder uses its new independent identity', async () => {
  const { plugin, note } = folderNoteFixture();
  await plugin.handleDrop(note.path, 'A', 'after');
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['before', plugin.data.folderGuids.A, 'f:note000000', 'target', 'after']);
});

test('native rename event and explicit drop completion share the same pending identity update', async () => {
  const { plugin, note } = folderNoteFixture();
  const rename = plugin.app.fileManager.renameFile;
  let eventDone;
  plugin.app.fileManager.renameFile = async (file, path) => {
    const oldPath = file.path;
    await rename(file, path);
    eventDone = plugin.handleRename(file, oldPath);
  };
  await plugin.handleDrop(note.path, 'target.md', 'before');
  await eventDone;
  plugin.data.orderByFolder.__root__.push('later');
  await plugin.handleRename(note, 'A/A.md');
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['before', plugin.data.folderGuids.A, 'f:note000000', 'target', 'after', 'later']);
});

test('same-parent folder-note rename preserves children and stable document GUID', async () => {
  const { plugin, note, folder } = folderNoteFixture();
  note.path = 'A/renamed.md'; note.basename = 'renamed';
  await plugin.handleRename(note, 'A/A.md');
  assert.equal(plugin.guidByPath.get(note.path), 'f:note000000');
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['before', plugin.data.folderGuids.A, 'target', 'after']);
  assert.deepEqual(Array.from(plugin.data.orderByFolder[plugin.data.folderGuids.A]), ['f:note000000', 'child']);
  assert.equal(await plugin.ensureFolderGuid(folder), plugin.data.folderGuids.A);
});

test('converting a target document to a folder preserves the target sibling position', async () => {
  const plugin = fixture();
  const root = Object.assign(new TFolder(), { path: '', name: '', parent: null, children: [] });
  const before = Object.assign(new TFile(), { path: 'before.md', name: 'before.md', basename: 'before', extension: 'md', parent: root });
  const target = Object.assign(new TFile(), { path: 'target.md', name: 'target.md', basename: 'target', extension: 'md', parent: root });
  const after = Object.assign(new TFile(), { path: 'after.md', name: 'after.md', basename: 'after', extension: 'md', parent: root });
  const source = Object.assign(new TFile(), { path: 'source.md', name: 'source.md', basename: 'source', extension: 'md', parent: root });
  root.children = [before, target, after, source];
  const files = [root, before, target, after, source];
  plugin.guidByPath.set(before.path, 'before');
  plugin.guidByPath.set(target.path, 'target');
  plugin.guidByPath.set(after.path, 'after');
  plugin.guidByPath.set(source.path, 'source');
  plugin.data.orderByFolder = { __root__: ['before', 'target', 'after', 'source'] };
  plugin.app.workspace = { layoutReady: true };
  plugin.app.metadataCache = { getFileCache: () => null };
  plugin.app.vault = {
    getAbstractFileByPath: path => files.find(file => file.path === path) || null,
    createFolder: async path => {
      const folder = Object.assign(new TFolder(), { path, name: path, parent: root, children: [] });
      files.push(folder); root.children.push(folder);
      return folder;
    },
  };
  plugin.app.fileManager = { renameFile: async (file, path) => {
    file.parent.children = file.parent.children.filter(child => child !== file);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    file.parent = parentPath ? plugin.app.vault.getAbstractFileByPath(parentPath) : root;
    file.path = path;
    file.name = path.slice(path.lastIndexOf('/') + 1);
    file.basename = file.name.replace(/\.md$/, '');
    file.parent.children.push(file);
  } };
  plugin.queueSave = () => {};
  plugin.flushSave = async () => {};
  plugin.refreshExplorer = () => {};
  plugin.rememberDragUndo = () => {};

  await plugin.handleDrop('source.md', 'target.md', 'inside');

  const folderGuid = plugin.data.folderGuids.target;
  assert.match(folderGuid, /^d-[A-Za-z0-9]{11}$/);
  assert.deepEqual(Array.from(plugin.data.orderByFolder.__root__), ['before', folderGuid, 'after']);
  assert.deepEqual(Array.from(plugin.data.orderByFolder[folderGuid]), ['target', 'source']);
});
