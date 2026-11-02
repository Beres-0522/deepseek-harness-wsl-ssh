import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const result = await build({
  entryPoints: ["main.mjs"],
  outfile: "server.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ssh2 optional native accelerators; ssh2 falls back to pure JS when absent.
  plugins: [
    {
      name: "native-external",
      setup(b) {
        b.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  define: {
    __dirname: "import.meta.dirname",
    __filename: "import.meta.filename",
  },
  legalComments: "inline",
  metafile: true,
});

const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const marker = input.lastIndexOf("node_modules/");
  if (marker < 0) continue;
  const parts = input.slice(marker + 13).split("/");
  const name = parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/");
  packages.add(resolve(input.slice(0, marker), "node_modules", name));
}
const notices = [];
for (const directory of [...packages].sort()) {
  const { name, version } = JSON.parse(
    await readFile(resolve(directory, "package.json"), "utf8"),
  );
  const licenses = (await readdir(directory)).filter((n) =>
    /^(licen[sc]e|notice)(\..*)?$/i.test(n),
  );
  if (!licenses.length) throw new Error(`Missing license for ${name}`);
  notices.push(`${name}@${version}`);
  for (const license of licenses.sort()) {
    notices.push(await readFile(resolve(directory, license), "utf8"));
  }
}
await writeFile("THIRD-PARTY-NOTICES.txt", notices.join("\n\n"));
console.log(`Built deepseek-harness MCP server with ${packages.size} bundled packages`);
