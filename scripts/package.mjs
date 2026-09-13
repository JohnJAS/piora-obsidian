import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const ASSETS = ["main.js", "manifest.json", "styles.css"];
export async function packagePlugin(distDirectory = resolve("dist"), outputDirectory = resolve("release")) {
  const manifest = JSON.parse(await readFile(join(distDirectory, "manifest.json"), "utf8"));
  if (manifest.id !== "piora-obsidian" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("invalid plugin manifest version");
  for (const file of ASSETS) { const info = await stat(join(distDirectory, file)); if (!info.isFile() || info.size === 0) throw new Error(`invalid asset: ${file}`); }
  await mkdir(outputDirectory, { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), "piora-package-stage-"));
  const zip = join(outputDirectory, `piora-obsidian-v${manifest.version}.zip`);
  const sha = `${zip}.sha256`;
  try {
    for (const file of ASSETS) await writeFile(join(stage, file), await readFile(join(distDirectory, file)));
    if (process.platform === "win32") await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path '${zip}') { Remove-Item -LiteralPath '${zip}' -Force }; [IO.Compression.ZipFile]::CreateFromDirectory('${stage}','${zip}',[IO.Compression.CompressionLevel]::Optimal,$false)`]);
    else await run("zip", ["-q", "-j", zip, ...ASSETS.map(file => join(stage, file))]);
    const digest = createHash("sha256").update(await readFile(zip)).digest("hex");
    await writeFile(sha, `${digest}  ${zip.split(/[\\/]/).pop()}\n`);
    return { zip, sha256: sha, entries: [...ASSETS].sort() };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
function run(command, args) { return new Promise((resolvePromise, reject) => { const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); let error = ""; child.stderr.on("data", chunk => { error += chunk.toString(); }); child.once("error", reject); child.once("exit", code => code === 0 ? resolvePromise() : reject(new Error(`archive command failed (${code}): ${error.trim()}`))); }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import("./build.mjs");
  const result = await packagePlugin();
  console.log(`Created ${result.zip}\n${result.sha256}`);
}
