/** Desktop-only, on-demand native directory chooser. No shell interpolation of user paths. */
export async function chooseDirectory(load: (name: string) => any, title: string, initial: string): Promise<string | null> {
  const electron = load("electron");
  let dialog = electron.dialog || electron.remote?.dialog;
  if (!dialog) { try { dialog = load("@electron/remote").dialog; } catch { /* Optional host capability, not a dependency. */ } }
  if (dialog?.showOpenDialog) {
    const result = await dialog.showOpenDialog({ title, defaultPath: initial || undefined, properties: ["openDirectory", "dontAddToRecent"] });
    return result.canceled ? null : result.filePaths?.[0] || null;
  }
  const process = load("process");
  if (process.platform !== "win32") throw new Error("当前宿主未提供目录选择窗口，请手动填写绝对路径");
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = $env:YQ_PICK_TITLE; $picker.SelectedPath = $env:YQ_PICK_INITIAL; $picker.ShowNewFolderButton = $false; try { if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) } } finally { $picker.Dispose() }';
  return new Promise((resolve, reject) => {
    load("child_process").execFile("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024, env: { ...process.env, YQ_PICK_TITLE: title, YQ_PICK_INITIAL: initial } },
      (error: Error | null, stdout: string) => error ? reject(new Error("无法打开系统目录选择窗口，请手动填写绝对路径")) : resolve(stdout.trim() || null));
  });
}
