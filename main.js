"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => YqOrderDragPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// src/order-utils.ts
var ROOT_FOLDER_KEY = "__root__";
var entryNameCollator = new Intl.Collator(void 0, {
  numeric: true,
  sensitivity: "base"
});
var rankByOrder = /* @__PURE__ */ new WeakMap();
function sanitizePortableName(name) {
  if (!name) return "";
  let result = name.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u200B-\u200D\uFEFF]/g, "").replace(/[\\/<>:"|?*]/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/[. ]+$/g, "").trim().replace(/^\.+|\.+$/g, "");
  if (!result) return "";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(result)) {
    result = `_${result}`;
  }
  if (result.length > 120) {
    result = result.slice(0, 120).replace(/[. ]+$/g, "");
  }
  return result;
}
function referencedLocalPaths(markdown, notePath, scopeRoot) {
  const result = /* @__PURE__ */ new Set();
  const normalizedRoot = scopeRoot.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const noteParent = notePath.replace(/\\/g, "/").split("/").slice(0, -1);
  const add = (rawTarget) => {
    let target = String(rawTarget || "").trim().replace(/^<|>$/g, "");
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return;
    target = target.split(/[?#]/, 1)[0];
    try {
      target = decodeURIComponent(target);
    } catch (e) {
    }
    target = target.replace(/\\/g, "/");
    const parts = target.startsWith("/") ? [] : [...noteParent];
    for (const part of target.replace(/^\/+/, "").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    const resolved = parts.join("/");
    if (!resolved || normalizedRoot && resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) return;
    result.add(resolved);
    let parent = resolved.split("/").slice(0, -1).join("/");
    while (parent && parent !== normalizedRoot && (!normalizedRoot || parent.startsWith(`${normalizedRoot}/`))) {
      result.add(parent);
      parent = parent.split("/").slice(0, -1).join("/");
    }
  };
  const scan = (pattern) => {
    let match;
    while ((match = pattern.exec(markdown)) !== null) add(match[1]);
  };
  let cursor = 0;
  while ((cursor = markdown.indexOf("](", cursor)) >= 0) {
    const start = cursor + 2;
    let depth = 1;
    let escaped = false;
    let end = start;
    for (; end < markdown.length; end += 1) {
      const char = markdown[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) break;
      if (char === "\n" || char === "\r") break;
    }
    if (depth === 0) {
      const destination = markdown.slice(start, end).trim();
      add(destination.startsWith("<") ? destination.split(">", 1)[0] + ">" : destination.split(/\s+["']/)[0]);
    }
    cursor = Math.max(end + 1, start);
  }
  scan(/!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g);
  scan(/(?:src|href)\s*=\s*["']([^"']+)["']/gi);
  return result;
}
function normalizeGuid(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const guid = String(value).trim();
  return guid ? guid : null;
}
function compareEntryNames(a, b) {
  return entryNameCollator.compare(a.name, b.name);
}
function sortEntries(entries, savedOrder, guidOf, fallback = "name-last") {
  let rank = rankByOrder.get(savedOrder);
  if (!rank) {
    rank = /* @__PURE__ */ new Map();
    savedOrder.forEach((guid, index) => {
      if (!rank.has(guid)) rank.set(guid, index);
    });
    rankByOrder.set(savedOrder, rank);
  }
  return entries.map((entry, originalIndex) => ({ entry, originalIndex, guid: guidOf(entry) })).sort((a, b) => {
    const ar = a.guid ? rank.get(a.guid) : void 0;
    const br = b.guid ? rank.get(b.guid) : void 0;
    if (ar !== void 0 && br !== void 0) return ar - br;
    if (ar !== void 0) return -1;
    if (br !== void 0) return 1;
    if (fallback === "name" || fallback === "name-last") {
      const byName = compareEntryNames(a.entry, b.entry);
      if (byName !== 0) return byName;
    }
    return a.originalIndex - b.originalIndex;
  }).map(({ entry }) => entry);
}
function reconcileOrderNonDestructive(previousOrder, currentChildGuids, initialSortedGuids, placement) {
  const previous = [...new Set(previousOrder)];
  const current = [...new Set(currentChildGuids)];
  if (!previous.length) return [...new Set(initialSortedGuids)];
  const known = new Set(previous);
  const missing = current.filter((guid) => !known.has(guid));
  if (!missing.length) return previous;
  return placement === "top" ? [...missing, ...previous] : [...previous, ...missing];
}
function moveGuid(order, sourceGuid, targetGuid, insertBefore) {
  const next = order.filter((guid) => guid !== sourceGuid);
  const targetIndex = next.indexOf(targetGuid);
  if (targetIndex < 0) {
    next.push(sourceGuid);
    return next;
  }
  next.splice(insertBefore ? targetIndex : targetIndex + 1, 0, sourceGuid);
  return next;
}
function captureGuidOrderPosition(order, guid) {
  const index = order.indexOf(guid);
  return {
    previousGuid: index > 0 ? order[index - 1] : null,
    nextGuid: index >= 0 && index + 1 < order.length ? order[index + 1] : null,
    originalIndex: index >= 0 ? index : order.length
  };
}
function restoreGuidOrderPosition(order, guid, position) {
  const next = order.filter((itemGuid) => itemGuid !== guid);
  const previousIndex = position.previousGuid ? next.indexOf(position.previousGuid) : -1;
  if (previousIndex >= 0) {
    next.splice(previousIndex + 1, 0, guid);
    return next;
  }
  const followingIndex = position.nextGuid ? next.indexOf(position.nextGuid) : -1;
  if (followingIndex >= 0) {
    next.splice(followingIndex, 0, guid);
    return next;
  }
  next.splice(Math.max(0, Math.min(position.originalIndex, next.length)), 0, guid);
  return next;
}
function removeGuidFromOrders(orderByFolder, guid) {
  let changed = false;
  Object.keys(orderByFolder).forEach((folderKey) => {
    const oldOrder = orderByFolder[folderKey] || [];
    const nextOrder = oldOrder.filter((itemGuid) => itemGuid !== guid);
    if (nextOrder.length !== oldOrder.length) {
      orderByFolder[folderKey] = nextOrder;
      changed = true;
    }
  });
  return changed;
}
function insertGuid(order, guid, placement) {
  if (order.includes(guid)) return order;
  return placement === "top" ? [guid, ...order] : [...order, guid];
}
function relocateGuid(orderByFolder, targetFolderKey, guid, placement) {
  removeGuidFromOrders(orderByFolder, guid);
  orderByFolder[targetFolderKey] = insertGuid(
    orderByFolder[targetFolderKey] || [],
    guid,
    placement
  );
}
function replaceGuidInOrders(orderByFolder, oldGuid, newGuid) {
  if (!oldGuid || !newGuid || oldGuid === newGuid) return false;
  let changed = false;
  Object.keys(orderByFolder).forEach((folderKey) => {
    const oldOrder = orderByFolder[folderKey] || [];
    const seen = /* @__PURE__ */ new Set();
    const nextOrder = oldOrder.map((guid) => guid === oldGuid ? newGuid : guid).filter((guid) => {
      if (seen.has(guid)) return false;
      seen.add(guid);
      return true;
    });
    if (nextOrder.length !== oldOrder.length || nextOrder.some((guid, index) => guid !== oldOrder[index])) {
      orderByFolder[folderKey] = nextOrder;
      changed = true;
    }
  });
  if (Object.prototype.hasOwnProperty.call(orderByFolder, oldGuid)) {
    const oldChildren = orderByFolder[oldGuid] || [];
    const newChildren = orderByFolder[newGuid] || [];
    orderByFolder[newGuid] = [.../* @__PURE__ */ new Set([...oldChildren, ...newChildren])];
    delete orderByFolder[oldGuid];
    changed = true;
  }
  return changed;
}
function migratePathMappings(mappings, oldPath, newPath) {
  const prefix = `${oldPath}/`;
  const updates = [];
  Object.entries(mappings).forEach(([path, guid]) => {
    if (path === oldPath || path.startsWith(prefix)) {
      const nextPath = path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
      updates.push([path, nextPath, guid]);
    }
  });
  updates.forEach(([from, to, guid]) => {
    delete mappings[from];
    mappings[to] = guid;
  });
  return updates;
}
function purgeFolderGuidsFromOrders(orderByFolder, guids) {
  const deleted = new Set(guids);
  if (!deleted.size) return false;
  let changed = false;
  Object.keys(orderByFolder).forEach((folderKey) => {
    if (deleted.has(folderKey)) {
      delete orderByFolder[folderKey];
      changed = true;
      return;
    }
    const oldOrder = orderByFolder[folderKey] || [];
    const nextOrder = oldOrder.filter((guid) => !deleted.has(guid));
    if (nextOrder.length !== oldOrder.length) {
      orderByFolder[folderKey] = nextOrder;
      changed = true;
    }
  });
  return changed;
}
function compareInventories(manifestEntries, actualEntries) {
  const groupByGuid = (entries) => {
    const grouped = /* @__PURE__ */ new Map();
    entries.forEach((entry) => grouped.set(entry.guid, [...grouped.get(entry.guid) || [], entry]));
    return grouped;
  };
  const manifestByGuid = groupByGuid(manifestEntries);
  const actualByGuid = groupByGuid(actualEntries);
  const duplicateManifestGuids = [...manifestByGuid].filter(([, entries]) => entries.length > 1).map(([guid]) => guid);
  const duplicateActualGuids = [...actualByGuid].filter(([, entries]) => entries.length > 1).map(([guid]) => guid);
  const missing = manifestEntries.filter((entry) => !actualByGuid.has(entry.guid));
  const extra = actualEntries.filter((entry) => !manifestByGuid.has(entry.guid));
  const moved = [];
  manifestByGuid.forEach((expectedEntries, guid) => {
    const actualEntriesForGuid = actualByGuid.get(guid);
    if (expectedEntries.length !== 1 || (actualEntriesForGuid == null ? void 0 : actualEntriesForGuid.length) !== 1) return;
    const expected = expectedEntries[0];
    const actual = actualEntriesForGuid[0];
    if (expected.parentGuid !== actual.parentGuid) moved.push({ expected, actual });
  });
  return { missing, extra, moved, duplicateManifestGuids, duplicateActualGuids };
}

// src/drag-utils.ts
function dropPositionForPointer(clientY, top, height, canNest) {
  const ratio = height > 0 ? Math.max(0, Math.min(1, (clientY - top) / height)) : 0.5;
  if (!canNest) return ratio < 0.5 ? "before" : "after";
  if (ratio < 0.3) return "before";
  if (ratio > 0.7) return "after";
  return "inside";
}
function moveBlockReason(sourcePath, sourceIsFolder, targetFolderPath, destinationExists) {
  if (sourceIsFolder && (targetFolderPath === sourcePath || targetFolderPath.startsWith(`${sourcePath}/`))) {
    return "self-or-descendant";
  }
  return destinationExists ? "conflict" : null;
}

// src/folder-note-utils.ts
function typedGuidToken(value, expectedKind) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const guid = String(value).trim();
  if (!guid || guid[0] !== expectedKind || guid[1] !== "-" && guid[1] !== ":") return null;
  return guid.slice(2) || null;
}
function pairedFolderNoteToken(input) {
  if (!input.directChild || input.folderName !== input.fileBasename) return null;
  const folderToken = typedGuidToken(input.folderGuid, "d");
  const fileToken = typedGuidToken(input.fileGuid, "f");
  return folderToken && fileToken && folderToken === fileToken ? folderToken : null;
}
function mergeChoice(globalEnabled, overrides, token) {
  return Object.prototype.hasOwnProperty.call(overrides, token) ? overrides[token] : globalEnabled;
}

// src/guid-utils.ts
function normalizeGuidBits(value) {
  return Number(value) === 72 ? 72 : 64;
}
var BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function encodeBase62(bytes, length) {
  const quotient = Array.from(bytes);
  const encoded = [];
  let first = 0;
  while (first < quotient.length) {
    let remainder = 0;
    for (let index = first; index < quotient.length; index += 1) {
      const value = remainder * 256 + quotient[index];
      quotient[index] = Math.floor(value / 62);
      remainder = value % 62;
    }
    encoded.push(BASE62[remainder]);
    while (first < quotient.length && quotient[first] === 0) first += 1;
  }
  return encoded.reverse().join("").padStart(length, "0");
}
function createTypedGuid(kind, bits = 64, used, random = globalThis.crypto) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = new Uint8Array(bits / 8);
    random.getRandomValues(bytes);
    const guid = `${kind}-${encodeBase62(bytes, bits === 72 ? 13 : 11)}`;
    if (!used || !used.has(guid)) {
      used == null ? void 0 : used.add(guid);
      return guid;
    }
  }
  throw new Error("\u65E0\u6CD5\u751F\u6210\u552F\u4E00 GUID");
}
function findDuplicateIdentities(entries) {
  const first = /* @__PURE__ */ new Map();
  const duplicate = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const initial = first.get(entry.guid);
    if (!initial) {
      first.set(entry.guid, entry);
      continue;
    }
    const group = duplicate.get(entry.guid);
    if (group) group.push(entry);
    else duplicate.set(entry.guid, [initial, entry]);
  }
  return [...duplicate.values()];
}
function remapOrderSnapshot(folderChildrenByPath, guidByPath, folderGuidByPath) {
  const result = {};
  for (const [folderPath, childPaths] of Object.entries(folderChildrenByPath)) {
    const key2 = folderPath ? folderGuidByPath.get(folderPath) : "__root__";
    if (!key2) continue;
    result[key2] = childPaths.map((path) => guidByPath.get(path)).filter((guid) => Boolean(guid));
  }
  return result;
}
async function mapLimit(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

// src/vault-transfer.ts
function safeTransferPath(value, root = false) {
  return typeof value === "string" && (value === "" ? root : !/[\\:\x00-\x1f]/.test(value) && value.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !part.startsWith(".") && part !== "__proto__"));
}
function parseVaultTransfer(value) {
  var _a;
  const v = value;
  if (!v || v.format !== "yuque-vault-transfer" || v.version !== 1 || !Array.isArray(v.items) || !v.orders || typeof v.orders !== "object" || Array.isArray(v.orders)) throw new Error("\u4E0D\u662F\u6709\u6548\u7684\u8DE8 Vault \u987A\u5E8F\u5305 v1");
  const paths = /* @__PURE__ */ new Map();
  for (const item of v.items) {
    if (!item || !safeTransferPath(item.path) || !["file", "folder"].includes(item.kind) || typeof item.guid !== "string" || !/^[A-Za-z0-9:_-]+$/.test(item.guid) || item.guid.length > 256 || ["__proto__", "constructor", "prototype"].includes(item.guid)) throw new Error("\u987A\u5E8F\u5305\u5305\u542B\u65E0\u6548\u8DEF\u5F84\u6216 GUID");
    if (paths.has(item.path)) throw new Error(`\u6765\u6E90\u5B58\u5728\u91CD\u590D\u8DEF\u5F84\uFF1A${item.path}`);
    paths.set(item.path, item);
  }
  const ordered = /* @__PURE__ */ new Set();
  for (const [parent, children] of Object.entries(v.orders)) {
    if (!safeTransferPath(parent, true) || parent && ((_a = paths.get(parent)) == null ? void 0 : _a.kind) !== "folder" || !Array.isArray(children)) throw new Error(`\u76EE\u5F55\u7D22\u5F15\u65E0\u6548\uFF1A${parent}`);
    for (const child of children) {
      if (typeof child !== "string" || !paths.has(child) || child.split("/").slice(0, -1).join("/") !== parent || ordered.has(child)) throw new Error(`\u5B50\u9879\u7D22\u5F15\u65E0\u6548\uFF1A${child}`);
      ordered.add(child);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(v.orders, "") || ordered.size !== paths.size || v.items.some((item) => item.kind === "folder" && !Object.prototype.hasOwnProperty.call(v.orders, item.path))) throw new Error("\u6765\u6E90\u76EE\u5F55\u7D22\u5F15\u4E0D\u5B8C\u6574");
  const mergeChoices = /* @__PURE__ */ Object.create(null);
  if (v.mergeChoices && typeof v.mergeChoices === "object") {
    for (const [token, choice] of Object.entries(v.mergeChoices)) if (/^[A-Za-z0-9_-]+$/.test(token) && typeof choice === "boolean") mergeChoices[token] = choice;
  }
  return { format: v.format, version: 1, items: v.items, orders: v.orders, mergeChoices };
}
function planTransferGuids(items, occupied, generate) {
  var _a;
  const used = new Set(occupied);
  const byPath = new Map(items.map((item) => [item.path, item]));
  const result = /* @__PURE__ */ new Map();
  const counts = /* @__PURE__ */ new Map();
  for (const item of items) counts.set(item.guid, (counts.get(item.guid) || 0) + 1);
  const conflict = (guid) => occupied.has(guid) || counts.get(guid) > 1;
  for (const item of items) used.add(item.guid);
  for (const item of items.filter((item2) => item2.kind === "folder").concat(items.filter((item2) => item2.kind === "file"))) {
    if (result.has(item.path)) continue;
    const name = item.path.split("/").pop();
    const note = item.kind === "folder" ? byPath.get(`${item.path}/${name}.md`) : void 0;
    const token = (_a = /^d[:-]([A-Za-z0-9_-]+)$/.exec(item.guid)) == null ? void 0 : _a[1];
    if ((note == null ? void 0 : note.kind) === "file" && token && note.guid.slice(2) === token && /^f[:-]/.test(note.guid)) {
      let folderGuid = item.guid;
      let noteGuid = note.guid;
      if (conflict(folderGuid) || conflict(noteGuid)) {
        let found = false;
        for (let attempt = 0; attempt < 32; attempt++) {
          folderGuid = generate("d", used);
          noteGuid = `f-${folderGuid.slice(2)}`;
          if (!used.has(noteGuid)) {
            used.add(noteGuid);
            found = true;
            break;
          }
        }
        if (!found) throw new Error("\u65E0\u6CD5\u751F\u6210\u552F\u4E00\u914D\u5BF9 GUID");
      }
      result.set(item.path, folderGuid);
      result.set(note.path, noteGuid);
    } else result.set(item.path, conflict(item.guid) ? generate(item.kind === "folder" ? "d" : "f", used) : item.guid);
  }
  return result;
}

// src/local-copy.ts
var key = (name) => name.normalize("NFC").toLowerCase();
function portableCopyName(name) {
  return safeTransferPath(name) && !name.includes("/") && !/[<>"|?*]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
function planCopyRoots(names, existing, choices) {
  const occupied = /* @__PURE__ */ new Map();
  for (const name of existing) {
    if (occupied.has(key(name))) throw new Error(`\u76EE\u6807\u5B58\u5728\u5927\u5C0F\u5199\u6216 Unicode \u7B49\u4EF7\u91CD\u540D\uFF1A${name}`);
    occupied.set(key(name), name);
  }
  const sourceKeys = /* @__PURE__ */ new Set();
  for (const name of names) {
    if (!portableCopyName(name) || sourceKeys.has(key(name))) throw new Error(`\u6765\u6E90\u540D\u79F0\u4E0D\u5B89\u5168\u6216\u5927\u5C0F\u5199\u91CD\u540D\uFF1A${name}`);
    sourceKeys.add(key(name));
  }
  const reserved = /* @__PURE__ */ new Set([...occupied.keys(), ...sourceKeys]);
  const assigned = /* @__PURE__ */ new Set();
  return names.map((source, index) => {
    const collision = occupied.get(key(source));
    const choice = choices.get(source);
    if (collision && !choice) throw new Error(`\u8BF7\u9009\u62E9\u540C\u540D\u9879\u5904\u7406\u65B9\u5F0F\uFF1A${source}`);
    let target = source;
    let replaces = false;
    if ((choice == null ? void 0 : choice.mode) === "replace" && collision) {
      target = collision;
      replaces = true;
    } else if ((choice == null ? void 0 : choice.mode) === "rename") {
      target = (choice.name || "").trim();
      if (!portableCopyName(target) || key(target) !== key(source) && reserved.has(key(target)) || occupied.has(key(target))) throw new Error(`\u65B0\u540D\u79F0\u65E0\u6548\u6216\u5DF2\u88AB\u5360\u7528\uFF1A${target}`);
    } else if ((choice == null ? void 0 : choice.mode) === "number") {
      const stem = `${String(index + 1).padStart(3, "0")}-${source}`;
      target = stem;
      let retry = 2;
      while (reserved.has(key(target))) target = `${String(index + 1).padStart(3, "0")}-${retry++}-${source}`;
    } else if (collision && !replaces) throw new Error(`\u672A\u89E3\u51B3\u540C\u540D\u9879\uFF1A${source}`);
    if (assigned.has(key(target))) throw new Error(`\u4E24\u4E2A\u8FC1\u5165\u9879\u4F7F\u7528\u540C\u4E00\u540D\u79F0\uFF1A${target}`);
    reserved.add(key(target));
    assigned.add(key(target));
    return { source, target, replaces };
  });
}
function copyPathMap(pack, roots) {
  const rootMap = new Map(roots.map((root) => [root.source, root.target]));
  const pairs = /* @__PURE__ */ new Map();
  const byPath = new Map(pack.items.map((item) => [item.path, item]));
  for (const root of roots) {
    const folder = byPath.get(root.source);
    const extension = (name) => name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
    if ((folder == null ? void 0 : folder.kind) === "file" && extension(root.source) !== extension(root.target)) throw new Error(`\u6587\u4EF6\u91CD\u547D\u540D\u9700\u4FDD\u7559\u6269\u5C55\u540D\uFF1A${root.source}`);
    const notePath = `${root.source}/${root.source}.md`;
    const note = byPath.get(notePath);
    if (root.source !== root.target && (folder == null ? void 0 : folder.kind) === "folder" && /^d[:-]/.test(folder.guid) && (note == null ? void 0 : note.kind) === "file" && /^f[:-]/.test(note.guid) && folder.guid.slice(2) === note.guid.slice(2)) {
      const desired = `${root.source}/${root.target}.md`;
      if (pack.orders[root.source].some((path) => key(path) === key(desired) && path !== notePath)) throw new Error(`\u91CD\u547D\u540D\u4F1A\u4E0E\u914D\u5BF9\u7B14\u8BB0\u7684\u5144\u5F1F\u6587\u4EF6\u51B2\u7A81\uFF1A${desired}`);
      pairs.set(notePath, `${root.target}/${root.target}.md`);
    }
  }
  return new Map(pack.items.map((item) => {
    const slash = item.path.indexOf("/");
    const first = slash < 0 ? item.path : item.path.slice(0, slash);
    const renamed = rootMap.get(first);
    if (!renamed) throw new Error(`\u7F3A\u5C11\u590D\u5236\u8BA1\u5212\uFF1A${item.path}`);
    return [item.path, pairs.get(item.path) || renamed + (slash < 0 ? "" : item.path.slice(slash))];
  }));
}
function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isDirectory()].join(":");
}
async function exists(io, path) {
  try {
    await io.fs.promises.lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function contained(io, root, target) {
  const rel = io.path.relative(root, target);
  return rel === "" || !io.path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${io.path.sep}`);
}
async function checkedDirectory(io, value) {
  if (!io.path.isAbsolute(value)) throw new Error("\u6765\u6E90\u5FC5\u987B\u662F\u672C\u673A\u7EDD\u5BF9\u8DEF\u5F84");
  const full = io.path.resolve(value);
  let cursor = full;
  while (true) {
    const stat = await io.fs.promises.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`\u4E0D\u652F\u6301\u7B26\u53F7\u94FE\u63A5\u6216\u76EE\u5F55\u8054\u63A5\uFF1A${cursor}`);
    const parent = io.path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!(await io.fs.promises.stat(full)).isDirectory()) throw new Error(`\u4E0D\u662F\u76EE\u5F55\uFF1A${full}`);
  return io.fs.promises.realpath(full);
}
async function resolveCopyDestination(io, vaultRoot, input) {
  const absolute = input ? io.path.resolve(vaultRoot, input) : vaultRoot;
  if (!contained(io, vaultRoot, absolute)) throw new Error("\u76EE\u6807\u5FC5\u987B\u662F\u5F53\u524D Vault \u6216\u5176\u5185\u90E8\u76EE\u5F55\uFF0C\u4E0D\u80FD\u9009\u62E9\u5E93\u5916\u76EE\u5F55");
  const relative = io.path.relative(vaultRoot, absolute).split(io.path.sep).join("/");
  if (!safeTransferPath(relative, true) || relative.split("/").some((part) => part && !portableCopyName(part))) throw new Error("\u76EE\u6807\u76EE\u5F55\u540D\u79F0\u65E0\u6548\uFF0C\u4E0D\u652F\u6301\u9690\u85CF\u76EE\u5F55\u3001\u4E0A\u7EA7\u8DEF\u5F84\u6216\u7279\u6B8A\u540D\u79F0");
  const missing = [];
  let cursor = vaultRoot, rel = "", parentExists = true;
  for (const name of relative ? relative.split("/") : []) {
    if (parentExists) {
      const siblings = await io.fs.promises.readdir(cursor);
      const equivalent = siblings.find((other) => key(other) === key(name));
      if (equivalent && equivalent !== name) throw new Error(`\u76EE\u6807\u76EE\u5F55\u540D\u79F0\u5927\u5C0F\u5199\u6216 Unicode \u4E0D\u4E00\u81F4\uFF0C\u8BF7\u901A\u8FC7\u9009\u62E9\u76EE\u5F55\u586B\u5165\u5B9E\u9645\u8DEF\u5F84\uFF1A${name}`);
    }
    cursor = io.path.join(cursor, name);
    rel = rel ? `${rel}/${name}` : name;
    if (parentExists && await exists(io, cursor)) await checkedDirectory(io, cursor);
    else {
      parentExists = false;
      missing.push(rel);
    }
  }
  return { absolute, relative, missing };
}
async function scanDisk(io, root, hidden = false) {
  const result = [];
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    const absolute = io.path.join(root, relative);
    const stat = await io.fs.promises.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error(`\u4E0D\u652F\u6301\u94FE\u63A5\u6216\u7279\u6B8A\u6587\u4EF6\uFF1A${absolute}`);
    result.push({ path: relative, kind: stat.isDirectory() ? "folder" : "file", stamp: stamp(stat), size: stat.size, mtimeMs: stat.mtimeMs });
    if (stat.isDirectory()) {
      const names = await io.fs.promises.readdir(absolute);
      const keys = /* @__PURE__ */ new Set();
      for (const name of names) {
        if (!hidden && name.startsWith(".")) continue;
        if (!hidden && !portableCopyName(name)) throw new Error(`\u6765\u6E90\u540D\u79F0\u4E0D\u652F\u6301\u5B89\u5168\u590D\u5236\uFF1A${name}`);
        if (keys.has(key(name))) throw new Error(`\u76EE\u5F55\u5B58\u5728\u5927\u5C0F\u5199\u6216 Unicode \u7B49\u4EF7\u91CD\u540D\uFF1A${absolute}/${name}`);
        keys.add(key(name));
        pending.push(relative ? `${relative}/${name}` : name);
      }
    }
    if (result.length % 250 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return result;
}
async function verifyDisk(io, root, expected, hidden = false) {
  const current = await scanDisk(io, root, hidden);
  const before = new Map(expected.map((entry) => [entry.path, entry.stamp]));
  if (current.length !== expected.length || current.some((entry) => before.get(entry.path) !== entry.stamp)) throw new Error(`\u9884\u68C0\u540E\u5185\u5BB9\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u68C0\uFF1A${root}`);
}
async function verifyInstalledCopies(io, target, roots, staged) {
  const expected = new Map(staged.filter((entry) => entry.path).map((entry) => [entry.path, entry]));
  let count = 0;
  for (const root of roots) {
    for (const entry of await scanDisk(io, io.path.join(target, root.target), true)) {
      const relative = entry.path ? `${root.target}/${entry.path}` : root.target;
      const previous = expected.get(relative);
      count++;
      if (!previous || previous.kind !== entry.kind || entry.kind === "file" && (previous.size !== entry.size || Math.abs(previous.mtimeMs - entry.mtimeMs) >= 2)) throw new Error(`\u5B89\u88C5\u540E\u7684\u526F\u672C\u53D1\u751F\u53D8\u5316\uFF1A${relative}`);
    }
  }
  if (count !== expected.size) throw new Error("\u5B89\u88C5\u540E\u7684\u526F\u672C\u9879\u76EE\u96C6\u5408\u53D1\u751F\u53D8\u5316");
}
async function markdownHeader(io, path) {
  const handle = await io.fs.promises.open(path, "r");
  try {
    const size = (await handle.stat()).size;
    for (const limit of [4096, 256 * 1024]) {
      const buffer = new Uint8Array(Math.min(size, limit));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      const bom = buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191;
      const text = new TextDecoder().decode(buffer.subarray(bom ? 3 : 0, bytesRead));
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      if (!/^---[ \t]*\r?\n/.test(text)) return { yaml: null, offset: bom ? 3 : 0, bom, eol };
      const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
      if (match && (match[0].endsWith("\n") || bytesRead === size)) return { yaml: match[1], offset: new TextEncoder().encode(match[0]).length + (bom ? 3 : 0), bom, eol };
      if (bytesRead === size) break;
    }
    throw new Error(`frontmatter \u672A\u95ED\u5408\u6216\u8D85\u8FC7 256 KiB\uFF1A${path}`);
  } finally {
    await handle.close();
  }
}
async function copyMarkdown(io, source, destination, yaml, header) {
  const input = await io.fs.promises.open(source, "r");
  let output;
  try {
    output = await io.fs.promises.open(destination, "wx");
    await output.writeFile(`${header.bom ? "\uFEFF" : ""}---${header.eol}${yaml.replace(/\s+$/, "").replace(/\r?\n/g, header.eol)}${header.eol}---${header.eol}`);
    const buffer = new Uint8Array(64 * 1024);
    let position = header.offset;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, null)).bytesWritten;
      position += bytesRead;
    }
  } finally {
    await input.close();
    if (output) await output.close();
  }
}
async function installCopies(io, options) {
  var _a, _b;
  const { roots, target, workspace } = options;
  await checkedDirectory(io, target);
  if (!contained(io, io.path.dirname(workspace), workspace) || contained(io, workspace, target)) throw new Error("\u5907\u4EFD\u8DEF\u5F84\u4E0E\u76EE\u6807\u51B2\u7A81");
  await options.verify();
  const installed = [], backedUp = [];
  const journalPath = io.path.join(workspace, "transaction.json");
  const journal = async (phase, root) => {
    await io.fs.promises.appendFile(io.path.join(workspace, "progress.jsonl"), JSON.stringify({ phase, root }) + "\n");
  };
  await io.fs.promises.mkdir(io.path.join(workspace, "originals"));
  await io.fs.promises.writeFile(journalPath, JSON.stringify({ version: 1, target, roots }), { flag: "wx" });
  await journal("prepared");
  try {
    for (const root of roots) {
      (_a = options.checkCancelled) == null ? void 0 : _a.call(options);
      if (!portableCopyName(root.target) || !portableCopyName(root.source)) throw new Error("\u590D\u5236\u540D\u79F0\u65E0\u6548");
      const destination = io.path.join(target, root.target);
      if (root.replaces) {
        if (!await exists(io, destination)) throw new Error(`\u66FF\u6362\u76EE\u6807\u5DF2\u6D88\u5931\uFF1A${root.target}`);
        await io.fs.promises.rename(destination, io.path.join(workspace, "originals", root.target));
        backedUp.push(root);
        await journal("backed-up", root);
      } else if (await exists(io, destination)) throw new Error(`\u76EE\u6807\u5DF2\u88AB\u5176\u4ED6\u64CD\u4F5C\u521B\u5EFA\uFF1A${root.target}`);
      await io.fs.promises.rename(io.path.join(workspace, "staged", root.target), destination);
      installed.push(root);
      await journal("installed", root);
    }
    (_b = options.checkCancelled) == null ? void 0 : _b.call(options);
    await options.commitData();
    await journal("complete");
  } catch (error) {
    const failures = [];
    for (const root of installed.slice().reverse()) {
      try {
        await io.fs.promises.rename(io.path.join(target, root.target), io.path.join(workspace, "staged", root.target));
      } catch (e) {
        failures.push(root.target);
      }
    }
    for (const root of backedUp.slice().reverse()) {
      try {
        const destination = io.path.join(target, root.target);
        if (await exists(io, destination)) throw new Error("\u76EE\u6807\u88AB\u5360\u7528");
        await io.fs.promises.rename(io.path.join(workspace, "originals", root.target), destination);
      } catch (e) {
        failures.push(root.target);
      }
    }
    try {
      await options.rollbackData();
    } catch (e) {
      failures.push("data.json");
    }
    await journal(failures.length ? "recovery-required" : "rolled-back").catch(() => void 0);
    throw new Error(`${String(error)}\uFF1B${failures.length ? `\u56DE\u6EDA\u4E0D\u5B8C\u6574\uFF1A${failures.join("\uFF1B")}` : "\u5DF2\u56DE\u6EDA"}\u3002\u4FDD\u7559\u6062\u590D\u76EE\u5F55\uFF1A${workspace}`);
  }
}

// src/directory-picker.ts
async function chooseDirectory(load, title, initial) {
  var _a, _b;
  const electron = load("electron");
  let dialog = electron.dialog || ((_a = electron.remote) == null ? void 0 : _a.dialog);
  if (!dialog) {
    try {
      dialog = load("@electron/remote").dialog;
    } catch (e) {
    }
  }
  if (dialog == null ? void 0 : dialog.showOpenDialog) {
    const result = await dialog.showOpenDialog({ title, defaultPath: initial || void 0, properties: ["openDirectory", "dontAddToRecent"] });
    return result.canceled ? null : ((_b = result.filePaths) == null ? void 0 : _b[0]) || null;
  }
  const process = load("process");
  if (process.platform !== "win32") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u672A\u63D0\u4F9B\u76EE\u5F55\u9009\u62E9\u7A97\u53E3\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u7EDD\u5BF9\u8DEF\u5F84");
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = $env:YQ_PICK_TITLE; $picker.SelectedPath = $env:YQ_PICK_INITIAL; $picker.ShowNewFolderButton = $false; try { if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) } } finally { $picker.Dispose() }";
  return new Promise((resolve, reject) => {
    load("child_process").execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024, env: { ...process.env, YQ_PICK_TITLE: title, YQ_PICK_INITIAL: initial } },
      (error, stdout) => error ? reject(new Error("\u65E0\u6CD5\u6253\u5F00\u7CFB\u7EDF\u76EE\u5F55\u9009\u62E9\u7A97\u53E3\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u7EDD\u5BF9\u8DEF\u5F84")) : resolve(stdout.trim() || null)
    );
  });
}

// src/local-source.ts
function yamlObject(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Markdown frontmatter \u5FC5\u987B\u662F YAML \u5BF9\u8C61");
  return value;
}
async function sourceTransfer(io, root, entries, pluginId, generate, parseYaml2) {
  var _a, _b, _c, _d, _e;
  let cursor = root, vaultRoot = root, data = {}, metadataPath = "", metadataText = "";
  while (true) {
    let candidate = io.path.join(cursor, ".obsidian", "plugins", pluginId, "data.json");
    if (pluginId === "yuque-sorting" && !await exists(io, candidate)) candidate = io.path.join(cursor, ".obsidian", "plugins", "yuque-order-drag", "data.json");
    if (await exists(io, candidate)) {
      await checkedDirectory(io, io.path.dirname(candidate));
      if ((await io.fs.promises.lstat(candidate)).isSymbolicLink()) throw new Error("\u6765\u6E90\u63D2\u4EF6\u6570\u636E\u4E0D\u80FD\u662F\u7B26\u53F7\u94FE\u63A5");
      if ((await io.fs.promises.stat(candidate)).size > 64 * 1024 * 1024) throw new Error("\u6765\u6E90\u63D2\u4EF6\u6570\u636E\u8D85\u8FC7 64 MiB\uFF0C\u8BF7\u4F7F\u7528\u624B\u52A8\u987A\u5E8F\u5305");
      metadataPath = candidate;
      metadataText = await io.fs.promises.readFile(candidate, "utf8");
      data = JSON.parse(metadataText);
      vaultRoot = cursor;
      break;
    }
    if (await exists(io, io.path.join(cursor, ".obsidian"))) break;
    const parent = io.path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!data || typeof data !== "object") throw new Error("\u6765\u6E90 data.json \u65E0\u6548");
  const pack = { format: "yuque-vault-transfer", version: 1, items: [], orders: /* @__PURE__ */ Object.create(null), mergeChoices: /* @__PURE__ */ Object.create(null) };
  const used = /* @__PURE__ */ new Set();
  const grouped = /* @__PURE__ */ new Map();
  grouped.set("", []);
  const base = io.path.relative(vaultRoot, root).split(io.path.sep).join("/");
  const fullPath = (relative) => base ? relative ? `${base}/${relative}` : base : relative;
  let generated = 0, fallback = 0;
  for (const entry of entries) {
    if (!entry.path) continue;
    let raw;
    if (entry.kind === "file" && /\.md$/i.test(entry.path)) {
      const header = await markdownHeader(io, io.path.join(root, entry.path));
      raw = header.yaml === null ? null : yamlObject(parseYaml2(header.yaml)).guid;
    } else raw = (_a = entry.kind === "folder" ? data.folderGuids : data.fileGuids) == null ? void 0 : _a[fullPath(entry.path)];
    const guid = typeof raw === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(raw) && !["__proto__", "constructor", "prototype"].includes(raw) ? raw : generate(entry.kind === "folder" ? "d" : "f", used);
    if (raw !== guid) generated++;
    used.add(guid);
    const item = { path: entry.path, kind: entry.kind, guid };
    pack.items.push(item);
    if (pack.items.length % 250 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const parent = entry.path.split("/").slice(0, -1).join("/");
    if (!grouped.has(parent)) grouped.set(parent, []);
    grouped.get(parent).push(item);
    if (entry.kind === "folder" && !grouped.has(entry.path)) grouped.set(entry.path, []);
  }
  const byPath = new Map(pack.items.map((item) => [item.path, item]));
  const collator = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
  for (const [parent, children] of grouped) {
    const sourcePath = fullPath(parent);
    const folderGuid = (_b = data.folderGuids) == null ? void 0 : _b[sourcePath || "/"];
    const saved = (_c = data.orderByFolder) == null ? void 0 : _c[folderGuid || (sourcePath ? "" : "__root__")];
    const rank = /* @__PURE__ */ new Map();
    if (Array.isArray(saved)) saved.forEach((guid, index) => {
      if (!rank.has(guid)) rank.set(guid, index);
    });
    fallback += children.filter((item) => !rank.has(item.guid)).length;
    children.sort((a, b) => {
      var _a2, _b2;
      return ((_a2 = rank.get(a.guid)) != null ? _a2 : Number.MAX_SAFE_INTEGER) - ((_b2 = rank.get(b.guid)) != null ? _b2 : Number.MAX_SAFE_INTEGER) || collator.compare(a.path, b.path) || a.path.localeCompare(b.path);
    });
    pack.orders[parent] = children.map((item) => item.path);
    if (parent) {
      const guid = byPath.get(parent).guid;
      const choice = (_d = data.folderNoteMergeOverrides) == null ? void 0 : _d[guid.slice(2)];
      pack.mergeChoices[guid.slice(2)] = typeof choice === "boolean" ? choice : Boolean((_e = data.settings) == null ? void 0 : _e.mergePairedFolderNotes);
    }
  }
  return { pack: parseVaultTransfer(pack), fallback, generated, metadataPath, metadataText };
}

// src/manifest-restore-view.ts
var MANIFEST_PREVIEW_LIMIT = 10;
var MANIFEST_PROBLEM_LIMIT = 12;
function splitManifestProblem(problem) {
  const separator = problem.indexOf("\uFF1A");
  if (separator === -1) return { path: "", reason: problem };
  return { path: problem.slice(0, separator), reason: problem.slice(separator + 1) };
}
function renderManifestRestoreView(container, view) {
  const wrap = container.createDiv({ cls: "yq-manifest-restore" });
  const statsEl = wrap.createDiv({ cls: "yq-manifest-stats" });
  const stats = [
    { label: "\u6709\u6548\u6E05\u5355", value: `${view.manifestCount} \u4EFD` },
    { label: "\u987A\u5E8F\u5C06\u53D8\u5316", value: `${view.changedDirectories} \u4E2A\u76EE\u5F55`, tone: view.changedDirectories ? "warn" : "ok" },
    { label: "\u663E\u793A\u4F4D\u7F6E\u4E0D\u540C", value: `${view.changedPositions} \u5904`, tone: view.changedPositions ? "warn" : "ok" },
    { label: "\u6E05\u5355\u5DEE\u5F02", value: `${view.problems.length} \u9879`, tone: view.problems.length ? "warn" : "ok" }
  ];
  stats.forEach(({ label, value, tone }) => {
    const cell = statsEl.createDiv({ cls: `yq-manifest-stat${tone ? ` is-${tone}` : ""}` });
    cell.createSpan({ cls: "yq-manifest-stat-label", text: label });
    cell.createSpan({ cls: "yq-manifest-stat-value", text: value });
  });
  wrap.createEl("p", {
    cls: "yq-manifest-status",
    text: view.changedDirectories ? "\u4E0B\u5217\u793A\u4F8B\u76EE\u5F55\u7684\u663E\u793A\u987A\u5E8F\u5C06\u4E0E\u6E05\u5355\u4E0D\u540C\uFF1B\u786E\u8BA4\u540E\u6309\u6E05\u5355\u987A\u5E8F\u6392\u5217\uFF0C\u672A\u5217\u51FA\u7684\u53D8\u5316\u76EE\u5F55\u540C\u6837\u5904\u7406\u3002" : "\u5F53\u524D\u53EF\u5339\u914D\u9879\u76EE\u7684\u663E\u793A\u987A\u5E8F\u4E0E\u6E05\u5355\u4E00\u81F4\uFF0C\u786E\u8BA4\u540E\u4E0D\u4F1A\u6539\u53D8\u4EFB\u4F55\u76EE\u5F55\u7684\u73B0\u6709\u987A\u5E8F\u3002"
  });
  const previews = view.previews.slice(0, MANIFEST_PREVIEW_LIMIT);
  if (previews.length) {
    const section = wrap.createDiv({ cls: "yq-manifest-section" });
    section.createEl("h4", { text: `\u987A\u5E8F\u53D8\u5316\u793A\u4F8B\uFF08${previews.length} / ${view.changedDirectories}\uFF09` });
    const list = section.createEl("ul", { cls: "yq-manifest-preview" });
    previews.forEach(({ folder, current, next }) => {
      const item = list.createEl("li");
      item.createDiv({ cls: "yq-manifest-folder", text: folder });
      const currentRow = item.createDiv({ cls: "yq-manifest-order" });
      currentRow.createSpan({ cls: "yq-manifest-tag", text: "\u5F53\u524D" });
      currentRow.createSpan({ text: current });
      const nextRow = item.createDiv({ cls: "yq-manifest-order is-next" });
      nextRow.createSpan({ cls: "yq-manifest-tag", text: "\u6062\u590D\u540E" });
      nextRow.createSpan({ text: next });
    });
  }
  if (view.problems.length) {
    const section = wrap.createDiv({ cls: "yq-manifest-section is-problems" });
    section.createEl("h4", { text: `\u6E05\u5355\u5DEE\u5F02\uFF08${view.problems.length}\uFF09` });
    const list = section.createEl("ul", { cls: "yq-manifest-problems" });
    view.problems.slice(0, MANIFEST_PROBLEM_LIMIT).forEach((problem) => {
      const { path, reason } = splitManifestProblem(problem);
      const item = list.createEl("li");
      if (path) item.createDiv({ cls: "yq-manifest-path", text: path });
      item.createDiv({ cls: "yq-manifest-reason", text: reason });
    });
    if (view.problems.length > MANIFEST_PROBLEM_LIMIT) {
      list.createEl("li", { cls: "yq-manifest-more", text: `\u53E6\u6709 ${view.problems.length - MANIFEST_PROBLEM_LIMIT} \u9879\u2026\u2026` });
    }
    section.createEl("p", { cls: "yq-manifest-hint", text: "\u7EE7\u7EED\u4EC5\u5904\u7406\u80FD\u591F\u5339\u914D\u7684\u9879\u76EE\uFF0C\u4EE5\u4E0A\u5DEE\u5F02\u4E0D\u4F1A\u81EA\u52A8\u4FEE\u590D\u3002" });
  }
  const notes = [
    view.newManifests ? `${view.newManifests} \u4EFD\u6E05\u5355\u4E3A\u9996\u6B21\u4F7F\u7528\uFF0C\u5C06\u91C7\u7528\u6E05\u5355\u91CC\u7684 GUID \u5E76\u5EFA\u7ACB\u7D22\u5F15\uFF1BMarkdown \u6B63\u6587\u4E0D\u6539\u5199\u3002` : "\u4EC5\u6062\u590D\u987A\u5E8F\uFF0C\u4E0D\u8986\u76D6\u540E\u6765\u66F4\u6362\u7684 GUID\u3002",
    "\u5339\u914D\u53EA\u770B\u6E05\u5355\u4E2D\u7684\u8DEF\u5F84\uFF0C\u4E0D\u770B\u6587\u4EF6\u5185\u5BB9\uFF1A\u5DF2\u6539\u540D\u6216\u79FB\u52A8\u8FC7\u7684\u9879\u76EE\u65E0\u6CD5\u6062\u590D\u539F\u987A\u5E8F\uFF0C\u4F1A\u63D0\u793A\u7F3A\u5931/\u591A\u51FA\u3002"
  ];
  if (view.newManifests < view.manifestCount) {
    notes.push("\u540C\u4E00\u8DEF\u5F84\u82E5\u5DF2\u6362\u6210\u53E6\u4E00\u4E2A\u6587\u4EF6\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u8BC6\u522B\uFF0C\u4F1A\u76F4\u63A5\u6309\u6E05\u5355\u4F4D\u7F6E\u7ED9\u5B83\u6392\u5E8F\u3002");
  }
  notes.push("\u4E0D\u79FB\u52A8\u3001\u91CD\u547D\u540D\u6216\u5220\u9664\u5B9E\u9645\u6587\u4EF6\u3002");
  notes.push("\u786E\u8BA4\u540E\u4F1A\u6E05\u7A7A\u62D6\u62FD\u64A4\u9500\u5386\u53F2\uFF1B\u53D6\u6D88\u6216\u5173\u95ED\u7A97\u53E3\u4E0D\u4FEE\u6539\u6570\u636E\u3002");
  const noteList = wrap.createEl("ul", { cls: "yq-manifest-notes" });
  notes.forEach((note) => noteList.createEl("li", { text: note }));
}

// src/order-data-sync.ts
var MAP_FIELDS = [
  "settings",
  "orderByFolder",
  "folderGuids",
  "fileGuids",
  "detachedFolderNotes",
  "folderNoteMergeOverrides",
  "transferReceipts"
];
var same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function mergeOrderData(base, local, disk) {
  const baseline = base;
  const ours = local;
  const theirs = disk;
  const result = {};
  const conflicts = [];
  const fields = /* @__PURE__ */ new Set([...Object.keys(baseline), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const field of fields) {
    if (MAP_FIELDS.includes(field)) {
      const previous = baseline[field] || {};
      const current = ours[field] || {};
      const incoming = theirs[field] || {};
      const merged = {};
      const keys = /* @__PURE__ */ new Set([...Object.keys(previous), ...Object.keys(current), ...Object.keys(incoming)]);
      for (const key2 of keys) {
        const a = previous[key2], b = current[key2], c = incoming[key2];
        if (same(b, c)) {
          if (b !== void 0) merged[key2] = b;
        } else if (same(a, b)) {
          if (c !== void 0) merged[key2] = c;
        } else if (same(a, c)) {
          if (b !== void 0) merged[key2] = b;
        } else conflicts.push(`${field}.${key2}`);
      }
      result[field] = merged;
    } else {
      const a = baseline[field], b = ours[field], c = theirs[field];
      if (same(b, c)) result[field] = b;
      else if (same(a, b)) result[field] = c;
      else if (same(a, c)) result[field] = b;
      else conflicts.push(field);
    }
  }
  if (!conflicts.length) {
    const pathsByGuid = /* @__PURE__ */ new Map();
    for (const field of ["folderGuids", "fileGuids"]) {
      for (const [path, guid] of Object.entries(result[field] || {})) {
        if (typeof guid !== "string") continue;
        const previousPath = pathsByGuid.get(guid);
        if (previousPath && previousPath !== `${field}.${path}`) conflicts.push(`duplicateGuid.${guid}`);
        else pathsByGuid.set(guid, `${field}.${path}`);
      }
    }
  }
  return { data: conflicts.length ? null : result, conflicts };
}
function validateStoredOrderData(raw) {
  const value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("data.json \u9876\u5C42\u5FC5\u987B\u662F\u5BF9\u8C61");
  const saved = value;
  if (saved.version !== void 0 && saved.version !== 1 && saved.version !== 2) {
    throw new Error("data.json \u7248\u672C\u4E0D\u53D7\u652F\u6301");
  }
  if (saved.orderByFolder === void 0) throw new Error("data.json \u7F3A\u5C11\u76EE\u5F55\u987A\u5E8F");
  for (const field of ["settings", ...MAP_FIELDS.filter((name) => name !== "settings")]) {
    const mapping = saved[field];
    if (mapping === void 0) continue;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new Error(`data.json \u7684 ${field} \u65E0\u6548`);
    }
  }
  for (const [key2, order] of Object.entries(saved.orderByFolder || {})) {
    if (!Array.isArray(order) || order.some((guid) => typeof guid !== "string")) {
      throw new Error(`data.json \u7684\u76EE\u5F55\u987A\u5E8F ${key2} \u65E0\u6548`);
    }
  }
  for (const field of ["folderGuids", "fileGuids", "detachedFolderNotes"]) {
    for (const [path, guid] of Object.entries(saved[field] || {})) {
      if (typeof guid !== "string") throw new Error(`data.json \u7684 ${field}.${path} \u65E0\u6548`);
    }
  }
  return saved;
}

// main.ts
var MANIFEST_NAME = "_yuque_order.json";
var GUID_FRONTMATTER_KEY = "guid";
var DEFAULT_SETTINGS = {
  newItemPlacement: "bottom",
  fallbackSort: "name-last",
  persistOrderOnCreateDelete: true,
  enableDrag: true,
  guidBits: 64,
  scanDuplicateGuidsOnStartup: false,
  mergePairedFolderNotes: false
};
function isMarkdown(file) {
  return file instanceof import_obsidian.TFile && file.extension.toLowerCase() === "md";
}
function parentPath(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
function basename(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}
function stripMarkdown(path) {
  return path.replace(/\.md$/i, "");
}
function createGuid(kind, bits = 64, used) {
  return createTypedGuid(kind, bits, used);
}
function yieldToUi() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
var ConfirmActionModal = class extends import_obsidian.Modal {
  constructor(app, titleText, message, confirmText, resolveChoice, renderDetails) {
    super(app);
    this.titleText = titleText;
    this.message = message;
    this.confirmText = confirmText;
    this.resolveChoice = resolveChoice;
    this.renderDetails = renderDetails;
    this.settled = false;
  }
  onOpen() {
    this.setTitle(this.titleText);
    if (this.renderDetails) this.renderDetails(this.contentEl);
    else this.contentEl.createEl("p", { text: this.message });
    new import_obsidian.Setting(this.contentEl).addButton((button) => button.setButtonText("\u53D6\u6D88").onClick(() => this.finish(false))).addButton((button) => button.setButtonText(this.confirmText).setWarning().onClick(() => this.finish(true)));
  }
  onClose() {
    this.contentEl.empty();
    if (!this.settled) this.resolveChoice(false);
  }
  finish(choice) {
    if (this.settled) return;
    this.settled = true;
    this.resolveChoice(choice);
    this.close();
  }
};
var SettingDetailsModal = class extends import_obsidian.Modal {
  constructor(app, titleText, paragraphs) {
    super(app);
    this.titleText = titleText;
    this.paragraphs = paragraphs;
  }
  onOpen() {
    this.setTitle(this.titleText);
    const body = this.contentEl.createDiv({ cls: "yq-setting-details" });
    this.paragraphs.forEach((paragraph) => body.createEl("p", { text: paragraph }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var CopyConflictModal = class extends import_obsidian.Modal {
  constructor(app, names, resolveChoices) {
    super(app);
    this.names = names;
    this.resolveChoices = resolveChoices;
    this.settled = false;
    this.page = 0;
    this.choices = /* @__PURE__ */ new Map();
    names.forEach((name) => this.choices.set(name, { mode: "number" }));
  }
  onOpen() {
    this.render();
  }
  render() {
    this.contentEl.empty();
    this.setTitle(`\u5904\u7406 ${this.names.length} \u4E2A\u540C\u7EA7\u91CD\u540D\u9879`);
    this.contentEl.createEl("p", { text: "\u66FF\u6362\uFF1D\u6574\u4E2A\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u66FF\u6362\uFF0C\u76EE\u6807\u72EC\u6709\u5B50\u9879\u4E5F\u4F1A\u79FB\u5165\u5907\u4EFD\u3002\u91CD\u547D\u540D\u548C\u7F16\u53F7\u53EA\u4FEE\u6539\u8FC1\u5165\u526F\u672C\u3002\u6BCF\u9875\u6700\u591A 50 \u9879\u3002\u5173\u95ED\u6216\u53D6\u6D88\u4E0D\u4F1A\u590D\u5236\u3002" });
    new import_obsidian.Setting(this.contentEl).setName("\u7EDF\u4E00\u5904\u7406\u5168\u90E8\u51B2\u7A81").addDropdown((dropdown) => dropdown.addOption("", "\u8BF7\u9009\u62E9\u6279\u91CF\u64CD\u4F5C").addOption("number", "\u81EA\u52A8\u6309\u6765\u6E90\u987A\u5E8F\u7F16\u53F7").addOption("replace", "\u5168\u90E8\u66FF\u6362\uFF08\u540E\u7EED\u518D\u6B21\u786E\u8BA4\uFF09").onChange((value) => {
      if (!value) return;
      this.names.forEach((name) => this.choices.set(name, { mode: value }));
      this.render();
    }));
    for (const name of this.names.slice(this.page * 50, (this.page + 1) * 50)) {
      const choice = this.choices.get(name);
      const row = new import_obsidian.Setting(this.contentEl).setName(name);
      row.addDropdown((dropdown) => dropdown.addOption("number", "\u81EA\u52A8\u7F16\u53F7").addOption("rename", "\u91CD\u547D\u540D").addOption("replace", "\u6574\u9879\u66FF\u6362").setValue(choice.mode).onChange((value) => {
        this.choices.set(name, { mode: value, name: choice.name });
        this.render();
      }));
      if (choice.mode === "rename") row.addText((text) => text.setPlaceholder("\u65B0\u540D\u79F0\uFF0C\u6587\u4EF6\u8BF7\u4FDD\u7559\u6269\u5C55\u540D").setValue(choice.name || "").onChange((value) => {
        choice.name = value;
      }));
    }
    new import_obsidian.Setting(this.contentEl).setName(`\u7B2C ${this.page + 1} / ${Math.ceil(this.names.length / 50)} \u9875`).addButton((button) => button.setButtonText("\u4E0A\u4E00\u9875").setDisabled(this.page === 0).onClick(() => {
      this.page--;
      this.render();
    })).addButton((button) => button.setButtonText("\u4E0B\u4E00\u9875").setDisabled((this.page + 1) * 50 >= this.names.length).onClick(() => {
      this.page++;
      this.render();
    }));
    new import_obsidian.Setting(this.contentEl).addButton((button) => button.setButtonText("\u53D6\u6D88").onClick(() => this.finish(null))).addButton((button) => button.setButtonText("\u67E5\u770B\u6700\u7EC8\u590D\u5236\u8BA1\u5212").setCta().onClick(() => this.finish(this.choices)));
  }
  finish(choice) {
    this.settled = true;
    this.resolveChoices(choice);
    this.close();
  }
  onClose() {
    this.contentEl.empty();
    if (!this.settled) this.resolveChoices(null);
  }
};
var IdentitySelectionModal = class extends import_obsidian.Modal {
  constructor(app, items, onSubmit) {
    super(app);
    this.items = items;
    this.onSubmit = onSubmit;
    this.selected = /* @__PURE__ */ new Set();
    this.query = "";
  }
  onOpen() {
    this.setTitle("\u9009\u62E9\u8981\u7EB3\u5165\u7BA1\u7406\u7684\u6587\u4EF6\u548C\u6587\u4EF6\u5939");
    this.contentEl.createEl("p", { text: "\u53EF\u641C\u7D22\u5E76\u52FE\u9009\u5F53\u524D\u5E93\u4E2D\u7684\u6587\u4EF6\u6216\u6587\u4EF6\u5939" });
    const search = this.contentEl.createEl("input", {
      cls: "yq-order-selection-search",
      attr: { type: "search", placeholder: "\u6309\u8DEF\u5F84\u641C\u7D22" }
    });
    this.countEl = this.contentEl.createEl("div", { cls: "setting-item-description" });
    this.listEl = this.contentEl.createDiv({ cls: "yq-order-selection-list" });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLocaleLowerCase();
      this.renderList();
    });
    new import_obsidian.Setting(this.contentEl).addButton((button) => button.setButtonText("\u53D6\u6D88").onClick(() => this.close())).addButton((button) => button.setButtonText("\u4EC5\u751F\u6210\u7F3A\u5931 GUID").onClick(() => this.finish("missing"))).addButton((button) => button.setButtonText("\u91CD\u65B0\u751F\u6210\u9009\u4E2D GUID").setWarning().onClick(() => this.finish("regenerate")));
    this.renderList();
  }
  onClose() {
    this.contentEl.empty();
  }
  renderList() {
    this.listEl.empty();
    const visible = this.items.filter((item) => !this.query || item.path.toLocaleLowerCase().includes(this.query)).slice(0, 300);
    visible.forEach((item) => {
      const label = this.listEl.createEl("label", { cls: "yq-order-selection-row" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selected.has(item.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(item.path);
        else this.selected.delete(item.path);
        this.updateCount();
      });
      label.createSpan({ text: `${item instanceof import_obsidian.TFolder ? "\u{1F4C1}" : "\u{1F4C4}"} ${item.path}` });
    });
    if (visible.length === 300) this.listEl.createEl("p", { text: "\u5F53\u524D\u6700\u591A\u663E\u793A 300 \u9879\uFF0C\u8BF7\u4F7F\u7528\u641C\u7D22\u7F29\u5C0F\u8303\u56F4\u3002" });
    this.updateCount();
  }
  updateCount() {
    this.countEl.setText(`\u5DF2\u9009\u62E9 ${this.selected.size} \u9879`);
  }
  finish(mode) {
    if (!this.selected.size) {
      new import_obsidian.Notice("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u9879\u76EE");
      return;
    }
    const paths = [...this.selected];
    this.close();
    this.onSubmit(paths, mode);
  }
};
var YqOrderDragPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.storageState = "ready";
    this.hasTrustedMemoryData = false;
    this.storageRaw = null;
    this.storageBaseline = null;
    this.storageConflict = null;
    this.rejectedStorageRaw = null;
    this.storageCheckPromise = null;
    this.storageOperation = Promise.resolve();
    this.lastSaveError = null;
    this.deferredVaultEvents = [];
    this.guidByPath = /* @__PURE__ */ new Map();
    this.guidPromises = /* @__PURE__ */ new Map();
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
    this.saveDirty = false;
    this.explorerView = null;
    this.explorerContainer = null;
    this.explorerObserver = null;
    this.explorerWaitObserver = null;
    this.restoreExplorerPatch = null;
    this.explorerPatchActive = false;
    this.explorerRefreshFrame = null;
    this.domOrderFrame = null;
    this.folderNoteFrame = null;
    this.explorerSetup = false;
    this.manifestNoticeShown = false;
    this.dragSourcePath = "";
    this.dragHintEl = null;
    this.dragHintWidth = 0;
    this.dragHintHeight = 0;
    this.dropTargetEl = null;
    this.dropTargetPosition = null;
    this.pendingDropPlacements = /* @__PURE__ */ new Map();
    this.pendingUndoPositions = /* @__PURE__ */ new Map();
    this.lastDragUndo = null;
    this.dragUndoStack = [];
    this.undoInProgress = false;
    this.identityMaintenanceInProgress = false;
    this.transferInProgress = false;
    this.transferEvents = [];
    this.autoCopyScope = null;
    this.autoCopyPreparing = false;
    this.autoCopyLastEvent = 0;
    this.autoCopyCancelled = false;
    this.autoCopyCreatedDirectories = /* @__PURE__ */ new Set();
    this.dropInProgress = false;
    this.handledRenames = /* @__PURE__ */ new WeakMap();
  }
  async onload() {
    await this.loadInitialOrderData();
    this.registerEvent(this.app.vault.on("create", (file) => void this.handleCreate(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.handleDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (this.ownsAutoCopyPath(file.path)) this.autoCopyLastEvent = Date.now();
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.setupExplorer()));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, item) => this.addIdentityMenuItems(menu, item)));
    this.installPairedFolderNoteClickHandler();
    this.addCommand({
      id: "restore-yuque-order-manifest",
      name: "\u6062\u590D\u539F\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F",
      callback: () => void this.requestManifestImport()
    });
    this.addCommand({
      id: "refresh-yuque-order",
      name: "\u5237\u65B0\u8BED\u96C0\u5F0F\u6587\u4EF6\u987A\u5E8F",
      callback: () => void this.reconcileVault(true)
    });
    this.addCommand({ id: "initialize-local-order-data", name: "\u521D\u59CB\u5316\u672C\u5730\u76EE\u5F55\u987A\u5E8F", callback: () => void this.initializeLocalOrderData() });
    this.addCommand({ id: "reload-synced-order-data", name: "\u68C0\u67E5\u540C\u6B65\u540E\u7684\u6392\u5E8F\u6570\u636E", callback: () => void this.checkExternalOrderData(true) });
    this.addCommand({ id: "recover-order-data-from-memory", name: "\u4ECE\u5F53\u524D\u5185\u5B58\u6062\u590D\u6392\u5E8F\u6570\u636E", callback: () => this.confirmMemoryRecovery() });
    this.addCommand({
      id: "undo-last-yuque-drag",
      name: "\u64A4\u9500\u4E0A\u4E00\u6B21\u8BED\u96C0\u62D6\u62FD",
      checkCallback: (checking) => {
        if (!this.lastDragUndo || this.undoInProgress || this.identityMaintenanceInProgress) return false;
        if (!checking) void this.undoLastDrag();
        return true;
      }
    });
    this.addCommand({ id: "check-duplicate-guids", name: "\u68C0\u6D4B\u5E76\u4FEE\u590D\u91CD\u590D GUID", callback: () => void this.checkDuplicateGuids(true) });
    this.addCommand({ id: "audit-unmanaged-items", name: "\u68C0\u6D4B\u5E76\u7EB3\u5165\u672A\u7BA1\u7406\u9879\u76EE", callback: () => void this.auditAndOfferManagement() });
    this.addCommand({ id: "cross-vault-transfer", name: "\u8DE8Vault\u5408\u5E76\uFF08\u81EA\u52A8\u590D\u5236\uFF09", callback: () => this.openLocalCopy() });
    this.addCommand({ id: "copy-from-local-vault", name: "\u4ECE\u672C\u673A Vault\uFF0F\u76EE\u5F55\u81EA\u52A8\u590D\u5236", callback: () => this.openLocalCopy() });
    this.addCommand({ id: "cancel-local-vault-copy", name: "\u53D6\u6D88\u6B63\u5728\u8FDB\u884C\u7684\u81EA\u52A8\u590D\u5236", checkCallback: (checking) => {
      if (!this.autoCopyPreparing) return false;
      if (!checking) {
        this.autoCopyCancelled = true;
        new import_obsidian.Notice("\u5C06\u5728\u5F53\u524D\u6587\u4EF6\u590D\u5236\u5B8C\u6210\u540E\u505C\u6B62\uFF1B\u5982\u5DF2\u66FF\u6362\uFF0C\u4F1A\u5C1D\u8BD5\u56DE\u6EDA");
      }
      return true;
    } });
    this.addCommand({ id: "manage-selected-items", name: "\u9009\u62E9\u9879\u76EE\u5E76\u751F\u6210\u6216\u91CD\u65B0\u751F\u6210 GUID", callback: () => this.openIdentitySelection() });
    this.addCommand({ id: "replace-all-guids", name: "\u4E3A\u6574\u4E2A\u5E93\u66F4\u6362 GUID", callback: () => void this.replaceAllGuids(this.data.settings.guidBits, true) });
    this.addCommand({
      id: "restore-latest-guid-backup",
      name: "\u6062\u590D\u6700\u8FD1\u4E00\u6B21 GUID \u5907\u4EFD",
      checkCallback: (checking) => {
        const latest = this.data.guidBackups[this.data.guidBackups.length - 1];
        if (!latest || this.identityMaintenanceInProgress) return false;
        if (!checking) void this.restoreGuidBackup(latest);
        return true;
      }
    });
    this.addSettingTab(new YqOrderSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => {
      if (document.visibilityState !== "hidden") void this.checkExternalOrderData();
    }, 5e3));
    this.registerDomEvent(window, "focus", () => void this.checkExternalOrderData());
    this.app.workspace.onLayoutReady(() => void this.boot());
  }
  async boot() {
    if (this.storageState !== "ready") {
      new import_obsidian.Notice(this.storageState === "waiting" ? "\u5C1A\u65E0\u6392\u5E8F\u6570\u636E\uFF1A\u8BF7\u5148\u5B8C\u6210\u540C\u6B65\uFF0C\u6216\u624B\u52A8\u6267\u884C\u201C\u521D\u59CB\u5316\u672C\u5730\u76EE\u5F55\u987A\u5E8F\u201D" : "\u6392\u5E8F\u6570\u636E\u6682\u4E0D\u53EF\u7528\uFF1B\u5DF2\u6682\u505C\u5199\u5165\uFF0C\u8BF7\u68C0\u67E5\u6216\u6062\u590D data.json", 1e4);
      return;
    }
    await this.reconcileVault(false);
    if (this.data.settings.scanDuplicateGuidsOnStartup) await this.checkDuplicateGuids(false);
    this.setupExplorer();
    this.refreshExplorer();
  }
  onunload() {
    var _a, _b, _c;
    this.autoCopyCancelled = true;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.saveDirty && this.storageState === "ready") void this.enqueueDirtySave();
    if (this.explorerRefreshFrame !== null) window.cancelAnimationFrame(this.explorerRefreshFrame);
    if (this.domOrderFrame !== null) window.cancelAnimationFrame(this.domOrderFrame);
    if (this.folderNoteFrame !== null) window.cancelAnimationFrame(this.folderNoteFrame);
    (_a = this.explorerObserver) == null ? void 0 : _a.disconnect();
    (_b = this.explorerWaitObserver) == null ? void 0 : _b.disconnect();
    this.clearDragState();
    (_c = this.restoreExplorerPatch) == null ? void 0 : _c.call(this);
    this.restoreExplorerPatch = null;
    this.explorerPatchActive = false;
  }
  orderDataPath() {
    return (0, import_obsidian.normalizePath)(`${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`);
  }
  async readOrderDataRaw() {
    const adapter = this.app.vault.adapter;
    const path = this.orderDataPath();
    if (!await adapter.exists(path)) return null;
    return adapter.read(path);
  }
  cloneOrderData(data) {
    return JSON.parse(JSON.stringify(data));
  }
  withStorageLock(work) {
    const next = this.storageOperation.then(work, work);
    this.storageOperation = next.then(() => void 0, () => void 0);
    return next;
  }
  parseOrderData(raw) {
    return this.normalizeData(validateStoredOrderData(raw));
  }
  async loadInitialOrderData() {
    var _a, _b;
    if (!((_a = this.app.vault.adapter) == null ? void 0 : _a.exists) || !((_b = this.app.vault.adapter) == null ? void 0 : _b.read)) {
      this.data = this.normalizeData(await this.loadData());
      this.hasTrustedMemoryData = true;
      this.storageBaseline = this.cloneOrderData(this.data);
      return;
    }
    let raw = null;
    try {
      raw = await this.readOrderDataRaw();
      if (raw === null) {
        this.storageState = "waiting";
        this.data = this.normalizeData(null);
      } else {
        this.data = this.parseOrderData(raw);
        this.hasTrustedMemoryData = true;
      }
      this.storageRaw = raw;
      this.storageBaseline = this.cloneOrderData(this.data);
    } catch (error) {
      this.storageState = "blocked";
      this.rejectedStorageRaw = raw;
      this.data = this.normalizeData(null);
      this.storageBaseline = this.cloneOrderData(this.data);
      console.error("[Yuque Sorting] Cannot load data.json; writes are paused.", error);
    }
  }
  getOrderDataStatus() {
    return this.storageState;
  }
  canMutateOrderData() {
    if (this.storageState === "ready") return true;
    new import_obsidian.Notice("\u6392\u5E8F\u6570\u636E\u5C1A\u672A\u5C31\u7EEA\uFF1B\u8BF7\u5148\u5B8C\u6210\u540C\u6B65\u6216\u5904\u7406\u51B2\u7A81", 1e4);
    return false;
  }
  async replayDeferredVaultEvents() {
    const events = this.deferredVaultEvents.splice(0);
    for (const event of events) {
      try {
        if (event.kind === "create") {
          if (this.app.vault.getAbstractFileByPath(event.file.path) === event.file) await this.handleCreate(event.file);
        } else if (event.kind === "delete") {
          if (!this.app.vault.getAbstractFileByPath(event.file.path)) await this.handleDelete(event.file);
        } else if (event.oldPath && this.app.vault.getAbstractFileByPath(event.file.path) === event.file) {
          await this.handleRename(event.file, event.oldPath);
        }
      } catch (error) {
        console.error("[Yuque Sorting] Failed to replay a vault event after sync.", error);
        new import_obsidian.Notice(`\u540C\u6B65\u540E\u5904\u7406\u6587\u4EF6\u53D8\u66F4\u5931\u8D25\uFF1A${String(error)}`, 1e4);
      }
    }
  }
  async initializeLocalOrderData() {
    if (this.storageState === "blocked") {
      new import_obsidian.Notice("\u6392\u5E8F\u6570\u636E\u5904\u4E8E\u51B2\u7A81\u6216\u635F\u574F\u72B6\u6001\uFF1B\u8BF7\u5148\u6062\u590D\u6216\u9009\u62E9\u6570\u636E\u7248\u672C", 1e4);
      return;
    }
    if (this.storageState === "ready") {
      new import_obsidian.Notice("\u6392\u5E8F\u6570\u636E\u5DF2\u7ECF\u521D\u59CB\u5316");
      return;
    }
    const raw = await this.readOrderDataRaw();
    if (raw !== null) {
      await this.acceptExternalOrderData(raw);
      return;
    }
    this.storageState = "ready";
    this.hasTrustedMemoryData = true;
    this.storageRaw = null;
    this.storageBaseline = this.cloneOrderData(this.data);
    this.deferredVaultEvents.length = 0;
    await this.reconcileVault(true);
    if (this.storageRaw === null) await this.forceSave();
    this.setupExplorer();
    this.refreshExplorer();
    new import_obsidian.Notice("\u5DF2\u521D\u59CB\u5316\u672C\u5730\u76EE\u5F55\u987A\u5E8F");
  }
  async checkExternalOrderData(interactive = false) {
    var _a, _b, _c, _d;
    if (!((_c = (_b = (_a = this.app) == null ? void 0 : _a.vault) == null ? void 0 : _b.adapter) == null ? void 0 : _c.exists) || !((_d = this.app.vault.adapter) == null ? void 0 : _d.read)) return;
    if (this.storageCheckPromise) return this.storageCheckPromise;
    this.storageCheckPromise = this.withStorageLock(async () => {
      var _a2;
      let raw;
      try {
        raw = await this.readOrderDataRaw();
      } catch (error) {
        this.storageState = "blocked";
        if (interactive) new import_obsidian.Notice(`\u65E0\u6CD5\u8BFB\u53D6\u6392\u5E8F\u6570\u636E\uFF1A${String(error)}`, 1e4);
        return;
      }
      if (this.storageState === "blocked" && (raw === this.rejectedStorageRaw || raw === ((_a2 = this.storageConflict) == null ? void 0 : _a2.raw))) return;
      if (raw === this.storageRaw) {
        if (this.storageState === "blocked") await this.acceptExternalOrderData(raw);
        else if (interactive) new import_obsidian.Notice(raw === null ? "\u4ECD\u5728\u7B49\u5F85\u540C\u6B65\u7684\u6392\u5E8F\u6570\u636E" : "\u6392\u5E8F\u6570\u636E\u5DF2\u662F\u5F53\u524D\u7248\u672C");
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      let stable;
      try {
        stable = await this.readOrderDataRaw();
      } catch (e) {
        return;
      }
      if (stable !== raw) return;
      await this.acceptExternalOrderData(stable);
    }).finally(() => {
      this.storageCheckPromise = null;
    });
    return this.storageCheckPromise;
  }
  async acceptExternalOrderData(raw) {
    if (raw === null) {
      if (this.storageState === "waiting") return;
      this.storageState = "blocked";
      this.rejectedStorageRaw = null;
      new import_obsidian.Notice("\u6392\u5E8F\u6570\u636E\u88AB\u5916\u90E8\u5220\u9664\uFF1B\u5DF2\u6682\u505C\u5199\u5165\uFF0C\u8BF7\u5148\u6062\u590D data.json", 12e3);
      return;
    }
    let disk;
    try {
      disk = this.parseOrderData(raw);
    } catch (error) {
      this.storageState = "blocked";
      this.rejectedStorageRaw = raw;
      new import_obsidian.Notice(`\u540C\u6B65\u7684\u6392\u5E8F\u6570\u636E\u65E0\u6548\uFF0C\u5DF2\u6682\u505C\u5199\u5165\uFF1A${String(error)}`, 12e3);
      return;
    }
    const base = this.storageBaseline || this.normalizeData(null);
    const localChanged = JSON.stringify(this.data) !== JSON.stringify(base);
    let next = disk;
    if (localChanged) {
      const merged = mergeOrderData(base, this.data, disk);
      if (!merged.data) {
        this.storageState = "blocked";
        this.storageConflict = { raw, disk, local: this.cloneOrderData(this.data), conflicts: merged.conflicts };
        this.showStorageConflict();
        return;
      }
      next = merged.data;
    }
    this.data = next;
    this.storageRaw = raw;
    this.storageBaseline = this.cloneOrderData(disk);
    this.storageState = "ready";
    this.hasTrustedMemoryData = true;
    this.storageConflict = null;
    this.rejectedStorageRaw = null;
    this.guidByPath.clear();
    this.clearUndoHistory();
    await this.replayDeferredVaultEvents();
    await this.reconcileVault(false, false);
    this.setupExplorer();
    this.refreshExplorer();
    if (localChanged && JSON.stringify(next) !== JSON.stringify(disk)) this.queueSave(true);
  }
  showStorageConflict() {
    const conflict = this.storageConflict;
    if (!conflict) return;
    const modal = new import_obsidian.Modal(this.app);
    modal.titleEl.setText("\u6392\u5E8F\u6570\u636E\u540C\u6B65\u51B2\u7A81");
    modal.contentEl.createEl("p", { text: "\u672C\u5730\u5C1A\u672A\u4FDD\u5B58\u7684\u6539\u52A8\u4E0E\u540C\u6B65\u540E\u7684 data.json \u4FEE\u6539\u4E86\u76F8\u540C\u9879\u76EE\u3002\u5DF2\u6682\u505C\u5199\u5165\uFF0C\u5173\u95ED\u7A97\u53E3\u7B49\u540C\u4E8E\u7A0D\u540E\u5904\u7406\u3002" });
    modal.contentEl.createEl("p", { text: conflict.conflicts.slice(0, 8).join("\u3001") + (conflict.conflicts.length > 8 ? "\u2026" : "") });
    new import_obsidian.Setting(modal.contentEl).addButton((button) => button.setButtonText("\u91C7\u7528\u540C\u6B65\u7248\u672C").onClick(() => {
      modal.close();
      void this.resolveStorageConflict("disk");
    })).addButton((button) => button.setButtonText("\u4FDD\u7559\u672C\u5730\u5E76\u8986\u76D6\u78C1\u76D8").onClick(() => {
      modal.close();
      void this.resolveStorageConflict("local");
    })).addButton((button) => button.setButtonText("\u7A0D\u540E\u5904\u7406").onClick(() => modal.close()));
    modal.open();
  }
  async backUpOrderData(raw) {
    const path = (0, import_obsidian.normalizePath)(`${this.app.vault.configDir}/plugins/${this.manifest.id}/data-recovery-${Date.now()}-${createGuid("f", 64).slice(2)}.json`);
    await this.app.vault.adapter.write(path, raw);
    return path;
  }
  openOrderDataResolution() {
    if (this.storageConflict) this.showStorageConflict();
    else this.confirmMemoryRecovery();
  }
  confirmMemoryRecovery() {
    if (this.storageState !== "blocked" || this.storageConflict || !this.hasTrustedMemoryData) {
      new import_obsidian.Notice("\u5F53\u524D\u6CA1\u6709\u53EF\u4ECE\u5185\u5B58\u6062\u590D\u7684\u635F\u574F\u6216\u7F3A\u5931\u6570\u636E");
      return;
    }
    const modal = new import_obsidian.Modal(this.app);
    modal.titleEl.setText("\u4ECE\u5185\u5B58\u6062\u590D\u6392\u5E8F\u6570\u636E");
    modal.contentEl.createEl("p", { text: "\u4EC5\u5728\u540C\u6B65\u6587\u4EF6\u7F3A\u5931\u6216\u635F\u574F\u4E14\u4F60\u786E\u8BA4\u5185\u5B58\u4E2D\u7684\u987A\u5E8F\u6B63\u786E\u65F6\u6267\u884C\uFF1B\u539F\u6587\u4EF6\u82E5\u5B58\u5728\u4F1A\u5148\u5907\u4EFD\u3002" });
    new import_obsidian.Setting(modal.contentEl).addButton((button) => button.setButtonText("\u6062\u590D").onClick(() => {
      modal.close();
      void this.recoverOrderDataFromMemory();
    })).addButton((button) => button.setButtonText("\u53D6\u6D88").onClick(() => modal.close()));
    modal.open();
  }
  async recoverOrderDataFromMemory() {
    try {
      const raw = await this.readOrderDataRaw();
      if (raw !== null) {
        try {
          this.parseOrderData(raw);
          new import_obsidian.Notice("\u78C1\u76D8\u6570\u636E\u5DF2\u7ECF\u6062\u590D\u6709\u6548\uFF0C\u8BF7\u5148\u8FD0\u884C\u201C\u68C0\u67E5\u540C\u6B65\u540E\u7684\u6392\u5E8F\u6570\u636E\u201D", 1e4);
          return;
        } catch (e) {
          await this.backUpOrderData(raw);
        }
      }
      const nextRaw = JSON.stringify(this.data, null, 2);
      if (await this.readOrderDataRaw() !== raw) throw new Error("\u6062\u590D\u524D\u78C1\u76D8\u6570\u636E\u518D\u6B21\u53D8\u5316");
      await this.app.vault.adapter.write(this.orderDataPath(), nextRaw);
      this.storageRaw = nextRaw;
      this.storageBaseline = this.cloneOrderData(this.data);
      this.storageState = "ready";
      this.rejectedStorageRaw = null;
      this.saveDirty = false;
      await this.replayDeferredVaultEvents();
      await this.reconcileVault(false, false);
      this.setupExplorer();
      this.refreshExplorer();
      new import_obsidian.Notice("\u5DF2\u4ECE\u5185\u5B58\u6062\u590D\u6392\u5E8F\u6570\u636E");
    } catch (error) {
      new import_obsidian.Notice(`\u6062\u590D\u5931\u8D25\uFF1A${String(error)}`, 1e4);
    }
  }
  async resolveStorageConflict(choice) {
    const conflict = this.storageConflict;
    if (!conflict || await this.readOrderDataRaw() !== conflict.raw) {
      new import_obsidian.Notice("\u6392\u5E8F\u6570\u636E\u518D\u6B21\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u540E\u9009\u62E9", 1e4);
      await this.checkExternalOrderData();
      return;
    }
    try {
      await this.backUpOrderData(choice === "disk" ? JSON.stringify(conflict.local, null, 2) : conflict.raw);
    } catch (error) {
      new import_obsidian.Notice(`\u5907\u4EFD\u51B2\u7A81\u6570\u636E\u5931\u8D25\uFF0C\u672A\u6267\u884C\u9009\u62E9\uFF1A${String(error)}`, 1e4);
      return;
    }
    this.storageRaw = conflict.raw;
    this.storageBaseline = this.cloneOrderData(conflict.disk);
    this.data = this.cloneOrderData(choice === "disk" ? conflict.disk : conflict.local);
    this.storageState = "ready";
    this.storageConflict = null;
    this.rejectedStorageRaw = null;
    this.guidByPath.clear();
    this.clearUndoHistory();
    if (choice === "local") await this.forceSave();
    await this.replayDeferredVaultEvents();
    await this.reconcileVault(false, false);
    this.setupExplorer();
    this.refreshExplorer();
  }
  normalizeData(saved) {
    const savedSettings = (saved == null ? void 0 : saved.settings) || {};
    const rawSettings = (saved == null ? void 0 : saved.settings) || {};
    const supportedSettings = {};
    if (savedSettings.newItemPlacement === "top" || savedSettings.newItemPlacement === "bottom") {
      supportedSettings.newItemPlacement = savedSettings.newItemPlacement;
    }
    if (savedSettings.fallbackSort === "name" || savedSettings.fallbackSort === "name-last") {
      supportedSettings.fallbackSort = savedSettings.fallbackSort;
    }
    if (typeof savedSettings.persistOrderOnCreateDelete === "boolean") {
      supportedSettings.persistOrderOnCreateDelete = savedSettings.persistOrderOnCreateDelete;
    }
    if (typeof savedSettings.enableDrag === "boolean") {
      supportedSettings.enableDrag = savedSettings.enableDrag;
    }
    supportedSettings.guidBits = normalizeGuidBits(savedSettings.guidBits);
    if (typeof savedSettings.scanDuplicateGuidsOnStartup === "boolean") {
      supportedSettings.scanDuplicateGuidsOnStartup = savedSettings.scanDuplicateGuidsOnStartup;
    }
    if (typeof savedSettings.mergePairedFolderNotes === "boolean") {
      supportedSettings.mergePairedFolderNotes = savedSettings.mergePairedFolderNotes;
    }
    const orderByFolder = (saved == null ? void 0 : saved.orderByFolder) && typeof saved.orderByFolder === "object" ? saved.orderByFolder : {};
    Object.keys(orderByFolder).forEach((key2) => {
      if (!Array.isArray(orderByFolder[key2])) orderByFolder[key2] = [];
    });
    return {
      version: 2,
      settings: { ...DEFAULT_SETTINGS, ...supportedSettings },
      orderByFolder,
      folderGuids: (saved == null ? void 0 : saved.folderGuids) && typeof saved.folderGuids === "object" ? saved.folderGuids : {},
      fileGuids: (saved == null ? void 0 : saved.fileGuids) && typeof saved.fileGuids === "object" ? saved.fileGuids : {},
      detachedFolderNotes: (saved == null ? void 0 : saved.detachedFolderNotes) && typeof saved.detachedFolderNotes === "object" ? saved.detachedFolderNotes : {},
      consumedManifestIds: Array.isArray(saved == null ? void 0 : saved.consumedManifestIds) ? saved.consumedManifestIds.filter((id) => typeof id === "string") : [],
      guidBackups: Array.isArray(saved == null ? void 0 : saved.guidBackups) ? saved.guidBackups : [],
      legacyGuidField: typeof rawSettings.orderFrontmatterKey === "string" && rawSettings.orderFrontmatterKey.trim() && rawSettings.orderFrontmatterKey.trim() !== GUID_FRONTMATTER_KEY ? rawSettings.orderFrontmatterKey.trim() : void 0,
      folderNoteMergeOverrides: (saved == null ? void 0 : saved.folderNoteMergeOverrides) && typeof saved.folderNoteMergeOverrides === "object" ? saved.folderNoteMergeOverrides : {},
      transferReceipts: (saved == null ? void 0 : saved.transferReceipts) || {}
    };
  }
  queueSave(force = false) {
    if (!force && !this.data.settings.persistOrderOnCreateDelete) return;
    this.saveDirty = true;
    if (this.storageState !== "ready") return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.enqueueDirtySave();
    }, 250);
  }
  enqueueDirtySave() {
    this.savePromise = this.savePromise.catch((error) => {
      console.error("[Yuque Sorting] Previous data save failed; retrying.", error);
    }).then(async () => {
      while (this.saveDirty) {
        this.saveDirty = false;
        try {
          await this.persistOrderData();
          this.lastSaveError = null;
        } catch (error) {
          this.saveDirty = true;
          this.lastSaveError = error instanceof Error ? error : new Error(String(error));
          console.error("[Yuque Sorting] Failed to save plugin data.", error);
          new import_obsidian.Notice(`\u6392\u5E8F\u6570\u636E\u672A\u4FDD\u5B58\uFF1A${this.lastSaveError.message}`, 1e4);
          break;
        }
      }
    });
    return this.savePromise;
  }
  async flushSave() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saveDirty) await this.enqueueDirtySave();
    await this.savePromise;
    if (this.lastSaveError) throw this.lastSaveError;
  }
  async forceSave() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveDirty = true;
    await this.flushSave();
  }
  async persistOrderData() {
    return this.withStorageLock(() => this.persistOrderDataLocked());
  }
  async persistOrderDataLocked() {
    const adapter = this.app.vault.adapter;
    if (!(adapter == null ? void 0 : adapter.exists) || !(adapter == null ? void 0 : adapter.read) || !(adapter == null ? void 0 : adapter.write)) {
      await this.saveData(this.data);
      return;
    }
    if (this.storageState !== "ready") throw new Error("\u6392\u5E8F\u6570\u636E\u5C1A\u672A\u5C31\u7EEA\uFF0C\u5DF2\u6682\u505C\u5199\u5165");
    const current = await this.readOrderDataRaw();
    if (current !== this.storageRaw) {
      await this.acceptExternalOrderData(current);
      if (this.storageState !== "ready") throw new Error("\u6392\u5E8F\u6570\u636E\u5DF2\u7531\u5916\u90E8\u66F4\u6539\uFF0C\u8BF7\u5148\u5904\u7406\u51B2\u7A81");
    }
    const base = this.storageBaseline;
    if (this.storageRaw !== null && base && JSON.stringify(this.data) === JSON.stringify(base)) return;
    const nextRaw = JSON.stringify(this.data, null, 2);
    const expected = this.storageRaw;
    const path = this.orderDataPath();
    if (expected !== null && adapter.process) {
      try {
        await adapter.process(path, (value) => {
          if (value !== expected) throw new Error("\u4FDD\u5B58\u65F6\u6392\u5E8F\u6570\u636E\u53C8\u88AB\u5916\u90E8\u66F4\u65B0");
          return nextRaw;
        });
      } catch (error) {
        void this.checkExternalOrderData();
        throw error;
      }
    } else {
      if (await this.readOrderDataRaw() !== expected) {
        void this.checkExternalOrderData();
        throw new Error("\u4FDD\u5B58\u524D\u6392\u5E8F\u6570\u636E\u53D1\u751F\u53D8\u5316");
      }
      await adapter.write(path, nextRaw);
    }
    this.storageRaw = nextRaw;
    this.storageBaseline = this.cloneOrderData(this.data);
  }
  async saveSettings() {
    if (this.autoCopyPreparing && this.transferInProgress) {
      new import_obsidian.Notice("\u81EA\u52A8\u590D\u5236\u671F\u95F4\u6682\u4E0D\u4FDD\u5B58\u8BBE\u7F6E\uFF0C\u8BF7\u5B8C\u6210\u540E\u518D\u4FEE\u6539");
      return;
    }
    await this.forceSave();
  }
  async reconcileVault(forceRefresh, persist = true) {
    if (this.storageState !== "ready") return;
    if (this.transferInProgress) return;
    const all = this.app.vault.getAllLoadedFiles();
    const files = all.filter((file) => file instanceof import_obsidian.TFile);
    const folders = all.filter((file) => file instanceof import_obsidian.TFolder);
    if (all.length <= 1) return;
    for (const file of files) await this.ensureFileGuid(file);
    for (const folder of folders) await this.ensureFolderGuid(folder);
    for (const folder of folders) this.reconcileFolder(folder);
    if (persist) await this.forceSave();
    if (forceRefresh) this.refreshExplorer();
  }
  reconcileFolder(folder) {
    const sortable = folder.children.filter((child) => child instanceof import_obsidian.TFile || child instanceof import_obsidian.TFolder);
    const childGuids = sortable.map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    const uniqueChildGuids = [...new Set(childGuids)];
    const key2 = this.folderKeySync(folder);
    const previous = this.data.orderByFolder[key2] || [];
    const byName = sortable.slice().sort((a, b) => a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" })).map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    this.data.orderByFolder[key2] = reconcileOrderNonDestructive(
      previous,
      uniqueChildGuids,
      byName,
      this.data.settings.newItemPlacement
    );
  }
  async ensureFileGuid(file) {
    const cached = this.guidByPath.get(file.path);
    if (cached) return cached;
    if (!isMarkdown(file)) {
      const guid = this.data.fileGuids[file.path] || createGuid("f", this.data.settings.guidBits);
      this.data.fileGuids[file.path] = guid;
      this.guidByPath.set(file.path, guid);
      return guid;
    }
    const pending = this.guidPromises.get(file.path);
    if (pending) return pending;
    const promise = (async () => {
      let guid = this.readCachedFrontmatterGuid(file);
      if (!guid) guid = this.guidByPath.get(file.path) || null;
      if (!guid) {
        try {
          guid = this.readGuidFromText(await this.app.vault.read(file));
        } catch (e) {
          guid = null;
        }
      }
      if (!guid) {
        guid = createGuid("f", this.data.settings.guidBits);
        await this.writeFileGuid(file, guid);
      }
      this.guidByPath.set(file.path, guid);
      return guid;
    })();
    this.guidPromises.set(file.path, promise);
    try {
      return await promise;
    } finally {
      this.guidPromises.delete(file.path);
    }
  }
  readCachedFrontmatterGuid(file) {
    var _a;
    const frontmatter = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter;
    return normalizeGuid(frontmatter == null ? void 0 : frontmatter[GUID_FRONTMATTER_KEY]) || normalizeGuid(this.data.legacyGuidField ? frontmatter == null ? void 0 : frontmatter[this.data.legacyGuidField] : null);
  }
  readGuidFromText(text) {
    var _a;
    const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const keys = [GUID_FRONTMATTER_KEY, this.data.legacyGuidField].filter((key2) => Boolean(key2));
    for (const key2 of keys) {
      const escaped = key2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const field = match[1].match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, "m"));
      const guid = normalizeGuid((_a = field == null ? void 0 : field[1]) == null ? void 0 : _a.replace(/^['\"]|['\"]$/g, ""));
      if (guid) return guid;
    }
    return null;
  }
  async writeFileGuid(file, guid) {
    const key2 = GUID_FRONTMATTER_KEY;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (!normalizeGuid(frontmatter[key2])) frontmatter[key2] = guid;
      });
      return;
    } catch (e) {
      await this.app.vault.process(file, (text) => {
        if (this.readGuidFromText(text)) return text;
        return `---
${key2}: ${guid}
---

${text}`;
      });
    }
  }
  async setFileGuid(file, guid) {
    const key2 = GUID_FRONTMATTER_KEY;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter[key2] = guid;
      });
    } catch (e) {
      await this.app.vault.process(file, (text) => {
        const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) return `---
${key2}: ${guid}
---

${text}`;
        const escaped = key2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const body = match[1];
        const nextBody = new RegExp(`^\\s*${escaped}\\s*:.*$`, "m").test(body) ? body.replace(new RegExp(`^\\s*${escaped}\\s*:.*$`, "m"), `${key2}: ${guid}`) : `${key2}: ${guid}
${body}`;
        return text.replace(match[0], `---
${nextBody}
---
`);
      });
    }
    this.guidByPath.set(file.path, guid);
  }
  async clearFileGuid(file, expectedGuid) {
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (normalizeGuid(frontmatter[GUID_FRONTMATTER_KEY]) === expectedGuid) {
          delete frontmatter[GUID_FRONTMATTER_KEY];
        }
      });
    } catch (e) {
      await this.app.vault.process(file, (text) => {
        const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) return text;
        const escaped = GUID_FRONTMATTER_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const line = new RegExp(`^\\s*${escaped}\\s*:\\s*['"]?${expectedGuid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*\\r?\\n?`, "m");
        const body = match[1].replace(line, "").replace(/\s+$/, "");
        return text.replace(match[0], body ? `---
${body}
---
` : "");
      });
    }
    this.guidByPath.delete(file.path);
  }
  async ensureFolderGuid(folder) {
    if (!folder.path || folder.path === "/") return null;
    if (!this.data.folderGuids[folder.path]) {
      this.data.folderGuids[folder.path] = createGuid("d", this.data.settings.guidBits);
    }
    return this.data.folderGuids[folder.path];
  }
  folderKeySync(folder) {
    if (!folder) return ROOT_FOLDER_KEY;
    if (!folder.path) return ROOT_FOLDER_KEY;
    if (folder.path === "/") return this.data.folderGuids["/"] || ROOT_FOLDER_KEY;
    return this.data.folderGuids[folder.path] || ROOT_FOLDER_KEY;
  }
  getItemGuidSync(item) {
    if (item instanceof import_obsidian.TFile) {
      return this.guidByPath.get(item.path) || (isMarkdown(item) ? this.readCachedFrontmatterGuid(item) : this.data.fileGuids[item.path]) || null;
    }
    if (item instanceof import_obsidian.TFolder) return this.data.folderGuids[item.path] || null;
    return null;
  }
  sortFolderItems(folderPath, items) {
    const folder = !folderPath || folderPath === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folderPath);
    const key2 = folder instanceof import_obsidian.TFolder ? this.folderKeySync(folder) : ROOT_FOLDER_KEY;
    const saved = this.data.orderByFolder[key2] || [];
    const sortable = items.filter((item) => item instanceof import_obsidian.TFolder || item instanceof import_obsidian.TFile);
    return sortEntries(
      sortable,
      saved,
      (item) => this.getItemGuidSync(item),
      this.data.settings.fallbackSort
    );
  }
  async handleCreate(file) {
    if (this.storageState !== "ready") {
      if (this.app.workspace.layoutReady) this.deferredVaultEvents.push({ kind: "create", file });
      return;
    }
    if (this.ownsAutoCopyPath(file.path)) {
      this.autoCopyLastEvent = Date.now();
      return;
    }
    if (this.transferInProgress) {
      this.transferEvents.push(() => this.handleCreate(file));
      return;
    }
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof import_obsidian.TFile) {
      const guid = await this.ensureFileGuid(file);
      if (file.parent) await this.ensureFolderGuid(file.parent);
      this.addGuidToFolder(file.parent, guid);
    } else if (file instanceof import_obsidian.TFolder) {
      const guid = await this.ensureFolderGuid(file);
      if (guid) this.addGuidToFolder(file.parent, guid);
    }
    this.queueSave();
    this.refreshExplorer();
  }
  async handleDelete(file) {
    if (this.storageState !== "ready") {
      if (this.app.workspace.layoutReady) this.deferredVaultEvents.push({ kind: "delete", file });
      return;
    }
    if (this.ownsAutoCopyPath(file.path)) {
      this.autoCopyLastEvent = Date.now();
      return;
    }
    if (this.transferInProgress) {
      this.transferEvents.push(() => this.handleDelete(file));
      return;
    }
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof import_obsidian.TFile) {
      const guid = this.guidByPath.get(file.path) || (isMarkdown(file) ? this.readCachedFrontmatterGuid(file) : this.data.fileGuids[file.path]);
      if (guid) removeGuidFromOrders(this.data.orderByFolder, guid);
      this.guidByPath.delete(file.path);
      if (!isMarkdown(file)) delete this.data.fileGuids[file.path];
    } else if (file instanceof import_obsidian.TFolder) {
      const prefix = `${file.path}/`;
      const deletedFolderGuids = /* @__PURE__ */ new Set();
      Object.keys(this.data.folderGuids).forEach((path) => {
        if (path === file.path || path.startsWith(prefix)) {
          const guid = this.data.folderGuids[path];
          if (guid) deletedFolderGuids.add(guid);
          delete this.data.folderGuids[path];
        }
      });
      const collectDescendantGuids = (item) => {
        if (item instanceof import_obsidian.TFile) {
          const guid = this.getItemGuidSync(item);
          if (guid) deletedFolderGuids.add(guid);
          this.guidByPath.delete(item.path);
          if (!isMarkdown(item)) delete this.data.fileGuids[item.path];
        } else if (item instanceof import_obsidian.TFolder) {
          item.children.forEach(collectDescendantGuids);
        }
      };
      file.children.forEach(collectDescendantGuids);
      purgeFolderGuidsFromOrders(this.data.orderByFolder, deletedFolderGuids);
    }
    this.queueSave();
    this.refreshExplorer();
  }
  async handleRename(file, oldPath) {
    var _a;
    if (this.storageState !== "ready") {
      if (this.app.workspace.layoutReady) this.deferredVaultEvents.push({ kind: "rename", file, oldPath });
      return;
    }
    if (this.ownsAutoCopyPath(file.path) || this.ownsAutoCopyPath(oldPath)) {
      this.autoCopyLastEvent = Date.now();
      return;
    }
    if (this.transferInProgress) {
      this.transferEvents.push(() => this.handleRename(file, oldPath));
      return;
    }
    if (!this.app.workspace.layoutReady) return;
    const renameKey = `${oldPath}
${file.path}`;
    const existing = this.handledRenames.get(file);
    if ((existing == null ? void 0 : existing.key) === renameKey) return existing.done;
    const done = this.processRename(file, oldPath);
    this.handledRenames.set(file, { key: renameKey, done });
    try {
      await done;
    } catch (error) {
      if (((_a = this.handledRenames.get(file)) == null ? void 0 : _a.done) === done) this.handledRenames.delete(file);
      throw error;
    }
  }
  async renameTracked(file, destination) {
    const oldPath = file.path;
    await this.app.fileManager.renameFile(file, destination);
    await this.handleRename(file, oldPath);
  }
  async processRename(file, oldPath) {
    var _a, _b;
    if (file instanceof import_obsidian.TFolder) {
      const movedGuid = this.data.folderGuids[oldPath];
      const oldParent = parentPath(oldPath);
      migratePathMappings(this.data.folderGuids, oldPath, file.path);
      for (const [path, guid] of Array.from(this.guidByPath)) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          this.guidByPath.delete(path);
          this.guidByPath.set(`${file.path}${path.slice(oldPath.length)}`, guid);
        }
      }
      const fileUpdates = migratePathMappings(this.data.fileGuids, oldPath, file.path);
      fileUpdates.forEach(([from, to, guid]) => {
        this.guidByPath.delete(from);
        this.guidByPath.set(to, guid);
      });
      const newParent = ((_a = file.parent) == null ? void 0 : _a.path) || "";
      if (movedGuid && oldParent !== newParent) {
        if (file.parent) await this.ensureFolderGuid(file.parent);
        const undoPosition = this.pendingUndoPositions.get(movedGuid);
        const pending = this.pendingDropPlacements.get(movedGuid);
        if (undoPosition && undoPosition.folderKey === this.folderKeySync(file.parent)) {
          this.pendingUndoPositions.delete(movedGuid);
          this.restoreStoredGuidPosition(undoPosition);
        } else if ((pending == null ? void 0 : pending.parentPath) === newParent) {
          this.pendingDropPlacements.delete(movedGuid);
          this.placeGuidRelative(file.parent, movedGuid, pending.targetGuid, pending.before);
        } else {
          relocateGuid(
            this.data.orderByFolder,
            this.folderKeySync(file.parent),
            movedGuid,
            this.data.settings.newItemPlacement
          );
        }
      }
    } else if (file instanceof import_obsidian.TFile) {
      const guid = this.guidByPath.get(oldPath) || (isMarkdown(file) ? this.readCachedFrontmatterGuid(file) : this.data.fileGuids[oldPath]);
      this.guidByPath.delete(oldPath);
      if (guid) {
        this.guidByPath.set(file.path, guid);
        if (!isMarkdown(file)) {
          delete this.data.fileGuids[oldPath];
          this.data.fileGuids[file.path] = guid;
        }
        const oldParent = parentPath(oldPath);
        const newParent = ((_b = file.parent) == null ? void 0 : _b.path) || "";
        if (oldParent !== newParent) {
          if (file.parent) await this.ensureFolderGuid(file.parent);
          const undoPosition = this.pendingUndoPositions.get(guid);
          const pending = this.pendingDropPlacements.get(guid);
          if (undoPosition && undoPosition.folderKey === this.folderKeySync(file.parent)) {
            this.pendingUndoPositions.delete(guid);
            this.restoreStoredGuidPosition(undoPosition);
          } else if ((pending == null ? void 0 : pending.parentPath) === newParent) {
            this.pendingDropPlacements.delete(guid);
            this.placeGuidRelative(file.parent, guid, pending.targetGuid, pending.before);
          } else {
            removeGuidFromOrders(this.data.orderByFolder, guid);
            this.addGuidToFolder(file.parent, guid);
          }
        }
      }
    }
    this.queueSave();
    this.refreshExplorer();
  }
  addGuidToFolder(folder, guid) {
    const key2 = this.folderKeySync(folder);
    const order = this.data.orderByFolder[key2] || [];
    this.data.orderByFolder[key2] = insertGuid(order, guid, this.data.settings.newItemPlacement);
  }
  placeGuidRelative(folder, guid, targetGuid, before) {
    const key2 = this.folderKeySync(folder);
    relocateGuid(this.data.orderByFolder, key2, guid, this.data.settings.newItemPlacement);
    this.data.orderByFolder[key2] = moveGuid(this.data.orderByFolder[key2], guid, targetGuid, before);
  }
  captureItemPosition(item, guid) {
    var _a, _b;
    const folderKey = this.folderKeySync(item.parent);
    const fallbackOrder = ((_a = item.parent) == null ? void 0 : _a.children.filter((child) => child instanceof import_obsidian.TFolder || child instanceof import_obsidian.TFile).map((child) => this.getItemGuidSync(child)).filter((childGuid) => Boolean(childGuid))) || [];
    const order = ((_b = this.data.orderByFolder[folderKey]) == null ? void 0 : _b.length) ? this.data.orderByFolder[folderKey] : fallbackOrder;
    return { folderKey, guid, ...captureGuidOrderPosition(order, guid) };
  }
  restoreStoredGuidPosition(position) {
    removeGuidFromOrders(this.data.orderByFolder, position.guid);
    this.data.orderByFolder[position.folderKey] = restoreGuidOrderPosition(
      this.data.orderByFolder[position.folderKey] || [],
      position.guid,
      position
    );
  }
  collectIdentityState() {
    const entries = [];
    const folderChildrenByPath = {};
    const visit = (folder) => {
      const children = this.sortFolderItems(folder.path, folder.children.filter((item) => item instanceof import_obsidian.TFile || item instanceof import_obsidian.TFolder));
      folderChildrenByPath[folder.path] = children.map((item) => item.path);
      for (const item of children) {
        const guid = this.getItemGuidSync(item);
        if (guid) entries.push({ path: item.path, kind: item instanceof import_obsidian.TFolder ? "folder" : "file", guid });
        if (item instanceof import_obsidian.TFolder) visit(item);
      }
    };
    visit(this.app.vault.getRoot());
    return { entries, folderChildrenByPath };
  }
  rebuildOrders(folderChildrenByPath) {
    const guidByPath = /* @__PURE__ */ new Map();
    const folderGuidByPath = /* @__PURE__ */ new Map();
    for (const item of this.app.vault.getAllLoadedFiles()) {
      const guid = this.getItemGuidSync(item);
      if (guid) guidByPath.set(item.path, guid);
      if (item instanceof import_obsidian.TFolder && item.path && guid) folderGuidByPath.set(item.path, guid);
    }
    this.data.orderByFolder = remapOrderSnapshot(folderChildrenByPath, guidByPath, folderGuidByPath);
  }
  clearUndoHistory() {
    this.dragUndoStack = [];
    this.lastDragUndo = null;
  }
  async readItemGuid(item) {
    let guid = this.getItemGuidSync(item);
    if (!guid && item instanceof import_obsidian.TFile && isMarkdown(item)) {
      try {
        guid = this.readGuidFromText(await this.app.vault.read(item));
      } catch (e) {
        guid = null;
      }
    }
    return guid;
  }
  manageableItems() {
    return this.app.vault.getAllLoadedFiles().filter((item) => (item instanceof import_obsidian.TFile || item instanceof import_obsidian.TFolder) && Boolean(item.path) && item.path !== "/");
  }
  async collectUnmanagedItems() {
    const items = this.manageableItems();
    const managed = new Array(items.length).fill(false);
    await mapLimit(items.map((item, index) => ({ item, index })), 4, async ({ item, index }) => {
      managed[index] = Boolean(await this.readItemGuid(item));
    });
    return items.filter((_item, index) => !managed[index]);
  }
  collectUnindexedItems() {
    const membership = /* @__PURE__ */ new Map();
    return this.manageableItems().filter((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return false;
      const key2 = this.folderKeySync(item.parent);
      let indexed = membership.get(key2);
      if (!indexed) {
        indexed = new Set(this.data.orderByFolder[key2] || []);
        membership.set(key2, indexed);
      }
      return !indexed.has(guid);
    });
  }
  async auditAndOfferManagement() {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const unmanaged = await this.collectUnmanagedItems();
    if (!unmanaged.length) {
      new import_obsidian.Notice("\u5F53\u524D Vault \u4E2D\u6CA1\u6709\u672A\u7BA1\u7406\u9879\u76EE\uFF1B\u590D\u5236\u6216\u65B0\u5EFA\u7684\u9879\u76EE\u5DF2\u7531\u63D2\u4EF6\u5B9E\u65F6\u81EA\u52A8\u7EB3\u5165");
      return;
    }
    const fileCount = unmanaged.filter((item) => item instanceof import_obsidian.TFile).length;
    const proceed = await new Promise((resolve) => new ConfirmActionModal(
      this.app,
      "\u68C0\u6D4B\u5230\u672A\u7BA1\u7406\u9879\u76EE",
      `\u53D1\u73B0 ${fileCount} \u4E2A\u6587\u4EF6\u548C ${unmanaged.length - fileCount} \u4E2A\u6587\u4EF6\u5939\u3002\u5C06\u53EA\u4E3A\u7F3A\u5C11 GUID \u7684\u9879\u76EE\u751F\u6210 GUID\uFF0C\u5E76\u6309\u65B0\u589E\u9879\u89C4\u5219\u7EB3\u5165\u7BA1\u7406\uFF1B\u5DF2\u6709\u5144\u5F1F\u9879\u76F8\u5BF9\u987A\u5E8F\u4E0D\u53D8\u3002`,
      "\u751F\u6210 GUID \u5E76\u7EB3\u5165\u7BA1\u7406",
      resolve
    ).open());
    if (proceed) await this.applyIdentitySelection(unmanaged.map((item) => item.path), "missing");
  }
  async takeOverHistoricalVault() {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const unmanaged = await this.collectUnmanagedItems();
    const unindexed = this.collectUnindexedItems();
    if (!unmanaged.length && !unindexed.length) {
      new import_obsidian.Notice("\u5F53\u524D Vault \u7684 GUID \u548C\u76EE\u5F55\u7D22\u5F15\u5747\u5B8C\u6574\uFF1B\u590D\u5236\u6216\u65B0\u5EFA\u7684\u9879\u76EE\u5DF2\u88AB\u5B9E\u65F6\u81EA\u52A8\u63A5\u7BA1");
      return;
    }
    const currentOrder = this.collectIdentityState().folderChildrenByPath;
    const proceed = await new Promise((resolve) => new ConfirmActionModal(
      this.app,
      "\u63A5\u7BA1\u5386\u53F2 Obsidian Vault",
      `\u53D1\u73B0 ${unmanaged.length} \u4E2A\u9879\u76EE\u7F3A\u5C11 GUID\u3001${unindexed.length} \u4E2A\u9879\u76EE\u7F3A\u5C11\u76EE\u5F55\u7D22\u5F15\u3002${unindexed.length ? `\u7F3A\u5C11\u7D22\u5F15\uFF1A${unindexed.slice(0, 10).map((item) => item.path).join("\uFF1B")}${unindexed.length > 10 ? `\uFF1B\u53E6\u6709 ${unindexed.length - 10} \u9879` : ""}\u3002` : ""}\u5C06\u8865\u5168\u7F3A\u5931\u7684 GUID\uFF0C\u5E76\u4EE5\u5F53\u524D\u663E\u793A\u7ED3\u6784\u4E00\u6B21\u6027\u91CD\u5EFA\u76EE\u5F55\u7D22\u5F15\uFF1B\u4E0D\u4F1A\u79FB\u52A8\u3001\u91CD\u547D\u540D\u6216\u5220\u9664\u6587\u4EF6\u3002`,
      "\u5F00\u59CB\u63A5\u7BA1",
      resolve
    ).open());
    if (proceed) await this.applyIdentitySelection(
      unmanaged.map((item) => item.path),
      "missing",
      currentOrder,
      "\u5386\u53F2 Vault \u63A5\u7BA1\u5B8C\u6210"
    );
  }
  ownsAutoCopyPath(path) {
    if (this.autoCopyCreatedDirectories.has(path)) return true;
    const scope = this.autoCopyScope;
    if (!scope) return false;
    const prefix = scope.destination ? `${scope.destination}/` : "";
    if (!path.startsWith(prefix)) return false;
    return scope.roots.has(path.slice(prefix.length).split("/")[0]);
  }
  openLocalCopy() {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress || this.autoCopyPreparing) {
      new import_obsidian.Notice("\u5DF2\u6709\u7EF4\u62A4\u6216\u590D\u5236\u4EFB\u52A1\u6B63\u5728\u8FDB\u884C");
      return;
    }
    const modal = new import_obsidian.Modal(this.app);
    modal.setTitle("\u8DE8Vault\u5408\u5E76\uFF08\u81EA\u52A8\u590D\u5236\uFF09");
    modal.contentEl.addClass("yq-copy-modal");
    modal.contentEl.createEl("p", { text: "\u652F\u6301\u590D\u5236\u6E90\u5E93\u6216\u6E90\u5E93\u6307\u5B9A\u76EE\u5F55\u4E0B\u7684\u6587\u4EF6\u548C\u6587\u4EF6\u5939\uFF0C\u4E0D\u590D\u5236\u6240\u9009\u6E90\u76EE\u5F55\u672C\u8EAB\u3002\u8BFB\u53D6\u6E90\u5E93 .obsidian \u4E2D\u7684\u672C\u63D2\u4EF6\u6392\u5E8F\uFF1B\u6CA1\u6709\u7D22\u5F15\u65F6\u6309\u540D\u79F0\u6392\u5E8F\u5E76\u5728\u786E\u8BA4\u9875\u63D0\u793A\u3002\u9690\u85CF\u9879\u76EE\u4E0D\u590D\u5236\uFF0C\u6E90\u5E93\u5185\u5BB9\u548C\u987A\u5E8F\u4E0D\u4FEE\u6539\u3002" });
    let source = "", destination = "";
    const pathRow = (name, target) => {
      let input;
      new import_obsidian.Setting(modal.contentEl).setName(name).setDesc(target ? "\u4EC5\u9650\u5F53\u524D\u5E93\u5185\u3002\u7559\u7A7A\u4E3A Vault \u6839\u76EE\u5F55\uFF1B\u4E5F\u53EF\u586B\u5199\u5E93\u5185\u76F8\u5BF9\u8DEF\u5F84\u3002\u4E0D\u5B58\u5728\u7684\u76EE\u5F55\u5728\u6700\u7EC8\u786E\u8BA4\u540E\u81EA\u52A8\u521B\u5EFA\u3002" : "\u9009\u62E9\u76EE\u5F55\uFF0C\u6216\u624B\u52A8\u586B\u5199\u6E90\u5E93/\u6E90\u76EE\u5F55\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002").addText((text) => {
        input = text;
        text.setPlaceholder(target ? "\u7559\u7A7A\u4E3A Vault \u6839\u76EE\u5F55" : "\u9009\u62E9\u76EE\u5F55\u6216\u586B\u5199\u7EDD\u5BF9\u8DEF\u5F84").onChange((value) => {
          if (target) destination = value.trim();
          else source = value.trim();
        });
      }).addButton((button) => button.setButtonText("\u9009\u62E9\u76EE\u5F55\u2026").onClick(async () => {
        var _a, _b;
        button.setDisabled(true);
        try {
          const load = window.require;
          if (typeof load !== "function") throw new Error("\u76EE\u5F55\u9009\u62E9\u4EC5\u652F\u6301\u684C\u9762\u7AEF");
          const base = ((_b = (_a = this.app.vault.adapter).getBasePath) == null ? void 0 : _b.call(_a)) || "";
          const selected = await chooseDirectory(load, name, target ? base : source);
          if (!selected) return;
          if (target) {
            await resolveCopyDestination({ fs: load("fs"), path: load("path") }, base, selected);
            destination = selected;
          } else source = selected;
          input.setValue(selected);
        } catch (error) {
          new import_obsidian.Notice(String(error));
        } finally {
          button.setDisabled(false);
        }
      }));
    };
    pathRow("\u6E90\u5E93\u6216\u6E90\u5E93\u6307\u5B9A\u76EE\u5F55", false);
    pathRow("\u5F53\u524D\u5E93\u6216\u8005\u5F53\u524D\u5E93\u7684\u76EE\u5F55", true);
    new import_obsidian.Setting(modal.contentEl).addButton((button) => button.setButtonText("\u9884\u68C0\u5E76\u5904\u7406\u51B2\u7A81").setCta().onClick(() => {
      modal.close();
      void this.copyLocalDirectory(source, destination).catch((error) => new import_obsidian.Notice(`\u81EA\u52A8\u590D\u5236\u672A\u5B8C\u6210\uFF1A${String(error)}`, 12e3));
    }));
    modal.open();
  }
  async copyLocalDirectory(sourceInput, destination) {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress || this.autoCopyPreparing || !this.app.workspace.layoutReady) return;
    const load = window.require;
    const adapter = this.app.vault.adapter;
    if (typeof load !== "function" || typeof adapter.getBasePath !== "function") throw new Error("\u8DE8Vault\u5408\u5E76\u4EC5\u652F\u6301\u672C\u673A\u684C\u9762 Vault");
    const io = { fs: load("fs"), path: load("path") };
    this.autoCopyPreparing = true;
    this.autoCopyCancelled = false;
    const checkCancelled = () => {
      if (this.autoCopyCancelled) throw new Error("\u81EA\u52A8\u590D\u5236\u5DF2\u53D6\u6D88");
    };
    try {
      const source = await checkedDirectory(io, sourceInput);
      const vaultRoot = await checkedDirectory(io, adapter.getBasePath());
      if (contained(io, vaultRoot, source) || contained(io, source, vaultRoot)) throw new Error("\u6765\u6E90\u548C\u5F53\u524D Vault \u4E0D\u80FD\u76F8\u540C\u3001\u4E92\u76F8\u5305\u542B\u6216\u6765\u81EA\u5F53\u524D Vault \u5185\u90E8");
      const targetPlan = await resolveCopyDestination(io, vaultRoot, destination);
      destination = targetPlan.relative;
      const target = targetPlan.absolute;
      const targetFolder = targetPlan.missing.length ? null : this.transferFolder(destination);
      const sourceEntries = await scanDisk(io, source);
      const sourceInfo = await sourceTransfer(
        io,
        source,
        sourceEntries,
        this.manifest.id,
        (kind, used) => createGuid(kind, this.data.settings.guidBits, used),
        import_obsidian.parseYaml
      );
      const pack = sourceInfo.pack;
      checkCancelled();
      if (!pack.items.length) {
        new import_obsidian.Notice("\u6765\u6E90\u6CA1\u6709\u53EF\u590D\u5236\u7684\u975E\u9690\u85CF\u9879\u76EE");
        return;
      }
      const targetNames = targetPlan.missing.length ? [] : await io.fs.promises.readdir(target);
      const targetNameSet = new Set(targetNames);
      const indexedNames = new Set((targetFolder == null ? void 0 : targetFolder.children.map((item) => item.name)) || []);
      if (targetNames.some((name) => !name.startsWith(".") && !indexedNames.has(name))) throw new Error("\u76EE\u6807\u76EE\u5F55\u8FD8\u6709\u672A\u88AB Obsidian \u7D22\u5F15\u7684\u9879\u76EE\uFF0C\u8BF7\u7B49\u5F85\u7D22\u5F15\u5B8C\u6210\u540E\u91CD\u8BD5");
      const nameKey = (name) => name.normalize("NFC").toLowerCase();
      const existingKeys = new Set(targetNames.map(nameKey));
      const conflicts = pack.orders[""].filter((name) => existingKeys.has(nameKey(name)));
      const choices = conflicts.length ? await new Promise((resolve) => new CopyConflictModal(this.app, conflicts, resolve).open()) : /* @__PURE__ */ new Map();
      if (!choices) return;
      const roots = planCopyRoots(pack.orders[""], targetNames, choices);
      const mappedPaths = copyPathMap(pack, roots);
      const prefix = destination ? `${destination}/` : "";
      const replacedRoots = new Set(roots.filter((root) => root.replaces).map((root) => root.target));
      const inReplacement = (path) => path.startsWith(prefix) && replacedRoots.has(path.slice(prefix.length).split("/")[0]);
      const snapshots = /* @__PURE__ */ new Map();
      let removedCount = 0;
      for (const root of roots.filter((root2) => root2.replaces)) {
        const snapshot = await scanDisk(io, io.path.join(target, root.target), true);
        snapshots.set(root.target, snapshot);
        removedCount += snapshot.length;
      }
      const all = this.manageableItems();
      const oldGuids = /* @__PURE__ */ new Map();
      const occupied = /* @__PURE__ */ new Set();
      for (const item of all) {
        let guid = this.getItemGuidSync(item);
        if (item instanceof import_obsidian.TFile && isMarkdown(item)) {
          const header = await markdownHeader(io, io.path.join(vaultRoot, item.path));
          const yaml = header.yaml === null ? {} : yamlObject((0, import_obsidian.parseYaml)(header.yaml));
          guid = normalizeGuid(yaml.guid) || normalizeGuid(this.data.legacyGuidField ? yaml[this.data.legacyGuidField] : null);
        }
        if (!guid) throw new Error(`\u5F53\u524D\u5E93\u9879\u76EE\u5C1A\u65E0 GUID\uFF0C\u8BF7\u5148\u68C0\u6D4B\u5E76\u7EB3\u5165\u7BA1\u7406\uFF1A${item.path}`);
        oldGuids.set(item.path, guid);
        occupied.add(guid);
      }
      for (const mappings of [this.data.folderGuids, this.data.fileGuids]) for (const guid of Object.values(mappings)) occupied.add(guid);
      const replacements = planTransferGuids(pack.items, occupied, (kind, used) => createGuid(kind, this.data.settings.guidBits, used));
      const remapped = pack.items.filter((item) => replacements.get(item.path) !== item.guid).length;
      const targetOrder = targetFolder ? this.sortFolderItems(targetFolder.path, targetFolder.children).map((item) => item.path) : [];
      const originalData = this.data;
      const dataSnapshot = JSON.stringify(originalData);
      const missingGuids = /* @__PURE__ */ new Map();
      const reservedGuids = /* @__PURE__ */ new Set([...occupied, ...replacements.values()]);
      for (const path of targetPlan.missing) missingGuids.set(path, createGuid("d", this.data.settings.guidBits, reservedGuids));
      const confirm = await new Promise((resolve) => new ConfirmActionModal(
        this.app,
        targetPlan.missing.length ? `\u786E\u8BA4\u81EA\u52A8\u590D\u5236\uFF1A\u5C06\u521B\u5EFA ${targetPlan.missing.join("\u3001")}` : "\u786E\u8BA4\u81EA\u52A8\u590D\u5236",
        `\u6765\u6E90\uFF1A${source}\uFF1B\u76EE\u6807\uFF1A${destination || "Vault \u6839\u76EE\u5F55"}\u3002\u590D\u5236 ${pack.items.length} \u9879\uFF0C${remapped} \u4E2A\u51B2\u7A81\u6216\u91CD\u590D GUID \u6362\u53F7\uFF0C${sourceInfo.generated} \u9879\u8865 GUID\uFF0C${sourceInfo.fallback} \u9879\u65E0\u6765\u6E90\u7D22\u5F15\u3001\u6309\u540D\u79F0\u515C\u5E95\u3002${replacedRoots.size} \u4E2A\u540C\u540D\u9879\u5C06\u6574\u9879\u66FF\u6362\uFF0C\u76EE\u6807\u539F ${removedCount} \u9879\uFF08\u542B\u76EE\u6807\u72EC\u6709\u5B50\u9879\uFF09\u79FB\u5165\u5907\u4EFD\uFF0C\u4E0D\u9012\u5F52\u6DF7\u5408\u3002\u8BA1\u5212\uFF1A${roots.slice(0, 30).map((root) => `${root.source} \u2192 ${root.target}${root.replaces ? " [\u6574\u9879\u66FF\u6362]" : ""}`).join("\uFF1B")}${roots.length > 30 ? "\uFF1B\u5176\u4F59\u7701\u7565" : ""}\u3002\u66FF\u6362\u9879\u6CBF\u7528\u539F\u4F4D\u7F6E\uFF0C\u65B0\u9879\u6309\u65B0\u589E\u4F4D\u7F6E\u8BBE\u7F6E\u63D2\u5165\uFF0C\u5176\u4ED6\u5144\u5F1F\u9879\u987A\u5E8F\u4E0D\u53D8\u3002\u91CD\u547D\u540D\u53EF\u80FD\u5F71\u54CD\u76F8\u5BF9\u94FE\u63A5\uFF0C\u4E0D\u81EA\u52A8\u6539\u5199\u6B63\u6587\u94FE\u63A5\u3002\u8BF7\u5148\u5173\u95ED\u88AB\u66FF\u6362\u7684\u7B14\u8BB0\uFF0C\u5E76\u6682\u505C\u540C\u6B65\u6216\u5176\u4ED6\u7F16\u8F91\u3002`,
        "\u786E\u8BA4\u590D\u5236\uFF08\u66FF\u6362\u9879\u5DF2\u5907\u4EFD\u540E\u624D\u6267\u884C\uFF09",
        resolve
      ).open());
      if (!confirm) return;
      checkCancelled();
      if (this.identityMaintenanceInProgress || this.data !== originalData || JSON.stringify(this.data) !== dataSnapshot) throw new Error("\u9884\u68C0\u540E GUID \u6216\u6392\u5E8F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u68C0");
      this.app.workspace.iterateAllLeaves((leaf) => {
        var _a, _b;
        const path = (_b = (_a = leaf.view) == null ? void 0 : _a.file) == null ? void 0 : _b.path;
        if (path && inReplacement(path)) throw new Error(`\u8BF7\u5148\u5173\u95ED\u88AB\u66FF\u6362\u7684\u5DF2\u6253\u5F00\u6587\u4EF6\uFF1A${path}`);
      });
      this.identityMaintenanceInProgress = true;
      this.transferInProgress = true;
      let workspace = "";
      let copyComplete = false;
      const createdPaths = [];
      const removeCreatedEmptyFolders = async () => {
        for (const path of createdPaths.slice().reverse()) {
          try {
            await io.fs.promises.rmdir(io.path.join(vaultRoot, path));
          } catch (error) {
            if (error.code !== "ENOENT") throw new Error(`\u65B0\u5EFA\u76EE\u5F55\u542B\u5176\u4ED6\u5185\u5BB9\u6216\u65E0\u6CD5\u79FB\u9664\uFF0C\u5DF2\u4FDD\u7559\uFF1A${path}`);
          }
        }
      };
      try {
        await this.flushSave();
        if (this.saveDirty) throw new Error("\u73B0\u6709\u63D2\u4EF6\u6570\u636E\u4FDD\u5B58\u5931\u8D25\uFF0C\u505C\u6B62\u590D\u5236");
        const backupBase = io.path.join(vaultRoot, this.app.vault.configDir, "plugins", this.manifest.id);
        const checkedBase = await checkedDirectory(io, backupBase);
        if (!contained(io, vaultRoot, checkedBase)) throw new Error("\u63D2\u4EF6\u5907\u4EFD\u76EE\u5F55\u4E0D\u5728\u5F53\u524D Vault \u5185");
        workspace = await io.fs.promises.mkdtemp(io.path.join(checkedBase, "local-copy-"));
        await io.fs.promises.writeFile(io.path.join(workspace, "data-before.json"), dataSnapshot, { flag: "wx" });
        await io.fs.promises.writeFile(io.path.join(workspace, "plan.json"), JSON.stringify({ source, target, roots, createdDirectories: targetPlan.missing, paths: [...mappedPaths], guids: [...replacements] }), { flag: "wx" });
        const staging = io.path.join(workspace, "staged");
        await io.fs.promises.mkdir(staging);
        new import_obsidian.Notice("\u6B63\u5728\u51C6\u5907\u526F\u672C\uFF0C\u5C1A\u672A\u66FF\u6362\u76EE\u6807\uFF1B\u5927\u6587\u4EF6\u9010\u9879\u590D\u5236\uFF0C\u8BF7\u52FF\u7F16\u8F91\u6765\u6E90\u6216\u76EE\u6807");
        for (const entry of pack.items) {
          checkCancelled();
          const output = io.path.join(staging, mappedPaths.get(entry.path));
          if (entry.kind === "folder") await io.fs.promises.mkdir(output, { recursive: true });
          else {
            await io.fs.promises.mkdir(io.path.dirname(output), { recursive: true });
            const input = io.path.join(source, entry.path);
            if (/\.md$/i.test(entry.path)) {
              const header = await markdownHeader(io, input);
              const yaml = header.yaml === null ? {} : yamlObject((0, import_obsidian.parseYaml)(header.yaml));
              yaml.guid = replacements.get(entry.path);
              await copyMarkdown(io, input, output, (0, import_obsidian.stringifyYaml)(yaml), header);
            } else await io.fs.promises.copyFile(input, output, io.fs.constants.COPYFILE_EXCL);
          }
        }
        const stagedInventory = await scanDisk(io, staging);
        const verify = async () => {
          checkCancelled();
          if (this.transferEvents.length || JSON.stringify(this.data) !== dataSnapshot) throw new Error("\u51C6\u5907\u671F\u95F4\u76EE\u6807\u5E93\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u68C0");
          await checkedDirectory(io, source);
          await checkedDirectory(io, target);
          await verifyDisk(io, source, sourceEntries);
          if (sourceInfo.metadataPath && await io.fs.promises.readFile(sourceInfo.metadataPath, "utf8") !== sourceInfo.metadataText) throw new Error("\u6765\u6E90\u6392\u5E8F\u6570\u636E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u68C0");
          const currentNames = await io.fs.promises.readdir(target);
          if (currentNames.length !== targetNames.length || currentNames.some((name) => !targetNameSet.has(name))) throw new Error("\u76EE\u6807\u540C\u7EA7\u9879\u76EE\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u68C0");
          for (const [name, snapshot] of snapshots) await verifyDisk(io, io.path.join(target, name), snapshot, true);
        };
        const stagedData = {
          ...originalData,
          folderGuids: { ...originalData.folderGuids },
          fileGuids: { ...originalData.fileGuids },
          orderByFolder: { ...originalData.orderByFolder },
          folderNoteMergeOverrides: { ...originalData.folderNoteMergeOverrides }
        };
        for (const [path, guid] of missingGuids) {
          stagedData.folderGuids[path] = guid;
          const parent = path.split("/").slice(0, -1).join("/");
          const parentGuid = missingGuids.get(parent);
          const folder = parentGuid ? null : this.transferFolder(parent);
          const key2 = parentGuid || this.folderKeySync(folder);
          const before = folder ? this.sortFolderItems(folder.path, folder.children).map((item) => oldGuids.get(item.path)) : [];
          stagedData.orderByFolder[key2] = this.data.settings.newItemPlacement === "top" ? [guid, ...before] : [...before, guid];
        }
        const outsideGuids = /* @__PURE__ */ new Set();
        for (const [path, guid] of oldGuids) if (!inReplacement(path)) outsideGuids.add(guid);
        for (const path of Object.keys(stagedData.folderGuids)) if (inReplacement(path)) {
          const guid = stagedData.folderGuids[path];
          delete stagedData.folderGuids[path];
          if (!outsideGuids.has(guid)) delete stagedData.orderByFolder[guid];
        }
        for (const path of Object.keys(stagedData.fileGuids)) if (inReplacement(path)) delete stagedData.fileGuids[path];
        for (const entry of pack.items) {
          const path = prefix + mappedPaths.get(entry.path);
          const guid = replacements.get(entry.path);
          if (entry.kind === "folder") {
            stagedData.folderGuids[path] = guid;
            const choice = pack.mergeChoices[entry.guid.slice(2)];
            if (typeof choice === "boolean") stagedData.folderNoteMergeOverrides[guid.slice(2)] = choice;
          } else if (!/\.md$/i.test(path)) stagedData.fileGuids[path] = guid;
        }
        for (const [parent, children] of Object.entries(pack.orders)) if (parent) stagedData.orderByFolder[replacements.get(parent)] = children.map((path) => replacements.get(path));
        const rootByTarget = new Map(roots.map((root) => [prefix + root.target, root]));
        const existingOrder = targetOrder.map((path) => rootByTarget.has(path) ? replacements.get(rootByTarget.get(path).source) : oldGuids.get(path));
        const additions = roots.filter((root) => !root.replaces).map((root) => replacements.get(root.source));
        stagedData.orderByFolder[missingGuids.get(destination) || this.folderKeySync(targetFolder)] = this.data.settings.newItemPlacement === "top" ? [...additions, ...existingOrder] : [...existingOrder, ...additions];
        const freshTarget = await resolveCopyDestination(io, vaultRoot, target);
        if (JSON.stringify(freshTarget.missing) !== JSON.stringify(targetPlan.missing)) throw new Error("\u9884\u68C0\u540E\u76EE\u6807\u8DEF\u5F84\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u68C0");
        for (const path of targetPlan.missing) {
          checkCancelled();
          this.autoCopyCreatedDirectories.add(path);
          await io.fs.promises.mkdir(io.path.join(vaultRoot, path));
          createdPaths.push(path);
        }
        await verify();
        this.autoCopyScope = { destination, roots: new Set(roots.map((root) => root.target)) };
        const waitForIndex = async (expected) => {
          this.autoCopyLastEvent = Date.now();
          const fileStats = /* @__PURE__ */ new Map();
          for (const [path, kind] of expected) if (kind === "file") fileStats.set(path, await io.fs.promises.stat(io.path.join(vaultRoot, path)));
          const start = Date.now();
          let stable = 0;
          while (Date.now() - start < 2e4) {
            const current = this.manageableItems().filter((item) => this.ownsAutoCopyPath(item.path));
            const matches = current.length === expected.size && current.every((item) => {
              if (expected.get(item.path) !== (item instanceof import_obsidian.TFolder ? "folder" : "file")) return false;
              const stat = fileStats.get(item.path);
              return !(item instanceof import_obsidian.TFile) || Boolean(stat && item.stat.size === stat.size && Math.abs(item.stat.mtime - stat.mtimeMs) < 2);
            });
            stable = matches && Date.now() - this.autoCopyLastEvent >= 500 ? stable + 1 : 0;
            if (stable >= 2) return;
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
          throw new Error("Obsidian \u6587\u4EF6\u7D22\u5F15\u672A\u53CA\u65F6\u66F4\u65B0\uFF1B\u8BF7\u91CD\u8F7D\u540E\u68C0\u67E5\u6062\u590D\u65E5\u5FD7");
        };
        const oldScope = new Map(all.filter((item) => this.ownsAutoCopyPath(item.path)).map((item) => [item.path, item instanceof import_obsidian.TFolder ? "folder" : "file"]));
        await installCopies(io, {
          roots,
          target,
          workspace,
          verify,
          checkCancelled,
          commitData: async () => {
            await verifyInstalledCopies(io, target, roots, stagedInventory);
            const expected = new Map(pack.items.map((item) => [prefix + mappedPaths.get(item.path), item.kind]));
            for (const path of createdPaths) expected.set(path, "folder");
            await waitForIndex(expected);
            await verifyInstalledCopies(io, target, roots, stagedInventory);
            checkCancelled();
            if (this.transferEvents.length || JSON.stringify(this.data) !== dataSnapshot) throw new Error("\u590D\u5236\u671F\u95F4\u5E93\u5185\u53D1\u751F\u5176\u4ED6\u6587\u4EF6\u6216\u8BBE\u7F6E\u64CD\u4F5C\uFF0C\u505C\u6B62\u63D0\u4EA4");
            this.data = stagedData;
            for (const path of this.guidByPath.keys()) if (this.ownsAutoCopyPath(path)) this.guidByPath.delete(path);
            for (const entry of pack.items) this.guidByPath.set(prefix + mappedPaths.get(entry.path), replacements.get(entry.path));
            for (const [path, guid] of missingGuids) this.guidByPath.set(path, guid);
            await this.persistOrderData();
          },
          rollbackData: async () => {
            this.data = originalData;
            for (const path of this.guidByPath.keys()) if (this.ownsAutoCopyPath(path)) this.guidByPath.delete(path);
            for (const [path, guid] of oldGuids) this.guidByPath.set(path, guid);
            await this.persistOrderData();
            await removeCreatedEmptyFolders();
            await waitForIndex(oldScope);
          }
        });
        copyComplete = true;
        this.clearUndoHistory();
        new import_obsidian.Notice(`\u5DF2\u81EA\u52A8\u590D\u5236 ${pack.items.length} \u9879\uFF1B\u539F\u5185\u5BB9\u53CA\u7D22\u5F15\u5907\u4EFD\uFF1A${workspace}`, 12e3);
      } catch (error) {
        throw new Error(`${String(error)}${workspace ? `\uFF1B\u51C6\u5907/\u6062\u590D\u6587\u4EF6\u4FDD\u7559\u5728 ${workspace}` : ""}`);
      } finally {
        if (!copyComplete) await removeCreatedEmptyFolders().catch((error) => new import_obsidian.Notice(String(error), 12e3));
        this.autoCopyCreatedDirectories.clear();
        this.autoCopyScope = null;
        this.identityMaintenanceInProgress = false;
        this.transferInProgress = false;
        this.refreshExplorer();
        for (const event of this.transferEvents.splice(0)) await event();
      }
    } finally {
      this.autoCopyPreparing = false;
    }
  }
  transferFolder(path) {
    if (!safeTransferPath(path, true)) throw new Error("\u8BF7\u8F93\u5165 Vault \u5185\u76F8\u5BF9\u76EE\u5F55\u8DEF\u5F84\uFF0C\u4E0D\u652F\u6301\u9690\u85CF\u76EE\u5F55\u6216\u4E0A\u7EA7\u8DEF\u5F84");
    const folder = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (!(folder instanceof import_obsidian.TFolder)) throw new Error(`\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${path}`);
    return folder;
  }
  openIdentitySelection() {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    new IdentitySelectionModal(this.app, this.manageableItems(), (paths, mode) => {
      void this.applyIdentitySelection(paths, mode);
    }).open();
  }
  addIdentityMenuItems(menu, item) {
    if (this.storageState !== "ready") return;
    if (!(item instanceof import_obsidian.TFile || item instanceof import_obsidian.TFolder) || !item.path) return;
    const guid = this.getItemGuidSync(item);
    menu.addItem((entry) => entry.setTitle(guid ? "\u91CD\u65B0\u751F\u6210 GUID \u5E76\u7EB3\u5165\u7BA1\u7406" : "\u751F\u6210 GUID \u5E76\u7EB3\u5165\u7BA1\u7406").setIcon(guid ? "refresh-cw" : "fingerprint").onClick(() => void this.applyIdentitySelection([item.path], guid ? "regenerate" : "missing")));
    const pair = this.resolvePairedFolderNote(item);
    if (!pair) return;
    const merged = mergeChoice(this.data.settings.mergePairedFolderNotes, this.data.folderNoteMergeOverrides, pair.token);
    menu.addItem((entry) => entry.setTitle(merged ? "\u53D6\u6D88\u4E0E\u540C\u540D\u6587\u4EF6\u5939\u5408\u5E76\u5C55\u793A" : "\u4E0E\u540C\u540D\u6587\u4EF6\u5939\u5408\u5E76\u5C55\u793A").setIcon(merged ? "panel-top-close" : "panel-top-open").onClick(() => void this.setPairMergeOverride(pair.token, !merged)));
  }
  resolvePairedFolderNote(item) {
    let folder = null;
    let note = null;
    if (item instanceof import_obsidian.TFolder) {
      folder = item;
      const candidate = this.app.vault.getAbstractFileByPath(`${item.path}/${item.name}.md`);
      if (candidate instanceof import_obsidian.TFile) note = candidate;
    } else if (item instanceof import_obsidian.TFile && isMarkdown(item) && item.parent && item.basename === item.parent.name) {
      folder = item.parent;
      note = item;
    }
    if (!folder || !note) return null;
    const token = pairedFolderNoteToken({
      folderName: folder.name,
      fileBasename: note.basename,
      folderGuid: this.getItemGuidSync(folder),
      fileGuid: this.getItemGuidSync(note),
      directChild: note.parent === folder
    });
    return token ? { folder, note, token } : null;
  }
  isMergedPair(pair) {
    return mergeChoice(this.data.settings.mergePairedFolderNotes, this.data.folderNoteMergeOverrides, pair.token);
  }
  async setPairMergeOverride(token, merged) {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    this.data.folderNoteMergeOverrides[token] = merged;
    await this.forceSave();
    this.scheduleFolderNoteRender();
  }
  installPairedFolderNoteClickHandler() {
    this.registerDomEvent(document, "click", (event) => {
      if (!(event.target instanceof HTMLElement) || event.button !== 0) return;
      if (event.target.closest(".nav-folder-collapse-indicator, .collapse-icon")) return;
      const title = event.target.closest(".nav-folder-title");
      const element = title ? this.explorerItem(title) : null;
      if (!element) return;
      const folder = this.app.vault.getAbstractFileByPath(this.pathFromElement(element));
      if (!(folder instanceof import_obsidian.TFolder)) return;
      const pair = this.resolvePairedFolderNote(folder);
      if (!pair || !this.isMergedPair(pair)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.app.workspace.getLeaf(false).openFile(pair.note);
    }, true);
  }
  scheduleFolderNoteRender() {
    if (this.folderNoteFrame !== null) return;
    this.folderNoteFrame = window.requestAnimationFrame(() => {
      this.folderNoteFrame = null;
      this.applyFolderNoteDisplay();
    });
  }
  applyFolderNoteDisplay() {
    const container = this.getExplorerContainer();
    if (!container) return;
    container.querySelectorAll(".nav-file.yq-order-folder-note-hidden, .nav-folder.yq-order-folder-note").forEach((element) => element.classList.remove("yq-order-folder-note-hidden", "yq-order-folder-note"));
    container.querySelectorAll(".nav-folder-title[data-yq-merged-label]").forEach((element) => delete element.dataset.yqMergedLabel);
    container.querySelectorAll(".nav-file").forEach((element) => {
      const file = this.app.vault.getAbstractFileByPath(this.pathFromElement(element));
      if (!(file instanceof import_obsidian.TFile)) return;
      const pair = this.resolvePairedFolderNote(file);
      if (!pair || !this.isMergedPair(pair)) return;
      element.classList.add("yq-order-folder-note-hidden");
      const folderElement = container.querySelector(`.nav-folder[data-path="${CSS.escape(pair.folder.path)}"]`) || Array.from(container.querySelectorAll(".nav-folder")).find((candidate) => this.pathFromElement(candidate) === pair.folder.path);
      if (folderElement) {
        folderElement.classList.add("yq-order-folder-note");
        const title = folderElement.querySelector(":scope > .nav-folder-title");
        if (title) title.dataset.yqMergedLabel = "\u2197";
      }
    });
  }
  async applyIdentitySelection(paths, mode, orderSnapshot, successLabel = "\u5DF2\u5904\u7406") {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const items = [...new Set(paths)].map((path) => this.app.vault.getAbstractFileByPath(path)).filter((item) => item instanceof import_obsidian.TFile || item instanceof import_obsidian.TFolder);
    if (!items.length && !orderSnapshot) {
      new import_obsidian.Notice("\u9009\u4E2D\u7684\u9879\u76EE\u5DF2\u4E0D\u5B58\u5728");
      return;
    }
    if (mode === "regenerate") {
      const proceed = await new Promise((resolve) => new ConfirmActionModal(
        this.app,
        "\u91CD\u65B0\u751F\u6210\u9009\u4E2D GUID",
        `\u5C06\u4E3A ${items.length} \u4E2A\u9879\u76EE\u751F\u6210\u65B0 GUID\uFF0C\u76EE\u5F55\u4F4D\u7F6E\u4E0E\u5144\u5F1F\u987A\u5E8F\u4E0D\u53D8\u3002`,
        "\u91CD\u65B0\u751F\u6210",
        resolve
      ).open());
      if (!proceed) return;
    }
    this.identityMaintenanceInProgress = true;
    const used = new Set(this.collectIdentityState().entries.map((entry) => entry.guid));
    const mutations = [];
    const previousOrders = orderSnapshot ? {} : null;
    if (previousOrders) {
      for (const [key2, order] of Object.entries(this.data.orderByFolder)) previousOrders[key2] = [...order];
    }
    try {
      for (const item of items) {
        const oldGuid = await this.readItemGuid(item);
        if (mode === "missing" && oldGuid) continue;
        mutations.push({
          item,
          oldGuid,
          newGuid: createGuid(item instanceof import_obsidian.TFolder ? "d" : "f", this.data.settings.guidBits, used)
        });
      }
      if (!mutations.length && !orderSnapshot) {
        new import_obsidian.Notice("\u9009\u4E2D\u9879\u76EE\u5747\u5DF2\u6709\u6709\u6548 GUID\uFF0C\u65E0\u9700\u4FEE\u6539");
        return;
      }
      await mapLimit(mutations, 4, async ({ item, newGuid }) => {
        if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = newGuid;
        else if (isMarkdown(item)) await this.setFileGuid(item, newGuid);
        else {
          this.data.fileGuids[item.path] = newGuid;
          this.guidByPath.set(item.path, newGuid);
        }
      });
      for (const { item, oldGuid, newGuid } of mutations) {
        if (oldGuid) replaceGuidInOrders(this.data.orderByFolder, oldGuid, newGuid);
        else this.addGuidToFolder(item.parent, newGuid);
      }
      if (orderSnapshot) this.rebuildOrders(orderSnapshot);
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new import_obsidian.Notice(`${successLabel}\uFF1A\u751F\u6210 ${mutations.length} \u4E2A GUID\uFF0C\u76EE\u5F55\u7D22\u5F15\u5DF2\u5B8C\u6574\u66F4\u65B0`);
    } catch (error) {
      await mapLimit(mutations, 4, async ({ item, oldGuid, newGuid }) => {
        if (item instanceof import_obsidian.TFolder) {
          if (oldGuid) this.data.folderGuids[item.path] = oldGuid;
          else delete this.data.folderGuids[item.path];
        } else if (isMarkdown(item)) {
          if (oldGuid) await this.setFileGuid(item, oldGuid);
          else await this.clearFileGuid(item, newGuid);
        } else {
          if (oldGuid) this.data.fileGuids[item.path] = oldGuid;
          else delete this.data.fileGuids[item.path];
          if (oldGuid) this.guidByPath.set(item.path, oldGuid);
          else this.guidByPath.delete(item.path);
        }
        if (oldGuid) replaceGuidInOrders(this.data.orderByFolder, newGuid, oldGuid);
        else removeGuidFromOrders(this.data.orderByFolder, newGuid);
      }).catch(() => void 0);
      if (previousOrders) this.data.orderByFolder = previousOrders;
      await this.forceSave().catch(() => void 0);
      new import_obsidian.Notice(`GUID \u64CD\u4F5C\u5931\u8D25\uFF0C\u5DF2\u5C1D\u8BD5\u56DE\u6EDA\uFF1A${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.identityMaintenanceInProgress = false;
    }
  }
  async checkDuplicateGuids(interactive) {
    if (interactive && !this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const state = this.collectIdentityState();
    const groups = findDuplicateIdentities(state.entries);
    if (!groups.length) {
      if (interactive) new import_obsidian.Notice("\u672A\u53D1\u73B0\u91CD\u590D GUID");
      return;
    }
    if (!interactive) {
      new import_obsidian.Notice(`\u53D1\u73B0 ${groups.length} \u7EC4\u91CD\u590D GUID\uFF0C\u53EF\u8FD0\u884C\u201C\u68C0\u6D4B\u5E76\u4FEE\u590D\u91CD\u590D GUID\u201D\u5904\u7406`);
      return;
    }
    const count = groups.reduce((sum, group) => sum + group.length - 1, 0);
    const proceed = await new Promise((resolve) => new ConfirmActionModal(
      this.app,
      "\u53D1\u73B0\u91CD\u590D GUID",
      `\u5171 ${groups.length} \u7EC4\u3001${count} \u4E2A\u9879\u76EE\u9700\u8981\u6362\u53F7\u3002\u6BCF\u7EC4\u6309\u5F53\u524D\u76EE\u5F55\u987A\u5E8F\u4FDD\u7559\u9996\u9879\uFF0C\u5176\u4F59\u751F\u6210\u65B0 GUID\u3002`,
      "\u81EA\u52A8\u4FEE\u590D",
      resolve
    ).open());
    if (!proceed) return;
    this.identityMaintenanceInProgress = true;
    const changed = [];
    try {
      const used = new Set(state.entries.map((entry) => entry.guid));
      const replacements = [];
      groups.forEach((group) => replacements.push(...group.slice(1)));
      await mapLimit(replacements, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        const guid = createGuid(entry.kind === "folder" ? "d" : "f", this.data.settings.guidBits, used);
        if (item instanceof import_obsidian.TFile && isMarkdown(item)) await this.setFileGuid(item, guid);
        else if (item instanceof import_obsidian.TFile) {
          this.data.fileGuids[item.path] = guid;
          this.guidByPath.set(item.path, guid);
        } else if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = guid;
        changed.push(entry);
        if (changed.length % 200 === 0) await yieldToUi();
      });
      this.rebuildOrders(state.folderChildrenByPath);
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new import_obsidian.Notice(`\u5DF2\u4FEE\u590D ${count} \u4E2A\u91CD\u590D GUID\uFF0C\u76EE\u5F55\u987A\u5E8F\u4FDD\u6301\u4E0D\u53D8`);
    } catch (error) {
      await mapLimit(changed, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof import_obsidian.TFile && isMarkdown(item)) await this.setFileGuid(item, entry.guid);
        else if (item instanceof import_obsidian.TFile) {
          this.data.fileGuids[item.path] = entry.guid;
          this.guidByPath.set(item.path, entry.guid);
        } else if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = entry.guid;
      }).catch(() => void 0);
      this.rebuildOrders(state.folderChildrenByPath);
      new import_obsidian.Notice(`\u4FEE\u590D\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      await this.reconcileVault(true);
    } finally {
      this.identityMaintenanceInProgress = false;
    }
  }
  backupDirectory() {
    return (0, import_obsidian.normalizePath)(`${this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`}/guid-backups`);
  }
  async writeGuidBackup(backup, bits) {
    const directory = this.backupDirectory();
    if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
    const id = `${Date.now()}-${createGuid("f", 64).slice(2)}`;
    const file = (0, import_obsidian.normalizePath)(`${directory}/${id}.json`);
    await this.app.vault.adapter.write(file, JSON.stringify(backup));
    const meta = { id, createdAt: (/* @__PURE__ */ new Date()).toISOString(), file, bits, count: backup.entries.length };
    this.data.guidBackups.push(meta);
    return meta;
  }
  pruneGuidBackups() {
    return this.data.guidBackups.length > 3 ? this.data.guidBackups.splice(0, this.data.guidBackups.length - 3) : [];
  }
  async retargetGuidBackups(currentByPath) {
    for (const meta of this.data.guidBackups) {
      try {
        if (!await this.app.vault.adapter.exists(meta.file)) continue;
        const backup = JSON.parse(await this.app.vault.adapter.read(meta.file));
        if (!backup.entries.every((entry) => currentByPath.has(entry.path))) continue;
        backup.entries.forEach((entry) => {
          entry.replacementGuid = currentByPath.get(entry.path);
        });
        await this.app.vault.adapter.write(meta.file, JSON.stringify(backup));
      } catch (error) {
        console.warn("[Yuque Sorting] Failed to update a GUID recovery baseline.", error);
      }
    }
  }
  async replaceAllGuids(bits, createBackup) {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const proceed = await new Promise((resolve) => new ConfirmActionModal(
      this.app,
      "\u4E3A\u6574\u4E2A\u5E93\u66F4\u6362 GUID",
      `\u5C06\u4E3A\u5168\u90E8\u6587\u4EF6\u548C\u6587\u4EF6\u5939\u751F\u6210 ${bits} bit GUID\uFF0C\u5E76\u4FDD\u6301\u5F53\u524D\u76EE\u5F55\u987A\u5E8F\u3002${createBackup ? "\u5C06\u521B\u5EFA\u6062\u590D\u70B9\u3002" : "\u4E0D\u4F1A\u521B\u5EFA\u6301\u4E45\u6062\u590D\u70B9\u3002"}`,
      "\u5F00\u59CB\u66F4\u6362",
      resolve
    ).open());
    if (!proceed) return;
    this.identityMaintenanceInProgress = true;
    const state = this.collectIdentityState();
    const used = /* @__PURE__ */ new Set();
    const replacement = new Map(state.entries.map((entry) => [entry.path, createGuid(entry.kind === "folder" ? "d" : "f", bits, used)]));
    const backup = { version: 1, entries: state.entries.map((entry) => ({ ...entry, replacementGuid: replacement.get(entry.path) })), folderChildrenByPath: state.folderChildrenByPath };
    const changedMarkdown = [];
    const previousBits = this.data.settings.guidBits;
    let backupMeta = null;
    let obsoleteBackups = [];
    try {
      if (createBackup) backupMeta = await this.writeGuidBackup(backup, bits);
      const markdown = state.entries.filter((entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        return item instanceof import_obsidian.TFile && isMarkdown(item);
      });
      await mapLimit(markdown, 4, async (entry) => {
        const file = this.app.vault.getAbstractFileByPath(entry.path);
        await this.setFileGuid(file, replacement.get(entry.path));
        changedMarkdown.push({ file, guid: entry.guid });
      });
      let mapped = 0;
      for (const entry of state.entries) {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        const guid = replacement.get(entry.path);
        if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = guid;
        else if (item instanceof import_obsidian.TFile && !isMarkdown(item)) {
          this.data.fileGuids[item.path] = guid;
          this.guidByPath.set(item.path, guid);
        }
        mapped += 1;
        if (mapped % 250 === 0) await yieldToUi();
      }
      this.rebuildOrders(state.folderChildrenByPath);
      this.data.settings.guidBits = bits;
      obsoleteBackups = this.pruneGuidBackups();
      await this.retargetGuidBackups(replacement);
      this.clearUndoHistory();
      await this.forceSave();
      for (const obsolete of obsoleteBackups) {
        try {
          if (await this.app.vault.adapter.exists(obsolete.file)) await this.app.vault.adapter.remove(obsolete.file);
        } catch (error) {
          console.warn("[Yuque Sorting] Failed to remove an expired GUID recovery point.", error);
        }
      }
      this.refreshExplorer();
      new import_obsidian.Notice(`\u5DF2\u4E3A ${state.entries.length} \u4E2A\u9879\u76EE\u66F4\u6362 GUID`);
    } catch (error) {
      await mapLimit(changedMarkdown, 4, async ({ file, guid }) => this.setFileGuid(file, guid)).catch(() => void 0);
      for (const entry of state.entries) {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = entry.guid;
        else if (item instanceof import_obsidian.TFile && !isMarkdown(item)) {
          this.data.fileGuids[item.path] = entry.guid;
          this.guidByPath.set(item.path, entry.guid);
        }
      }
      this.data.settings.guidBits = previousBits;
      this.rebuildOrders(state.folderChildrenByPath);
      if (obsoleteBackups.length) this.data.guidBackups.unshift(...obsoleteBackups);
      await this.retargetGuidBackups(new Map(state.entries.map((entry) => [entry.path, entry.guid])));
      if (backupMeta) {
        this.data.guidBackups = this.data.guidBackups.filter((candidate) => candidate.id !== (backupMeta == null ? void 0 : backupMeta.id));
        if (await this.app.vault.adapter.exists(backupMeta.file)) await this.app.vault.adapter.remove(backupMeta.file);
      }
      new import_obsidian.Notice(`\u66F4\u6362\u5931\u8D25\uFF0C\u5DF2\u5C1D\u8BD5\u56DE\u6EDA\uFF1A${error instanceof Error ? error.message : String(error)}`);
      await this.reconcileVault(true);
    } finally {
      this.identityMaintenanceInProgress = false;
    }
  }
  async restoreGuidBackup(meta) {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const changed = [];
    let currentOrders = null;
    try {
      const backup = JSON.parse(await this.app.vault.adapter.read(meta.file));
      const current = this.collectIdentityState();
      currentOrders = current.folderChildrenByPath;
      const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
      const valid = backup.entries.length === current.entries.length && backup.entries.every((entry) => {
        const now = currentByPath.get(entry.path);
        return (now == null ? void 0 : now.kind) === entry.kind && now.guid === entry.replacementGuid;
      });
      if (!valid) {
        new import_obsidian.Notice("\u65E0\u6CD5\u6062\u590D\uFF1A\u5F53\u524D\u5E93\u5DF2\u6709\u65B0\u589E\u3001\u5220\u9664\u3001\u79FB\u52A8\u3001\u91CD\u547D\u540D\u6216 GUID \u53D8\u5316");
        return;
      }
      const proceed = await new Promise((resolve) => new ConfirmActionModal(this.app, "\u6062\u590D GUID", `\u6062\u590D ${meta.createdAt} \u7684 ${meta.count} \u9879 GUID \u548C\u76EE\u5F55\u987A\u5E8F\u3002`, "\u6062\u590D", resolve).open());
      if (!proceed) return;
      this.identityMaintenanceInProgress = true;
      await mapLimit(backup.entries, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof import_obsidian.TFile && isMarkdown(item)) await this.setFileGuid(item, entry.guid);
        else if (item instanceof import_obsidian.TFile) {
          this.data.fileGuids[item.path] = entry.guid;
          this.guidByPath.set(item.path, entry.guid);
        } else if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = entry.guid;
        changed.push(entry);
      });
      this.rebuildOrders(backup.folderChildrenByPath);
      await this.retargetGuidBackups(new Map(backup.entries.map((entry) => [entry.path, entry.guid])));
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new import_obsidian.Notice("GUID \u4E0E\u76EE\u5F55\u987A\u5E8F\u5DF2\u6062\u590D");
    } catch (error) {
      await mapLimit(changed, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof import_obsidian.TFile && isMarkdown(item)) await this.setFileGuid(item, entry.replacementGuid);
        else if (item instanceof import_obsidian.TFile) {
          this.data.fileGuids[item.path] = entry.replacementGuid;
          this.guidByPath.set(item.path, entry.replacementGuid);
        } else if (item instanceof import_obsidian.TFolder) this.data.folderGuids[item.path] = entry.replacementGuid;
      }).catch(() => void 0);
      if (currentOrders) this.rebuildOrders(currentOrders);
      new import_obsidian.Notice(`\u6062\u590D\u5931\u8D25\uFF0C\u5DF2\u5C1D\u8BD5\u56DE\u6EDA\uFF1A${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.identityMaintenanceInProgress = false;
    }
  }
  async requestManifestImport() {
    var _a, _b, _c;
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      new import_obsidian.Notice("\u672A\u627E\u5230 _yuque_order.json");
      return;
    }
    if (this.identityMaintenanceInProgress) return;
    const parsed = [];
    const problems = [];
    for (const file of manifests) {
      try {
        const raw = JSON.parse(await this.app.vault.read(file));
        if ((raw == null ? void 0 : raw.version) !== 2 || typeof raw.exportId !== "string" || !Array.isArray(raw.directories)) {
          problems.push(`${file.path}\uFF1A\u65E0\u6CD5\u89E3\u6790`);
        } else parsed.push({ file, raw });
      } catch (e) {
        problems.push(`${file.path}\uFF1A\u65E0\u6CD5\u89E3\u6790`);
      }
    }
    if (!parsed.length) {
      new import_obsidian.Notice(problems.length ? problems[0] : "\u6CA1\u6709\u53EF\u7528\u7684\u8BED\u96C0\u5BFC\u51FA\u6E05\u5355");
      return;
    }
    const seen = /* @__PURE__ */ new Set();
    const verifiedMarkdownGuids = /* @__PURE__ */ new Map();
    const markdownTextByPath = /* @__PURE__ */ new Map();
    let matched = 0;
    const actualDuplicates = findDuplicateIdentities(this.collectIdentityState().entries);
    if (actualDuplicates.length) problems.push(`\u5F53\u524D\u5E93\u5B58\u5728 ${actualDuplicates.length} \u7EC4\u91CD\u590D GUID`);
    for (const { file, raw } of parsed) {
      const adoptExportIdentity = !this.data.consumedManifestIds.includes(raw.exportId);
      const root = ((_a = file.parent) == null ? void 0 : _a.path) || "";
      const expectedPaths = /* @__PURE__ */ new Set();
      for (const directory of raw.directories) {
        if (!directory || typeof directory.path !== "string" || !Array.isArray(directory.items)) {
          problems.push(`${file.path}\uFF1A\u76EE\u5F55\u7ED3\u6784\u65E0\u6548`);
          continue;
        }
        for (const entry of directory.items) {
          if (!entry || !["file", "folder"].includes(entry.kind) || typeof entry.path !== "string" || typeof entry.guid !== "string") {
            problems.push(`${file.path}\uFF1A\u6761\u76EE\u65E0\u6548`);
            continue;
          }
          const expectedKind = entry.kind === "folder" ? "d" : "f";
          const bits = Number(raw.guidBits) === 72 ? 72 : 64;
          const currentLength = bits === 72 ? 13 : 11;
          const currentGuid = new RegExp(`^${expectedKind}-[A-Za-z0-9]{${currentLength}}$`).test(entry.guid);
          const legacyLength = bits === 72 ? 12 : 11;
          const legacyGuid = new RegExp(`^${expectedKind}:[A-Za-z0-9_-]{${legacyLength}}$`).test(entry.guid);
          if (!currentGuid && !legacyGuid) {
            problems.push(`${entry.path}\uFF1AGUID \u683C\u5F0F\u6216\u7C7B\u578B\u524D\u7F00\u4E0D\u7B26`);
          }
          if (seen.has(entry.guid)) problems.push(`${file.path}\uFF1A\u91CD\u590D GUID ${entry.guid}`);
          seen.add(entry.guid);
          const path = root ? `${root}/${entry.path}` : entry.path;
          if (expectedPaths.has((0, import_obsidian.normalizePath)(path))) problems.push(`${entry.path}\uFF1A\u6E05\u5355\u4E2D\u5B58\u5728\u91CD\u590D\u6700\u7EC8\u8DEF\u5F84`);
          expectedPaths.add((0, import_obsidian.normalizePath)(path));
          const relativeParent = (0, import_obsidian.normalizePath)(entry.path).split("/").slice(0, -1).join("/");
          const expectedParent = directory.path ? (0, import_obsidian.normalizePath)(directory.path) : "";
          if (relativeParent !== expectedParent) problems.push(`${entry.path}\uFF1A\u7236\u7EA7\u4E0E\u76EE\u5F55\u6E05\u5355\u4E0D\u4E00\u81F4`);
          const item = this.app.vault.getAbstractFileByPath(path);
          if (!item || entry.kind === "file" !== item instanceof import_obsidian.TFile) problems.push(`${path}\uFF1A\u5F53\u524D\u5E93\u7F3A\u5931\u6216\u7C7B\u578B\u4E0D\u7B26`);
          else {
            let actualGuid = this.getItemGuidSync(item);
            if (item instanceof import_obsidian.TFile && isMarkdown(item) && actualGuid !== entry.guid) {
              try {
                const text = await this.app.vault.read(item);
                markdownTextByPath.set(path, text);
                actualGuid = this.readGuidFromText(text);
              } catch (e) {
                actualGuid = null;
              }
            }
            if (item instanceof import_obsidian.TFile && isMarkdown(item) && actualGuid) verifiedMarkdownGuids.set(path, actualGuid);
            if (adoptExportIdentity && item instanceof import_obsidian.TFile && isMarkdown(item) && actualGuid !== entry.guid) problems.push(`${path}\uFF1Afrontmatter GUID \u4E0E\u6E05\u5355\u4E0D\u7B26`);
            else matched += 1;
          }
        }
      }
      if (raw.resources !== void 0 && !Array.isArray(raw.resources)) {
        problems.push(`${file.path}\uFF1Aresources \u7ED3\u6784\u65E0\u6548`);
      }
      for (const entry of Array.isArray(raw.resources) ? raw.resources : []) {
        if (!entry || !["file", "folder"].includes(entry.kind) || typeof entry.path !== "string" || typeof entry.guid !== "string") {
          problems.push(`${file.path}\uFF1A\u8D44\u6E90\u6761\u76EE\u65E0\u6548`);
          continue;
        }
        const expectedKind = entry.kind === "folder" ? "d" : "f";
        const bits = Number(raw.guidBits) === 72 ? 72 : 64;
        const currentLength = bits === 72 ? 13 : 11;
        const currentGuid = new RegExp(`^${expectedKind}-[A-Za-z0-9]{${currentLength}}$`).test(entry.guid);
        const legacyLength = bits === 72 ? 12 : 11;
        const legacyGuid = new RegExp(`^${expectedKind}:[A-Za-z0-9_-]{${legacyLength}}$`).test(entry.guid);
        if (!currentGuid && !legacyGuid) problems.push(`${entry.path}\uFF1A\u8D44\u6E90 GUID \u683C\u5F0F\u6216\u7C7B\u578B\u524D\u7F00\u4E0D\u7B26`);
        if (seen.has(entry.guid)) problems.push(`${file.path}\uFF1A\u91CD\u590D GUID ${entry.guid}`);
        seen.add(entry.guid);
        const path = root ? `${root}/${entry.path}` : entry.path;
        const normalized = (0, import_obsidian.normalizePath)(path);
        if (expectedPaths.has(normalized)) problems.push(`${entry.path}\uFF1A\u6E05\u5355\u4E2D\u5B58\u5728\u91CD\u590D\u6700\u7EC8\u8DEF\u5F84`);
        expectedPaths.add(normalized);
        const item = this.app.vault.getAbstractFileByPath(path);
        if (!item || entry.kind === "file" !== item instanceof import_obsidian.TFile) problems.push(`${path}\uFF1A\u5F53\u524D\u5E93\u7F3A\u5931\u6216\u7C7B\u578B\u4E0D\u7B26`);
        else matched += 1;
      }
      if (raw.resources === void 0) {
        for (const directory of raw.directories) for (const entry of directory.items) {
          if ((entry == null ? void 0 : entry.kind) !== "file" || !/\.md$/i.test(entry.path)) continue;
          const path = root ? `${root}/${entry.path}` : entry.path;
          const note = this.app.vault.getAbstractFileByPath(path);
          if (!(note instanceof import_obsidian.TFile)) continue;
          let text = markdownTextByPath.get(path);
          if (text === void 0) {
            try {
              text = await this.app.vault.read(note);
              markdownTextByPath.set(path, text);
            } catch (e) {
              continue;
            }
          }
          for (const resourcePath of referencedLocalPaths(text, path, root)) {
            if (this.app.vault.getAbstractFileByPath(resourcePath)) expectedPaths.add((0, import_obsidian.normalizePath)(resourcePath));
          }
        }
      }
      const prefix = root ? `${root}/` : "";
      let extraCount = 0;
      for (const item of this.app.vault.getAllLoadedFiles()) {
        if (!item.path || item.path === file.path || prefix && !item.path.startsWith(prefix)) continue;
        if (!expectedPaths.has((0, import_obsidian.normalizePath)(item.path))) extraCount += 1;
      }
      if (extraCount) problems.push(`${file.path}\uFF1A\u5F53\u524D\u5E93\u591A\u51FA ${extraCount} \u4E2A\u9879\u76EE`);
    }
    const changedDirectories = [];
    let changedPositions = 0;
    const previewLines = [];
    const previews = [];
    for (const { file, raw } of parsed) {
      const root = ((_b = file.parent) == null ? void 0 : _b.path) || "";
      for (const directory of raw.directories) {
        if (!directory || typeof directory.path !== "string" || !Array.isArray(directory.items)) continue;
        const folderPath = directory.path ? root ? `${root}/${directory.path}` : directory.path : root;
        const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
        if (!(folder instanceof import_obsidian.TFolder)) continue;
        const current = this.sortFolderItems(folder.path, folder.children).map((item) => item.path);
        const currentSet = new Set(current);
        const listed = directory.items.map((entry) => typeof (entry == null ? void 0 : entry.path) === "string" ? root ? `${root}/${entry.path}` : entry.path : "").filter((path) => currentSet.has(path));
        const listedSet = new Set(listed);
        const next = [...listed, ...current.filter((path) => !listedSet.has(path))];
        const changed = next.reduce((count, path, index) => count + (current[index] !== path ? 1 : 0), 0);
        if (!changed) continue;
        const folderLabel = folderPath || "Vault \u6839\u76EE\u5F55";
        changedDirectories.push(folderLabel);
        changedPositions += changed;
        if (previewLines.length < 10) {
          const names = (paths) => paths.slice(0, 6).map((path) => path.split("/").pop()).join(" \u2192 ") + (paths.length > 6 ? " \u2192 \u2026" : "");
          const currentText = names(current), nextText = names(next);
          previews.push({ folder: folderLabel, current: currentText, next: nextText });
          previewLines.push(`${folderLabel}\uFF1A\u5F53\u524D [${currentText}]\uFF1B\u6062\u590D\u540E [${nextText}]`);
        }
      }
    }
    const dataBeforeConfirmation = JSON.stringify(this.data);
    const fileState = () => JSON.stringify(this.app.vault.getAllLoadedFiles().map((item) => [item.path, item instanceof import_obsidian.TFile ? [item.stat.mtime, item.stat.size] : "folder"]));
    const filesBeforeConfirmation = fileState();
    const newManifests = parsed.filter(({ raw }) => !this.data.consumedManifestIds.includes(raw.exportId)).length;
    const matchingCaveat = `\u5339\u914D\u53EA\u770B\u6E05\u5355\u4E2D\u7684\u8DEF\u5F84\uFF0C\u4E0D\u770B\u6587\u4EF6\u5185\u5BB9\uFF1A\u5DF2\u6539\u540D\u6216\u79FB\u52A8\u8FC7\u7684\u9879\u76EE\u65E0\u6CD5\u6062\u590D\u539F\u987A\u5E8F\uFF08\u4F1A\u63D0\u793A\u7F3A\u5931/\u591A\u51FA\uFF09\u3002${newManifests < parsed.length ? "\u540C\u4E00\u8DEF\u5F84\u82E5\u5DF2\u6362\u6210\u53E6\u4E00\u4E2A\u6587\u4EF6\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u8BC6\u522B\uFF0C\u4F1A\u76F4\u63A5\u6309\u6E05\u5355\u4F4D\u7F6E\u6392\u5E8F\u3002" : ""}`;
    const restoreView = {
      manifestCount: parsed.length,
      changedDirectories: changedDirectories.length,
      changedPositions,
      previews,
      problems,
      newManifests
    };
    const renderManifestRestoreDetails = (contentEl) => renderManifestRestoreView(contentEl, restoreView);
    const proceed = await new Promise((resolve) => new ConfirmActionModal(
      this.app,
      "\u786E\u8BA4\u6062\u590D\u539F\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F",
      `\u5DF2\u68C0\u67E5 ${parsed.length} \u4EFD\u6709\u6548\u6E05\u5355\uFF1B${changedDirectories.length} \u4E2A\u76EE\u5F55\u7684\u987A\u5E8F\u5C06\u53D8\u5316\uFF0C${changedPositions} \u4E2A\u663E\u793A\u4F4D\u7F6E\u4E0D\u540C\u3002${changedDirectories.length ? previewLines.join("\uFF1B") + (changedDirectories.length > 10 ? "\uFF1B\u5176\u4F59\u76EE\u5F55\u7701\u7565" : "") : "\u5F53\u524D\u53EF\u5339\u914D\u9879\u76EE\u7684\u663E\u793A\u987A\u5E8F\u4E0E\u6E05\u5355\u4E00\u81F4\u3002"} ${problems.length ? `\u53E6\u6709 ${problems.length} \u9879\u6E05\u5355\u5DEE\u5F02\uFF1A${problems.slice(0, 10).join("\uFF1B")}${problems.length > 10 ? "\uFF1B\u5176\u4F59\u7701\u7565" : ""}\u3002\u7EE7\u7EED\u4EC5\u5904\u7406\u80FD\u591F\u5339\u914D\u7684\u9879\u76EE\u3002` : "\u672A\u53D1\u73B0\u6E05\u5355\u5DEE\u5F02\u3002"} ${newManifests ? `${newManifests} \u4EFD\u6E05\u5355\u4E3A\u9996\u6B21\u4F7F\u7528\uFF0C\u5C06\u6309\u73B0\u6709\u89C4\u5219\u91C7\u7528\u6E05\u5355\u91CC\u7684 GUID \u5E76\u5EFA\u7ACB\u7D22\u5F15\uFF1BMarkdown \u6B63\u6587\u4E0D\u6539\u5199\u3002` : "\u4EC5\u6062\u590D\u987A\u5E8F\uFF0C\u4E0D\u8986\u76D6\u540E\u6765\u66F4\u6362\u7684 GUID\u3002"} ${matchingCaveat}\u4E0D\u79FB\u52A8\u3001\u91CD\u547D\u540D\u6216\u5220\u9664\u5B9E\u9645\u6587\u4EF6\u3002\u786E\u8BA4\u540E\u4F1A\u6E05\u7A7A\u62D6\u62FD\u64A4\u9500\u5386\u53F2\uFF1B\u53D6\u6D88\u6216\u5173\u95ED\u7A97\u53E3\u4E0D\u4FEE\u6539\u6570\u636E\u3002`,
      problems.length ? "\u786E\u8BA4\u6062\u590D\u5339\u914D\u9879" : "\u786E\u8BA4\u6062\u590D\u76EE\u5F55\u987A\u5E8F",
      resolve,
      renderManifestRestoreDetails
    ).open());
    if (!proceed) return;
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress || JSON.stringify(this.data) !== dataBeforeConfirmation || fileState() !== filesBeforeConfirmation) {
      new import_obsidian.Notice("\u786E\u8BA4\u671F\u95F4\u6587\u4EF6\u3001GUID \u6216\u76EE\u5F55\u987A\u5E8F\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u540E\u6062\u590D");
      return;
    }
    this.identityMaintenanceInProgress = true;
    try {
      verifiedMarkdownGuids.forEach((guid, path) => this.guidByPath.set(path, guid));
      for (const { file, raw } of parsed) {
        const root = ((_c = file.parent) == null ? void 0 : _c.path) || "";
        if (!this.data.consumedManifestIds.includes(raw.exportId)) {
          const identityEntries = [];
          for (const directory of raw.directories) identityEntries.push(...directory.items);
          if (Array.isArray(raw.resources)) identityEntries.push(...raw.resources);
          for (const entry of identityEntries) {
            const path = root ? `${root}/${entry.path}` : entry.path;
            const item = this.app.vault.getAbstractFileByPath(path);
            const previousGuid = item ? this.getItemGuidSync(item) : null;
            if (entry.kind === "folder" && item instanceof import_obsidian.TFolder) this.data.folderGuids[path] = entry.guid;
            else if (entry.kind === "file" && item instanceof import_obsidian.TFile) {
              if (!isMarkdown(item)) this.data.fileGuids[path] = entry.guid;
              if (!isMarkdown(item) || this.getItemGuidSync(item) === entry.guid) this.guidByPath.set(path, entry.guid);
            }
            if (previousGuid && previousGuid !== entry.guid && (!(item instanceof import_obsidian.TFile) || !isMarkdown(item))) {
              replaceGuidInOrders(this.data.orderByFolder, previousGuid, entry.guid);
            }
          }
        }
        for (const directory of raw.directories) {
          const folderPath = directory.path ? root ? `${root}/${directory.path}` : directory.path : root;
          const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
          if (!(folder instanceof import_obsidian.TFolder)) continue;
          const wanted = directory.items.map((entry) => {
            const path = root ? `${root}/${entry.path}` : entry.path;
            const item = this.app.vault.getAbstractFileByPath(path);
            return item ? this.getItemGuidSync(item) : null;
          }).filter((guid) => typeof guid === "string");
          const key2 = this.folderKeySync(folder);
          const wantedSet = new Set(wanted);
          this.data.orderByFolder[key2] = [...wanted, ...(this.data.orderByFolder[key2] || []).filter((guid) => !wantedSet.has(guid))];
        }
        if (!this.data.consumedManifestIds.includes(raw.exportId)) this.data.consumedManifestIds.push(raw.exportId);
      }
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new import_obsidian.Notice(`\u5DF2\u4ECE ${parsed.length} \u4EFD\u6E05\u5355\u6062\u590D ${matched} \u4E2A\u9879\u76EE\u7684\u539F\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F`);
    } finally {
      this.identityMaintenanceInProgress = false;
    }
  }
  async inspectManifestConsistency(manifests) {
    var _a;
    const report = {
      missing: [],
      extra: [],
      moved: [],
      duplicateManifestGuids: [],
      duplicateActualGuids: [],
      invalidManifests: []
    };
    const all = this.app.vault.getAllLoadedFiles();
    const byGuid = /* @__PURE__ */ new Map();
    const folderByGuid = /* @__PURE__ */ new Map();
    all.forEach((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return;
      if (item instanceof import_obsidian.TFolder) folderByGuid.set(guid, item);
      else if (item instanceof import_obsidian.TFile) byGuid.set(guid, item);
    });
    for (const manifestFile of manifests) {
      let raw;
      try {
        raw = JSON.parse(await this.app.vault.read(manifestFile));
      } catch (e) {
        report.invalidManifests.push(`${manifestFile.path}\uFF1AJSON \u65E0\u6CD5\u89E3\u6790`);
        continue;
      }
      if ((raw == null ? void 0 : raw.version) !== 1 || !Array.isArray(raw.tree)) {
        report.invalidManifests.push(`${manifestFile.path}\uFF1A\u7248\u672C\u6216 tree \u683C\u5F0F\u65E0\u6548`);
        continue;
      }
      const manifestEntries = [];
      const manifestGuids = [];
      const collect = (nodes, parentGuid, trail) => {
        nodes.forEach((node) => {
          var _a2;
          const guid = normalizeGuid(node == null ? void 0 : node.guid);
          if (!guid) return;
          const title = String((node == null ? void 0 : node.title) || guid);
          const label = trail ? `${trail}/${title}` : `${((_a2 = manifestFile.parent) == null ? void 0 : _a2.path) || ""}/${title}`;
          manifestEntries.push({ guid, parentGuid, label });
          manifestGuids.push(guid);
          if (Array.isArray(node == null ? void 0 : node.children)) collect(node.children, guid, label);
        });
      };
      collect(raw.tree, ROOT_FOLDER_KEY, "");
      const folderAliases = /* @__PURE__ */ new Map();
      const adoptedFolderPaths = /* @__PURE__ */ new Set();
      const manifestGuidSet = new Set(manifestGuids);
      const resolveTree = (nodes, fallbackFolder) => {
        nodes.forEach((node) => {
          const guid = normalizeGuid(node == null ? void 0 : node.guid);
          if (!guid) return;
          let item = byGuid.get(guid) || folderByGuid.get(guid) || null;
          if (!item) {
            const folder = this.matchManifestNodeToFolder(
              fallbackFolder,
              node,
              adoptedFolderPaths,
              manifestGuidSet
            );
            if (folder) {
              folderAliases.set(folder.path, guid);
              folderByGuid.set(guid, folder);
              item = folder;
            }
          }
          const logicalItem = folderByGuid.get(guid) || (item instanceof import_obsidian.TFile ? this.findFolderForNote(item) : null) || item;
          const childFolder = logicalItem instanceof import_obsidian.TFolder ? logicalItem : (logicalItem == null ? void 0 : logicalItem.parent) || fallbackFolder;
          if (Array.isArray(node == null ? void 0 : node.children)) resolveTree(node.children, childFolder);
        });
      };
      resolveTree(raw.tree, manifestFile.parent);
      const logicalItems = /* @__PURE__ */ new Map();
      const rootPath = ((_a = manifestFile.parent) == null ? void 0 : _a.path) || "";
      const prefix = rootPath ? `${rootPath}/` : "";
      all.forEach((item) => {
        if (!(item instanceof import_obsidian.TFolder || item instanceof import_obsidian.TFile)) return;
        if (item === manifestFile || item.path === rootPath) return;
        if (prefix && !item.path.startsWith(prefix)) return;
        const guid = this.getItemGuidSync(item);
        if (!guid) return;
        let logicalItem = item;
        if (item instanceof import_obsidian.TFile && isMarkdown(item)) {
          const ownFolder = item.parent && item.basename === item.parent.name ? item.parent : null;
          logicalItem = ownFolder || this.findFolderForNote(item) || item;
        }
        logicalItems.set(logicalItem.path, logicalItem);
      });
      const actualEntries = [...logicalItems.values()].map((item) => {
        const originalGuid = this.getItemGuidSync(item) || `path:${item.path}`;
        const guid = folderAliases.get(item.path) || originalGuid;
        const parent = item.parent;
        const parentGuid = !parent || parent.path === rootPath ? ROOT_FOLDER_KEY : folderAliases.get(parent.path) || this.getItemGuidSync(parent) || `path:${parent.path}`;
        return { guid, parentGuid, label: item.path };
      });
      const comparison = compareInventories(manifestEntries, actualEntries);
      report.missing.push(...comparison.missing);
      report.extra.push(...comparison.extra);
      report.moved.push(...comparison.moved);
      report.duplicateManifestGuids.push(...comparison.duplicateManifestGuids);
      report.duplicateActualGuids.push(...comparison.duplicateActualGuids);
    }
    return report;
  }
  async seedFromManifests() {
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      new import_obsidian.Notice("\u672A\u627E\u5230 _yuque_order.json");
      return;
    }
    const all = this.app.vault.getAllLoadedFiles();
    const byGuid = /* @__PURE__ */ new Map();
    const folderByGuid = /* @__PURE__ */ new Map();
    all.forEach((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return;
      if (item instanceof import_obsidian.TFolder) folderByGuid.set(guid, item);
      else if (item instanceof import_obsidian.TFile) byGuid.set(guid, item);
    });
    let seeded = 0;
    const adoptedFolderPaths = /* @__PURE__ */ new Set();
    for (const manifestFile of manifests) {
      let raw;
      let text;
      try {
        text = await this.app.vault.read(manifestFile);
        raw = JSON.parse(text);
      } catch (e) {
        continue;
      }
      if ((raw == null ? void 0 : raw.version) !== 1 || !Array.isArray(raw.tree)) continue;
      const manifestGuids = [];
      const collectGuids = (nodes) => nodes.forEach((node) => {
        const guid = normalizeGuid(node == null ? void 0 : node.guid);
        if (guid) manifestGuids.push(guid);
        if (Array.isArray(node == null ? void 0 : node.children)) collectGuids(node.children);
      });
      collectGuids(raw.tree);
      const desired = /* @__PURE__ */ new Map();
      const append = (key2, guid) => {
        const list = desired.get(key2) || [];
        if (!list.includes(guid)) list.push(guid);
        desired.set(key2, list);
      };
      const visit = (nodes, fallbackFolder) => {
        nodes.forEach((node) => {
          const guid = normalizeGuid(node == null ? void 0 : node.guid);
          if (!guid) return;
          const item = byGuid.get(guid) || folderByGuid.get(guid) || null;
          if (!item) {
            const folder = this.matchManifestNodeToFolder(
              fallbackFolder,
              node,
              adoptedFolderPaths,
              new Set(manifestGuids)
            );
            if (folder) {
              this.data.folderGuids[folder.path] = guid;
              folderByGuid.set(guid, folder);
              const parentFolder2 = folder.parent || fallbackFolder;
              const key3 = this.folderKeySync(parentFolder2);
              append(key3, guid);
              if (Array.isArray(node.children) && node.children.length) visit(node.children, folder);
              return;
            }
            if (Array.isArray(node.children) && node.children.length) visit(node.children, fallbackFolder);
            return;
          }
          const logicalItem = folderByGuid.get(guid) || (item instanceof import_obsidian.TFile ? this.findFolderForNote(item) : null) || item;
          const parentFolder = logicalItem.parent || fallbackFolder;
          const key2 = this.folderKeySync(parentFolder);
          append(key2, guid);
          const childFolder = logicalItem instanceof import_obsidian.TFolder ? logicalItem : parentFolder;
          if (Array.isArray(node.children) && node.children.length) visit(node.children, childFolder);
        });
      };
      visit(raw.tree, manifestFile.parent);
      const manifestGuidSet = new Set(manifestGuids);
      Object.keys(this.data.orderByFolder).forEach((key2) => {
        this.data.orderByFolder[key2] = (this.data.orderByFolder[key2] || []).filter((guid) => !manifestGuidSet.has(guid));
      });
      desired.forEach((wanted, key2) => {
        const old = this.data.orderByFolder[key2] || [];
        const next = [...wanted, ...old];
        this.data.orderByFolder[key2] = next;
        if (next.length !== old.length || next.some((guid, index) => guid !== old[index])) {
          seeded += 1;
        }
      });
    }
    if (seeded) {
      await this.forceSave();
      this.refreshExplorer();
      new import_obsidian.Notice("\u5DF2\u4ECE\u8BED\u96C0\u6E05\u5355\u5BFC\u5165\u987A\u5E8F");
    } else {
      if (!this.manifestNoticeShown) {
        this.manifestNoticeShown = true;
        new import_obsidian.Notice("\u987A\u5E8F\u6E05\u5355\u6CA1\u6709\u53EF\u5339\u914D\u7684\u6587\u6863\uFF0C\u5DF2\u4FDD\u7559\u73B0\u6709\u987A\u5E8F");
      }
    }
  }
  findFolderForNote(file) {
    if (file.parent && file.basename === file.parent.name) return file.parent;
    const folder = this.app.vault.getAbstractFileByPath(stripMarkdown(file.path));
    return folder instanceof import_obsidian.TFolder ? folder : null;
  }
  /**
   * V1 规则 2 兜底：为空正文父级文档（只有目录、无同名笔记）按目录名匹配 manifest 节点。
   * 候选名 = sanitize(title) 精确名，其后顺带尝试 title-N（导出端同名去重后的形式）。
   * 同名组内"首个保留原名"由扫描顺序复现（manifest 前序遍历顺序 = 语雀目录序）。
   */
  matchManifestNodeToFolder(fallbackFolder, node, adoptedFolderPaths, manifestGuidSet) {
    const base = sanitizePortableName(node == null ? void 0 : node.title);
    if (!base) return null;
    const scope = fallbackFolder ? fallbackFolder.children : this.app.vault.getRoot().children;
    const parentFolders = scope.filter((child) => child instanceof import_obsidian.TFolder);
    const candidates = [base];
    for (let n = 1; n <= 64; n += 1) candidates.push(`${base}-${n}`);
    for (const name of candidates) {
      const folder = parentFolders.find((f) => f.name === name);
      if (!folder) continue;
      if (adoptedFolderPaths.has(folder.path)) continue;
      const existingGuid = this.data.folderGuids[folder.path];
      if (existingGuid && manifestGuidSet.has(existingGuid)) continue;
      adoptedFolderPaths.add(folder.path);
      return folder;
    }
    return null;
  }
  patchFileExplorer() {
    var _a;
    const view = (_a = this.app.workspace.getLeavesOfType("file-explorer")[0]) == null ? void 0 : _a.view;
    if (!view || this.restoreExplorerPatch) return;
    this.explorerView = view;
    try {
      const prototype = Object.getPrototypeOf(view);
      if (!prototype || typeof prototype.getSortedFolderItems !== "function") {
        throw new Error("FileExplorerView.getSortedFolderItems unavailable");
      }
      const original = prototype.getSortedFolderItems;
      const plugin = this;
      prototype.getSortedFolderItems = function(folder, ...args) {
        const result = original.call(this, folder, ...args);
        if (!Array.isArray(result)) return result;
        try {
          const files = result.map((entry) => (entry == null ? void 0 : entry.file) || entry);
          const sortedFiles = plugin.sortFolderItems((folder == null ? void 0 : folder.path) || "", files);
          const itemsByPath = /* @__PURE__ */ new Map();
          result.forEach((entry) => {
            const file = (entry == null ? void 0 : entry.file) || entry;
            if (file == null ? void 0 : file.path) itemsByPath.set(file.path, entry);
          });
          return sortedFiles.map((file) => itemsByPath.get(file.path)).filter((entry) => Boolean(entry));
        } catch (e) {
          return result;
        }
      };
      this.restoreExplorerPatch = () => {
        prototype.getSortedFolderItems = original;
      };
      this.explorerPatchActive = true;
    } catch (error) {
      if (!this.manifestNoticeShown) {
        this.manifestNoticeShown = true;
        console.warn("[Yuque Sorting] FileExplorer patch unavailable; using default order.", error);
      }
    }
  }
  setupExplorer() {
    var _a, _b;
    const view = (_a = this.app.workspace.getLeavesOfType("file-explorer")[0]) == null ? void 0 : _a.view;
    const container = (view == null ? void 0 : view.containerEl) || document.querySelector(".nav-files-container");
    if (!view || !container) {
      if (this.explorerWaitObserver) return;
      this.explorerWaitObserver = new MutationObserver(() => {
        var _a2, _b2;
        if (!((_a2 = this.app.workspace.getLeavesOfType("file-explorer")[0]) == null ? void 0 : _a2.view)) return;
        (_b2 = this.explorerWaitObserver) == null ? void 0 : _b2.disconnect();
        this.explorerWaitObserver = null;
        this.setupExplorer();
      });
      this.explorerWaitObserver.observe(document.body, { childList: true, subtree: true });
      return;
    }
    (_b = this.explorerWaitObserver) == null ? void 0 : _b.disconnect();
    this.explorerWaitObserver = null;
    const explorerChanged = this.explorerView !== view || this.explorerContainer !== container;
    this.explorerView = view;
    this.patchFileExplorer();
    if (!this.explorerSetup) {
      this.explorerSetup = true;
      this.installDragHandlers();
    } else {
      this.observeExplorerContainer(container);
    }
    if (explorerChanged) this.refreshExplorer();
  }
  getExplorerContainer() {
    var _a;
    return ((_a = this.explorerView) == null ? void 0 : _a.containerEl) || document.querySelector(".nav-files-container");
  }
  explorerItem(target) {
    const element = target instanceof HTMLElement ? target.closest(".nav-file, .nav-folder") : null;
    if (!element) return null;
    const container = this.getExplorerContainer();
    return (container == null ? void 0 : container.contains(element)) ? element : null;
  }
  pathFromElement(element) {
    const directPath = element.dataset.path || element.getAttribute("data-path");
    if (directPath) return directPath;
    const title = element.querySelector(
      ":scope > .nav-file-title, :scope > .nav-folder-title, :scope > [data-path]"
    );
    return (title == null ? void 0 : title.dataset.path) || (title == null ? void 0 : title.getAttribute("data-path")) || "";
  }
  dropSurface(element) {
    return element.querySelector(
      ":scope > .nav-file-title, :scope > .nav-folder-title"
    ) || element;
  }
  canNestDrop(source, target) {
    if (target instanceof import_obsidian.TFolder) {
      return target !== source && !target.path.startsWith(`${source.path}/`);
    }
    return source instanceof import_obsidian.TFile && isMarkdown(target);
  }
  dropPosition(sourcePath, targetPath, clientY, targetEl) {
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    const surface = this.dropSurface(targetEl);
    const rect = surface.getBoundingClientRect();
    return dropPositionForPointer(
      clientY,
      rect.top,
      rect.height,
      Boolean(source && target && this.canNestDrop(source, target))
    );
  }
  showDropFeedback(targetEl, position, clientX, clientY) {
    var _a;
    const targetChanged = this.dropTargetEl !== targetEl || this.dropTargetPosition !== position;
    if (targetChanged) {
      this.clearDropTargets();
      this.dropTargetEl = targetEl;
      this.dropTargetPosition = position;
      targetEl.classList.add(`yq-order-drop-${position}`);
    }
    if (!this.dragHintEl) {
      this.dragHintEl = document.createElement("div");
      this.dragHintEl.className = "yq-order-drag-hint";
      document.body.appendChild(this.dragHintEl);
    }
    if (targetChanged || !this.dragHintEl.textContent) {
      const targetName = ((_a = this.dropSurface(targetEl).textContent) == null ? void 0 : _a.trim()) || this.pathFromElement(targetEl);
      const action = position === "before" ? "\u63D2\u5165\u5230\u4E0A\u65B9" : position === "after" ? "\u63D2\u5165\u5230\u4E0B\u65B9" : "\u79FB\u5165";
      this.dragHintEl.textContent = `${action}\uFF1A${targetName}`;
      const hintRect = this.dragHintEl.getBoundingClientRect();
      this.dragHintWidth = hintRect.width;
      this.dragHintHeight = hintRect.height;
    }
    const left = Math.max(8, Math.min(clientX + 14, window.innerWidth - this.dragHintWidth - 8));
    const below = clientY + 18;
    const top = below + this.dragHintHeight <= window.innerHeight - 8 ? below : Math.max(8, clientY - this.dragHintHeight - 14);
    this.dragHintEl.style.left = `${left}px`;
    this.dragHintEl.style.top = `${top}px`;
  }
  clearDropTargets() {
    var _a;
    (_a = this.dropTargetEl) == null ? void 0 : _a.classList.remove(
      "yq-order-drop-before",
      "yq-order-drop-inside",
      "yq-order-drop-after"
    );
    this.dropTargetEl = null;
    this.dropTargetPosition = null;
  }
  clearDropFeedback() {
    var _a;
    this.clearDropTargets();
    (_a = this.dragHintEl) == null ? void 0 : _a.remove();
    this.dragHintEl = null;
    this.dragHintWidth = 0;
    this.dragHintHeight = 0;
  }
  installDragHandlers() {
    const explorerContainer = this.getExplorerContainer() || void 0;
    if (explorerContainer) this.observeExplorerContainer(explorerContainer);
    this.registerDomEvent(document, "dragstart", (event) => {
      if (!this.data.settings.enableDrag) return;
      const item = this.explorerItem(event.target);
      const path = item && this.pathFromElement(item);
      if (!path || !event.dataTransfer) return;
      event.stopImmediatePropagation();
      if (this.dropInProgress || this.undoInProgress) {
        event.preventDefault();
        return;
      }
      this.dragSourcePath = path;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-yq-order-path", path);
      event.dataTransfer.setData("text/plain", path);
      item.classList.add("yq-order-drag-source");
    }, true);
    this.registerDomEvent(document, "dragover", (event) => {
      if (!this.dragSourcePath) return;
      event.stopImmediatePropagation();
      const item = this.explorerItem(event.target);
      if (!item || this.pathFromElement(item) === this.dragSourcePath) {
        this.clearDropFeedback();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const position = this.dropPosition(
        this.dragSourcePath,
        this.pathFromElement(item),
        event.clientY,
        item
      );
      this.showDropFeedback(item, position, event.clientX, event.clientY);
    }, true);
    this.registerDomEvent(document, "drop", (event) => {
      if (!this.dragSourcePath) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = this.explorerItem(event.target);
      if (!target) {
        this.clearDragState();
        return;
      }
      event.preventDefault();
      const targetPath = this.pathFromElement(target);
      const position = this.dropPosition(this.dragSourcePath, targetPath, event.clientY, target);
      void this.handleDrop(this.dragSourcePath, targetPath, position).catch((error) => {
        new import_obsidian.Notice(`\u62D6\u62FD\u672A\u5B8C\u6210\uFF1A${String(error)}\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6811\u548C\u6392\u5E8F\u6570\u636E`, 12e3);
      });
      this.clearDragState();
    }, true);
    this.registerDomEvent(document, "dragend", () => this.clearDragState(), true);
  }
  observeExplorerContainer(container) {
    var _a;
    if (this.explorerContainer === container && this.explorerObserver) return;
    (_a = this.explorerObserver) == null ? void 0 : _a.disconnect();
    this.explorerContainer = container;
    const markDraggable = (root) => {
      if (root instanceof HTMLElement && root.matches(".nav-file, .nav-folder")) {
        root.setAttribute("draggable", "true");
      }
      root.querySelectorAll(".nav-file, .nav-folder").forEach((element) => element.setAttribute("draggable", "true"));
    };
    markDraggable(container);
    this.explorerObserver = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) markDraggable(node);
      }));
      this.scheduleDomOrder();
      this.scheduleFolderNoteRender();
    });
    this.explorerObserver.observe(container, { childList: true, subtree: true });
    this.scheduleDomOrder();
    this.scheduleFolderNoteRender();
  }
  clearDragState() {
    var _a;
    this.dragSourcePath = "";
    (_a = this.getExplorerContainer()) == null ? void 0 : _a.querySelectorAll(".yq-order-drag-source").forEach((el) => el.classList.remove("yq-order-drag-source"));
    this.clearDropFeedback();
  }
  rememberDragUndo(record) {
    this.dragUndoStack.push(record);
    if (this.dragUndoStack.length > 50) this.dragUndoStack.shift();
    this.lastDragUndo = record;
  }
  async rollbackFolderNoteConversion(createdFolderPath, targetNoteOriginalPath, targetNoteMovedPath, targetNotePosition) {
    if (!createdFolderPath || !targetNoteOriginalPath || !targetNoteMovedPath) return true;
    try {
      const movedTarget = this.app.vault.getAbstractFileByPath(targetNoteMovedPath);
      if (movedTarget instanceof import_obsidian.TFile && !this.app.vault.getAbstractFileByPath(targetNoteOriginalPath)) {
        if (targetNotePosition) this.pendingUndoPositions.set(targetNotePosition.guid, targetNotePosition);
        await this.renameTracked(movedTarget, targetNoteOriginalPath);
      }
      const createdFolder = this.app.vault.getAbstractFileByPath(createdFolderPath);
      if (createdFolder instanceof import_obsidian.TFolder) {
        if (createdFolder.children.length) return false;
        await this.app.vault.delete(createdFolder, true);
      }
      if (targetNotePosition) this.restoreStoredGuidPosition(targetNotePosition);
      this.queueSave(true);
      await this.flushSave();
      return true;
    } catch (e) {
      return false;
    } finally {
      if (targetNotePosition) {
        window.setTimeout(() => this.pendingUndoPositions.delete(targetNotePosition.guid), 1e3);
      }
    }
  }
  async undoLastDrag() {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    const record = this.dragUndoStack.length ? this.dragUndoStack[this.dragUndoStack.length - 1] : this.lastDragUndo;
    if (!record || this.undoInProgress) return;
    const source = this.app.vault.getAbstractFileByPath(record.sourceMovedPath);
    if (!source || this.getItemGuidSync(source) !== record.sourceGuid) {
      this.dragUndoStack.pop();
      this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
      new import_obsidian.Notice("\u65E0\u6CD5\u64A4\u9500\uFF1A\u88AB\u62D6\u9879\u76EE\u5DF2\u88AB\u79FB\u52A8\u3001\u91CD\u547D\u540D\u6216\u5220\u9664");
      return;
    }
    const sourceAtOriginal = this.app.vault.getAbstractFileByPath(record.sourceOriginalPath);
    if (record.sourceMovedPath !== record.sourceOriginalPath && sourceAtOriginal) {
      new import_obsidian.Notice("\u65E0\u6CD5\u64A4\u9500\uFF1A\u539F\u4F4D\u7F6E\u5DF2\u5B58\u5728\u540C\u540D\u9879\u76EE");
      return;
    }
    const targetNote = record.targetNoteMovedPath ? this.app.vault.getAbstractFileByPath(record.targetNoteMovedPath) : null;
    if (record.targetNoteMovedPath && (!(targetNote instanceof import_obsidian.TFile) || this.getItemGuidSync(targetNote) !== record.targetNoteGuid)) {
      this.dragUndoStack.pop();
      this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
      new import_obsidian.Notice("\u65E0\u6CD5\u64A4\u9500\uFF1A\u76EE\u6807\u6587\u4EF6\u5939\u7B14\u8BB0\u5DF2\u88AB\u79FB\u52A8\u3001\u91CD\u547D\u540D\u6216\u5220\u9664");
      return;
    }
    if (record.targetNoteOriginalPath && this.app.vault.getAbstractFileByPath(record.targetNoteOriginalPath)) {
      new import_obsidian.Notice("\u65E0\u6CD5\u64A4\u9500\uFF1A\u76EE\u6807\u7B14\u8BB0\u7684\u539F\u4F4D\u7F6E\u5DF2\u5B58\u5728\u540C\u540D\u9879\u76EE");
      return;
    }
    if (record.createdFolderPath) {
      const createdFolder = this.app.vault.getAbstractFileByPath(record.createdFolderPath);
      if (!(createdFolder instanceof import_obsidian.TFolder)) {
        this.dragUndoStack.pop();
        this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
        new import_obsidian.Notice("\u65E0\u6CD5\u64A4\u9500\uFF1A\u62D6\u62FD\u521B\u5EFA\u7684\u6587\u4EF6\u5939\u5DF2\u4E0D\u5B58\u5728");
        return;
      }
      const expectedPaths = new Set([record.sourceMovedPath, record.targetNoteMovedPath].filter(Boolean));
      if (createdFolder.children.some((child) => !expectedPaths.has(child.path))) {
        new import_obsidian.Notice("\u65E0\u6CD5\u64A4\u9500\uFF1A\u62D6\u62FD\u521B\u5EFA\u7684\u6587\u4EF6\u5939\u4E2D\u5DF2\u6709\u5176\u4ED6\u9879\u76EE");
        return;
      }
    }
    this.undoInProgress = true;
    this.dragUndoStack.pop();
    this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
    const currentPosition = this.captureItemPosition(source, record.sourceGuid);
    let sourceRestored = false;
    try {
      if (record.sourceMovedPath !== record.sourceOriginalPath) {
        this.pendingUndoPositions.set(record.sourceGuid, record.sourcePosition);
        await this.renameTracked(source, record.sourceOriginalPath);
        sourceRestored = true;
      }
      this.restoreStoredGuidPosition(record.sourcePosition);
      if (targetNote instanceof import_obsidian.TFile && record.targetNoteOriginalPath && record.targetNotePosition) {
        this.pendingUndoPositions.set(record.targetNotePosition.guid, record.targetNotePosition);
        await this.renameTracked(targetNote, record.targetNoteOriginalPath);
        this.restoreStoredGuidPosition(record.targetNotePosition);
      }
      if (record.createdFolderPath) {
        const createdFolder = this.app.vault.getAbstractFileByPath(record.createdFolderPath);
        if (createdFolder instanceof import_obsidian.TFolder) {
          if (createdFolder.children.length) throw new Error("\u521B\u5EFA\u7684\u6587\u4EF6\u5939\u4E0D\u662F\u7A7A\u6587\u4EF6\u5939");
          await this.app.vault.delete(createdFolder, true);
        }
        this.restoreStoredGuidPosition(record.sourcePosition);
        if (record.targetNotePosition) this.restoreStoredGuidPosition(record.targetNotePosition);
      }
      this.queueSave(true);
      await this.flushSave();
      this.refreshExplorer();
      new import_obsidian.Notice("\u5DF2\u64A4\u9500\u4E0A\u4E00\u6B21\u8BED\u96C0\u62D6\u62FD");
    } catch (error) {
      if (sourceRestored) {
        const restoredSource = this.app.vault.getAbstractFileByPath(record.sourceOriginalPath);
        if (restoredSource && !this.app.vault.getAbstractFileByPath(record.sourceMovedPath)) {
          try {
            await this.renameTracked(restoredSource, record.sourceMovedPath);
            this.restoreStoredGuidPosition(currentPosition);
          } catch (e) {
          }
        }
      }
      this.dragUndoStack.push(record);
      this.lastDragUndo = record;
      new import_obsidian.Notice(`\u64A4\u9500\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.undoInProgress = false;
      window.setTimeout(() => {
        this.pendingUndoPositions.delete(record.sourceGuid);
        if (record.targetNoteGuid) this.pendingUndoPositions.delete(record.targetNoteGuid);
      }, 1e3);
    }
  }
  async handleDrop(sourcePath, targetPath, position) {
    var _a, _b;
    if (this.transferInProgress) return;
    if (this.dropInProgress || this.undoInProgress) return;
    this.dropInProgress = true;
    try {
      if ((_b = (_a = this.app) == null ? void 0 : _a.vault) == null ? void 0 : _b.adapter) await this.checkExternalOrderData();
      if (this.storageState !== "ready") {
        new import_obsidian.Notice("\u6392\u5E8F\u6570\u636E\u6B63\u5728\u7B49\u5F85\u540C\u6B65\u6216\u5904\u7406\u51B2\u7A81\uFF0C\u6682\u4E0D\u80FD\u62D6\u62FD\u6392\u5E8F", 1e4);
        return;
      }
      await this.executeDrop(sourcePath, targetPath, position);
    } finally {
      this.dropInProgress = false;
    }
  }
  async executeDrop(sourcePath, targetPath, position) {
    var _a;
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!source || !target || source.path === target.path) return;
    const initialSourceGuid = this.getItemGuidSync(source);
    if (!initialSourceGuid) return;
    const sourceOriginalPath = source.path;
    const sourcePosition = this.captureItemPosition(source, initialSourceGuid);
    let createdFolderPath = null;
    let targetNoteOriginalPath = null;
    let targetNoteMovedPath = null;
    let targetNoteGuid = null;
    let targetNotePosition = null;
    let targetFolder = position === "inside" && target instanceof import_obsidian.TFolder ? target : position === "inside" && target instanceof import_obsidian.TFile ? this.findFolderForNote(target) : null;
    if (!targetFolder && position === "inside" && target instanceof import_obsidian.TFile && isMarkdown(target)) {
      if (source instanceof import_obsidian.TFolder) return;
      const folderPath = stripMarkdown(target.path);
      const prospectiveDestination = `${folderPath}/${basename(source.path)}`;
      if (basename(source.path) === target.name || this.app.vault.getAbstractFileByPath(prospectiveDestination)) {
        new import_obsidian.Notice("\u76EE\u6807\u6587\u4EF6\u5939\u4E2D\u5DF2\u5B58\u5728\u540C\u540D\u6587\u4EF6");
        return;
      }
      targetNoteGuid = this.getItemGuidSync(target);
      if (!targetNoteGuid) return;
      targetNoteOriginalPath = target.path;
      targetNoteMovedPath = `${folderPath}/${target.name}`;
      targetNotePosition = this.captureItemPosition(target, targetNoteGuid);
      try {
        targetFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(targetFolder instanceof import_obsidian.TFolder)) {
          targetFolder = await this.app.vault.createFolder(folderPath);
          createdFolderPath = folderPath;
        }
        await this.ensureFolderGuid(targetFolder);
        await this.renameTracked(target, targetNoteMovedPath);
        const folderGuid = this.getItemGuidSync(targetFolder);
        if (folderGuid && targetNotePosition) {
          this.restoreStoredGuidPosition({ ...targetNotePosition, guid: folderGuid });
        }
      } catch (error) {
        const restored = await this.rollbackFolderNoteConversion(
          createdFolderPath,
          targetNoteOriginalPath,
          targetNoteMovedPath,
          targetNotePosition
        );
        if (!restored) new import_obsidian.Notice("\u521B\u5EFA\u5931\u8D25\uFF0C\u4E14\u672A\u80FD\u5B8C\u5168\u6062\u590D\u76EE\u6807\u6587\u4EF6\u5939\u7B14\u8BB0\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6811");
        new import_obsidian.Notice(`\u521B\u5EFA\u7236\u6587\u6863\u6587\u4EF6\u5939\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (targetFolder) {
      const destination = `${targetFolder.path}/${basename(source.path)}`;
      const sourceGuid2 = initialSourceGuid;
      const blocked = moveBlockReason(
        source.path,
        source instanceof import_obsidian.TFolder,
        targetFolder.path,
        Boolean(this.app.vault.getAbstractFileByPath(destination))
      );
      if (blocked === "self-or-descendant") {
        new import_obsidian.Notice("\u4E0D\u80FD\u628A\u6587\u4EF6\u5939\u79FB\u52A8\u5230\u5B83\u81EA\u5DF1\u7684\u5B50\u76EE\u5F55\u4E2D");
        return;
      }
      if (blocked === "conflict") {
        new import_obsidian.Notice("\u76EE\u6807\u6587\u4EF6\u5939\u4E2D\u5DF2\u5B58\u5728\u540C\u540D\u6587\u4EF6");
        return;
      }
      try {
        await this.renameTracked(source, destination);
      } catch (error) {
        const restored = await this.rollbackFolderNoteConversion(
          createdFolderPath,
          targetNoteOriginalPath,
          targetNoteMovedPath,
          targetNotePosition
        );
        if (!restored) new import_obsidian.Notice("\u79FB\u52A8\u5931\u8D25\uFF0C\u4E14\u672A\u80FD\u5B8C\u5168\u6062\u590D\u76EE\u6807\u6587\u4EF6\u5939\u7B14\u8BB0\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6811");
        new import_obsidian.Notice(`\u79FB\u52A8\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (sourceGuid2 && this.folderKeySync(targetFolder) !== sourceGuid2) {
        relocateGuid(
          this.data.orderByFolder,
          this.folderKeySync(targetFolder),
          sourceGuid2,
          this.data.settings.newItemPlacement
        );
      }
      this.queueSave(true);
      await this.flushSave();
      this.refreshExplorer();
      this.rememberDragUndo({
        sourceGuid: sourceGuid2,
        sourceOriginalPath,
        sourceMovedPath: destination,
        sourcePosition,
        createdFolderPath,
        targetNoteGuid,
        targetNoteOriginalPath,
        targetNoteMovedPath,
        targetNotePosition
      });
      return;
    }
    const sourceGuid = initialSourceGuid;
    const targetGuid = this.getItemGuidSync(target);
    if (!sourceGuid || !targetGuid || !source.parent || !target.parent) return;
    if (source.parent.path !== target.parent.path) {
      const destination = target.parent.path ? `${target.parent.path}/${basename(source.path)}` : basename(source.path);
      const blocked = moveBlockReason(
        source.path,
        source instanceof import_obsidian.TFolder,
        target.parent.path,
        Boolean(this.app.vault.getAbstractFileByPath(destination))
      );
      if (blocked === "self-or-descendant") {
        new import_obsidian.Notice("\u4E0D\u80FD\u628A\u6587\u4EF6\u5939\u79FB\u52A8\u5230\u5B83\u81EA\u5DF1\u7684\u5B50\u76EE\u5F55\u4E2D");
        return;
      }
      if (blocked === "conflict") {
        new import_obsidian.Notice("\u76EE\u6807\u76EE\u5F55\u4E2D\u5DF2\u5B58\u5728\u540C\u540D\u6587\u4EF6");
        return;
      }
      this.pendingDropPlacements.set(sourceGuid, {
        parentPath: target.parent.path,
        targetGuid,
        before: position === "before"
      });
      try {
        await this.renameTracked(source, destination);
      } catch (error) {
        this.pendingDropPlacements.delete(sourceGuid);
        new import_obsidian.Notice(`\u79FB\u52A8\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.placeGuidRelative(target.parent, sourceGuid, this.getItemGuidSync(target) || targetGuid, position === "before");
      this.queueSave(true);
      await this.flushSave();
      window.setTimeout(() => this.pendingDropPlacements.delete(sourceGuid), 1e3);
      this.refreshExplorer();
      this.rememberDragUndo({
        sourceGuid,
        sourceOriginalPath,
        sourceMovedPath: destination,
        sourcePosition,
        createdFolderPath: null,
        targetNoteGuid: null,
        targetNoteOriginalPath: null,
        targetNoteMovedPath: null,
        targetNotePosition: null
      });
      return;
    }
    const key2 = this.folderKeySync(source.parent);
    const fallbackOrder = source.parent.children.filter((child) => child instanceof import_obsidian.TFolder || child instanceof import_obsidian.TFile).map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    const currentOrder = ((_a = this.data.orderByFolder[key2]) == null ? void 0 : _a.length) ? this.data.orderByFolder[key2] : fallbackOrder;
    this.data.orderByFolder[key2] = moveGuid(currentOrder, sourceGuid, targetGuid, position === "before");
    this.queueSave(true);
    await this.flushSave();
    this.refreshExplorer();
    this.rememberDragUndo({
      sourceGuid,
      sourceOriginalPath,
      sourceMovedPath: sourceOriginalPath,
      sourcePosition,
      createdFolderPath: null,
      targetNoteGuid: null,
      targetNoteOriginalPath: null,
      targetNoteMovedPath: null,
      targetNotePosition: null
    });
  }
  refreshExplorer() {
    if (this.explorerRefreshFrame !== null) return;
    if (this.autoCopyScope) return;
    this.explorerRefreshFrame = window.requestAnimationFrame(() => {
      this.explorerRefreshFrame = null;
      this.performExplorerRefresh();
    });
  }
  performExplorerRefresh() {
    var _a;
    try {
      const view = this.explorerView;
      if (view) {
        if (typeof view.sort === "function") view.sort();
        else if (typeof view.requestSort === "function") view.requestSort();
        else (_a = view.rerender) == null ? void 0 : _a.call(view);
      }
      this.scheduleDomOrder();
      this.scheduleFolderNoteRender();
    } catch (e) {
    }
  }
  /**
   * V1 compatibility fallback for Obsidian releases whose private
   * FileExplorer Folder.sort implementation cannot be patched reliably.
   * The explorer DOM is public enough for this best-effort visual reorder,
   * while all authoritative order data remains in data.json.
   */
  scheduleDomOrder() {
    if (this.explorerPatchActive) return;
    if (this.domOrderFrame !== null) return;
    this.domOrderFrame = window.requestAnimationFrame(() => {
      this.domOrderFrame = null;
      this.applyDomOrder();
    });
  }
  applyDomOrder() {
    const container = this.getExplorerContainer() || void 0;
    if (!container) return;
    const childrenContainers = Array.from(
      container.querySelectorAll(".nav-folder-children")
    );
    const rootItems = Array.from(container.children).filter((element) => element instanceof HTMLElement).filter((element) => element.matches(".nav-file, .nav-folder"));
    if (rootItems.length) this.reorderDomItems("", rootItems);
    childrenContainers.forEach((children) => {
      var _a;
      const parentFolder = (_a = children.parentElement) == null ? void 0 : _a.closest(".nav-folder");
      const folderPath = parentFolder ? this.pathFromElement(parentFolder) : "";
      const items = Array.from(children.children).filter((element) => element instanceof HTMLElement).filter((element) => element.matches(".nav-file, .nav-folder"));
      if (items.length) this.reorderDomItems(folderPath, items);
    });
  }
  reorderDomItems(folderPath, elements) {
    const files = elements.map((element) => this.app.vault.getAbstractFileByPath(this.pathFromElement(element))).filter((file) => Boolean(file));
    if (files.length !== elements.length) return;
    const sorted = this.sortFolderItems(folderPath, files);
    const desiredPaths = sorted.map((file) => file.path);
    const currentPaths = elements.map((element) => this.pathFromElement(element));
    if (desiredPaths.length !== currentPaths.length || desiredPaths.some((path, index) => path !== currentPaths[index])) {
      const elementsByPath = new Map(elements.map((element) => [this.pathFromElement(element), element]));
      desiredPaths.forEach((path) => {
        var _a;
        const element = elementsByPath.get(path);
        if (element) (_a = element.parentElement) == null ? void 0 : _a.appendChild(element);
      });
    }
  }
};
var YqOrderSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  /** 给设置项加一个"?"按钮，点击后显示完整说明。 */
  addDetails(setting, title, paragraphs) {
    setting.addExtraButton((button) => button.setIcon("help").setTooltip("\u67E5\u770B\u8BE6\u7EC6\u8BF4\u660E").onClick(() => new SettingDetailsModal(this.app, title, paragraphs).open()));
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Yuque Sorting" });
    const section = (text) => {
      new import_obsidian.Setting(containerEl).setName(text).setHeading();
    };
    const storageStatus = this.plugin.getOrderDataStatus();
    if (storageStatus !== "ready") {
      section("\u540C\u6B65\u6570\u636E\u72B6\u6001");
      new import_obsidian.Setting(containerEl).setName(storageStatus === "waiting" ? "\u7B49\u5F85\u6392\u5E8F\u6570\u636E" : "\u6392\u5E8F\u6570\u636E\u5DF2\u6682\u505C\u5199\u5165").setDesc(storageStatus === "waiting" ? "\u5148\u5B8C\u6210\u4E91\u7AEF\u540C\u6B65\uFF1B\u5982\u679C\u8FD9\u662F\u5168\u65B0\u5E93\u4E14\u4E91\u7AEF\u6CA1\u6709\u6392\u5E8F\u6570\u636E\uFF0C\u518D\u624B\u52A8\u521D\u59CB\u5316\u3002" : "\u78C1\u76D8\u6570\u636E\u7F3A\u5931\u3001\u635F\u574F\u6216\u4E0E\u672C\u5730\u6539\u52A8\u51B2\u7A81\u3002\u5904\u7406\u524D\u4E0D\u4F1A\u7528\u5185\u5B58\u6570\u636E\u8986\u76D6\u78C1\u76D8\u3002").addButton((button) => button.setButtonText("\u68C0\u67E5\u540C\u6B65\u6570\u636E").onClick(() => void this.plugin.checkExternalOrderData(true).then(() => this.display()))).addButton((button) => button.setButtonText(storageStatus === "waiting" ? "\u521D\u59CB\u5316\u672C\u5730\u987A\u5E8F" : "\u5904\u7406\u51B2\u7A81\u6216\u6062\u590D").onClick(() => {
        if (storageStatus === "waiting") void this.plugin.initializeLocalOrderData().then(() => this.display());
        else this.plugin.openOrderDataResolution();
      }));
      return;
    }
    section("\u6392\u5E8F\u89C4\u5219");
    new import_obsidian.Setting(containerEl).setName("\u65B0\u589E\u9879\u4F4D\u7F6E").setDesc("\u65B0\u5EFA Markdown \u6216\u6587\u4EF6\u5939\u52A0\u5165\u5F53\u524D\u76EE\u5F55\u65F6\u7684\u4F4D\u7F6E\u3002").addDropdown((dropdown) => dropdown.addOption("bottom", "\u5E95\u90E8").addOption("top", "\u9876\u90E8").setValue(this.plugin.data.settings.newItemPlacement).onChange(async (value) => {
      this.plugin.data.settings.newItemPlacement = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u672A\u8BB0\u5F55\u9879\u515C\u5E95\u6392\u5E8F").setDesc("\u987A\u5E8F\u5217\u8868\u91CC\u6CA1\u6709\u8BB0\u5F55\u7684\u9879\u76EE\u5982\u4F55\u6392\u5217\u3002").addDropdown((dropdown) => dropdown.addOption("name-last", "\u6309\u540D\u79F0\uFF0C\u6392\u5728\u672B\u5C3E").addOption("name", "\u6309\u540D\u79F0").setValue(this.plugin.data.settings.fallbackSort).onChange(async (value) => {
      this.plugin.data.settings.fallbackSort = value;
      await this.plugin.saveSettings();
      this.plugin.refreshExplorer();
    }));
    const persistSetting = new import_obsidian.Setting(containerEl).setName("\u589E\u5220\u540E\u7ACB\u5373\u4FDD\u5B58\u987A\u5E8F").setDesc("\u65B0\u5EFA\u3001\u5220\u9664\u6216\u6539\u540D\u540E\u662F\u5426\u7ACB\u5373\u628A\u987A\u5E8F\u5199\u5165\u63D2\u4EF6\u6570\u636E\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.persistOrderOnCreateDelete).onChange(async (value) => {
      this.plugin.data.settings.persistOrderOnCreateDelete = value;
      await this.plugin.saveSettings();
    }));
    this.addDetails(persistSetting, "\u589E\u5220\u540E\u7ACB\u5373\u4FDD\u5B58\u987A\u5E8F", [
      "\u5F00\u542F\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u6BCF\u6B21\u65B0\u5EFA\u3001\u5220\u9664\u3001\u6539\u540D\u6216\u79FB\u52A8\u540E\uFF0C\u63D2\u4EF6\u90FD\u4F1A\u628A\u6700\u65B0\u7684\u76EE\u5F55\u987A\u5E8F\u5199\u5165\u63D2\u4EF6\u6570\u636E data.json\u3002",
      "\u5173\u95ED\uFF1A\u8FD9\u4E9B\u64CD\u4F5C\u53EA\u6539\u52A8\u5185\u5B58\u91CC\u7684\u987A\u5E8F\uFF0C\u7B49\u4E0B\u4E00\u6B21\u5FC5\u987B\u4FDD\u5B58\u7684\u64CD\u4F5C\uFF08\u62D6\u62FD\u6392\u5E8F\u3001\u66F4\u6362\u6216\u4FEE\u590D GUID\u3001\u8DE8 Vault \u590D\u5236\u3001\u4FDD\u5B58\u8BBE\u7F6E\uFF09\u6216\u63D2\u4EF6\u5378\u8F7D\u65F6\u624D\u4E00\u8D77\u5199\u5165\u3002",
      "\u5173\u95ED\u53EF\u4EE5\u51CF\u5C11\u78C1\u76D8\u5199\u5165\uFF0C\u964D\u4F4E\u591A\u8BBE\u5907\u540C\u6B65\uFF08Obsidian Sync \u7B49\uFF09\u4EA7\u751F\u51B2\u7A81\u7684\u6982\u7387\uFF1B\u4EE3\u4EF7\u662F Obsidian \u5F02\u5E38\u9000\u51FA\u65F6\uFF0C\u81EA\u4E0A\u6B21\u4FDD\u5B58\u4EE5\u6765\u7684\u589E\u5220\u6539\u540D\u987A\u5E8F\u53EF\u80FD\u4E22\u5931\u3002",
      "\u62D6\u62FD\u6392\u5E8F\u4E0D\u53D7\u8FD9\u4E2A\u5F00\u5173\u5F71\u54CD\uFF0C\u59CB\u7EC8\u7ACB\u5373\u4FDD\u5B58\u3002"
    ]);
    section("\u6587\u4EF6\u6811\u4EA4\u4E92");
    const dragSetting = new import_obsidian.Setting(containerEl).setName("\u542F\u7528\u6587\u4EF6\u6811\u62D6\u62FD").setDesc("\u5F00\u542F\u540E\u53EF\u5728\u6587\u4EF6\u6811\u91CC\u62D6\u62FD\u8C03\u6574\u987A\u5E8F\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.enableDrag).onChange(async (value) => {
      this.plugin.data.settings.enableDrag = value;
      await this.plugin.saveSettings();
    }));
    this.addDetails(dragSetting, "\u542F\u7528\u6587\u4EF6\u6811\u62D6\u62FD", [
      "\u62D6\u5230\u6807\u9898\u884C\u7684\u4E0A 30% \u6216\u4E0B 30% \u53EF\u7CBE\u786E\u63D2\u5165\u5230\u76EE\u6807\u4E0A\u65B9\u6216\u4E0B\u65B9\uFF1B\u62D6\u5230\u4E2D\u95F4 40% \u53EF\u79FB\u5165\u6587\u4EF6\u5939\u6216\u6587\u4EF6\u5939\u7B14\u8BB0\u3002",
      "\u62D6\u52A8\u8FC7\u7A0B\u4E2D\u4F1A\u663E\u793A\u63D2\u5165\u7EBF\u548C\u52A8\u4F5C\u63D0\u793A\uFF0C\u677E\u624B\u540E\u7ACB\u5373\u751F\u6548\u3002",
      "\u521A\u5B8C\u6210\u7684\u62D6\u62FD\u53EF\u7528\u547D\u4EE4\u201C\u64A4\u9500\u4E0A\u4E00\u6B21\u8BED\u96C0\u62D6\u62FD\u201D\u8FD8\u539F\u3002"
    ]);
    const mergeSetting = new import_obsidian.Setting(containerEl).setName("\u5408\u5E76\u5C55\u793A\u914D\u5BF9\u6587\u4EF6\u5939\u7B14\u8BB0").setDesc("\u628A\u914D\u5BF9\u7684\u6587\u4EF6\u5939\u7B14\u8BB0\u5408\u5E76\u5230\u4E00\u884C\u663E\u793A\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.mergePairedFolderNotes).onChange(async (value) => {
      this.plugin.data.settings.mergePairedFolderNotes = value;
      await this.plugin.saveSettings();
      this.plugin.refreshExplorer();
    }));
    this.addDetails(mergeSetting, "\u5408\u5E76\u5C55\u793A\u914D\u5BF9\u6587\u4EF6\u5939\u7B14\u8BB0", [
      "\u4EC5\u5339\u914D\u4F4D\u4E8E\u540C\u540D\u6587\u4EF6\u5939\u5185\u3001\u4E14 f-/d- GUID \u540E\u7F00\u76F8\u540C\u7684 Markdown\u3002",
      "\u540D\u79F0\u65C1\u7684 \u2197 \u8868\u793A\u5DF2\u5408\u5E76\uFF0C\u70B9\u51FB\u6807\u9898\u6253\u5F00\u6587\u6863\u3002"
    ]);
    section("\u8BED\u96C0\u6E05\u5355");
    const restoreSetting = new import_obsidian.Setting(containerEl).setName("\u6062\u590D\u539F\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F").setDesc("\u6309\u8BED\u96C0\u5BFC\u51FA\u6E05\u5355\u6062\u590D\u76EE\u5F55\u987A\u5E8F\uFF1B\u53EA\u6309\u8DEF\u5F84\u5339\u914D\uFF0C\u4E0D\u6539\u52A8\u6587\u4EF6\u4E0E GUID\u3002").addButton((button) => button.setButtonText("\u6062\u590D\u539F\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F").onClick(() => void this.plugin.requestManifestImport()));
    this.addDetails(restoreSetting, "\u6062\u590D\u539F\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F", [
      "\u8BFB\u53D6\u5E93\u91CC\u7684 _yuque_order.json\uFF08\u8BED\u96C0\u5BFC\u51FA\u6E05\u5355\uFF09\uFF0C\u628A\u5404\u76EE\u5F55\u7684\u663E\u793A\u987A\u5E8F\u8C03\u56DE\u8BED\u96C0\u91CC\u7684\u539F\u987A\u5E8F\u3002",
      "\u9996\u6B21\u4F7F\u7528\u67D0\u4EFD\u6E05\u5355\u65F6\u4F1A\u4E00\u5E76\u91C7\u7528\u6E05\u5355\u91CC\u7684 GUID\uFF1B\u4E4B\u540E\u518D\u6B21\u6267\u884C\u53EA\u8C03\u987A\u5E8F\uFF0C\u4E0D\u6539\u52A8\u4F60\u540E\u6765\u66F4\u6362\u8FC7\u7684 GUID\u3002",
      "\u5339\u914D\u53EA\u770B\u6E05\u5355\u4E2D\u7684\u8DEF\u5F84\uFF0C\u4E0D\u770B\u6587\u4EF6\u5185\u5BB9\uFF1A\u5DF2\u6539\u540D\u6216\u79FB\u52A8\u8FC7\u7684\u9879\u76EE\u65E0\u6CD5\u6062\u590D\u539F\u987A\u5E8F\uFF08\u4F1A\u63D0\u793A\u7F3A\u5931/\u591A\u51FA\uFF09\uFF1B\u540C\u4E00\u8DEF\u5F84\u82E5\u5DF2\u6362\u6210\u53E6\u4E00\u4E2A\u6587\u4EF6\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u8BC6\u522B\uFF0C\u4F1A\u76F4\u63A5\u6309\u6E05\u5355\u4F4D\u7F6E\u6392\u5E8F\u3002",
      "\u4E0D\u4F1A\u65B0\u5EFA\u3001\u5220\u9664\u3001\u91CD\u547D\u540D\u6216\u79FB\u52A8\u6587\u4EF6\u3002\u53EA\u6709\u70B9\u6B64\u6309\u94AE\u6216\u547D\u4EE4\u624D\u4F1A\u6267\u884C\uFF0C\u542F\u52A8\u65F6\u7EDD\u4E0D\u81EA\u52A8\u5E94\u7528\u3002"
    ]);
    section("GUID \u7BA1\u7406");
    new import_obsidian.Setting(containerEl).setName("GUID \u968F\u673A\u4F4D\u6570").setDesc("\u65B0 GUID \u7684\u968F\u673A\u540E\u7F00\u957F\u5EA6\u3002").addDropdown((dropdown) => dropdown.addOption("64", "64 bit").addOption("72", "72 bit").setValue(String(this.plugin.data.settings.guidBits)).onChange(async (value) => {
      this.plugin.data.settings.guidBits = value === "72" ? 72 : 64;
      await this.plugin.saveSettings();
    }));
    const auditSetting = new import_obsidian.Setting(containerEl).setName("\u68C0\u6D4B\u672A\u7BA1\u7406\u9879\u76EE").setDesc("\u53EA\u8BFB\u626B\u63CF\u6574\u4E2A Vault\uFF0C\u786E\u8BA4\u540E\u4E3A\u672A\u7EB3\u5165\u7BA1\u7406\u7684\u9879\u76EE\u751F\u6210 GUID\u3002").addButton((button) => button.setButtonText("\u68C0\u6D4B\u5E76\u7EB3\u5165\u7BA1\u7406").onClick(() => void this.plugin.auditAndOfferManagement()));
    this.addDetails(auditSetting, "\u68C0\u6D4B\u672A\u7BA1\u7406\u9879\u76EE", [
      "\u626B\u63CF\u672C\u8EAB\u53EA\u8BFB\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\uFF1B\u53EA\u6709\u786E\u8BA4\u540E\u624D\u4F1A\u4E3A\u7F3A\u5C11 GUID \u7684\u6587\u4EF6\u548C\u6587\u4EF6\u5939\u751F\u6210 GUID\u3002",
      "\u63D2\u4EF6\u8FD0\u884C\u671F\u95F4\u590D\u5236\u6216\u65B0\u5EFA\u7684\u9879\u76EE\u901A\u5E38\u5DF2\u88AB\u5B9E\u65F6\u81EA\u52A8\u7EB3\u5165\uFF0C\u56E0\u6B64\u626B\u63CF\u7ED3\u679C\u53EF\u80FD\u4E3A\u96F6\u3002"
    ]);
    const manageSetting = new import_obsidian.Setting(containerEl).setName("\u5C06\u5F53\u524D\u5E93\u4E2D\u7684\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u7EB3\u5165\u672C\u63D2\u4EF6\u7BA1\u7406").setDesc("\u4E3A\u9009\u4E2D\u7684\u9879\u76EE\u8865\u9F50\u6216\u91CD\u65B0\u751F\u6210 GUID\u3002").addButton((button) => button.setButtonText("\u9009\u62E9\u6587\u4EF6\u548C\u6587\u4EF6\u5939").onClick(() => this.plugin.openIdentitySelection()));
    this.addDetails(manageSetting, "\u5C06\u5F53\u524D\u5E93\u4E2D\u7684\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u7EB3\u5165\u672C\u63D2\u4EF6\u7BA1\u7406", [
      "\u8303\u56F4\u5305\u542B\u6240\u9009\u6587\u4EF6\u5939\u672C\u8EAB\u4EE5\u53CA\u6587\u4EF6\u5939\u4E0B\u7684\u5168\u90E8\u5185\u5BB9\u3002",
      "\u53EF\u53EA\u751F\u6210\u7F3A\u5931\u7684 GUID\uFF0C\u4E5F\u53EF\u91CD\u65B0\u751F\u6210\u9009\u4E2D\u9879\u76EE\u7684 GUID \u5E76\u5EFA\u7ACB\u6392\u5E8F\u7D22\u5F15\uFF1B\u4FEE\u6539\u540E\u4E0D\u6539\u53D8\u539F\u4F4D\u7F6E\u3002",
      "\u8BE5\u529F\u80FD\u4E5F\u53EF\u7528\u4F5C\u91CD\u7F6E\u6392\u5E8F\u7D22\u5F15\u3002"
    ]);
    new import_obsidian.Setting(containerEl).setName("\u542F\u52A8\u65F6\u68C0\u6D4B\u91CD\u590D GUID").setDesc("\u542F\u52A8\u65F6\u53EA\u8BFB\u68C0\u6D4B\u91CD\u590D GUID \u5E76\u63D0\u793A\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.scanDuplicateGuidsOnStartup).onChange(async (value) => {
      this.plugin.data.settings.scanDuplicateGuidsOnStartup = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u91CD\u590D GUID").setDesc("\u6309\u5B8C\u6574 GUID \u68C0\u6D4B\uFF1B\u4FEE\u590D\u65F6\u4FDD\u7559\u5F53\u524D\u987A\u5E8F\u4E2D\u7684\u9996\u9879\u3002").addButton((button) => button.setButtonText("\u68C0\u6D4B\u5E76\u4FEE\u590D").onClick(() => void this.plugin.checkDuplicateGuids(true)));
    new import_obsidian.Setting(containerEl).setName("\u5168\u5E93\u66F4\u6362 GUID").setDesc("\u4E3A\u5168\u90E8\u6587\u4EF6\u548C\u6587\u4EF6\u5939\u6362\u53F7\uFF0C\u53EF\u9009\u62E9\u662F\u5426\u521B\u5EFA\u6062\u590D\u70B9\u3002").addButton((button) => button.setButtonText("\u4E0D\u5907\u4EFD").onClick(() => void this.plugin.replaceAllGuids(this.plugin.data.settings.guidBits, false))).addButton((button) => button.setButtonText("\u66F4\u6362\u5E76\u5907\u4EFD").setWarning().onClick(() => void this.plugin.replaceAllGuids(this.plugin.data.settings.guidBits, true)));
    if (this.plugin.data.guidBackups.length) {
      containerEl.createEl("h4", { text: "GUID \u6062\u590D\u70B9\uFF08\u6700\u591A 3 \u4EFD\uFF09" });
      [...this.plugin.data.guidBackups].reverse().forEach((backup) => {
        new import_obsidian.Setting(containerEl).setName(new Date(backup.createdAt).toLocaleString()).setDesc(`${backup.count} \u9879\uFF0C${backup.bits} bit`).addButton((button) => button.setButtonText("\u6062\u590D").onClick(() => void this.plugin.restoreGuidBackup(backup)));
      });
    }
    section("\u65E7\u5E93\u63A5\u7BA1\u4E0E\u8DE8\u5E93\u8FC1\u79FB");
    const legacySetting = new import_obsidian.Setting(containerEl).setName("\u63A5\u7BA1\u5386\u53F2 Obsidian Vault").setDesc("\u4E3A\u6CA1\u6709 GUID \u7684\u65E7\u5E93\u8865\u9F50 GUID \u5E76\u91CD\u5EFA\u76EE\u5F55\u7D22\u5F15\u3002").addButton((button) => button.setButtonText("\u68C0\u67E5\u5E76\u63A5\u7BA1\u5386\u53F2\u5E93").onClick(() => void this.plugin.takeOverHistoricalVault()));
    this.addDetails(legacySetting, "\u63A5\u7BA1\u5386\u53F2 Obsidian Vault", [
      "\u9002\u7528\u4E8E\u6CA1\u6709 GUID\u3001\u6CA1\u6709\u63D2\u4EF6 data.json \u7684\u65E7\u5E93\u3002",
      "\u8865\u5168\u7F3A\u5931\u7684 GUID \u4E0E\u76EE\u5F55\u7D22\u5F15\uFF0C\u5E76\u6309\u5F53\u524D\u663E\u793A\u7ED3\u6784\u91CD\u5EFA\u987A\u5E8F\uFF1B\u4E0D\u79FB\u52A8\u6216\u91CD\u547D\u540D\u6587\u4EF6\u3002"
    ]);
    const transferSetting = new import_obsidian.Setting(containerEl).setName("\u8DE8Vault\u5408\u5E76\uFF08\u81EA\u52A8\u590D\u5236\uFF09").setDesc("\u4ECE\u53E6\u4E00\u4E2A Vault \u6216\u76EE\u5F55\u590D\u5236\u6587\u4EF6\u4E0E\u987A\u5E8F\uFF0C\u51B2\u7A81\u53EF\u66FF\u6362\u3001\u91CD\u547D\u540D\u6216\u7F16\u53F7\u3002").addButton((button) => button.setButtonText("\u8DE8Vault\u5408\u5E76\uFF08\u81EA\u52A8\u590D\u5236\uFF09").onClick(() => this.plugin.openLocalCopy()));
    this.addDetails(transferSetting, "\u8DE8Vault\u5408\u5E76\uFF08\u81EA\u52A8\u590D\u5236\uFF09", [
      "\u9009\u62E9\u6E90\u5E93\u548C\u5F53\u524D\u5E93\u4E2D\u7684\u76EE\u6807\u76EE\u5F55\uFF0C\u9884\u68C0\u540C\u540D\u51B2\u7A81\u540E\u518D\u6267\u884C\uFF1B\u652F\u6301\u6574\u9879\u66FF\u6362\u3001\u91CD\u547D\u540D\u548C\u7F16\u53F7\u3002",
      "\u6BCF\u6B21\u64CD\u4F5C\u4F1A\u5728\u63D2\u4EF6\u76EE\u5F55\u751F\u6210 local-copy-* \u5907\u4EFD\u4E0E\u8BB0\u5F55\u6587\u4EF6\u5939\u3002",
      "\u786E\u8BA4\u590D\u5236\u7ED3\u679C\u548C\u6392\u5E8F\u90FD\u6B63\u5E38\u3001\u4E14\u4E0D\u518D\u9700\u8981\u6062\u590D\u8BB0\u5F55\u540E\uFF0C\u53EF\u4EE5\u5220\u9664\u5BF9\u5E94\u7684 local-copy-* \u6587\u4EF6\u5939\uFF08\u4F8B\u5982 local-copy-DJKYhp\uFF09\uFF1B\u4E0D\u8981\u5220\u9664\u63D2\u4EF6\u76EE\u5F55\u4E2D\u6B63\u5728\u4F7F\u7528\u7684 data.json\u3002"
    ]);
  }
};
