import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ test: { include: ["tests/**/*.test.{ts,mjs}"], exclude: [".local/**", "node_modules/**"] }, resolve: { alias: { obsidian: fileURLToPath(new URL("./tests/obsidian-stub.ts", import.meta.url)) } } });
