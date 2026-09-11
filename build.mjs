import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const watch = process.argv.includes("--watch");
const DIST = "dist";
const localConfigPath = path.join(__dirname, ".yuque-sorting.local.json");
const localConfig = fs.existsSync(localConfigPath) ? JSON.parse(fs.readFileSync(localConfigPath, "utf8")) : {};
const TEST_PLUGIN_DIR = process.env.YUQUE_ORDER_TEST_PLUGIN_DIR || localConfig.testPluginDir;
// 插件更新需要的全部产物清单（data.json 是每个仓库的本地数据，不属于构建产物）
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

function syncDist() {
  // 先清空 dist，避免旧文件残留；构建失败时不会调用，保留上一份可用产物
  fs.rmSync(path.join(__dirname, DIST), { recursive: true, force: true });
  fs.mkdirSync(path.join(__dirname, DIST), { recursive: true });
  for (const file of ARTIFACTS) {
    fs.copyFileSync(path.join(__dirname, file), path.join(__dirname, DIST, file));
  }
  console.log(`Synced ${DIST}/ (${ARTIFACTS.join(", ")})`);
}

function fileHash(file) {
  return fs.existsSync(file)
    ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : null;
}

function syncTestVault() {
  if (!TEST_PLUGIN_DIR) return;
  fs.mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
  const dataFile = path.join(TEST_PLUGIN_DIR, "data.json");
  const dataHashBefore = fileHash(dataFile);
  for (const file of ARTIFACTS) {
    fs.copyFileSync(path.join(__dirname, DIST, file), path.join(TEST_PLUGIN_DIR, file));
  }
  if (fileHash(dataFile) !== dataHashBefore) {
    throw new Error(`Refusing deployment because ${dataFile} changed`);
  }
  console.log(`Synced test vault plugin: ${TEST_PLUGIN_DIR}`);
}

const syncDistPlugin = {
  name: "sync-dist",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        syncDist();
        syncTestVault();
      } else {
        console.error("Build failed; dist not updated.");
      }
    });
  },
};

const options = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2018",
  sourcemap: false,
  outfile: "main.js",
  logLevel: "info",
  plugins: [syncDistPlugin],
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
  console.log("Built main.js");
}
