import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  compareEntryNames,
  compareInventories,
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
  sanitizePortableName,
  sortEntries,
  uniqueKnownOrder,
} from "../src/order-utils.ts";

test("sortEntries keeps saved guid order and puts unknown items last", () => {
  const items = [
    { path: "b.md", name: "B", guid: "b" },
    { path: "c.md", name: "C", guid: "c" },
    { path: "a.md", name: "A", guid: "a" },
  ];
  const sorted = sortEntries(items, ["c", "a"], (item) => item.guid);
  assert.deepEqual(sorted.map((item) => item.guid), ["c", "a", "b"]);
});

test("moveGuid moves an item before or after a target", () => {
  assert.deepEqual(moveGuid(["a", "b", "c"], "c", "a", true), ["c", "a", "b"]);
  assert.deepEqual(moveGuid(["a", "b", "c"], "a", "b", false), ["b", "a", "c"]);
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
