/**
 * “恢复原语雀目录顺序”确认窗口的结构化排版。
 *
 * 纯文本摘要仍由 main.ts 生成，用于取消/确认日志与测试断言；这里只把同一份
 * 数据排版成更易读的卡片、预览列表和差异分组。视图不读取 Vault，也不写入数据。
 */

export interface ManifestRestorePreview {
  folder: string;
  current: string;
  next: string;
}

export interface ManifestRestoreView {
  manifestCount: number;
  changedDirectories: number;
  changedPositions: number;
  previews: ManifestRestorePreview[];
  problems: string[];
  newManifests: number;
}

export const MANIFEST_PREVIEW_LIMIT = 10;
export const MANIFEST_PROBLEM_LIMIT = 12;

/** 差异项通常写作“路径：原因”；没有分隔符时整条作为原因显示。 */
export function splitManifestProblem(problem: string): { path: string; reason: string } {
  const separator = problem.indexOf("：");
  if (separator === -1) return { path: "", reason: problem };
  return { path: problem.slice(0, separator), reason: problem.slice(separator + 1) };
}

export function renderManifestRestoreView(container: HTMLElement, view: ManifestRestoreView): void {
  const wrap = container.createDiv({ cls: "yq-manifest-restore" });

  const statsEl = wrap.createDiv({ cls: "yq-manifest-stats" });
  const stats: Array<{ label: string; value: string; tone?: "ok" | "warn" }> = [
    { label: "有效清单", value: `${view.manifestCount} 份` },
    { label: "顺序将变化", value: `${view.changedDirectories} 个目录`, tone: view.changedDirectories ? "warn" : "ok" },
    { label: "显示位置不同", value: `${view.changedPositions} 处`, tone: view.changedPositions ? "warn" : "ok" },
    { label: "清单差异", value: `${view.problems.length} 项`, tone: view.problems.length ? "warn" : "ok" },
  ];
  stats.forEach(({ label, value, tone }) => {
    const cell = statsEl.createDiv({ cls: `yq-manifest-stat${tone ? ` is-${tone}` : ""}` });
    cell.createSpan({ cls: "yq-manifest-stat-label", text: label });
    cell.createSpan({ cls: "yq-manifest-stat-value", text: value });
  });

  wrap.createEl("p", {
    cls: "yq-manifest-status",
    text: view.changedDirectories
      ? "下列示例目录的显示顺序将与清单不同；确认后按清单顺序排列，未列出的变化目录同样处理。"
      : "当前可匹配项目的显示顺序与清单一致，确认后不会改变任何目录的现有顺序。",
  });

  const previews = view.previews.slice(0, MANIFEST_PREVIEW_LIMIT);
  if (previews.length) {
    const section = wrap.createDiv({ cls: "yq-manifest-section" });
    section.createEl("h4", { text: `顺序变化示例（${previews.length} / ${view.changedDirectories}）` });
    const list = section.createEl("ul", { cls: "yq-manifest-preview" });
    previews.forEach(({ folder, current, next }) => {
      const item = list.createEl("li");
      item.createDiv({ cls: "yq-manifest-folder", text: folder });
      const currentRow = item.createDiv({ cls: "yq-manifest-order" });
      currentRow.createSpan({ cls: "yq-manifest-tag", text: "当前" });
      currentRow.createSpan({ text: current });
      const nextRow = item.createDiv({ cls: "yq-manifest-order is-next" });
      nextRow.createSpan({ cls: "yq-manifest-tag", text: "恢复后" });
      nextRow.createSpan({ text: next });
    });
  }

  if (view.problems.length) {
    const section = wrap.createDiv({ cls: "yq-manifest-section is-problems" });
    section.createEl("h4", { text: `清单差异（${view.problems.length}）` });
    const list = section.createEl("ul", { cls: "yq-manifest-problems" });
    view.problems.slice(0, MANIFEST_PROBLEM_LIMIT).forEach((problem) => {
      const { path, reason } = splitManifestProblem(problem);
      const item = list.createEl("li");
      if (path) item.createDiv({ cls: "yq-manifest-path", text: path });
      item.createDiv({ cls: "yq-manifest-reason", text: reason });
    });
    if (view.problems.length > MANIFEST_PROBLEM_LIMIT) {
      list.createEl("li", { cls: "yq-manifest-more", text: `另有 ${view.problems.length - MANIFEST_PROBLEM_LIMIT} 项……` });
    }
    section.createEl("p", { cls: "yq-manifest-hint", text: "继续仅处理能够匹配的项目，以上差异不会自动修复。" });
  }

  const notes: string[] = [
    view.newManifests
      ? `${view.newManifests} 份清单为首次使用，将采用清单里的 GUID 并建立索引；Markdown 正文不改写。`
      : "仅恢复顺序，不覆盖后来更换的 GUID。",
    "匹配只看清单中的路径，不看文件内容：已改名或移动过的项目无法恢复原顺序，会提示缺失/多出。",
  ];
  // 首次执行会额外校验 Markdown 的 GUID；重复执行时不再校验，因此同路径换文件不会被发现。
  if (view.newManifests < view.manifestCount) {
    notes.push("同一路径若已换成另一个文件，插件不会识别，会直接按清单位置给它排序。");
  }
  notes.push("不移动、重命名或删除实际文件。");
  notes.push("确认后会清空拖拽撤销历史；取消或关闭窗口不修改数据。");
  const noteList = wrap.createEl("ul", { cls: "yq-manifest-notes" });
  notes.forEach((note) => noteList.createEl("li", { text: note }));
}
