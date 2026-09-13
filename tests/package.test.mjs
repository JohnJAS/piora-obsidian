import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagePlugin } from "../scripts/package.mjs";

it("packages exactly the three runtime assets and writes a hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-package-"));
  const dist = join(root, "dist"); const out = join(root, "out");
  await mkdir(dist); await writeFile(join(dist, "manifest.json"), JSON.stringify({ id: "piora-obsidian", version: "1.2.3" }));
  await writeFile(join(dist, "main.js"), "runtime"); await writeFile(join(dist, "styles.css"), "style"); await writeFile(join(dist, "extra.txt"), "no");
  const result = await packagePlugin(dist, out);
  expect(result.zip).toMatch(/piora-obsidian-v1\.2\.3\.zip$/);
  expect(await readFile(result.sha256, "utf8")).toMatch(/^[a-f0-9]{64}  /);
  expect(result.entries).toEqual(["main.js", "manifest.json", "styles.css"]);
});
