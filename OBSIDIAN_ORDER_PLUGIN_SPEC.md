# Obsidian 语雀式拖拽排序（Order Drag）插件 与 YuqueOut 导出配合 —— 开发规格书

> **现行强制规则：** `_yuque_order.json` 只能由用户通过命令或设置按钮手动导入；启动和任何文件事件都不得自动导入。导入前必须校验实际身份与层级，不一致时由用户选择放弃或继续。仓库根目录 `AGENTS.md` 的回归约束优先于本文早期设计。

> 用途：交给另一个 AI / 开发者实现。本文档自包含，不需要本文档之外的对话上下文。
> 目标：让语雀（Yuque）知识库导出到 Obsidian 后，获得**接近语雀的目录排序体验**：文件名不带序号前缀、可按任意顺序拖拽排序、改名/移动/增删文件都不破坏顺序、顺序不依赖文件名、也不依赖每篇笔记的一个 `order` 字段。

---

## 1. 背景与用户需求（验收基线）

用户痛点（必须全部解决）：

1. **不要文件名前缀**。像 `01-章节`、`01-文档.md` 这种数字前缀太丑，不能接受。
2. **要语雀那种拖拽体验**。在目录里直接拖拽即可重排、可拖到某文档下成为其子文档（嵌套/改父级），顺序自动记住。
3. **频繁移动/重命名文件、文件夹**，顺序不能被破坏、不需要逐个改名字/改序号。
4. **顺序要有稳定的身份载体**。顺序索引不能以**文件名/路径**为键（改名/移动就断），而要以**文件本身的某个稳定属性**为键。
5. **不依赖每篇笔记的 `order` 字段**作为日常排序机制（笔记尽量干净，只带一个身份字段）。
6. 用户**经常在 Windows 资源管理器**（Obsidian 之外）增删改文件，希望同样能自动维护顺序。
7. 从语雀导出的文档，**首次导入 Obsidian 后顺序要与语雀一致**（导出端与 Obsidian 端必须协调）。

---

## 2. 总体架构（两个组件 + 一个契约）

实现分两部分，外加它们之间的一份「协作契约」。

| 组件 | 是什么 | 职责 |
|------|--------|------|
| **组件 A：YuqueOut（Chrome 扩展，已存在）** | 语雀 → Markdown 导出 | 为每篇导出文档写稳定 `guid`；在知识库根目录生成 `_yuque_order.json`（顺序清单） |
| **组件 B：Obsidian 插件（新建）** | Obsidian 插件 | 用 `guid` 做稳定身份；按「每文件夹 guid 有序列表」维护顺序；patch 文件树按该顺序渲染；支持拖拽重排/嵌套；监听增删改移；仅在用户明确操作后读取 manifest 播种语雀顺序 |

**协作契约（选型 B）**：
- **身份**：每个可排序项（笔记 / 文件夹）有一个**唯一且稳定**的 `guid`。
  - 导出自语雀的笔记：`guid = yq-<语雀文档id>`（语雀文档 id 稳定且唯一）。
  - Obsidian 内新建的笔记：随机 UUID（如 `obs-<uuid>`，或纯 UUID）。
  - 文件夹：优先用「文件夹笔记」里的 guid；否则由插件在 `data.json` 维护 `路径→guid` 映射。
- **顺序**：不写进文件、不用文件名；由**组件 B 的 `data.json`** 按「每个文件夹一个有序 guid 列表」存储。
- **语雀顺序的传递**：组件 A 在每个知识库根目录写 `_yuque_order.json`；组件 B 首次导入时读取它，**播种**各文件夹的 guid 顺序，从而初始顺序 = 语雀顺序。

---

## 3. 关键设计决策（为什么这么做）

- **稳定身份用 guid，不用文件名/路径**：Obsidian 的 `path`/`name` 在改名/移动时都会变，API 也不暴露稳定的文件 id。唯一能跟着文件走、跨改名/移动的，是**写进笔记 frontmatter 里的字段**。所以给每篇笔记写一个一次性生成、永不改变的 `guid`。
- **顺序是「每文件夹一个有序 guid 列表」，不是「每个文件一个数字」**：这样增/删/移动/拖拽都只是改这个列表，**永远不需要重编号，也不会动邻居文件**。这是相对 `order`/前缀方案的本质优势。
- **语雀文档 id 当 guid**：稳定、唯一；同一篇文档反复导出 guid 不变，因此**重导后插件能识别同一文档、保留或重同步顺序**，天然解决「重导打乱顺序」。
- **顺序放插件 `data.json`（不在文件里）**：换取「文件干净、只带一个 guid」；代价是顺序不跨设备/不扛「重新导入全新库」，需靠 `data.json` 同步，或重导后重新播种。用户已接受该取舍（选 B）。

---

## 4. 组件 A：YuqueOut 扩展改动

> YuqueOut 是 Chrome MV3 扩展，核心导出在 `src/core/exporter.js`（本地 Lake→MD 路径与官方 API 路径），文件路径构建在 `src/core/utils.js`，frontmatter 处理在 `withOrderFrontmatter()`（`src/core/utils.js`），设置项在 `src/core/constants.js` 的 `DEFAULT_SETTINGS`，设置 UI 在 `src/settings.html`+`src/settings.js`，国际化在 `_locales/zh_CN`, `_locales/en`。

### 4.1 为每篇导出笔记写 `guid`

- 在每篇导出 Markdown 的 frontmatter 增加：
  ```yaml
  ---
  guid: yq-<语雀文档id>
  title: 文档标题
  ---
  ```
- `<语雀文档id>` 取自导出文件的稳定 id（现有 `file.id`，即语雀 doc id；图片命名已用到，如 `文档名-101-1.png`）。必须是**该文档的稳定、唯一 id**，不能是随机值。
- 若文档无稳定 id（极端情况），退化为生成一次并存入 frontmatter 的 UUID，但**优先用语雀 id**。
- 写 guid 的时机与位置：与现有 `withOrderFrontmatter()` 类似——**合并进已有 frontmatter**，不覆盖其它键；若已存在 `guid` 则跳过。

### 4.2 生成 `_yuque_order.json`（manifest）

- 位置：每个知识库**根目录**，文件名固定 `_yuque_order.json`。
- 内容：完整目录树，每个节点含 `guid`（语雀稳定 id）、`title`（语雀标题）、`order`（层级序号，如 `1`、`1.1`）、`children` 数组。**记录语雀原始目录顺序**。
- 示例：
  ```json
  {
    "version": 1,
    "source": "yuque",
    "book": "导出测试",
    "generatedAt": "2026-01-01T00:00:00Z",
    "tree": [
      { "guid": "yq-101", "title": "文档1", "order": "1",  "children": [
          { "guid": "yq-111", "title": "文档1-1", "order": "1.1", "children": [
              { "guid": "yq-1111", "title": "文档1-1-1", "order": "1.1.1", "children": [] }
          ]},
          { "guid": "yq-113", "title": "文档1-3", "order": "1.2", "children": [] },
          { "guid": "yq-112", "title": "文档1-2", "order": "1.3", "children": [
              { "guid": "yq-1121", "title": "文档1-2-1", "order": "1.2.1", "children": [] }
          ]}
      ]},
      { "guid": "yq-103", "title": "文档3", "order": "2",  "children": [] },
      { "guid": "yq-102", "title": "文档2", "order": "3",  "children": [
          { "guid": "yq-121", "title": "文档2-1", "order": "3.1", "children": [] }
      ]}
    ]
  }
  ```
- `order` 字段只用于**让组件 B 播种**；组件 B 读取后，逐文件夹按其子节点顺序生成 guid 列表。
- **注意**：B 方案下，每篇笔记**不再需要**写 `order` 字段。现有扩展有「写入 order 排序字段」开关，B 模式下应默认关闭（仅保留 `guid`）。可保留该开关但默认关，或移除。
- manifest 里的 `order` 与 frontmatter 的 `order` **不同**：manifest 是给插件播种用的「顺序清单」，存在文件中；frontmatter 的 `order` 是用户已否定的「每篇字段」，B 模态下不用。

### 4.3 与现有导出结构的关系

- **文件夹笔记模式**（父文档为 `父/父.md`）**保持开启**：这正是组件 B 识别「文件夹」与「父文档」的关键（文件夹身份 = 文件夹笔记的 guid）。
- **层级序号前缀**：导出端可继续关掉（用户不要前缀）。若用户在导出端仍开着前缀，组件 B 也不依赖它——组件 B 只认 `guid` 与 manifest。
- **附件目录 / 图片命名**：保持导出逻辑；附件及任意非 `.md` 文件参与 Obsidian 排序，其稳定身份由插件保存在 `data.json.fileGuids`，不写入文件内容。
- **README 索引**：可与 manifest 并存；但组件 B 的排序以 manifest/guid 为准。

### 4.4 设置项（导出端，新增）

- `writeGuid`（默认开）：为每篇笔记写 `guid`。
- `generateOrderManifest`（默认开，B 模态）：生成 `_yuque_order.json`。
- （B 模态）`writeOrderField`：默认关闭，说明改为「不再写入每篇 `order`，顺序改由 manifest 承载」。
- 相应更新 `settings.html`、`settings.js`、`_locales/zh_CN`、`_locales/en`。

---

## 5. 组件 B：Obsidian 插件（核心，新建工程）

> Obsidian 社区插件，TypeScript + esbuild/tsup，产出 `main.js`/`manifest.json`/`styles.css`。可用 Obsidian CLI 或手写构建。需在 Obsidian 里「加载未打包扩展」测试。

### 5.1 身份：`guid`

- **笔记**：优先读 frontmatter 的 `guid`；没有则**生成一个 UUID 并写回 frontmatter**（一次性）。生成后永不改。
- **文件夹**：
  - 若是「文件夹笔记」结构（`文件夹/文件夹.md`）：文件夹身份 = 里面那篇笔记的 `guid`。
  - 否则（普通/空文件夹）：插件在 `data.json` 维护 `路径→guid` 映射，并在改名/移动时更新映射键。
- **键名**：默认 `guid`，做成设置项（可改，避免与用户已有字段冲突）。

### 5.2 顺序存储（`data.json` 结构）

```json
{
  "version": 1,
  "settings": { "...": "..." },
  "orderByFolder": {
    "<folderKey>": ["<childGuid1>", "<childGuid2>", "..."]
  },
  "folderGuids": {
    "<folderPath>": "<folderGuid>"
  }
}
```
- `orderByFolder[<folderKey>]` = 该文件夹下**子项的有序 guid 列表**。`<folderKey>` 用文件夹的 guid（文件夹笔记时 = 其笔记 guid；否则 = `folderGuids` 的值）；根的 `folderKey` 用特殊值（如 `"__root__"`）。
- 顺序是**列表**，不是每个 guid 一个数字 → 增删/拖拽只改列表，无需重编号。
- 无排序数据的项（未进列表的 guid）在渲染时**兜底**：按名字排、排在末尾（设置可调）。

### 5.3 渲染：把文件树按顺序显示

- 参考 Flexplorer/custom-sort 的做法：**patch Obsidian 的 `FileExplorerView`**，在返回`sort()`时按 `orderByFolder` 重排其子项。
- 关键：用 `metadataCache.getFileCache(file)?.frontmatter?.['guid']` 拿到每个笔记的 guid（**内存缓存，不读盘**），据此按 `orderByFolder` 排序；文件夹用其文件夹笔记的 guid 或 `folderGuids`。
- `FileExplorerView` 的 patch 是 Obsidian 内部接口，**版本升级可能需微调**——文档需注明这一点，实现时尽量用稳的 hook，并做容错（patch 失败则回退默认排序，不崩）。

### 5.4 拖拽交互（语雀手感）

- **拖拽重排**：在文件树内拖动一个项到同级某个位置，更新该文件夹的 `orderByFolder` 列表（把 guid 移到新位置），写回 `data.json`（防抖）。
- **拖拽嵌套（改父级）**：把一个项拖到另一篇文档上，使其成为其子文档。Obsidian 文件树原生支持拖动改父级（改路径）；组件 B 在其后把该 guid 从旧文件夹列表移入新文件夹列表。若目标成为「有子文档的父文档」，应配合 Folder Notes 约定（父文档 `父/父.md`）。
- **插入位置指示/自动缩进**：拖拽时显示落点与层级提示（增强可选项）。
- 拖拽结束后，对受影响的文件夹**重新按 `orderByFolder` 排序**。

### 5.5 事件处理（含外部 Windows 资源管理器操作）

Obsidian 监听 vault 文件系统变化，因此**即使你在资源管理器里增删改，Obsidian 也会触发对应事件**（前提：Obsidian 开着、该 vault 打开）。组件 B 处理：

| 事件 | 处理 |
|------|------|
| `create` | Markdown 读写 frontmatter `guid`；非 Markdown 在 `fileGuids` 中生成/复用身份；文件夹登记 `folderGuids`。新身份按设置插入父文件夹列表，已有兄弟项相对顺序不变。 |
| `delete` | 从父文件夹列表移除该 guid（清理孤儿 `folderGuids` 项）。其他项不受影响（列表只是一项变少）。 |
| `rename`（含移动） | 同目录改名保持原位；跨目录移动从旧父级移除并按新增项策略插入新父级。普通文件夹还需迁移 `路径→guid` 映射；笔记 guid 随 frontmatter 保持不变。 |
| `modify` | 忽略；修改 manifest 也不得自动触发导入。 |

**关键韧性规则**（应对资源管理器操作被 Obsidian 当成「删除旧路径 + 新增新路径」处理）：
> 每当笔记以「新增」出现，**优先读它 frontmatter 已有的 `guid`**，有就复用，只有没有才生成。

这样即使在资源管理器里改名/移动，guid 随文件走，插件在新路径上一读即复用，**身份不丢**；只是该笔记在新文件夹里的位置会落到顶部/底部，用户拖一下归位。

**注意**：普通文件夹（无文件夹笔记）在资源管理器里移动/重命名是相对弱的一环（身份在 `data.json` 映射里、不在文件里）。建议在文档里提示：**结构性文件夹改名/移动尽量在 Obsidian 内进行**；笔记在资源管理器里随意动都稳。

**启动对账**：插件启动时做一次全量扫描对账（补 guid、清孤儿、维护已有顺序），以兜底 Obsidian 关闭期间的外部改动；不得读取 manifest 并应用顺序。

### 5.6 读取 manifest 播种（首次导入 / 重导）

- 只有用户执行命令或点击设置按钮时，才读取 `_yuque_order.json`，按树状顺序为各文件夹生成 `orderByFolder`（用每个节点的 `guid`，与 vault 中 frontmatter 的 `guid` 匹配）。
- 匹配方式：遍历树，对每个节点，按 `guid` 找到 vault 中对应笔记/文件夹（笔记 guid 在 frontmatter；文件夹 = 其文件夹笔记的 guid），确定其所在文件夹，按 manifest 中兄弟顺序填入 `orderByFolder`。
- 提供「导入/重同步顺序」命令（命令面板）与设置按钮；导入前校验缺失、多余、层级和重复 GUID，不一致时必须由用户确认。
- 重导一致性：因 `guid` 稳定（= 语雀 id），重导同一批文档后，旧列表中 guid 仍匹配；可选「按 manifest 重新同步」以让顺序回到语雀最新顺序，或保留已有拖拽顺序。

### 5.7 设置项（插件端）

- `orderFrontmatterKey`：身份键名，默认 `guid`。
- `newItemPlacement`：新增项放顶部/底部，默认底部。
- `fallbackSort`：无顺序数据的项如何排（按名字、放最后）。
- 不提供 `autoSeedFromManifest`；manifest 永远不得自动播种。
- `persistOrderOnCreateDelete`：是否在增删后立即写 `data.json`（关掉可减少 Obsidian Sync 冲突，参考 Flexplorer）。
- 其它：是否显示标题而非文件名（增强）、是否启用拖拽嵌套等。

### 5.8 性能

- **渲染**：从 `metadataCache` 读 guid（内存），不读盘；分组+排序内存操作，几千篇也可接受；监听变更后**防抖**重排。
- **拖拽**：只写插件 `data.json`（防抖），**不重写任何笔记 frontmatter**。
- **一次性成本**：首次为「无 guid 的旧笔记」补写 guid 是一次性批量（可后台+限速，或用「启用时批量/用到才补」开关控制）。
- 建议 `data.json` 写入防抖，避免频繁写盘。

### 5.9 边界情况

- **附件/非 .md**：不修改文件内容；身份保存在 `data.json.fileGuids`，与 Markdown 和文件夹一起参与排序。
- **同名文件 / 重命名冲突**：guid 唯一，不受影响。
- **文件夹身份**：文件夹笔记结构最稳；普通文件夹靠 `路径→guid` 映射（改/移时更新）。
- **Obsidian 升级** `FileExplorerView` 内部结构变化：patch 失效时回退默认排序并提示，不崩。
- **Obsidian Sync 多设备**：`data.json` 可能的同步冲突，提供 `persistOrderOnCreateDelete` 关闭选项；顺序跨设备需同步该文件（或重导重新播种）。
- **manifest 缺失**：不播种，按已有顺序或兜底排序；用户可手动拖。

---

## 6. 协作契约：manifest 格式（定稿）

- 文件：每个知识库根目录 `_yuque_order.json`
- 顶层字段：`version`（int，当前 1）、`source`（`"yuque"`）、`book`（知识库名）、`generatedAt`（ISO 时间）、`tree`（数组）。
- 树节点字段：`guid`（string，`yq-` 前缀）、`title`（string）、`order`（string，层级序号如 `1`/`1.1`）、`children`（数组，可能为空）。
- 语义：`tree` 数组顺序 = 语雀目录顺序；`children` 中的顺序 = 该父文档下的子文档顺序。插件只读取顺序，不依赖 frontmatter `order`。
- 版本兼容：组件 B 校验 `version`；未来升级通过 `version` 区分。

---

## 7. 用户工作流（使用场景）

1. 用 **YuqueOut** 导出知识库（设置：去掉「层级序号前缀」；开启写 `guid` + 生成 `_yuque_order.json`；关闭每篇 `order`）。
2. 把导出的知识库文件夹放入（或复制进）Obsidian vault。
3. 安装 **组件 B 插件** 并启用；由用户在命令面板或设置页手动执行“检查并导入”。
4. 之后在 Obsidian 里：**直接拖拽**调整顺序、拖动嵌套改父子；顺序自动记住。
5. 在 Obsidian 或 Windows 资源管理器里改名/移动/增删文件，顺序自动维护（笔记最稳；文件夹结构性操作建议在 Obsidian 内）。
6. 若再次从语雀导出（同一批文档），可再次「导入顺序」恢复语雀最新顺序。

---

## 8. 分阶段建议（v1 → v2）

**v1（核心闭环）**
- 组件 B：guid 身份 + `orderByFolder` 列表 + patch 文件树按序显示 + 文件树内**拖拽重排** + 事件处理（create/delete/rename/move）+ 读取 manifest 播种 + 设置项 + 性能处理。
- 组件 A：写 `guid` + 生成 `_yuque_order.json` + 相应设置/文案。
- 验收：导出→导入→顺序=语雀；拖拽重排生效；改名/移动/增删后顺序稳定。

**v2（更接近语雀）**
- 专属「目录」有序视图（侧边栏）：按顺序列出文档，显示 **title/aliases** 而非文件名；在该视图内拖拽重排/拖拽嵌套（最接近语雀）。
- 拖拽插入位置指示/自动缩进。
- 拖拽嵌套（改父级）的完善与 Folder Notes 联动。
- 重排/嵌套后联动更新父级目录页（可选）。

---

## 9. 验收标准 / 测试清单

- [ ] 导出后笔记 frontmatter 含稳定 `guid: yq-<id>`，无文件名前缀。
- [ ] 知识库根目录生成 `_yuque_order.json`，`tree` 顺序与语雀一致。
- [ ] 导入 Obsidian 后，文件树顺序 = 语雀顺序（经 manifest 播种）。
- [ ] 在文件树拖拽重排：顺序更新并持久化（重启 Obsidian 仍保持）。
- [ ] 拖拽到另一文档下成为子文档（嵌套），父级自动成文件夹。
- [ ] 在 Obsidian 里**重命名**笔记/文件夹：顺序不变。
- [ ] 在 Obsidian 里**移动**笔记到别处：身份保留，不重设顺序（只可能落顶/底，拖一下归位）。
- [ ] 在 **Windows 资源管理器**里新增/删除/改名/移动：Obsidian 重开或自动检测后，guid 与顺序被正确维护（文件级最稳）。
- [ ] 删除文件：从父文件夹列表移除，其余顺序不变。
- [ ] Obsidian 新建笔记：自动获得 guid，并按「新增项放置」插入。
- [ ] 附件/非 .md 文件参与稳定排序，不改写文件内容；改名和移动时 `fileGuids` 路径映射正确迁移。
- [ ] 再次从语雀导出同一批文档：可重新播种，顺序回到语雀最新顺序。
- [ ] `data.json` 写入防抖；`FileExplorerView` patch 失败时回退默认排序且不崩。
- [ ] 设置项、命令面板「导入/重同步顺序」可用；国际化（zh/en）齐全。

---

## 10. 需实现方注意的风险与开放问题

- **`FileExplorerView` patch 是 Obsidian 内部接口**：版本升级可能失效，务必容错回退。可参考 Flexplorer（`kh4f/flexplorer`，已开源，含 `src/ui/menu.ts` 的 `SORT_OPTIONS`、`src/core/order-manager.ts` 的 `move`/增量处理、`src/plugin.ts` 的事件监听）与 custom-sort（`SebastianMC/obsidian-custom-sort`，含 `by-metadata:` 语法）的实现思路。**不要照搬名称键**，需改为 guid 键。
- **Obsidian 无稳定文件 id**：唯一稳定身份必须写进笔记 frontmatter（`guid`）；**无法**用 `path`/`name` 或其他系统属性替代。
- **普通文件夹**（无文件夹笔记）在资源管理器里结构性移动是弱项；文档建议用户在 Obsidian 内做结构性改动。
- 是否提供「把顺序同时写回 frontmatter（可选）」以换取跨设备可移植性：当前 B 方案**不做**（顺序在 `data.json`），如需可加为可选开关。
- `order` 字段与 manifest 的 `order` 语义区隔：前者是用户已否定的每篇字段（B 方案关闭），后者是给插件播种用的清单。

---

## 11. 交付物

- **组件 A 改动**（YuqueOut 仓库内）：`guid` 写入、`_yuque_order.json` 生成、设置项与 i18n 更新。
- **组件 B 新建**（独立 Obsidian 插件工程）：`manifest.json`、`main.ts`（可拆模块）、`styles.css`、构建脚本；实现 5.1–5.9。
- 一份「使用说明」（略，可在本规格基础上补）。
