import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { untrackInstance } from "../config/state.js";
import { type Context, createContext } from "../context.js";
import {
  BASE_IMAGES,
  DEFAULT_BASE_IMAGE,
  findBaseImage,
  GPU_SPECS,
  parseCudaVersion,
  REGIONS,
  resolveGpuSpec,
  resolveRegion,
} from "../core/catalog.js";
import { parseDuration } from "../core/duration.js";
import { getBalance } from "../core/endpoints/account.js";
import { listPrivateImages, saveImage } from "../core/endpoints/image.js";
import {
  createInstance,
  findInstance,
  getInstanceSnapshot,
  getInstanceStatus,
  listAllInstances,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "../core/endpoints/instance.js";
import { toAutoDLError, UsageError } from "../core/errors.js";
import { redactSnapshot } from "../core/schemas.js";
import { waitForRunning } from "../core/waiters.js";
import { assertBudget } from "../guard/budget.js";
import { armTTLOverSSH, composeStartCommand, recordTTL, sweepExpired } from "../guard/ttl.js";
import { execCommand } from "../ssh/exec.js";
import { pull, push } from "../ssh/transfer.js";
import { runWorkflow } from "../workflow/run.js";

/**
 * MCP surface.
 *
 * Same core as the CLI — commands and tools are both thin shells — but with different
 * defaults, because the caller here is an autonomous agent rather than a person:
 *
 *  - TTL is mandatory and defaults to 2h. An agent that forgets to clean up costs real
 *    money, and AutoDL bills on power state regardless of GPU use.
 *  - Releasing requires an explicit `confirm: true`; there is nobody to answer a prompt.
 *  - Passwords are redacted unless the caller explicitly asks for them.
 */

const DEFAULT_MCP_TTL = "2h";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const error = toAutoDLError(err);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: error.toJSON() }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Wrap a handler so a thrown error becomes a structured tool error, not a crash. */
function tool<T>(handler: (input: T) => Promise<unknown>) {
  return async (input: T) => {
    try {
      return ok({ ok: true, data: await handler(input) });
    } catch (err) {
      return fail(err);
    }
  };
}

export function buildServer(context: Context): McpServer {
  const server = new McpServer(
    { name: "autodl-cli", version: "0.1.0" },
    {
      instructions: [
        "通过 AutoDL 官方开放 API 管理 GPU 实例：创建、开关机、SSH 执行命令、传文件。",
        "重要：AutoDL 按实例开机时长计费，与是否使用 GPU 无关。用完请立刻调用 autodl_power_off。",
        "创建实例默认带 2 小时 TTL 兜底自动关机；如果任务更长请显式传 ttl。",
        "开关机后 SSH 端口和密码会变化，不要缓存 autodl_get_instance 的结果。",
      ].join("\n"),
    },
  );

  const { client } = context;

  server.registerTool(
    "autodl_account_info",
    {
      title: "查询账号余额",
      description: "返回 AutoDL 账号的可用余额、代金券余额和累计消费（单位：元）。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const balance = await getBalance(client);
      return { ...balance, spendableYuan: balance.balanceYuan + balance.voucherYuan };
    }),
  );

  server.registerTool(
    "autodl_list_instances",
    {
      title: "列出实例",
      description: "列出账号下所有实例及其状态。可用 status 过滤，如 running / shutdown。",
      inputSchema: { status: z.string().optional().describe("按状态过滤，例如 running") },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ status }: { status?: string }) => {
      const instances = await listAllInstances(client);
      return status ? instances.filter((i) => i.status === status) : instances;
    }),
  );

  server.registerTool(
    "autodl_get_instance",
    {
      title: "查询实例详情",
      description:
        "返回实例详情与实时 SSH 连接信息。注意：实例每次开关机后 SSH 端口和 root 密码都会变化，务必每次重新调用而不要缓存。",
      inputSchema: {
        instance_uuid: z.string().describe("实例 ID，例如 pro-76419909953e"),
        reveal_password: z.boolean().optional().describe("是否返回 root 密码明文，默认脱敏为 ***"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(
      async ({
        instance_uuid,
        reveal_password,
      }: {
        instance_uuid: string;
        reveal_password?: boolean;
      }) => {
        const instance = await findInstance(client, instance_uuid);
        const snapshot = await getInstanceSnapshot(client, instance_uuid).catch(() => null);
        return {
          instance,
          snapshot: snapshot ? (reveal_password ? snapshot : redactSnapshot(snapshot)) : null,
        };
      },
    ),
  );

  server.registerTool(
    "autodl_create_instance",
    {
      title: "创建 GPU 实例",
      description: [
        "创建一台按量计费的 AutoDL Pro 实例并可选等待其就绪。",
        "会先检查余额；余额不足会直接拒绝。",
        "默认带 2 小时 TTL 兜底自动关机——长任务请显式加大 ttl，不要关闭它。",
        "官方 API 没有库存查询接口，无货时会返回 NO_STOCK，换 GPU 规格或地区重试即可。",
      ].join("\n"),
      inputSchema: {
        gpu: z.string().describe("GPU 规格，如 4090 / pro6000-p，用 autodl_list_gpu_specs 查看"),
        gpu_num: z.number().int().min(1).max(4).optional().describe("GPU 数量 1-4，默认 1"),
        image: z.string().optional().describe("镜像 UUID，默认 PyTorch 2.0 / CUDA 11.8"),
        regions: z.array(z.string()).optional().describe("优先地区代码列表"),
        disk_gb: z.number().int().min(0).max(500).optional().describe("系统盘扩容 GB，默认 0"),
        name: z.string().optional().describe("实例名称"),
        ttl: z.string().optional().describe("到期自动关机时长，如 2h / 90m，默认 2h"),
        wait: z.boolean().optional().describe("是否等待实例进入 running，默认 true"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    tool(
      async (input: {
        gpu: string;
        gpu_num?: number;
        image?: string;
        regions?: string[];
        disk_gb?: number;
        name?: string;
        ttl?: string;
        wait?: boolean;
      }) => {
        const spec = resolveGpuSpec(input.gpu);
        if (!spec) {
          throw new UsageError(`未知的 GPU 规格 "${input.gpu}"`, {
            hint: "调用 autodl_list_gpu_specs 查看全部可用规格。",
          });
        }
        const image = findBaseImage(input.image ?? DEFAULT_BASE_IMAGE);
        const imageUuid = image?.uuid ?? input.image ?? DEFAULT_BASE_IMAGE;
        const regions = (input.regions ?? []).map((value) => {
          const region = resolveRegion(value);
          if (!region) throw new UsageError(`未知的地区 "${value}"`);
          return region.id;
        });
        const ttlSeconds = parseDuration(input.ttl ?? DEFAULT_MCP_TTL);

        await assertBudget(client);

        const startCommand = composeStartCommand(ttlSeconds, undefined);
        const uuid = await createInstance(client, {
          gpuSpec: spec.id,
          gpuNum: input.gpu_num ?? 1,
          imageUuid,
          cudaFrom: parseCudaVersion(image?.cuda ?? "11.8"),
          expandSystemDiskGb: input.disk_gb ?? 0,
          ...(regions.length ? { regions } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(startCommand ? { startCommand } : {}),
        });
        recordTTL({
          uuid,
          ...(input.name ? { name: input.name } : {}),
          ttlSeconds,
          inInstanceTimer: true,
        });

        let status = "creating";
        if (input.wait !== false) status = await waitForRunning(client, uuid);

        return {
          instance_uuid: uuid,
          status,
          gpu_spec: spec.id,
          gpu_num: input.gpu_num ?? 1,
          image_uuid: imageUuid,
          ttl_seconds: ttlSeconds,
          note: `实例将在 ${input.ttl ?? DEFAULT_MCP_TTL} 后自动关机。用完请尽快调用 autodl_power_off 停止计费。`,
        };
      },
    ),
  );

  server.registerTool(
    "autodl_power_on",
    {
      title: "开机",
      description: "启动一台已关机的实例，并可选等待其就绪。开机后 SSH 端口和密码会变化。",
      inputSchema: {
        instance_uuid: z.string(),
        ttl: z.string().optional().describe("开机后设置的自动关机时长，默认 2h"),
        wait: z.boolean().optional().describe("是否等待 running，默认 true"),
      },
    },
    tool(async (input: { instance_uuid: string; ttl?: string; wait?: boolean }) => {
      const ttlSeconds = parseDuration(input.ttl ?? DEFAULT_MCP_TTL);
      await powerOnInstance(client, input.instance_uuid, {
        startCommand: composeStartCommand(ttlSeconds, undefined) as string,
      });

      let status = "starting";
      let armed = false;
      if (input.wait !== false) {
        status = await waitForRunning(client, input.instance_uuid);
        // A warm container skips start_command, so re-arm over SSH to be sure.
        armed = await armTTLOverSSH(client, input.instance_uuid, ttlSeconds);
        recordTTL({ uuid: input.instance_uuid, ttlSeconds, inInstanceTimer: armed });
      }
      return {
        instance_uuid: input.instance_uuid,
        status,
        ttl_seconds: ttlSeconds,
        ttl_armed: armed,
      };
    }),
  );

  server.registerTool(
    "autodl_power_off",
    {
      title: "关机",
      description: "关闭实例，立即停止计费。数据全部保留，随时可以再次开机。",
      inputSchema: { instance_uuid: z.string() },
    },
    tool(async ({ instance_uuid }: { instance_uuid: string }) => {
      await powerOffInstance(client, instance_uuid);
      untrackInstance(instance_uuid);
      return { instance_uuid, stopped: true };
    }),
  );

  server.registerTool(
    "autodl_release_instance",
    {
      title: "释放实例（不可逆）",
      description:
        "永久释放实例，所有数据会被清空且无法恢复。必须先关机。需要显式传 confirm=true 才会执行。",
      inputSchema: {
        instance_uuid: z.string(),
        confirm: z.boolean().describe("必须显式传 true，确认理解数据将被永久清空"),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ instance_uuid, confirm }: { instance_uuid: string; confirm: boolean }) => {
      if (confirm !== true) {
        throw new UsageError("释放实例是不可逆操作，必须显式传 confirm=true", {
          hint: "确认要永久删除该实例的全部数据后，再带 confirm: true 重新调用。",
        });
      }
      const status = await getInstanceStatus(client, instance_uuid);
      if (status !== "shutdown") {
        await powerOffInstance(client, instance_uuid);
      }
      await releaseInstance(client, instance_uuid);
      untrackInstance(instance_uuid);
      return { instance_uuid, released: true };
    }),
  );

  server.registerTool(
    "autodl_exec",
    {
      title: "在实例上执行命令",
      description:
        "通过 SSH 在实例上执行 shell 命令，返回 stdout / stderr / 退出码。每次都会重新获取 SSH 凭证，因此实例重启后依然可用。",
      inputSchema: {
        instance_uuid: z.string(),
        command: z.string().describe("要执行的 shell 命令"),
        cwd: z.string().optional().describe("远程工作目录"),
        timeout: z.string().optional().describe("超时时间，如 30m，默认 30m"),
        start_if_stopped: z.boolean().optional().describe("实例未运行时是否自动开机，默认 false"),
      },
    },
    tool(
      async (input: {
        instance_uuid: string;
        command: string;
        cwd?: string;
        timeout?: string;
        start_if_stopped?: boolean;
      }) => {
        const result = await execCommand(client, input.instance_uuid, input.command, {
          capture: true,
          autoStart: input.start_if_stopped ?? false,
          timeoutMs: parseDuration(input.timeout ?? "30m") * 1000,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        return {
          instance_uuid: input.instance_uuid,
          exit_code: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    ),
  );

  server.registerTool(
    "autodl_upload",
    {
      title: "上传文件到实例",
      description: "通过 SFTP 上传本地文件或目录到实例。目录会自动跳过 .git / node_modules 等。",
      inputSchema: {
        instance_uuid: z.string(),
        local_path: z.string().describe("本地文件或目录路径"),
        remote_path: z.string().optional().describe("远程目标路径，默认 /root/autodl-cli"),
      },
    },
    tool(async (input: { instance_uuid: string; local_path: string; remote_path?: string }) => {
      const remote = input.remote_path ?? "/root/autodl-cli";
      const summary = await push(client, input.instance_uuid, input.local_path, remote);
      return { instance_uuid: input.instance_uuid, remote_path: remote, ...summary };
    }),
  );

  server.registerTool(
    "autodl_download",
    {
      title: "从实例下载文件",
      description: "通过 SFTP 把实例上的文件或目录下载到本地。",
      inputSchema: {
        instance_uuid: z.string(),
        remote_path: z.string(),
        local_path: z.string().optional().describe("本地目标目录，默认 ./autodl-output"),
      },
    },
    tool(async (input: { instance_uuid: string; remote_path: string; local_path?: string }) => {
      const local = input.local_path ?? "./autodl-output";
      const summary = await pull(client, input.instance_uuid, input.remote_path, local);
      return { instance_uuid: input.instance_uuid, local_path: local, ...summary };
    }),
  );

  server.registerTool(
    "autodl_run",
    {
      title: "一键跑任务",
      description: [
        "端到端工作流：创建实例 → 等待就绪 → 上传代码 → 远程执行 → 回传产物 → 自动关机。",
        "适合“跑一次就走”的任务，无需自己编排生命周期，也不会忘记关机。",
        "注意：这个调用会阻塞到任务结束，请为 ttl 和 timeout 留足余量。",
      ].join("\n"),
      inputSchema: {
        command: z.string().describe("要在实例上执行的命令"),
        gpu: z.string().describe("GPU 规格"),
        gpu_num: z.number().int().min(1).max(4).optional(),
        image: z.string().optional(),
        regions: z.array(z.string()).optional(),
        sync: z.string().optional().describe("执行前上传的本地目录"),
        workdir: z.string().optional().describe("远程工作目录，默认 /root/autodl-cli"),
        pull_from: z.string().optional().describe("执行后回传的远程路径"),
        pull_to: z.string().optional().describe("回传产物的本地目录"),
        ttl: z.string().optional().describe("兜底自动关机时长，默认 4h"),
        timeout: z.string().optional().describe("远程命令超时时间"),
        on_finish: z
          .enum(["poweroff", "release", "keep"])
          .optional()
          .describe("结束后动作，默认 poweroff"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    tool(
      async (input: {
        command: string;
        gpu: string;
        gpu_num?: number;
        image?: string;
        regions?: string[];
        sync?: string;
        workdir?: string;
        pull_from?: string;
        pull_to?: string;
        ttl?: string;
        timeout?: string;
        on_finish?: "poweroff" | "release" | "keep";
      }) => {
        const result = await runWorkflow(client, {
          command: input.command,
          gpu: input.gpu,
          ...(input.gpu_num !== undefined ? { gpuNum: input.gpu_num } : {}),
          ...(input.image ? { image: input.image } : {}),
          ...(input.regions ? { regions: input.regions } : {}),
          ...(input.sync ? { sync: input.sync } : {}),
          ...(input.workdir ? { workdir: input.workdir } : {}),
          ...(input.pull_from ? { pullFrom: input.pull_from } : {}),
          ...(input.pull_to ? { pullTo: input.pull_to } : {}),
          ttlSeconds: parseDuration(input.ttl ?? "4h"),
          ...(input.timeout ? { commandTimeoutMs: parseDuration(input.timeout) * 1000 } : {}),
          onFinish: input.on_finish ?? "poweroff",
        });
        return {
          instance_uuid: result.instanceUuid,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          final_action: result.finalAction,
          duration_ms: result.durationMs,
        };
      },
    ),
  );

  server.registerTool(
    "autodl_list_gpu_specs",
    {
      title: "列出可用 GPU 规格",
      description:
        "列出官方开放 API 支持的全部 GPU 规格。注意官方没有库存接口，有货与否只能创建时才知道。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(async () => ({ gpu_specs: GPU_SPECS, regions: REGIONS })),
  );

  server.registerTool(
    "autodl_list_images",
    {
      title: "列出镜像",
      description: "列出官方公共基础镜像，或账号下的私有镜像。",
      inputSchema: {
        kind: z.enum(["base", "private"]).optional().describe("默认 base（公共基础镜像）"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ kind }: { kind?: "base" | "private" }) => {
      if (kind === "private") {
        const { images } = await listPrivateImages(client, { pageSize: 100 });
        return { kind: "private", images };
      }
      return { kind: "base", images: BASE_IMAGES };
    }),
  );

  server.registerTool(
    "autodl_save_image",
    {
      title: "保存实例为私有镜像",
      description:
        "把实例当前状态保存成可复用的私有镜像。保存过程需要一段时间，之后用 autodl_list_images 查状态。",
      inputSchema: { instance_uuid: z.string(), image_name: z.string() },
    },
    tool(async ({ instance_uuid, image_name }: { instance_uuid: string; image_name: string }) => ({
      instance_uuid,
      image_uuid: await saveImage(client, instance_uuid, image_name),
    })),
  );

  server.registerTool(
    "autodl_sweep_expired",
    {
      title: "清理超时实例",
      description: "关闭本机记录中所有已超过 TTL 但仍在运行的实例。用于收尾兜底。",
      inputSchema: {},
    },
    tool(async () => sweepExpired(client)),
  );

  server.registerResource(
    "instances",
    "autodl://instances",
    {
      title: "AutoDL 实例列表",
      description: "当前账号下所有实例的实时快照（JSON）。",
      mimeType: "application/json",
    },
    async (uri) => {
      const instances = await listAllInstances(client);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(instances, null, 2) },
        ],
      };
    },
  );

  return server;
}

/** Start the stdio MCP server. Blocks until the transport closes. */
export async function startMcpServer(
  options: { token?: string; baseUrl?: string } = {},
): Promise<void> {
  // stdout belongs to the MCP protocol here — force every human-facing write to stderr.
  const context = createContext({
    ...(options.token ? { token: options.token } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    json: true,
    sweep: false,
  });

  const server = buildServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
