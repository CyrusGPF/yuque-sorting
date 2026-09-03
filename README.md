# Yuque Order Drag

Yuque Order Drag is the Obsidian companion for YuqueOut V1 exports.

## V1 workflow

1. In YuqueOut, keep `写入稳定 guid` and `生成 _yuque_order.json` enabled. Turn off `层级序号前缀` and the legacy per-note `order` field.
2. Copy the exported knowledge base into an Obsidian vault.
3. Install this folder as `.obsidian/plugins/yuque-order-drag/`, enable the plugin, and let it scan the vault.
4. The plugin seeds each folder's order from `_yuque_order.json`. Afterwards, drag items in the File Explorer to reorder them. Dragging to a folder, or to a folder-note that already has a matching folder, moves an item into that folder.

The plugin stores only order lists and ordinary-folder identities in its own `data.json`. Markdown files receive one stable identity field (`guid` by default); attachments and other non-Markdown files are ignored.

Use the command **导入/重同步语雀顺序清单** when a later Yuque export should become the current order again. Automatic seeding only runs when a manifest changes, so normal Obsidian restarts do not erase manual rearrangements.

## Compatibility note

The File Explorer sorting hook uses Obsidian's internal `Folder.sort` implementation. It is guarded and falls back to Obsidian's default order if a future Obsidian release changes that internal interface. Ordinary folders moved in Windows Explorer are inherently weaker because their identity is stored in `data.json`; moving them inside Obsidian is recommended. Note identities remain stable because the guid travels in frontmatter.

## Development

```bash
npm install
npm run build
npm test
```

The build emits `main.js` beside `manifest.json` and `styles.css`, ready for a manually loaded plugin directory.
