# Yuque Order Drag

Yuque Order Drag is the Obsidian companion for YuqueOut V1 exports.

## V1 workflow

1. In YuqueOut, keep `写入稳定 guid` and `生成 _yuque_order.json` enabled. Turn off `层级序号前缀` and the legacy per-note `order` field.
2. Copy the exported knowledge base into an Obsidian vault.
3. Install this folder as `.obsidian/plugins/yuque-order-drag/`, enable the plugin, and let it scan the vault.
4. Run **导入/重同步语雀顺序清单** (or click **检查并导入** in settings) when you explicitly want to apply `_yuque_order.json`.

## Precise drag and drop

- Drop on the upper 30% of a title row to insert before it.
- Drop on the lower 30% to insert after it.
- Drop in the highlighted center of a folder or folder-note to move the item inside it.
- Follow the insertion line, target highlight, and pointer label for the exact action that will happen when released.

The plugin stores order lists plus ordinary-folder and non-Markdown-file identities in its own `data.json`. Markdown files receive one stable identity field (`guid` by default). Images, PDFs, Canvas files, JSON, and every other `TFile` type participate in the same stable ordering; their identities are path-migrated in `data.json` on rename or move.

The manifest is never imported automatically—not at startup and not after create, delete, rename, move, or modify events. Before a manual import, the plugin compares identities and hierarchy with the current vault. A mismatch requires explicit confirmation; continuing changes only matched ordering and never creates, deletes, renames, or moves files.

## Compatibility note

The File Explorer sorting hook uses Obsidian's internal `Folder.sort` implementation. It is guarded and falls back to Obsidian's default order if a future Obsidian release changes that internal interface. Ordinary folders moved in Windows Explorer are inherently weaker because their identity is stored in `data.json`; moving them inside Obsidian is recommended. Note identities remain stable because the guid travels in frontmatter.

## Development

```bash
npm install
npm run build
npm test
```

The build emits `main.js` beside `manifest.json` and `styles.css`, and copies all three plugin artifacts into `dist/`.

To update a manually loaded plugin, take the whole `dist/` folder and copy its three files into `.obsidian/plugins/yuque-order-drag/`. Never overwrite `data.json` there — it holds the order data and identities for that specific vault.
