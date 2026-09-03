import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
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
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
  console.log("Built main.js");
}
