# Yuque Sorting

Yuque Sorting is the Obsidian companion for current YuqueOut exports.

完整中文操作手册请参阅：[YuqueOut 与 Yuque Sorting 使用说明](./使用说明.md)。

## Workflow

1. In YuqueOut, choose 64-bit (default) or 72-bit GUIDs. Markdown identities and `_yuque_order.json` are generated automatically.
2. Copy the exported knowledge base into an Obsidian vault.
3. Install this folder as `.obsidian/plugins/yuque-sorting/` and enable it. If `data.json` is absent, sync that file first or explicitly run **初始化本地目录顺序** for a genuinely new vault.
4. Run **恢复原语雀目录顺序**. New export IDs adopt exported identities once; later explicit runs restore order only.

## Precise drag and drop

- Drop on the upper 30% of a title row to insert before it.
- Drop on the lower 30% to insert after it.
- Drop in the highlighted center of a folder or folder-note to move the item inside it.
- Follow the insertion line, target highlight, and pointer label for the exact action that will happen when released.
- Bind a custom hotkey to **撤销上一次语雀拖拽** in Obsidian. The current session keeps up to 50 safe undo steps without a timeout or repeated completion notices.

New files use `f-` identities and folders use independent `d-` identities. The suffix is Base62: 64-bit uses 11 alphanumeric characters and 72-bit uses 13. Legacy `f:`/`d:` identities remain readable. The plugin also detects exact duplicate GUIDs, can replace every vault identity without changing order, and keeps up to three on-demand backup files outside the always-loaded `data.json`.

The manifest is never imported automatically. An `exportId` initializes once unless the user explicitly invokes manifest-based order restoration; the plugin never deletes or rewrites it.

## Synced order data

An absent `data.json` leaves the plugin waiting without creating a competing local file. The settings page offers **检查同步数据** and explicit local initialization. While running, the plugin checks for external `data.json` changes and reloads a valid stable version. Independent changes to different folders can merge; overlapping changes pause writes and offer a choice after backing up the discarded version as `data-recovery-*.json`. Invalid, missing, or partially written data pauses writes rather than replacing it. A sync service can still choose not to download a remote version; the plugin cannot inspect a version that never reaches this vault.

The settings page also provides a read-only unmanaged-item audit, searchable multi-selection for GUID generation/regeneration, historical-vault takeover, and strict paired folder-note display. Pairing requires a direct `folder/folder.md` relationship plus identical `d-token`/`f-token` suffixes; hiding is DOM-only and never removes the note from ordering or disk.

## Compatibility note

Desktop **跨Vault合并（自动复制）** copies the contents of a selected source directory into the current Vault. Both fields offer native directory selection and absolute-path entry; an empty target means the current Vault root. Missing target directories are created only after final confirmation. Same-level conflicts offer whole-item replacement (with backups), renaming, or source-order numbering. Source files/order and unaffected target sibling order are preserved. Manual transfer-package import/export has been removed. See the Chinese guide for restrictions, cancellation, and recovery. No additional runtime dependency is required.

The File Explorer sorting hook uses Obsidian's internal `Folder.sort` implementation. It is guarded and falls back to Obsidian's default order if a future Obsidian release changes that internal interface. Ordinary folders moved in Windows Explorer are inherently weaker because their identity is stored in `data.json`; moving them inside Obsidian is recommended. Note identities remain stable because the guid travels in frontmatter.

## Development

Builds always update `dist/`. To also deploy into a local test Vault, set `YUQUE_ORDER_TEST_PLUGIN_DIR`, or create the ignored `.yuque-sorting.local.json` with a `testPluginDir` property pointing to that Vault's plugin directory. Without either setting, no Vault is modified. Deployment replaces only the three plugin artifacts and verifies that `data.json` is unchanged.

```bash
npm install
npm test
```

构建插件产物到 `dist/`：

```bash
npm run build
```

打包插件：

```bash
npm run pack
```

The build emits `main.js` beside `manifest.json` and `styles.css`, copies all three plugin artifacts into `dist/`, and deploys only those files to the configured test vault. Set `YUQUE_ORDER_TEST_PLUGIN_DIR` to override the default test-vault plugin directory. `data.json` and `guid-backups` are never copied or removed.

To update a manually loaded plugin, take the whole `dist/` folder and copy its three files into `.obsidian/plugins/yuque-sorting/`. Never overwrite `data.json` there — it holds the order data and identities for that specific vault.
