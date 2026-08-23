import { createRequire } from "node:module";

/**
 * Read the version from package.json rather than hardcoding it.
 *
 * changesets rewrites package.json on every release, so any literal here would go
 * stale silently — `autodl --version` would keep reporting the previous release.
 *
 * The relative path resolves correctly from both `src/` (tests) and `dist/` (the built
 * and published CLI), since both sit one level below the package root.
 */
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
