import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [header, core, tabBroker, userscript] = await Promise.all([
  readFile(resolve(root, "userscript.header.txt"), "utf8"),
  readFile(resolve(root, "src/core.cjs"), "utf8"),
  readFile(resolve(root, "src/tab-broker.cjs"), "utf8"),
  readFile(resolve(root, "src/userscript.js"), "utf8"),
]);

await mkdir(resolve(root, "dist"), { recursive: true });
const bundled = `${header.trim()}\n\n${core.trim()}\n\n${tabBroker.trim()}\n\n${userscript.trim()}\n`;
const metadata = `${header.trim()}\n`;

await Promise.all([
  writeFile(resolve(root, "warbuddy.user.js"), bundled, "utf8"),
  writeFile(resolve(root, "warbuddy.meta.js"), metadata, "utf8"),
  writeFile(resolve(root, "askelads-warbuddy.user.js"), bundled, "utf8"),
  writeFile(resolve(root, "askelads-warbuddy.meta.js"), metadata, "utf8"),
  writeFile(resolve(root, "dist/warbuddy.user.js"), bundled, "utf8"),
  writeFile(resolve(root, "dist/warbuddy.meta.js"), metadata, "utf8"),
  writeFile(resolve(root, "dist/askelads-warbuddy.user.js"), bundled, "utf8"),
  writeFile(resolve(root, "dist/askelads-warbuddy.meta.js"), metadata, "utf8"),
]);
