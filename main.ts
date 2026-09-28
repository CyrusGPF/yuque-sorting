import {
  App,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import {
  InventoryComparison,
  InventoryEntry,
  GuidOrderPosition,
  ROOT_FOLDER_KEY,
  SortableEntry,
  compareInventories,
  captureGuidOrderPosition,
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
  referencedLocalPaths,
  restoreGuidOrderPosition,
  sanitizePortableName,
  sortEntries,
} from "./src/order-utils";
import { DropPosition, dropPositionForPointer, moveBlockReason } from "./src/drag-utils";
import { mergeChoice, pairedFolderNoteToken } from "./src/folder-note-utils";
import {
  GuidBits,
  IdentityEntry,
  createTypedGuid,
  findDuplicateIdentities,
  mapLimit,
  normalizeGuidBits,
  remapOrderSnapshot,
} from "./src/guid-utils";

import { planTransferGuids, safeTransferPath } from "./src/vault-transfer";
import { checkedDirectory, contained, copyMarkdown, copyPathMap, installCopies, markdownHeader, planCopyRoots, resolveCopyDestination, scanDisk, verifyDisk, verifyInstalledCopies } from "./src/local-copy";
import { chooseDirectory } from "./src/directory-picker";
import type { CopyChoice, LocalRuntime, DiskEntry } from "./src/local-copy";
import { sourceTransfer, yamlObject } from "./src/local-source";
import { renderManifestRestoreView } from "./src/manifest-restore-view";
import { mergeOrderData, validateStoredOrderData } from "./src/order-data-sync";
const MANIFEST_NAME = "_yuque_order.json";
const GUID_FRONTMATTER_KEY = "guid";

interface OrderSettings {
  newItemPlacement: "top" | "bottom";
  fallbackSort: "name" | "name-last";
  persistOrderOnCreateDelete: boolean;
  enableDrag: boolean;
  guidBits: GuidBits;
  scanDuplicateGuidsOnStartup: boolean;
  mergePairedFolderNotes: boolean;
}

interface GuidBackupMeta { id: string; createdAt: string; file: string; bits: GuidBits; count: number; }
interface GuidBackupFile {
  version: 1;
  entries: Array<IdentityEntry & { replacementGuid: string }>;
  folderChildrenByPath: Record<string, string[]>;
}

interface OrderData {
  version: 2;
  settings: OrderSettings;
  orderByFolder: Record<string, string[]>;
  folderGuids: Record<string, string>;
  fileGuids: Record<string, string>;
  detachedFolderNotes?: Record<string, string>;
  consumedManifestIds: string[];
  guidBackups: GuidBackupMeta[];
  legacyGuidField?: string;
  folderNoteMergeOverrides: Record<string, boolean>;
  transferReceipts?: Record<string, string>;
}

interface PendingDropPlacement {
  parentPath: string;
  targetGuid: string;
  before: boolean;
}

interface StoredGuidPosition extends GuidOrderPosition {
  folderKey: string;
  guid: string;
}

interface DragUndoRecord {
  sourceGuid: string;
  sourceOriginalPath: string;
  sourceMovedPath: string;
  sourcePosition: StoredGuidPosition;
  createdFolderPath: string | null;
  targetNoteGuid: string | null;
  targetNoteOriginalPath: string | null;
  targetNoteMovedPath: string | null;
  targetNotePosition: StoredGuidPosition | null;
}

const DEFAULT_SETTINGS: OrderSettings = {
  newItemPlacement: "bottom",
  fallbackSort: "name-last",
  persistOrderOnCreateDelete: true,
  enableDrag: true,
  guidBits: 64,
  scanDuplicateGuidsOnStartup: false,
  mergePairedFolderNotes: false,
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

function createGuid(kind: "f" | "d", bits: GuidBits = 64, used?: Set<string>): string {
  return createTypedGuid(kind, bits, used);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
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

class ConfirmActionModal extends Modal {
  private settled = false;
  constructor(
    app: App,
    private titleText: string,
    private message: string,
    private confirmText: string,
    private resolveChoice: (choice: boolean) => void,
    private renderDetails?: (contentEl: HTMLElement) => void,
  ) { super(app); }
  onOpen(): void {
    this.setTitle(this.titleText);
    if (this.renderDetails) this.renderDetails(this.contentEl);
    else this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText(this.confirmText).setWarning().onClick(() => this.finish(true)));
  }
  onClose(): void { this.contentEl.empty(); if (!this.settled) this.resolveChoice(false); }
  private finish(choice: boolean): void { if (this.settled) return; this.settled = true; this.resolveChoice(choice); this.close(); }
}

/** 设置页只显示一句话简介，详细说明放在这里按需打开。 */
class SettingDetailsModal extends Modal {
  constructor(app: App, private titleText: string, private paragraphs: string[]) { super(app); }
  onOpen(): void {
    this.setTitle(this.titleText);
    const body = this.contentEl.createDiv({ cls: "yq-setting-details" });
    this.paragraphs.forEach((paragraph) => body.createEl("p", { text: paragraph }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class CopyConflictModal extends Modal {
  private settled = false;
  private page = 0;
  private choices = new Map<string, CopyChoice>();
  constructor(app: App, private names: string[], private resolveChoices: (choices: Map<string, CopyChoice> | null) => void) {
    super(app); names.forEach(name => this.choices.set(name, { mode: "number" }));
  }
  onOpen(): void { this.render(); }
  private render(): void {
    this.contentEl.empty(); this.setTitle(`处理 ${this.names.length} 个同级重名项`);
    this.contentEl.createEl("p", { text: "替换＝整个文件或文件夹替换，目标独有子项也会移入备份。重命名和编号只修改迁入副本。每页最多 50 项。关闭或取消不会复制。" });
    new Setting(this.contentEl).setName("统一处理全部冲突").addDropdown(dropdown => dropdown
      .addOption("", "请选择批量操作").addOption("number", "自动按来源顺序编号").addOption("replace", "全部替换（后续再次确认）")
      .onChange(value => { if (!value) return; this.names.forEach(name => this.choices.set(name, { mode: value as "number" | "replace" })); this.render(); }));
    for (const name of this.names.slice(this.page * 50, (this.page + 1) * 50)) {
      const choice = this.choices.get(name)!;
      const row = new Setting(this.contentEl).setName(name);
      row.addDropdown(dropdown => dropdown.addOption("number", "自动编号").addOption("rename", "重命名").addOption("replace", "整项替换")
        .setValue(choice.mode).onChange(value => { this.choices.set(name, { mode: value as CopyChoice["mode"], name: choice.name }); this.render(); }));
      if (choice.mode === "rename") row.addText(text => text.setPlaceholder("新名称，文件请保留扩展名").setValue(choice.name || "").onChange(value => { choice.name = value; }));
    }
    new Setting(this.contentEl).setName(`第 ${this.page + 1} / ${Math.ceil(this.names.length / 50)} 页`)
      .addButton(button => button.setButtonText("上一页").setDisabled(this.page === 0).onClick(() => { this.page--; this.render(); }))
      .addButton(button => button.setButtonText("下一页").setDisabled((this.page + 1) * 50 >= this.names.length).onClick(() => { this.page++; this.render(); }));
    new Setting(this.contentEl).addButton(button => button.setButtonText("取消").onClick(() => this.finish(null)))
      .addButton(button => button.setButtonText("查看最终复制计划").setCta().onClick(() => this.finish(this.choices)));
  }
  private finish(choice: Map<string, CopyChoice> | null): void { this.settled = true; this.resolveChoices(choice); this.close(); }
  onClose(): void { this.contentEl.empty(); if (!this.settled) this.resolveChoices(null); }
}

type IdentitySelectionMode = "missing" | "regenerate";

class IdentitySelectionModal extends Modal {
  private selected = new Set<string>();
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private query = "";

  constructor(
    app: App,
    private items: TAbstractFile[],
    private onSubmit: (paths: string[], mode: IdentitySelectionMode) => void,
  ) { super(app); }

  onOpen(): void {
    this.setTitle("选择要纳入管理的文件和文件夹");
    this.contentEl.createEl("p", { text: "可搜索并勾选当前库中的文件或文件夹" });
    const search = this.contentEl.createEl("input", {
      cls: "yq-order-selection-search",
      attr: { type: "search", placeholder: "按路径搜索" },
    });
    this.countEl = this.contentEl.createEl("div", { cls: "setting-item-description" });
    this.listEl = this.contentEl.createDiv({ cls: "yq-order-selection-list" });
    search.addEventListener("input", () => { this.query = search.value.trim().toLocaleLowerCase(); this.renderList(); });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("仅生成缺失 GUID").onClick(() => this.finish("missing")))
      .addButton((button) => button.setButtonText("重新生成选中 GUID").setWarning().onClick(() => this.finish("regenerate")));
    this.renderList();
  }

  onClose(): void { this.contentEl.empty(); }

  private renderList(): void {
    this.listEl.empty();
    const visible = this.items
      .filter((item) => !this.query || item.path.toLocaleLowerCase().includes(this.query))
      .slice(0, 300);
    visible.forEach((item) => {
      const label = this.listEl.createEl("label", { cls: "yq-order-selection-row" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selected.has(item.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(item.path); else this.selected.delete(item.path);
        this.updateCount();
      });
      label.createSpan({ text: `${item instanceof TFolder ? "📁" : "📄"} ${item.path}` });
    });
    if (visible.length === 300) this.listEl.createEl("p", { text: "当前最多显示 300 项，请使用搜索缩小范围。" });
    this.updateCount();
  }

  private updateCount(): void { this.countEl.setText(`已选择 ${this.selected.size} 项`); }

  private finish(mode: IdentitySelectionMode): void {
    if (!this.selected.size) { new Notice("请至少选择一个项目"); return; }
    const paths = [...this.selected];
    this.close();
    this.onSubmit(paths, mode);
  }
}

export default class YqOrderDragPlugin extends Plugin {
  data!: OrderData;
  private storageState: "ready" | "waiting" | "blocked" = "ready";
  private hasTrustedMemoryData = false;
  private storageRaw: string | null = null;
  private storageBaseline: OrderData | null = null;
  private storageConflict: { raw: string; disk: OrderData; local: OrderData; conflicts: string[] } | null = null;
  private rejectedStorageRaw: string | null = null;
  private storageCheckPromise: Promise<void> | null = null;
  private storageOperation: Promise<void> = Promise.resolve();
  private lastSaveError: Error | null = null;
  private deferredVaultEvents: Array<{ kind: "create" | "delete" | "rename"; file: TAbstractFile; oldPath?: string }> = [];
  private guidByPath = new Map<string, string>();
  private guidPromises = new Map<string, Promise<string>>();
  private saveTimer: number | null = null;
  private savePromise: Promise<void> = Promise.resolve();
  private saveDirty = false;
  private explorerView: any = null;
  private explorerContainer: HTMLElement | null = null;
  private explorerObserver: MutationObserver | null = null;
  private explorerWaitObserver: MutationObserver | null = null;
  private restoreExplorerPatch: (() => void) | null = null;
  private explorerPatchActive = false;
  private explorerRefreshFrame: number | null = null;
  private domOrderFrame: number | null = null;
  private folderNoteFrame: number | null = null;
  private explorerSetup = false;
  private manifestNoticeShown = false;
  private dragSourcePath = "";
  private dragHintEl: HTMLElement | null = null;
  private dragHintWidth = 0;
  private dragHintHeight = 0;
  private dropTargetEl: HTMLElement | null = null;
  private dropTargetPosition: DropPosition | null = null;
  private pendingDropPlacements = new Map<string, PendingDropPlacement>();
  private pendingUndoPositions = new Map<string, StoredGuidPosition>();
  private lastDragUndo: DragUndoRecord | null = null;
  private dragUndoStack: DragUndoRecord[] = [];
  private undoInProgress = false;
  private identityMaintenanceInProgress = false;
  private transferInProgress = false;
  private transferEvents: Array<() => Promise<void>> = [];
  private autoCopyScope: { destination: string; roots: Set<string> } | null = null;
  private autoCopyPreparing = false;
  private autoCopyLastEvent = 0;
  private autoCopyCancelled = false;
  private autoCopyCreatedDirectories = new Set<string>();
  private dropInProgress = false;
  private handledRenames = new WeakMap<TAbstractFile, { key: string; done: Promise<void> }>();

  async onload(): Promise<void> {
    await this.loadInitialOrderData();

    this.registerEvent(this.app.vault.on("create", (file) => void this.handleCreate(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.handleDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("modify", file => { if (this.ownsAutoCopyPath(file.path)) this.autoCopyLastEvent = Date.now(); }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.setupExplorer()));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, item) => this.addIdentityMenuItems(menu, item)));
    this.installPairedFolderNoteClickHandler();

    this.addCommand({
      id: "restore-yuque-order-manifest",
      name: "恢复原语雀目录顺序",
      callback: () => void this.requestManifestImport(),
    });
    this.addCommand({
      id: "refresh-yuque-order",
      name: "刷新语雀式文件顺序",
      callback: () => void this.reconcileVault(true),
    });
    this.addCommand({ id: "initialize-local-order-data", name: "初始化本地目录顺序", callback: () => void this.initializeLocalOrderData() });
    this.addCommand({ id: "reload-synced-order-data", name: "检查同步后的排序数据", callback: () => void this.checkExternalOrderData(true) });
    this.addCommand({ id: "recover-order-data-from-memory", name: "从当前内存恢复排序数据", callback: () => this.confirmMemoryRecovery() });
    this.addCommand({
      id: "undo-last-yuque-drag",
      name: "撤销上一次语雀拖拽",
      checkCallback: (checking) => {
        if (!this.lastDragUndo || this.undoInProgress || this.identityMaintenanceInProgress) return false;
        if (!checking) void this.undoLastDrag();
        return true;
      },
    });
    this.addCommand({ id: "check-duplicate-guids", name: "检测并修复重复 GUID", callback: () => void this.checkDuplicateGuids(true) });
    this.addCommand({ id: "audit-unmanaged-items", name: "检测并纳入未管理项目", callback: () => void this.auditAndOfferManagement() });
    this.addCommand({ id: "cross-vault-transfer", name: "跨Vault合并（自动复制）", callback: () => this.openLocalCopy() });
    this.addCommand({ id: "copy-from-local-vault", name: "从本机 Vault／目录自动复制", callback: () => this.openLocalCopy() });
    this.addCommand({ id: "cancel-local-vault-copy", name: "取消正在进行的自动复制", checkCallback: checking => {
      if (!this.autoCopyPreparing) return false;
      if (!checking) { this.autoCopyCancelled = true; new Notice("将在当前文件复制完成后停止；如已替换，会尝试回滚"); }
      return true;
    } });
    this.addCommand({ id: "manage-selected-items", name: "选择项目并生成或重新生成 GUID", callback: () => this.openIdentitySelection() });
    this.addCommand({ id: "replace-all-guids", name: "为整个库更换 GUID", callback: () => void this.replaceAllGuids(this.data.settings.guidBits, true) });
    this.addCommand({
      id: "restore-latest-guid-backup",
      name: "恢复最近一次 GUID 备份",
      checkCallback: (checking) => {
        const latest = this.data.guidBackups[this.data.guidBackups.length - 1];
        if (!latest || this.identityMaintenanceInProgress) return false;
        if (!checking) void this.restoreGuidBackup(latest);
        return true;
      },
    });
    this.addSettingTab(new YqOrderSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => {
      if (document.visibilityState !== "hidden") void this.checkExternalOrderData();
    }, 5000));
    this.registerDomEvent(window, "focus", () => void this.checkExternalOrderData());

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
    if (this.storageState !== "ready") {
      new Notice(this.storageState === "waiting"
        ? "尚无排序数据：请先完成同步，或手动执行“初始化本地目录顺序”"
        : "排序数据暂不可用；已暂停写入，请检查或恢复 data.json", 10000);
      return;
    }
    await this.reconcileVault(false);
    if (this.data.settings.scanDuplicateGuidsOnStartup) await this.checkDuplicateGuids(false);
    this.setupExplorer();
    this.refreshExplorer();
  }

  onunload(): void {
    this.autoCopyCancelled = true;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.saveDirty && this.storageState === "ready") void this.enqueueDirtySave();
    if (this.explorerRefreshFrame !== null) window.cancelAnimationFrame(this.explorerRefreshFrame);
    if (this.domOrderFrame !== null) window.cancelAnimationFrame(this.domOrderFrame);
    if (this.folderNoteFrame !== null) window.cancelAnimationFrame(this.folderNoteFrame);
    this.explorerObserver?.disconnect();
    this.explorerWaitObserver?.disconnect();
    this.clearDragState();
    this.restoreExplorerPatch?.();
    this.restoreExplorerPatch = null;
    this.explorerPatchActive = false;
  }

  private orderDataPath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`);
  }

  private async readOrderDataRaw(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    const path = this.orderDataPath();
    if (!await adapter.exists(path)) return null;
    return adapter.read(path);
  }

  private cloneOrderData(data: OrderData): OrderData {
    return JSON.parse(JSON.stringify(data)) as OrderData;
  }

  private withStorageLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.storageOperation.then(work, work);
    this.storageOperation = next.then(() => undefined, () => undefined);
    return next;
  }

  private parseOrderData(raw: string): OrderData {
    return this.normalizeData(validateStoredOrderData(raw) as unknown as Partial<OrderData>);
  }

  private async loadInitialOrderData(): Promise<void> {
    // The adapter is available on every supported Obsidian platform. The
    // fallback keeps lightweight plugin mocks and unusual adapters usable.
    if (!this.app.vault.adapter?.exists || !this.app.vault.adapter?.read) {
      this.data = this.normalizeData((await this.loadData()) as Partial<OrderData> | null);
      this.hasTrustedMemoryData = true;
      this.storageBaseline = this.cloneOrderData(this.data);
      return;
    }
    let raw: string | null = null;
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

  getOrderDataStatus(): "ready" | "waiting" | "blocked" { return this.storageState; }

  private canMutateOrderData(): boolean {
    if (this.storageState === "ready") return true;
    new Notice("排序数据尚未就绪；请先完成同步或处理冲突", 10000);
    return false;
  }

  private async replayDeferredVaultEvents(): Promise<void> {
    const events = this.deferredVaultEvents.splice(0);
    for (const event of events) {
      try {
        if (event.kind === "create") {
          if (this.app.vault.getAbstractFileByPath(event.file.path) === event.file) await this.handleCreate(event.file);
        } else if (event.kind === "delete") {
          // A path may have been recreated during the pause. Never remove the
          // identity of a live replacement based on the old delete event.
          if (!this.app.vault.getAbstractFileByPath(event.file.path)) await this.handleDelete(event.file);
        } else if (event.oldPath && this.app.vault.getAbstractFileByPath(event.file.path) === event.file) {
          await this.handleRename(event.file, event.oldPath);
        }
      } catch (error) {
        console.error("[Yuque Sorting] Failed to replay a vault event after sync.", error);
        new Notice(`同步后处理文件变更失败：${String(error)}`, 10000);
      }
    }
  }

  async initializeLocalOrderData(): Promise<void> {
    if (this.storageState === "blocked") {
      new Notice("排序数据处于冲突或损坏状态；请先恢复或选择数据版本", 10000);
      return;
    }
    if (this.storageState === "ready") {
      new Notice("排序数据已经初始化");
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
    new Notice("已初始化本地目录顺序");
  }

  async checkExternalOrderData(interactive = false): Promise<void> {
    if (!this.app?.vault?.adapter?.exists || !this.app.vault.adapter?.read) return;
    if (this.storageCheckPromise) return this.storageCheckPromise;
    this.storageCheckPromise = this.withStorageLock(async () => {
      let raw: string | null;
      try { raw = await this.readOrderDataRaw(); }
      catch (error) {
        this.storageState = "blocked";
        if (interactive) new Notice(`无法读取排序数据：${String(error)}`, 10000);
        return;
      }
      if (this.storageState === "blocked" && (raw === this.rejectedStorageRaw || raw === this.storageConflict?.raw)) return;
      if (raw === this.storageRaw) {
        if (this.storageState === "blocked") await this.acceptExternalOrderData(raw);
        else if (interactive) new Notice(raw === null ? "仍在等待同步的排序数据" : "排序数据已是当前版本");
        return;
      }
      // A sync tool can replace the file in several writes. Only adopt a
      // complete, stable snapshot; a partial JSON must never become the base.
      await new Promise(resolve => window.setTimeout(resolve, 300));
      let stable: string | null;
      try { stable = await this.readOrderDataRaw(); }
      catch { return; }
      if (stable !== raw) return;
      await this.acceptExternalOrderData(stable);
    }).finally(() => { this.storageCheckPromise = null; });
    return this.storageCheckPromise;
  }

  private async acceptExternalOrderData(raw: string | null): Promise<void> {
    if (raw === null) {
      if (this.storageState === "waiting") return;
      this.storageState = "blocked";
      this.rejectedStorageRaw = null;
      new Notice("排序数据被外部删除；已暂停写入，请先恢复 data.json", 12000);
      return;
    }
    let disk: OrderData;
    try { disk = this.parseOrderData(raw); }
    catch (error) {
      this.storageState = "blocked";
      this.rejectedStorageRaw = raw;
      new Notice(`同步的排序数据无效，已暂停写入：${String(error)}`, 12000);
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

  private showStorageConflict(): void {
    const conflict = this.storageConflict;
    if (!conflict) return;
    const modal = new Modal(this.app);
    modal.titleEl.setText("排序数据同步冲突");
    modal.contentEl.createEl("p", { text: "本地尚未保存的改动与同步后的 data.json 修改了相同项目。已暂停写入，关闭窗口等同于稍后处理。" });
    modal.contentEl.createEl("p", { text: conflict.conflicts.slice(0, 8).join("、") + (conflict.conflicts.length > 8 ? "…" : "") });
    new Setting(modal.contentEl)
      .addButton(button => button.setButtonText("采用同步版本").onClick(() => { modal.close(); void this.resolveStorageConflict("disk"); }))
      .addButton(button => button.setButtonText("保留本地并覆盖磁盘").onClick(() => { modal.close(); void this.resolveStorageConflict("local"); }))
      .addButton(button => button.setButtonText("稍后处理").onClick(() => modal.close()));
    modal.open();
  }

  private async backUpOrderData(raw: string): Promise<string> {
    const path = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/data-recovery-${Date.now()}-${createGuid("f", 64).slice(2)}.json`);
    await this.app.vault.adapter.write(path, raw);
    return path;
  }

  openOrderDataResolution(): void {
    if (this.storageConflict) this.showStorageConflict();
    else this.confirmMemoryRecovery();
  }

  private confirmMemoryRecovery(): void {
    if (this.storageState !== "blocked" || this.storageConflict || !this.hasTrustedMemoryData) {
      new Notice("当前没有可从内存恢复的损坏或缺失数据");
      return;
    }
    const modal = new Modal(this.app);
    modal.titleEl.setText("从内存恢复排序数据");
    modal.contentEl.createEl("p", { text: "仅在同步文件缺失或损坏且你确认内存中的顺序正确时执行；原文件若存在会先备份。" });
    new Setting(modal.contentEl)
      .addButton(button => button.setButtonText("恢复").onClick(() => { modal.close(); void this.recoverOrderDataFromMemory(); }))
      .addButton(button => button.setButtonText("取消").onClick(() => modal.close()));
    modal.open();
  }

  private async recoverOrderDataFromMemory(): Promise<void> {
    try {
      const raw = await this.readOrderDataRaw();
      if (raw !== null) {
        try {
          this.parseOrderData(raw);
          new Notice("磁盘数据已经恢复有效，请先运行“检查同步后的排序数据”", 10000);
          return;
        } catch { await this.backUpOrderData(raw); }
      }
      const nextRaw = JSON.stringify(this.data, null, 2);
      if (await this.readOrderDataRaw() !== raw) throw new Error("恢复前磁盘数据再次变化");
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
      new Notice("已从内存恢复排序数据");
    } catch (error) { new Notice(`恢复失败：${String(error)}`, 10000); }
  }

  private async resolveStorageConflict(choice: "disk" | "local"): Promise<void> {
    const conflict = this.storageConflict;
    if (!conflict || await this.readOrderDataRaw() !== conflict.raw) {
      new Notice("排序数据再次变化，请重新检查后选择", 10000);
      await this.checkExternalOrderData();
      return;
    }
    try {
      await this.backUpOrderData(choice === "disk" ? JSON.stringify(conflict.local, null, 2) : conflict.raw);
    } catch (error) {
      new Notice(`备份冲突数据失败，未执行选择：${String(error)}`, 10000);
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

  normalizeData(saved: Partial<OrderData> | null): OrderData {
    const savedSettings = (saved?.settings || {}) as Partial<OrderSettings>;
    const rawSettings = (saved?.settings || {}) as unknown as Record<string, unknown>;
    const supportedSettings: Partial<OrderSettings> = {};
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
    const orderByFolder = saved?.orderByFolder && typeof saved.orderByFolder === "object"
      ? saved.orderByFolder
      : {};
    Object.keys(orderByFolder).forEach((key) => {
      if (!Array.isArray(orderByFolder[key])) orderByFolder[key] = [];
    });
    return {
      version: 2,
      settings: { ...DEFAULT_SETTINGS, ...supportedSettings },
      orderByFolder,
      folderGuids: saved?.folderGuids && typeof saved.folderGuids === "object" ? saved.folderGuids : {},
      fileGuids: saved?.fileGuids && typeof saved.fileGuids === "object" ? saved.fileGuids : {},
      detachedFolderNotes: saved?.detachedFolderNotes && typeof saved.detachedFolderNotes === "object" ? saved.detachedFolderNotes : {},
      consumedManifestIds: Array.isArray(saved?.consumedManifestIds) ? saved.consumedManifestIds.filter((id): id is string => typeof id === "string") : [],
      guidBackups: Array.isArray(saved?.guidBackups) ? saved.guidBackups as GuidBackupMeta[] : [],
      legacyGuidField: typeof rawSettings.orderFrontmatterKey === "string"
        && rawSettings.orderFrontmatterKey.trim()
        && rawSettings.orderFrontmatterKey.trim() !== GUID_FRONTMATTER_KEY
        ? rawSettings.orderFrontmatterKey.trim()
        : undefined,
      folderNoteMergeOverrides: saved?.folderNoteMergeOverrides && typeof saved.folderNoteMergeOverrides === "object"
        ? saved.folderNoteMergeOverrides as Record<string, boolean>
        : {},
      transferReceipts: saved?.transferReceipts || {},
    };
  }

  private queueSave(force = false): void {
    if (!force && !this.data.settings.persistOrderOnCreateDelete) return;
    this.saveDirty = true;
    if (this.storageState !== "ready") return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.enqueueDirtySave();
    }, 250);
  }

  private enqueueDirtySave(): Promise<void> {
    this.savePromise = this.savePromise
      .catch((error) => {
        console.error("[Yuque Sorting] Previous data save failed; retrying.", error);
      })
      .then(async () => {
        while (this.saveDirty) {
          this.saveDirty = false;
          try {
            await this.persistOrderData();
            this.lastSaveError = null;
          } catch (error) {
            this.saveDirty = true;
            this.lastSaveError = error instanceof Error ? error : new Error(String(error));
            console.error("[Yuque Sorting] Failed to save plugin data.", error);
            new Notice(`排序数据未保存：${this.lastSaveError.message}`, 10000);
            break;
          }
        }
      });
    return this.savePromise;
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saveDirty) await this.enqueueDirtySave();
    await this.savePromise;
    if (this.lastSaveError) throw this.lastSaveError;
  }

  private async forceSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveDirty = true;
    await this.flushSave();
  }

  private async persistOrderData(): Promise<void> {
    return this.withStorageLock(() => this.persistOrderDataLocked());
  }

  private async persistOrderDataLocked(): Promise<void> {
    // Some test adapters only expose Plugin.saveData. In Obsidian, use the
    // public adapter so the value on disk can be checked before every write.
    const adapter = this.app.vault.adapter;
    if (!adapter?.exists || !adapter?.read || !adapter?.write) {
      await this.saveData(this.data);
      return;
    }
    if (this.storageState !== "ready") throw new Error("排序数据尚未就绪，已暂停写入");
    const current = await this.readOrderDataRaw();
    if (current !== this.storageRaw) {
      await this.acceptExternalOrderData(current);
      if (this.storageState !== "ready") throw new Error("排序数据已由外部更改，请先处理冲突");
    }
    const base = this.storageBaseline;
    if (this.storageRaw !== null && base && JSON.stringify(this.data) === JSON.stringify(base)) return;
    const nextRaw = JSON.stringify(this.data, null, 2);
    const expected = this.storageRaw;
    const path = this.orderDataPath();
    if (expected !== null && adapter.process) {
      try {
        await adapter.process(path, value => {
          if (value !== expected) throw new Error("保存时排序数据又被外部更新");
          return nextRaw;
        });
      } catch (error) {
        void this.checkExternalOrderData();
        throw error;
      }
    } else {
      if (await this.readOrderDataRaw() !== expected) {
        void this.checkExternalOrderData();
        throw new Error("保存前排序数据发生变化");
      }
      await adapter.write(path, nextRaw);
    }
    this.storageRaw = nextRaw;
    this.storageBaseline = this.cloneOrderData(this.data);
  }

  async saveSettings(): Promise<void> {
    if (this.autoCopyPreparing && this.transferInProgress) { new Notice("自动复制期间暂不保存设置，请完成后再修改"); return; }
    await this.forceSave();
  }

  async reconcileVault(forceRefresh: boolean, persist = true): Promise<void> {
    if (this.storageState !== "ready") return;
    if (this.transferInProgress) return;
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
    // The full scan also creates folder identities and initial order lists;
    // persist that reconciliation even when event persistence is disabled.
    if (persist) await this.forceSave();
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
        } catch {
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

  private readCachedFrontmatterGuid(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return normalizeGuid(frontmatter?.[GUID_FRONTMATTER_KEY])
      || normalizeGuid(this.data.legacyGuidField ? frontmatter?.[this.data.legacyGuidField] : null);
  }

  private readGuidFromText(text: string): string | null {
    const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    const keys = [GUID_FRONTMATTER_KEY, this.data.legacyGuidField].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const field = match[1].match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, "m"));
      const guid = normalizeGuid(field?.[1]?.replace(/^['\"]|['\"]$/g, ""));
      if (guid) return guid;
    }
    return null;
  }

  private async writeFileGuid(file: TFile, guid: string): Promise<void> {
    const key = GUID_FRONTMATTER_KEY;
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

  private async setFileGuid(file: TFile, guid: string): Promise<void> {
    const key = GUID_FRONTMATTER_KEY;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => { frontmatter[key] = guid; });
    } catch {
      await this.app.vault.process(file, (text) => {
        const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) return `---\n${key}: ${guid}\n---\n\n${text}`;
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const body = match[1];
        const nextBody = new RegExp(`^\\s*${escaped}\\s*:.*$`, "m").test(body)
          ? body.replace(new RegExp(`^\\s*${escaped}\\s*:.*$`, "m"), `${key}: ${guid}`)
          : `${key}: ${guid}\n${body}`;
        return text.replace(match[0], `---\n${nextBody}\n---\n`);
      });
    }
    this.guidByPath.set(file.path, guid);
  }

  private async clearFileGuid(file: TFile, expectedGuid: string): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (normalizeGuid(frontmatter[GUID_FRONTMATTER_KEY]) === expectedGuid) {
          delete frontmatter[GUID_FRONTMATTER_KEY];
        }
      });
    } catch {
      await this.app.vault.process(file, (text) => {
        const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) return text;
        const escaped = GUID_FRONTMATTER_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const line = new RegExp(`^\\s*${escaped}\\s*:\\s*['\"]?${expectedGuid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['\"]?\\s*\\r?\\n?`, "m");
        const body = match[1].replace(line, "").replace(/\s+$/, "");
        return text.replace(match[0], body ? `---\n${body}\n---\n` : "");
      });
    }
    this.guidByPath.delete(file.path);
  }

  private async ensureFolderGuid(folder: TFolder): Promise<string | null> {
    if (!folder.path || folder.path === "/") return null;
    if (!this.data.folderGuids[folder.path]) {
      this.data.folderGuids[folder.path] = createGuid("d", this.data.settings.guidBits);
    }
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
    if (this.storageState !== "ready") {
      if (this.app.workspace.layoutReady) this.deferredVaultEvents.push({ kind: "create", file });
      return;
    }
    if (this.ownsAutoCopyPath(file.path)) { this.autoCopyLastEvent = Date.now(); return; }
    if (this.transferInProgress) { this.transferEvents.push(() => this.handleCreate(file)); return; }
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
    if (this.storageState !== "ready") {
      if (this.app.workspace.layoutReady) this.deferredVaultEvents.push({ kind: "delete", file });
      return;
    }
    if (this.ownsAutoCopyPath(file.path)) { this.autoCopyLastEvent = Date.now(); return; }
    if (this.transferInProgress) { this.transferEvents.push(() => this.handleDelete(file)); return; }
    if (!this.app.workspace.layoutReady) return;
    if (file instanceof TFile) {
      const guid = this.guidByPath.get(file.path)
        || (isMarkdown(file) ? this.readCachedFrontmatterGuid(file) : this.data.fileGuids[file.path]);
      if (guid) removeGuidFromOrders(this.data.orderByFolder, guid);
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
    if (this.storageState !== "ready") {
      if (this.app.workspace.layoutReady) this.deferredVaultEvents.push({ kind: "rename", file, oldPath });
      return;
    }
    if (this.ownsAutoCopyPath(file.path) || this.ownsAutoCopyPath(oldPath)) { this.autoCopyLastEvent = Date.now(); return; }
    if (this.transferInProgress) { this.transferEvents.push(() => this.handleRename(file, oldPath)); return; }
    if (!this.app.workspace.layoutReady) return;
    const renameKey = `${oldPath}\n${file.path}`;
    const existing = this.handledRenames.get(file);
    if (existing?.key === renameKey) return existing.done;
    const done = this.processRename(file, oldPath);
    this.handledRenames.set(file, { key: renameKey, done });
    try { await done; } catch (error) {
      if (this.handledRenames.get(file)?.done === done) this.handledRenames.delete(file);
      throw error;
    }
  }

  private async renameTracked(file: TAbstractFile, destination: string): Promise<void> {
    const oldPath = file.path;
    await this.app.fileManager.renameFile(file, destination);
    await this.handleRename(file, oldPath);
  }

  private async processRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (file instanceof TFolder) {
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
      const newParent = file.parent?.path || "";
      if (movedGuid && oldParent !== newParent) {
        if (file.parent) await this.ensureFolderGuid(file.parent);
        const undoPosition = this.pendingUndoPositions.get(movedGuid);
        const pending = this.pendingDropPlacements.get(movedGuid);
        if (undoPosition && undoPosition.folderKey === this.folderKeySync(file.parent)) {
          this.pendingUndoPositions.delete(movedGuid);
          this.restoreStoredGuidPosition(undoPosition);
        } else if (pending?.parentPath === newParent) {
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
          const undoPosition = this.pendingUndoPositions.get(guid);
          const pending = this.pendingDropPlacements.get(guid);
          if (undoPosition && undoPosition.folderKey === this.folderKeySync(file.parent)) {
            this.pendingUndoPositions.delete(guid);
            this.restoreStoredGuidPosition(undoPosition);
          } else if (pending?.parentPath === newParent) {
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

  private captureItemPosition(item: TAbstractFile, guid: string): StoredGuidPosition {
    const folderKey = this.folderKeySync(item.parent);
    const fallbackOrder = item.parent?.children
      .filter((child) => child instanceof TFolder || child instanceof TFile)
      .map((child) => this.getItemGuidSync(child))
      .filter((childGuid): childGuid is string => Boolean(childGuid)) || [];
    const order = this.data.orderByFolder[folderKey]?.length
      ? this.data.orderByFolder[folderKey]
      : fallbackOrder;
    return { folderKey, guid, ...captureGuidOrderPosition(order, guid) };
  }

  private restoreStoredGuidPosition(position: StoredGuidPosition): void {
    removeGuidFromOrders(this.data.orderByFolder, position.guid);
    this.data.orderByFolder[position.folderKey] = restoreGuidOrderPosition(
      this.data.orderByFolder[position.folderKey] || [],
      position.guid,
      position,
    );
  }

  private collectIdentityState(): { entries: IdentityEntry[]; folderChildrenByPath: Record<string, string[]> } {
    const entries: IdentityEntry[] = [];
    const folderChildrenByPath: Record<string, string[]> = {};
    const visit = (folder: TFolder): void => {
      const children = this.sortFolderItems(folder.path, folder.children.filter((item) => item instanceof TFile || item instanceof TFolder));
      folderChildrenByPath[folder.path] = children.map((item) => item.path);
      for (const item of children) {
        const guid = this.getItemGuidSync(item);
        if (guid) entries.push({ path: item.path, kind: item instanceof TFolder ? "folder" : "file", guid });
        if (item instanceof TFolder) visit(item);
      }
    };
    visit(this.app.vault.getRoot());
    return { entries, folderChildrenByPath };
  }

  private rebuildOrders(folderChildrenByPath: Record<string, string[]>): void {
    const guidByPath = new Map<string, string>();
    const folderGuidByPath = new Map<string, string>();
    for (const item of this.app.vault.getAllLoadedFiles()) {
      const guid = this.getItemGuidSync(item);
      if (guid) guidByPath.set(item.path, guid);
      if (item instanceof TFolder && item.path && guid) folderGuidByPath.set(item.path, guid);
    }
    this.data.orderByFolder = remapOrderSnapshot(folderChildrenByPath, guidByPath, folderGuidByPath);
  }

  private clearUndoHistory(): void {
    this.dragUndoStack = [];
    this.lastDragUndo = null;
  }

  private async readItemGuid(item: TAbstractFile): Promise<string | null> {
    let guid = this.getItemGuidSync(item);
    if (!guid && item instanceof TFile && isMarkdown(item)) {
      try { guid = this.readGuidFromText(await this.app.vault.read(item)); }
      catch { guid = null; }
    }
    return guid;
  }

  private manageableItems(): TAbstractFile[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((item) => (item instanceof TFile || item instanceof TFolder) && Boolean(item.path) && item.path !== "/");
  }

  private async collectUnmanagedItems(): Promise<TAbstractFile[]> {
    const items = this.manageableItems();
    const managed = new Array<boolean>(items.length).fill(false);
    await mapLimit(items.map((item, index) => ({ item, index })), 4, async ({ item, index }) => {
      managed[index] = Boolean(await this.readItemGuid(item));
    });
    return items.filter((_item, index) => !managed[index]);
  }

  private collectUnindexedItems(): TAbstractFile[] {
    const membership = new Map<string, Set<string>>();
    return this.manageableItems().filter((item) => {
      const guid = this.getItemGuidSync(item);
      if (!guid) return false;
      const key = this.folderKeySync(item.parent);
      let indexed = membership.get(key);
      if (!indexed) {
        indexed = new Set(this.data.orderByFolder[key] || []);
        membership.set(key, indexed);
      }
      return !indexed.has(guid);
    });
  }

  async auditAndOfferManagement(): Promise<void> {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const unmanaged = await this.collectUnmanagedItems();
    if (!unmanaged.length) {
      new Notice("当前 Vault 中没有未管理项目；复制或新建的项目已由插件实时自动纳入");
      return;
    }
    const fileCount = unmanaged.filter((item) => item instanceof TFile).length;
    const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(
      this.app,
      "检测到未管理项目",
      `发现 ${fileCount} 个文件和 ${unmanaged.length - fileCount} 个文件夹。将只为缺少 GUID 的项目生成 GUID，并按新增项规则纳入管理；已有兄弟项相对顺序不变。`,
      "生成 GUID 并纳入管理",
      resolve,
    ).open());
    if (proceed) await this.applyIdentitySelection(unmanaged.map((item) => item.path), "missing");
  }

  async takeOverHistoricalVault(): Promise<void> {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const unmanaged = await this.collectUnmanagedItems();
    const unindexed = this.collectUnindexedItems();
    if (!unmanaged.length && !unindexed.length) {
      new Notice("当前 Vault 的 GUID 和目录索引均完整；复制或新建的项目已被实时自动接管");
      return;
    }
    const currentOrder = this.collectIdentityState().folderChildrenByPath;
    const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(
      this.app,
      "接管历史 Obsidian Vault",
      `发现 ${unmanaged.length} 个项目缺少 GUID、${unindexed.length} 个项目缺少目录索引。${unindexed.length ? `缺少索引：${unindexed.slice(0, 10).map((item) => item.path).join("；")}${unindexed.length > 10 ? `；另有 ${unindexed.length - 10} 项` : ""}。` : ""}将补全缺失的 GUID，并以当前显示结构一次性重建目录索引；不会移动、重命名或删除文件。`,
      "开始接管",
      resolve,
    ).open());
    if (proceed) await this.applyIdentitySelection(
      unmanaged.map((item) => item.path), "missing", currentOrder, "历史 Vault 接管完成",
    );
  }


  private ownsAutoCopyPath(path: string): boolean {
    if (this.autoCopyCreatedDirectories.has(path)) return true;
    const scope = this.autoCopyScope;
    if (!scope) return false;
    const prefix = scope.destination ? `${scope.destination}/` : "";
    if (!path.startsWith(prefix)) return false;
    return scope.roots.has(path.slice(prefix.length).split("/")[0]);
  }

  openLocalCopy(): void {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress || this.autoCopyPreparing) { new Notice("已有维护或复制任务正在进行"); return; }
    const modal = new Modal(this.app); modal.setTitle("跨Vault合并（自动复制）");
    modal.contentEl.addClass("yq-copy-modal");
    modal.contentEl.createEl("p", { text: "支持复制源库或源库指定目录下的文件和文件夹，不复制所选源目录本身。读取源库 .obsidian 中的本插件排序；没有索引时按名称排序并在确认页提示。隐藏项目不复制，源库内容和顺序不修改。" });
    let source = "", destination = "";
    const pathRow = (name: string, target: boolean): void => {
      let input: any;
      new Setting(modal.contentEl).setName(name).setDesc(target ? "仅限当前库内。留空为 Vault 根目录；也可填写库内相对路径。不存在的目录在最终确认后自动创建。" : "选择目录，或手动填写源库/源目录的绝对路径。")
        .addText(text => { input = text; text.setPlaceholder(target ? "留空为 Vault 根目录" : "选择目录或填写绝对路径").onChange(value => { if (target) destination = value.trim(); else source = value.trim(); }); })
        .addButton(button => button.setButtonText("选择目录…").onClick(async () => {
          button.setDisabled(true);
          try {
            const load = (window as any).require;
            if (typeof load !== "function") throw new Error("目录选择仅支持桌面端");
            const base = (this.app.vault.adapter as any).getBasePath?.() || "";
            const selected = await chooseDirectory(load, name, target ? base : source);
            if (!selected) return;
            if (target) { await resolveCopyDestination({ fs: load("fs"), path: load("path") }, base, selected); destination = selected; }
            else source = selected;
            input.setValue(selected);
          } catch (error) { new Notice(String(error)); } finally { button.setDisabled(false); }
        }));
    };
    pathRow("源库或源库指定目录", false); pathRow("当前库或者当前库的目录", true);
    new Setting(modal.contentEl).addButton(button => button.setButtonText("预检并处理冲突").setCta().onClick(() => {
      modal.close(); void this.copyLocalDirectory(source, destination).catch(error => new Notice(`自动复制未完成：${String(error)}`, 12000));
    }));
    modal.open();
  }

  private async copyLocalDirectory(sourceInput: string, destination: string): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress || this.autoCopyPreparing || !this.app.workspace.layoutReady) return;
    const load = (window as any).require;
    const adapter = this.app.vault.adapter as any;
    if (typeof load !== "function" || typeof adapter.getBasePath !== "function") throw new Error("跨Vault合并仅支持本机桌面 Vault");
    const io: LocalRuntime = { fs: load("fs"), path: load("path") };
    this.autoCopyPreparing = true; this.autoCopyCancelled = false;
    const checkCancelled = (): void => { if (this.autoCopyCancelled) throw new Error("自动复制已取消"); };
    try {
      const source = await checkedDirectory(io, sourceInput);
      const vaultRoot = await checkedDirectory(io, adapter.getBasePath());
      if (contained(io, vaultRoot, source) || contained(io, source, vaultRoot)) throw new Error("来源和当前 Vault 不能相同、互相包含或来自当前 Vault 内部");
      const targetPlan = await resolveCopyDestination(io, vaultRoot, destination);
      destination = targetPlan.relative;
      const target = targetPlan.absolute;
      const targetFolder = targetPlan.missing.length ? null : this.transferFolder(destination);
      const sourceEntries = await scanDisk(io, source);
      const sourceInfo = await sourceTransfer(io, source, sourceEntries, this.manifest.id,
        (kind, used) => createGuid(kind, this.data.settings.guidBits, used), parseYaml);
      const pack = sourceInfo.pack;
      checkCancelled();
      if (!pack.items.length) { new Notice("来源没有可复制的非隐藏项目"); return; }
      const targetNames: string[] = targetPlan.missing.length ? [] : await io.fs.promises.readdir(target);
      const targetNameSet = new Set(targetNames);
      const indexedNames = new Set(targetFolder?.children.map(item => item.name) || []);
      if (targetNames.some(name => !name.startsWith(".") && !indexedNames.has(name))) throw new Error("目标目录还有未被 Obsidian 索引的项目，请等待索引完成后重试");
      const nameKey = (name: string): string => name.normalize("NFC").toLowerCase();
      const existingKeys = new Set(targetNames.map(nameKey));
      const conflicts = pack.orders[""].filter(name => existingKeys.has(nameKey(name)));
      const choices = conflicts.length ? await new Promise<Map<string, CopyChoice> | null>(resolve => new CopyConflictModal(this.app, conflicts, resolve).open()) : new Map<string, CopyChoice>();
      if (!choices) return;
      const roots = planCopyRoots(pack.orders[""], targetNames, choices);
      const mappedPaths = copyPathMap(pack, roots);
      const prefix = destination ? `${destination}/` : "";
      const replacedRoots = new Set(roots.filter(root => root.replaces).map(root => root.target));
      const inReplacement = (path: string): boolean => path.startsWith(prefix) && replacedRoots.has(path.slice(prefix.length).split("/")[0]);
      const snapshots = new Map<string, DiskEntry[]>();
      let removedCount = 0;
      for (const root of roots.filter(root => root.replaces)) {
        const snapshot = await scanDisk(io, io.path.join(target, root.target), true);
        snapshots.set(root.target, snapshot); removedCount += snapshot.length;
      }
      const all = this.manageableItems();
      const oldGuids = new Map<string, string>();
      const occupied = new Set<string>();
      for (const item of all) {
        let guid = this.getItemGuidSync(item);
        if (item instanceof TFile && isMarkdown(item)) {
          const header = await markdownHeader(io, io.path.join(vaultRoot, item.path));
          const yaml = header.yaml === null ? {} : yamlObject(parseYaml(header.yaml));
          guid = normalizeGuid(yaml.guid) || normalizeGuid(this.data.legacyGuidField ? yaml[this.data.legacyGuidField] : null);
        }
        if (!guid) throw new Error(`当前库项目尚无 GUID，请先检测并纳入管理：${item.path}`);
        oldGuids.set(item.path, guid); occupied.add(guid);
      }
      for (const mappings of [this.data.folderGuids, this.data.fileGuids]) for (const guid of Object.values(mappings)) occupied.add(guid);
      const replacements = planTransferGuids(pack.items, occupied, (kind, used) => createGuid(kind, this.data.settings.guidBits, used));
      const remapped = pack.items.filter(item => replacements.get(item.path) !== item.guid).length;
      const targetOrder: string[] = targetFolder ? this.sortFolderItems(targetFolder.path, targetFolder.children).map((item: TAbstractFile) => item.path) : [];
      const originalData = this.data;
      const dataSnapshot = JSON.stringify(originalData);
      const missingGuids = new Map<string, string>();
      const reservedGuids = new Set([...occupied, ...replacements.values()]);
      for (const path of targetPlan.missing) missingGuids.set(path, createGuid("d", this.data.settings.guidBits, reservedGuids));
      const confirm = await new Promise<boolean>(resolve => new ConfirmActionModal(this.app, targetPlan.missing.length ? `确认自动复制：将创建 ${targetPlan.missing.join("、")}` : "确认自动复制",
        `来源：${source}；目标：${destination || "Vault 根目录"}。复制 ${pack.items.length} 项，${remapped} 个冲突或重复 GUID 换号，${sourceInfo.generated} 项补 GUID，${sourceInfo.fallback} 项无来源索引、按名称兜底。${replacedRoots.size} 个同名项将整项替换，目标原 ${removedCount} 项（含目标独有子项）移入备份，不递归混合。计划：${roots.slice(0, 30).map(root => `${root.source} → ${root.target}${root.replaces ? " [整项替换]" : ""}`).join("；")}${roots.length > 30 ? "；其余省略" : ""}。替换项沿用原位置，新项按新增位置设置插入，其他兄弟项顺序不变。重命名可能影响相对链接，不自动改写正文链接。请先关闭被替换的笔记，并暂停同步或其他编辑。`, "确认复制（替换项已备份后才执行）", resolve).open());
      if (!confirm) return;
      checkCancelled();
      if (this.identityMaintenanceInProgress || this.data !== originalData || JSON.stringify(this.data) !== dataSnapshot) throw new Error("预检后 GUID 或排序变化，请重新预检");
      this.app.workspace.iterateAllLeaves(leaf => {
        const path = (leaf.view as any)?.file?.path;
        if (path && inReplacement(path)) throw new Error(`请先关闭被替换的已打开文件：${path}`);
      });
      this.identityMaintenanceInProgress = true; this.transferInProgress = true;
      let workspace = "";
      let copyComplete = false;
      const createdPaths: string[] = [];
      const removeCreatedEmptyFolders = async (): Promise<void> => {
        for (const path of createdPaths.slice().reverse()) {
          try { await io.fs.promises.rmdir(io.path.join(vaultRoot, path)); }
          catch (error: any) { if (error.code !== "ENOENT") throw new Error(`新建目录含其他内容或无法移除，已保留：${path}`); }
        }
      };
      try {
        await this.flushSave();
        if (this.saveDirty) throw new Error("现有插件数据保存失败，停止复制");
        const backupBase = io.path.join(vaultRoot, this.app.vault.configDir, "plugins", this.manifest.id);
        const checkedBase = await checkedDirectory(io, backupBase);
        if (!contained(io, vaultRoot, checkedBase)) throw new Error("插件备份目录不在当前 Vault 内");
        workspace = await io.fs.promises.mkdtemp(io.path.join(checkedBase, "local-copy-"));
        await io.fs.promises.writeFile(io.path.join(workspace, "data-before.json"), dataSnapshot, { flag: "wx" });
        await io.fs.promises.writeFile(io.path.join(workspace, "plan.json"), JSON.stringify({ source, target, roots, createdDirectories: targetPlan.missing, paths: [...mappedPaths], guids: [...replacements] }), { flag: "wx" });
        const staging = io.path.join(workspace, "staged"); await io.fs.promises.mkdir(staging);
        new Notice("正在准备副本，尚未替换目标；大文件逐项复制，请勿编辑来源或目标");
        for (const entry of pack.items) {
          checkCancelled();
          const output = io.path.join(staging, mappedPaths.get(entry.path)!);
          if (entry.kind === "folder") await io.fs.promises.mkdir(output, { recursive: true });
          else {
            await io.fs.promises.mkdir(io.path.dirname(output), { recursive: true });
            const input = io.path.join(source, entry.path);
            if (/\.md$/i.test(entry.path)) {
              const header = await markdownHeader(io, input);
              const yaml = header.yaml === null ? {} : yamlObject(parseYaml(header.yaml));
              yaml.guid = replacements.get(entry.path)!;
              await copyMarkdown(io, input, output, stringifyYaml(yaml), header);
            } else await io.fs.promises.copyFile(input, output, io.fs.constants.COPYFILE_EXCL);
          }
        }
        const stagedInventory = await scanDisk(io, staging);
        const verify = async (): Promise<void> => {
          checkCancelled();
          if (this.transferEvents.length || JSON.stringify(this.data) !== dataSnapshot) throw new Error("准备期间目标库发生变化，请重新预检");
          await checkedDirectory(io, source); await checkedDirectory(io, target);
          await verifyDisk(io, source, sourceEntries);
          if (sourceInfo.metadataPath && await io.fs.promises.readFile(sourceInfo.metadataPath, "utf8") !== sourceInfo.metadataText) throw new Error("来源排序数据已变化，请重新预检");
          const currentNames: string[] = await io.fs.promises.readdir(target);
          if (currentNames.length !== targetNames.length || currentNames.some(name => !targetNameSet.has(name))) throw new Error("目标同级项目已变化，请重新预检");
          for (const [name, snapshot] of snapshots) await verifyDisk(io, io.path.join(target, name), snapshot, true);
        };
        const stagedData: OrderData = { ...originalData, folderGuids: { ...originalData.folderGuids }, fileGuids: { ...originalData.fileGuids },
          orderByFolder: { ...originalData.orderByFolder }, folderNoteMergeOverrides: { ...originalData.folderNoteMergeOverrides } };
        for (const [path, guid] of missingGuids) {
          stagedData.folderGuids[path] = guid;
          const parent = path.split("/").slice(0, -1).join("/");
          const parentGuid = missingGuids.get(parent);
          const folder = parentGuid ? null : this.transferFolder(parent);
          const key = parentGuid || this.folderKeySync(folder);
          const before = folder ? this.sortFolderItems(folder.path, folder.children).map((item: TAbstractFile) => oldGuids.get(item.path)!) : [];
          stagedData.orderByFolder[key] = this.data.settings.newItemPlacement === "top" ? [guid, ...before] : [...before, guid];
        }
        const outsideGuids = new Set<string>();
        for (const [path, guid] of oldGuids) if (!inReplacement(path)) outsideGuids.add(guid);
        for (const path of Object.keys(stagedData.folderGuids)) if (inReplacement(path)) {
          const guid = stagedData.folderGuids[path]; delete stagedData.folderGuids[path];
          if (!outsideGuids.has(guid)) delete stagedData.orderByFolder[guid];
        }
        for (const path of Object.keys(stagedData.fileGuids)) if (inReplacement(path)) delete stagedData.fileGuids[path];
        for (const entry of pack.items) {
          const path = prefix + mappedPaths.get(entry.path)!; const guid = replacements.get(entry.path)!;
          if (entry.kind === "folder") {
            stagedData.folderGuids[path] = guid;
            const choice = pack.mergeChoices[entry.guid.slice(2)];
            if (typeof choice === "boolean") stagedData.folderNoteMergeOverrides[guid.slice(2)] = choice;
          } else if (!/\.md$/i.test(path)) stagedData.fileGuids[path] = guid;
        }
        for (const [parent, children] of Object.entries(pack.orders)) if (parent) stagedData.orderByFolder[replacements.get(parent)!] = children.map(path => replacements.get(path)!);
        const rootByTarget = new Map(roots.map(root => [prefix + root.target, root]));
        const existingOrder = targetOrder.map(path => rootByTarget.has(path) ? replacements.get(rootByTarget.get(path)!.source)! : oldGuids.get(path)!);
        const additions = roots.filter(root => !root.replaces).map(root => replacements.get(root.source)!);
        stagedData.orderByFolder[missingGuids.get(destination) || this.folderKeySync(targetFolder)] = this.data.settings.newItemPlacement === "top" ? [...additions, ...existingOrder] : [...existingOrder, ...additions];
        const freshTarget = await resolveCopyDestination(io, vaultRoot, target);
        if (JSON.stringify(freshTarget.missing) !== JSON.stringify(targetPlan.missing)) throw new Error("预检后目标路径发生变化，请重新预检");
        for (const path of targetPlan.missing) {
          checkCancelled(); this.autoCopyCreatedDirectories.add(path);
          await io.fs.promises.mkdir(io.path.join(vaultRoot, path)); createdPaths.push(path);
        }
        await verify();
        this.autoCopyScope = { destination, roots: new Set(roots.map(root => root.target)) };
        const waitForIndex = async (expected: Map<string, "file" | "folder">): Promise<void> => {
          this.autoCopyLastEvent = Date.now();
          const fileStats = new Map<string, { size: number; mtimeMs: number }>();
          for (const [path, kind] of expected) if (kind === "file") fileStats.set(path, await io.fs.promises.stat(io.path.join(vaultRoot, path)));
          const start = Date.now(); let stable = 0;
          while (Date.now() - start < 20000) {
            const current = this.manageableItems().filter(item => this.ownsAutoCopyPath(item.path));
            const matches = current.length === expected.size && current.every(item => {
              if (expected.get(item.path) !== (item instanceof TFolder ? "folder" : "file")) return false;
              const stat = fileStats.get(item.path);
              return !(item instanceof TFile) || Boolean(stat && item.stat.size === stat.size && Math.abs(item.stat.mtime - stat.mtimeMs) < 2);
            });
            stable = matches && Date.now() - this.autoCopyLastEvent >= 500 ? stable + 1 : 0;
            if (stable >= 2) return;
            await new Promise(resolve => window.setTimeout(resolve, 250));
          }
          throw new Error("Obsidian 文件索引未及时更新；请重载后检查恢复日志");
        };
        const oldScope = new Map(all.filter(item => this.ownsAutoCopyPath(item.path)).map(item => [item.path, item instanceof TFolder ? "folder" as const : "file" as const]));
        await installCopies(io, { roots, target, workspace, verify, checkCancelled,
          commitData: async () => {
            await verifyInstalledCopies(io, target, roots, stagedInventory);
            const expected = new Map<string, "file" | "folder">(pack.items.map(item => [prefix + mappedPaths.get(item.path)!, item.kind]));
            for (const path of createdPaths) expected.set(path, "folder");
            await waitForIndex(expected);
            await verifyInstalledCopies(io, target, roots, stagedInventory);
            checkCancelled();
            if (this.transferEvents.length || JSON.stringify(this.data) !== dataSnapshot) throw new Error("复制期间库内发生其他文件或设置操作，停止提交");
            this.data = stagedData;
            for (const path of this.guidByPath.keys()) if (this.ownsAutoCopyPath(path)) this.guidByPath.delete(path);
            for (const entry of pack.items) this.guidByPath.set(prefix + mappedPaths.get(entry.path)!, replacements.get(entry.path)!);
            for (const [path, guid] of missingGuids) this.guidByPath.set(path, guid);
            await this.persistOrderData();
          }, rollbackData: async () => {
            this.data = originalData;
            for (const path of this.guidByPath.keys()) if (this.ownsAutoCopyPath(path)) this.guidByPath.delete(path);
            for (const [path, guid] of oldGuids) this.guidByPath.set(path, guid);
            await this.persistOrderData(); await removeCreatedEmptyFolders(); await waitForIndex(oldScope);
          } });
        copyComplete = true;
        this.clearUndoHistory();
        new Notice(`已自动复制 ${pack.items.length} 项；原内容及索引备份：${workspace}`, 12000);
      } catch (error) {
        throw new Error(`${String(error)}${workspace ? `；准备/恢复文件保留在 ${workspace}` : ""}`);
      } finally {
        if (!copyComplete) await removeCreatedEmptyFolders().catch(error => new Notice(String(error), 12000));
        this.autoCopyCreatedDirectories.clear();
        this.autoCopyScope = null; this.identityMaintenanceInProgress = false; this.transferInProgress = false;
        this.refreshExplorer();
        for (const event of this.transferEvents.splice(0)) await event();
      }
    } finally { this.autoCopyPreparing = false; }
  }

  private transferFolder(path: string): TFolder {
    if (!safeTransferPath(path, true)) throw new Error("请输入 Vault 内相对目录路径，不支持隐藏目录或上级路径");
    const folder = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) throw new Error(`目录不存在：${path}`);
    return folder;
  }


  openIdentitySelection(): void {
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    new IdentitySelectionModal(this.app, this.manageableItems(), (paths, mode) => {
      void this.applyIdentitySelection(paths, mode);
    }).open();
  }

  private addIdentityMenuItems(menu: Menu, item: TAbstractFile): void {
    if (this.storageState !== "ready") return;
    if (!(item instanceof TFile || item instanceof TFolder) || !item.path) return;
    const guid = this.getItemGuidSync(item);
    menu.addItem((entry) => entry
      .setTitle(guid ? "重新生成 GUID 并纳入管理" : "生成 GUID 并纳入管理")
      .setIcon(guid ? "refresh-cw" : "fingerprint")
      .onClick(() => void this.applyIdentitySelection([item.path], guid ? "regenerate" : "missing")));

    const pair = this.resolvePairedFolderNote(item);
    if (!pair) return;
    const merged = mergeChoice(this.data.settings.mergePairedFolderNotes, this.data.folderNoteMergeOverrides, pair.token);
    menu.addItem((entry) => entry
      .setTitle(merged ? "取消与同名文件夹合并展示" : "与同名文件夹合并展示")
      .setIcon(merged ? "panel-top-close" : "panel-top-open")
      .onClick(() => void this.setPairMergeOverride(pair.token, !merged)));
  }

  private resolvePairedFolderNote(item: TAbstractFile): { folder: TFolder; note: TFile; token: string } | null {
    let folder: TFolder | null = null;
    let note: TFile | null = null;
    if (item instanceof TFolder) {
      folder = item;
      const candidate = this.app.vault.getAbstractFileByPath(`${item.path}/${item.name}.md`);
      if (candidate instanceof TFile) note = candidate;
    } else if (item instanceof TFile && isMarkdown(item) && item.parent && item.basename === item.parent.name) {
      folder = item.parent;
      note = item;
    }
    if (!folder || !note) return null;
    const token = pairedFolderNoteToken({
      folderName: folder.name,
      fileBasename: note.basename,
      folderGuid: this.getItemGuidSync(folder),
      fileGuid: this.getItemGuidSync(note),
      directChild: note.parent === folder,
    });
    return token ? { folder, note, token } : null;
  }

  private isMergedPair(pair: { token: string }): boolean {
    return mergeChoice(this.data.settings.mergePairedFolderNotes, this.data.folderNoteMergeOverrides, pair.token);
  }

  private async setPairMergeOverride(token: string, merged: boolean): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    this.data.folderNoteMergeOverrides[token] = merged;
    await this.forceSave();
    this.scheduleFolderNoteRender();
  }

  private installPairedFolderNoteClickHandler(): void {
    this.registerDomEvent(document, "click", (event) => {
      if (!(event.target instanceof HTMLElement) || event.button !== 0) return;
      if (event.target.closest(".nav-folder-collapse-indicator, .collapse-icon")) return;
      const title = event.target.closest<HTMLElement>(".nav-folder-title");
      const element = title ? this.explorerItem(title) : null;
      if (!element) return;
      const folder = this.app.vault.getAbstractFileByPath(this.pathFromElement(element));
      if (!(folder instanceof TFolder)) return;
      const pair = this.resolvePairedFolderNote(folder);
      if (!pair || !this.isMergedPair(pair)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.app.workspace.getLeaf(false).openFile(pair.note);
    }, true);
  }

  private scheduleFolderNoteRender(): void {
    if (this.folderNoteFrame !== null) return;
    this.folderNoteFrame = window.requestAnimationFrame(() => {
      this.folderNoteFrame = null;
      this.applyFolderNoteDisplay();
    });
  }

  private applyFolderNoteDisplay(): void {
    const container = this.getExplorerContainer();
    if (!container) return;
    container.querySelectorAll<HTMLElement>(".nav-file.yq-order-folder-note-hidden, .nav-folder.yq-order-folder-note")
      .forEach((element) => element.classList.remove("yq-order-folder-note-hidden", "yq-order-folder-note"));
    container.querySelectorAll<HTMLElement>(".nav-folder-title[data-yq-merged-label]")
      .forEach((element) => delete element.dataset.yqMergedLabel);
    container.querySelectorAll<HTMLElement>(".nav-file").forEach((element) => {
      const file = this.app.vault.getAbstractFileByPath(this.pathFromElement(element));
      if (!(file instanceof TFile)) return;
      const pair = this.resolvePairedFolderNote(file);
      if (!pair || !this.isMergedPair(pair)) return;
      element.classList.add("yq-order-folder-note-hidden");
      const folderElement = container.querySelector<HTMLElement>(`.nav-folder[data-path="${CSS.escape(pair.folder.path)}"]`)
        || Array.from(container.querySelectorAll<HTMLElement>(".nav-folder"))
          .find((candidate) => this.pathFromElement(candidate) === pair.folder.path);
      if (folderElement) {
        folderElement.classList.add("yq-order-folder-note");
        const title = folderElement.querySelector<HTMLElement>(":scope > .nav-folder-title");
        if (title) title.dataset.yqMergedLabel = "↗";
      }
    });
  }

  private async applyIdentitySelection(
    paths: string[],
    mode: IdentitySelectionMode,
    orderSnapshot?: Record<string, string[]>,
    successLabel = "已处理",
  ): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const items = [...new Set(paths)]
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((item): item is TFile | TFolder => item instanceof TFile || item instanceof TFolder);
    if (!items.length && !orderSnapshot) { new Notice("选中的项目已不存在"); return; }
    if (mode === "regenerate") {
      const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(
        this.app, "重新生成选中 GUID", `将为 ${items.length} 个项目生成新 GUID，目录位置与兄弟顺序不变。`, "重新生成", resolve,
      ).open());
      if (!proceed) return;
    }

    this.identityMaintenanceInProgress = true;
    const used = new Set(this.collectIdentityState().entries.map((entry) => entry.guid));
    const mutations: Array<{ item: TFile | TFolder; oldGuid: string | null; newGuid: string }> = [];
    const previousOrders: Record<string, string[]> | null = orderSnapshot ? {} : null;
    if (previousOrders) {
      for (const [key, order] of Object.entries(this.data.orderByFolder)) previousOrders[key] = [...order];
    }
    try {
      for (const item of items) {
        const oldGuid = await this.readItemGuid(item);
        if (mode === "missing" && oldGuid) continue;
        mutations.push({
          item,
          oldGuid,
          newGuid: createGuid(item instanceof TFolder ? "d" : "f", this.data.settings.guidBits, used),
        });
      }
      if (!mutations.length && !orderSnapshot) { new Notice("选中项目均已有有效 GUID，无需修改"); return; }

      await mapLimit(mutations, 4, async ({ item, newGuid }) => {
        if (item instanceof TFolder) this.data.folderGuids[item.path] = newGuid;
        else if (isMarkdown(item)) await this.setFileGuid(item, newGuid);
        else { this.data.fileGuids[item.path] = newGuid; this.guidByPath.set(item.path, newGuid); }
      });
      for (const { item, oldGuid, newGuid } of mutations) {
        if (oldGuid) replaceGuidInOrders(this.data.orderByFolder, oldGuid, newGuid);
        else this.addGuidToFolder(item.parent, newGuid);
      }
      if (orderSnapshot) this.rebuildOrders(orderSnapshot);
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new Notice(`${successLabel}：生成 ${mutations.length} 个 GUID，目录索引已完整更新`);
    } catch (error) {
      await mapLimit(mutations, 4, async ({ item, oldGuid, newGuid }) => {
        if (item instanceof TFolder) {
          if (oldGuid) this.data.folderGuids[item.path] = oldGuid; else delete this.data.folderGuids[item.path];
        } else if (isMarkdown(item)) {
          if (oldGuid) await this.setFileGuid(item, oldGuid); else await this.clearFileGuid(item, newGuid);
        } else {
          if (oldGuid) this.data.fileGuids[item.path] = oldGuid; else delete this.data.fileGuids[item.path];
          if (oldGuid) this.guidByPath.set(item.path, oldGuid); else this.guidByPath.delete(item.path);
        }
        if (oldGuid) replaceGuidInOrders(this.data.orderByFolder, newGuid, oldGuid);
        else removeGuidFromOrders(this.data.orderByFolder, newGuid);
      }).catch(() => undefined);
      if (previousOrders) this.data.orderByFolder = previousOrders;
      await this.forceSave().catch(() => undefined);
      new Notice(`GUID 操作失败，已尝试回滚：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.identityMaintenanceInProgress = false;
    }
  }

  async checkDuplicateGuids(interactive: boolean): Promise<void> {
    if (interactive && !this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const state = this.collectIdentityState();
    const groups = findDuplicateIdentities(state.entries);
    if (!groups.length) {
      if (interactive) new Notice("未发现重复 GUID");
      return;
    }
    if (!interactive) {
      new Notice(`发现 ${groups.length} 组重复 GUID，可运行“检测并修复重复 GUID”处理`);
      return;
    }
    const count = groups.reduce((sum, group) => sum + group.length - 1, 0);
    const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(
      this.app, "发现重复 GUID", `共 ${groups.length} 组、${count} 个项目需要换号。每组按当前目录顺序保留首项，其余生成新 GUID。`, "自动修复", resolve,
    ).open());
    if (!proceed) return;
    this.identityMaintenanceInProgress = true;
    const changed: IdentityEntry[] = [];
    try {
      const used = new Set(state.entries.map((entry) => entry.guid));
      const replacements: IdentityEntry[] = [];
      groups.forEach((group) => replacements.push(...group.slice(1)));
      await mapLimit(replacements, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        const guid = createGuid(entry.kind === "folder" ? "d" : "f", this.data.settings.guidBits, used);
        if (item instanceof TFile && isMarkdown(item)) await this.setFileGuid(item, guid);
        else if (item instanceof TFile) { this.data.fileGuids[item.path] = guid; this.guidByPath.set(item.path, guid); }
        else if (item instanceof TFolder) this.data.folderGuids[item.path] = guid;
        changed.push(entry);
        if (changed.length % 200 === 0) await yieldToUi();
      });
      this.rebuildOrders(state.folderChildrenByPath);
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new Notice(`已修复 ${count} 个重复 GUID，目录顺序保持不变`);
    } catch (error) {
      await mapLimit(changed, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof TFile && isMarkdown(item)) await this.setFileGuid(item, entry.guid);
        else if (item instanceof TFile) { this.data.fileGuids[item.path] = entry.guid; this.guidByPath.set(item.path, entry.guid); }
        else if (item instanceof TFolder) this.data.folderGuids[item.path] = entry.guid;
      }).catch(() => undefined);
      this.rebuildOrders(state.folderChildrenByPath);
      new Notice(`修复失败：${error instanceof Error ? error.message : String(error)}`);
      await this.reconcileVault(true);
    } finally { this.identityMaintenanceInProgress = false; }
  }

  private backupDirectory(): string {
    return normalizePath(`${this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`}/guid-backups`);
  }

  private async writeGuidBackup(backup: GuidBackupFile, bits: GuidBits): Promise<GuidBackupMeta> {
    const directory = this.backupDirectory();
    if (!(await this.app.vault.adapter.exists(directory))) await this.app.vault.adapter.mkdir(directory);
    const id = `${Date.now()}-${createGuid("f", 64).slice(2)}`;
    const file = normalizePath(`${directory}/${id}.json`);
    await this.app.vault.adapter.write(file, JSON.stringify(backup));
    const meta = { id, createdAt: new Date().toISOString(), file, bits, count: backup.entries.length };
    this.data.guidBackups.push(meta);
    return meta;
  }

  private pruneGuidBackups(): GuidBackupMeta[] {
    return this.data.guidBackups.length > 3
      ? this.data.guidBackups.splice(0, this.data.guidBackups.length - 3)
      : [];
  }

  private async retargetGuidBackups(currentByPath: ReadonlyMap<string, string>): Promise<void> {
    for (const meta of this.data.guidBackups) {
      try {
        if (!(await this.app.vault.adapter.exists(meta.file))) continue;
        const backup = JSON.parse(await this.app.vault.adapter.read(meta.file)) as GuidBackupFile;
        if (!backup.entries.every((entry) => currentByPath.has(entry.path))) continue;
        backup.entries.forEach((entry) => { entry.replacementGuid = currentByPath.get(entry.path)!; });
        await this.app.vault.adapter.write(meta.file, JSON.stringify(backup));
      } catch (error) {
        console.warn("[Yuque Sorting] Failed to update a GUID recovery baseline.", error);
      }
    }
  }

  async replaceAllGuids(bits: GuidBits, createBackup: boolean): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(
      this.app, "为整个库更换 GUID", `将为全部文件和文件夹生成 ${bits} bit GUID，并保持当前目录顺序。${createBackup ? "将创建恢复点。" : "不会创建持久恢复点。"}`, "开始更换", resolve,
    ).open());
    if (!proceed) return;
    this.identityMaintenanceInProgress = true;
    const state = this.collectIdentityState();
    const used = new Set<string>();
    const replacement = new Map(state.entries.map((entry) => [entry.path, createGuid(entry.kind === "folder" ? "d" : "f", bits, used)]));
    const backup: GuidBackupFile = { version: 1, entries: state.entries.map((entry) => ({ ...entry, replacementGuid: replacement.get(entry.path)! })), folderChildrenByPath: state.folderChildrenByPath };
    const changedMarkdown: Array<{ file: TFile; guid: string }> = [];
    const previousBits = this.data.settings.guidBits;
    let backupMeta: GuidBackupMeta | null = null;
    let obsoleteBackups: GuidBackupMeta[] = [];
    try {
      if (createBackup) backupMeta = await this.writeGuidBackup(backup, bits);
      const markdown = state.entries.filter((entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        return item instanceof TFile && isMarkdown(item);
      });
      await mapLimit(markdown, 4, async (entry) => {
        const file = this.app.vault.getAbstractFileByPath(entry.path) as TFile;
        await this.setFileGuid(file, replacement.get(entry.path)!);
        changedMarkdown.push({ file, guid: entry.guid });
      });
      let mapped = 0;
      for (const entry of state.entries) {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        const guid = replacement.get(entry.path)!;
        if (item instanceof TFolder) this.data.folderGuids[item.path] = guid;
        else if (item instanceof TFile && !isMarkdown(item)) { this.data.fileGuids[item.path] = guid; this.guidByPath.set(item.path, guid); }
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
        } catch (error) { console.warn("[Yuque Sorting] Failed to remove an expired GUID recovery point.", error); }
      }
      this.refreshExplorer();
      new Notice(`已为 ${state.entries.length} 个项目更换 GUID`);
    } catch (error) {
      await mapLimit(changedMarkdown, 4, async ({ file, guid }) => this.setFileGuid(file, guid)).catch(() => undefined);
      for (const entry of state.entries) {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof TFolder) this.data.folderGuids[item.path] = entry.guid;
        else if (item instanceof TFile && !isMarkdown(item)) { this.data.fileGuids[item.path] = entry.guid; this.guidByPath.set(item.path, entry.guid); }
      }
      this.data.settings.guidBits = previousBits;
      this.rebuildOrders(state.folderChildrenByPath);
      if (obsoleteBackups.length) this.data.guidBackups.unshift(...obsoleteBackups);
      await this.retargetGuidBackups(new Map(state.entries.map((entry) => [entry.path, entry.guid])));
      if (backupMeta) {
        this.data.guidBackups = this.data.guidBackups.filter((candidate) => candidate.id !== backupMeta?.id);
        if (await this.app.vault.adapter.exists(backupMeta.file)) await this.app.vault.adapter.remove(backupMeta.file);
      }
      new Notice(`更换失败，已尝试回滚：${error instanceof Error ? error.message : String(error)}`);
      await this.reconcileVault(true);
    } finally { this.identityMaintenanceInProgress = false; }
  }

  async restoreGuidBackup(meta: GuidBackupMeta): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress) return;
    const changed: Array<IdentityEntry & { replacementGuid: string }> = [];
    let currentOrders: Record<string, string[]> | null = null;
    try {
      const backup = JSON.parse(await this.app.vault.adapter.read(meta.file)) as GuidBackupFile;
      const current = this.collectIdentityState();
      currentOrders = current.folderChildrenByPath;
      const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
      const valid = backup.entries.length === current.entries.length && backup.entries.every((entry) => {
        const now = currentByPath.get(entry.path);
        return now?.kind === entry.kind && now.guid === entry.replacementGuid;
      });
      if (!valid) { new Notice("无法恢复：当前库已有新增、删除、移动、重命名或 GUID 变化"); return; }
      const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(this.app, "恢复 GUID", `恢复 ${meta.createdAt} 的 ${meta.count} 项 GUID 和目录顺序。`, "恢复", resolve).open());
      if (!proceed) return;
      this.identityMaintenanceInProgress = true;
      await mapLimit(backup.entries, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof TFile && isMarkdown(item)) await this.setFileGuid(item, entry.guid);
        else if (item instanceof TFile) { this.data.fileGuids[item.path] = entry.guid; this.guidByPath.set(item.path, entry.guid); }
        else if (item instanceof TFolder) this.data.folderGuids[item.path] = entry.guid;
        changed.push(entry);
      });
      this.rebuildOrders(backup.folderChildrenByPath);
      await this.retargetGuidBackups(new Map(backup.entries.map((entry) => [entry.path, entry.guid])));
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new Notice("GUID 与目录顺序已恢复");
    } catch (error) {
      await mapLimit(changed, 4, async (entry) => {
        const item = this.app.vault.getAbstractFileByPath(entry.path);
        if (item instanceof TFile && isMarkdown(item)) await this.setFileGuid(item, entry.replacementGuid);
        else if (item instanceof TFile) { this.data.fileGuids[item.path] = entry.replacementGuid; this.guidByPath.set(item.path, entry.replacementGuid); }
        else if (item instanceof TFolder) this.data.folderGuids[item.path] = entry.replacementGuid;
      }).catch(() => undefined);
      if (currentOrders) this.rebuildOrders(currentOrders);
      new Notice(`恢复失败，已尝试回滚：${error instanceof Error ? error.message : String(error)}`);
    }
    finally { this.identityMaintenanceInProgress = false; }
  }

  async requestManifestImport(): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    const manifests = this.app.vault.getFiles().filter((file) => file.name === MANIFEST_NAME);
    if (!manifests.length) {
      new Notice("未找到 _yuque_order.json");
      return;
    }
    if (this.identityMaintenanceInProgress) return;
    const parsed: Array<{ file: TFile; raw: any }> = [];
    const problems: string[] = [];
    for (const file of manifests) {
      try {
        const raw = JSON.parse(await this.app.vault.read(file));
        if (raw?.version !== 2 || typeof raw.exportId !== "string" || !Array.isArray(raw.directories)) {
          problems.push(`${file.path}：无法解析`);
        } else parsed.push({ file, raw });
      } catch { problems.push(`${file.path}：无法解析`); }
    }
    if (!parsed.length) {
      new Notice(problems.length ? problems[0] : "没有可用的语雀导出清单");
      return;
    }
    const seen = new Set<string>();
    const verifiedMarkdownGuids = new Map<string, string>();
    const markdownTextByPath = new Map<string, string>();
    let matched = 0;
    const actualDuplicates = findDuplicateIdentities(this.collectIdentityState().entries);
    if (actualDuplicates.length) problems.push(`当前库存在 ${actualDuplicates.length} 组重复 GUID`);
    for (const { file, raw } of parsed) {
      const adoptExportIdentity = !this.data.consumedManifestIds.includes(raw.exportId);
      const root = file.parent?.path || "";
      const expectedPaths = new Set<string>();
      for (const directory of raw.directories) {
        if (!directory || typeof directory.path !== "string" || !Array.isArray(directory.items)) { problems.push(`${file.path}：目录结构无效`); continue; }
        for (const entry of directory.items) {
          if (!entry || !["file", "folder"].includes(entry.kind) || typeof entry.path !== "string" || typeof entry.guid !== "string") { problems.push(`${file.path}：条目无效`); continue; }
          const expectedKind = entry.kind === "folder" ? "d" : "f";
          const bits = Number(raw.guidBits) === 72 ? 72 : 64;
          const currentLength = bits === 72 ? 13 : 11;
          const currentGuid = new RegExp(`^${expectedKind}-[A-Za-z0-9]{${currentLength}}$`).test(entry.guid);
          const legacyLength = bits === 72 ? 12 : 11;
          const legacyGuid = new RegExp(`^${expectedKind}:[A-Za-z0-9_-]{${legacyLength}}$`).test(entry.guid);
          if (!currentGuid && !legacyGuid) {
            problems.push(`${entry.path}：GUID 格式或类型前缀不符`);
          }
          if (seen.has(entry.guid)) problems.push(`${file.path}：重复 GUID ${entry.guid}`);
          seen.add(entry.guid);
          const path = root ? `${root}/${entry.path}` : entry.path;
          if (expectedPaths.has(normalizePath(path))) problems.push(`${entry.path}：清单中存在重复最终路径`);
          expectedPaths.add(normalizePath(path));
          const relativeParent = normalizePath(entry.path).split("/").slice(0, -1).join("/");
          const expectedParent = directory.path ? normalizePath(directory.path) : "";
          if (relativeParent !== expectedParent) problems.push(`${entry.path}：父级与目录清单不一致`);
          const item = this.app.vault.getAbstractFileByPath(path);
          if (!item || (entry.kind === "file") !== (item instanceof TFile)) problems.push(`${path}：当前库缺失或类型不符`);
          else {
            let actualGuid = this.getItemGuidSync(item);
            if (item instanceof TFile && isMarkdown(item) && actualGuid !== entry.guid) {
              try {
                const text = await this.app.vault.read(item);
                markdownTextByPath.set(path, text);
                actualGuid = this.readGuidFromText(text);
              }
              catch { actualGuid = null; }
            }
            if (item instanceof TFile && isMarkdown(item) && actualGuid) verifiedMarkdownGuids.set(path, actualGuid);
            if (adoptExportIdentity && item instanceof TFile && isMarkdown(item) && actualGuid !== entry.guid) problems.push(`${path}：frontmatter GUID 与清单不符`);
            else matched += 1;
          }
        }
      }
      if (raw.resources !== undefined && !Array.isArray(raw.resources)) {
        problems.push(`${file.path}：resources 结构无效`);
      }
      for (const entry of Array.isArray(raw.resources) ? raw.resources : []) {
        if (!entry || !["file", "folder"].includes(entry.kind) || typeof entry.path !== "string" || typeof entry.guid !== "string") {
          problems.push(`${file.path}：资源条目无效`);
          continue;
        }
        const expectedKind = entry.kind === "folder" ? "d" : "f";
        const bits = Number(raw.guidBits) === 72 ? 72 : 64;
        const currentLength = bits === 72 ? 13 : 11;
        const currentGuid = new RegExp(`^${expectedKind}-[A-Za-z0-9]{${currentLength}}$`).test(entry.guid);
        const legacyLength = bits === 72 ? 12 : 11;
        const legacyGuid = new RegExp(`^${expectedKind}:[A-Za-z0-9_-]{${legacyLength}}$`).test(entry.guid);
        if (!currentGuid && !legacyGuid) problems.push(`${entry.path}：资源 GUID 格式或类型前缀不符`);
        if (seen.has(entry.guid)) problems.push(`${file.path}：重复 GUID ${entry.guid}`);
        seen.add(entry.guid);
        const path = root ? `${root}/${entry.path}` : entry.path;
        const normalized = normalizePath(path);
        if (expectedPaths.has(normalized)) problems.push(`${entry.path}：清单中存在重复最终路径`);
        expectedPaths.add(normalized);
        const item = this.app.vault.getAbstractFileByPath(path);
        if (!item || (entry.kind === "file") !== (item instanceof TFile)) problems.push(`${path}：当前库缺失或类型不符`);
        else matched += 1;
      }
      // Early V2 manifests did not have a resources section. Derive only
      // actually referenced local assets from Markdown, keeping unrelated
      // user-created files visible as genuine extras.
      if (raw.resources === undefined) {
        for (const directory of raw.directories) for (const entry of directory.items) {
          if (entry?.kind !== "file" || !/\.md$/i.test(entry.path)) continue;
          const path = root ? `${root}/${entry.path}` : entry.path;
          const note = this.app.vault.getAbstractFileByPath(path);
          if (!(note instanceof TFile)) continue;
          let text = markdownTextByPath.get(path);
          if (text === undefined) {
            try { text = await this.app.vault.read(note); markdownTextByPath.set(path, text); }
            catch { continue; }
          }
          for (const resourcePath of referencedLocalPaths(text, path, root)) {
            if (this.app.vault.getAbstractFileByPath(resourcePath)) expectedPaths.add(normalizePath(resourcePath));
          }
        }
      }
      const prefix = root ? `${root}/` : "";
      let extraCount = 0;
      for (const item of this.app.vault.getAllLoadedFiles()) {
        if (!item.path || item.path === file.path || (prefix && !item.path.startsWith(prefix))) continue;
        if (!expectedPaths.has(normalizePath(item.path))) extraCount += 1;
      }
      if (extraCount) problems.push(`${file.path}：当前库多出 ${extraCount} 个项目`);
    }
    const changedDirectories: string[] = [];
    let changedPositions = 0;
    const previewLines: string[] = [];
    const previews: Array<{ folder: string; current: string; next: string }> = [];
    for (const { file, raw } of parsed) {
      const root = file.parent?.path || "";
      for (const directory of raw.directories) {
        if (!directory || typeof directory.path !== "string" || !Array.isArray(directory.items)) continue;
        const folderPath = directory.path ? (root ? `${root}/${directory.path}` : directory.path) : root;
        const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
        if (!(folder instanceof TFolder)) continue;
        const current: string[] = this.sortFolderItems(folder.path, folder.children).map((item: TAbstractFile) => item.path);
        const currentSet = new Set(current);
        const listed: string[] = directory.items.map((entry: any) => typeof entry?.path === "string" ? (root ? `${root}/${entry.path}` : entry.path) : "").filter((path: string) => currentSet.has(path));
        const listedSet = new Set(listed);
        const next = [...listed, ...current.filter(path => !listedSet.has(path))];
        const changed = next.reduce((count, path, index) => count + (current[index] !== path ? 1 : 0), 0);
        if (!changed) continue;
        const folderLabel = folderPath || "Vault 根目录";
        changedDirectories.push(folderLabel); changedPositions += changed;
        if (previewLines.length < 10) {
          const names = (paths: string[]): string => paths.slice(0, 6).map(path => path.split("/").pop()).join(" → ") + (paths.length > 6 ? " → …" : "");
          const currentText = names(current), nextText = names(next);
          previews.push({ folder: folderLabel, current: currentText, next: nextText });
          previewLines.push(`${folderLabel}：当前 [${currentText}]；恢复后 [${nextText}]`);
        }
      }
    }
    const dataBeforeConfirmation = JSON.stringify(this.data);
    const fileState = (): string => JSON.stringify(this.app.vault.getAllLoadedFiles().map(item => [item.path, item instanceof TFile ? [item.stat.mtime, item.stat.size] : "folder"]));
    const filesBeforeConfirmation = fileState();
    const newManifests = parsed.filter(({ raw }) => !this.data.consumedManifestIds.includes(raw.exportId)).length;
    const matchingCaveat = `匹配只看清单中的路径，不看文件内容：已改名或移动过的项目无法恢复原顺序（会提示缺失/多出）。${newManifests < parsed.length ? "同一路径若已换成另一个文件，插件不会识别，会直接按清单位置排序。" : ""}`;
    const restoreView = {
      manifestCount: parsed.length,
      changedDirectories: changedDirectories.length,
      changedPositions,
      previews,
      problems,
      newManifests,
    };
    const renderManifestRestoreDetails = (contentEl: HTMLElement): void => renderManifestRestoreView(contentEl, restoreView);
    const proceed = await new Promise<boolean>((resolve) => new ConfirmActionModal(
      this.app, "确认恢复原语雀目录顺序",
      `已检查 ${parsed.length} 份有效清单；${changedDirectories.length} 个目录的顺序将变化，${changedPositions} 个显示位置不同。${changedDirectories.length ? previewLines.join("；") + (changedDirectories.length > 10 ? "；其余目录省略" : "") : "当前可匹配项目的显示顺序与清单一致。"} ${problems.length ? `另有 ${problems.length} 项清单差异：${problems.slice(0, 10).join("；")}${problems.length > 10 ? "；其余省略" : ""}。继续仅处理能够匹配的项目。` : "未发现清单差异。"} ${newManifests ? `${newManifests} 份清单为首次使用，将按现有规则采用清单里的 GUID 并建立索引；Markdown 正文不改写。` : "仅恢复顺序，不覆盖后来更换的 GUID。"} ${matchingCaveat}不移动、重命名或删除实际文件。确认后会清空拖拽撤销历史；取消或关闭窗口不修改数据。`,
      problems.length ? "确认恢复匹配项" : "确认恢复目录顺序", resolve, renderManifestRestoreDetails,
    ).open());
    if (!proceed) return;
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    if (this.identityMaintenanceInProgress || JSON.stringify(this.data) !== dataBeforeConfirmation || fileState() !== filesBeforeConfirmation) {
      new Notice("确认期间文件、GUID 或目录顺序发生变化，请重新检查后恢复"); return;
    }
    this.identityMaintenanceInProgress = true;
    try {
      // External re-exports can replace Markdown while Obsidian still holds
      // the previous metadata cache. Refresh only the identities verified
      // directly from disk, and only after the user accepts the operation.
      verifiedMarkdownGuids.forEach((guid, path) => this.guidByPath.set(path, guid));
      for (const { file, raw } of parsed) {
        const root = file.parent?.path || "";
        // Initialization adopts exported identities. Explicit restoration is
        // path-based and changes order only, so a later full-vault GUID reset
        // remains intact.
        if (!this.data.consumedManifestIds.includes(raw.exportId)) {
          const identityEntries: any[] = [];
          for (const directory of raw.directories) identityEntries.push(...directory.items);
          if (Array.isArray(raw.resources)) identityEntries.push(...raw.resources);
          for (const entry of identityEntries) {
            const path = root ? `${root}/${entry.path}` : entry.path;
            const item = this.app.vault.getAbstractFileByPath(path);
            const previousGuid = item ? this.getItemGuidSync(item) : null;
            if (entry.kind === "folder" && item instanceof TFolder) this.data.folderGuids[path] = entry.guid;
            else if (entry.kind === "file" && item instanceof TFile) {
              if (!isMarkdown(item)) this.data.fileGuids[path] = entry.guid;
              if (!isMarkdown(item) || this.getItemGuidSync(item) === entry.guid) this.guidByPath.set(path, entry.guid);
            }
            if (previousGuid && previousGuid !== entry.guid && (!(item instanceof TFile) || !isMarkdown(item))) {
              replaceGuidInOrders(this.data.orderByFolder, previousGuid, entry.guid);
            }
          }
        }
        for (const directory of raw.directories) {
          const folderPath = directory.path ? (root ? `${root}/${directory.path}` : directory.path) : root;
          const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
          if (!(folder instanceof TFolder)) continue;
          const wanted = directory.items.map((entry: any) => {
            const path = root ? `${root}/${entry.path}` : entry.path;
            const item = this.app.vault.getAbstractFileByPath(path);
            return item ? this.getItemGuidSync(item) : null;
          }).filter((guid: unknown): guid is string => typeof guid === "string");
          const key = this.folderKeySync(folder);
          const wantedSet = new Set(wanted);
          this.data.orderByFolder[key] = [...wanted, ...(this.data.orderByFolder[key] || []).filter((guid) => !wantedSet.has(guid))];
        }
        if (!this.data.consumedManifestIds.includes(raw.exportId)) this.data.consumedManifestIds.push(raw.exportId);
      }
      this.clearUndoHistory();
      await this.forceSave();
      this.refreshExplorer();
      new Notice(`已从 ${parsed.length} 份清单恢复 ${matched} 个项目的原语雀目录顺序`);
    } finally { this.identityMaintenanceInProgress = false; }
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
      await this.forceSave();
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
    if (file.parent && file.basename === file.parent.name) return file.parent;
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
      this.explorerPatchActive = true;
    } catch (error) {
      if (!this.manifestNoticeShown) {
        this.manifestNoticeShown = true;
        console.warn("[Yuque Sorting] FileExplorer patch unavailable; using default order.", error);
      }
    }
  }

  private setupExplorer(): void {
    const view = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    const container = view?.containerEl
      || document.querySelector<HTMLElement>(".nav-files-container");
    if (!view || !container) {
      // The file-explorer sidebar can mount after startup (closed at boot,
      // still rendering, or reopened later). Wait for it like flexplorer
      // does, otherwise the sort patch never applies and the explorer stays
      // in Obsidian's default alphabetical order.
      if (this.explorerWaitObserver) return;
      this.explorerWaitObserver = new MutationObserver(() => {
        if (!this.app.workspace.getLeavesOfType("file-explorer")[0]?.view) return;
        this.explorerWaitObserver?.disconnect();
        this.explorerWaitObserver = null;
        this.setupExplorer();
      });
      this.explorerWaitObserver.observe(document.body, { childList: true, subtree: true });
      return;
    }
    this.explorerWaitObserver?.disconnect();
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
      const targetName = this.dropSurface(targetEl).textContent?.trim() || this.pathFromElement(targetEl);
      const action = position === "before" ? "插入到上方" : position === "after" ? "插入到下方" : "移入";
      this.dragHintEl.textContent = `${action}：${targetName}`;
      const hintRect = this.dragHintEl.getBoundingClientRect();
      this.dragHintWidth = hintRect.width;
      this.dragHintHeight = hintRect.height;
    }
    const left = Math.max(8, Math.min(clientX + 14, window.innerWidth - this.dragHintWidth - 8));
    const below = clientY + 18;
    const top = below + this.dragHintHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, clientY - this.dragHintHeight - 14);
    this.dragHintEl.style.left = `${left}px`;
    this.dragHintEl.style.top = `${top}px`;
  }

  private clearDropTargets(): void {
    this.dropTargetEl?.classList.remove(
      "yq-order-drop-before", "yq-order-drop-inside", "yq-order-drop-after",
    );
    this.dropTargetEl = null;
    this.dropTargetPosition = null;
  }

  private clearDropFeedback(): void {
    this.clearDropTargets();
    this.dragHintEl?.remove();
    this.dragHintEl = null;
    this.dragHintWidth = 0;
    this.dragHintHeight = 0;
  }

  private installDragHandlers(): void {
    const explorerContainer = this.getExplorerContainer() || undefined;
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
        item,
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
      void this.handleDrop(this.dragSourcePath, targetPath, position).catch(error => {
        new Notice(`拖拽未完成：${String(error)}；请检查文件树和排序数据`, 12000);
      });
      this.clearDragState();
    }, true);
    this.registerDomEvent(document, "dragend", () => this.clearDragState(), true);
  }

  private observeExplorerContainer(container: HTMLElement): void {
    if (this.explorerContainer === container && this.explorerObserver) return;
    this.explorerObserver?.disconnect();
    this.explorerContainer = container;

    const markDraggable = (root: ParentNode) => {
      if (root instanceof HTMLElement && root.matches(".nav-file, .nav-folder")) {
        root.setAttribute("draggable", "true");
      }
      root.querySelectorAll<HTMLElement>(".nav-file, .nav-folder")
        .forEach((element) => element.setAttribute("draggable", "true"));
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

  private clearDragState(): void {
    this.dragSourcePath = "";
    this.getExplorerContainer()?.querySelectorAll(".yq-order-drag-source")
      .forEach((el) => el.classList.remove("yq-order-drag-source"));
    this.clearDropFeedback();
  }

  private rememberDragUndo(record: DragUndoRecord): void {
    this.dragUndoStack.push(record);
    if (this.dragUndoStack.length > 50) this.dragUndoStack.shift();
    this.lastDragUndo = record;
  }

  private async rollbackFolderNoteConversion(
    createdFolderPath: string | null,
    targetNoteOriginalPath: string | null,
    targetNoteMovedPath: string | null,
    targetNotePosition: StoredGuidPosition | null,
  ): Promise<boolean> {
    if (!createdFolderPath || !targetNoteOriginalPath || !targetNoteMovedPath) return true;
    try {
      const movedTarget = this.app.vault.getAbstractFileByPath(targetNoteMovedPath);
      if (movedTarget instanceof TFile && !this.app.vault.getAbstractFileByPath(targetNoteOriginalPath)) {
        if (targetNotePosition) this.pendingUndoPositions.set(targetNotePosition.guid, targetNotePosition);
        await this.renameTracked(movedTarget, targetNoteOriginalPath);
      }
      const createdFolder = this.app.vault.getAbstractFileByPath(createdFolderPath);
      if (createdFolder instanceof TFolder) {
        if (createdFolder.children.length) return false;
        await this.app.vault.delete(createdFolder, true);
      }
      if (targetNotePosition) this.restoreStoredGuidPosition(targetNotePosition);
      this.queueSave(true);
      await this.flushSave();
      return true;
    } catch {
      return false;
    } finally {
      if (targetNotePosition) {
        window.setTimeout(() => this.pendingUndoPositions.delete(targetNotePosition.guid), 1000);
      }
    }
  }

  private async undoLastDrag(): Promise<void> {
    await this.checkExternalOrderData();
    if (!this.canMutateOrderData()) return;
    const record = this.dragUndoStack.length ? this.dragUndoStack[this.dragUndoStack.length - 1] : this.lastDragUndo;
    if (!record || this.undoInProgress) return;

    const source = this.app.vault.getAbstractFileByPath(record.sourceMovedPath);
    if (!source || this.getItemGuidSync(source) !== record.sourceGuid) {
      this.dragUndoStack.pop();
      this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
      new Notice("无法撤销：被拖项目已被移动、重命名或删除");
      return;
    }
    const sourceAtOriginal = this.app.vault.getAbstractFileByPath(record.sourceOriginalPath);
    if (record.sourceMovedPath !== record.sourceOriginalPath && sourceAtOriginal) {
      new Notice("无法撤销：原位置已存在同名项目");
      return;
    }

    const targetNote = record.targetNoteMovedPath
      ? this.app.vault.getAbstractFileByPath(record.targetNoteMovedPath)
      : null;
    if (record.targetNoteMovedPath && (!(targetNote instanceof TFile)
      || this.getItemGuidSync(targetNote) !== record.targetNoteGuid)) {
      this.dragUndoStack.pop();
      this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
      new Notice("无法撤销：目标文件夹笔记已被移动、重命名或删除");
      return;
    }
    if (record.targetNoteOriginalPath
      && this.app.vault.getAbstractFileByPath(record.targetNoteOriginalPath)) {
      new Notice("无法撤销：目标笔记的原位置已存在同名项目");
      return;
    }
    if (record.createdFolderPath) {
      const createdFolder = this.app.vault.getAbstractFileByPath(record.createdFolderPath);
      if (!(createdFolder instanceof TFolder)) {
        this.dragUndoStack.pop();
        this.lastDragUndo = this.dragUndoStack[this.dragUndoStack.length - 1] || null;
        new Notice("无法撤销：拖拽创建的文件夹已不存在");
        return;
      }
      const expectedPaths = new Set([record.sourceMovedPath, record.targetNoteMovedPath].filter(Boolean));
      if (createdFolder.children.some((child) => !expectedPaths.has(child.path))) {
        new Notice("无法撤销：拖拽创建的文件夹中已有其他项目");
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

      if (targetNote instanceof TFile && record.targetNoteOriginalPath && record.targetNotePosition) {
        this.pendingUndoPositions.set(record.targetNotePosition.guid, record.targetNotePosition);
        await this.renameTracked(targetNote, record.targetNoteOriginalPath);
        this.restoreStoredGuidPosition(record.targetNotePosition);
      }

      if (record.createdFolderPath) {
        const createdFolder = this.app.vault.getAbstractFileByPath(record.createdFolderPath);
        if (createdFolder instanceof TFolder) {
          if (createdFolder.children.length) throw new Error("创建的文件夹不是空文件夹");
          await this.app.vault.delete(createdFolder, true);
        }
        this.restoreStoredGuidPosition(record.sourcePosition);
        if (record.targetNotePosition) this.restoreStoredGuidPosition(record.targetNotePosition);
      }

      this.queueSave(true);
      await this.flushSave();
      this.refreshExplorer();
      new Notice("已撤销上一次语雀拖拽");
    } catch (error) {
      if (sourceRestored) {
        const restoredSource = this.app.vault.getAbstractFileByPath(record.sourceOriginalPath);
        if (restoredSource && !this.app.vault.getAbstractFileByPath(record.sourceMovedPath)) {
          try {
            await this.renameTracked(restoredSource, record.sourceMovedPath);
            this.restoreStoredGuidPosition(currentPosition);
          } catch {
            // Preserve the original error; reconciliation remains available.
          }
        }
      }
      this.dragUndoStack.push(record);
      this.lastDragUndo = record;
      new Notice(`撤销失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.undoInProgress = false;
      window.setTimeout(() => {
        this.pendingUndoPositions.delete(record.sourceGuid);
        if (record.targetNoteGuid) this.pendingUndoPositions.delete(record.targetNoteGuid);
      }, 1000);
    }
  }

  private async handleDrop(sourcePath: string, targetPath: string, position: DropPosition): Promise<void> {
    if (this.transferInProgress) return;
    if (this.dropInProgress || this.undoInProgress) return;
    this.dropInProgress = true;
    try {
      if (this.app?.vault?.adapter) await this.checkExternalOrderData();
      if (this.storageState !== "ready") {
        new Notice("排序数据正在等待同步或处理冲突，暂不能拖拽排序", 10000);
        return;
      }
      await this.executeDrop(sourcePath, targetPath, position);
    } finally {
      this.dropInProgress = false;
    }
  }

  private async executeDrop(sourcePath: string, targetPath: string, position: DropPosition): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!source || !target || source.path === target.path) return;
    const initialSourceGuid = this.getItemGuidSync(source);
    if (!initialSourceGuid) return;
    const sourceOriginalPath = source.path;
    const sourcePosition = this.captureItemPosition(source, initialSourceGuid);
    let createdFolderPath: string | null = null;
    let targetNoteOriginalPath: string | null = null;
    let targetNoteMovedPath: string | null = null;
    let targetNoteGuid: string | null = null;
    let targetNotePosition: StoredGuidPosition | null = null;
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
      const prospectiveDestination = `${folderPath}/${basename(source.path)}`;
      if (basename(source.path) === target.name || this.app.vault.getAbstractFileByPath(prospectiveDestination)) {
        new Notice("目标文件夹中已存在同名文件");
        return;
      }
      targetNoteGuid = this.getItemGuidSync(target);
      if (!targetNoteGuid) return;
      targetNoteOriginalPath = target.path;
      targetNoteMovedPath = `${folderPath}/${target.name}`;
      targetNotePosition = this.captureItemPosition(target, targetNoteGuid);
      try {
        targetFolder = this.app.vault.getAbstractFileByPath(folderPath) as TFolder | null;
        if (!(targetFolder instanceof TFolder)) {
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
          createdFolderPath, targetNoteOriginalPath, targetNoteMovedPath, targetNotePosition,
        );
        if (!restored) new Notice("创建失败，且未能完全恢复目标文件夹笔记；请检查文件树");
        new Notice(`创建父文档文件夹失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    if (targetFolder) {
      const destination = `${targetFolder.path}/${basename(source.path)}`;
      const sourceGuid = initialSourceGuid;
      const blocked = moveBlockReason(
        source.path,
        source instanceof TFolder,
        targetFolder.path,
        Boolean(this.app.vault.getAbstractFileByPath(destination)),
      );
      if (blocked === "self-or-descendant") {
        new Notice("不能把文件夹移动到它自己的子目录中");
        return;
      }
      if (blocked === "conflict") {
        new Notice("目标文件夹中已存在同名文件");
        return;
      }
      try {
        await this.renameTracked(source, destination);
      } catch (error) {
        const restored = await this.rollbackFolderNoteConversion(
          createdFolderPath, targetNoteOriginalPath, targetNoteMovedPath, targetNotePosition,
        );
        if (!restored) new Notice("移动失败，且未能完全恢复目标文件夹笔记；请检查文件树");
        new Notice(`移动失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (sourceGuid && this.folderKeySync(targetFolder) !== sourceGuid) {
        relocateGuid(
          this.data.orderByFolder,
          this.folderKeySync(targetFolder),
          sourceGuid,
          this.data.settings.newItemPlacement,
        );
      }
      this.queueSave(true);
      await this.flushSave();
      this.refreshExplorer();
      this.rememberDragUndo({
        sourceGuid,
        sourceOriginalPath,
        sourceMovedPath: destination,
        sourcePosition,
        createdFolderPath,
        targetNoteGuid,
        targetNoteOriginalPath,
        targetNoteMovedPath,
        targetNotePosition,
      });
      return;
    }

    const sourceGuid = initialSourceGuid;
    const targetGuid = this.getItemGuidSync(target);
    if (!sourceGuid || !targetGuid || !source.parent || !target.parent) return;

    if (source.parent.path !== target.parent.path) {
      const destination = target.parent.path
        ? `${target.parent.path}/${basename(source.path)}`
        : basename(source.path);
      const blocked = moveBlockReason(
        source.path,
        source instanceof TFolder,
        target.parent.path,
        Boolean(this.app.vault.getAbstractFileByPath(destination)),
      );
      if (blocked === "self-or-descendant") {
        new Notice("不能把文件夹移动到它自己的子目录中");
        return;
      }
      if (blocked === "conflict") {
        new Notice("目标目录中已存在同名文件");
        return;
      }
      this.pendingDropPlacements.set(sourceGuid, {
        parentPath: target.parent.path,
        targetGuid,
        before: position === "before",
      });
      try {
        await this.renameTracked(source, destination);
      } catch (error) {
        this.pendingDropPlacements.delete(sourceGuid);
        new Notice(`移动失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      // The vault rename event normally consumes the pending placement. Apply
      // the same idempotent operation here as well so an explicit drop is
      // persisted even when event persistence is disabled or delayed.
      this.placeGuidRelative(target.parent, sourceGuid, this.getItemGuidSync(target) || targetGuid, position === "before");
      this.queueSave(true);
      await this.flushSave();
      window.setTimeout(() => this.pendingDropPlacements.delete(sourceGuid), 1000);
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
        targetNotePosition: null,
      });
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
    this.rememberDragUndo({
      sourceGuid,
      sourceOriginalPath,
      sourceMovedPath: sourceOriginalPath,
      sourcePosition,
      createdFolderPath: null,
      targetNoteGuid: null,
      targetNoteOriginalPath: null,
      targetNoteMovedPath: null,
      targetNotePosition: null,
    });
  }

  refreshExplorer(): void {
    if (this.explorerRefreshFrame !== null) return;
    if (this.autoCopyScope) return;
    this.explorerRefreshFrame = window.requestAnimationFrame(() => {
      this.explorerRefreshFrame = null;
      this.performExplorerRefresh();
    });
  }

  private performExplorerRefresh(): void {
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
      this.scheduleFolderNoteRender();
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
    if (this.explorerPatchActive) return;
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

  /** 给设置项加一个"?"按钮，点击后显示完整说明。 */
  private addDetails(setting: Setting, title: string, paragraphs: string[]): void {
    setting.addExtraButton((button) => button
      .setIcon("help")
      .setTooltip("查看详细说明")
      .onClick(() => new SettingDetailsModal(this.app, title, paragraphs).open()));
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("yuque-sorting").setHeading();

    const section = (text: string): void => { new Setting(containerEl).setName(text).setHeading(); };

    const storageStatus = this.plugin.getOrderDataStatus();
    if (storageStatus !== "ready") {
      section("同步数据状态");
      new Setting(containerEl)
        .setName(storageStatus === "waiting" ? "等待排序数据" : "排序数据已暂停写入")
        .setDesc(storageStatus === "waiting"
          ? "先完成云端同步；如果这是全新库且云端没有排序数据，再手动初始化。"
          : "磁盘数据缺失、损坏或与本地改动冲突。处理前不会用内存数据覆盖磁盘。")
        .addButton(button => button.setButtonText("检查同步数据").onClick(() => void this.plugin.checkExternalOrderData(true).then(() => this.display())))
        .addButton(button => button.setButtonText(storageStatus === "waiting" ? "初始化本地顺序" : "处理冲突或恢复")
          .onClick(() => {
            if (storageStatus === "waiting") void this.plugin.initializeLocalOrderData().then(() => this.display());
            else this.plugin.openOrderDataResolution();
          }));
      return;
    }

    section("排序规则");
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
      .setDesc("顺序列表里没有记录的项目如何排列。")
      .addDropdown((dropdown) => dropdown
        .addOption("name-last", "按名称，排在末尾")
        .addOption("name", "按名称")
        .setValue(this.plugin.data.settings.fallbackSort)
        .onChange(async (value) => {
          this.plugin.data.settings.fallbackSort = value as "name" | "name-last";
          await this.plugin.saveSettings();
          this.plugin.refreshExplorer();
        }));
    const persistSetting = new Setting(containerEl)
      .setName("增删后立即保存顺序")
      .setDesc("新建、删除或改名后是否立即把顺序写入插件数据。")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.persistOrderOnCreateDelete).onChange(async (value) => {
        this.plugin.data.settings.persistOrderOnCreateDelete = value;
        await this.plugin.saveSettings();
      }));
    this.addDetails(persistSetting, "增删后立即保存顺序", [
      "开启（默认）：每次新建、删除、改名或移动后，插件都会把最新的目录顺序写入插件数据 data.json。",
      "关闭：这些操作只改动内存里的顺序，等下一次必须保存的操作（拖拽排序、更换或修复 GUID、跨 Vault 复制、保存设置）或插件卸载时才一起写入。",
      "关闭可以减少磁盘写入，降低多设备同步（Obsidian Sync 等）产生冲突的概率；代价是 Obsidian 异常退出时，自上次保存以来的增删改名顺序可能丢失。",
      "拖拽排序不受这个开关影响，始终立即保存。",
    ]);

    section("文件树交互");
    const dragSetting = new Setting(containerEl)
      .setName("启用文件树拖拽")
      .setDesc("开启后可在文件树里拖拽调整顺序。")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.enableDrag).onChange(async (value) => {
        this.plugin.data.settings.enableDrag = value;
        await this.plugin.saveSettings();
      }));
    this.addDetails(dragSetting, "启用文件树拖拽", [
      "拖到标题行的上 30% 或下 30% 可精确插入到目标上方或下方；拖到中间 40% 可移入文件夹或文件夹笔记。",
      "拖动过程中会显示插入线和动作提示，松手后立即生效。",
      "刚完成的拖拽可用命令“撤销上一次语雀拖拽”还原。",
    ]);
    const mergeSetting = new Setting(containerEl)
      .setName("合并展示配对文件夹笔记")
      .setDesc("把配对的文件夹笔记合并到一行显示。")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.mergePairedFolderNotes).onChange(async (value) => {
        this.plugin.data.settings.mergePairedFolderNotes = value;
        await this.plugin.saveSettings();
        this.plugin.refreshExplorer();
      }));
    this.addDetails(mergeSetting, "合并展示配对文件夹笔记", [
      "仅匹配位于同名文件夹内、且 f-/d- GUID 后缀相同的 Markdown。",
      "名称旁的 ↗ 表示已合并，点击标题打开文档。",
    ]);

    section("语雀清单");
    const restoreSetting = new Setting(containerEl)
      .setName("恢复原语雀目录顺序")
      .setDesc("按语雀导出清单恢复目录顺序；只按路径匹配，不改动文件与 GUID。")
      .addButton((button) => button.setButtonText("恢复原语雀目录顺序").onClick(() => void this.plugin.requestManifestImport()));
    this.addDetails(restoreSetting, "恢复原语雀目录顺序", [
      "读取库里的 _yuque_order.json（语雀导出清单），把各目录的显示顺序调回语雀里的原顺序。",
      "首次使用某份清单时会一并采用清单里的 GUID；之后再次执行只调顺序，不改动你后来更换过的 GUID。",
      "匹配只看清单中的路径，不看文件内容：已改名或移动过的项目无法恢复原顺序（会提示缺失/多出）；同一路径若已换成另一个文件，插件不会识别，会直接按清单位置排序。",
      "不会新建、删除、重命名或移动文件。只有点此按钮或命令才会执行，启动时绝不自动应用。",
    ]);

    section("GUID 管理");
    new Setting(containerEl)
      .setName("GUID 随机位数")
      .setDesc("新 GUID 的随机后缀长度。")
      .addDropdown((dropdown) => dropdown.addOption("64", "64 bit").addOption("72", "72 bit")
        .setValue(String(this.plugin.data.settings.guidBits)).onChange(async (value) => {
          this.plugin.data.settings.guidBits = value === "72" ? 72 : 64;
          await this.plugin.saveSettings();
        }));
    const auditSetting = new Setting(containerEl)
      .setName("检测未管理项目")
      .setDesc("只读扫描整个 Vault，确认后为未纳入管理的项目生成 GUID。")
      .addButton((button) => button.setButtonText("检测并纳入管理").onClick(() => void this.plugin.auditAndOfferManagement()));
    this.addDetails(auditSetting, "检测未管理项目", [
      "扫描本身只读，不会修改任何文件；只有确认后才会为缺少 GUID 的文件和文件夹生成 GUID。",
      "插件运行期间复制或新建的项目通常已被实时自动纳入，因此扫描结果可能为零。",
    ]);
    const manageSetting = new Setting(containerEl)
      .setName("将当前库中的文件或文件夹纳入本插件管理")
      .setDesc("为选中的项目补齐或重新生成 GUID。")
      .addButton((button) => button.setButtonText("选择文件和文件夹").onClick(() => this.plugin.openIdentitySelection()));
    this.addDetails(manageSetting, "将当前库中的文件或文件夹纳入本插件管理", [
      "范围包含所选文件夹本身以及文件夹下的全部内容。",
      "可只生成缺失的 GUID，也可重新生成选中项目的 GUID 并建立排序索引；修改后不改变原位置。",
      "该功能也可用作重置排序索引。",
    ]);
    new Setting(containerEl)
      .setName("启动时检测重复 GUID")
      .setDesc("启动时只读检测重复 GUID 并提示。")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.scanDuplicateGuidsOnStartup).onChange(async (value) => {
        this.plugin.data.settings.scanDuplicateGuidsOnStartup = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("重复 GUID")
      .setDesc("按完整 GUID 检测；修复时保留当前顺序中的首项。")
      .addButton((button) => button.setButtonText("检测并修复").onClick(() => void this.plugin.checkDuplicateGuids(true)));
    new Setting(containerEl)
      .setName("全库更换 GUID")
      .setDesc("为全部文件和文件夹换号，可选择是否创建恢复点。")
      .addButton((button) => button.setButtonText("不备份").onClick(() => void this.plugin.replaceAllGuids(this.plugin.data.settings.guidBits, false)))
      .addButton((button) => button.setButtonText("更换并备份").setWarning().onClick(() => void this.plugin.replaceAllGuids(this.plugin.data.settings.guidBits, true)));
    if (this.plugin.data.guidBackups.length) {
      new Setting(containerEl).setName("GUID 恢复点（最多 3 份）").setHeading();
      [...this.plugin.data.guidBackups].reverse().forEach((backup) => {
        new Setting(containerEl).setName(new Date(backup.createdAt).toLocaleString()).setDesc(`${backup.count} 项，${backup.bits} bit`)
          .addButton((button) => button.setButtonText("恢复").onClick(() => void this.plugin.restoreGuidBackup(backup)));
      });
    }

    section("旧库接管与跨库迁移");
    const legacySetting = new Setting(containerEl)
      .setName("接管历史 Obsidian Vault")
      .setDesc("为没有 GUID 的旧库补齐 GUID 并重建目录索引。")
      .addButton((button) => button.setButtonText("检查并接管历史库").onClick(() => void this.plugin.takeOverHistoricalVault()));
    this.addDetails(legacySetting, "接管历史 Obsidian Vault", [
      "适用于没有 GUID、没有插件 data.json 的旧库。",
      "补全缺失的 GUID 与目录索引，并按当前显示结构重建顺序；不移动或重命名文件。",
    ]);
    const transferSetting = new Setting(containerEl)
      .setName("跨Vault合并（自动复制）")
      .setDesc("从另一个 Vault 或目录复制文件与顺序，冲突可替换、重命名或编号。")
      .addButton(button => button.setButtonText("跨Vault合并（自动复制）").onClick(() => this.plugin.openLocalCopy()));
    this.addDetails(transferSetting, "跨Vault合并（自动复制）", [
      "选择源库和当前库中的目标目录，预检同名冲突后再执行；支持整项替换、重命名和编号。",
      "每次操作会在插件目录生成 local-copy-* 备份与记录文件夹。",
      "确认复制结果和排序都正常、且不再需要恢复记录后，可以删除对应的 local-copy-* 文件夹（例如 local-copy-DJKYhp）；不要删除插件目录中正在使用的 data.json。",
    ]);
  }
}
