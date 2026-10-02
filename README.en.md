# autodl-cli

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by AutoDL.
> "AutoDL" is used only to identify the platform this tool talks to.

Manage [AutoDL](https://www.autodl.com/) GPU instances from the command line — and let
your coding agent do it too.

Built on AutoDL's **official open API**, so the developer token stays valid indefinitely
and nothing breaks when the web console is redesigned.

[简体中文](./README.md)

---

## Why

When an AI agent needs a GPU box mid-task, it has no way to get one: AutoDL's instances
are created by clicking through a web console. This gives the agent three ways in, all
backed by the same core:

| Entry point | For | How |
|---|---|---|
| **CLI** | humans | `autodl create --gpu 4090 --ttl 2h` |
| **MCP server** | Claude Code, Cursor, Cline, … | `autodl mcp` over stdio |
| **SDK** | Node programs | `import { createInstance } from "@minato-aqukin/autodl-cli"` |

Every command speaks `--json` with a stable schema and a documented exit code, so an
agent can branch on the result without parsing prose.

## Install

```bash
npm install -g @minato-aqukin/autodl-cli   # then: autodl <command>
npx @minato-aqukin/autodl-cli <command>    # or without installing
```

Requires Node.js 22+.

## The dashboard

```bash
autodl tui     # or just `autodl` in an interactive terminal
```

On a machine with no token yet it opens on a login screen offering two things —
configure a token, or quit. Paste the token, it is verified against the API before
being saved, and you land on the dashboard. Once configured, `autodl` goes straight in.

A live table of your instances: status, GPU, region, **how long each has been powered on
and roughly what that has cost**, and how much TTL is left. Keys: `↑↓` move, `Enter`
detail, `s` start, `x` stop, `ctrl+d` release, `g` stock, `i` private images,
`r` refresh, `ctrl+l` log out, `?` help, `q` quit. Release and logout require confirmation.
The detail screen (`Enter`) owns the per-instance keys: `h` automatically authenticated
SSH, `f` files, `t` transfers, `c` copy the SSH command, `n` new instance, `i` save as a
private image.

The `i` image list is re-read on every visit; the status column shows a save in progress.
Deleting, renaming and sharing images are not in the open API, so they stay in the AutoDL
web console. The create wizard's image step lists finished private images ahead of the
public ones; the list carries no CUDA version, so they are scheduled with CUDA ≥ 11.8, the
same as `autodl create --image <private>`. Its TTL step offers 不限时 (no limit): no
shutdown timer, the same as `autodl create` without `--ttl` — the instance bills until you
stop it.

`ctrl+d` release wipes the instance permanently, which is why it is not a bare `d`.

`ctrl+l` clears the saved token and returns to the login screen, after a confirmation — and
it says so when `AUTODL_TOKEN` or `--token` will outrank whatever you save next. If the
API rejects the token while the dashboard is open — expired, reset, verification lapsed —
polling stops and the same login screen is one keystroke away, rather than leaving a
frozen table above an endless stream of 401s.
Re-login keeps the same token precedence: `--token` › `AUTODL_TOKEN` › saved token.
Saving a different token does not switch accounts while an override is active. If that
override is invalid, remove or update it and restart the TUI; it will not silently fall
back to the saved account. Authentication failures from GPU stock queries also end the session.

It fills the terminal and shows your account id and balance in the header. Copying with
`c` puts only the SSH command on the clipboard — never the root password, which any
process could then read. Where no clipboard helper exists (SSH sessions, containers) it
falls back to OSC 52 and says so, since the terminal never confirms.

It runs on the terminal's alternate screen, so it owns a fixed canvas instead of
scrolling below whatever was already there, and quitting restores your prompt and
scrollback untouched.

It exists because AutoDL bills on power state: the expensive mistake is not a wrong
command, it's an instance nobody remembered to stop. Leaving this open makes that visible.

Two deliberate honesty constraints. A rate is only knowable from a **running** instance's
snapshot, so a stopped instance shows elapsed time and no money — inventing a number
would be worse than showing none. And while a rate is still loading the total says so
rather than quietly under-reporting.
Account runway stays pending until every running instance's rate is known; an unknown
rate is never treated as free compute. On short terminals, including 80×24, the resource
and billing panels are hidden when their stacked layout would obscure the instance list
or keyboard hints.

The TUI never runs in a pipe, in CI, or under `--json`: it exits with code 2 and an
explanation instead of taking over a terminal that isn't there. A bare `autodl` outside
an interactive terminal still prints help exactly as before.

### SSH and file management

Open the detail screen (`Enter`) and press `h`: it hands the entire terminal to a
password-authenticated SSH session and restores the dashboard on exit or disconnect;
this is not an embedded terminal. Credentials are
fetched live and never placed in command arguments, logs, or transfer records.
The CLI equivalent is `autodl ssh <id> --auto-auth`. This mode uses ssh2, not OpenSSH
configuration. Keep using ordinary `autodl ssh <id>` for `~/.ssh/config`, agents and
forwarding such as `-L`. The implementation uses cross-platform Node.js terminal and
filesystem interfaces for Linux, macOS and native Windows; sshpass is not required.

On the detail screen, `f` opens local/remote panes; narrow terminals show the active pane. `Tab` switches
sides, arrows and Enter navigate, PgUp/PgDn page, Home/End jump to either end, Space
selects multiple entries, and `a` selects all.
`g` accepts a directory path; `p` accepts source/destination paths directly.
`u` transfers the selection to the opposite pane after confirming direction.
`m` creates directories, `r` renames or moves within one side, and `x` permanently
deletes after confirmation. `Q` opens the queue; Esc returns.

The selected entry stays mid-window with its neighbours in view, leaving the middle only
at either end of the list. A refresh — after creating, renaming or deleting, or the
automatic one when a transfer finishes — keeps the cursor on the same entry; going up
lands on the directory you just left.

Relative paths resolve against their corresponding pane. Selected source basenames
are preserved: copying `project` into `/root/work` produces `/root/work/project`.
The browser transfers explicitly selected directory contents, without the legacy
`push` command's ignore rules. Symlinks and special files are skipped; queue details
offer `v` to browse every skipped entry.

Ordinary conflicts pause for `o` overwrite, `s` skip, or `b` keep both; `a` applies the
choice to remaining conflicts in this task. Toggle `s` in the browser to synchronize
one way: skip unchanged files, replace changed files in full, and **never delete
destination-only files**. Size/mtime comparison is the default; `c` enables SHA-256
comparison. Checksumming reads both files; remote contents are streamed over SFTP,
so strict checking can cost as much bandwidth as downloading the files.

The session queue is serial, with byte progress, speed, cancellation (`c`), details
(Enter), and manual resume (`r`). Recoverable transport failures have bounded retries;
authentication failures and powered-off instances pause instead. Starting a stopped
instance to open SSH/files or resume a task always requires a billing confirmation.
Automatic reconnect never powers an instance on.
The file view holds one browsing connection for list/mkdir/rename/remove; directory
contents are always read live, a dead connection reconnects on the next operation,
and leaving the view releases it.
The CLI `files` and `queue` commands share the same queue records: a task added via
`queue add` can be confirmed and resumed from the dashboard, and vice versa.
`queue resume`, `queue resolve` and `queue add --wait` run the task in the foreground and
exit non-zero unless it completes.

Transfers write same-directory `.autodl-*.part` files and commit only after completion,
preserving existing destinations on interruption. Resume validates the source version
and partial prefix, restarting changed/corrupt files. Remote replacement requires the
OpenSSH atomic-rename extension; unsupported servers fail without deleting the old file.
Credential-free records live under the config directory's `transfers/`, scoped by
account and API endpoint. Exit/logout pauses unfinished work. Restored tasks require
manual resume: **nothing runs in the background after exit**. Only one process may
mutate an account's queue; dead-process ownership claims are recoverable.
Cancelled tasks retain partial data; remove their `.part` files and local checkpoints
only when you no longer need to resume them.


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
claude mcp add autodl -- npx -y @minato-aqukin/autodl-cli mcp
```

### Cursor / Cline / any MCP client

```json
{
  "mcpServers": {
    "autodl": {
      "command": "npx",
      "args": ["-y", "@minato-aqukin/autodl-cli", "mcp"],
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

## Deploying a git project

```bash
# Rent a box, clone, auto-install dependencies, run it, then stop the instance
autodl deploy owner/repo --gpu 4090 --start "python train.py" --ttl 4h

# Long-running service: background it and keep the instance up
autodl deploy owner/repo --gpu 4090 --start "python app.py" --detach

# Come back later — powers the same box on and `git pull`s, no rebuild
autodl deploy owner/repo --instance pro-76419909953e --start "python train.py"
```

`deploy` differs from `run` in one deliberate way: it **stops** the instance at the end
instead of releasing it. A stopped instance keeps its disks, so the next deploy reuses
the environment you already built. `--on-finish release` opts out.

Code lands in `/root/autodl-tmp/<repo>` — the data disk. AutoDL's system disk is a fixed
30GB that also gets packed into any saved image; the data disk is separate, faster and
expandable. The trade-off worth knowing: **data-disk contents are not included when you
save an image**, so put the environment on the system disk and the code here.

Dependencies are auto-detected in this order, first hit wins — `environment.yml` →
`requirements.txt` → `pyproject.toml` → `package-lock.json`/`package.json`. Override with
`--setup "<cmd>"`, or skip with `--no-setup`.

Remote commands run through a **login shell**. AutoDL images keep `python`, `pip` and
`conda` in `/root/miniconda3/bin`, which only reaches `PATH` via the login profile — a
plain non-interactive `ssh host "pip install ..."` exits 127. This applies to
`autodl exec` too, so it behaves the way it does when you `autodl ssh` in by hand.

Cloning from GitHub or HuggingFace automatically enables AutoDL's academic proxy
(`source /etc/network_turbo`). Gitee is domestic and skips it. `--no-accel` disables it.
AutoDL notes the proxy is "for academic use, with no stability guarantee".

Private repos: `--git-token`, or a token in the environment — `GIT_TOKEN` for any host,
`GITHUB_TOKEN` only for github.com, `GITEE_TOKEN` only for gitee.com, so a GitHub token
is never sent to another host. The token never reaches a log line, an error message,
`--json` output, or the checkout's stored git remote.

## Checking GPU stock

```bash
autodl stock --gpu 4090        # where are the free cards
autodl stock                   # everything, everywhere
```

**Read this table carefully — the numbers are less authoritative than they look.** They
come from AutoDL's elastic-deployment stock endpoint, the only capacity API that exists,
and it does not track Pro instance availability. Measured on 2026-08-23: it reported 140
idle RTX 4090D in `westDC3` while creating a Pro instance there answered *"暂无库存"* —
and the identical request with no region constraint succeeded, landing in `beijingDC2`.

Two consequences, both baked into the tool:

- **Creating an instance never narrows regions on its own.** Omitting `data_center_list`
  gives AutoDL the widest choice, which empirically succeeds most often.
- **Only two regions accept a Pro instance at all**: `westDC3` (西北B区) and `beijingDC2`
  (北京B区). The other nine in the stock table are elastic-deployment only; passing one
  to `--region` is rejected up front rather than failing later with AutoDL's opaque
  "请求参数错误". The `可建Pro` column marks which is which.

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
autodl guard cancel pro-xxx     # disarm (clears the ledger; exit 1 if the in-instance timer can't be confirmed gone)
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
Unknown commands, unknown options and missing arguments use exit code 2 with a `USAGE`
error, including a JSON error object when `--json` is enabled. `tui --json` follows the
same error contract; explicit help and version requests still print their normal text.

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
`autodl exec box "make test" && deploy` behaves the way you'd expect. The one exception:
if `run`/`deploy` could not power off or release the instance afterwards, they exit 1 and
report it in `data.cleanup.error`, because that instance may still be billing.

## Commands

| Command | What it does |
|---|---|
| `login` / `logout` / `whoami` | Token management |
| `account` | Balance, vouchers, lifetime spend |
| `ls [--status]` | List instances |
| `info <id> [--show-password]` | Details, live SSH info, resource usage |
| `create --gpu <spec>` | Create a pay-as-you-go Pro instance |
| `start` / `stop` / `rm <id>` | Power on / off / release |
| `ssh <id> [--auto-auth]` | System OpenSSH with extra flags, or automatic instance-password authentication |
| `exec <id> <cmd…>` | Run a command, stream output, propagate exit code |
| `files ls/mkdir/mv/rm <id>` | Browse and manage instance files (SFTP, reused connection) |
| `queue add/ls/resume/cancel/resolve` | Serial transfer queue, shared with the dashboard |
| `run <cmd…>` | Create → sync → run → fetch → power off |
| `deploy <repo>` | Create → clone → install deps → start → **stop, keeping data** |
| `stock [--gpu] [--region]` | Live GPU stock per region |
| `guard ttl\|cancel\|idle\|list\|sweep` | Cost guards |
| `image save <id> <name>` / `images` | Private image management |
| `gpus` / `regions` | Catalogue lookup |
| `tui` | Interactive dashboard (also entered by a bare `autodl`) |
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
} from "@minato-aqukin/autodl-cli";

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
- **No usable stock query for Pro.** The one capacity endpoint reports elastic-deployment
  stock, which demonstrably does not match Pro availability (see above). Creation is
  effectively a blind attempt; no capacity means exit code 6 and another spec to try.
- **Only two regions accept a Pro instance**: `westDC3` and `beijingDC2`.
- **No CPU-only boot _yet_.** AutoDL's own wording is deliberately provisional:
  `payload` is documented as `"gpu：有卡开机, 暂不支持API以无卡模式开机"` — *not yet*
  supported, rather than never. Confirmed on a live instance 2026-08-24: `cpu`,
  `no_gpu`, `nogpu`, `cpu_only`, `cpu-only` and `none` all return
  `ServerError | 不支持的启动模式`, and an empty `payload` is accepted but boots with the
  GPU attached (`start_mode: "gpu"`). Use the web console for the ¥0.1/hr 无卡模式 in the
  meantime; this tool will expose it once the API does.
- **Identity verification required** before the API will respond at all.
- **Missing operations:** rename, scheduled shutdown, resizing, migration, system reset.
- **SSH credentials can change on any power cycle** — port *and* root password. AutoDL
  may reschedule the instance onto a different machine. It doesn't always happen (a real
  stop/start was observed keeping both identical), which is precisely what makes caching
  dangerous: a stale value works often enough to hide the bug until it doesn't. This tool
  re-reads them on every connection, so you never have to think about it.
- **`running` does not mean sshd is ready.** A freshly created instance reports `running`
  before it accepts connections. Connection attempts here are spaced out rather than
  fired back to back.
- **A non-interactive SSH session has almost no PATH.** No python, pip or conda — they
  live in `/root/miniconda3/bin` and arrive only through the login profile. Every remote
  command here runs under `bash -lc` for that reason.
- **Releasing requires a completed shutdown**, and a second `power_off` on an instance
  that is already stopping is an error. Both are handled internally.

Also worth knowing: **an instance left shut down for 15 consecutive days is released and
its data wiped.**

Verified against the live API on 2026-08-23: full lifecycle (create → SSH exec → SFTP
round trip → stop → start → exec again → release) on a 4090D, total cost ¥0.10.

The GPU spec, region and base-image tables are baked in because the API exposes no
catalogue endpoint. If AutoDL changes them, please
[open an issue](https://github.com/Minato-Aqukin/AutoDL-cli/issues).

## Development

```bash
npm install
npm run build
npm test            # 325 tests, no network access, no cost
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

The published package bundles Ink, React and their dependencies into `dist/`; their
license notices ship in `dist/THIRD_PARTY_LICENSES.txt`.
