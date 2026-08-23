import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { resolveBaseUrl, tryResolveToken, updateConfig } from "../config/store.js";
import { parseCudaVersion } from "../core/catalog.js";
import { AutoDLClient } from "../core/client.js";
import { getBalance } from "../core/endpoints/account.js";
import { createInstance } from "../core/endpoints/instance.js";
import type { StockSnapshot } from "../core/stock.js";
import { getStockByRegion } from "../core/stock.js";
import { composeStartCommand, recordTTL } from "../guard/ttl.js";
import { configureOutput, isJson, isVerbose } from "../output/format.js";
import { Confirm } from "./components/confirm.js";
import { Logo } from "./components/logo.js";
import { StatusBar } from "./components/statusbar.js";
import {
  type DashboardRow,
  destroyInstance,
  startInstance,
  stopInstance,
  useInstances,
} from "./data.js";
import { type CreateDraft, CreateWizard, equivalentCommand } from "./screens/create.js";
import { Dashboard } from "./screens/dashboard.js";
import { Detail } from "./screens/detail.js";
import { Login } from "./screens/login.js";
import { StockScreen, toStockRows } from "./screens/stock.js";

type View = "dashboard" | "detail" | "stock" | "create" | "help";

const SCREEN_TITLES: Record<View, string> = {
  dashboard: "实例看板",
  detail: "实例详情",
  stock: "GPU 库存",
  create: "新建实例",
  help: "快捷键",
};
type Pending = { kind: "release"; row: DashboardRow } | null;

const DASHBOARD_KEYS =
  "↑↓ 移动 · Enter 详情 · s 开机 · x 关机 · c 显示SSH · Ctrl+D 释放 · g 库存 · n 新建 · r 刷新 · ? 帮助 · q 退出";

export function App({ client }: { client: AutoDLClient }): React.ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<View>("dashboard");
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [stock, setStock] = useState<StockSnapshot[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockIndex, setStockIndex] = useState(0);

  // Polling pauses whenever a modal owns the screen, so a refresh can't reorder rows
  // under a confirmation the user is reading.
  const paused = view === "create" || pending !== null;
  const { rows, loading, error, lastUpdated, refresh, snapshotFor, loadSnapshot } = useInstances(
    client,
    { paused },
  );

  const row = rows[Math.min(selected, Math.max(0, rows.length - 1))];

  // Rates come only from a running instance's snapshot; fetch just the selected one
  // rather than N snapshots per poll.
  useEffect(() => {
    if (row && row.instance.status === "running" && !snapshotFor(row.instance.uuid)) {
      loadSnapshot(row.instance.uuid);
    }
  }, [row, snapshotFor, loadSnapshot]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 6000);
  }, []);

  const act = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(true);
      setNotice(`${label}…`);
      try {
        flash(await fn());
      } catch (err) {
        flash(`✖ ${label}失败：${(err as Error).message}`);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [flash, refresh],
  );

  const loadStock = useCallback(async () => {
    setStockLoading(true);
    try {
      const { snapshots } = await getStockByRegion(client);
      setStock(snapshots);
    } catch (err) {
      flash(`✖ 库存查询失败：${(err as Error).message}`);
    } finally {
      setStockLoading(false);
    }
  }, [client, flash]);

  const submitCreate = useCallback(
    async (draft: CreateDraft) => {
      setBusy(true);
      try {
        const uuid = await createInstance(client, {
          gpuSpec: draft.spec.id,
          gpuNum: 1,
          imageUuid: draft.imageUuid,
          cudaFrom: parseCudaVersion("11.8"),
          expandSystemDiskGb: 0,
          startCommand: composeStartCommand(draft.ttlSeconds, undefined) as string,
        });
        recordTTL({ uuid, ttlSeconds: draft.ttlSeconds, inInstanceTimer: true });
        setView("dashboard");
        flash(`✔ 已创建 ${uuid}　等价命令：${equivalentCommand(draft)}`);
      } catch (err) {
        flash(`✖ 创建失败：${(err as Error).message}`);
        setView("dashboard");
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, flash, refresh],
  );

  useInput(
    (input, key) => {
      if (busy && view !== "dashboard") return;

      if (view === "help") {
        setView("dashboard");
        return;
      }
      if (view === "detail" || view === "stock") {
        if (key.escape || input === "q") return setView("dashboard");
      }

      if (view === "stock") {
        const max = toStockRows(stock, false).length;
        if (key.upArrow || input === "k") return setStockIndex((v) => Math.max(0, v - 1));
        if (key.downArrow || input === "j") return setStockIndex((v) => Math.min(max - 1, v + 1));
        if (input === "r") return void loadStock();
        return;
      }

      if (view === "detail") {
        if (input === "p") return setReveal((v) => !v);
        return;
      }

      // Dashboard
      if (input === "q" || (key.ctrl && input === "c")) return exit();
      if (input === "?") return setView("help");
      if (key.upArrow || input === "k") return setSelected((v) => Math.max(0, v - 1));
      if (key.downArrow || input === "j")
        return setSelected((v) => Math.min(rows.length - 1, v + 1));
      if (input === "r") return refresh();
      if (input === "n") return setView("create");
      if (input === "g") {
        setView("stock");
        if (stock.length === 0) void loadStock();
        return;
      }
      if (!row) return;
      if (key.return) {
        setReveal(false);
        return setView("detail");
      }
      if (input === "s") {
        return void act("开机", async () => {
          await startInstance(client, row.instance.uuid);
          return `✔ ${row.instance.uuid} 开机指令已发送`;
        });
      }
      if (input === "x") {
        return void act("关机", async () => {
          // Verified rather than assumed: power_off on a still-starting instance was
          // measured not to take effect, and a false "stopped" costs real money.
          const { stopped, status } = await stopInstance(client, row.instance.uuid);
          return stopped
            ? `✔ ${row.instance.uuid} 已关机，计费已停止`
            : `⚠ 关机未生效，状态仍为 ${status}，请稍后重试`;
        });
      }
      if (input === "c") {
        const snapshot = snapshotFor(row.instance.uuid);
        if (!snapshot?.ssh.host || !snapshot.ssh.port) {
          return flash("实例未运行或 SSH 信息尚未就绪");
        }
        return flash(
          `${snapshot.ssh.command ?? `ssh -p ${snapshot.ssh.port} root@${snapshot.ssh.host}`}　密码 ${snapshot.ssh.password}`,
        );
      }
      if (key.ctrl && input === "d") return setPending({ kind: "release", row });
    },
    { isActive: view !== "create" && pending === null },
  );

  return (
    <Box flexDirection="column" paddingY={1}>
      <Logo subtitle={SCREEN_TITLES[view]} />

      {pending ? (
        <Confirm
          title={`释放实例 ${pending.row.instance.name || pending.row.instance.uuid}？`}
          detail="会先关机并等待关机完成，然后释放。"
          danger="不可逆：实例的所有数据将被永久清空。"
          confirmLabel="释放"
          onConfirm={() => {
            const target = pending.row;
            setPending(null);
            void act("释放", async () => {
              await destroyInstance(client, target.instance.uuid);
              return `✔ ${target.instance.uuid} 已释放`;
            });
          }}
          onCancel={() => setPending(null)}
        />
      ) : view === "create" ? (
        <CreateWizard busy={busy} onSubmit={submitCreate} onCancel={() => setView("dashboard")} />
      ) : view === "detail" && row ? (
        <Detail row={row} snapshot={snapshotFor(row.instance.uuid)} revealSecrets={reveal} />
      ) : view === "stock" ? (
        <StockScreen
          rows={toStockRows(stock, false)}
          selectedIndex={stockIndex}
          loading={stockLoading}
        />
      ) : view === "help" ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>快捷键</Text>
          <Text>{DASHBOARD_KEYS.split(" · ").join("\n")}</Text>
          <Text dimColor>按任意键返回</Text>
        </Box>
      ) : (
        <Dashboard rows={rows} selectedIndex={selected} loading={loading} />
      )}

      <StatusBar
        rows={rows}
        error={error}
        notice={notice}
        lastUpdated={lastUpdated}
        hints={
          view === "dashboard"
            ? DASHBOARD_KEYS
            : view === "detail"
              ? "p 显示/隐藏密码 · Esc 返回"
              : view === "stock"
                ? "↑↓ 移动 · r 刷新 · Esc 返回"
                : ""
        }
      />
    </Box>
  );
}

/**
 * Gate the dashboard behind a token, obtaining one if needed.
 *
 * Entering the TUI is now the default for a bare `autodl`, so it has to work on a
 * machine that has never been configured: no token means a login screen, not an error.
 * A token already in place goes straight through.
 */
function Root({ globals }: { globals: TuiGlobals }): React.ReactElement {
  const { exit } = useApp();
  const [client, setClient] = useState<AutoDLClient | null>(() => {
    const resolved = tryResolveToken(globals.token);
    if (!resolved) return null;
    return new AutoDLClient({
      token: resolved.token,
      ...(resolveBaseUrl(globals.baseUrl) ? { baseUrl: resolveBaseUrl(globals.baseUrl) } : {}),
    });
  });
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const submit = useCallback(
    (token: string) => {
      setVerifying(true);
      setError(null);
      const baseUrl = resolveBaseUrl(globals.baseUrl);
      const candidate = new AutoDLClient({ token, ...(baseUrl ? { baseUrl } : {}) });
      // Verify before persisting — writing a dead token just moves the failure later,
      // exactly as `autodl login` does.
      getBalance(candidate)
        .then(() => {
          updateConfig({ token });
          setClient(candidate);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setVerifying(false));
    },
    [globals.baseUrl],
  );

  if (!client) {
    return <Login onSubmit={submit} onQuit={exit} error={error} verifying={verifying} />;
  }
  return <App client={client} />;
}

export interface TuiGlobals {
  token?: string;
  baseUrl?: string;
}

/** Switch to the terminal's alternate screen: a private, fixed canvas. */
const ENTER_ALT_SCREEN = "\u001B[?1049h";
const LEAVE_ALT_SCREEN = "\u001B[?1049l";
const CLEAR = "\u001B[2J\u001B[H";

/**
 * Mount the TUI. Resolves when the user quits.
 *
 * Runs on the alternate screen buffer so the dashboard owns a fixed canvas rather than
 * scrolling below whatever was already on screen — and so quitting restores the
 * terminal exactly as it was, scrollback intact.
 *
 * Core helpers are silenced for the duration: they write to stderr, which would land
 * inside the rendered frame. Their messages reach the user through the status bar.
 */
export async function runTui(globals: TuiGlobals = {}): Promise<void> {
  const previous = { json: isJson(), verbose: isVerbose() };
  configureOutput({ quiet: true });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(LEAVE_ALT_SCREEN);
    configureOutput({ quiet: false, json: previous.json, verbose: previous.verbose });
  };

  // Cover the paths that bypass a normal unmount, or the user's shell is left on a
  // blank alternate screen with no prompt.
  process.once("exit", restore);
  process.once("SIGINT", restore);
  process.once("SIGTERM", restore);

  process.stdout.write(ENTER_ALT_SCREEN + CLEAR);
  try {
    const app = render(<Root globals={globals} />);
    await app.waitUntilExit();
  } finally {
    restore();
    process.off("exit", restore);
    process.off("SIGINT", restore);
    process.off("SIGTERM", restore);
  }
}
