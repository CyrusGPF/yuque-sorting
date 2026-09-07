import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import {
  InventoryComparison,
  InventoryEntry,
  ROOT_FOLDER_KEY,
  SortableEntry,
  compareInventories,
  detachFolderNoteFromOrder,
  folderIdentityPathForNote,
  insertGuid,
  migratePathMappings,
  moveGuid,
  normalizeGuid,
  purgeFolderGuidsFromOrders,
  reconcileOrderNonDestructive,
  removeGuidFromOrders,
  relocateGuid,
  replaceGuidInOrders,
  sanitizePortableName,
  sortEntries,
} from "./src/order-utils";
import { DropPosition, dropPositionForPointer } from "./src/drag-utils";

const MANIFEST_NAME = "_yuque_order.json";

interface OrderSettings {
  orderFrontmatterKey: string;
  newItemPlacement: "top" | "bottom";
  fallbackSort: "name" | "name-last";
  persistOrderOnCreateDelete: boolean;
  enableDrag: boolean;
}

interface OrderData {
  version: 1;
  settings: OrderSettings;
  orderByFolder: Record<string, string[]>;
  folderGuids: Record<string, string>;
  fileGuids: Record<string, string>;
}

interface PendingDropPlacement {
  parentPath: string;
  targetGuid: string;
  before: boolean;
}

const DEFAULT_SETTINGS: OrderSettings = {
  orderFrontmatterKey: "guid",
  newItemPlacement: "bottom",
  fallbackSort: "name-last",
  persistOrderOnCreateDelete: true,
  enableDrag: true,
};

function isMarkdown(file: TAbstractFile | null): boolean {
  return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function stripMarkdown(path: string): string {
  return path.replace(/\.md$/i, "");
}

function createGuid(prefix = "obs"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

interface ManifestCheckReport extends InventoryComparison {
  invalidManifests: string[];
}

function manifestIssueCount(report: ManifestCheckReport): number {
  return report.missing.length
    + report.extra.length
    + report.moved.length
    + report.duplicateManifestGuids.length
    + report.duplicateActualGuids.length
    + report.invalidManifests.length;
}

class ManifestImportConfirmModal extends Modal {
  private settled = false;

  constructor(app: App, private report: ManifestCheckReport, private resolveChoice: (choice: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("语雀顺序清单与当前库不一致");
    this.contentEl.createEl("p", {
      text: "继续导入只会调整能够匹配的项目顺序，不会创建、删除或移动文件。请确认是否继续。",
    });
    const groups: Array<[string, string[]]> = [
      ["清单中有、当前库缺失", this.report.missing.map((entry) => entry.label)],
      ["当前库多出的项目", this.report.extra.map((entry) => entry.label)],
      ["所在目录与清单不符", this.report.moved.map(({ actual }) => actual.label)],
      ["清单中的重复 GUID", this.report.duplicateManifestGuids],
      ["当前库中的重复 GUID", this.report.duplicateActualGuids],
      ["无法读取的清单", this.report.invalidManifests],
    ];
    groups.forEach(([title, items]) => {
      if (!items.length) return;
      this.contentEl.createEl("h4", { text: `${title}（${items.length}）` });
      const list = this.contentEl.createEl("ul");
      items.slice(0, 8).forEach((item) => list.createEl("li", { text: item }));
      if (items.length > 8) list.createEl("li", { text: `另有 ${items.length - 8} 项……` });
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("放弃").onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText("仍然导入").setWarning().onClick(() => this.finish(true)));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolveChoice(false);
  }

  private finish(choice: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveChoice(choice);
    this.close();
  }
}

export default class YqOrderDragPlugin extends Plugin {
  data!: OrderData;
  private guidByPath = new Map<string, string>();
  private guidPromises = new Map<string, Promise<string>>();
  private saveTimer: number | null = null;
  private savePromise: Promise<void> = Promise.resolve();
  private explorerView: any = null;
  private restoreExplorerPatch: (() => void) | null = null;
  private domOrderFrame: number | null = null;
  private explorerSetup = false;
  private manifestNoticeShown = false;
  private dragSourcePath = "";
  private dragHintEl: HTMLElement | null = null;
  private pendingDropPlacements = new Map<string, PendingDropPlacement>();

  async onload(): Promise<void> {
    this.data = this.normalizeData((await this.loadData()) as Partial<OrderData> | null);

    this.registerEvent(this.app.vault.on("create", (file) => void this.handleCreate(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.handleDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.handleRename(file, oldPath)));

    this.addCommand({
      id: "import-yuque-order-manifest",
      name: "导入/重同步语雀顺序清单",
      callback: () => void this.requestManifestImport(),
    });
    this.addCommand({
      id: "refresh-yuque-order",
      name: "刷新语雀式文件顺序",
      callback: () => void this.reconcileVault(true),
    });
    this.addSettingTab(new YqOrderSettingTab(this.app, this));

    // Defer vault-wide reconciliation to onLayoutReady. Obsidian finishes
    // indexing the vault as part of startup, and on a slow first load (or a
    // synced vault) getAllLoadedFiles() can still return only the root
    // folder while onload() runs. Running reconcileVault() on such a partial
    // snapshot used to prune every persisted folder identity and order list,
    // wiping the plugin state on startup. layoutReady is Obsidian's
    // guarantee that the workspace (and vault index) is fully initialized.
    this.app.workspace.onLayoutReady(() => void this.boot());
  }

  private async boot(): Promise<void> {
    await this.reconcileVault(false);
    this.setupExplorer();
    this.refreshExplorer();
  }

  onunload(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.domOrderFrame !== null) window.cancelAnimationFrame(this.domOrderFrame);
    this.restoreExplorerPatch?.();
    this.restoreExplorerPatch = null;
  }

  normalizeData(saved: Partial<OrderData> | null): OrderData {
    const savedSettings = (saved?.settings || {}) as Partial<OrderSettings>;
    const supportedSettings: Partial<OrderSettings> = {};
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
    const orderByFolder = saved?.orderByFolder && typeof saved.orderByFolder === "object"
      ? saved.orderByFolder
      : {};
    Object.keys(orderByFolder).forEach((key) => {
      if (!Array.isArray(orderByFolder[key])) orderByFolder[key] = [];
    });
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...supportedSettings },
      orderByFolder,
      folderGuids: saved?.folderGuids && typeof saved.folderGuids === "object" ? saved.folderGuids : {},
      fileGuids: saved?.fileGuids && typeof saved.fileGuids === "object" ? saved.fileGuids : {},
    };
  }

  private queueSave(force = false): void {
    if (!force && !this.data.settings.persistOrderOnCreateDelete) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.savePromise = this.savePromise.then(() => this.saveData(this.data));
    }, 250);
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.savePromise = this.savePromise.then(() => this.saveData(this.data));
    }
    await this.savePromise;
  }

  async saveSettings(): Promise<void> {
    await this.flushSave();
    await this.saveData(this.data);
  }

  async reconcileVault(forceRefresh: boolean): Promise<void> {
    const all = this.app.vault.getAllLoadedFiles();
    const files = all.filter((file): file is TFile => file instanceof TFile);
    const folders = all.filter((file): file is TFolder => file instanceof TFolder);

    // A snapshot that contains nothing but the root folder means the vault
    // index is still populating. Never touch (or save) state in that case:
    // the cleanup below would delete every persisted folder identity/order.
    if (all.length <= 1) return;

    for (const file of files) await this.ensureFileGuid(file);
    for (const folder of folders) await this.ensureFolderGuid(folder);

    // Do not prune identities from a startup snapshot. On synced or large
    // vaults, layoutReady can still precede the final wave of indexed files;
    // pruning here would turn late arrivals into new bottom-placed items.
    // Confirmed delete events perform the destructive cleanup instead.
    for (const folder of folders) this.reconcileFolder(folder);
    await this.flushSave();
    // The full scan also creates folder identities and initial order lists;
    // persist that reconciliation even when event persistence is disabled.
    await this.saveData(this.data);
    if (forceRefresh) this.refreshExplorer();
  }

  private reconcileFolder(folder: TFolder): void {
    const sortable = folder.children.filter((child) => child instanceof TFile || child instanceof TFolder);
    const childGuids = sortable.map((child) => this.getItemGuidSync(child)).filter((guid): guid is string => Boolean(guid));
    const uniqueChildGuids = [...new Set(childGuids)];
    const key = this.folderKeySync(folder);
    const previous = this.data.orderByFolder[key] || [];
    const byName = sortable.slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
      .map((child) => this.getItemGuidSync(child))
      .filter((guid): guid is string => Boolean(guid));
    this.data.orderByFolder[key] = reconcileOrderNonDestructive(
      previous, uniqueChildGuids, byName, this.data.settings.newItemPlacement,
    );
  }

  private async ensureFileGuid(file: TFile): Promise<string> {
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
        } catch {
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

  private readCachedFrontmatterGuid(file: TFile): string | null {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.data.settings.orderFrontmatterKey];
    return normalizeGuid(value);
  }

  private readGuidFromText(text: string): string | null {
    const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const key = this.data.settings.orderFrontmatterKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const field = match[1].match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, "m"));
    return normalizeGuid(field?.[1]?.replace(/^['\"]|['\"]$/g, ""));
  }

  private async writeFileGuid(file: TFile, guid: string): Promise<void> {
    const key = this.data.settings.orderFrontmatterKey;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (!normalizeGuid(frontmatter[key])) frontmatter[key] = guid;
      });
      return;
    } catch {
      await this.app.vault.process(file, (text) => {
        if (this.readGuidFromText(text)) return text;
        return `---\n${key}: ${guid}\n---\n\n${text}`;
      });
    }
  }

  private async ensureFolderGuid(folder: TFolder): Promise<string | null> {
    if (!folder.path) return null;
    // Yuque exports a child document note beside its child directory, e.g.
    // Parent/Doc.md + Parent/Doc/<children>. Treat that sibling note as the
    // identity of the Doc folder when the note is not inside the folder.
    const ownNote = this.app.vault.getAbstractFileByPath(`${folder.path}/${basename(folder.path)}.md`);
    const siblingNotePath = `${folder.parent?.path ? `${folder.parent.path}/` : ""}${basename(folder.path)}.md`;
    const siblingNote = this.app.vault.getAbstractFileByPath(siblingNotePath);
    const folderNote = isMarkdown(ownNote) ? ownNote : siblingNote;
    if (folderNote instanceof TFile && isMarkdown(folderNote)) {
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

  private folderKeySync(folder: TFolder | null): string {
    if (!folder) return ROOT_FOLDER_KEY;
    if (!folder.path) return ROOT_FOLDER_KEY;
    if (folder.path === "/") return this.data.folderGuids["/"] || ROOT_FOLDER_KEY;
    return this.data.folderGuids[folder.path] || ROOT_FOLDER_KEY;
  }

  private getItemGuidSync(item: TAbstractFile): string | null {
    if (item instanceof TFile) {
      return this.guidByPath.get(item.path)
        || (isMarkdown(item) ? this.readCachedFrontmatterGuid(item) : this.data.fileGuids[item.path])
        || null;
    }
    if (item instanceof TFolder) return this.data.folderGuids[item.path] || null;
    return null;
  }

  sortFolderItems(folderPath: string, items: any[]): any[] {
    // Obsidian's root folder is represented by an empty path in some
    // versions and by "/" in others. Resolve it explicitly so the root order
    // does not accidentally fall back to ROOT_FOLDER_KEY.
    const folder = !folderPath || folderPath === "/"
      ? this.app.vault.getRoot()
      : this.app.vault.getAbstractFileByPath(folderPath);
    const key = folder instanceof TFolder ? this.folderKeySync(folder) : ROOT_FOLDER_KEY;
    const saved = this.data.orderByFolder[key] || [];
    const sortable = items.filter((item) => item instanceof TFolder || item instanceof TFile);
    return sortEntries(
      sortable as SortableEntry[],
      saved,
      (item: any) => this.getItemGuidSync(item as TAbstractFile),
      this.data.settings.fallbackSort,
    );
  }

  private async handleCreate(file: TAbstractFile): Promise<void> {
    // Obsidian's vault initialization fires `create` for every file in the
    // vault before the workspace layout is ready (see the official docs on
    // plugin load time). Reacting to those startup events made this plugin
    // run a manifest re-seed + explorer refresh once per file, and every
    // re-seed showed its own "已从语雀清单导入顺序" Notice.
    // `reconcileVault()` below already scans every file/folder at startup,
    // so ignore vault events until the layout is ready.
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof TFile) {
      const guid = await this.ensureFileGuid(file);
      if (file.parent) await this.ensureFolderGuid(file.parent);
      this.addGuidToFolder(file.parent, guid);
    } else if (file instanceof TFolder) {
      const guid = await this.ensureFolderGuid(file);
      if (guid) this.addGuidToFolder(file.parent, guid);
    }
    this.queueSave();
    this.refreshExplorer();
  }

  private async handleDelete(file: TAbstractFile): Promise<void> {
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof TFile) {
      const guid = this.guidByPath.get(file.path)
        || (isMarkdown(file) ? this.readCachedFrontmatterGuid(file) : this.data.fileGuids[file.path]);
      const identityFolderPath = isMarkdown(file) && guid
        ? folderIdentityPathForNote(file.path, this.data.folderGuids, guid)
        : null;
      if (guid && identityFolderPath) {
        // The note disappeared, but its folder still owns this stable GUID.
        // Keep the parent's reference and only remove a possible hidden
        // self-entry from the folder's own child order.
        detachFolderNoteFromOrder(this.data.orderByFolder, guid);
      } else if (guid) {
        removeGuidFromOrders(this.data.orderByFolder, guid);
      }
      this.guidByPath.delete(file.path);
      if (!isMarkdown(file)) delete this.data.fileGuids[file.path];
    } else if (file instanceof TFolder) {
      const prefix = `${file.path}/`;
      const deletedFolderGuids = new Set<string>();
      Object.keys(this.data.folderGuids).forEach((path) => {
        if (path === file.path || path.startsWith(prefix)) {
          const guid = this.data.folderGuids[path];
          if (guid) deletedFolderGuids.add(guid);
          delete this.data.folderGuids[path];
        }
      });
      // Do not rely on child delete events: Obsidian can report a deleted
      // folder as one event, or report its descendants in either order.
      const collectDescendantGuids = (item: TAbstractFile): void => {
        if (item instanceof TFile) {
          const guid = this.getItemGuidSync(item);
          if (guid) deletedFolderGuids.add(guid);
          this.guidByPath.delete(item.path);
          if (!isMarkdown(item)) delete this.data.fileGuids[item.path];
        } else if (item instanceof TFolder) {
          item.children.forEach(collectDescendantGuids);
        }
      };
      file.children.forEach(collectDescendantGuids);
      purgeFolderGuidsFromOrders(this.data.orderByFolder, deletedFolderGuids);
    }
    this.queueSave();
    this.refreshExplorer();
  }

  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof TFolder) {
      const movedGuid = this.data.folderGuids[oldPath];
      const oldParent = parentPath(oldPath);
      migratePathMappings(this.data.folderGuids, oldPath, file.path);
      const fileUpdates = migratePathMappings(this.data.fileGuids, oldPath, file.path);
      fileUpdates.forEach(([from, to, guid]) => {
        this.guidByPath.delete(from);
        this.guidByPath.set(to, guid);
      });
      const newParent = file.parent?.path || "";
      if (movedGuid && oldParent !== newParent) {
        if (file.parent) await this.ensureFolderGuid(file.parent);
        const pending = this.pendingDropPlacements.get(movedGuid);
        if (pending?.parentPath === newParent) {
          this.pendingDropPlacements.delete(movedGuid);
          this.placeGuidRelative(file.parent, movedGuid, pending.targetGuid, pending.before);
        } else {
          relocateGuid(
            this.data.orderByFolder,
            this.folderKeySync(file.parent),
            movedGuid,
            this.data.settings.newItemPlacement,
          );
        }
      }
    } else if (file instanceof TFile) {
      const guid = this.guidByPath.get(oldPath)
        || (isMarkdown(file) ? this.readCachedFrontmatterGuid(file) : this.data.fileGuids[oldPath]);
      this.guidByPath.delete(oldPath);
      if (guid) {
        this.guidByPath.set(file.path, guid);
        if (!isMarkdown(file)) {
          delete this.data.fileGuids[oldPath];
          this.data.fileGuids[file.path] = guid;
        }
        const oldParent = parentPath(oldPath);
        const newParent = file.parent?.path || "";
        if (oldParent !== newParent) {
          if (file.parent) await this.ensureFolderGuid(file.parent);
          const pending = this.pendingDropPlacements.get(guid);
          if (pending?.parentPath === newParent) {
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

  private addGuidToFolder(folder: TFolder | null, guid: string): void {
    const key = this.folderKeySync(folder);
    const order = this.data.orderByFolder[key] || [];
    this.data.orderByFolder[key] = insertGuid(order, guid, this.data.settings.newItemPlacement);
  }

  private placeGuidRelative(folder: TFolder | null, guid: string, targetGuid: string, before: boolean): void {
    const key = this.folderKeySync(folder);
    relocateGuid(this.data.orderByFolder, key, guid, this.data.settings.newItemPlacement);
    this.data.orderByFolder[key] = moveGuid(this.data.orderByFolder[key], guid, targetGuid, before);
  }

  async requestManifestImport(): Promise<void> {
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      new Notice("未找到 _yuque_order.json");
      return;
    }
    const report = await this.inspectManifestConsistency(manifests);
    if (manifestIssueCount(report) > 0) {
      const proceed = await new Promise<boolean>((resolve) => {
        new ManifestImportConfirmModal(this.app, report, resolve).open();
      });
      if (!proceed) {
        new Notice("已放弃导入语雀顺序清单");
        return;
      }
    }
    this.manifestNoticeShown = false;
    await this.seedFromManifests();
  }

  private async inspectManifestConsistency(manifests: TFile[]): Promise<ManifestCheckReport> {
    const report: ManifestCheckReport = {
      missing: [],
      extra: [],
      moved: [],
      duplicateManifestGuids: [],
      duplicateActualGuids: [],
      invalidManifests: [],
    };
    const all = this.app.vault.getAllLoadedFiles();
    const byGuid = new Map<string, TAbstractFile>();
    const folderByGuid = new Map<string, TFolder>();
    all.forEach((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return;
      if (item instanceof TFolder) folderByGuid.set(guid, item);
      else if (item instanceof TFile) byGuid.set(guid, item);
    });

    for (const manifestFile of manifests) {
      let raw: any;
      try {
        raw = JSON.parse(await this.app.vault.read(manifestFile));
      } catch {
        report.invalidManifests.push(`${manifestFile.path}：JSON 无法解析`);
        continue;
      }
      if (raw?.version !== 1 || !Array.isArray(raw.tree)) {
        report.invalidManifests.push(`${manifestFile.path}：版本或 tree 格式无效`);
        continue;
      }

      const manifestEntries: InventoryEntry[] = [];
      const manifestGuids: string[] = [];
      const collect = (nodes: any[], parentGuid: string, trail: string): void => {
        nodes.forEach((node) => {
          const guid = normalizeGuid(node?.guid);
          if (!guid) return;
          const title = String(node?.title || guid);
          const label = trail ? `${trail}/${title}` : `${manifestFile.parent?.path || ""}/${title}`;
          manifestEntries.push({ guid, parentGuid, label });
          manifestGuids.push(guid);
          if (Array.isArray(node?.children)) collect(node.children, guid, label);
        });
      };
      collect(raw.tree, ROOT_FOLDER_KEY, "");

      // Resolve empty-body parent folders by name without changing plugin data.
      const folderAliases = new Map<string, string>();
      const adoptedFolderPaths = new Set<string>();
      const manifestGuidSet = new Set(manifestGuids);
      const resolveTree = (nodes: any[], fallbackFolder: TFolder | null): void => {
        nodes.forEach((node) => {
          const guid = normalizeGuid(node?.guid);
          if (!guid) return;
          let item = byGuid.get(guid) || folderByGuid.get(guid) || null;
          if (!item) {
            const folder = this.matchManifestNodeToFolder(
              fallbackFolder, node, adoptedFolderPaths, manifestGuidSet,
            );
            if (folder) {
              folderAliases.set(folder.path, guid);
              folderByGuid.set(guid, folder);
              item = folder;
            }
          }
          const logicalItem = folderByGuid.get(guid)
            || (item instanceof TFile ? this.findFolderForNote(item) : null)
            || item;
          const childFolder = logicalItem instanceof TFolder
            ? logicalItem
            : logicalItem?.parent || fallbackFolder;
          if (Array.isArray(node?.children)) resolveTree(node.children, childFolder);
        });
      };
      resolveTree(raw.tree, manifestFile.parent);

      const logicalItems = new Map<string, TAbstractFile>();
      const rootPath = manifestFile.parent?.path || "";
      const prefix = rootPath ? `${rootPath}/` : "";
      all.forEach((item) => {
        if (!(item instanceof TFolder || item instanceof TFile)) return;
        if (item === manifestFile || item.path === rootPath) return;
        if (prefix && !item.path.startsWith(prefix)) return;
        const guid = this.getItemGuidSync(item);
        if (!guid) return;
        let logicalItem: TAbstractFile = item;
        if (item instanceof TFile && isMarkdown(item)) {
          const ownFolder = item.parent && item.basename === item.parent.name ? item.parent : null;
          logicalItem = ownFolder || this.findFolderForNote(item) || item;
        }
        logicalItems.set(logicalItem.path, logicalItem);
      });
      const actualEntries: InventoryEntry[] = [...logicalItems.values()].map((item) => {
        const originalGuid = this.getItemGuidSync(item) || `path:${item.path}`;
        const guid = folderAliases.get(item.path) || originalGuid;
        const parent = item.parent;
        const parentGuid = !parent || parent.path === rootPath
          ? ROOT_FOLDER_KEY
          : folderAliases.get(parent.path) || this.getItemGuidSync(parent) || `path:${parent.path}`;
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

  private async seedFromManifests(): Promise<void> {
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      new Notice("未找到 _yuque_order.json");
      return;
    }

    const all = this.app.vault.getAllLoadedFiles();
    const byGuid = new Map<string, TAbstractFile>();
    const folderByGuid = new Map<string, TFolder>();
    all.forEach((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return;
      if (item instanceof TFolder) folderByGuid.set(guid, item);
      else if (item instanceof TFile) byGuid.set(guid, item);
    });

    let seeded = 0;
    // V1 规则 2 兜底：已按目录名匹配并采用语雀 guid 的目录路径（同一目录只认领一次）。
    const adoptedFolderPaths = new Set<string>();
    for (const manifestFile of manifests) {
      let raw: any;
      let text: string;
      try {
        text = await this.app.vault.read(manifestFile);
        raw = JSON.parse(text);
      } catch {
        continue;
      }
      if (raw?.version !== 1 || !Array.isArray(raw.tree)) continue;
      const manifestGuids: string[] = [];
      const collectGuids = (nodes: any[]) => nodes.forEach((node) => {
        const guid = normalizeGuid(node?.guid);
        if (guid) manifestGuids.push(guid);
        if (Array.isArray(node?.children)) collectGuids(node.children);
      });
      collectGuids(raw.tree);

      const desired = new Map<string, string[]>();
      const append = (key: string, guid: string) => {
        const list = desired.get(key) || [];
        if (!list.includes(guid)) list.push(guid);
        desired.set(key, list);
      };
      const visit = (nodes: any[], fallbackFolder: TFolder | null): void => {
        nodes.forEach((node) => {
          const guid = normalizeGuid(node?.guid);
          if (!guid) return;
          const item = byGuid.get(guid) || folderByGuid.get(guid) || null;
          if (!item) {
            // V1 规则 2：空正文父级文档只有目录、没有同名笔记文件，guid 匹配不到。
            // 按"目录名"兜底匹配（同名去重后目录名可能是 原名 或 原名-N），
            // 把语雀 guid 赋予该目录，使其回到 manifest 中的语雀位置。
            const folder = this.matchManifestNodeToFolder(
              fallbackFolder, node, adoptedFolderPaths, new Set(manifestGuids),
            );
            if (folder) {
              this.data.folderGuids[folder.path] = guid;
              folderByGuid.set(guid, folder);
              const parentFolder = folder.parent || fallbackFolder;
              const key = this.folderKeySync(parentFolder);
              append(key, guid);
              if (Array.isArray(node.children) && node.children.length) visit(node.children, folder);
              return;
            }
            // Do not persist manifest-only identities when their files do not exist.
            if (Array.isArray(node.children) && node.children.length) visit(node.children, fallbackFolder);
            return;
          }
          // In folder-note mode, `文档1/文档1.md` represents the `文档1`
          // folder itself. Its parent is therefore the folder containing that
          // folder, not the folder containing the note file.
          const logicalItem = folderByGuid.get(guid)
            || (item instanceof TFile ? this.findFolderForNote(item) : null)
            || item;
          const parentFolder = logicalItem.parent || fallbackFolder;
          const key = this.folderKeySync(parentFolder);
          append(key, guid);

          const childFolder = logicalItem instanceof TFolder ? logicalItem : parentFolder;
          if (Array.isArray(node.children) && node.children.length) visit(node.children, childFolder);
        });
      };
      visit(raw.tree, manifestFile.parent);

      // A previous seed may have placed a folder-note guid in the note's own
      // folder. Remove all manifest guids first so a resync also repairs those
      // stale entries before applying the desired tree order.
      const manifestGuidSet = new Set(manifestGuids);
      Object.keys(this.data.orderByFolder).forEach((key) => {
        this.data.orderByFolder[key] = (this.data.orderByFolder[key] || [])
          .filter((guid) => !manifestGuidSet.has(guid));
      });
      desired.forEach((wanted, key) => {
        const old = this.data.orderByFolder[key] || [];
        const next = [...wanted, ...old];
        this.data.orderByFolder[key] = next;
        // Count real changes only: a re-seed over identical lists (e.g. files
        // arriving one by one during the startup create-event flood) must not
        // produce another Notice or another save/refresh.
        if (next.length !== old.length || next.some((guid, index) => guid !== old[index])) {
          seeded += 1;
        }
      });
    }

    if (seeded) {
      await this.flushSave();
      await this.saveData(this.data);
      this.refreshExplorer();
      new Notice("已从语雀清单导入顺序");
    } else {
      if (!this.manifestNoticeShown) {
        this.manifestNoticeShown = true;
        new Notice("顺序清单没有可匹配的文档，已保留现有顺序");
      }
    }
  }

  private findFolderForNote(file: TFile): TFolder | null {
    const folder = this.app.vault.getAbstractFileByPath(stripMarkdown(file.path));
    return folder instanceof TFolder ? folder : null;
  }

  /**
   * V1 规则 2 兜底：为空正文父级文档（只有目录、无同名笔记）按目录名匹配 manifest 节点。
   * 候选名 = sanitize(title) 精确名，其后顺带尝试 title-N（导出端同名去重后的形式）。
   * 同名组内"首个保留原名"由扫描顺序复现（manifest 前序遍历顺序 = 语雀目录序）。
   */
  private matchManifestNodeToFolder(
    fallbackFolder: TFolder | null,
    node: any,
    adoptedFolderPaths: Set<string>,
    manifestGuidSet: Set<string>,
  ): TFolder | null {
    const base = sanitizePortableName(node?.title);
    if (!base) return null;
    const scope = fallbackFolder
      ? fallbackFolder.children
      : this.app.vault.getRoot().children;
    const parentFolders = scope.filter((child): child is TFolder => child instanceof TFolder);
    const candidates: string[] = [base];
    for (let n = 1; n <= 64; n += 1) candidates.push(`${base}-${n}`);
    for (const name of candidates) {
      const folder = parentFolders.find((f) => f.name === name);
      if (!folder) continue;
      if (adoptedFolderPaths.has(folder.path)) continue;
      const existingGuid = this.data.folderGuids[folder.path];
      // 已被其它 manifest 节点（如正文父级）占用的目录跳过，避免抢占。
      if (existingGuid && manifestGuidSet.has(existingGuid)) continue;
      adoptedFolderPaths.add(folder.path);
      return folder;
    }
    return null;
  }

  private patchFileExplorer(): void {
    const view: any = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    if (!view || this.restoreExplorerPatch) return;
    this.explorerView = view;
    try {
      // Obsidian 1.13.x sorts File Explorer items through
      // FileExplorerView.getSortedFolderItems(). The older createFolderDom /
      // Folder.sort hook is not the method used by the current renderer.
      const prototype = Object.getPrototypeOf(view);
      if (!prototype || typeof prototype.getSortedFolderItems !== "function") {
        throw new Error("FileExplorerView.getSortedFolderItems unavailable");
      }
      const original = prototype.getSortedFolderItems;
      const plugin = this;
      prototype.getSortedFolderItems = function (folder: TFolder, ...args: any[]) {
        const result = original.call(this, folder, ...args);
        if (!Array.isArray(result)) return result;
        try {
          // The native method returns FileItem wrappers, not TAbstractFile
          // instances. Sort their underlying vault files and map the wrappers
          // back so Obsidian keeps its selection/collapse metadata intact.
          const files = result.map((entry: any) => entry?.file || entry);
          const sortedFiles = plugin.sortFolderItems(folder?.path || "", files);
          const itemsByPath = new Map<string, any>();
          result.forEach((entry: any) => {
            const file = entry?.file || entry;
            if (file?.path) itemsByPath.set(file.path, entry);
          });
          return sortedFiles
            .map((file: any) => itemsByPath.get(file.path))
            .filter((entry: any) => Boolean(entry));
        } catch {
          return result;
        }
      };
      this.restoreExplorerPatch = () => { prototype.getSortedFolderItems = original; };
    } catch (error) {
      if (!this.manifestNoticeShown) {
        this.manifestNoticeShown = true;
        console.warn("[Yuque Order Drag] FileExplorer patch unavailable; using default order.", error);
      }
    }
  }

  private setupExplorer(): void {
    if (this.explorerSetup) return;
    const view = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    const container = view?.containerEl
      || document.querySelector<HTMLElement>(".nav-files-container");
    if (!view || !container) {
      // The file-explorer sidebar can mount after startup (closed at boot,
      // still rendering, or reopened later). Wait for it like flexplorer
      // does, otherwise the sort patch never applies and the explorer stays
      // in Obsidian's default alphabetical order.
      const observer = new MutationObserver(() => {
        if (!this.app.workspace.getLeavesOfType("file-explorer")[0]?.view) return;
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

  private getExplorerContainer(): HTMLElement | null {
    return (this.explorerView?.containerEl as HTMLElement | undefined)
      || document.querySelector<HTMLElement>(".nav-files-container");
  }

  private explorerItem(target: EventTarget | null): HTMLElement | null {
    const element = target instanceof HTMLElement ? target.closest<HTMLElement>(".nav-file, .nav-folder") : null;
    if (!element) return null;
    const container = this.getExplorerContainer();
    return container?.contains(element) ? element : null;
  }

  private pathFromElement(element: HTMLElement): string {
    const directPath = element.dataset.path || element.getAttribute("data-path");
    if (directPath) return directPath;

    // Recent Obsidian versions place data-path on the title child instead of
    // the .nav-file/.nav-folder wrapper. Keep the lookup scoped to the item
    // so a folder never accidentally receives a nested child's path.
    const title = element.querySelector<HTMLElement>(
      ":scope > .nav-file-title, :scope > .nav-folder-title, :scope > [data-path]",
    );
    return title?.dataset.path || title?.getAttribute("data-path") || "";
  }

  private dropSurface(element: HTMLElement): HTMLElement {
    return element.querySelector<HTMLElement>(
      ":scope > .nav-file-title, :scope > .nav-folder-title",
    ) || element;
  }

  private canNestDrop(source: TAbstractFile, target: TAbstractFile): boolean {
    if (target instanceof TFolder) {
      return target !== source && !target.path.startsWith(`${source.path}/`);
    }
    return source instanceof TFile && isMarkdown(target);
  }

  private dropPosition(sourcePath: string, targetPath: string, clientY: number, targetEl: HTMLElement): DropPosition {
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    const surface = this.dropSurface(targetEl);
    const rect = surface.getBoundingClientRect();
    return dropPositionForPointer(
      clientY,
      rect.top,
      rect.height,
      Boolean(source && target && this.canNestDrop(source, target)),
    );
  }

  private showDropFeedback(targetEl: HTMLElement, position: DropPosition, clientX: number, clientY: number): void {
    this.clearDropTargets();
    targetEl.classList.add(`yq-order-drop-${position}`);

    if (!this.dragHintEl) {
      this.dragHintEl = document.createElement("div");
      this.dragHintEl.className = "yq-order-drag-hint";
      document.body.appendChild(this.dragHintEl);
    }
    const targetName = this.dropSurface(targetEl).textContent?.trim() || this.pathFromElement(targetEl);
    const action = position === "before" ? "插入到上方" : position === "after" ? "插入到下方" : "移入";
    this.dragHintEl.textContent = `${action}：${targetName}`;
    const hintRect = this.dragHintEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX + 14, window.innerWidth - hintRect.width - 8));
    const below = clientY + 18;
    const top = below + hintRect.height <= window.innerHeight - 8
      ? below
      : Math.max(8, clientY - hintRect.height - 14);
    this.dragHintEl.style.left = `${left}px`;
    this.dragHintEl.style.top = `${top}px`;
  }

  private clearDropTargets(): void {
    document.querySelectorAll(".yq-order-drop-before, .yq-order-drop-inside, .yq-order-drop-after")
      .forEach((element) => element.classList.remove(
        "yq-order-drop-before", "yq-order-drop-inside", "yq-order-drop-after",
      ));
  }

  private clearDropFeedback(): void {
    this.clearDropTargets();
    this.dragHintEl?.remove();
    this.dragHintEl = null;
  }

  private installDragHandlers(): void {
    const explorerContainer = this.getExplorerContainer() || undefined;
    if (explorerContainer) {
      const markDraggable = () => explorerContainer.querySelectorAll<HTMLElement>(".nav-file, .nav-folder")
        .forEach((element) => element.setAttribute("draggable", "true"));
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
        item,
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

  private clearDragState(): void {
    this.dragSourcePath = "";
    document.querySelectorAll(
      ".yq-order-drag-source, .yq-order-drop-before, .yq-order-drop-inside, .yq-order-drop-after",
    ).forEach((el) => {
      el.classList.remove(
        "yq-order-drag-source", "yq-order-drop-before", "yq-order-drop-inside", "yq-order-drop-after",
      );
    });
    this.clearDropFeedback();
  }

  private async handleDrop(sourcePath: string, targetPath: string, position: DropPosition): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!source || !target || source.path === target.path) return;
    let targetFolder = position === "inside" && target instanceof TFolder
      ? target
      : position === "inside" && target instanceof TFile
        ? this.findFolderForNote(target)
        : null;

    // A centered drop on a Markdown note turns that note into a folder note
    // when it does not have a folder yet: Parent.md -> Parent/Parent.md.
    // This is the V1 bridge between Yuque's parent-doc gesture and Obsidian's
    // filesystem-based nesting model.
    if (!targetFolder && position === "inside" && target instanceof TFile && isMarkdown(target)) {
      if (source instanceof TFolder) return;
      const folderPath = stripMarkdown(target.path);
      try {
        targetFolder = this.app.vault.getAbstractFileByPath(folderPath) as TFolder | null;
        if (!(targetFolder instanceof TFolder)) {
          targetFolder = await this.app.vault.createFolder(folderPath);
        }
        await this.ensureFolderGuid(targetFolder);
        await this.app.fileManager.renameFile(target, `${folderPath}/${target.name}`);
      } catch (error) {
        new Notice(`创建父文档文件夹失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    if (targetFolder && targetFolder !== source && !targetFolder.path.startsWith(`${source.path}/`)) {
      const destination = `${targetFolder.path}/${basename(source.path)}`;
      if (this.app.vault.getAbstractFileByPath(destination)) {
        new Notice("目标文件夹中已存在同名文件");
        return;
      }
      const guid = this.getItemGuidSync(source);
      if (guid) removeGuidFromOrders(this.data.orderByFolder, guid);
      try {
        await this.app.fileManager.renameFile(source as any, destination);
      } catch (error) {
        new Notice(`移动失败：${error instanceof Error ? error.message : String(error)}`);
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
        new Notice("不能把文件夹移动到它自己的子目录中");
        return;
      }
      const destination = target.parent.path
        ? `${target.parent.path}/${basename(source.path)}`
        : basename(source.path);
      if (this.app.vault.getAbstractFileByPath(destination)) {
        new Notice("目标目录中已存在同名文件");
        return;
      }
      this.pendingDropPlacements.set(sourceGuid, {
        parentPath: target.parent.path,
        targetGuid,
        before: position === "before",
      });
      try {
        await this.app.fileManager.renameFile(source as any, destination);
      } catch (error) {
        this.pendingDropPlacements.delete(sourceGuid);
        new Notice(`移动失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const key = this.folderKeySync(source.parent);
    const fallbackOrder = source.parent.children
      .filter((child) => child instanceof TFolder || child instanceof TFile)
      .map((child) => this.getItemGuidSync(child))
      .filter((guid): guid is string => Boolean(guid));
    const currentOrder = this.data.orderByFolder[key]?.length
      ? this.data.orderByFolder[key]
      : fallbackOrder;
    this.data.orderByFolder[key] = moveGuid(currentOrder, sourceGuid, targetGuid, position === "before");
    this.queueSave(true);
    await this.flushSave();
    this.refreshExplorer();
  }

  refreshExplorer(): void {
    try {
      // Like flexplorer, re-sort the live FileExplorerView; `sort()` is the
      // method that actually re-runs getSortedFolderItems and re-renders.
      const view: any = this.explorerView;
      if (view) {
        if (typeof view.sort === "function") view.sort();
        else if (typeof view.requestSort === "function") view.requestSort();
        else view.rerender?.();
      }
      this.scheduleDomOrder();
    } catch {
      // Obsidian's internal view is intentionally best-effort in V1.
    }
  }

  /**
   * V1 compatibility fallback for Obsidian releases whose private
   * FileExplorer Folder.sort implementation cannot be patched reliably.
   * The explorer DOM is public enough for this best-effort visual reorder,
   * while all authoritative order data remains in data.json.
   */
  private scheduleDomOrder(): void {
    if (this.domOrderFrame !== null) return;
    this.domOrderFrame = window.requestAnimationFrame(() => {
      this.domOrderFrame = null;
      this.applyDomOrder();
    });
  }

  private applyDomOrder(): void {
    const container = this.getExplorerContainer() || undefined;
    if (!container) return;

    const childrenContainers = Array.from(
      container.querySelectorAll<HTMLElement>(".nav-folder-children"),
    );
    const rootItems = Array.from(container.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => element.matches(".nav-file, .nav-folder"));
    if (rootItems.length) this.reorderDomItems("", rootItems);

    childrenContainers.forEach((children) => {
      const parentFolder = children.parentElement?.closest<HTMLElement>(".nav-folder");
      const folderPath = parentFolder ? this.pathFromElement(parentFolder) : "";
      const items = Array.from(children.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .filter((element) => element.matches(".nav-file, .nav-folder"));
      if (items.length) this.reorderDomItems(folderPath, items);
    });
  }

  private reorderDomItems(folderPath: string, elements: HTMLElement[]): void {
    const files = elements
      .map((element) => this.app.vault.getAbstractFileByPath(this.pathFromElement(element)))
      .filter((file): file is TAbstractFile => Boolean(file));
    if (files.length !== elements.length) return;

    const sorted = this.sortFolderItems(folderPath, files);
    const desiredPaths = sorted.map((file) => file.path);
    const currentPaths = elements.map((element) => this.pathFromElement(element));
    if (desiredPaths.length !== currentPaths.length
      || desiredPaths.some((path, index) => path !== currentPaths[index])) {
      const elementsByPath = new Map(elements.map((element) => [this.pathFromElement(element), element]));
      desiredPaths.forEach((path) => {
        const element = elementsByPath.get(path);
        if (element) element.parentElement?.appendChild(element);
      });
    }
  }
}

class YqOrderSettingTab extends PluginSettingTab {
  plugin: YqOrderDragPlugin;

  constructor(app: App, plugin: YqOrderDragPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Yuque Order Drag V1" });
    containerEl.createEl("p", {
      text: "使用 Markdown frontmatter 中的 guid 作为稳定身份；顺序保存在插件 data.json，不修改文件名。",
    });

    new Setting(containerEl)
      .setName("身份字段")
      .setDesc("默认使用 guid；修改后只影响之后识别的文件。")
      .addText((text) => text.setValue(this.plugin.data.settings.orderFrontmatterKey).onChange(async (value) => {
        this.plugin.data.settings.orderFrontmatterKey = value.trim() || "guid";
        await this.plugin.reconcileVault(true);
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("新增项位置")
      .setDesc("新建 Markdown 或文件夹加入当前目录时的位置。")
      .addDropdown((dropdown) => dropdown
        .addOption("bottom", "底部")
        .addOption("top", "顶部")
        .setValue(this.plugin.data.settings.newItemPlacement)
        .onChange(async (value) => {
          this.plugin.data.settings.newItemPlacement = value as "top" | "bottom";
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("未记录项兜底排序")
      .setDesc("没有出现在顺序列表中的项按名称排序，并排在已记录项之后。")
      .addDropdown((dropdown) => dropdown
        .addOption("name-last", "按名称，排在末尾")
        .addOption("name", "按名称")
        .setValue(this.plugin.data.settings.fallbackSort)
        .onChange(async (value) => {
          this.plugin.data.settings.fallbackSort = value as "name" | "name-last";
          await this.plugin.saveSettings();
          this.plugin.refreshExplorer();
        }));
    new Setting(containerEl)
      .setName("增删后立即持久化")
      .setDesc("关闭可减少 Obsidian Sync 冲突；拖拽排序仍会保存。")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.persistOrderOnCreateDelete).onChange(async (value) => {
        this.plugin.data.settings.persistOrderOnCreateDelete = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("启用文件树拖拽")
      .setDesc("拖到标题行上部或下部可精确插入；拖到中部可移入文件夹或文件夹笔记。拖动时会显示插入线和动作提示。")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.enableDrag).onChange(async (value) => {
        this.plugin.data.settings.enableDrag = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("手动导入/重同步")
      .setDesc("先核对当前库与清单；一致时直接导入，不一致时由你确认是否继续。")
      .addButton((button) => button.setButtonText("检查并导入").onClick(() => void this.plugin.requestManifestImport()));
  }
}
