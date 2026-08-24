import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearToken,
  configPath,
  resolveBaseUrl,
  type TokenResolution,
  tryResolveToken,
  updateConfig,
} from "../config/store.js";
import { parseCudaVersion } from "../core/catalog.js";
import { AutoDLClient } from "../core/client.js";
import { getBalance } from "../core/endpoints/account.js";
import { createInstance } from "../core/endpoints/instance.js";
import { isAuthError } from "../core/errors.js";
import type { Balance } from "../core/schemas.js";
import type { StockSnapshot } from "../core/stock.js";
import { getStockByRegion } from "../core/stock.js";
import { composeStartCommand, recordTTL } from "../guard/ttl.js";
import { configureOutput, isJson, isVerbose } from "../output/format.js";
import { identityFromToken, tokenOverrideNote } from "./account.js";
import { copyToClipboard } from "./clipboard.js";
import { Confirm } from "./components/confirm.js";
import { Header } from "./components/header.js";
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
import { SessionExpired } from "./screens/expired.js";
import { Login } from "./screens/login.js";
import { StockScreen, toStockRows } from "./screens/stock.js";
import { useTerminalSize } from "./useTerminalSize.js";

type View = "dashboard" | "detail" | "stock" | "create" | "help";

const SCREEN_TITLES: Record<View, string> = {
  dashboard: "实例看板",
  detail: "实例详情",
  stock: "GPU 库存",
  create: "新建实例",
  help: "快捷键",
};
type Pending = { kind: "release"; row: DashboardRow } | { kind: "logout" } | null;

const DASHBOARD_KEYS =
  "↑↓ 移动 · Enter 详情 · s 开机 · x 关机 · c 复制SSH · ctrl+d 释放 · g 库存 · n 新建 · r 刷新 · ctrl+l 退出登录 · ? 帮助 · q 退出";

/**
 * ctrl+<letter>, whatever the shift state.
 *
 * Terminals send the same control byte for ctrl+d and ctrl+shift+d, and Ink reports the
 * letter lowercased — the comparison is written case-insensitively anyway so the binding
 * cannot quietly depend on that. Hints are printed all-lowercase for the same reason: a
 * capital anywhere in the binding reads as "hold shift".
 */
const isCtrl = (input: string, key: { ctrl: boolean }, letter: string): boolean =>
  key.ctrl && input.toLowerCase() === letter;

/**
 * The same bindings, two columns.
 *
 * One per line overflowed a 24-row terminal once the list reached twelve — and Ink does
 * not scroll or complain, it just squeezes rows out of the frame, taking the last
 * bindings and a row of the wordmark with them.
 */
const HELP_COLUMNS = ((items: string[]) => {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
})(DASHBOARD_KEYS.split(" · "));

export function App({
  client,
  token,
  tokenSource,
  onLogout,
}: {
  client: AutoDLClient;
  token: string;
  /** Where this session's token came from, so logging out can say what it does not clear. */
  tokenSource: TokenResolution["source"];
  /** Drop back to the login screen. The reason is shown there. */
  onLogout: (reason?: string) => void;
}): React.ReactElement {
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
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  /** Non-null once the token has been rejected: the session is over, not merely erroring. */
  const [expired, setExpired] = useState<string | null>(null);
  const { columns, rows: terminalRows } = useTerminalSize();
  const identity = useMemo(() => identityFromToken(token), [token]);

  // Polling pauses whenever a modal owns the screen, so a refresh can't reorder rows
  // under a confirmation the user is reading.
  const paused = view === "create" || pending !== null || expired !== null;
  const { rows, loading, error, authError, lastUpdated, refresh, snapshotFor, loadSnapshot } =
    useInstances(client, { paused });

  // Any rejected token ends the session, whichever request happened to discover it.
  const noteAuthFailure = useCallback((err: unknown): void => {
    // First reason wins: a burst of parallel 401s should not rewrite the message the
    // user is already reading.
    if (isAuthError(err)) setExpired((current) => current ?? (err as Error).message);
  }, []);

  useEffect(() => {
    if (authError) setExpired((current) => current ?? authError);
  }, [authError]);

  const row = rows[Math.min(selected, Math.max(0, rows.length - 1))];

  // Rates come only from a running instance's snapshot; fetch just the selected one
  // rather than N snapshots per poll.
  useEffect(() => {
    if (row && row.instance.status === "running" && !snapshotFor(row.instance.uuid)) {
      loadSnapshot(row.instance.uuid);
    }
  }, [row, snapshotFor, loadSnapshot]);

  // Balance is the number that changes behaviour, so it refreshes on its own cadence —
  // slower than the instance list, since it moves far less often.
  useEffect(() => {
    if (expired) return;
    let cancelled = false;
    const load = () => {
      getBalance(client)
        .then((next) => {
          if (!cancelled) {
            setBalance(next);
            setBalanceError(null);
          }
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setBalanceError(err.message);
          noteAuthFailure(err);
        });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, expired, noteAuthFailure]);

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
        noteAuthFailure(err);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [flash, refresh, noteAuthFailure],
  );

  const loadStock = useCallback(async () => {
    setStockLoading(true);
    try {
      const { snapshots } = await getStockByRegion(client);
      setStock(snapshots);
    } catch (err) {
      flash(`✖ 库存查询失败：${(err as Error).message}`);
      noteAuthFailure(err);
    } finally {
      setStockLoading(false);
    }
  }, [client, flash, noteAuthFailure]);

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
        noteAuthFailure(err);
        setView("dashboard");
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, flash, refresh, noteAuthFailure],
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
      if (input === "q" || isCtrl(input, key, "c")) return exit();
      if (input === "?") return setView("help");
      if (key.upArrow || input === "k") return setSelected((v) => Math.max(0, v - 1));
      if (key.downArrow || input === "j")
        return setSelected((v) => Math.min(rows.length - 1, v + 1));
      if (input === "r") return refresh();
      if (input === "n") return setView("create");
      // ctrl-modified, and behind a confirmation: an accidental logout costs a re-paste
      // of a JWT nobody has memorised.
      if (isCtrl(input, key, "l")) return setPending({ kind: "logout" });
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
        const command =
          snapshot.ssh.command ?? `ssh -p ${snapshot.ssh.port} root@${snapshot.ssh.host}`;
        void copyToClipboard(command).then((result) => {
          // The password is shown but never copied: the clipboard is readable by any
          // process, and a root password does not belong there.
          flash(
            result.method === "native"
              ? `✔ 已复制：${command}　密码 ${snapshot.ssh.password}`
              : `${command}　密码 ${snapshot.ssh.password}　（${result.note}）`,
          );
        });
        return;
      }
      if (isCtrl(input, key, "d")) return setPending({ kind: "release", row });
    },
    { isActive: view !== "create" && pending === null && expired === null },
  );

  return (
    // Claim the entire terminal so the dashboard is a fixed full-screen surface rather
    // than a block that grows and shrinks with its content.
    <Box flexDirection="column" height={terminalRows} width={columns}>
      <Header
        subtitle={SCREEN_TITLES[view]}
        identity={identity}
        balance={balance}
        balanceError={balanceError}
        columns={columns}
      />

      {expired ? (
        <SessionExpired
          message={expired}
          onRelogin={() => onLogout("上一次会话的 Token 已失效，请重新登入。")}
          onQuit={exit}
        />
      ) : pending?.kind === "logout" ? (
        <Confirm
          title="退出登录？"
          detail={`会清除保存在 ${configPath()} 的 Token，并返回登入界面。实例不受影响，运行中的实例会继续计费。`}
          danger={tokenOverrideNote(tokenSource) ?? undefined}
          confirmLabel="退出登录"
          onConfirm={() => {
            setPending(null);
            onLogout();
          }}
          onCancel={() => setPending(null)}
        />
      ) : pending ? (
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
          <Box>
            {HELP_COLUMNS.map((column) => (
              <Box key={column[0]} flexDirection="column" width={22}>
                {column.map((item) => (
                  <Text key={item}>{item}</Text>
                ))}
              </Box>
            ))}
          </Box>
          <Text dimColor>按任意键返回</Text>
        </Box>
      ) : (
        <Dashboard rows={rows} selectedIndex={selected} loading={loading} />
      )}

      <Box flexGrow={1} />

      <StatusBar
        rows={rows}
        // The expired panel already carries the reason; repeating it as a status-bar
        // error would read as two separate failures.
        error={expired ? null : error}
        notice={notice}
        lastUpdated={lastUpdated}
        hints={
          expired
            ? "Enter 重新登入 · q 退出"
            : view === "dashboard"
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

interface Session {
  client: AutoDLClient;
  token: string;
  source: TokenResolution["source"];
}

/**
 * Own the session: obtain a token, hand it to the dashboard, take it back.
 *
 * Entering the TUI is the default for a bare `autodl`, so it has to work on a machine
 * that has never been configured: no token means a login screen, not an error. The same
 * screen is where the dashboard returns to on logout or once a token stops working, so
 * neither of those has to drop the user back to a shell.
 */
export function Root({ globals }: { globals: TuiGlobals }): React.ReactElement {
  const { exit } = useApp();
  const [session, setSession] = useState<Session | null>(() => {
    const resolved = tryResolveToken(globals.token);
    if (!resolved) return null;
    const baseUrl = resolveBaseUrl(globals.baseUrl);
    return {
      client: new AutoDLClient({ token: resolved.token, ...(baseUrl ? { baseUrl } : {}) }),
      token: resolved.token,
      source: resolved.source,
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
          setNotice(null);
          setSession({ client: candidate, token, source: "config" });
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setVerifying(false));
    },
    [globals.baseUrl],
  );

  const logout = useCallback(
    (reason?: string) => {
      // Same clearing `autodl logout` does, so "logged out" means the same thing
      // whichever surface the user reached for.
      clearToken();
      const override = session ? tokenOverrideNote(session.source) : null;
      setNotice([reason ?? "已退出登录，本地 Token 已清除。", override].filter(Boolean).join(" "));
      setError(null);
      setSession(null);
    },
    [session],
  );

  if (!session) {
    return (
      <Login onSubmit={submit} onQuit={exit} error={error} verifying={verifying} notice={notice} />
    );
  }
  return (
    // Keyed on the token so a re-login remounts: the previous session's instances,
    // balance and error state must not bleed into the new account's dashboard.
    <App
      key={session.token}
      client={session.client}
      token={session.token}
      tokenSource={session.source}
      onLogout={logout}
    />
  );
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
