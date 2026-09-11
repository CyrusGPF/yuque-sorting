import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { planCopyRoots, copyPathMap, resolveCopyDestination, scanDisk, verifyDisk, verifyInstalledCopies, checkedDirectory, markdownHeader, copyMarkdown, installCopies } = await load('src/local-copy.ts');
const { sourceTransfer } = await load('src/local-source.ts');
const io = { fs, path };
async function scratch(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yq-copy-test-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('yq-copy-test-'));
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
test('same-level conflicts require decisions; names reserve case-insensitive siblings and source names', () => {
  assert.throws(() => planCopyRoots(['a.md'], ['A.md'], new Map()), /请选择/);
  assert.deepEqual(planCopyRoots(['a.md'], ['A.md'], new Map([['a.md', { mode: 'replace' }]])), [{ source: 'a.md', target: 'A.md', replaces: true }]);
  assert.equal(planCopyRoots(['a.md'], ['a.md', '001-a.md'], new Map([['a.md', { mode: 'number' }]]))[0].target, '001-2-a.md');
  assert.throws(() => planCopyRoots(['a.md', 'b.md'], ['a.md'], new Map([['a.md', { mode: 'rename', name: 'B.md' }]])), /占用/);
  for (const name of ['../escape', 'a/b', 'CON', 'bad.', '.obsidian']) assert.throws(() => planCopyRoots(['a'], ['a'], new Map([['a', { mode: 'rename', name }]])), /无效/);
  assert.equal(planCopyRoots(['a'], ['a'], new Map([['a', { mode: 'rename', name: 'new' }]]))[0].target, 'new');
});
test('renamed paired root also renames its note without overwriting another child', () => {
  const pack = { items: [{ path: 'A', kind: 'folder', guid: 'd-token' }, { path: 'A/A.md', kind: 'file', guid: 'f-token' }], orders: { '': ['A'], A: ['A/A.md'] } };
  const roots = [{ source: 'A', target: '001-A', replaces: false }];
  assert.equal(copyPathMap(pack, roots).get('A/A.md'), '001-A/001-A.md');
  pack.orders.A.push('A/001-A.md');
  assert.throws(() => copyPathMap(pack, roots), /冲突/);
});
test('metadata scan excludes hidden sources and detects later edits; junctions are rejected', async t => {
  const dir = await scratch(t);
  await fs.promises.writeFile(path.join(dir, 'a'), 'a');
  await fs.promises.mkdir(path.join(dir, '.obsidian'));
  const before = await scanDisk(io, dir);
  assert.deepEqual(before.map(item => item.path).sort(), ['', 'a']);
  await fs.promises.writeFile(path.join(dir, 'a'), 'changed');
  await assert.rejects(verifyDisk(io, dir, before), /变化/);
  await fs.promises.symlink(path.join(dir, '.obsidian'), path.join(dir, 'junction'), 'junction');
  await assert.rejects(scanDisk(io, dir), /链接/);
  await assert.rejects(checkedDirectory(io, path.join(dir, 'junction')), /联接/);
});
test('target resolution permits absolute paths inside vault and missing directories without writing', async t => {
  const root = await scratch(t);
  const plan = await resolveCopyDestination(io, root, path.join(root, 'new', 'nested'));
  assert.equal(plan.relative, 'new/nested');
  assert.deepEqual(plan.missing, ['new', 'new/nested']);
  assert.deepEqual(await fs.promises.readdir(root), []);
  assert.equal((await resolveCopyDestination(io, root, '')).absolute, root);
  await assert.rejects(resolveCopyDestination(io, root, path.dirname(root)), /当前 Vault/);
  await assert.rejects(resolveCopyDestination(io, root, '.obsidian/new'), /隐藏/);
  await fs.promises.writeFile(path.join(root, 'file'), 'x');
  await assert.rejects(resolveCopyDestination(io, root, 'file/nested'), /不是目录/);
});
test('large Markdown body uses bounded reads, preserves bytes and replaces only YAML header', async t => {
  const dir = await scratch(t), source = path.join(dir, 'source.md'), output = path.join(dir, 'out.md');
  const body = '正文\r\n'.repeat(400000);
  await fs.promises.writeFile(source, '\uFEFF---\r\nguid: f-old\r\n---\r\n' + body);
  let maxRead = 0, openHandles = 0, maxOpen = 0;
  const wrapped = { fs: { promises: { open: async (...args) => {
    const file = await fs.promises.open(...args); openHandles++; maxOpen = Math.max(maxOpen, openHandles);
    return { read: (...args) => { maxRead = Math.max(maxRead, args[2]); return file.read(...args); },
      stat: () => file.stat(), write: (...args) => file.write(...args), writeFile: (...args) => file.writeFile(...args), close: async () => { openHandles--; await file.close(); } };
  } } }, path };
  const header = await markdownHeader(wrapped, source);
  await copyMarkdown(wrapped, source, output, 'guid: f-new\n', header);
  assert.equal(await fs.promises.readFile(output, 'utf8'), '\uFEFF---\r\nguid: f-new\r\n---\r\n' + body);
  assert.ok(maxRead <= 256 * 1024); assert.ok(maxOpen <= 2); assert.equal(openHandles, 0);
});
test('invalid or oversized YAML fails before copying a body', async t => {
  const dir = await scratch(t), source = path.join(dir, 'bad.md');
  await fs.promises.writeFile(source, '---\n' + 'x'.repeat(300000));
  await assert.rejects(markdownHeader(io, source), /256 KiB/);
});
async function installFixture(t) {
  const dir = await scratch(t), target = path.join(dir, 'target'), workspace = path.join(dir, 'job');
  await fs.promises.mkdir(path.join(target, 'folder'), { recursive: true });
  await fs.promises.writeFile(path.join(target, 'folder', 'old-only.txt'), 'original');
  await fs.promises.mkdir(path.join(workspace, 'staged', 'folder'), { recursive: true });
  await fs.promises.writeFile(path.join(workspace, 'staged', 'folder', 'new.txt'), 'new');
  return { target, workspace, roots: [{ source: 'folder', target: 'folder', replaces: true }], verify: async () => {} };
}
test('folder replacement does not recursively merge; original subtree remains recoverable', async t => {
  const options = await installFixture(t); let commits = 0;
  await installCopies(io, { ...options, commitData: async () => { commits++; }, rollbackData: async () => assert.fail('unexpected rollback') });
  assert.deepEqual(await fs.promises.readdir(path.join(options.target, 'folder')), ['new.txt']);
  assert.equal(await fs.promises.readFile(path.join(options.workspace, 'originals', 'folder', 'old-only.txt'), 'utf8'), 'original');
  assert.equal(commits, 1);
});
test('failed index save restores original tree and retains incoming files, with no delete', async t => {
  const options = await installFixture(t); let rollbacks = 0;
  await assert.rejects(installCopies(io, { ...options, commitData: async () => { throw new Error('disk full'); }, rollbackData: async () => { rollbacks++; } }), /已回滚/);
  assert.deepEqual(await fs.promises.readdir(path.join(options.target, 'folder')), ['old-only.txt']);
  assert.equal(await fs.promises.readFile(path.join(options.workspace, 'staged', 'folder', 'new.txt'), 'utf8'), 'new');
  assert.equal(rollbacks, 1);
});
test('failure after backup but before install restores the replaced item', async t => {
  const options = await installFixture(t);
  const wrapped = { path, fs: { promises: { ...fs.promises, rename: async (from, to) => {
    if (from === path.join(options.workspace, 'staged', 'folder')) throw new Error('copy failed');
    return fs.promises.rename(from, to);
  } } } };
  await assert.rejects(installCopies(wrapped, { ...options, commitData: async () => assert.fail('should not commit'), rollbackData: async () => {} }), /已回滚/);
  assert.equal(await fs.promises.readFile(path.join(options.target, 'folder', 'old-only.txt'), 'utf8'), 'original');
});
test('preflight failure touches no original and never calls commit', async t => {
  const options = await installFixture(t);
  await assert.rejects(installCopies(io, { ...options, verify: async () => { throw new Error('changed'); }, commitData: async () => assert.fail(), rollbackData: async () => assert.fail() }), /changed/);
  assert.equal(await fs.promises.readFile(path.join(options.target, 'folder', 'old-only.txt'), 'utf8'), 'original');
});
test('external edits after install are detected and rollback retains the edited incoming copy', async t => {
  const options = await installFixture(t);
  const staged = await scanDisk(io, path.join(options.workspace, 'staged'));
  await assert.rejects(installCopies(io, { ...options, commitData: async () => {
    await fs.promises.writeFile(path.join(options.target, 'folder', 'new.txt'), 'externally changed');
    await verifyInstalledCopies(io, options.target, options.roots, staged);
  }, rollbackData: async () => {} }), /副本发生变化/);
  assert.equal(await fs.promises.readFile(path.join(options.workspace, 'staged', 'folder', 'new.txt'), 'utf8'), 'externally changed');
  assert.deepEqual(await fs.promises.readdir(path.join(options.target, 'folder')), ['old-only.txt']);
});
test('cancellation before installing leaves originals untouched and records rollback', async t => {
  const options = await installFixture(t); let rolledBack = false;
  await assert.rejects(installCopies(io, { ...options, checkCancelled: () => { throw new Error('cancelled'); },
    commitData: async () => assert.fail(), rollbackData: async () => { rolledBack = true; } }), /cancelled/);
  assert.equal(rolledBack, true);
  assert.deepEqual(await fs.promises.readdir(path.join(options.target, 'folder')), ['old-only.txt']);
});
test('file versus folder replacement is explicit and backed up, in both directions', async t => {
  for (const direction of ['file-to-folder', 'folder-to-file']) {
    const dir = await scratch(t), target = path.join(dir, 'target'), workspace = path.join(dir, 'job');
    await fs.promises.mkdir(target); await fs.promises.mkdir(path.join(workspace, 'staged'), { recursive: true });
    const old = path.join(target, 'item'), next = path.join(workspace, 'staged', 'item');
    if (direction === 'file-to-folder') { await fs.promises.writeFile(old, 'old'); await fs.promises.mkdir(next); }
    else { await fs.promises.mkdir(old); await fs.promises.writeFile(next, 'new'); }
    await installCopies(io, { roots: [{ source: 'item', target: 'item', replaces: true }], target, workspace,
      verify: async () => {}, commitData: async () => {}, rollbackData: async () => assert.fail() });
    assert.equal((await fs.promises.stat(old)).isDirectory(), direction === 'file-to-folder');
    assert.equal((await fs.promises.stat(path.join(workspace, 'originals', 'item'))).isDirectory(), direction === 'folder-to-file');
  }
});
test('source index preserves nonalphabetical order; source missing identities are generated only in memory', async t => {
  const dir = await scratch(t), pluginDir = path.join(dir, '.obsidian', 'plugins', 'yuque-order-drag');
  await fs.promises.mkdir(pluginDir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'a.png'), 'a'); await fs.promises.writeFile(path.join(dir, 'z.png'), 'z');
  await fs.promises.writeFile(path.join(pluginDir, 'data.json'), JSON.stringify({ fileGuids: { 'a.png': 'f-a', 'z.png': 'f-z' }, orderByFolder: { __root__: ['f-z', 'f-a'] } }));
  const entries = await scanDisk(io, dir);
  const result = await sourceTransfer(io, dir, entries, 'yuque-order-drag', () => { throw new Error('unexpected generation'); }, () => ({}));
  assert.deepEqual(result.pack.orders[''], ['z.png', 'a.png']); assert.equal(result.fallback, 0);
  const legacySource = await sourceTransfer(io, dir, entries, 'yuque-sorting', () => { throw new Error('legacy identities must remain readable'); }, () => ({}));
  assert.deepEqual(legacySource.pack.orders[''], ['z.png', 'a.png']);
  await fs.promises.writeFile(path.join(dir, 'new.png'), 'new');
  const newer = await sourceTransfer(io, dir, await scanDisk(io, dir), 'yuque-order-drag', () => 'f-new', () => ({}));
  assert.equal(newer.generated, 1); assert.equal(newer.fallback, 1);
  assert.equal(await fs.promises.readFile(path.join(dir, 'new.png'), 'utf8'), 'new');
});
test('10,000 root names have deterministic numbering and no collisions', () => {
  const names = Array.from({ length: 10000 }, (_, i) => `item${i}`);
  const choices = new Map(names.map(name => [name, { mode: 'number' }]));
  const roots = planCopyRoots(names, names, choices);
  assert.equal(new Set(roots.map(root => root.target)).size, 10000);
  assert.equal(roots[0].target, '001-item0');
});
