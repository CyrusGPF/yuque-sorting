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
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
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
function normalizeGuid(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const guid = String(value).trim();
  return guid ? guid : null;
}
function compareEntryNames(a, b) {
  return a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
}
function sortEntries(entries, savedOrder, guidOf, fallback = "name-last") {
  const rank = /* @__PURE__ */ new Map();
  savedOrder.forEach((guid, index) => {
    if (!rank.has(guid)) rank.set(guid, index);
  });
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
function folderIdentityPathForNote(notePath, folderGuids, guid) {
  const withoutExtension = notePath.replace(/\.md$/i, "");
  const slash = notePath.lastIndexOf("/");
  const parent = slash < 0 ? "" : notePath.slice(0, slash);
  const noteName = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
  const parentName = parent.slice(parent.lastIndexOf("/") + 1);
  const candidates = noteName === parentName ? [parent, withoutExtension] : [withoutExtension];
  return candidates.find((path) => path && folderGuids[path] === guid) || null;
}
function detachFolderNoteFromOrder(orderByFolder, folderGuid) {
  const ownedOrder = orderByFolder[folderGuid];
  if (!ownedOrder) return false;
  const next = ownedOrder.filter((guid) => guid !== folderGuid);
  if (next.length === ownedOrder.length) return false;
  orderByFolder[folderGuid] = next;
  return true;
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

// main.ts
var MANIFEST_NAME = "_yuque_order.json";
var DEFAULT_SETTINGS = {
  orderFrontmatterKey: "guid",
  newItemPlacement: "bottom",
  fallbackSort: "name-last",
  persistOrderOnCreateDelete: true,
  enableDrag: true
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
function createGuid(prefix = "obs") {
  var _a, _b;
  const uuid = (_b = (_a = globalThis.crypto) == null ? void 0 : _a.randomUUID) == null ? void 0 : _b.call(_a);
  return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
function manifestIssueCount(report) {
  return report.missing.length + report.extra.length + report.moved.length + report.duplicateManifestGuids.length + report.duplicateActualGuids.length + report.invalidManifests.length;
}
var ManifestImportConfirmModal = class extends import_obsidian.Modal {
  constructor(app, report, resolveChoice) {
    super(app);
    this.report = report;
    this.resolveChoice = resolveChoice;
    this.settled = false;
  }
  onOpen() {
    this.setTitle("\u8BED\u96C0\u987A\u5E8F\u6E05\u5355\u4E0E\u5F53\u524D\u5E93\u4E0D\u4E00\u81F4");
    this.contentEl.createEl("p", {
      text: "\u7EE7\u7EED\u5BFC\u5165\u53EA\u4F1A\u8C03\u6574\u80FD\u591F\u5339\u914D\u7684\u9879\u76EE\u987A\u5E8F\uFF0C\u4E0D\u4F1A\u521B\u5EFA\u3001\u5220\u9664\u6216\u79FB\u52A8\u6587\u4EF6\u3002\u8BF7\u786E\u8BA4\u662F\u5426\u7EE7\u7EED\u3002"
    });
    const groups = [
      ["\u6E05\u5355\u4E2D\u6709\u3001\u5F53\u524D\u5E93\u7F3A\u5931", this.report.missing.map((entry) => entry.label)],
      ["\u5F53\u524D\u5E93\u591A\u51FA\u7684\u9879\u76EE", this.report.extra.map((entry) => entry.label)],
      ["\u6240\u5728\u76EE\u5F55\u4E0E\u6E05\u5355\u4E0D\u7B26", this.report.moved.map(({ actual }) => actual.label)],
      ["\u6E05\u5355\u4E2D\u7684\u91CD\u590D GUID", this.report.duplicateManifestGuids],
      ["\u5F53\u524D\u5E93\u4E2D\u7684\u91CD\u590D GUID", this.report.duplicateActualGuids],
      ["\u65E0\u6CD5\u8BFB\u53D6\u7684\u6E05\u5355", this.report.invalidManifests]
    ];
    groups.forEach(([title, items]) => {
      if (!items.length) return;
      this.contentEl.createEl("h4", { text: `${title}\uFF08${items.length}\uFF09` });
      const list = this.contentEl.createEl("ul");
      items.slice(0, 8).forEach((item) => list.createEl("li", { text: item }));
      if (items.length > 8) list.createEl("li", { text: `\u53E6\u6709 ${items.length - 8} \u9879\u2026\u2026` });
    });
    new import_obsidian.Setting(this.contentEl).addButton((button) => button.setButtonText("\u653E\u5F03").onClick(() => this.finish(false))).addButton((button) => button.setButtonText("\u4ECD\u7136\u5BFC\u5165").setWarning().onClick(() => this.finish(true)));
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
var YqOrderDragPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.guidByPath = /* @__PURE__ */ new Map();
    this.guidPromises = /* @__PURE__ */ new Map();
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
    this.explorerView = null;
    this.restoreExplorerPatch = null;
    this.domOrderFrame = null;
    this.explorerSetup = false;
    this.manifestNoticeShown = false;
    this.dragSourcePath = "";
    this.dragHintEl = null;
    this.pendingDropPlacements = /* @__PURE__ */ new Map();
  }
  async onload() {
    this.data = this.normalizeData(await this.loadData());
    this.registerEvent(this.app.vault.on("create", (file) => void this.handleCreate(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.handleDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.handleRename(file, oldPath)));
    this.addCommand({
      id: "import-yuque-order-manifest",
      name: "\u5BFC\u5165/\u91CD\u540C\u6B65\u8BED\u96C0\u987A\u5E8F\u6E05\u5355",
      callback: () => void this.requestManifestImport()
    });
    this.addCommand({
      id: "refresh-yuque-order",
      name: "\u5237\u65B0\u8BED\u96C0\u5F0F\u6587\u4EF6\u987A\u5E8F",
      callback: () => void this.reconcileVault(true)
    });
    this.addSettingTab(new YqOrderSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => void this.boot());
  }
  async boot() {
    await this.reconcileVault(false);
    this.setupExplorer();
    this.refreshExplorer();
  }
  onunload() {
    var _a;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.domOrderFrame !== null) window.cancelAnimationFrame(this.domOrderFrame);
    (_a = this.restoreExplorerPatch) == null ? void 0 : _a.call(this);
    this.restoreExplorerPatch = null;
  }
  normalizeData(saved) {
    const savedSettings = (saved == null ? void 0 : saved.settings) || {};
    const supportedSettings = {};
    if (typeof savedSettings.orderFrontmatterKey === "string") {
      supportedSettings.orderFrontmatterKey = savedSettings.orderFrontmatterKey;
    }
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
    const orderByFolder = (saved == null ? void 0 : saved.orderByFolder) && typeof saved.orderByFolder === "object" ? saved.orderByFolder : {};
    Object.keys(orderByFolder).forEach((key) => {
      if (!Array.isArray(orderByFolder[key])) orderByFolder[key] = [];
    });
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...supportedSettings },
      orderByFolder,
      folderGuids: (saved == null ? void 0 : saved.folderGuids) && typeof saved.folderGuids === "object" ? saved.folderGuids : {},
      fileGuids: (saved == null ? void 0 : saved.fileGuids) && typeof saved.fileGuids === "object" ? saved.fileGuids : {}
    };
  }
  queueSave(force = false) {
    if (!force && !this.data.settings.persistOrderOnCreateDelete) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.savePromise = this.savePromise.then(() => this.saveData(this.data));
    }, 250);
  }
  async flushSave() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.savePromise = this.savePromise.then(() => this.saveData(this.data));
    }
    await this.savePromise;
  }
  async saveSettings() {
    await this.flushSave();
    await this.saveData(this.data);
  }
  async reconcileVault(forceRefresh) {
    const all = this.app.vault.getAllLoadedFiles();
    const files = all.filter((file) => file instanceof import_obsidian.TFile);
    const folders = all.filter((file) => file instanceof import_obsidian.TFolder);
    if (all.length <= 1) return;
    for (const file of files) await this.ensureFileGuid(file);
    for (const folder of folders) await this.ensureFolderGuid(folder);
    for (const folder of folders) this.reconcileFolder(folder);
    await this.flushSave();
    await this.saveData(this.data);
    if (forceRefresh) this.refreshExplorer();
  }
  reconcileFolder(folder) {
    const sortable = folder.children.filter((child) => child instanceof import_obsidian.TFile || child instanceof import_obsidian.TFolder);
    const childGuids = sortable.map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    const uniqueChildGuids = [...new Set(childGuids)];
    const key = this.folderKeySync(folder);
    const previous = this.data.orderByFolder[key] || [];
    const byName = sortable.slice().sort((a, b) => a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" })).map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    this.data.orderByFolder[key] = reconcileOrderNonDestructive(
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
      const guid = this.data.fileGuids[file.path] || createGuid("obs-file");
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
        guid = createGuid("obs");
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
    var _a, _b;
    const value = (_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b[this.data.settings.orderFrontmatterKey];
    return normalizeGuid(value);
  }
  readGuidFromText(text) {
    var _a;
    const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const key = this.data.settings.orderFrontmatterKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const field = match[1].match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, "m"));
    return normalizeGuid((_a = field == null ? void 0 : field[1]) == null ? void 0 : _a.replace(/^['\"]|['\"]$/g, ""));
  }
  async writeFileGuid(file, guid) {
    const key = this.data.settings.orderFrontmatterKey;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (!normalizeGuid(frontmatter[key])) frontmatter[key] = guid;
      });
      return;
    } catch (e) {
      await this.app.vault.process(file, (text) => {
        if (this.readGuidFromText(text)) return text;
        return `---
${key}: ${guid}
---

${text}`;
      });
    }
  }
  async ensureFolderGuid(folder) {
    var _a;
    if (!folder.path) return null;
    const ownNote = this.app.vault.getAbstractFileByPath(`${folder.path}/${basename(folder.path)}.md`);
    const siblingNotePath = `${((_a = folder.parent) == null ? void 0 : _a.path) ? `${folder.parent.path}/` : ""}${basename(folder.path)}.md`;
    const siblingNote = this.app.vault.getAbstractFileByPath(siblingNotePath);
    const folderNote = isMarkdown(ownNote) ? ownNote : siblingNote;
    if (folderNote instanceof import_obsidian.TFile && isMarkdown(folderNote)) {
      const guid = await this.ensureFileGuid(folderNote);
      const previousGuid = this.data.folderGuids[folder.path];
      if (previousGuid && previousGuid !== guid) {
        replaceGuidInOrders(this.data.orderByFolder, previousGuid, guid);
      }
      this.data.folderGuids[folder.path] = guid;
      return guid;
    }
    if (!this.data.folderGuids[folder.path]) this.data.folderGuids[folder.path] = createGuid("obs-folder");
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
    const key = folder instanceof import_obsidian.TFolder ? this.folderKeySync(folder) : ROOT_FOLDER_KEY;
    const saved = this.data.orderByFolder[key] || [];
    const sortable = items.filter((item) => item instanceof import_obsidian.TFolder || item instanceof import_obsidian.TFile);
    return sortEntries(
      sortable,
      saved,
      (item) => this.getItemGuidSync(item),
      this.data.settings.fallbackSort
    );
  }
  async handleCreate(file) {
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
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof import_obsidian.TFile) {
      const guid = this.guidByPath.get(file.path) || (isMarkdown(file) ? this.readCachedFrontmatterGuid(file) : this.data.fileGuids[file.path]);
      const identityFolderPath = isMarkdown(file) && guid ? folderIdentityPathForNote(file.path, this.data.folderGuids, guid) : null;
      if (guid && identityFolderPath) {
        detachFolderNoteFromOrder(this.data.orderByFolder, guid);
      } else if (guid) {
        removeGuidFromOrders(this.data.orderByFolder, guid);
      }
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
    var _a, _b;
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof import_obsidian.TFolder) {
      const movedGuid = this.data.folderGuids[oldPath];
      const oldParent = parentPath(oldPath);
      migratePathMappings(this.data.folderGuids, oldPath, file.path);
      const fileUpdates = migratePathMappings(this.data.fileGuids, oldPath, file.path);
      fileUpdates.forEach(([from, to, guid]) => {
        this.guidByPath.delete(from);
        this.guidByPath.set(to, guid);
      });
      const newParent = ((_a = file.parent) == null ? void 0 : _a.path) || "";
      if (movedGuid && oldParent !== newParent) {
        if (file.parent) await this.ensureFolderGuid(file.parent);
        const pending = this.pendingDropPlacements.get(movedGuid);
        if ((pending == null ? void 0 : pending.parentPath) === newParent) {
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
          const pending = this.pendingDropPlacements.get(guid);
          if ((pending == null ? void 0 : pending.parentPath) === newParent) {
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
    const key = this.folderKeySync(folder);
    const order = this.data.orderByFolder[key] || [];
    this.data.orderByFolder[key] = insertGuid(order, guid, this.data.settings.newItemPlacement);
  }
  placeGuidRelative(folder, guid, targetGuid, before) {
    const key = this.folderKeySync(folder);
    relocateGuid(this.data.orderByFolder, key, guid, this.data.settings.newItemPlacement);
    this.data.orderByFolder[key] = moveGuid(this.data.orderByFolder[key], guid, targetGuid, before);
  }
  async requestManifestImport() {
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      new import_obsidian.Notice("\u672A\u627E\u5230 _yuque_order.json");
      return;
    }
    const report = await this.inspectManifestConsistency(manifests);
    if (manifestIssueCount(report) > 0) {
      const proceed = await new Promise((resolve) => {
        new ManifestImportConfirmModal(this.app, report, resolve).open();
      });
      if (!proceed) {
        new import_obsidian.Notice("\u5DF2\u653E\u5F03\u5BFC\u5165\u8BED\u96C0\u987A\u5E8F\u6E05\u5355");
        return;
      }
    }
    this.manifestNoticeShown = false;
    await this.seedFromManifests();
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
      const append = (key, guid) => {
        const list = desired.get(key) || [];
        if (!list.includes(guid)) list.push(guid);
        desired.set(key, list);
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
              const key2 = this.folderKeySync(parentFolder2);
              append(key2, guid);
              if (Array.isArray(node.children) && node.children.length) visit(node.children, folder);
              return;
            }
            if (Array.isArray(node.children) && node.children.length) visit(node.children, fallbackFolder);
            return;
          }
          const logicalItem = folderByGuid.get(guid) || (item instanceof import_obsidian.TFile ? this.findFolderForNote(item) : null) || item;
          const parentFolder = logicalItem.parent || fallbackFolder;
          const key = this.folderKeySync(parentFolder);
          append(key, guid);
          const childFolder = logicalItem instanceof import_obsidian.TFolder ? logicalItem : parentFolder;
          if (Array.isArray(node.children) && node.children.length) visit(node.children, childFolder);
        });
      };
      visit(raw.tree, manifestFile.parent);
      const manifestGuidSet = new Set(manifestGuids);
      Object.keys(this.data.orderByFolder).forEach((key) => {
        this.data.orderByFolder[key] = (this.data.orderByFolder[key] || []).filter((guid) => !manifestGuidSet.has(guid));
      });
      desired.forEach((wanted, key) => {
        const old = this.data.orderByFolder[key] || [];
        const next = [...wanted, ...old];
        this.data.orderByFolder[key] = next;
        if (next.length !== old.length || next.some((guid, index) => guid !== old[index])) {
          seeded += 1;
        }
      });
    }
    if (seeded) {
      await this.flushSave();
      await this.saveData(this.data);
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
    } catch (error) {
      if (!this.manifestNoticeShown) {
        this.manifestNoticeShown = true;
        console.warn("[Yuque Order Drag] FileExplorer patch unavailable; using default order.", error);
      }
    }
  }
  setupExplorer() {
    var _a;
    if (this.explorerSetup) return;
    const view = (_a = this.app.workspace.getLeavesOfType("file-explorer")[0]) == null ? void 0 : _a.view;
    const container = (view == null ? void 0 : view.containerEl) || document.querySelector(".nav-files-container");
    if (!view || !container) {
      const observer = new MutationObserver(() => {
        var _a2;
        if (!((_a2 = this.app.workspace.getLeavesOfType("file-explorer")[0]) == null ? void 0 : _a2.view)) return;
        observer.disconnect();
        this.setupExplorer();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      this.register(() => observer.disconnect());
      return;
    }
    if (!this.explorerView) this.explorerView = view;
    this.explorerSetup = true;
    this.patchFileExplorer();
    this.installDragHandlers();
    this.refreshExplorer();
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
    this.clearDropTargets();
    targetEl.classList.add(`yq-order-drop-${position}`);
    if (!this.dragHintEl) {
      this.dragHintEl = document.createElement("div");
      this.dragHintEl.className = "yq-order-drag-hint";
      document.body.appendChild(this.dragHintEl);
    }
    const targetName = ((_a = this.dropSurface(targetEl).textContent) == null ? void 0 : _a.trim()) || this.pathFromElement(targetEl);
    const action = position === "before" ? "\u63D2\u5165\u5230\u4E0A\u65B9" : position === "after" ? "\u63D2\u5165\u5230\u4E0B\u65B9" : "\u79FB\u5165";
    this.dragHintEl.textContent = `${action}\uFF1A${targetName}`;
    const hintRect = this.dragHintEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX + 14, window.innerWidth - hintRect.width - 8));
    const below = clientY + 18;
    const top = below + hintRect.height <= window.innerHeight - 8 ? below : Math.max(8, clientY - hintRect.height - 14);
    this.dragHintEl.style.left = `${left}px`;
    this.dragHintEl.style.top = `${top}px`;
  }
  clearDropTargets() {
    document.querySelectorAll(".yq-order-drop-before, .yq-order-drop-inside, .yq-order-drop-after").forEach((element) => element.classList.remove(
      "yq-order-drop-before",
      "yq-order-drop-inside",
      "yq-order-drop-after"
    ));
  }
  clearDropFeedback() {
    var _a;
    this.clearDropTargets();
    (_a = this.dragHintEl) == null ? void 0 : _a.remove();
    this.dragHintEl = null;
  }
  installDragHandlers() {
    const explorerContainer = this.getExplorerContainer() || void 0;
    if (explorerContainer) {
      const markDraggable = () => explorerContainer.querySelectorAll(".nav-file, .nav-folder").forEach((element) => element.setAttribute("draggable", "true"));
      markDraggable();
      const observer = new MutationObserver(() => {
        markDraggable();
        this.scheduleDomOrder();
      });
      observer.observe(explorerContainer, { childList: true, subtree: true });
      this.register(() => observer.disconnect());
      this.scheduleDomOrder();
    }
    this.registerDomEvent(document, "dragstart", (event) => {
      if (!this.data.settings.enableDrag) return;
      const item = this.explorerItem(event.target);
      const path = item && this.pathFromElement(item);
      if (!path || !event.dataTransfer) return;
      this.dragSourcePath = path;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-yq-order-path", path);
      event.dataTransfer.setData("text/plain", path);
      item.classList.add("yq-order-drag-source");
    }, true);
    this.registerDomEvent(document, "dragover", (event) => {
      if (!this.dragSourcePath) return;
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
      const target = this.explorerItem(event.target);
      if (!target) return;
      event.preventDefault();
      const targetPath = this.pathFromElement(target);
      const position = this.dropPosition(this.dragSourcePath, targetPath, event.clientY, target);
      void this.handleDrop(this.dragSourcePath, targetPath, position);
      this.clearDragState();
    }, true);
    this.registerDomEvent(document, "dragend", () => this.clearDragState(), true);
  }
  clearDragState() {
    this.dragSourcePath = "";
    document.querySelectorAll(
      ".yq-order-drag-source, .yq-order-drop-before, .yq-order-drop-inside, .yq-order-drop-after"
    ).forEach((el) => {
      el.classList.remove(
        "yq-order-drag-source",
        "yq-order-drop-before",
        "yq-order-drop-inside",
        "yq-order-drop-after"
      );
    });
    this.clearDropFeedback();
  }
  async handleDrop(sourcePath, targetPath, position) {
    var _a;
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!source || !target || source.path === target.path) return;
    let targetFolder = position === "inside" && target instanceof import_obsidian.TFolder ? target : position === "inside" && target instanceof import_obsidian.TFile ? this.findFolderForNote(target) : null;
    if (!targetFolder && position === "inside" && target instanceof import_obsidian.TFile && isMarkdown(target)) {
      if (source instanceof import_obsidian.TFolder) return;
      const folderPath = stripMarkdown(target.path);
      try {
        targetFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(targetFolder instanceof import_obsidian.TFolder)) {
          targetFolder = await this.app.vault.createFolder(folderPath);
        }
        await this.ensureFolderGuid(targetFolder);
        await this.app.fileManager.renameFile(target, `${folderPath}/${target.name}`);
      } catch (error) {
        new import_obsidian.Notice(`\u521B\u5EFA\u7236\u6587\u6863\u6587\u4EF6\u5939\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (targetFolder && targetFolder !== source && !targetFolder.path.startsWith(`${source.path}/`)) {
      const destination = `${targetFolder.path}/${basename(source.path)}`;
      if (this.app.vault.getAbstractFileByPath(destination)) {
        new import_obsidian.Notice("\u76EE\u6807\u6587\u4EF6\u5939\u4E2D\u5DF2\u5B58\u5728\u540C\u540D\u6587\u4EF6");
        return;
      }
      const guid = this.getItemGuidSync(source);
      if (guid) removeGuidFromOrders(this.data.orderByFolder, guid);
      try {
        await this.app.fileManager.renameFile(source, destination);
      } catch (error) {
        new import_obsidian.Notice(`\u79FB\u52A8\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      this.queueSave(true);
      this.refreshExplorer();
      return;
    }
    const sourceGuid = this.getItemGuidSync(source);
    const targetGuid = this.getItemGuidSync(target);
    if (!sourceGuid || !targetGuid || !source.parent || !target.parent) return;
    if (source.parent.path !== target.parent.path) {
      if (target.parent === source || target.parent.path.startsWith(`${source.path}/`)) {
        new import_obsidian.Notice("\u4E0D\u80FD\u628A\u6587\u4EF6\u5939\u79FB\u52A8\u5230\u5B83\u81EA\u5DF1\u7684\u5B50\u76EE\u5F55\u4E2D");
        return;
      }
      const destination = target.parent.path ? `${target.parent.path}/${basename(source.path)}` : basename(source.path);
      if (this.app.vault.getAbstractFileByPath(destination)) {
        new import_obsidian.Notice("\u76EE\u6807\u76EE\u5F55\u4E2D\u5DF2\u5B58\u5728\u540C\u540D\u6587\u4EF6");
        return;
      }
      this.pendingDropPlacements.set(sourceGuid, {
        parentPath: target.parent.path,
        targetGuid,
        before: position === "before"
      });
      try {
        await this.app.fileManager.renameFile(source, destination);
      } catch (error) {
        this.pendingDropPlacements.delete(sourceGuid);
        new import_obsidian.Notice(`\u79FB\u52A8\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const key = this.folderKeySync(source.parent);
    const fallbackOrder = source.parent.children.filter((child) => child instanceof import_obsidian.TFolder || child instanceof import_obsidian.TFile).map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    const currentOrder = ((_a = this.data.orderByFolder[key]) == null ? void 0 : _a.length) ? this.data.orderByFolder[key] : fallbackOrder;
    this.data.orderByFolder[key] = moveGuid(currentOrder, sourceGuid, targetGuid, position === "before");
    this.queueSave(true);
    await this.flushSave();
    this.refreshExplorer();
  }
  refreshExplorer() {
    var _a;
    try {
      const view = this.explorerView;
      if (view) {
        if (typeof view.sort === "function") view.sort();
        else if (typeof view.requestSort === "function") view.requestSort();
        else (_a = view.rerender) == null ? void 0 : _a.call(view);
      }
      this.scheduleDomOrder();
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
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Yuque Order Drag V1" });
    containerEl.createEl("p", {
      text: "\u4F7F\u7528 Markdown frontmatter \u4E2D\u7684 guid \u4F5C\u4E3A\u7A33\u5B9A\u8EAB\u4EFD\uFF1B\u987A\u5E8F\u4FDD\u5B58\u5728\u63D2\u4EF6 data.json\uFF0C\u4E0D\u4FEE\u6539\u6587\u4EF6\u540D\u3002"
    });
    new import_obsidian.Setting(containerEl).setName("\u8EAB\u4EFD\u5B57\u6BB5").setDesc("\u9ED8\u8BA4\u4F7F\u7528 guid\uFF1B\u4FEE\u6539\u540E\u53EA\u5F71\u54CD\u4E4B\u540E\u8BC6\u522B\u7684\u6587\u4EF6\u3002").addText((text) => text.setValue(this.plugin.data.settings.orderFrontmatterKey).onChange(async (value) => {
      this.plugin.data.settings.orderFrontmatterKey = value.trim() || "guid";
      await this.plugin.reconcileVault(true);
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u65B0\u589E\u9879\u4F4D\u7F6E").setDesc("\u65B0\u5EFA Markdown \u6216\u6587\u4EF6\u5939\u52A0\u5165\u5F53\u524D\u76EE\u5F55\u65F6\u7684\u4F4D\u7F6E\u3002").addDropdown((dropdown) => dropdown.addOption("bottom", "\u5E95\u90E8").addOption("top", "\u9876\u90E8").setValue(this.plugin.data.settings.newItemPlacement).onChange(async (value) => {
      this.plugin.data.settings.newItemPlacement = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u672A\u8BB0\u5F55\u9879\u515C\u5E95\u6392\u5E8F").setDesc("\u6CA1\u6709\u51FA\u73B0\u5728\u987A\u5E8F\u5217\u8868\u4E2D\u7684\u9879\u6309\u540D\u79F0\u6392\u5E8F\uFF0C\u5E76\u6392\u5728\u5DF2\u8BB0\u5F55\u9879\u4E4B\u540E\u3002").addDropdown((dropdown) => dropdown.addOption("name-last", "\u6309\u540D\u79F0\uFF0C\u6392\u5728\u672B\u5C3E").addOption("name", "\u6309\u540D\u79F0").setValue(this.plugin.data.settings.fallbackSort).onChange(async (value) => {
      this.plugin.data.settings.fallbackSort = value;
      await this.plugin.saveSettings();
      this.plugin.refreshExplorer();
    }));
    new import_obsidian.Setting(containerEl).setName("\u589E\u5220\u540E\u7ACB\u5373\u6301\u4E45\u5316").setDesc("\u5173\u95ED\u53EF\u51CF\u5C11 Obsidian Sync \u51B2\u7A81\uFF1B\u62D6\u62FD\u6392\u5E8F\u4ECD\u4F1A\u4FDD\u5B58\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.persistOrderOnCreateDelete).onChange(async (value) => {
      this.plugin.data.settings.persistOrderOnCreateDelete = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u542F\u7528\u6587\u4EF6\u6811\u62D6\u62FD").setDesc("\u62D6\u5230\u6807\u9898\u884C\u4E0A\u90E8\u6216\u4E0B\u90E8\u53EF\u7CBE\u786E\u63D2\u5165\uFF1B\u62D6\u5230\u4E2D\u90E8\u53EF\u79FB\u5165\u6587\u4EF6\u5939\u6216\u6587\u4EF6\u5939\u7B14\u8BB0\u3002\u62D6\u52A8\u65F6\u4F1A\u663E\u793A\u63D2\u5165\u7EBF\u548C\u52A8\u4F5C\u63D0\u793A\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.enableDrag).onChange(async (value) => {
      this.plugin.data.settings.enableDrag = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u624B\u52A8\u5BFC\u5165/\u91CD\u540C\u6B65").setDesc("\u5148\u6838\u5BF9\u5F53\u524D\u5E93\u4E0E\u6E05\u5355\uFF1B\u4E00\u81F4\u65F6\u76F4\u63A5\u5BFC\u5165\uFF0C\u4E0D\u4E00\u81F4\u65F6\u7531\u4F60\u786E\u8BA4\u662F\u5426\u7EE7\u7EED\u3002").addButton((button) => button.setButtonText("\u68C0\u67E5\u5E76\u5BFC\u5165").onClick(() => void this.plugin.requestManifestImport()));
  }
};
