import test from "node:test";
import assert from "node:assert/strict";
import { createTypedGuid, findDuplicateIdentities, mapLimit, remapOrderSnapshot } from "../src/guid-utils.ts";

test("typed GUIDs use the exact 64 and 72 bit contracts", () => {
  assert.match(createTypedGuid("f", 64), /^f-[A-Za-z0-9]{11}$/);
  assert.match(createTypedGuid("d", 72), /^d-[A-Za-z0-9]{13}$/);
});

test("duplicate detection compares the complete GUID and keeps traversal order", () => {
  const entries = [
    { path: "A", kind: "folder", guid: "d:same_token0" },
    { path: "A.md", kind: "file", guid: "f:same_token0" },
    { path: "B.md", kind: "file", guid: "f:same_token0" },
  ];
  const groups = findDuplicateIdentities(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((entry) => entry.path), ["A.md", "B.md"]);
});

test("10,000-item duplicate scan allocates groups only for actual duplicates", () => {
  const entries = Array.from({ length: 10000 }, (_, index) => ({ path: `${index}.md`, kind: "file", guid: `f:${index}` }));
  entries[9999].guid = entries[3].guid;
  const groups = findDuplicateIdentities(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("path snapshot remapping preserves every sibling position", () => {
  const orders = { "": ["A", "note.md", "image.png"], A: ["A/child.md"] };
  const identities = new Map([["A", "d:newfolder0"], ["note.md", "f:newnote000"], ["image.png", "f:newimage00"], ["A/child.md", "f:newchild00"]]);
  const folders = new Map([["A", "d:newfolder0"]]);
  assert.deepEqual(remapOrderSnapshot(orders, identities, folders), {
    __root__: ["d:newfolder0", "f:newnote000", "f:newimage00"],
    "d:newfolder0": ["f:newchild00"],
  });
});

test("bounded mapper never exceeds four concurrent Markdown operations", async () => {
  let active = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 30 }, (_, index) => index), 4, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });
  assert.equal(peak, 4);
});
