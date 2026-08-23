import { sep } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  // Ink and React are bundled rather than declared as installable deps, so users
  // still get a single package instead of a ~27-module React tree.
  noExternal: ["ink", "react", "react-reconciler", "yoga-layout", "scheduler"],
  external: ["react-devtools-core"],
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
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Some transitive CJS deps (signal-exit) call require("assert") at load time.
      // In an ESM bundle esbuild rewrites that to a shim that throws unless a real
      // `require` is in scope, so supply one. Must come before esbuild's helpers,
      // which is why it lives in the banner rather than in source.
      'import { createRequire as __nodeCreateRequire } from "node:module";',
      "const require = __nodeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
