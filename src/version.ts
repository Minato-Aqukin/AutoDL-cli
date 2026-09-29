/**
 * Read the version from package.json rather than hardcoding it.
 *
 * changesets rewrites package.json on every release, so any literal here would go
 * stale silently — `autodl --version` would keep reporting the previous release.
 *
 * The bundler inlines just this field at build time (prepublishOnly builds after the
 * version bump), so the published code needs no runtime `require` of package.json.
 */
import { version } from "../package.json";

export const VERSION: string = version;
