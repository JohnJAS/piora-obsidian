import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true, platform: "node", format: "cjs", target: "es2022", external: ["obsidian", "electron"], sourcemap: false });
await Promise.all(["manifest.json", "styles.css"].map((file) => copyFile(file, "dist/" + file)));
