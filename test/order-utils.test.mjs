import test from "node:test";
import assert from "node:assert/strict";
import { compareEntryNames, moveGuid, sanitizePortableName, sortEntries, uniqueKnownOrder } from "../src/order-utils.ts";

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
