import { createHash } from "node:crypto";
import type { Instance as InkInstance } from "ink";
import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearToken,
  configPath,
  resolveBaseUrl,
  resolveToken,
  type TokenResolution,
  tryResolveToken,
  updateConfig,
} from "../config/store.js";
import { findBaseImage, parseCudaVersion } from "../core/catalog.js";
import { AutoDLClient, DEFAULT_BASE_URL } from "../core/client.js";
import { getBalance } from "../core/endpoints/account.js";
import { createInstance, getInstanceStatus } from "../core/endpoints/instance.js";
import { isAuthError } from "../core/errors.js";
import type { Balance } from "../core/schemas.js";
import type { StockSnapshot } from "../core/stock.js";
import { getStockByRegion } from "../core/stock.js";
import { composeStartCommand, recordTTL } from "../guard/ttl.js";
import { configureOutput, isJson, isVerbose } from "../output/format.js";
import { getCredentials } from "../ssh/credentials.js";
import { FileWorkspace } from "../ssh/files.js";
import { connectTerminal } from "../ssh/terminal.js";
import { TransferQueue } from "../ssh/transfer-queue.js";
import { identityFromToken, tokenOverrideNote } from "./account.js";
import { copyToClipboard } from "./clipboard.js";
import { CONFIRM_KEYS, Confirm } from "./components/confirm.js";
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
import { FilesScreen, TransferJobs } from "./screens/files.js";
import { Login } from "./screens/login.js";
import { StockScreen, toStockRows } from "./screens/stock.js";
import { useTerminalSize } from "./useTerminalSize.js";

type View = "dashboard" | "detail" | "stock" | "create" | "help" | "files" | "transfers";

const SCREEN_TITLES: Record<View, string> = {
  dashboard: "实例看板",
  detail: "实例详情",
  stock: "GPU 库存",
  create: "新建实例",
  help: "快捷键",
  files: "文件管理",
  transfers: "传输队列",
};
type AccessAction =
  | { kind: "ssh"; uuid: string }
  | { kind: "files"; uuid: string }
  | { kind: "resume"; uuid: string; jobId: string };
type Pending =
  | { kind: "release"; row: DashboardRow }
  | { kind: "logout" }
  | { kind: "exit" }
  | { kind: "power"; action: AccessAction }
  | null;

const DASHBOARD_KEYS =
  "↑↓ 移动 · Enter 详情 · s 开机 · x 关机 · n 新建 · ctrl+d 释放 · g 库存 · r 刷新 · ctrl+l 退出登录 · ? 帮助 · q 退出";

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
  baseUrl,
}: {
  client: AutoDLClient;
  token: string;
  /** Where this session's token came from, so logging out can say what it does not clear. */
  tokenSource: TokenResolution["source"];
  /** Drop back to the login screen. The reason is shown there. */
  onLogout: (reason?: string) => void;
  baseUrl?: string;
}): React.ReactElement {
  const { exit, suspendTerminal } = useApp();
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
  const [terminalActive, setTerminalActive] = useState(false);
  const [workspace, setWorkspace] = useState<FileWorkspace | null>(null);
  const [fileUuid, setFileUuid] = useState("");
  const [fileGate, setFileGate] = useState<Promise<void> | undefined>(undefined);
  const queueRef = useRef<TransferQueue | null>(null);
  const accessController = useRef<AbortController | null>(null);
  /** A release waiting out its shutdown; quitting must stop that wait, not hang on it. */
  const releasing = useRef<{ uuid: string; controller: AbortController } | null>(null);
  const queueUnsubscribe = useRef<(() => void) | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const workspaceRef = useRef<FileWorkspace | null>(null);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  /**
   * The running instance whose snapshot the poll keeps fresh.
   *
   * Trails the selection by one render, because it has to be known before the hook that
   * produces the list the selection indexes into. Harmless: moving the cursor fetches
   * immediately (below), and the poll takes over from the next tick.
   */
  const [watched, setWatched] = useState<string | undefined>(undefined);
  const { columns, rows: terminalRows } = useTerminalSize();
  const identity = useMemo(() => identityFromToken(token), [token]);

  // Polling pauses whenever a modal owns the screen, so a refresh can't reorder rows
  // under a confirmation the user is reading.
  const paused = view === "create" || pending !== null || expired !== null || terminalActive;
  const {
    rows,
    loading,
    error,
    authError,
    lastUpdated,
    refresh,
    snapshotFor,
    historyFor,
    loadSnapshot,
  } = useInstances(client, { paused, watch: watched });

  // Any rejected token ends the session, whichever request happened to discover it.
  const noteAuthFailure = useCallback((err: unknown): void => {
    // First reason wins: a burst of parallel 401s should not rewrite the message the
    // user is already reading.
    if (isAuthError(err)) setExpired((current) => current ?? (err as Error).message);
  }, []);

  useEffect(() => {
    if (authError) setExpired((current) => current ?? authError);
  }, [authError]);

  // Clamped once and used for both the highlight and the actions. Clamping only the
  // lookup let the two disagree: release an instance while sitting on the last row and
  // the table highlighted nothing while `s`/`x` quietly operated on its neighbour.
  const selectedIndex = Math.min(selected, Math.max(0, rows.length - 1));
  const row = rows[selectedIndex];

  // A detail screen whose instance is gone renders the dashboard underneath the detail
  // title and the detail key hints. Leave rather than show that.
  useEffect(() => {
    if (view === "detail" && !row) setView("dashboard");
  }, [view, row]);

  const selectedUuid = row?.instance.uuid;
  const selectedRunning = row?.instance.status === "running";

  // The poll keeps the watched instance's snapshot fresh (see `watch` above), which is
  // what makes the resource panel a live view rather than one reading frozen at the
  // moment it was first opened. This covers the other case: moving the cursor, where
  // waiting out the rest of the interval would leave the panel blank.
  useEffect(() => {
    setWatched(selectedRunning ? selectedUuid : undefined);
    if (selectedUuid && selectedRunning) loadSnapshot(selectedUuid);
  }, [selectedUuid, selectedRunning, loadSnapshot]);

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

  /**
   * Show a message for six seconds.
   *
   * The timer is tracked so each message gets its own full six seconds — an untracked
   * one from an earlier action would fire mid-way through the next message and blank it
   * — and so quitting does not leave a pending timer holding the event loop open, which
   * kept the shell prompt away for up to six seconds after the TUI had already closed.
   * Late flashes are dropped for the same reason: an action that resolves after quit
   * would otherwise re-arm the loop with a timer nothing clears.
   */
  const noticeTimer = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(noticeTimer.current ?? undefined);
      noticeTimer.current = null;
    };
  }, []);
  const flash = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setNotice(message);
    clearTimeout(noticeTimer.current ?? undefined);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  const getQueue = useCallback(() => {
    if (!queueRef.current) {
      const account = [identity.tenant, identity.uid ?? identity.uuid ?? token];
      const namespace = createHash("sha256")
        .update(
          JSON.stringify([
            (baseUrl ?? resolveBaseUrl() ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
            account,
          ]),
        )
        .digest("hex");
      queueRef.current = new TransferQueue(client, namespace);
      const queue = queueRef.current;
      const updateNotice = () => {
        const jobs = queue.snapshot();
        const unfinished = jobs.filter(
          (job) => job.state !== "completed" && job.state !== "cancelled",
        );
        setQueueNotice(
          unfinished.length
            ? `传输 ${unfinished.length} 项未完成${jobs.some((job) => job.state === "conflict") ? " · 等待冲突处理" : ""} · t 查看队列`
            : null,
        );
      };
      queueUnsubscribe.current = queue.subscribe(updateNotice);
      updateNotice();
    }
    return queueRef.current;
  }, [client, baseUrl, identity, token]);

  useEffect(
    () => () => {
      accessController.current?.abort();
      releasing.current?.controller.abort();
      queueUnsubscribe.current?.();
      void queueRef.current?.dispose().catch((err: Error) => {
        process.stderr.write(`传输队列关闭失败：${err.message}\n`);
      });
      // FilesScreen never disposes: the workspace outlives its mounts, so App
      // releases it here. A ref avoids re-running this on every workspace swap.
      workspaceRef.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    if (expired) {
      void queueRef.current?.pauseAll().catch((err: Error) => flash(err.message));
    }
  }, [expired, flash]);

  const requestExit = useCallback(() => {
    accessController.current?.abort();
    if (queueRef.current?.hasPending() || releasing.current) setPending({ kind: "exit" });
    else exit();
  }, [exit]);
  const finishLogout = async (reason?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (queueRef.current) await queueRef.current.pauseAll();
      onLogout(reason);
    } catch (err) {
      flash((err as Error).message);
      setBusy(false);
    }
  };
  const finishExit = async () => {
    if (busy && !releasing.current) return;
    setBusy(true);
    try {
      // Stops the shutdown wait so the process can end; the power_off already took
      // effect, and nothing is released after the abort.
      releasing.current?.controller.abort();
      if (queueRef.current) await queueRef.current.pauseAll();
      exit();
    } catch (err) {
      flash((err as Error).message);
      setBusy(false);
    }
  };

  const act = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(true);
      // Drop any pending flash-clear first: it would otherwise blank this label
      // mid-operation (a release can run for minutes behind waitForShutdown).
      clearTimeout(noticeTimer.current ?? undefined);
      noticeTimer.current = null;
      setNotice(`${label}…`);
      try {
        flash(await fn());
      } catch (err) {
        // After quitting, an aborted action has nobody left to report to, and a
        // refresh would only start another request that keeps the process alive.
        if (!mountedRef.current) return;
        flash(`✖ ${label}失败：${(err as Error).message}`);
        noteAuthFailure(err);
      } finally {
        if (mountedRef.current) {
          setBusy(false);
          refresh();
        }
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
  const copySSH = useCallback(
    (uuid: string) => {
      const snapshot = snapshotFor(uuid);
      if (!snapshot?.ssh.host || !snapshot.ssh.port) {
        flash("实例未运行或 SSH 信息尚未就绪");
        return;
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
    },
    [flash, snapshotFor],
  );

  const performAccess = useCallback(
    async (action: AccessAction, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      if (action.kind === "files") {
        // App owns the workspace: FilesScreen must never dispose it, because the
        // same object is reused when a root modal unmounts the screen (power or
        // exit confirmation) and when `f` is pressed twice on one instance.
        // A fresh workspace per open also drops any half-connected session from
        // the previous visit instead of reusing it.
        setWorkspace((prev) => {
          prev?.dispose();
          return new FileWorkspace(client, action.uuid);
        });
        setFileUuid(action.uuid);
        // Throws on a corrupt queue dir; the files branch of requestAccess catches
        // it and flashes, before the view switches.
        getQueue();
        setView("files");
        if (signal) {
          // The power modal already verified the instance is up; the old rejected
          // gate must not keep gating the remote pane.
          setFileGate(Promise.resolve());
          return;
        }
        // No abort wiring on this path: open the view first, verify power in the
        // background, and let the remote pane wait on the outcome.
        const gate = (async () => {
          const status = await getInstanceStatus(client, action.uuid);
          if (status !== "running") {
            setPending({ kind: "power", action });
            throw new Error(`实例 ${action.uuid} 当前未运行，远程目录需开机后查看`);
          }
        })();
        gate.catch((err: Error) => {
          flash(err.message);
          noteAuthFailure(err);
        });
        const safe = gate.then(() => undefined);
        // The power modal unmounts FilesScreen, so nobody may be waiting on this
        // branch yet: a rejection with no handler faults the process (Node 22).
        safe.catch(() => undefined);
        setFileGate(safe);
        return;
      }
      if (action.kind === "resume") {
        getQueue().resume(action.jobId);
        return;
      }
      setTerminalActive(true);
      try {
        let code = 0;
        await suspendTerminal(async () => {
          process.stdout.write(LEAVE_ALT_SCREEN);
          try {
            code = await connectTerminal(client, action.uuid, signal ? { signal } : {});
          } finally {
            process.stdout.write(signal?.aborted ? LEAVE_ALT_SCREEN : ENTER_ALT_SCREEN + CLEAR);
          }
        });
        flash(`SSH 会话已结束（退出码 ${code}）`);
      } finally {
        setTerminalActive(false);
      }
    },
    [client, flash, getQueue, noteAuthFailure, suspendTerminal],
  );

  const requestAccess = useCallback(
    async (action: AccessAction) => {
      // Files open instantly: the view mounts with both panes in "读取中…" and
      // gates on a live instance from inside, so `f` never stalls on the API.
      // Everything else still gates here first.
      if (action.kind === "files") {
        if (busy) return;
        // getQueue throws on a corrupt queue dir; surface it like the `t` path
        // does instead of faulting the promise nobody awaits.
        try {
          await performAccess(action);
        } catch (err) {
          flash((err as Error).message);
          noteAuthFailure(err);
        }
        return;
      }
      if (busy) return;
      setBusy(true);
      const controller = new AbortController();
      accessController.current = controller;
      try {
        const status = await getInstanceStatus(client, action.uuid);
        if (controller.signal.aborted) return;
        if (status !== "running") {
          setPending({ kind: "power", action });
          return;
        }
        await performAccess(action, controller.signal);
      } catch (err) {
        flash((err as Error).message);
        noteAuthFailure(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, client, flash, noteAuthFailure, performAccess],
  );

  const resumeTransfer = useCallback(
    (jobId: string) => {
      const job = queueRef.current?.snapshot().find((entry) => entry.request.id === jobId);
      if (job) void requestAccess({ kind: "resume", uuid: job.request.uuid, jobId });
    },
    [requestAccess],
  );

  const submitCreate = useCallback(
    async (draft: CreateDraft) => {
      setBusy(true);
      try {
        // Derived from the image the wizard actually offered, exactly as `autodl create`
        // does. Hardcoding 11.8 shipped every instance with that floor no matter which
        // CUDA the chosen image advertised one screen earlier.
        const image = findBaseImage(draft.imageUuid);
        const startCommand = composeStartCommand(draft.ttlSeconds, undefined);
        const uuid = await createInstance(client, {
          gpuSpec: draft.spec.id,
          gpuNum: 1,
          imageUuid: draft.imageUuid,
          cudaFrom: parseCudaVersion(image?.cuda ?? "11.8"),
          expandSystemDiskGb: 0,
          ...(startCommand ? { startCommand } : {}),
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
      if (isCtrl(input, key, "c")) return requestExit();
      if (view === "files" || view === "transfers" || view === "create" || expired) return;
      // An action in flight blocks only the keys that would start another one (see the
      // `busy` guards below). It used to block every key on every screen but the
      // dashboard, which meant an unrelated start/stop trapped the user on the detail
      // screen — Esc included — until it finished.
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
        // Floored at 0: an empty list makes `max - 1` negative, and the cursor then had
        // to be walked back up from -1 before the first row would highlight.
        if (key.downArrow || input === "j")
          return setStockIndex((v) => Math.max(0, Math.min(max - 1, v + 1)));
        if (input === "r") return void loadStock();
        return;
      }

      if (view === "detail") {
        if (input === "p") return setReveal((v) => !v);
        if (input === "r") return refresh();
        if (!row) return;
        if (input === "h") return void requestAccess({ kind: "ssh", uuid: row.instance.uuid });
        if (input === "f") return void requestAccess({ kind: "files", uuid: row.instance.uuid });
        if (input === "c") return copySSH(row.instance.uuid);
        if (input === "t") {
          try {
            getQueue();
            setView("transfers");
          } catch (err) {
            flash((err as Error).message);
          }
          return;
        }
        if (input === "n") return setView("create");
        return;
      }

      // Dashboard
      if (input === "q") return requestExit();
      if (isCtrl(input, key, "c")) return;
      if (input === "?") return setView("help");
      if (key.upArrow || input === "k") return setSelected((v) => Math.max(0, v - 1));
      if (key.downArrow || input === "j")
        return setSelected((v) => Math.max(0, Math.min(rows.length - 1, v + 1)));
      if (input === "r") return refresh();
      // ctrl-modified, and behind a confirmation: an accidental logout costs a re-paste
      // of a JWT nobody has memorised.
      if (isCtrl(input, key, "l")) return setPending({ kind: "logout" });
      if (input === "g") {
        setView("stock");
        if (stock.length === 0) void loadStock();
        return;
      }
      // Before the empty guard: a fresh account has no rows, and `n` is the only
      // way out of the dashboard the empty state advertises.
      if (input === "n") return setView("create");
      if (!row) return;
      if (key.return) {
        setReveal(false);
        return setView("detail");
      }
      if (input === "s") {
        if (busy) return;
        return void act("开机", async () => {
          await startInstance(client, row.instance.uuid);
          return `✔ ${row.instance.uuid} 开机指令已发送`;
        });
      }
      if (input === "x") {
        if (busy) return;
        return void act("关机", async () => {
          // Verified rather than assumed: power_off on a still-starting instance was
          // measured not to take effect, and a false "stopped" costs real money.
          const { stopped, status } = await stopInstance(client, row.instance.uuid);
          return stopped
            ? `✔ ${row.instance.uuid} 已关机，计费已停止`
            : `⚠ 关机未生效，状态仍为 ${status}，请稍后重试`;
        });
      }
      if (isCtrl(input, key, "d")) {
        if (busy) return;
        return setPending({ kind: "release", row });
      }
    },
    {
      isActive: pending === null && !terminalActive,
    },
  );

  /**
   * What the bottom bar advertises — the keys of whoever owns the keyboard right now.
   *
   * The modal, the wizard and the help screen all take input away from the dashboard
   * (see `isActive` above), so keying this off `view` alone printed `s 开机 · ctrl+d
   * 释放 · q 退出` underneath a confirmation where `q` cancels and the rest do nothing.
   */
  const hints =
    expired && !pending
      ? "Enter 重新登入 · q 退出"
      : pending
        ? CONFIRM_KEYS
        : view === "files" || view === "transfers"
          ? "Esc 返回 · ctrl+c 退出（未完成任务先确认）"
          : view === "create"
            ? // Step-agnostic on purpose: the wizard's own line says what Enter does at this
              // step, and only Esc is true at every one of them.
              "Esc 取消"
            : view === "help"
              ? "按任意键返回"
              : view === "detail"
                ? "h SSH登录 · f 文件 · t 传输 · c 复制SSH · n 新建 · p 显示/隐藏密码 · Esc 返回"
                : view === "stock"
                  ? "↑↓ 移动 · r 刷新 · Esc 返回"
                  : DASHBOARD_KEYS;

  // Mirrors the render chain below: everything else takes the screen from the dashboard.
  const showsDashboard = !expired && !pending && view === "dashboard";
  const showsFiles = !expired && !pending && (view === "files" || view === "transfers");

  return (
    // Claim the entire terminal so the dashboard is a fixed full-screen surface rather
    // than a block that grows and shrinks with its content.
    <Box flexDirection="column" height={terminalRows} width={columns}>
      {showsFiles ? (
        <Box height={1} flexShrink={0}>
          <Text bold wrap="truncate">
            AutoDL · {SCREEN_TITLES[view]}
            {view === "files" ? ` · ${fileUuid}` : ""}
          </Text>
        </Box>
      ) : (
        <Header
          subtitle={SCREEN_TITLES[view]}
          identity={identity}
          balance={balance}
          balanceError={balanceError}
          columns={columns}
        />
      )}

      {expired && !pending ? (
        <SessionExpired
          message={expired}
          onRelogin={() => void finishLogout("上一次会话的 Token 已失效，请重新登入。")}
          onQuit={requestExit}
        />
      ) : pending?.kind === "logout" ? (
        <Confirm
          title="退出登录？"
          detail={`会先暂停未完成传输，清除保存在 ${configPath()} 的 Token，并返回登入界面。实例继续计费；传输记录保留，重新登录后可手动恢复。`}
          danger={tokenOverrideNote(tokenSource) ?? undefined}
          confirmLabel="退出登录"
          onConfirm={() => void finishLogout()}
          onCancel={() => setPending(null)}
        />
      ) : pending?.kind === "exit" ? (
        <Confirm
          title={releasing.current ? "中止释放并退出？" : "暂停传输并退出？"}
          detail={[
            releasing.current
              ? `实例 ${releasing.current.uuid} 已发出关机，正在等待关机完成后释放。退出会停止等待：实例会关机、不再计费，但不会被释放，之后可运行 autodl rm ${releasing.current.uuid}。`
              : null,
            queueRef.current?.hasPending()
              ? "当前和排队任务将暂停，保留续传数据。下次打开传输队列后可手动恢复；退出后不会后台传输。"
              : null,
          ]
            .filter(Boolean)
            .join("\n")}
          confirmLabel={releasing.current ? "中止并退出" : "暂停并退出"}
          onConfirm={() => void finishExit()}
          onCancel={() => setPending(null)}
        />
      ) : pending?.kind === "power" ? (
        <Confirm
          title={`启动实例 ${pending.action.uuid}？`}
          detail="实例尚未运行。确认后等待开机和 SSH 就绪，再继续刚才的操作。"
          danger="开机会产生实例费用。自动重连不会自动开机。"
          confirmLabel="开机并继续"
          onConfirm={() => {
            const action = pending.action;
            setPending(null);
            void act("开机并连接", async () => {
              const controller = new AbortController();
              accessController.current = controller;
              await getCredentials(client, action.uuid, {
                autoStart: true,
                signal: controller.signal,
              });
              await performAccess(action, controller.signal);
              return "操作已继续";
            });
          }}
          onCancel={() => setPending(null)}
        />
      ) : pending?.kind === "release" ? (
        <Confirm
          title={`释放实例 ${pending.row.instance.name || pending.row.instance.uuid}？`}
          detail="会先关机并等待关机完成，然后释放。"
          danger="不可逆：实例的所有数据将被永久清空。"
          confirmLabel="释放"
          onConfirm={() => {
            const target = pending.row;
            setPending(null);
            void act("释放", async () => {
              const controller = new AbortController();
              releasing.current = { uuid: target.instance.uuid, controller };
              try {
                await destroyInstance(client, target.instance.uuid, { signal: controller.signal });
              } finally {
                if (releasing.current?.controller === controller) releasing.current = null;
              }
              return `✔ ${target.instance.uuid} 已释放`;
            });
          }}
          onCancel={() => setPending(null)}
        />
      ) : view === "files" && workspace && queueRef.current ? (
        <FilesScreen
          workspace={workspace}
          queue={queueRef.current}
          uuid={fileUuid}
          width={columns}
          height={Math.max(6, terminalRows - 2)}
          onBack={() => setView("dashboard")}
          onResume={resumeTransfer}
          {...(fileGate ? { whenRunning: fileGate } : {})}
        />
      ) : view === "transfers" && queueRef.current ? (
        <TransferJobs
          queue={queueRef.current}
          width={columns}
          height={Math.max(6, terminalRows - 2)}
          onBack={() => setView("dashboard")}
          onResume={resumeTransfer}
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
        <Dashboard
          rows={rows}
          selectedIndex={selectedIndex}
          loading={loading}
          snapshot={selectedUuid ? snapshotFor(selectedUuid) : undefined}
          history={selectedUuid ? historyFor(selectedUuid) : undefined}
          balance={balance}
          width={columns}
          height={terminalRows}
        />
      )}

      {/* The dashboard fills the frame itself; anything else is a block that needs
          pushing up so the key hints stay pinned to the bottom. */}
      {showsDashboard || showsFiles ? null : <Box flexGrow={1} />}

      {showsFiles ? (
        <Box height={1} flexShrink={0}>
          <Text color="cyan" wrap="truncate">
            {notice ?? "ctrl+c 退出（未完成传输先确认）"}
          </Text>
        </Box>
      ) : (
        <StatusBar
          rows={rows}
          error={expired ? null : error}
          notice={notice ?? queueNotice}
          lastUpdated={lastUpdated}
          hints={hints}
        />
      )}
    </Box>
  );
}

interface Session {
  client: AutoDLClient;
  token: string;
  source: TokenResolution["source"];
  baseUrl: string;
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
      baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const submit = useCallback(
    async (token: string) => {
      setVerifying(true);
      setError(null);
      try {
        const baseUrl = resolveBaseUrl(globals.baseUrl);
        const candidate = new AutoDLClient({ token, ...(baseUrl ? { baseUrl } : {}) });
        // Verify the input before saving, then respect flag > env > saved config.
        await getBalance(candidate);
        updateConfig({ token });
        const resolved = resolveToken(globals.token);
        const client =
          resolved.token === token
            ? candidate
            : new AutoDLClient({
                token: resolved.token,
                ...(baseUrl ? { baseUrl } : {}),
              });
        // An expired override must not silently switch to the saved token's account.
        if (client !== candidate) await getBalance(client);
        setNotice(null);
        setSession({
          client,
          token: resolved.token,
          source: resolved.source,
          baseUrl: baseUrl ?? DEFAULT_BASE_URL,
        });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setVerifying(false);
      }
    },
    [globals.baseUrl, globals.token],
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
      baseUrl={session.baseUrl}
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
  let app: InkInstance | undefined;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(LEAVE_ALT_SCREEN);
    configureOutput({ quiet: false, json: previous.json, verbose: previous.verbose });
  };
  const stop = () => {
    app?.unmount();
    restore();
  };

  // Cover the paths that bypass a normal unmount, or the user's shell is left on a
  // blank alternate screen with no prompt.
  process.once("exit", restore);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.stdout.write(ENTER_ALT_SCREEN + CLEAR);
  try {
    app = render(<Root globals={globals} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
  } finally {
    restore();
    process.off("exit", restore);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
