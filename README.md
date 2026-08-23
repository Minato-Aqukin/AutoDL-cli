# autodl-cli

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by AutoDL.
> "AutoDL" is used only to identify the platform this tool talks to.

Manage [AutoDL](https://www.autodl.com/) GPU instances from the command line — and let
your coding agent do it too.

Built on AutoDL's **official open API**, so the developer token stays valid indefinitely
and nothing breaks when the web console is redesigned.

[简体中文](./README.zh-CN.md)

---

## Why

When an AI agent needs a GPU box mid-task, it has no way to get one: AutoDL's instances
are created by clicking through a web console. This gives the agent three ways in, all
backed by the same core:

| Entry point | For | How |
|---|---|---|
| **CLI** | humans | `autodl create --gpu 4090 --ttl 2h` |
| **MCP server** | Claude Code, Cursor, Cline, … | `autodl mcp` over stdio |
| **SDK** | Node programs | `import { createInstance } from "@minatoaqukin/autodl-cli"` |

Every command speaks `--json` with a stable schema and a documented exit code, so an
agent can branch on the result without parsing prose.

## Install

```bash
npm install -g @minatoaqukin/autodl-cli   # then: autodl <command>
npx @minatoaqukin/autodl-cli <command>    # or without installing
```

Requires Node.js 20+.

## Setup

The official API needs a developer token from an **identity-verified** account
(个人或企业实名认证). Get it from the AutoDL console → 设置 → 开发者 Token.

```bash
autodl login              # verifies the token, then saves it with 0600 permissions
autodl account            # balance, vouchers, lifetime spend
```

Token precedence: `--token` › `AUTODL_TOKEN` › `~/.config/autodl-cli/config.json`.

## Quick start

```bash
# Rent a GPU that shuts itself off after two hours, and wait until it's ready
autodl create --gpu 4090 --ttl 2h --wait

# Work with it
autodl ls
autodl ssh pro-76419909953e                    # interactive login
autodl exec pro-76419909953e "nvidia-smi"      # one-off command, remote exit code
autodl push pro-76419909953e ./src /root/work  # SFTP upload
autodl pull pro-76419909953e /root/work/out .  # SFTP download

# Stop paying
autodl stop pro-76419909953e
autodl rm pro-76419909953e --yes               # irreversible: wipes all data
```

Or do the whole thing in one verb:

```bash
autodl run "python train.py" \
  --gpu 4090 --sync ./ --pull /root/autodl-cli/checkpoints --ttl 4h
```

That creates an instance, waits for it, uploads your code, streams the command's output,
downloads the results, and powers the instance off — including on Ctrl-C.

## Use it from an agent

### Claude Code

```bash
claude mcp add autodl -- npx -y @minatoaqukin/autodl-cli mcp
```

### Cursor / Cline / any MCP client

```json
{
  "mcpServers": {
    "autodl": {
      "command": "npx",
      "args": ["-y", "@minatoaqukin/autodl-cli", "mcp"],
      "env": { "AUTODL_TOKEN": "your-token" }
    }
  }
}
```

Tools exposed: `autodl_account_info`, `autodl_list_instances`, `autodl_get_instance`,
`autodl_create_instance`, `autodl_power_on`, `autodl_power_off`,
`autodl_release_instance`, `autodl_exec`, `autodl_upload`, `autodl_download`,
`autodl_run`, `autodl_list_gpu_specs`, `autodl_list_images`, `autodl_save_image`,
`autodl_sweep_expired`. Plus an `autodl://instances` resource.

MCP defaults are deliberately stricter than the CLI's, because nobody is watching:
a 2-hour TTL is applied unless you ask for longer, releasing requires an explicit
`confirm: true`, and passwords come back redacted unless requested.

### Shell / CI

```bash
autodl ls --json | jq -r '.data[] | select(.status=="running") | .uuid'
```

## The cost guard

**AutoDL bills purely on power state.** An instance that finished training an hour ago
costs exactly as much as one at 100% utilisation. This is the single easiest way for an
unattended agent to waste real money, so the protection is built in rather than optional.

Three layers:

1. **Inside the instance.** `--ttl 2h` arms a detached `sleep && shutdown` on the box
   itself via `start_command`. It fires even if this CLI is killed, your laptop sleeps,
   or the network dies. This is the layer that actually protects your wallet.
2. **A local ledger.** Every command opportunistically sweeps instances past their TTL
   and powers them off. Catches the cases layer 1 can't — a `start_command` that
   silently failed, or a manual power-on with no fresh timer.
3. **Idle detection.** `autodl guard idle <id>` samples GPU utilisation over SSH and
   shuts down after a sustained lull.

```bash
autodl guard ttl pro-xxx 2h     # arm/re-arm on a running instance
autodl guard cancel pro-xxx     # disarm
autodl guard list               # what this machine is tracking
autodl guard sweep              # reclaim everything past its TTL now
autodl guard idle pro-xxx --threshold 5 --samples 6 --interval 1m
```

A **balance gate** also refuses to create an instance when your wallet is below
`--min-balance` (default ¥5). AutoDL doesn't reclaim instances the moment the balance
hits zero — it keeps them to protect your data — so a low balance turns into a stuck,
unusable instance rather than a clean failure.

## The agent contract

Stable across minor versions. Breaking changes require a major.

**stdout in `--json` mode is pure JSON.** Progress, prompts and warnings all go to
stderr, so `autodl ... --json | jq` is always safe.

```jsonc
// success
{ "ok": true, "data": { /* ... */ } }

// failure
{ "ok": false, "error": { "code": "NO_STOCK", "message": "…", "hint": "…", "requestId": "…" } }
```

| Exit | Meaning | Error codes |
|---:|---|---|
| 0 | Success | — |
| 1 | Generic failure | `GENERIC`, `API_ERROR`, `NETWORK` |
| 2 | Bad arguments | `USAGE` |
| 3 | Token missing or invalid | `AUTH_MISSING`, `AUTH_INVALID` |
| 4 | Resource not found | `NOT_FOUND` |
| 5 | Out of budget / blocked by a guard | `INSUFFICIENT_BALANCE`, `GUARD_BLOCKED` |
| 6 | No GPU stock | `NO_STOCK` |
| 7 | Timed out | `TIMEOUT` |
| 8 | SSH failure | `SSH_FAILED` |

`autodl exec` and `autodl run` instead exit with the **remote** command's exit code, so
`autodl exec box "make test" && deploy` behaves the way you'd expect.

## Commands

| Command | What it does |
|---|---|
| `login` / `logout` / `whoami` | Token management |
| `account` | Balance, vouchers, lifetime spend |
| `ls [--status]` | List instances |
| `info <id> [--show-password]` | Details, live SSH info, resource usage |
| `create --gpu <spec>` | Create a pay-as-you-go Pro instance |
| `start` / `stop` / `rm <id>` | Power on / off / release |
| `ssh <id>` | Interactive login (extra flags pass through to `ssh`) |
| `exec <id> <cmd…>` | Run a command, stream output, propagate exit code |
| `push` / `pull <id>` | SFTP transfer, recursive, respects ignore files |
| `run <cmd…>` | Create → sync → run → fetch → power off |
| `guard ttl\|cancel\|idle\|list\|sweep` | Cost guards |
| `image save <id> <name>` / `images` | Private image management |
| `gpus` / `regions` | Catalogue lookup |
| `mcp` | Run as an MCP server |

Global flags: `--json`, `--yes`, `--token`, `--base-url`, `--lang zh|en`, `--verbose`,
`--no-color`, `--no-sweep`.

`push` and `pull` skip `.git`, `node_modules`, `__pycache__`, `.venv` and friends, then
apply `.autodlignore` if present, falling back to `.gitignore`.

## SDK

```ts
import {
  AutoDLClient,
  createInstance,
  execCommand,
  powerOffInstance,
  waitForRunning,
} from "@minatoaqukin/autodl-cli";

const client = new AutoDLClient({ token: process.env.AUTODL_TOKEN! });

const uuid = await createInstance(client, {
  gpuSpec: "v-48g",
  gpuNum: 1,
  imageUuid: "base-image-l2t43iu6uk",
  cudaFrom: 118,
});

await waitForRunning(client, uuid);
const { stdout } = await execCommand(client, uuid, "nvidia-smi");
console.log(stdout);
await powerOffInstance(client, uuid);
```

Everything re-exported from the package root is public API. Prices arrive as yuan
(`number`), timestamps as ISO strings, and Go's `sql.NullTime` shape is flattened to
`string | null`.

## What the official API cannot do

These are AutoDL's limits, not this tool's. Knowing them up front saves a lot of
confusion:

- **Pay-as-you-go only.** No daily/weekly/monthly plans and no renewal endpoint.
- **Pro instances only.** The seven specs in `autodl gpus` — the cheaper standard
  instances aren't reachable through the open API.
- **No stock query.** Creation is a blind attempt; when there's no capacity you get
  exit code 6 and have to try another spec or region.
- **No CPU-only boot.** `power_on` accepts `payload: "gpu"` only, so the ¥0.1/hr
  no-GPU mode isn't available.
- **Identity verification required** before the API will respond at all.
- **Missing operations:** rename, scheduled shutdown, resizing, migration, system reset.
- **SSH credentials rotate on every power cycle** — port *and* root password. This tool
  re-reads them on every connection and retries once with a forced refresh, so you never
  have to think about it. Don't cache them yourself.

Also worth knowing: **an instance left shut down for 15 consecutive days is released and
its data wiped.**

The GPU spec, region and base-image tables are baked in because the API exposes no
catalogue endpoint. If AutoDL changes them, please
[open an issue](https://github.com/Minato-Aqukin/AutoDL-cli/issues).

## Development

```bash
npm install
npm run build
npm test            # 146 tests, no network access, no cost
npm run lint
npm run typecheck
```

Real end-to-end tests rent an actual GPU and cost actual money, so they're opt-in:

```bash
AUTODL_E2E=1 AUTODL_TOKEN=<token> npm run test:e2e
```

They always power the instance down in an `afterAll`, even on failure. Add
`AUTODL_E2E_RELEASE=1` to release it too.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Especially valuable:
corrections to the static catalogue, and real API error codes we haven't mapped yet
(AutoDL doesn't document them).

## License

[MIT](./LICENSE)
