import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const version = process.argv[2] ?? process.env.GITHUB_REF_NAME?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected SemVer X.Y.Z");
if (manifest.version !== version) throw new Error(`manifest version ${manifest.version} does not match ${version}`);
console.log(`Version ${version} verified`);
