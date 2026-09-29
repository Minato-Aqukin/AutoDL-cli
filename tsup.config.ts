import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, sep } from "node:path";
import { defineConfig } from "tsup";

const NODE_BUILTINS = new Set(builtinModules);

/**
 * Copyright lines for bundled packages whose npm tarball ships no license file. Only
 * MIT packages may appear here: their text is the MIT template plus this line, taken
 * from the upstream repository (yoga-layout: github.com/facebook/yoga/blob/main/LICENSE).
 */
const MIT_COPYRIGHT_WITHOUT_LICENSE_FILE: Record<string, string> = {
  "yoga-layout": "Copyright (c) Facebook, Inc. and its affiliates.",
};

const MIT_TEMPLATE = `MIT License

{copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** License text of one bundled package, from its own files or the table above. */
function licenseText(root: string, name: string, license: string): string {
  const file = readdirSync(root)
    .sort()
    .find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
  if (file) return readFileSync(join(root, file), "utf8").trim();
  const copyright = MIT_COPYRIGHT_WITHOUT_LICENSE_FILE[name];
  if (copyright && license === "MIT") return MIT_TEMPLATE.replace("{copyright}", copyright).trim();
  throw new Error(
    `${name} is bundled into dist/ but ships no license file; add its copyright line to MIT_COPYRIGHT_WITHOUT_LICENSE_FILE after checking the upstream license`,
  );
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  // Ink and React are devDependencies: tsup bundles everything that is not a runtime
  // dependency, so users install one package instead of Ink's ~50-package tree.
  external: ["react-devtools-core"],
  // React, react-reconciler and scheduler pick their build from NODE_ENV at load time.
  // Users never set it, so without this every run would take the development build:
  // ~1MB of extra bundle and a slower renderer full of dev-only checks.
  define: { "process.env.NODE_ENV": '"production"' },
  esbuildPlugins: [
    {
      // Ink reaches for React DevTools only when DEV=true *and* the optional peer
      // resolves — unreachable in a published build, yet esbuild follows the dynamic
      // import and emits a ~128KB chunk (plus `ws`) that can never run. Stub it out.
      name: "stub-ink-devtools",
      setup(build) {
        build.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) =>
          args.importer.includes(`${sep}ink${sep}build${sep}`)
            ? { path: "ink-devtools", namespace: "stub" }
            : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export {};",
          loader: "js",
        }));
      },
    },
    {
      // Bundled CJS deps (signal-exit, stack-utils) call require("assert") and friends.
      // In an ESM bundle esbuild turns those into a shim that throws unless a real
      // `require` is in scope. Serve each builtin through an ESM re-export instead, so
      // no chunk needs a createRequire banner.
      name: "cjs-builtins-as-esm",
      setup(build) {
        build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
          if (args.kind !== "require-call") return undefined;
          const name = args.path.replace(/^node:/, "");
          return NODE_BUILTINS.has(name) ? { path: name, namespace: "cjs-builtin" } : undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "cjs-builtin" }, (args) => ({
          contents: `export * from "node:${args.path}"; export { default } from "node:${args.path}";`,
          loader: "js",
        }));
      },
    },
    {
      // Ink, React and their dependencies are bundled into dist/, so their license
      // notices have to ship with it: MIT/ISC require the notice in every copy. The
      // list comes from what actually landed in the output, so it tracks dependency
      // changes by itself, and a bundled package without a license file fails the build.
      name: "third-party-licenses",
      setup(build) {
        build.initialOptions.metafile = true;
        build.onEnd((result) => {
          if (!result.metafile || result.errors.length > 0) return;
          const roots = new Set<string>();
          for (const output of Object.values(result.metafile.outputs)) {
            for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
              const root = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
              if (root && bytesInOutput > 0) roots.add(root);
            }
          }
          const notices = new Map<string, string>();
          for (const root of roots) {
            const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
              name: string;
              version: string;
              license?: string;
            };
            const id = `${pkg.name}@${pkg.version}`;
            if (notices.has(id)) continue;
            const license = pkg.license ?? "UNKNOWN";
            notices.set(id, `${id} (${license})\n\n${licenseText(root, pkg.name, license)}`);
          }
          const outdir = build.initialOptions.outdir ?? "dist";
          mkdirSync(outdir, { recursive: true });
          const sections = [
            "The files in this directory bundle the following third-party packages.\n" +
              `Their license notices are reproduced below.\n\n${[...notices.keys()].sort().join("\n")}`,
            ...[...notices.keys()].sort().map((id) => notices.get(id) as string),
          ];
          writeFileSync(
            join(outdir, "THIRD_PARTY_LICENSES.txt"),
            `${sections.join(`\n\n${"=".repeat(78)}\n\n`)}\n`,
          );
        });
      },
    },
  ],
  // Lets the TUI land in its own chunk so `mcp`/`ls`/`exec` never parse it.
  splitting: true,
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  shims: false,
});
