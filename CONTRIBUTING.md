# Contributing / 贡献指南

Thanks for helping out. Issues and PRs are both welcome, in English or Chinese.

## Getting started

```bash
npm install
npm run build
npm test          # 117 tests, offline, free
npm run lint      # biome
npm run typecheck # tsc --noEmit
```

## Especially useful contributions

**Corrections to the static catalogue.** AutoDL's open API exposes no endpoint for GPU
specs, regions or public base images, so `src/core/catalog.ts` hardcodes them from the
official docs. When the platform changes, this file goes stale. If `autodl gpus` shows
something wrong, please open an issue with what you see in the console.

**Real API error codes.** AutoDL returns HTTP 200 with a non-`Success` `code` for logical
failures, and does not document the possible values. `mapEnvelopeError` in
`src/core/client.ts` currently matches on message text as a best effort. If you hit an
error that lands on the generic `API_ERROR` path when it should be something more
specific, paste the raw `code` and `msg` into an issue — with the `request_id` if you
have it.

## Architecture in one paragraph

`src/commands/` (CLI) and `src/mcp/` (MCP tools) are both thin shells that do nothing but
parse arguments and format output. All behaviour lives in `src/core/`, `src/ssh/`,
`src/guard/` and `src/workflow/`. Keep it that way — the three entry points must never
drift in what they can do.

## Things to be careful about

- **Never cache SSH credentials.** AutoDL rotates the port and root password on every
  power cycle. Everything must go through `getCredentials` / `withSSH` in
  `src/ssh/credentials.ts`.
- **Never retry a create or release.** They aren't idempotent; a retry can rent a second
  GPU or race a release. Pass `maxRetries: 0`.
- **Keep `start_command` payloads quote-free.** That string is re-parsed somewhere on
  AutoDL's side and we can't see how. See `buildTTLSnippet` for the subshell trick.
- **stdout is a contract.** In `--json` mode it must contain exactly one JSON object.
  All human-facing output goes to stderr via `note` / `success` / `warn`.
- **Don't break the exit codes.** They're documented in the README and agents branch on
  them. Changing one is a breaking change.

## Tests

Add unit tests for pure logic, and integration tests with the `mockFetch` helper for
anything that talks to the API. Response fixtures in `tests/fixtures/responses.ts` are
copied verbatim from AutoDL's official docs — please keep them that way, so the parsers
are tested against real shapes rather than invented ones.

The real end-to-end suite (`tests/e2e/`) rents an actual GPU and costs actual money.
It's opt-in and never runs in CI:

```bash
AUTODL_E2E=1 AUTODL_TOKEN=<token> npm run test:e2e
```

## Releasing

This repo uses [changesets](https://github.com/changesets/changesets):

```bash
npx changeset          # describe your change, pick a bump
```

Merging to `main` with a changeset present opens a release PR; merging that publishes.

## Code of conduct

Be decent to each other. Harassment or personal attacks aren't welcome here.
