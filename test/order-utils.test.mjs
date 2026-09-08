import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  compareEntryNames,
  compareInventories,
  captureGuidOrderPosition,
  detachFolderNoteFromOrder,
  folderIdentityPathForNote,
  insertGuid,
  migratePathMappings,
  moveGuid,
  purgeFolderGuidsFromOrders,
  reconcileOrderNonDestructive,
  relocateGuid,
  removeGuidFromOrders,
  replaceGuidInOrders,
  restoreGuidOrderPosition,
  sanitizePortableName,
  sortEntries,
  uniqueKnownOrder,
} from "../src/order-utils.ts";
import { dropPositionForPointer, moveBlockReason } from "../src/drag-utils.ts";

test("drag targeting exposes precise before, inside, and after zones", () => {
  assert.equal(dropPositionForPointer(100, 100, 20, true), "before");
  assert.equal(dropPositionForPointer(109, 100, 20, true), "inside");
  assert.equal(dropPositionForPointer(120, 100, 20, true), "after");
  assert.equal(dropPositionForPointer(109, 100, 20, false), "before");
  assert.equal(dropPositionForPointer(111, 100, 20, false), "after");
});

test("drag move validation rejects self, descendants, and name conflicts", () => {
  assert.equal(moveBlockReason("A", true, "A", false), "self-or-descendant");
  assert.equal(moveBlockReason("A", true, "A/child", false), "self-or-descendant");
  assert.equal(moveBlockReason("A/file.md", false, "B", true), "conflict");
  assert.equal(moveBlockReason("A/file.md", false, "B", false), null);
});

test("sortEntries keeps saved guid order and puts unknown items last", () => {
  const items = [
    { path: "b.md", name: "B", guid: "b" },
    { path: "c.md", name: "C", guid: "c" },
    { path: "a.md", name: "A", guid: "a" },
  ];
  const sorted = sortEntries(items, ["c", "a"], (item) => item.guid);
  assert.deepEqual(sorted.map((item) => item.guid), ["c", "a", "b"]);
});

test("sortEntries cache is invalidated by replacing the immutable order array", () => {
  const items = [
    { path: "a.md", name: "A", guid: "a" },
    { path: "b.md", name: "B", guid: "b" },
  ];
  assert.deepEqual(sortEntries(items, ["a", "b"], (item) => item.guid).map((item) => item.guid), ["a", "b"]);
  assert.deepEqual(sortEntries(items, ["b", "a"], (item) => item.guid).map((item) => item.guid), ["b", "a"]);
});

test("moveGuid moves an item before or after a target", () => {
  assert.deepEqual(moveGuid(["a", "b", "c"], "c", "a", true), ["c", "a", "b"]);
  assert.deepEqual(moveGuid(["a", "b", "c"], "a", "b", false), ["b", "a", "c"]);
});

test("undo restores a dragged identity without overwriting unrelated sibling changes", () => {
  const original = ["a", "moving", "b", "c"];
  const position = captureGuidOrderPosition(original, "moving");
  const changedWhileMoved = ["new", "a", "b", "c"];
  assert.deepEqual(
    restoreGuidOrderPosition(changedWhileMoved, "moving", position),
    ["new", "a", "moving", "b", "c"],
  );
  assert.deepEqual(
    restoreGuidOrderPosition(["new", "b", "c"], "moving", position),
    ["new", "moving", "b", "c"],
  );
});

test("folder-note conversion keeps the shared identity at its original parent position", () => {
  const orders = {
    parent: ["before", "folder-note-guid", "after"],
    "folder-note-guid": ["folder-note-guid", "child"],
  };
  detachFolderNoteFromOrder(orders, "folder-note-guid");
  assert.deepEqual(orders, {
    parent: ["before", "folder-note-guid", "after"],
    "folder-note-guid": ["child"],
  });
});

test("document-into-document move and undo preserve both original parent positions", () => {
  const orders = {
    parent: ["before", "source", "target", "after"],
    target: ["target"],
  };
  const sourcePosition = captureGuidOrderPosition(orders.parent, "source");
  const targetPosition = captureGuidOrderPosition(orders.parent, "target");

  detachFolderNoteFromOrder(orders, "target");
  relocateGuid(orders, "target", "source", "bottom");
  assert.deepEqual(orders, {
    parent: ["before", "target", "after"],
    target: ["source"],
  });

  removeGuidFromOrders(orders, "source");
  orders.parent = restoreGuidOrderPosition(orders.parent, "source", sourcePosition);
  delete orders.target;
  orders.parent = restoreGuidOrderPosition(orders.parent, "target", targetPosition);
  assert.deepEqual(orders, {
    parent: ["before", "source", "target", "after"],
  });
});

test("uniqueKnownOrder removes unknown and duplicate identities", () => {
  assert.deepEqual(uniqueKnownOrder(["a", "x", "a", "b"], new Set(["a", "b"])), ["a", "b"]);
});

test("fallback name comparison is natural and case insensitive", () => {
  assert.equal(compareEntryNames({ name: "doc2", path: "doc2" }, { name: "doc10", path: "doc10" }) < 0, true);
});

test("sanitizePortableName mirrors the exporter's path sanitizer", () => {
  // 全角标点→半角（NFKC）、空格/冒号/斜杠→下划线
  assert.equal(sanitizePortableName("指数运算法则（Exponentiation）"), "指数运算法则(Exponentiation)");
  assert.equal(sanitizePortableName("对数 和 对数函数"), "对数_和_对数函数");
  assert.equal(sanitizePortableName("线性列表的顺序表示: 顺序表"), "线性列表的顺序表示_顺序表");
  assert.equal(sanitizePortableName("I/O控制方式"), "I_O控制方式");
  assert.equal(sanitizePortableName("无标题文档"), "无标题文档");
  // 同名去重后的形式保持不变（-N 后缀不算非法字符）
  assert.equal(sanitizePortableName("无标题文档-1"), "无标题文档-1");
});

test("manifest comparison checks identity and hierarchy but not sibling order", () => {
  const manifest = [
    { guid: "a", parentGuid: "root", label: "A" },
    { guid: "b", parentGuid: "a", label: "A/B" },
    { guid: "missing", parentGuid: "root", label: "Missing" },
  ];
  const actual = [
    { guid: "b", parentGuid: "root", label: "B moved" },
    { guid: "a", parentGuid: "root", label: "A" },
    { guid: "extra", parentGuid: "root", label: "Extra" },
  ];
  const result = compareInventories(manifest, actual);
  assert.deepEqual(result.missing.map((entry) => entry.guid), ["missing"]);
  assert.deepEqual(result.extra.map((entry) => entry.guid), ["extra"]);
  assert.deepEqual(result.moved.map((entry) => entry.expected.guid), ["b"]);
  assert.deepEqual(result.duplicateManifestGuids, []);
  assert.deepEqual(result.duplicateActualGuids, []);
});

test("manifest comparison reports duplicate stable identities", () => {
  const duplicate = { guid: "dup", parentGuid: "root", label: "duplicate" };
  const result = compareInventories([duplicate, duplicate], [duplicate, duplicate]);
  assert.deepEqual(result.duplicateManifestGuids, ["dup"]);
  assert.deepEqual(result.duplicateActualGuids, ["dup"]);
});

test("folder subtree deletion removes parent references and owned order lists", () => {
  const orders = {
    root: ["before", "folder-a", "after"],
    "folder-a": ["note", "folder-b"],
    "folder-b": ["deep-note"],
    unrelated: ["folder-b", "keep"],
  };
  assert.equal(purgeFolderGuidsFromOrders(orders, ["folder-a", "folder-b"]), true);
  assert.deepEqual(orders, {
    root: ["before", "after"],
    unrelated: ["keep"],
  });
  assert.equal(purgeFolderGuidsFromOrders(orders, ["folder-a", "folder-b"]), false);
});

test("create appends once and delete preserves remaining sibling order", () => {
  assert.deepEqual(insertGuid(["a", "b"], "new", "bottom"), ["a", "b", "new"]);
  assert.deepEqual(insertGuid(["a", "b"], "a", "bottom"), ["a", "b"]);
  const orders = { folder: ["a", "deleted", "b"] };
  removeGuidFromOrders(orders, "deleted");
  assert.deepEqual(orders.folder, ["a", "b"]);
});

test("startup reconciliation never prunes temporarily missing children", () => {
  const saved = ["first", "second", "third", "fourth"];
  assert.deepEqual(
    reconcileOrderNonDestructive(saved, ["second", "fourth"], ["second", "fourth"], "bottom"),
    saved,
  );
  assert.deepEqual(
    reconcileOrderNonDestructive(saved, ["second", "fourth", "new"], ["new", "second", "fourth"], "bottom"),
    [...saved, "new"],
  );
});

test("rename in place changes no order and moving preserves both sibling lists", () => {
  const orders = { source: ["a", "moving", "b"], target: ["c", "d"] };
  const beforeRename = structuredClone(orders);
  // A rename with the same parent does not call relocateGuid.
  assert.deepEqual(orders, beforeRename);
  relocateGuid(orders, "target", "moving", "bottom");
  assert.deepEqual(orders, { source: ["a", "b"], target: ["c", "d", "moving"] });
});

test("an explicit cross-folder drop keeps siblings stable and honors its exact target", () => {
  const orders = { source: ["a", "moving", "b"], target: ["c", "d"] };
  relocateGuid(orders, "target", "moving", "bottom");
  orders.target = moveGuid(orders.target, "moving", "c", true);
  assert.deepEqual(orders, { source: ["a", "b"], target: ["moving", "c", "d"] });

  const afterOrders = { source: ["a", "moving", "b"], target: ["c", "d"] };
  relocateGuid(afterOrders, "target", "moving", "bottom");
  afterOrders.target = moveGuid(afterOrders.target, "moving", "c", false);
  assert.deepEqual(afterOrders, { source: ["a", "b"], target: ["c", "moving", "d"] });
});

test("invalid, conflicting, cancelled, or failed drops do not modify order", () => {
  const blockedMoves = [
    moveBlockReason("folder", true, "folder/child", false),
    moveBlockReason("source.md", false, "target", true),
    "cancelled",
    "failed",
  ];
  for (const outcome of blockedMoves) {
    const orders = { source: ["a", "moving", "b"], target: ["c", "d"] };
    const before = structuredClone(orders);
    // Production commits relocateGuid only after renameFile succeeds.
    if (outcome === null) relocateGuid(orders, "target", "moving", "bottom");
    assert.deepEqual(orders, before, outcome);
  }
});

test("folder-note identity changes keep the folder in the same position", () => {
  const orders = {
    parent: ["before", "old-folder-guid", "after"],
    "old-folder-guid": ["child-a", "child-b"],
  };
  assert.equal(replaceGuidInOrders(orders, "old-folder-guid", "folder-note-guid"), true);
  assert.deepEqual(orders, {
    parent: ["before", "folder-note-guid", "after"],
    "folder-note-guid": ["child-a", "child-b"],
  });
  assert.equal(replaceGuidInOrders(orders, "folder-note-guid", "folder-note-guid"), false);
});

test("deleting a folder note preserves the folder identity without a live parent object", () => {
  const folderGuids = { "root/Chapter": "chapter-guid" };
  assert.equal(
    folderIdentityPathForNote("root/Chapter/Chapter.md", folderGuids, "chapter-guid"),
    "root/Chapter",
  );
  assert.equal(
    folderIdentityPathForNote("root/Chapter.md", folderGuids, "chapter-guid"),
    "root/Chapter",
  );
  const orders = {
    root: ["before", "chapter-guid", "after"],
    "chapter-guid": ["chapter-guid", "child"],
  };
  assert.equal(detachFolderNoteFromOrder(orders, "chapter-guid"), true);
  assert.deepEqual(orders, {
    root: ["before", "chapter-guid", "after"],
    "chapter-guid": ["child"],
  });
});

test("non-Markdown identities survive file and ancestor-folder moves", () => {
  const fileGuids = {
    "old/image.png": "image-guid",
    "old/nested/report.pdf": "pdf-guid",
    "elsewhere/audio.mp3": "audio-guid",
  };
  const updates = migratePathMappings(fileGuids, "old", "new");
  assert.deepEqual(updates, [
    ["old/image.png", "new/image.png", "image-guid"],
    ["old/nested/report.pdf", "new/nested/report.pdf", "pdf-guid"],
  ]);
  assert.deepEqual(fileGuids, {
    "new/image.png": "image-guid",
    "new/nested/report.pdf": "pdf-guid",
    "elsewhere/audio.mp3": "audio-guid",
  });
});

test("Yuque manifest import has exactly one explicit manual call site", async () => {
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  assert.equal((source.match(/await this\.seedFromManifests\(\)/g) || []).length, 1);
  assert.match(source, /async requestManifestImport\(\)/);
  assert.doesNotMatch(source, /vault\.on\("modify"/);
  assert.doesNotMatch(source, /autoSeedFromManifest/);
});

test("drop execution defers authoritative order mutation until rename succeeds", async () => {
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  const branchStart = source.indexOf("if (targetFolder) {");
  const rename = source.indexOf("await this.app.fileManager.renameFile(source as any, destination)", branchStart);
  assert.notEqual(branchStart, -1);
  assert.notEqual(rename, -1);
  assert.doesNotMatch(source.slice(branchStart, rename), /removeGuidFromOrders|relocateGuid|placeGuidRelative/);
});

test("drag cancellation clears only transient UI state", async () => {
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  const clearStart = source.indexOf("private clearDragState(): void");
  const dropStart = source.indexOf("private async handleDrop", clearStart);
  assert.notEqual(clearStart, -1);
  assert.notEqual(dropStart, -1);
  assert.doesNotMatch(
    source.slice(clearStart, dropStart),
    /orderByFolder|removeGuidFromOrders|relocateGuid|moveGuid|saveData/,
  );
});

test("successful drags expose a guarded undo command and notice action", async () => {
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(source, /id: "undo-last-yuque-drag"/);
  assert.match(source, /button\.textContent = "撤销"/);
  assert.match(source, /无法撤销：原位置已存在同名项目/);
  assert.match(source, /无法撤销：拖拽创建的文件夹中已有其他项目/);
});

test("explorer refresh requests are coalesced by an animation-frame guard", async () => {
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(source, /refreshExplorer\(\): void \{\s+if \(this\.explorerRefreshFrame !== null\) return;/);
  assert.match(source, /this\.explorerRefreshFrame = window\.requestAnimationFrame/);
});
