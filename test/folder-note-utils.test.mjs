import test from "node:test";
import assert from "node:assert/strict";
import { mergeChoice, pairedFolderNoteToken } from "../src/folder-note-utils.ts";

test("folder-note pairing requires direct placement, same name, and identical typed suffix", () => {
  assert.equal(pairedFolderNoteToken({
    folderName: "章节", fileBasename: "章节", directChild: true,
    folderGuid: "d-Abc12345678", fileGuid: "f-Abc12345678",
  }), "Abc12345678");
  assert.equal(pairedFolderNoteToken({
    folderName: "章节", fileBasename: "章节", directChild: false,
    folderGuid: "d-Abc12345678", fileGuid: "f-Abc12345678",
  }), null);
  assert.equal(pairedFolderNoteToken({
    folderName: "章节", fileBasename: "其它", directChild: true,
    folderGuid: "d-Abc12345678", fileGuid: "f-Abc12345678",
  }), null);
  assert.equal(pairedFolderNoteToken({
    folderName: "章节", fileBasename: "章节", directChild: true,
    folderGuid: "d-Abc12345678", fileGuid: "f-Xbc12345678",
  }), null);
});

test("per-pair display choice overrides but does not mutate the global default", () => {
  assert.equal(mergeChoice(false, {}, "token"), false);
  assert.equal(mergeChoice(true, { token: false }, "token"), false);
  assert.equal(mergeChoice(false, { token: true }, "token"), true);
});
