import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_PREVIEW_LIMIT,
  MANIFEST_PROBLEM_LIMIT,
  renderManifestRestoreView,
  splitManifestProblem,
} from '../src/manifest-restore-view.ts';

class FakeElement {
  constructor(tag, info) {
    this.tag = tag;
    this.children = [];
    this.classes = new Set();
    this.text = '';
    if (typeof info === 'string') this.text = info;
    else if (info) {
      if (info.cls) String(info.cls).split(/\s+/).filter(Boolean).forEach(name => this.classes.add(name));
      if (typeof info.text === 'string') this.text = info.text;
    }
  }
  createDiv(info) { const el = new FakeElement('div', info); this.children.push(el); return el; }
  createSpan(info) { const el = new FakeElement('span', info); this.children.push(el); return el; }
  createEl(tag, info) { const el = new FakeElement(tag, info); this.children.push(el); return el; }
  empty() { this.children = []; }
  hasClass(name) { return this.classes.has(name); }
}

function findAll(root, predicate) {
  const out = [];
  const walk = (element) => {
    for (const child of element.children) {
      if (predicate(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function byClass(root, name) { return findAll(root, element => element.hasClass(name)); }
function leaves(element) {
  if (!element.children.length) return element.text ? [element.text] : [];
  return element.children.flatMap(leaves);
}
function rowText(element) { return leaves(element).join(' '); }

function render(view) {
  const root = new FakeElement('div');
  renderManifestRestoreView(root, view);
  return root;
}

test('manifest restore view renders stat cards, order preview and notes', () => {
  const root = render({
    manifestCount: 2,
    changedDirectories: 1,
    changedPositions: 2,
    previews: [{ folder: 'kb', current: 'a.md → b.md', next: 'b.md → a.md' }],
    problems: [],
    newManifests: 0,
  });

  const stats = byClass(root, 'yq-manifest-stat');
  assert.equal(stats.length, 4);
  assert.deepEqual(stats.map(card => rowText(card)), [
    '有效清单 2 份',
    '顺序将变化 1 个目录',
    '显示位置不同 2 处',
    '清单差异 0 项',
  ]);
  assert.equal(stats.filter(card => card.hasClass('is-warn')).length, 2);
  assert.equal(stats.filter(card => card.hasClass('is-ok')).length, 1);

  const header = byClass(root, 'yq-manifest-section')[0].children.find(child => child.tag === 'h4');
  assert.equal(header.text, '顺序变化示例（1 / 1）');

  const preview = byClass(root, 'yq-manifest-preview')[0];
  assert.equal(preview.children.length, 1);
  const [folder, currentRow, nextRow] = preview.children[0].children;
  assert.equal(folder.text, 'kb');
  assert.deepEqual(leaves(currentRow), ['当前', 'a.md → b.md']);
  assert.deepEqual(leaves(nextRow), ['恢复后', 'b.md → a.md']);
  assert.equal(nextRow.hasClass('is-next'), true);
  assert.equal(currentRow.hasClass('is-next'), false);

  const notes = byClass(root, 'yq-manifest-notes')[0];
  assert.equal(notes.children.length, 5);
  assert.match(rowText(notes), /仅恢复顺序，不覆盖后来更换的 GUID。/);
  assert.match(rowText(notes), /匹配只看清单中的路径，不看文件内容/);
  assert.match(rowText(notes), /同一路径若已换成另一个文件/);
  assert.match(rowText(notes), /不移动、重命名或删除实际文件。/);
  assert.match(rowText(notes), /确认后会清空拖拽撤销历史/);
  assert.equal(byClass(root, 'yq-manifest-section').some(section => section.hasClass('is-problems')), false);
});

test('manifest restore view reports a fully matching order without a preview section', () => {
  const root = render({
    manifestCount: 2,
    changedDirectories: 0,
    changedPositions: 0,
    previews: [],
    problems: [],
    newManifests: 0,
  });
  const status = byClass(root, 'yq-manifest-status')[0];
  assert.match(status.text, /显示顺序与清单一致/);
  assert.equal(byClass(root, 'yq-manifest-preview').length, 0);
  assert.equal(byClass(root, 'yq-manifest-stat-value')[0].text, '2 份');
});

test('manifest restore view groups problems by path and reason and truncates long lists', () => {
  const problems = Array.from({ length: MANIFEST_PROBLEM_LIMIT + 3 }, (_value, index) =>
    index === 0 ? '当前库存在 2 组重复 GUID' : `语雀导出测试02/kb${index}/_yuque_order.json：无法解析`);

  const root = render({ manifestCount: 2, changedDirectories: 0, changedPositions: 0, previews: [], problems, newManifests: 0 });
  const section = byClass(root, 'yq-manifest-section').find(candidate => candidate.hasClass('is-problems'));
  assert.equal(section.children.find(child => child.tag === 'h4').text, `清单差异（${problems.length}）`);

  const items = byClass(root, 'yq-manifest-problems')[0].children;
  assert.equal(items.length, MANIFEST_PROBLEM_LIMIT + 1);
  assert.equal(byClass(items[0], 'yq-manifest-path').length, 0);
  assert.equal(byClass(items[0], 'yq-manifest-reason')[0].text, '当前库存在 2 组重复 GUID');
  assert.equal(byClass(items[1], 'yq-manifest-path')[0].text, '语雀导出测试02/kb1/_yuque_order.json');
  assert.equal(byClass(items[1], 'yq-manifest-reason')[0].text, '无法解析');
  assert.equal(items.at(-1).hasClass('yq-manifest-more'), true);
  assert.equal(items.at(-1).text, `另有 ${problems.length - MANIFEST_PROBLEM_LIMIT} 项……`);
  assert.match(byClass(section, 'yq-manifest-hint')[0].text, /不会自动修复/);
});

test('manifest restore view announces first-use manifests and caps previews', () => {
  const previews = Array.from({ length: MANIFEST_PREVIEW_LIMIT + 4 }, (_value, index) => ({
    folder: `folder-${index}`, current: 'a → b', next: 'b → a',
  }));
  const root = render({
    manifestCount: 3,
    changedDirectories: previews.length,
    changedPositions: previews.length,
    previews,
    problems: [],
    newManifests: 3,
  });
  const previewList = byClass(root, 'yq-manifest-preview')[0];
  assert.equal(previewList.children.length, MANIFEST_PREVIEW_LIMIT);
  const header = byClass(root, 'yq-manifest-section')[0].children.find(child => child.tag === 'h4');
  assert.equal(header.text, `顺序变化示例（${MANIFEST_PREVIEW_LIMIT} / ${previews.length}）`);
  const firstUseNotes = byClass(root, 'yq-manifest-notes')[0];
  assert.equal(firstUseNotes.children.length, 4);
  assert.match(rowText(firstUseNotes), /3 份清单为首次使用/);
  assert.match(rowText(firstUseNotes), /匹配只看清单中的路径/);
  // 全部首次使用时不再提示"同路径换文件"，因为首次会校验 Markdown GUID。
  assert.doesNotMatch(rowText(firstUseNotes), /同一路径若已换成另一个文件/);
});

test('splitManifestProblem keeps a colon-free problem as reason', () => {
  assert.deepEqual(splitManifestProblem('当前库存在 1 组重复 GUID'), { path: '', reason: '当前库存在 1 组重复 GUID' });
  assert.deepEqual(splitManifestProblem('kb/a.md：当前库缺失或类型不符'), { path: 'kb/a.md', reason: '当前库缺失或类型不符' });
});
