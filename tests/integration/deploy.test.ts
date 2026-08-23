import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deploy assembles shell commands that run on a rented machine and may carry a git
 * credential. These tests capture every command it issues and assert on their content —
 * both that the logic is right and that no token ever appears where it shouldn't.
 */

const ssh = vi.hoisted(() => ({
  commands: [] as string[],
  /** Responses keyed by a substring of the command. */
  responses: [] as { match: string; stdout?: string; exitCode?: number }[],
}));

vi.mock("../../src/ssh/exec.js", () => ({
  execCommand: vi.fn(async (_client: unknown, _uuid: string, command: string) => {
    ssh.commands.push(command);
    const hit = ssh.responses.find((r) => command.includes(r.match));
    return {
      exitCode: hit?.exitCode ?? 0,
      signal: null,
      stdout: hit?.stdout ?? "",
      stderr: "",
    };
  }),
  execOnConnection: vi.fn(),
}));

const { AutoDLClient } = await import("../../src/core/client.js");
const { deployWorkflow } = await import("../../src/workflow/deploy.js");
const { configureOutput } = await import("../../src/output/format.js");
const { mockFetch } = await import("../fixtures/mock-fetch.js");
const { createResponse, emptySuccess, snapshotResponse, stockResponse } = await import(
  "../fixtures/responses.js"
);

const CREATE = "/api/v1/dev/instance/pro/create";
const STATUS = "/api/v1/dev/instance/pro/status";
const SNAPSHOT = "/api/v1/dev/instance/pro/snapshot";
const POWER_ON = "/api/v1/dev/instance/pro/power_on";
const POWER_OFF = "/api/v1/dev/instance/pro/power_off";
const BALANCE = "/api/v1/dev/wallet/balance";
const STOCK = "/api/v1/dev/machine/region/gpu_stock";

function routes(overrides: { statusSequence?: string[] } = {}) {
  let statusIndex = 0;
  return [
    { path: BALANCE, response: { code: "Success", msg: "", data: { assets: 500_000 } } },
    { path: STOCK, response: stockResponse({ "RTX 4090D": { idle: 42, total: 100 } }) },
    { path: CREATE, response: createResponse },
    {
      path: STATUS,
      response: () => {
        const sequence = overrides.statusSequence ?? ["running"];
        const value = sequence[Math.min(statusIndex++, sequence.length - 1)];
        return { code: "Success", msg: "", data: value };
      },
    },
    { path: SNAPSHOT, response: snapshotResponse },
    { path: POWER_ON, response: emptySuccess },
    { path: POWER_OFF, response: emptySuccess },
  ];
}

function client(fetchImpl: typeof fetch) {
  return new AutoDLClient({ token: "t", fetchImpl, retryBaseDelayMs: 1 });
}

const base = { repo: "owner/demo", gpu: "4090D", ttlSeconds: 3600 };

beforeEach(() => {
  ssh.commands.length = 0;
  ssh.responses.length = 0;
  configureOutput({ json: true, color: false, verbose: false });
  process.env.AUTODL_NO_SWEEP = "1";
});

afterEach(() => {
  configureOutput({ json: false, color: true, verbose: false });
});

const allCommands = () => ssh.commands.join("\n");

describe("checkout", () => {
  it("clones when there is no existing checkout, into the data disk", async () => {
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), base);

    expect(result.dir).toBe("/root/autodl-tmp/demo");
    const checkout = ssh.commands.find((c) => c.includes("git clone")) as string;
    expect(checkout).toContain("git clone --depth 1");
    expect(checkout).toContain("/root/autodl-tmp/demo");
    // The branch matters: it must decide between clone and update at runtime, on the
    // box, because we don't know whether the instance was used before.
    expect(checkout).toContain("if [ -d");
  });

  it("updates in place when the checkout already exists", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), base);
    const checkout = ssh.commands.find((c) => c.includes("git clone")) as string;
    expect(checkout).toContain("git fetch --depth 1 origin");
    expect(checkout).toContain("git reset --hard");
  });

  it("checks out a specific branch when asked", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, branch: "dev" });
    const checkout = ssh.commands.find((c) => c.includes("git clone")) as string;
    expect(checkout).toContain("--branch 'dev'");
    expect(checkout).toContain("git checkout -B 'dev' origin/'dev'");
  });

  it("enables academic acceleration for GitHub", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), base);
    expect(ssh.commands.find((c) => c.includes("git clone"))).toContain(
      "source /etc/network_turbo",
    );
  });

  it("does not enable acceleration for Gitee, which does not need it", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), {
      ...base,
      repo: "https://gitee.com/owner/demo",
    });
    expect(ssh.commands.find((c) => c.includes("git clone"))).not.toContain("network_turbo");
  });

  it("honours --no-accel", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, noAcceleration: true });
    expect(ssh.commands.find((c) => c.includes("git clone"))).not.toContain("network_turbo");
  });

  it("fails with a usable hint when the clone fails", async () => {
    ssh.responses.push({ match: "git clone", exitCode: 128 });
    const fetchMock = mockFetch(routes());
    await expect(deployWorkflow(client(fetchMock.impl), base)).rejects.toThrow(/拉取仓库失败/);
  });
});

describe("git credentials", () => {
  const token = "ghp_supersecret_value";

  it("uses the token for the clone", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, gitToken: token });
    expect(ssh.commands.find((c) => c.includes("git clone"))).toContain(token);
  });

  it("scrubs the credential from the stored remote afterwards", async () => {
    // .git/config outlives this process on a machine that may be reused or imaged.
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, gitToken: token });
    const checkout = ssh.commands.find((c) => c.includes("git clone")) as string;
    const scrub = checkout.slice(checkout.lastIndexOf("git remote set-url"));
    expect(scrub).toContain("https://github.com/owner/demo.git");
    expect(scrub).not.toContain(token);
  });

  it("never puts the token in the returned result", async () => {
    // The result is what reaches --json output and MCP tool responses.
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), { ...base, gitToken: token });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("fails without leaking the token when the clone fails", async () => {
    ssh.responses.push({ match: "git clone", exitCode: 128 });
    const fetchMock = mockFetch(routes());
    await expect(
      deployWorkflow(client(fetchMock.impl), { ...base, gitToken: token }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(token),
      }),
    );
  });
});

describe("dependency setup", () => {
  it("detects requirements.txt and installs from it", async () => {
    ssh.responses.push({ match: "echo 'requirements.txt'", stdout: "requirements.txt\n" });
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), base);
    expect(result.setupCommand).toBe("pip install -r requirements.txt");
    expect(allCommands()).toContain("pip install -r requirements.txt");
  });

  it("prefers environment.yml over requirements.txt", async () => {
    // requirements.txt is usually referenced from inside the conda env file.
    ssh.responses.push({
      match: "echo 'environment.yml'",
      stdout: "environment.yml\nrequirements.txt\n",
    });
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), base);
    expect(result.setupCommand).toContain("conda env update");
  });

  it("prefers npm ci over npm install when a lockfile exists", async () => {
    ssh.responses.push({
      match: "echo 'environment.yml'",
      stdout: "package-lock.json\npackage.json\n",
    });
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), base);
    expect(result.setupCommand).toBe("npm ci");
  });

  it("skips installation when no manifest is present", async () => {
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), base);
    expect(result.setupCommand).toBeNull();
  });

  it("lets --setup override detection entirely", async () => {
    ssh.responses.push({ match: "echo 'requirements.txt'", stdout: "requirements.txt\n" });
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), {
      ...base,
      setup: "uv sync",
    });
    expect(result.setupCommand).toBe("uv sync");
    expect(allCommands()).not.toContain("pip install");
  });

  it("skips detection entirely with --no-setup", async () => {
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), { ...base, noSetup: true });
    expect(result.setupCommand).toBeNull();
    expect(allCommands()).not.toContain("echo 'requirements.txt'");
  });

  it("aborts when installation fails, rather than starting a broken project", async () => {
    ssh.responses.push({ match: "echo 'requirements.txt'", stdout: "requirements.txt\n" });
    ssh.responses.push({ match: "pip install", exitCode: 1 });
    const fetchMock = mockFetch(routes());
    await expect(deployWorkflow(client(fetchMock.impl), base)).rejects.toThrow(/依赖安装失败/);
  });
});

describe("every assembled command is valid shell", () => {
  // A `.join(" && ")` once produced `... 2>&1 & && echo ...`, which bash rejects
  // outright. Asserting on substrings missed it because each substring was present.
  // Running the real thing through `bash -n` is what actually catches this class.
  async function assertParses(commands: string[]) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    for (const command of commands) {
      // The workflow wraps in `bash -lc '...'`; check the payload bash will parse.
      await expect(
        run("bash", ["-n", "-c", command]),
        `not valid shell:\n${command}`,
      ).resolves.toBeDefined();
    }
  }

  it("parses the foreground path", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, start: "python app.py" });
    await assertParses(ssh.commands);
  });

  it("parses the detached path", async () => {
    const fetchMock = mockFetch(routes());
    ssh.responses.push({ match: "AUTODL_START_OK", stdout: "AUTODL_START_OK 1234\n" });
    await deployWorkflow(client(fetchMock.impl), {
      ...base,
      start: "python app.py",
      detach: true,
    });
    await assertParses(ssh.commands);
  });

  it("parses with a branch, a token and a custom setup command", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), {
      ...base,
      branch: "feature/x",
      gitToken: "ghp_abc",
      setup: "pip install -e '.[dev]'",
      start: "python -c 'print(1)'",
    });
    await assertParses(ssh.commands);
  });
});

describe("start behaviour", () => {
  it("runs the start command in the foreground by default", async () => {
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), {
      ...base,
      start: "python app.py",
    });
    expect(result.detached).toBe(false);
    const start = ssh.commands.at(-1) as string;
    expect(start).toContain("cd '/root/autodl-tmp/demo' && python app.py");
    expect(start).not.toContain("nohup");
  });

  it("backgrounds the command with a log and pid file under --detach", async () => {
    const fetchMock = mockFetch(routes());
    ssh.responses.push({ match: "AUTODL_START_OK", stdout: "AUTODL_START_OK 1234\n" });
    const result = await deployWorkflow(client(fetchMock.impl), {
      ...base,
      start: "python app.py",
      detach: true,
    });
    expect(result.detached).toBe(true);
    const start = ssh.commands.find((c) => c.includes("nohup")) as string;
    expect(start).toContain("nohup python app.py > .autodl/start.log 2>&1 < /dev/null &");
    expect(start).toContain("echo $! > .autodl/start.pid");
  });

  it("reports the instance as kept, not powered off, when detached", async () => {
    // The instance really is left running; saying "poweroff" would mislead the caller.
    const fetchMock = mockFetch(routes());
    ssh.responses.push({ match: "AUTODL_START_OK", stdout: "AUTODL_START_OK 1234\n" });
    const result = await deployWorkflow(client(fetchMock.impl), {
      ...base,
      start: "python app.py",
      detach: true,
    });
    expect(result.finalAction).toBe("keep");
  });

  it("fails loudly when the backgrounded process dies immediately", async () => {
    // Starting is not running. Previously this reported success regardless.
    ssh.responses.push({
      match: "AUTODL_START_OK",
      exitCode: 1,
      stdout: "AUTODL_START_DEAD\nTraceback: ModuleNotFoundError\n",
    });
    const fetchMock = mockFetch(routes());
    await expect(
      deployWorkflow(client(fetchMock.impl), {
        ...base,
        start: "python app.py",
        detach: true,
      }),
    ).rejects.toThrow(/后台启动失败/);
  });

  it("propagates the project's exit code", async () => {
    ssh.responses.push({ match: "python app.py", exitCode: 3 });
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), {
      ...base,
      start: "python app.py",
    });
    expect(result.exitCode).toBe(3);
  });
});

describe("lifecycle — stop, do not release", () => {
  it("powers the instance off by default and never releases it", async () => {
    // This is the whole point of deploy versus run: the data survives for reuse.
    const fetchMock = mockFetch(routes());
    const result = await deployWorkflow(client(fetchMock.impl), base);
    expect(result.finalAction).toBe("poweroff");
    expect(fetchMock.calls.some((c) => c.url.includes("power_off"))).toBe(true);
    expect(fetchMock.calls.some((c) => c.url.includes("/release"))).toBe(false);
  });

  it("powers off even when the start command fails", async () => {
    ssh.responses.push({ match: "python app.py", exitCode: 1 });
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, start: "python app.py" });
    expect(fetchMock.calls.some((c) => c.url.includes("power_off"))).toBe(true);
  });

  it("powers off even when setup throws", async () => {
    ssh.responses.push({ match: "echo 'requirements.txt'", stdout: "requirements.txt\n" });
    ssh.responses.push({ match: "pip install", exitCode: 1 });
    const fetchMock = mockFetch(routes());
    await expect(deployWorkflow(client(fetchMock.impl), base)).rejects.toThrow();
    expect(fetchMock.calls.some((c) => c.url.includes("power_off"))).toBe(true);
  });

  it("keeps the instance running when the service was detached", async () => {
    // Shutting down would kill the very service we just backgrounded.
    const fetchMock = mockFetch(routes());
    ssh.responses.push({ match: "AUTODL_START_OK", stdout: "AUTODL_START_OK 1234\n" });
    await deployWorkflow(client(fetchMock.impl), {
      ...base,
      start: "python app.py",
      detach: true,
    });
    expect(fetchMock.calls.some((c) => c.url.includes("power_off"))).toBe(false);
  });

  it("releases only when explicitly asked, and waits for shutdown first", async () => {
    // AutoDL rejects a release while the instance is still `shutting_down`; releasing
    // immediately after power_off is a race that fails in practice.
    const fetchMock = mockFetch([
      // running (wait-for-ready) → running (cleanup's pre-check) → shutting_down → shutdown
      ...routes({ statusSequence: ["running", "running", "shutting_down", "shutdown"] }),
      { path: "/api/v1/dev/instance/pro/release", response: emptySuccess },
    ]);
    const result = await deployWorkflow(client(fetchMock.impl), { ...base, onFinish: "release" });
    expect(result.finalAction).toBe("release");

    const order = fetchMock.calls.map((c) => c.url);
    const powerOffAt = order.findIndex((url) => url.includes("power_off"));
    const releaseAt = order.findIndex((url) => url.includes("/release"));
    const statusChecksBetween = order
      .slice(powerOffAt, releaseAt)
      .filter((url) => url.includes("/status")).length;

    expect(releaseAt).toBeGreaterThan(powerOffAt);
    expect(statusChecksBetween).toBeGreaterThan(0);
  }, 20_000);
});

describe("instance reuse", () => {
  it("powers on an existing instance instead of creating a new one", async () => {
    const fetchMock = mockFetch(routes({ statusSequence: ["shutdown", "running", "running"] }));
    const result = await deployWorkflow(client(fetchMock.impl), {
      repo: "owner/demo",
      instanceUuid: "pro-existing",
      ttlSeconds: 3600,
    });
    expect(result.created).toBe(false);
    expect(result.instanceUuid).toBe("pro-existing");
    expect(fetchMock.calls.some((c) => c.url.includes("power_on"))).toBe(true);
    expect(fetchMock.calls.some((c) => c.url.includes("/create"))).toBe(false);
  });

  it("does not consult stock or the balance gate when reusing", async () => {
    const fetchMock = mockFetch(routes({ statusSequence: ["running"] }));
    await deployWorkflow(client(fetchMock.impl), {
      repo: "owner/demo",
      instanceUuid: "pro-existing",
      ttlSeconds: 3600,
    });
    expect(fetchMock.calls.some((c) => c.url.includes("gpu_stock"))).toBe(false);
    expect(fetchMock.calls.some((c) => c.url.includes("wallet/balance"))).toBe(false);
  });

  it("requires --gpu when not reusing an instance", async () => {
    const fetchMock = mockFetch(routes());
    await expect(
      deployWorkflow(client(fetchMock.impl), { repo: "owner/demo", ttlSeconds: 3600 }),
    ).rejects.toThrow(/必须指定 --gpu/);
  });
});

describe("region handling", () => {
  it("omits data_center_list entirely when no region was requested", async () => {
    // Live evidence: naming a region can fail where an unconstrained request succeeds,
    // because Pro capacity does not track the elastic-deployment stock we can see.
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), base);
    const create = fetchMock.calls.find((c) => c.url.includes("/create"));
    expect(create?.body).not.toHaveProperty("data_center_list");
  });

  it("does not query stock when no region was requested", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), base);
    expect(fetchMock.calls.some((c) => c.url.includes("gpu_stock"))).toBe(false);
  });

  it("passes through a region Pro creation supports", async () => {
    const fetchMock = mockFetch(routes());
    await deployWorkflow(client(fetchMock.impl), { ...base, regions: ["beijingDC2"] });
    const create = fetchMock.calls.find((c) => c.url.includes("/create"));
    expect(create).toBeDefined();
    const body = create?.body as { data_center_list?: string[] } | undefined;
    expect(body?.data_center_list).toEqual(["beijingDC2"]);
  });

  it("rejects an elastic-deployment-only region before creating anything", async () => {
    const fetchMock = mockFetch(routes());
    await expect(
      deployWorkflow(client(fetchMock.impl), { ...base, regions: ["chongqingDC1"] }),
    ).rejects.toThrow(/不支持创建 Pro 实例/);
    expect(fetchMock.calls.some((c) => c.url.includes("/create"))).toBe(false);
  });
});
