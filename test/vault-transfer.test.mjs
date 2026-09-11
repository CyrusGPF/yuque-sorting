import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVaultTransfer, planTransferGuids, safeTransferPath } from '../src/vault-transfer.ts';

function fixture() {
  return { format: 'yuque-vault-transfer', version: 1,
    items: [{ path: 'A/A.md', kind: 'file', guid: 'f-12345678901' }, { path: 'A', kind: 'folder', guid: 'd-12345678901' },
      { path: 'image.png', kind: 'file', guid: 'f-image000001' }],
    orders: { '': ['image.png', 'A'], A: ['A/A.md'] }, mergeChoices: { '12345678901': true } };
}
test('transfer package retains arbitrary sibling order and file types', () => {
  const pack = parseVaultTransfer(fixture());
  assert.deepEqual(pack.orders[''], ['image.png', 'A']);
  assert.equal(pack.mergeChoices['12345678901'], true);
});
test('duplicate GUIDs are readable while invalid paths and malformed indexes are rejected', () => {
  for (const path of ['../x', '/x', 'A/../x', 'C:/x', '.obsidian/x', 'A\\x', 'A//x', '__proto__/x']) assert.equal(safeTransferPath(path), false);
  const duplicate = fixture(); duplicate.items[2].guid = duplicate.items[0].guid;
  assert.equal(parseVaultTransfer(duplicate).items.length, 3);
  const missing = fixture(); missing.orders.A = [];
  assert.throws(() => parseVaultTransfer(missing), /不完整/);
  const moved = fixture(); moved.orders[''].push('A/A.md');
  assert.throws(() => parseVaultTransfer(moved), /索引无效/);
  const empty = fixture(); delete empty.orders.A;
  assert.throws(() => parseVaultTransfer(empty), /不完整/);
});
test('conflicts change only incoming identities and preserve folder-note pairs regardless of input order', () => {
  const pack = fixture();
  const occupied = new Set(['f-12345678901']);
  const result = planTransferGuids(pack.items, occupied, (kind, used) => {
    const guid = kind + '-99999999999'; assert.equal(used.has(guid), false); used.add(guid); return guid;
  });
  assert.equal(result.get('A'), 'd-99999999999');
  assert.equal(result.get('A/A.md'), 'f-99999999999');
  assert.equal(result.get('image.png'), 'f-image000001');
  assert.deepEqual([...occupied], ['f-12345678901']);
});
test('10,000 entries validate and allocate once per identity, with no changes for unique IDs', () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({ path: `${i}.png`, kind: 'file', guid: `f-${i}` }));
  const pack = parseVaultTransfer({ format: 'yuque-vault-transfer', version: 1, items, orders: { '': items.map(item => item.path) } });
  let generated = 0;
  const result = planTransferGuids(pack.items, new Set(), () => { generated++; throw new Error('unnecessary generation'); });
  assert.equal(result.size, 10000); assert.equal(generated, 0);
});
