import { untrackInstance } from "../config/state.js";
import {
  assertProCreateRegion,
  DEFAULT_BASE_IMAGE,
  findBaseImage,
  parseCudaVersion,
  resolveGpuSpec,
} from "../core/catalog.js";
import type { AutoDLClient } from "../core/client.js";
import { formatDuration } from "../core/duration.js";
import {
  createInstance,
  getInstanceSnapshot,
  getInstanceStatus,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "../core/endpoints/instance.js";
import { UsageError } from "../core/errors.js";
import { type ParsedRepo, parseRepo, redactCredentials, withCredentials } from "../core/repo.js";
import { chooseRegions } from "../core/stock.js";
import { waitForRunning, waitForShutdown } from "../core/waiters.js";
import { assertBudget } from "../guard/budget.js";
import { armTTLOverSSH, composeStartCommand, recordTTL } from "../guard/ttl.js";
import { debug, isJson, note, success, warn } from "../output/format.js";
import { t } from "../output/i18n.js";
import { type ExecResult, execCommand } from "../ssh/exec.js";

/**
 * Deploy a hosted git project onto an AutoDL instance.
 *
 * The defining difference from `runWorkflow`: this **stops** the instance at the end
 * rather than releasing it. A stopped container instance keeps its disks, so the next
 * deploy can power the same box back on and `git pull` instead of rebuilding from
 * scratch. Releasing would throw all of that away.
 */

export interface DeployOptions {
  repo: string;
  branch?: string;
  /** Reuse an existing instance instead of creating one. */
  instanceUuid?: string;
  gpu?: string;
  gpuNum?: number;
  image?: string;
  regions?: string[];
  diskGb?: number;
  name?: string;
  /** Remote checkout directory. Defaults to /root/autodl-tmp/<repo>. */
  dir?: string;
  /** Overrides dependency auto-detection. */
  setup?: string;
  noSetup?: boolean;
  /** Command that runs the project once dependencies are in place. */
  start?: string;
  /** Background the start command and return immediately. */
  detach?: boolean;
  gitToken?: string;
  /** Disable `source /etc/network_turbo` even for accelerated hosts. */
  noAcceleration?: boolean;
  ttlSeconds: number;
  onFinish?: "poweroff" | "release" | "keep";
  commandTimeoutMs?: number;
  minBalanceYuan?: number;
  stockCheck?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DeployResult {
  instanceUuid: string;
  /** True when this call created the instance rather than reusing one. */
  created: boolean;
  repo: { host: string; path: string; name: string; branch: string | null };
  dir: string;
  setupCommand: string | null;
  startCommand: string | null;
  detached: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** How to reach a detached service. */
  access: { publicUrls: string[]; tunnelHint: string | null; logHint: string | null };
  finalAction: "poweroff" | "release" | "keep";
  durationMs: number;
}

/** Where AutoDL's docs say project code belongs: the data disk, not the system disk. */
const DATA_DISK = "/root/autodl-tmp";

/** Sentinels used to tell "backgrounded and still alive" from "started and died". */
const ALIVE_MARKER = "AUTODL_START_OK";
const DEAD_MARKER = "AUTODL_START_DEAD";

/**
 * Dependency manifests in the order we prefer them. First hit wins — a repo with both
 * `environment.yml` and `requirements.txt` almost always wants the conda one, since the
 * requirements file is usually referenced from inside it.
 */
const SETUP_RECIPES: { file: string; command: string }[] = [
  { file: "environment.yml", command: "conda env update -f environment.yml --prune" },
  { file: "requirements.txt", command: "pip install -r requirements.txt" },
  { file: "pyproject.toml", command: "pip install -e ." },
  { file: "package-lock.json", command: "npm ci" },
  { file: "package.json", command: "npm install" },
];

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prefix a command with AutoDL's academic proxy when the target host benefits.
 * The proxy only covers GitHub and HuggingFace, and AutoDL asks that it stay off
 * otherwise, so this is deliberately narrow.
 */
function withAcceleration(command: string, enabled: boolean): string {
  return enabled ? `source /etc/network_turbo >/dev/null 2>&1; ${command}` : command;
}

async function run(
  client: AutoDLClient,
  uuid: string,
  command: string,
  options: DeployOptions,
  { label, capture = true }: { label: string; capture?: boolean },
): Promise<ExecResult> {
  debug(`[${label}] ${redactCredentials(command)}`);
  const result = await execCommand(client, uuid, command, {
    capture,
    stdout: isJson() ? process.stderr : process.stdout,
    stderr: process.stderr,
    ...(options.commandTimeoutMs !== undefined ? { timeoutMs: options.commandTimeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return result;
}

/** Probe the checkout for a dependency manifest and return the matching command. */
async function detectSetup(
  client: AutoDLClient,
  uuid: string,
  dir: string,
  options: DeployOptions,
): Promise<string | null> {
  // One round trip: list which manifests exist, then decide locally.
  const probe = SETUP_RECIPES.map(
    (recipe) => `[ -f ${quote(`${dir}/${recipe.file}`)} ] && echo ${quote(recipe.file)}`,
  ).join("; ");

  const result = await run(client, uuid, `${probe}; true`, options, {
    label: "detect",
    capture: true,
  });
  const present = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );

  const recipe = SETUP_RECIPES.find((candidate) => present.has(candidate.file));
  if (!recipe) {
    note(
      "未探测到依赖清单（environment.yml / requirements.txt / pyproject.toml / package.json），跳过安装",
    );
    return null;
  }
  note(`探测到 ${recipe.file}，将执行：${recipe.command}`);
  return recipe.command;
}

async function checkout(
  client: AutoDLClient,
  uuid: string,
  repo: ParsedRepo,
  dir: string,
  options: DeployOptions,
): Promise<void> {
  const accelerate = repo.needsAcceleration && !options.noAcceleration;
  if (accelerate) note("已启用学术资源加速（仅覆盖 GitHub / HuggingFace）");

  const { url } = withCredentials(repo, options.gitToken);
  const branch = options.branch;

  // Existing checkout: update in place, so a redeploy onto a stopped instance is cheap.
  // Fresh checkout: shallow clone.
  const update = [
    `cd ${quote(dir)}`,
    `git remote set-url origin ${quote(url)}`,
    "git fetch --depth 1 origin",
    branch ? `git checkout -B ${quote(branch)} origin/${quote(branch)}` : "git reset --hard @{u}",
  ].join(" && ");

  const clone = [
    `mkdir -p ${quote(DATA_DISK)}`,
    `git clone --depth 1 ${branch ? `--branch ${quote(branch)} ` : ""}${quote(url)} ${quote(dir)}`,
  ].join(" && ");

  // Always scrub the credential out of the stored remote afterwards: the URL lives in
  // .git/config on a machine that outlives this process.
  const scrub = `cd ${quote(dir)} && git remote set-url origin ${quote(repo.cloneUrl)}`;

  const command = withAcceleration(
    `if [ -d ${quote(`${dir}/.git`)} ]; then ${update}; else ${clone}; fi && ${scrub}`,
    accelerate,
  );

  const result = await run(client, uuid, command, options, { label: "checkout", capture: true });
  if (result.exitCode !== 0) {
    throw new UsageError(`拉取仓库失败（退出码 ${result.exitCode}）`, {
      hint: options.gitToken
        ? "确认 token 对该仓库有读权限。"
        : "私有仓库需要 --git-token，或设置 GIT_TOKEN / GITHUB_TOKEN 环境变量。",
      details: { stderr: redactCredentials(result.stderr).slice(0, 500) },
    });
  }
  success(`代码已就绪：${dir}`);
}

/** Public service URLs, if the account has them (they require enterprise verification). */
async function describeAccess(
  client: AutoDLClient,
  uuid: string,
  dir: string,
  detached: boolean,
): Promise<DeployResult["access"]> {
  if (!detached) return { publicUrls: [], tunnelHint: null, logHint: null };

  const logHint = `autodl exec ${uuid} "tail -f ${dir}/.autodl/start.log"`;
  try {
    const snapshot = await getInstanceSnapshot(client, uuid);
    const publicUrls = snapshot.services.map(
      (service) =>
        `${service.protocol === "http" ? "https://" : ""}${service.domain} (:${service.port})`,
    );
    return {
      publicUrls,
      // 6006/6008 public mapping needs enterprise verification; personal accounts tunnel.
      tunnelHint: publicUrls.length ? null : `autodl ssh ${uuid} -L 6006:localhost:6006`,
      logHint,
    };
  } catch {
    return { publicUrls: [], tunnelHint: `autodl ssh ${uuid} -L 6006:localhost:6006`, logHint };
  }
}

export async function deployWorkflow(
  client: AutoDLClient,
  options: DeployOptions,
): Promise<DeployResult> {
  const startedAt = Date.now();
  const repo = parseRepo(options.repo);
  const dir = options.dir ?? `${DATA_DISK}/${repo.name}`;
  const onFinish = options.onFinish ?? "poweroff";

  let uuid = options.instanceUuid;
  let created = false;

  if (uuid) {
    // Reuse path: this is what "stop, don't release" buys you.
    const status = await getInstanceStatus(client, uuid);
    if (status !== "running") {
      note(t("instance.poweringOn"));
      await powerOnInstance(client, uuid, {
        startCommand: composeStartCommand(options.ttlSeconds, undefined) as string,
      });
      await waitForRunning(client, uuid, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    const armed = await armTTLOverSSH(client, uuid, options.ttlSeconds);
    if (!armed) warn(t("guard.armFailed"));
    recordTTL({ uuid, ttlSeconds: options.ttlSeconds, inInstanceTimer: armed });
    success(`复用实例 ${uuid}`);
  } else {
    if (!options.gpu) {
      throw new UsageError("必须指定 --gpu（或用 --instance 复用已有实例）", {
        hint: "运行 `autodl gpus` 查看规格，`autodl stock` 查看哪里有货。",
      });
    }
    const spec = resolveGpuSpec(options.gpu);
    if (!spec) {
      throw new UsageError(`未知的 GPU 规格 "${options.gpu}"`, {
        hint: "运行 `autodl gpus` 查看官方 API 支持的全部规格。",
      });
    }

    const imageInput = options.image ?? DEFAULT_BASE_IMAGE;
    const image = findBaseImage(imageInput);
    const imageUuid = image?.uuid ?? imageInput;

    // Pro creation accepts only two regions; anything else fails opaquely upstream.
    const requestedRegions = (options.regions ?? []).map(
      (input) => assertProCreateRegion(input).id,
    );

    await assertBudget(client, options.minBalanceYuan);

    const regions =
      options.stockCheck === false
        ? requestedRegions
        : (await chooseRegions(client, spec, requestedRegions)).regions;

    note(t("instance.creating"));
    uuid = await createInstance(client, {
      gpuSpec: spec.id,
      gpuNum: options.gpuNum ?? 1,
      imageUuid,
      cudaFrom: parseCudaVersion(image?.cuda ?? "11.8"),
      expandSystemDiskGb: options.diskGb ?? 0,
      ...(regions.length ? { regions } : {}),
      name: options.name ?? repo.name,
      ...(composeStartCommand(options.ttlSeconds, undefined)
        ? { startCommand: composeStartCommand(options.ttlSeconds, undefined) as string }
        : {}),
    });
    created = true;
    recordTTL({
      uuid,
      name: options.name ?? repo.name,
      ttlSeconds: options.ttlSeconds,
      inInstanceTimer: true,
    });
    success(`${t("instance.created")}：${uuid}（TTL ${formatDuration(options.ttlSeconds)}）`);

    note(t("instance.waiting"));
    await waitForRunning(client, uuid, { ...(options.signal ? { signal: options.signal } : {}) });
    success(t("instance.ready"));
  }

  const instanceUuid = uuid;
  let setupCommand: string | null = null;
  let startCommand: string | null = null;
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  let access: DeployResult["access"] = { publicUrls: [], tunnelHint: null, logHint: null };

  try {
    await checkout(client, instanceUuid, repo, dir, options);

    if (!options.noSetup) {
      setupCommand = options.setup ?? (await detectSetup(client, instanceUuid, dir, options));
      if (setupCommand) {
        note("正在安装依赖…");
        const accelerate = repo.needsAcceleration && !options.noAcceleration;
        const result = await run(
          client,
          instanceUuid,
          withAcceleration(`cd ${quote(dir)} && ${setupCommand}`, accelerate),
          options,
          { label: "setup", capture: true },
        );
        if (result.exitCode !== 0) {
          throw new UsageError(`依赖安装失败（退出码 ${result.exitCode}）`, {
            hint: "可以用 --setup 指定自定义安装命令，或 --no-setup 跳过后手动处理。",
          });
        }
        success("依赖安装完成");
      }
    }

    if (options.start) {
      startCommand = options.start;
      if (options.detach) {
        // The instance outlives this process, so the log has to live on the box.
        //
        // Three details that are easy to get wrong, and were:
        //  - `&` ends a command, so the pieces after it join with `;`, not `&&`.
        //  - stdin comes from /dev/null, or the background process holds the SSH
        //    channel open and the exec never returns.
        //  - starting is not the same as running: verify the pid is still alive and
        //    surface the log if it died, instead of reporting a false success.
        const detached = [
          `cd ${quote(dir)}`,
          "mkdir -p .autodl",
          `{ nohup ${options.start} > .autodl/start.log 2>&1 < /dev/null & echo $! > .autodl/start.pid; }`,
          "sleep 2",
          `if kill -0 "$(cat .autodl/start.pid)" 2>/dev/null; then echo "${ALIVE_MARKER} $(cat .autodl/start.pid)"; else echo "${DEAD_MARKER}"; tail -50 .autodl/start.log; exit 1; fi`,
        ].join(" && ");

        const result = await run(client, instanceUuid, detached, options, {
          label: "start",
          capture: true,
        });
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;

        if (result.exitCode !== 0 || result.stdout.includes(DEAD_MARKER)) {
          throw new UsageError("后台启动失败：进程已退出", {
            hint: `完整日志在实例上的 ${dir}/.autodl/start.log`,
            details: {
              log: result.stdout.replace(DEAD_MARKER, "").trim().slice(0, 800),
              stderr: result.stderr.slice(0, 400),
            },
          });
        }
        success("已在后台启动并确认进程存活");
      } else {
        note("正在启动项目…");
        const result = await run(
          client,
          instanceUuid,
          `cd ${quote(dir)} && ${options.start}`,
          options,
          { label: "start", capture: true },
        );
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
      }
    }

    access = await describeAccess(
      client,
      instanceUuid,
      dir,
      Boolean(options.detach && options.start),
    );
  } finally {
    await finish(client, instanceUuid, onFinish, Boolean(options.detach && options.start));
  }

  return {
    instanceUuid,
    created,
    repo: { host: repo.host, path: repo.path, name: repo.name, branch: options.branch ?? null },
    dir,
    setupCommand,
    startCommand,
    detached: Boolean(options.detach && options.start),
    exitCode,
    stdout,
    stderr,
    access,
    // A detached run deliberately leaves the instance up, so reporting the requested
    // `poweroff` here would be a lie the caller might act on.
    finalAction: options.detach && options.start ? "keep" : onFinish,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Cleanup. Runs in a `finally`, so it must never throw — an exception here would mask
 * the real error and hide the fact that the instance is still burning money.
 */
async function finish(
  client: AutoDLClient,
  uuid: string,
  action: "poweroff" | "release" | "keep",
  detached: boolean,
): Promise<void> {
  if (detached) {
    // Shutting down would kill the very service we just backgrounded.
    warn(`实例 ${uuid} 保持运行中（--detach），用完请关机：autodl stop ${uuid}`);
    return;
  }
  if (action === "keep") {
    warn(`实例 ${uuid} 仍在运行（--on-finish keep），记得手动关机：autodl stop ${uuid}`);
    return;
  }

  note(t("run.cleanup"));
  try {
    // Skip the call if AutoDL is already stopping it; a duplicate is rejected.
    const status = await getInstanceStatus(client, uuid).catch(() => "unknown");
    if (status !== "shutdown" && status !== "shutting_down") {
      await powerOffInstance(client, uuid);
    }
    success(`实例 ${uuid} 已关机，计费已停止（数据保留，可再次部署复用）`);
  } catch (err) {
    warn(`自动关机失败：${(err as Error).message}`);
    warn(`请立即手动处理：autodl stop ${uuid}`);
    return;
  }

  if (action === "release") {
    try {
      // AutoDL rejects a release until the instance has finished shutting down.
      await waitForShutdown(client, uuid, { timeoutMs: 10 * 60_000 });
      await releaseInstance(client, uuid);
      untrackInstance(uuid);
      success(`实例 ${uuid} 已释放`);
    } catch (err) {
      warn(`释放失败（实例已关机，不再计费）：${(err as Error).message}`);
      warn(`稍后可重试：autodl rm ${uuid} --yes`);
    }
  } else {
    untrackInstance(uuid);
  }
}
