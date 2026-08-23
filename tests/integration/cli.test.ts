import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  balanceResponse,
  createResponse,
  emptySuccess,
  instanceListResponse,
} from "../fixtures/responses.js";

/**
 * End-to-end checks of the two things agents actually depend on: the shape of
 * `--json` stdout and the exit code. Both are public contract, so they are asserted
 * against the real built binary rather than an in-process call.
 */

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

let server: Server;
let baseUrl: string;
let configDir: string;
/** Lets a test make the next call to a given path fail. */
const overrides = new Map<string, { status?: number; body: unknown }>();

function respond(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error("dist/cli.js 不存在，请先运行 `npm run build`（npm test 会自动构建）");
  }
  configDir = await mkdtemp(join(tmpdir(), "autodl-cli-test-"));

  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] as string;
    const override = overrides.get(path);
    if (override) {
      overrides.delete(path);
      respond(res, override.body, override.status ?? 200);
      return;
    }
    switch (path) {
      case "/api/v1/dev/wallet/balance":
        return respond(res, balanceResponse);
      case "/api/v1/dev/instance/pro/list":
        return respond(res, instanceListResponse);
      case "/api/v1/dev/instance/pro/create":
        return respond(res, createResponse);
      case "/api/v1/dev/instance/pro/power_off":
        return respond(res, emptySuccess);
      default:
        return respond(res, { code: "Fail", msg: `未实现的测试路径 ${path}` });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configDir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        AUTODL_CONFIG_DIR: configDir,
        AUTODL_BASE_URL: baseUrl,
        AUTODL_TOKEN: "test-token",
        AUTODL_NO_SWEEP: "1",
        NO_COLOR: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

describe("the --json contract", () => {
  it("wraps success in {ok:true, data}", async () => {
    const result = await runCli(["account", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      ok: true,
      data: {
        balanceYuan: 12.34,
        accumulatedYuan: 987.65,
        voucherYuan: 5,
        spendableYuan: 17.34,
      },
    });
  });

  it("keeps stdout pure JSON with all chatter on stderr", async () => {
    // This is what makes `autodl ... --json | jq` reliable.
    const result = await runCli(["ls", "--json", "--verbose"]);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toContain("[debug]");
  });

  it("wraps failure in {ok:false, error} with a machine-readable code", async () => {
    overrides.set("/api/v1/dev/wallet/balance", {
      body: { code: "Fail", msg: "token 已失效", request_id: "req-x" },
    });
    const result = await runCli(["account", "--json"]);
    expect(result.json).toMatchObject({
      ok: false,
      error: { code: "AUTH_INVALID", message: "token 已失效", requestId: "req-x" },
    });
  });

  it("emits human-readable output when --json is absent", async () => {
    const result = await runCli(["account"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("¥12.34");
  });
});

describe("exit codes", () => {
  it("returns 0 on success", async () => {
    expect((await runCli(["ls", "--json"])).code).toBe(0);
  });

  it("returns 2 for bad arguments", async () => {
    const result = await runCli(["create", "--gpu", "not-a-real-gpu", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ ok: false, error: { code: "USAGE" } });
  });

  it("returns 3 when no token is configured", async () => {
    const result = await runCli(["account", "--json"], { AUTODL_TOKEN: "" });
    expect(result.code).toBe(3);
    expect(result.json).toMatchObject({ ok: false, error: { code: "AUTH_MISSING" } });
  });

  it("returns 5 when the balance guard blocks a create", async () => {
    overrides.set("/api/v1/dev/wallet/balance", {
      body: { code: "Success", msg: "", data: { assets: 100, accumulate: 0, voucher_balance: 0 } },
    });
    const result = await runCli(["create", "--gpu", "4090", "--json"]);
    expect(result.code).toBe(5);
    expect(result.json).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
  });

  it("returns 6 when AutoDL reports no stock", async () => {
    overrides.set("/api/v1/dev/instance/pro/create", {
      body: { code: "Fail", msg: "当前无可用资源" },
    });
    const result = await runCli(["create", "--gpu", "4090", "--ttl", "1h", "--json"]);
    expect(result.code).toBe(6);
    expect(result.json).toMatchObject({ ok: false, error: { code: "NO_STOCK" } });
  });
});

describe("destructive operations", () => {
  it("refuses to release without --yes in non-interactive mode", async () => {
    // There is nobody to answer a prompt when an agent is driving, so the CLI must
    // refuse rather than block or silently proceed.
    overrides.set("/api/v1/dev/instance/pro/status", {
      body: { code: "Success", msg: "", data: "shutdown" },
    });
    const result = await runCli(["rm", "pro-1", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ ok: false, error: { code: "USAGE" } });
  });
});

describe("safety defaults", () => {
  it("warns when creating an instance without a TTL", async () => {
    const result = await runCli(["create", "--gpu", "4090"]);
    expect(result.stderr).toContain("未设置 --ttl");
  });

  it("does not warn when a TTL is set", async () => {
    const result = await runCli(["create", "--gpu", "4090", "--ttl", "2h"]);
    expect(result.stderr).not.toContain("未设置 --ttl");
  });

  it("arms an in-instance shutdown timer via start_command", async () => {
    let captured: Record<string, unknown> | undefined;
    const probe = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const path = (req.url ?? "").split("?")[0];
        if (path === "/api/v1/dev/instance/pro/create") {
          captured = JSON.parse(body);
          respond(res, createResponse);
        } else if (path === "/api/v1/dev/wallet/balance") {
          respond(res, balanceResponse);
        } else {
          respond(res, emptySuccess);
        }
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (typeof address === "string" || address === null) throw new Error("no address");

    await runCli(["create", "--gpu", "4090", "--ttl", "90m", "--json"], {
      AUTODL_BASE_URL: `http://127.0.0.1:${address.port}`,
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    expect(captured?.start_command).toContain("sleep 5400");
    expect(captured?.start_command).toContain("/usr/bin/shutdown -h now");
  });
});

describe("remote output routing", () => {
  // `autodl exec box "cat file" > out.txt` has to work for a human, while --json mode
  // (and MCP, which sets it) needs stdout reserved for the payload.
  it("sends remote stdout to stdout in human mode", async () => {
    overrides.set("/api/v1/dev/instance/pro/status", {
      body: { code: "Success", msg: "", data: "shutdown" },
    });
    const result = await runCli(["exec", "pro-1", "echo", "hi"]);
    // The instance is stopped, so this fails before connecting — the point is that the
    // failure is reported on stderr and stdout is left clean for real output.
    expect(result.code).toBe(8);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SSH");
  });

  it("keeps stdout pure JSON for exec under --json", async () => {
    overrides.set("/api/v1/dev/instance/pro/status", {
      body: { code: "Success", msg: "", data: "shutdown" },
    });
    const result = await runCli(["exec", "pro-1", "echo", "hi", "--json"]);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.json).toMatchObject({ ok: false, error: { code: "SSH_FAILED" } });
  });
});

describe("the TTL sweep", () => {
  // Commander maps `--no-sweep` to `sweep: false`, not `noSweep: true`. Reading the
  // wrong key silently disables the flag, so assert on observable behaviour.
  it("runs by default and reports it under --verbose", async () => {
    const result = await runCli(["ls", "--verbose"], { AUTODL_NO_SWEEP: "" });
    expect(result.stderr).not.toContain("TTL 清理失败");
    expect(result.code).toBe(0);
  });

  it("is skipped when --no-sweep is passed", async () => {
    const result = await runCli(["ls", "--no-sweep", "--json"], { AUTODL_NO_SWEEP: "" });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true });
  });
});

describe("commands that need no credentials", () => {
  // Catalogue lookups and the local ledger read no API. Requiring a token for them
  // would block an agent from even discovering what GPUs exist before logging in.
  it.each([["gpus"], ["regions"], ["guard", "list"]])(
    "runs `%s` with no token configured",
    async (...args) => {
      const result = await runCli([...args, "--json"], { AUTODL_TOKEN: "" });
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ ok: true });
    },
  );

  it("runs `images --base` with no token, since base images are a static table", async () => {
    const result = await runCli(["images", "--base", "--json"], { AUTODL_TOKEN: "" });
    expect(result.code).toBe(0);
    expect((result.json as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it("still requires a token for `images` without --base", async () => {
    const result = await runCli(["images", "--json"], { AUTODL_TOKEN: "" });
    expect(result.code).toBe(3);
    expect(result.json).toMatchObject({ ok: false, error: { code: "AUTH_MISSING" } });
  });
});

describe("the TUI never hijacks a non-interactive session", () => {
  // The whole agent contract rests on this: stdout stays parseable and nothing takes
  // over the terminal. Failing loudly beats degrading silently, because a script that
  // reaches here has a bug worth seeing.
  it("refuses `tui` under --json with exit 2", async () => {
    const result = await runCli(["tui", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--json");
  });

  it("refuses `tui` when stdout is not a terminal", async () => {
    // runCli always pipes, so this is the piped/CI/agent case by construction.
    const result = await runCli(["tui"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("交互式终端");
  });

  it("still prints help for a bare `autodl` outside a terminal", async () => {
    const result = await runCli([]);
    // Commander treats "no command" as a usage error, so help goes to stderr with a
    // non-zero exit — long-standing behaviour that the TUI branch must not disturb.
    expect(result.stderr).toContain("Usage: autodl");
    expect(result.stdout).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain("实例看板");
  });

  it("keeps `ls --json` pure JSON now that a TUI exists", async () => {
    const result = await runCli(["ls", "--json"]);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("lists tui in help", async () => {
    expect((await runCli(["--help"])).stdout).toContain("tui");
  });
});

describe("help and version", () => {
  it("prints help with exit 0", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("autodl mcp");
  });

  it("reports the version from package.json, not a hardcoded literal", async () => {
    // changesets rewrites package.json on release; a literal in the source would
    // silently keep reporting the previous version.
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    const result = await runCli(["--version"]);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("documents the exit codes in help output", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("退出码");
  });
});
