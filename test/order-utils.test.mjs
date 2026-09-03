import test from "node:test";
import assert from "node:assert/strict";
import { compareEntryNames, moveGuid, sortEntries, uniqueKnownOrder } from "../src/order-utils.ts";

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
