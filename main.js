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
function uniqueKnownOrder(order, knownGuids) {
  const seen = /* @__PURE__ */ new Set();
  return order.filter((guid) => {
    if (!knownGuids.has(guid) || seen.has(guid)) return false;
    seen.add(guid);
    return true;
  });
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

// main.ts
var MANIFEST_NAME = "_yuque_order.json";
var DEFAULT_SETTINGS = {
  orderFrontmatterKey: "guid",
  newItemPlacement: "bottom",
  fallbackSort: "name-last",
  autoSeedFromManifest: true,
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
    this.autoSeedNoticeShown = false;
    this.dragSourcePath = "";
  }
  async onload() {
    this.data = this.normalizeData(await this.loadData());
    this.registerEvent(this.app.vault.on("create", (file) => void this.handleCreate(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.handleDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("modify", (file) => void this.handleModify(file)));
    this.addCommand({
      id: "import-yuque-order-manifest",
      name: "\u5BFC\u5165/\u91CD\u540C\u6B65\u8BED\u96C0\u987A\u5E8F\u6E05\u5355",
      callback: () => void this.seedFromManifests(true)
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
    const orderByFolder = (saved == null ? void 0 : saved.orderByFolder) && typeof saved.orderByFolder === "object" ? saved.orderByFolder : {};
    Object.keys(orderByFolder).forEach((key) => {
      if (!Array.isArray(orderByFolder[key])) orderByFolder[key] = [];
    });
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...savedSettings },
      orderByFolder,
      folderGuids: (saved == null ? void 0 : saved.folderGuids) && typeof saved.folderGuids === "object" ? saved.folderGuids : {},
      manifestSignatures: (saved == null ? void 0 : saved.manifestSignatures) && typeof saved.manifestSignatures === "object" ? saved.manifestSignatures : {}
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
    const files = all.filter((file) => isMarkdown(file));
    const folders = all.filter((file) => file instanceof import_obsidian.TFolder);
    if (all.length <= 1) return;
    for (const file of files) await this.ensureFileGuid(file);
    for (const folder of folders) await this.ensureFolderGuid(folder);
    const knownFolderPaths = new Set(folders.filter((folder) => folder.path).map((folder) => folder.path));
    Object.keys(this.data.folderGuids).forEach((path) => {
      if (!knownFolderPaths.has(path)) delete this.data.folderGuids[path];
    });
    const knownGuids = /* @__PURE__ */ new Set();
    files.forEach((file) => {
      const guid = this.guidByPath.get(file.path);
      if (guid) knownGuids.add(guid);
    });
    folders.forEach((folder) => {
      if (folder.path && this.data.folderGuids[folder.path]) knownGuids.add(this.data.folderGuids[folder.path]);
    });
    const knownFolderKeys = /* @__PURE__ */ new Set([ROOT_FOLDER_KEY, ...knownGuids]);
    Object.keys(this.data.orderByFolder).forEach((folderKey) => {
      if (!knownFolderKeys.has(folderKey)) {
        delete this.data.orderByFolder[folderKey];
        return;
      }
      const next = uniqueKnownOrder(this.data.orderByFolder[folderKey] || [], knownGuids);
      if (next.length) this.data.orderByFolder[folderKey] = next;
      else delete this.data.orderByFolder[folderKey];
    });
    for (const folder of folders) this.reconcileFolder(folder);
    if (this.data.settings.autoSeedFromManifest) await this.seedFromManifests(false);
    await this.flushSave();
    await this.saveData(this.data);
    if (forceRefresh) this.refreshExplorer();
  }
  reconcileFolder(folder) {
    const sortable = folder.children.filter((child) => isMarkdown(child) || child instanceof import_obsidian.TFolder);
    const childGuids = sortable.map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    const uniqueChildGuids = [...new Set(childGuids)];
    const key = this.folderKeySync(folder);
    const previous = this.data.orderByFolder[key] || [];
    const existing = previous.filter((guid) => uniqueChildGuids.includes(guid));
    const missing = uniqueChildGuids.filter((guid) => !existing.includes(guid));
    if (!previous.length) {
      const byName = sortable.slice().sort((a, b) => a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" }));
      this.data.orderByFolder[key] = byName.map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    } else if (missing.length) {
      this.data.orderByFolder[key] = this.data.settings.newItemPlacement === "top" ? [...missing, ...existing] : [...existing, ...missing];
    } else {
      this.data.orderByFolder[key] = existing;
    }
  }
  async ensureFileGuid(file) {
    const cached = this.guidByPath.get(file.path);
    if (cached) return cached;
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
    if (isMarkdown(folderNote)) {
      const guid = await this.ensureFileGuid(folderNote);
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
    if (isMarkdown(item)) {
      return this.guidByPath.get(item.path) || this.readCachedFrontmatterGuid(item);
    }
    if (item instanceof import_obsidian.TFolder) return this.data.folderGuids[item.path] || null;
    return null;
  }
  sortFolderItems(folderPath, items) {
    const folder = !folderPath || folderPath === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folderPath);
    const key = folder instanceof import_obsidian.TFolder ? this.folderKeySync(folder) : ROOT_FOLDER_KEY;
    const saved = this.data.orderByFolder[key] || [];
    const sortable = items.filter((item) => item instanceof import_obsidian.TFolder || isMarkdown(item));
    const unsupported = items.filter((item) => !(item instanceof import_obsidian.TFolder || isMarkdown(item)));
    return [
      ...sortEntries(
        sortable,
        saved,
        (item) => this.getItemGuidSync(item),
        this.data.settings.fallbackSort
      ),
      ...unsupported
    ];
  }
  async handleCreate(file) {
    if (!this.app.workspace.layoutReady) return;
    if (isMarkdown(file)) {
      const guid = await this.ensureFileGuid(file);
      if (file.parent) await this.ensureFolderGuid(file.parent);
      this.addGuidToFolder(file.parent, guid);
    } else if (file instanceof import_obsidian.TFolder) {
      const guid = await this.ensureFolderGuid(file);
      if (guid) this.addGuidToFolder(file.parent, guid);
    }
    this.queueSave();
    if (this.data.settings.autoSeedFromManifest) await this.seedFromManifests(false);
    this.refreshExplorer();
  }
  async handleDelete(file) {
    if (!this.app.workspace.layoutReady) return;
    if (isMarkdown(file)) {
      const guid = this.guidByPath.get(file.path) || this.readCachedFrontmatterGuid(file);
      if (guid) removeGuidFromOrders(this.data.orderByFolder, guid);
      this.guidByPath.delete(file.path);
    } else if (file instanceof import_obsidian.TFolder) {
      const prefix = `${file.path}/`;
      const oldGuid = this.data.folderGuids[file.path];
      Object.keys(this.data.folderGuids).forEach((path) => {
        if (path === file.path || path.startsWith(prefix)) delete this.data.folderGuids[path];
      });
      if (oldGuid) delete this.data.orderByFolder[oldGuid];
    }
    this.queueSave();
    this.refreshExplorer();
  }
  async handleRename(file, oldPath) {
    var _a;
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof import_obsidian.TFolder) {
      const prefix = `${oldPath}/`;
      const updates = [];
      Object.entries(this.data.folderGuids).forEach(([path, guid]) => {
        if (path === oldPath || path.startsWith(prefix)) {
          const nextPath = path === oldPath ? file.path : `${file.path}${path.slice(oldPath.length)}`;
          updates.push([path, nextPath, guid]);
        }
      });
      updates.forEach(([from, to, guid]) => {
        delete this.data.folderGuids[from];
        this.data.folderGuids[to] = guid;
      });
    } else if (isMarkdown(file)) {
      const guid = this.guidByPath.get(oldPath) || this.readCachedFrontmatterGuid(file);
      this.guidByPath.delete(oldPath);
      if (guid) {
        this.guidByPath.set(file.path, guid);
        const oldParent = parentPath(oldPath);
        const newParent = ((_a = file.parent) == null ? void 0 : _a.path) || "";
        if (oldParent !== newParent) {
          removeGuidFromOrders(this.data.orderByFolder, guid);
          if (file.parent) await this.ensureFolderGuid(file.parent);
          this.addGuidToFolder(file.parent, guid);
        }
      }
    }
    this.queueSave();
    this.refreshExplorer();
  }
  async handleModify(file) {
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof import_obsidian.TFile && basename(file.path) === MANIFEST_NAME) {
      if (this.data.settings.autoSeedFromManifest) await this.seedFromManifests(false);
    }
  }
  addGuidToFolder(folder, guid) {
    const key = this.folderKeySync(folder);
    const order = this.data.orderByFolder[key] || [];
    if (order.includes(guid)) return;
    this.data.orderByFolder[key] = this.data.settings.newItemPlacement === "top" ? [guid, ...order] : [...order, guid];
  }
  async seedFromManifests(force) {
    await this.seedFromManifestsInternal(force);
  }
  async seedFromManifestsInternal(force) {
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      if (force) new import_obsidian.Notice("\u672A\u627E\u5230 _yuque_order.json");
      return;
    }
    const all = this.app.vault.getAllLoadedFiles();
    const byGuid = /* @__PURE__ */ new Map();
    const folderByGuid = /* @__PURE__ */ new Map();
    all.forEach((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return;
      if (item instanceof import_obsidian.TFolder) folderByGuid.set(guid, item);
      else if (isMarkdown(item)) byGuid.set(guid, item);
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
      const signature = `logical-folder-note-v3:${raw.generatedAt || ""}:${text.length}:${text.slice(0, 80)}`;
      const manifestGuids = [];
      const collectGuids = (nodes) => nodes.forEach((node) => {
        const guid = normalizeGuid(node == null ? void 0 : node.guid);
        if (guid) manifestGuids.push(guid);
        if (Array.isArray(node == null ? void 0 : node.children)) collectGuids(node.children);
      });
      collectGuids(raw.tree);
      const hasUnmatchedItems = manifestGuids.some((guid) => !byGuid.has(guid) && !folderByGuid.has(guid));
      if (!force && this.data.manifestSignatures[manifestFile.path] === signature && !hasUnmatchedItems) continue;
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
      this.data.manifestSignatures[manifestFile.path] = signature;
    }
    if (seeded) {
      await this.flushSave();
      await this.saveData(this.data);
      this.refreshExplorer();
      if (force || !this.autoSeedNoticeShown) {
        this.autoSeedNoticeShown = true;
        new import_obsidian.Notice("\u5DF2\u4ECE\u8BED\u96C0\u6E05\u5355\u5BFC\u5165\u987A\u5E8F");
      }
    } else if (force && !this.manifestNoticeShown) {
      this.manifestNoticeShown = true;
      new import_obsidian.Notice("\u987A\u5E8F\u6E05\u5355\u6CA1\u6709\u53EF\u5339\u914D\u7684\u6587\u6863\uFF0C\u5DF2\u4FDD\u7559\u73B0\u6709\u987A\u5E8F");
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
      if (!item || this.pathFromElement(item) === this.dragSourcePath) return;
      event.preventDefault();
      document.querySelectorAll(".yq-order-drag-over").forEach((el) => el.classList.remove("yq-order-drag-over"));
      item.classList.add("yq-order-drag-over");
    }, true);
    this.registerDomEvent(document, "drop", (event) => {
      if (!this.dragSourcePath) return;
      const target = this.explorerItem(event.target);
      if (!target) return;
      event.preventDefault();
      void this.handleDrop(this.dragSourcePath, this.pathFromElement(target), event.clientY, target);
      this.clearDragState();
    }, true);
    this.registerDomEvent(document, "dragend", () => this.clearDragState(), true);
  }
  clearDragState() {
    this.dragSourcePath = "";
    document.querySelectorAll(".yq-order-drag-source, .yq-order-drag-over").forEach((el) => {
      el.classList.remove("yq-order-drag-source", "yq-order-drag-over");
    });
  }
  async handleDrop(sourcePath, targetPath, clientY, targetEl) {
    var _a, _b, _c;
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!source || !target || source.path === target.path) return;
    const rect = targetEl.getBoundingClientRect();
    const ratio = rect.height ? (clientY - rect.top) / rect.height : 0.5;
    let targetFolder = target instanceof import_obsidian.TFolder ? target : target instanceof import_obsidian.TFile && ratio > 0.25 && ratio < 0.75 ? this.findFolderForNote(target) : null;
    if (!targetFolder && target instanceof import_obsidian.TFile && isMarkdown(target) && ratio > 0.25 && ratio < 0.75) {
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
    if (((_a = source.parent) == null ? void 0 : _a.path) !== ((_b = target.parent) == null ? void 0 : _b.path)) return;
    const sourceGuid = this.getItemGuidSync(source);
    const targetGuid = this.getItemGuidSync(target);
    if (!sourceGuid || !targetGuid || !source.parent) return;
    const key = this.folderKeySync(source.parent);
    const fallbackOrder = source.parent.children.filter((child) => child instanceof import_obsidian.TFolder || isMarkdown(child)).map((child) => this.getItemGuidSync(child)).filter((guid) => Boolean(guid));
    const currentOrder = ((_c = this.data.orderByFolder[key]) == null ? void 0 : _c.length) ? this.data.orderByFolder[key] : fallbackOrder;
    this.data.orderByFolder[key] = moveGuid(currentOrder, sourceGuid, targetGuid, ratio < 0.5);
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
    new import_obsidian.Setting(containerEl).setName("\u81EA\u52A8\u5BFC\u5165\u8BED\u96C0\u6E05\u5355").setDesc("\u68C0\u6D4B\u5230\u65B0\u7684\u6216\u66F4\u65B0\u8FC7\u7684 _yuque_order.json \u65F6\u81EA\u52A8\u64AD\u79CD\uFF1B\u4E0D\u4F1A\u5728\u6BCF\u6B21\u542F\u52A8\u65F6\u8986\u76D6\u5DF2\u62D6\u62FD\u987A\u5E8F\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.autoSeedFromManifest).onChange(async (value) => {
      this.plugin.data.settings.autoSeedFromManifest = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u589E\u5220\u540E\u7ACB\u5373\u6301\u4E45\u5316").setDesc("\u5173\u95ED\u53EF\u51CF\u5C11 Obsidian Sync \u51B2\u7A81\uFF1B\u62D6\u62FD\u6392\u5E8F\u4ECD\u4F1A\u4FDD\u5B58\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.persistOrderOnCreateDelete).onChange(async (value) => {
      this.plugin.data.settings.persistOrderOnCreateDelete = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u542F\u7528\u6587\u4EF6\u6811\u62D6\u62FD").setDesc("\u540C\u7EA7\u62D6\u62FD\u8C03\u6574\u987A\u5E8F\uFF1B\u62D6\u5230\u6587\u4EF6\u5939\u6216\u6587\u4EF6\u5939\u7B14\u8BB0\u53EF\u79FB\u52A8\u5230\u5B50\u76EE\u5F55\u3002").addToggle((toggle) => toggle.setValue(this.plugin.data.settings.enableDrag).onChange(async (value) => {
      this.plugin.data.settings.enableDrag = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u624B\u52A8\u5BFC\u5165/\u91CD\u540C\u6B65").setDesc("\u6309\u5F53\u524D vault \u4E2D\u7684 _yuque_order.json \u5F3A\u5236\u6062\u590D\u8BED\u96C0\u76EE\u5F55\u987A\u5E8F\u3002").addButton((button) => button.setButtonText("\u7ACB\u5373\u5BFC\u5165").onClick(() => void this.plugin.seedFromManifests(true)));
  }
};
