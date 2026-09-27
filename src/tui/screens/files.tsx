import { basename, dirname, join, posix, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatBytes } from "../../output/format.js";
import type { FileEntry, FileSide } from "../../ssh/file-types.js";
import type { TransferJob, TransferQueueView } from "../../ssh/queue-types.js";
import { bar } from "../components/meters.js";
import { clip } from "../components/table.js";

/**
 * File browser + transfer queue screen.
 *
 * The parent owns the app frame (compact title, global footer, exit, power
 * gating) and hands this screen its box: everything rendered here fits strictly
 * inside the passed `width`/`height`. Keyboard ownership is also the parent's to
 * arbitrate — while this screen is mounted the dashboard-level bindings stay
 * inactive, so `q` here only ever walks back (never quits the app) and Ctrl+C is
 * ignored for the parent's global exit confirmation.
 *
 * Unmount safety: the parent unmounts this view while a root modal is up, so
 * every async completion (listings, mkdir/rename/remove, flash timers) is
 * guarded by a mounted flag plus a per-side generation counter. Stale listings
 * never overwrite a newer navigation, and nothing sets state after unmount.
 */

/** Structural workspace: the real FileWorkspace carries an extra `transfer`. */
export interface FileBrowserWorkspace {
  list(side: FileSide, path: string): Promise<FileEntry[]>;
  mkdir(side: FileSide, path: string): Promise<void>;
  rename(side: FileSide, from: string, to: string): Promise<void>;
  remove(side: FileSide, path: string): Promise<void>;
  dispose(): void;
}

export interface FilesScreenProps {
  workspace: FileBrowserWorkspace;
  queue: TransferQueueView;
  uuid: string;
  width: number;
  height: number;
  onBack: () => void;
  /**
   * Resume hook for power gating. When present it replaces `queue.resume`: the
   * parent checks the instance state and confirms power-on first. No automatic
   * power-on happens from this screen either way.
   */
  onResume?: (id: string) => void;
  /** Resolves once the instance is running; remote listing waits for it. */
  whenRunning?: Promise<void>;
}

export interface TransferJobsProps {
  queue: TransferQueueView;
  width: number;
  height: number;
  onBack: () => void;
  onResume?: (id: string) => void;
}

const REMOTE_HOME = "/root/autodl-tmp";

/** C0 controls, DEL, and C1 controls (U+0080–U+009F) never reach the screen or fields. */
function isVisibleCode(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return false;
  if (code >= 0x80 && code <= 0x9f) return false;
  return true;
}

/** Strip control characters so hostile file names cannot inject terminal escapes. */
function visible(input: string): string {
  let out = "";
  for (const char of input) {
    if (isVisibleCode(char.codePointAt(0) ?? 0)) out += char;
  }
  return out || "?";
}

function sanitizeInput(input: string): string {
  let out = "";
  for (const char of input) {
    if (isVisibleCode(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

const joinSide = (side: FileSide, dir: string, name: string): string =>
  side === "remote" ? posix.join(dir, name) : join(dir, name);
/**
 * Resolve typed input against the active pane, not the process/server cwd:
 * absolute input stays absolute, relative input anchors at the pane.
 */
function resolveSide(side: FileSide, base: string, value: string): string {
  return side === "remote" ? posix.resolve(base, value) : resolve(base, value);
}
const parentSide = (side: FileSide, p: string): string =>
  side === "remote" ? posix.dirname(p) : dirname(p);
const baseSide = (side: FileSide, p: string): string =>
  side === "remote" ? posix.basename(p) : basename(p);

function kindMark(kind: FileEntry["kind"]): string {
  if (kind === "directory") return "/";
  if (kind === "symlink") return "@";
  if (kind === "other") return "?";
  return "";
}

const directionText = (direction: "upload" | "download"): string =>
  direction === "upload" ? "上传" : "下载";

function jobStateText(state: TransferJob["state"]): string {
  switch (state) {
    case "queued":
      return "排队";
    case "running":
      return "传输中";
    case "conflict":
      return "待确认";
    case "paused":
      return "已暂停";
    case "completed":
      return "完成";
    case "cancelled":
      return "已取消";
  }
}

/** Re-render whenever the queue notifies; the snapshot itself is read on render. */
function useQueueJobs(queue: TransferQueueView): readonly TransferJob[] {
  const subscribe = useCallback((listener: () => void) => queue.subscribe(listener), [queue]);
  const snapshot = useCallback(() => queue.snapshot(), [queue]);
  return useSyncExternalStore(subscribe, snapshot);
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

interface Pane {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  cursor: number;
  checked: string[];
}

const emptyPane = (p: string): Pane => ({
  path: p,
  entries: [],
  loading: true,
  error: null,
  cursor: 0,
  checked: [],
});

type BrowserMode =
  | { name: "none" }
  | { name: "pathNav" }
  | { name: "mkdir" }
  | { name: "rename"; multi: boolean }
  | { name: "delete" }
  | { name: "transfer" }
  | { name: "pathTransfer"; field: number };

interface PendingTransfer {
  sources: string[];
  kinds: FileEntry["kind"][];
  direction: "upload" | "download";
  destDir: string;
}

interface PathForm {
  direction: "upload" | "download";
  source: string;
  dest: string;
  sync: boolean;
  checksum: boolean;
}

/**
 * Exact row budgets for the dialog box, including its two border rows.
 * Overestimates are absorbed by flexGrow; underestimates would clip the hints
 * footer, so every wrapped-text risk is removed by clipping instead.
 */
function dialogRows(mode: BrowserMode, selectionCount: number): number {
  switch (mode.name) {
    case "none":
      return 0;
    case "pathNav":
    case "mkdir":
    case "rename":
      return 4;
    case "delete":
      // Border (2) + title (1) + up to 3 paths + overflow line + buttons + hints.
      return 5 + Math.min(selectionCount, 3) + (selectionCount > 3 ? 1 : 0);
    case "transfer":
      return 6 + Math.min(selectionCount, 2);
    case "pathTransfer":
      // Header + direction + source + dest + two-line basis/toggles hint.
      return 7;
  }
}

type TimerHandle = number | NodeJS.Timeout | undefined;

function useFlash(): { notice: string | null; flash: (message: string) => void } {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<TimerHandle>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const flash = useCallback((message: string) => {
    if (!mounted.current) return;
    setNotice(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (mounted.current) setNotice(null);
    }, 6000);
  }, []);
  return { notice, flash };
}

// ---------------------------------------------------------------------------
// Queue body (shared by FilesScreen queue tab and TransferJobs)
// ---------------------------------------------------------------------------

interface QueueUi {
  jobs: readonly TransferJob[];
  cursor: number;
  setCursor: (fn: (v: number) => number) => void;
  showDetail: boolean;
  setShowDetail: (fn: (v: boolean) => boolean) => void;
  skippedOpen: boolean;
  setSkippedOpen: (fn: (v: boolean) => boolean) => void;
  skippedIndex: number;
  setSkippedIndex: (fn: (v: number) => number) => void;
  applyAll: boolean;
  setApplyAll: (fn: (v: boolean) => boolean) => void;
  resume: (id: string) => void;
  flash: (message: string) => void;
  width: number;
  listRows: number;
}

/**
 * One composed line per Text node, clipped as a whole to the content width so
 * nothing wraps to a second row on 40/80-col terminals. Every row costs exactly
 * one line, which is what makes detailRows exact. Lockstep across all queue
 * rows: sanitize, then CJK-aware clip, then truncate rendering.
 */
function fitLine(text: string, width: number): string {
  return clip(visible(text), Math.max(1, width));
}

/** First visible skipped row for a paged window of 3. */
function skippedPageStart(index: number): number {
  return Math.floor(Math.max(0, index) / 3) * 3;
}

/**
 * Rows the detail block occupies: header + dest + capped sources + extras.
 * The skipped browser replaces the single skipped-preview row with a paged list
 * (header + up to 3 paths + footer), and each of progress/conflict/result/error
 * stays one clipped line.
 */
function detailRows(
  job: TransferJob | undefined,
  show: boolean,
  skippedOpen: boolean,
  skippedIndex: number,
): number {
  if (!job || !show) return 0;
  let n = 2;
  n += Math.min(job.request.sources.length, 2) + (job.request.sources.length > 2 ? 1 : 0);
  if (job.progress) n += 2;
  if (job.state === "conflict" && job.conflict) n += 2;
  if (job.result) {
    n += 1;
    const total = job.result.skipped.length;
    if (total > 0) {
      if (!skippedOpen) {
        n += 1;
      } else {
        const clamped = Math.min(Math.max(0, skippedIndex), total - 1);
        n += Math.min(3, total - skippedPageStart(clamped)) + 2;
      }
    }
  }
  if (job.error) n += 1;
  return n;
}

function renderQueueBody(ui: QueueUi): React.ReactElement {
  const { jobs, cursor, listRows } = ui;
  const width = Math.max(20, ui.width);
  const rowWidth = Math.max(1, width - 2);
  const start = Math.max(0, Math.min(cursor, Math.max(0, jobs.length - listRows)));
  const shown = jobs.slice(start, start + listRows);
  return (
    <Box flexDirection="column">
      {jobs.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor wrap="truncate">
            {fitLine("队列为空。在浏览器按 u 将选中文件加入传输队列。", rowWidth)}
          </Text>
        </Box>
      ) : (
        shown.map((job, i) => {
          const index = start + i;
          const active = index === cursor;
          const req = job.request;
          const label = `${req.direction === "upload" ? "↑" : "↓"} ${req.sources.length}项 → ${req.destination}`;
          const pct =
            job.progress && job.progress.total > 0
              ? (job.progress.transferred / job.progress.total) * 100
              : job.state === "completed"
                ? 100
                : 0;
          const speed =
            job.state === "running" && job.progress
              ? ` ${formatBytes(job.progress.bytesPerSecond)}/s`
              : "";
          const row = `${active ? "›" : " "} ${label}  ${jobStateText(job.state)} ${Math.round(pct)}%${speed}${job.state === "conflict" ? " 待确认" : ""}${job.error ? " ✖" : ""}`;
          return (
            <Box key={job.request.id}>
              <Text color={active ? "green" : undefined} inverse={active} wrap="truncate">
                {fitLine(row, rowWidth)}
              </Text>
            </Box>
          );
        })
      )}
      <QueueDetail ui={ui} />
    </Box>
  );
}

/** Paged skipped-paths browser: every skipped entry is inspectable. */
function SkippedBrowser({
  ui,
  job,
  width,
}: {
  ui: QueueUi;
  job: TransferJob;
  width: number;
}): React.ReactElement | null {
  const skipped = job.result?.skipped;
  if (!skipped || skipped.length === 0) return null;
  if (!ui.skippedOpen) {
    return (
      <Text dimColor wrap="truncate">
        {fitLine(`跳过 ${skipped.length} 项 · v 查看全部`, width)}
      </Text>
    );
  }
  const total = skipped.length;
  const clamped = Math.min(ui.skippedIndex, Math.max(0, total - 1));
  const start = skippedPageStart(clamped);
  const shown = skipped.slice(start, start + 3);
  return (
    <>
      <Text bold wrap="truncate">
        {fitLine(`跳过 ${total} 项（${clamped + 1}/${total}）· ↑↓ 选择 · Esc 收起`, width)}
      </Text>
      {shown.map((entry, i) => {
        const absolute = start + i;
        const active = absolute === clamped;
        return (
          <Text key={`${absolute}`} dimColor={!active} inverse={active} wrap="truncate">
            {fitLine(`${active ? "›" : "·"} ${entry}`, width)}
          </Text>
        );
      })}
      <Text dimColor wrap="truncate">
        {fitLine(
          total > 3
            ? `第 ${Math.floor(start / 3) + 1}/${Math.ceil(total / 3)} 页 · Esc 收起跳过列表`
            : "Esc 收起跳过列表",
          width,
        )}
      </Text>
    </>
  );
}

function QueueDetail({ ui }: { ui: QueueUi }): React.ReactElement | null {
  const job = ui.jobs[Math.min(ui.cursor, Math.max(0, ui.jobs.length - 1))];
  if (!job || !ui.showDetail) return null;
  const req = job.request;
  const width = Math.max(20, ui.width - 4);
  const lines: React.ReactNode[] = [
    <Text key="h" bold wrap="truncate">
      {fitLine(
        `${directionText(req.direction)} · ${req.sources.length} 个来源${req.sync ? " · 同步" : ""}${req.checksum ? " · 哈希校验" : ""}`,
        width,
      )}
    </Text>,
    <Text key="d" dimColor wrap="truncate">
      {fitLine(`→ ${req.destination}`, width)}
    </Text>,
  ];
  for (const [i, source] of req.sources.slice(0, 2).entries()) {
    lines.push(
      <Text key={`s-${i}`} dimColor wrap="truncate">
        {fitLine(`· ${source}`, width)}
      </Text>,
    );
  }
  if (req.sources.length > 2) {
    lines.push(
      <Text key="more" dimColor wrap="truncate">
        {fitLine(`· …另 ${req.sources.length - 2} 个`, width)}
      </Text>,
    );
  }
  if (job.progress) {
    const p = job.progress;
    lines.push(
      <Text key="p" wrap="truncate">
        {fitLine(
          `${p.file} ${formatBytes(p.transferred)}/${formatBytes(p.total)} · ${p.filesDone}/${p.filesTotal} 文件 · ${formatBytes(p.bytesPerSecond)}/s`,
          width,
        )}
      </Text>,
    );
    lines.push(
      <Text key="b" wrap="truncate">
        {fitLine(
          bar(p.total > 0 ? (p.transferred / p.total) * 100 : 0, Math.min(30, width)),
          width,
        )}
      </Text>,
    );
  }
  if (job.state === "conflict" && job.conflict) {
    lines.push(
      <Text key="c" color="yellow" wrap="truncate">
        {fitLine(
          `冲突：${job.conflict.source} → ${job.conflict.destination} (${formatBytes(job.conflict.sourceSize)}/${formatBytes(job.conflict.destinationSize)})`,
          width,
        )}
      </Text>,
    );
    lines.push(
      <Text key="ck" color="yellow" wrap="truncate">
        {fitLine(
          `o 覆盖 · s 跳过 · b 保留两者 · a 应用于全部[${ui.applyAll ? "✓" : " "}] · 目标为选中任务`,
          width,
        )}
      </Text>,
    );
  }
  if (job.result) {
    lines.push(
      <Text key="r" color="green" wrap="truncate">
        {fitLine(
          `完成：${job.result.files} 文件 · ${formatBytes(job.result.bytes)}${job.result.skipped.length > 0 ? ` · 跳过 ${job.result.skipped.length} 项` : ""}`,
          width,
        )}
      </Text>,
    );
    lines.push(<SkippedBrowser key="skipped" ui={ui} job={job} width={width} />);
  }
  if (job.error) {
    lines.push(
      <Text key="e" color="red" wrap="truncate">
        {fitLine(`✖ ${job.error}`, width)}
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines}
    </Box>
  );
}

/**
 * Shared queue key handling. Returns true when the key was consumed.
 * Esc/q leave (close detail first, then back) — never exit the app.
 */
function handleQueueInput(
  input: string,
  key: { upArrow: boolean; downArrow: boolean; return: boolean; escape: boolean },
  ui: QueueUi,
  queue: TransferQueueView,
  onExit: () => void,
): boolean {
  const job = ui.jobs[Math.min(ui.cursor, Math.max(0, ui.jobs.length - 1))];
  const skippedTotal = ui.showDetail && !ui.skippedOpen ? (job?.result?.skipped.length ?? 0) : 0;
  if (ui.showDetail && ui.skippedOpen && job?.result) {
    const total = job.result.skipped.length;
    if (key.upArrow || input === "k") {
      ui.setSkippedIndex((v) => Math.max(0, v - 1));
      return true;
    }
    if (key.downArrow || input === "j") {
      ui.setSkippedIndex((v) => Math.max(0, Math.min(total - 1, v + 1)));
      return true;
    }
    if (input === "q" || key.escape || key.return || input === "v") {
      ui.setSkippedOpen(() => false);
      return true;
    }
    // Anything else (Q back to browser, r/c, conflicts) falls through to the
    // shared handling below so the open list never traps the user.
    return false;
  }
  if (key.upArrow || input === "k") {
    ui.setCursor((v) => Math.max(0, v - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    ui.setCursor((v) => Math.max(0, Math.min(ui.jobs.length - 1, v + 1)));
    return true;
  }
  if (key.return) {
    if (ui.showDetail) {
      ui.setShowDetail(() => false);
      ui.setSkippedOpen(() => false);
    } else {
      ui.setShowDetail(() => true);
    }
    return true;
  }
  if (input === "v" && ui.showDetail && skippedTotal > 0) {
    ui.setSkippedIndex(() => 0);
    ui.setSkippedOpen(() => true);
    return true;
  }
  if (input === "q" || key.escape) {
    if (ui.showDetail) {
      ui.setShowDetail(() => false);
      ui.setSkippedOpen(() => false);
    } else onExit();
    return true;
  }
  if (input === "r") {
    if (!job) {
      ui.flash("队列为空");
      return true;
    }
    if (job.state === "paused" || job.state === "cancelled") ui.resume(job.request.id);
    else ui.flash("只有已暂停/已取消的任务可以恢复");
    return true;
  }
  if (input === "c") {
    if (!job) {
      ui.flash("队列为空");
      return true;
    }
    if (
      job.state === "queued" ||
      job.state === "running" ||
      job.state === "paused" ||
      job.state === "conflict"
    ) {
      queue.cancel(job.request.id);
    } else ui.flash("已完成/已取消的任务无需取消");
    return true;
  }
  if (input === "a" && job && job.state === "conflict") {
    ui.setApplyAll((v) => !v);
    return true;
  }
  if ((input === "o" || input === "s" || input === "b") && job && job.state === "conflict") {
    queue.resolveConflict(job.request.id, {
      choice: input === "o" ? "overwrite" : input === "s" ? "skip" : "keep-both",
      applyToAll: ui.applyAll,
    });
    return true;
  }
  return false;
}

function queueHints(job: TransferJob | undefined, skippedOpen: boolean): string[] {
  const base = "↑↓/jk 选择 · Enter 详情 · r 恢复暂停/取消 · c 取消排队/传输";
  const skipped = job?.result && job.result.skipped.length > 0 ? " · 详情中按 v 查看跳过" : "";
  if (skippedOpen) {
    return [base, "跳过列表：↑↓ 选择 · Enter/Esc/q/v 收起"];
  }
  const second =
    job?.state === "conflict"
      ? "o 覆盖 · s 跳过 · b 保留两者 · a 应用于全部 · Esc/q 收起详情或返回"
      : "Esc/q 收起详情或返回 · 跳过列表中 ↑↓ 翻看 Esc 收起";
  return [`${base}${skipped}`, second];
}

// ---------------------------------------------------------------------------
// TransferJobs: queue-only view for the parent dashboard (t key)
// ---------------------------------------------------------------------------

export function TransferJobs({
  queue,
  width,
  height,
  onBack,
  onResume,
}: TransferJobsProps): React.ReactElement {
  const jobs = useQueueJobs(queue);
  const [cursor, setCursor] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [skippedIndex, setSkippedIndex] = useState(0);
  const [applyAll, setApplyAll] = useState(false);
  const { notice, flash } = useFlash();
  const resume = useCallback(
    (id: string) => (onResume ? onResume(id) : queue.resume(id)),
    [onResume, queue],
  );

  const clamped = Math.min(cursor, Math.max(0, jobs.length - 1));
  const selected = jobs[clamped];
  const selectedId = selected?.request.id;
  const previousSelectedId = useRef(selectedId);
  useEffect(() => {
    if (previousSelectedId.current === selectedId) return;
    previousSelectedId.current = selectedId;
    setSkippedOpen(false);
    setSkippedIndex(0);
  }, [selectedId]);
  // Title (1) + list + detail + notice + hints (2) = height.
  const listRows = Math.max(
    1,
    height - 3 - detailRows(selected, showDetail, skippedOpen, skippedIndex) - (notice ? 1 : 0),
  );
  const ui: QueueUi = {
    jobs,
    cursor: clamped,
    setCursor,
    showDetail,
    setShowDetail,
    skippedOpen,
    setSkippedOpen,
    skippedIndex,
    setSkippedIndex,
    applyAll,
    setApplyAll,
    resume,
    flash,
    width,
    listRows,
  };

  useInput((input, key) => {
    if (key.ctrl) return;
    handleQueueInput(input, key, ui, queue, onBack);
  });

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box paddingX={1}>
        <Text bold>传输队列</Text>
        <Text dimColor>
          　{jobs.length} 个任务（串行）
          {jobs.length > 0 ? ` · ${clamped + 1}/${jobs.length}` : ""}
        </Text>
      </Box>
      {renderQueueBody(ui)}
      <Box flexGrow={1} />
      {notice ? (
        <Box paddingX={1}>
          <Text color="cyan">{clip(visible(notice), Math.max(10, width - 2))}</Text>
        </Box>
      ) : null}
      {queueHints(selected, skippedOpen).map((hint) => (
        <Box key={hint} paddingX={1}>
          <Text dimColor wrap="truncate">
            {fitLine(hint, Math.max(10, width - 2))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// FilesScreen: dual-pane browser + queue tabs
// ---------------------------------------------------------------------------

export function FilesScreen({
  workspace,
  queue,
  uuid,
  width,
  height,
  onBack,
  onResume,
  whenRunning,
}: FilesScreenProps): React.ReactElement {
  const [tab, setTab] = useState<"browser" | "queue">("browser");
  const [panes, setPanes] = useState<{ local: Pane; remote: Pane }>(() => ({
    local: emptyPane(process.cwd()),
    remote: emptyPane(REMOTE_HOME),
  }));
  const [activeSide, setActiveSide] = useState<FileSide>("local");
  const [mode, setMode] = useState<BrowserMode>({ name: "none" });
  const [field, setField] = useState("");
  const [confirmYes, setConfirmYes] = useState(false);
  const [syncDefault, setSyncDefault] = useState(false);
  const [checksumDefault, setChecksumDefault] = useState(false);
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [pathForm, setPathForm] = useState<PathForm>({
    direction: "upload",
    source: "",
    dest: "",
    sync: false,
    checksum: false,
  });
  const [busy, setBusy] = useState(false);
  const { notice, flash } = useFlash();

  // Queue tab state (owned here so one useInput can serve both tabs).
  const jobs = useQueueJobs(queue);
  const [queueCursor, setQueueCursor] = useState(0);
  const [queueDetail, setQueueDetail] = useState(false);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [skippedIndex, setSkippedIndex] = useState(0);
  const [applyAll, setApplyAll] = useState(false);
  const resume = useCallback(
    (id: string) => (onResume ? onResume(id) : queue.resume(id)),
    [onResume, queue],
  );

  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      workspace.dispose();
    },
    [workspace],
  );
  const gen = useRef<{ local: number; remote: number }>({ local: 0, remote: 0 });
  const queueJobId = jobs[Math.min(queueCursor, Math.max(0, jobs.length - 1))]?.request.id;
  const previousQueueJobId = useRef(queueJobId);
  useEffect(() => {
    if (previousQueueJobId.current === queueJobId) return;
    previousQueueJobId.current = queueJobId;
    setSkippedOpen(false);
    setSkippedIndex(0);
  }, [queueJobId]);
  /** Current paths, so a slow op refreshes where the user is, not where they were. */
  const pathRef = useRef<{ local: string; remote: string }>({
    local: process.cwd(),
    remote: REMOTE_HOME,
  });
  useEffect(() => {
    pathRef.current = { local: panes.local.path, remote: panes.remote.path };
  });

  const loadPane = useCallback(
    (side: FileSide, nextPath: string) => {
      gen.current[side] += 1;
      const g = gen.current[side];
      if (side === "local") {
        setPanes((prev) => ({ ...prev, local: { ...emptyPane(nextPath), cursor: 0 } }));
      } else {
        setPanes((prev) => ({ ...prev, remote: { ...emptyPane(nextPath), cursor: 0 } }));
      }
      const run = () => {
        if (!mounted.current || gen.current[side] !== g) return;
        workspace
          .list(side, nextPath)
          .then((entries) => {
            if (!mounted.current || gen.current[side] !== g) return;
            const sorted = [...entries].sort((a, b) => {
              if (a.kind === "directory" && b.kind !== "directory") return -1;
              if (a.kind !== "directory" && b.kind === "directory") return 1;
              return a.name.localeCompare(b.name);
            });
            setPanes((prev) =>
              side === "local"
                ? { ...prev, local: { ...prev.local, entries: sorted, loading: false } }
                : { ...prev, remote: { ...prev.remote, entries: sorted, loading: false } },
            );
          })
          .catch((err: unknown) => {
            if (!mounted.current || gen.current[side] !== g) return;
            const message = (err as Error).message;
            setPanes((prev) =>
              side === "local"
                ? { ...prev, local: { ...prev.local, entries: [], loading: false, error: message } }
                : {
                    ...prev,
                    remote: { ...prev.remote, entries: [], loading: false, error: message },
                  },
            );
          });
      };
      // Local lists immediately; remote waits for the instance to be running so
      // the first paint never stalls behind the power check or SSH handshake.
      if (side === "remote" && whenRunning) {
        void whenRunning.then(
          () => run(),
          (err: unknown) => {
            if (!mounted.current || gen.current[side] !== g) return;
            const message = (err as Error).message;
            setPanes((prev) => ({
              ...prev,
              remote: { ...prev.remote, entries: [], loading: false, error: message },
            }));
          },
        );
        return;
      }
      run();
    },
    [workspace, whenRunning],
  );

  useEffect(() => {
    loadPane("local", process.cwd());
    loadPane("remote", REMOTE_HOME);
  }, [loadPane]);
  const completedJobs = useRef(
    new Set(jobs.filter((job) => job.state === "completed").map((job) => job.request.id)),
  );
  useEffect(() => {
    for (const job of jobs) {
      if (job.state !== "completed" || completedJobs.current.has(job.request.id)) continue;
      completedJobs.current.add(job.request.id);
      if (job.request.uuid !== uuid) continue;
      const side = job.request.direction === "upload" ? "remote" : "local";
      loadPane(side, pathRef.current[side]);
    }
  }, [jobs, loadPane, uuid]);

  const pane = panes[activeSide];
  const otherSide: FileSide = activeSide === "local" ? "remote" : "local";
  const cursorIndex = Math.min(pane.cursor, Math.max(0, pane.entries.length - 1));
  const cursorEntry = pane.entries[cursorIndex];

  const selection = useMemo((): FileEntry[] => {
    if (pane.checked.length > 0) return pane.entries.filter((e) => pane.checked.includes(e.path));
    return cursorEntry ? [cursorEntry] : [];
  }, [pane.checked, pane.entries, cursorEntry]);

  const setPaneCursor = useCallback((side: FileSide, fn: (v: number) => number) => {
    setPanes((prev) => {
      const current = prev[side];
      const next = fn(current.cursor);
      return side === "local"
        ? { ...prev, local: { ...current, cursor: next } }
        : { ...prev, remote: { ...current, cursor: next } };
    });
  }, []);

  const runOp = useCallback(
    async (label: string, fn: () => Promise<void>, side: FileSide) => {
      setBusy(true);
      try {
        await fn();
        if (!mounted.current) return;
        flash(`✔ ${label}`);
        loadPane(side, pathRef.current[side]);
      } catch (err) {
        if (!mounted.current) return;
        flash(`✖ ${label}失败：${(err as Error).message}`);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [flash, loadPane],
  );

  const doDelete = useCallback(() => {
    const targets = selection.map((e) => e.path);
    const side = activeSide;
    const count = targets.length;
    setMode({ name: "none" });
    setConfirmYes(false);
    void runOp(
      `已删除 ${count} 项`,
      async () => {
        const results = await Promise.allSettled(targets.map((t) => workspace.remove(side, t)));
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) throw new Error(`${failed.length}/${count} 项删除失败`);
      },
      side,
    );
  }, [selection, activeSide, runOp, workspace]);

  const openTransferConfirm = useCallback(() => {
    if (selection.length === 0) {
      flash("没有可传输的选中项");
      return;
    }
    setPending({
      sources: selection.map((e) => e.path),
      kinds: selection.map((e) => e.kind),
      direction: activeSide === "local" ? "upload" : "download",
      destDir: panes[otherSide].path,
    });
    setMode({ name: "transfer" });
  }, [selection, activeSide, panes, otherSide, flash]);

  const submitTransfer = useCallback(
    (sync: boolean, checksum: boolean) => {
      if (!pending) return;
      queue.enqueue({
        uuid,
        direction: pending.direction,
        sources: pending.sources,
        destination: pending.destDir,
        sync,
        checksum,
      });
      flash(`✔ 已加入队列：${pending.sources.length} 项，按 Q 查看`);
      setPending(null);
      setMode({ name: "none" });
    },
    [pending, queue, uuid, flash],
  );

  const submitPathForm = useCallback(() => {
    const rawSource = pathForm.source.trim();
    const rawDest = pathForm.dest.trim();
    if (!rawSource || !rawDest) {
      flash("来源和目标路径都不能为空");
      return;
    }
    // Resolve now so persistence never depends on a later process cwd: the
    // source lives on the direction's origin side, the destination on the
    // opposite side's current pane.
    const direction = pathForm.direction;
    const fromSide: FileSide = direction === "upload" ? "local" : "remote";
    const toSide: FileSide = direction === "upload" ? "remote" : "local";
    const source = resolveSide(fromSide, panes[fromSide].path, rawSource);
    const dest = resolveSide(toSide, panes[toSide].path, rawDest);
    queue.enqueue({
      uuid,
      direction,
      sources: [source],
      destination: dest,
      sync: pathForm.sync,
      checksum: pathForm.checksum,
    });
    flash("✔ 已加入队列，按 Q 查看");
    setMode({ name: "none" });
  }, [pathForm, panes, queue, uuid, flash]);

  const updatePaneChecked = useCallback((side: FileSide, fn: (checked: string[]) => string[]) => {
    setPanes((prev) => {
      const current = prev[side];
      const next = fn(current.checked);
      return side === "local"
        ? { ...prev, local: { ...current, checked: next } }
        : { ...prev, remote: { ...current, checked: next } };
    });
  }, []);

  useInput((input, key) => {
    // The parent's global Ctrl+C owns exit confirmation; never act on it here.
    if (key.ctrl) return;

    // An op in flight blocks everything except backing out: Esc/q close the
    // dialog (if any) or walk back, so a hanging request cannot trap the user.
    if (busy) {
      if (key.escape || input === "q") {
        if (tab === "queue") {
          if (queueDetail) {
            setQueueDetail(false);
            setSkippedOpen(false);
          } else setTab("browser");
        } else if (mode.name !== "none") {
          setMode({ name: "none" });
          setPending(null);
          setConfirmYes(false);
        } else onBack();
      }
      return;
    }

    // Queue tab owns its keys; Esc returns to the browser.
    if (tab === "queue") {
      const ui: QueueUi = {
        jobs,
        cursor: Math.min(queueCursor, Math.max(0, jobs.length - 1)),
        setCursor: setQueueCursor,
        showDetail: queueDetail,
        setShowDetail: setQueueDetail,
        skippedOpen,
        setSkippedOpen,
        skippedIndex,
        setSkippedIndex,
        applyAll,
        setApplyAll,
        resume,
        flash,
        width,
        listRows: 1,
      };
      if (handleQueueInput(input, key, ui, queue, () => setTab("browser"))) return;
      if (input === "Q") {
        setTab("browser");
        return;
      }
      return;
    }

    // ---- text-field modes: Esc cancels, q is ordinary text ----
    if (mode.name === "pathNav" || mode.name === "mkdir" || mode.name === "rename") {
      if (key.escape) {
        setMode({ name: "none" });
        return;
      }
      if (key.return) {
        const value = field.trim();
        if (mode.name === "pathNav") {
          if (value) loadPane(activeSide, resolveSide(activeSide, pane.path, value));
          setMode({ name: "none" });
        } else if (mode.name === "mkdir") {
          if (!value) {
            flash("目录名不能为空");
            return;
          }
          const target = resolveSide(activeSide, pane.path, value);
          setMode({ name: "none" });
          void runOp("已创建目录", () => workspace.mkdir(activeSide, target), activeSide);
        } else if (mode.name === "rename") {
          if (!value) {
            flash("目标路径不能为空");
            return;
          }
          const targets = selection;
          setMode({ name: "none" });
          if (mode.multi) {
            const destDir = resolveSide(activeSide, pane.path, value);
            void runOp(
              `已移动 ${targets.length} 项`,
              async () => {
                // Serial: every rename runs to completion and every failure is
                // reported exactly. Promise.all would reject early while the
                // remaining moves kept running behind a cleared busy flag.
                const failures: string[] = [];
                for (const t of targets) {
                  try {
                    await workspace.rename(
                      activeSide,
                      t.path,
                      joinSide(activeSide, destDir, baseSide(activeSide, t.path)),
                    );
                  } catch {
                    failures.push(t.path);
                  }
                }
                if (failures.length > 0) {
                  throw new Error(
                    `${failures.length}/${targets.length} 项移动失败：${failures[0]}`,
                  );
                }
              },
              activeSide,
            );
          } else {
            const first = targets[0];
            if (targets.length === 1 && first) {
              const from = first.path;
              void runOp(
                "已改名/移动",
                () => workspace.rename(activeSide, from, resolveSide(activeSide, pane.path, value)),
                activeSide,
              );
            }
          }
        }
        return;
      }
      if (key.backspace || key.delete) {
        setField((v) => v.slice(0, -1));
        return;
      }
      if (key.tab) return;
      const clean = sanitizeInput(input);
      if (clean) setField((v) => v + clean);
      return;
    }

    // ---- path-transfer form: s/c/u/d only act on the direction row ----
    if (mode.name === "pathTransfer") {
      if (key.escape) {
        setMode({ name: "none" });
        return;
      }
      if (key.tab || key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setMode({ name: "pathTransfer", field: (mode.field + delta + 3) % 3 });
        return;
      }
      if (mode.field === 0) {
        if (key.return) {
          submitPathForm();
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          setPathForm((v) => ({
            ...v,
            direction: v.direction === "upload" ? "download" : "upload",
          }));
          return;
        }
        if (input === "u" || input === "d") {
          setPathForm((v) => ({ ...v, direction: input === "u" ? "upload" : "download" }));
          return;
        }
        if (input === "s") {
          setPathForm((v) => ({ ...v, sync: !v.sync }));
          return;
        }
        if (input === "c") {
          setPathForm((v) => ({ ...v, checksum: !v.checksum }));
          return;
        }
        return;
      }
      if (key.return) {
        submitPathForm();
        return;
      }
      if (key.backspace || key.delete) {
        const f = mode.field;
        setPathForm((v) =>
          f === 1 ? { ...v, source: v.source.slice(0, -1) } : { ...v, dest: v.dest.slice(0, -1) },
        );
        return;
      }
      if (key.leftArrow || key.rightArrow) return;
      const clean = sanitizeInput(input);
      if (clean) {
        const f = mode.field;
        if (f === 1) setPathForm((v) => ({ ...v, source: v.source + clean }));
        else setPathForm((v) => ({ ...v, dest: v.dest + clean }));
      }
      return;
    }

    // ---- delete confirmation (defaults to no; q only cancels, never confirms) ----
    if (mode.name === "delete") {
      if (key.leftArrow || key.rightArrow || key.tab || input === "h" || input === "l") {
        setConfirmYes((v) => !v);
        return;
      }
      if (key.return) {
        if (!confirmYes) {
          setMode({ name: "none" });
          return;
        }
        doDelete();
        return;
      }
      if (key.escape || input === "q" || input === "n") {
        setMode({ name: "none" });
        setConfirmYes(false);
        return;
      }
      if (input === "y") {
        doDelete();
        return;
      }
      return;
    }

    // ---- transfer confirmation ----
    if (mode.name === "transfer") {
      if (key.escape || input === "q") {
        setMode({ name: "none" });
        setPending(null);
        return;
      }
      if (key.return || input === "y") {
        submitTransfer(syncDefault, checksumDefault);
        return;
      }
      if (input === "s") {
        setSyncDefault((v) => !v);
        return;
      }
      if (input === "c") {
        setChecksumDefault((v) => !v);
        return;
      }
      return;
    }

    // ---- browser, no dialog ----
    if (key.tab) {
      setActiveSide((v) => (v === "local" ? "remote" : "local"));
      return;
    }
    if (key.upArrow || input === "k") {
      setPaneCursor(activeSide, (v) => Math.max(0, v - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setPaneCursor(activeSide, (v) => Math.max(0, Math.min(pane.entries.length - 1, v + 1)));
      return;
    }
    if (key.return || key.rightArrow || input === "l") {
      if (cursorEntry?.kind === "directory") loadPane(activeSide, cursorEntry.path);
      else if (cursorEntry) flash("文件不能进入：u 传输 · r 改名 · x 删除");
      return;
    }
    if (key.leftArrow || key.backspace || key.delete || input === "h") {
      const parent = parentSide(activeSide, pane.path);
      if (parent !== pane.path) loadPane(activeSide, parent);
      return;
    }
    if (input === " ") {
      if (!cursorEntry) return;
      const p = cursorEntry.path;
      updatePaneChecked(activeSide, (checked) =>
        checked.includes(p) ? checked.filter((x) => x !== p) : [...checked, p],
      );
      setPaneCursor(activeSide, (v) => Math.min(pane.entries.length - 1, v + 1));
      return;
    }
    if (key.escape || input === "q" || input === "Q") {
      if (input === "Q") {
        setTab("queue");
        return;
      }
      onBack();
      return;
    }
    if (input === "a") {
      updatePaneChecked(activeSide, (checked) =>
        checked.length === pane.entries.length && pane.entries.length > 0
          ? []
          : pane.entries.map((e) => e.path),
      );
      return;
    }
    if (input === "r" && cursorEntry) {
      const multi = selection.length > 1;
      setField(multi ? pane.path : cursorEntry.path);
      setMode({ name: "rename", multi });
      return;
    }
    if (input === "g") {
      setField(pane.path);
      setMode({ name: "pathNav" });
      return;
    }
    if (input === "m") {
      setField("");
      setMode({ name: "mkdir" });
      return;
    }
    if (input === "x") {
      if (selection.length === 0) {
        flash("没有可删除的选中项");
        return;
      }
      setConfirmYes(false);
      setMode({ name: "delete" });
      return;
    }
    if (input === "u") {
      openTransferConfirm();
      return;
    }
    if (input === "p") {
      setPathForm({
        direction: activeSide === "local" ? "upload" : "download",
        source: "",
        dest: panes[otherSide].path,
        sync: syncDefault,
        checksum: checksumDefault,
      });
      setMode({ name: "pathTransfer", field: 1 });
      return;
    }
    if (input === "s") {
      setSyncDefault((v) => !v);
      flash(`同步模式：${!syncDefault ? "开（目录按大小+时间跳过未变文件）" : "关（全部传输）"}`);
      return;
    }
    if (input === "c") {
      setChecksumDefault((v) => !v);
      flash(`内容哈希校验：${!checksumDefault ? "开" : "关"}`);
      return;
    }
  });

  const narrow = width < 64;
  const hintLines =
    mode.name === "none"
      ? narrow
        ? [
            "Tab 切侧 · ↑↓ 移动 · Enter 进入",
            "← 返回 · Space 多选 · a 全选",
            "u 传输 · p 路径直传 · g 跳转",
            "m 新建 · r 移动 · x 删除",
            `s 同步[${syncDefault ? "开" : "关"}] c 校验[${checksumDefault ? "开" : "关"}] · Q 队列`,
            "Esc/q 返回",
          ]
        : [
            "Tab 切侧 · ↑↓ 移动 · Enter 进入 · ← 返回 · Space 多选 · a 全选",
            "u 传输 · p 路径直传 · g 跳转 · Q 队列 · Esc/q 返回",
            `m 新建 · r 改名/移动 · x 删除 · s 同步[${syncDefault ? "开" : "关"}] c 校验[${checksumDefault ? "开" : "关"}]`,
          ]
      : mode.name === "delete"
        ? ["←→ 选择 · Enter 确定 · y 删除 · Esc/q/n 取消"]
        : mode.name === "transfer"
          ? ["Enter/y 加入队列 · s 同步 · c 校验 · Esc/q 取消"]
          : ["输入路径 · ⌫ 删除 · Enter 确定 · Esc 取消"];
  const dialogH = dialogRows(mode, selection.length);
  const hintCount = hintLines.length;
  // Title (1) + pane header (1) + entries + pane footer (1) + dialog + notice + hints.
  const listRows = Math.max(1, height - 3 - dialogH - (notice ? 1 : 0) - hintCount);

  const renderPane = (side: FileSide, paneWidth: number): React.ReactElement => {
    const p = panes[side];
    const activePane = side === activeSide && !(narrow && side !== activeSide);
    const idx =
      side === activeSide ? cursorIndex : Math.min(p.cursor, Math.max(0, p.entries.length - 1));
    const nameWidth = Math.max(8, paneWidth - 14);
    const start = Math.max(0, Math.min(idx, Math.max(0, p.entries.length - listRows)));
    const shown = p.entries.slice(start, start + listRows);
    return (
      <Box flexDirection="column" width={paneWidth} flexShrink={0}>
        <Box paddingX={1}>
          <Text bold={activePane} color={activePane ? "green" : undefined}>
            {side === "local" ? "▸本地" : "▸远程"}
          </Text>
          <Text dimColor> {clip(visible(p.path), Math.max(8, paneWidth - 10))}</Text>
        </Box>
        {p.loading ? (
          <Box paddingX={1}>
            <Text dimColor>读取中…</Text>
          </Box>
        ) : p.error ? (
          <Box paddingX={1}>
            <Text color="red">✖ {clip(visible(p.error), Math.max(8, paneWidth - 4))}</Text>
          </Box>
        ) : p.entries.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>空目录</Text>
          </Box>
        ) : (
          shown.map((entry, i) => {
            const absolute = start + i;
            const isCursor = side === activeSide && absolute === idx;
            const checked = p.checked.includes(entry.path);
            const label = `${checked ? "[✓]" : "[ ]"}${isCursor ? "›" : " "}${visible(entry.name)}${kindMark(entry.kind)}`;
            return (
              <Box key={entry.path}>
                <Text>
                  <Text inverse={isCursor}>{clip(label, nameWidth)}</Text>
                  <Text dimColor>
                    {" "}
                    {entry.kind === "directory" ? "-" : formatBytes(entry.size)}
                  </Text>
                  {entry.kind === "symlink" ? <Text color="yellow"> 跳过</Text> : null}
                </Text>
              </Box>
            );
          })
        )}
        <Box paddingX={1}>
          <Text dimColor>
            {p.entries.length > listRows ? `${idx + 1}/` : ""}
            {p.entries.length} 项{p.checked.length > 0 ? ` · 已选 ${p.checked.length}` : ""}
            {p.entries.some((e) => e.kind === "symlink") ? " · @符号链接将跳过" : ""}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderDialog = (): React.ReactElement | null => {
    const inner = Math.max(10, width - 4);
    if (mode.name === "pathNav") {
      return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
          <Text>
            跳转（{activeSide === "local" ? "本地" : "远程"}）：{clip(visible(field), inner - 8)}
            <Text dimColor>█</Text>
          </Text>
          <Text dimColor>相对路径以本侧当前目录为基准 · Enter 跳转 · Esc 取消</Text>
        </Box>
      );
    }
    if (mode.name === "mkdir") {
      return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
          <Text>
            在 {clip(visible(pane.path), Math.max(8, inner - 24))} 下新建目录：
            {clip(visible(field), Math.max(8, inner - 24))}
            <Text dimColor>█</Text>
          </Text>
          <Text dimColor>相对名建于当前目录，绝对路径亦可 · Enter 创建 · Esc 取消</Text>
        </Box>
      );
    }
    if (mode.name === "rename") {
      return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
          <Text>
            {mode.multi ? `移动 ${selection.length} 项到目录：` : "改名/移动为："}
            {clip(visible(field), inner - 8)}
            <Text dimColor>█</Text>
          </Text>
          <Text dimColor>相对路径以当前目录为基准 · Enter 确定 · Esc 取消</Text>
        </Box>
      );
    }
    if (mode.name === "delete") {
      return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="red">
          <Text bold color="red">
            永久删除 {selection.length} 项（递归，不可恢复）：
          </Text>
          {selection.slice(0, 3).map((e) => (
            <Text key={e.path} dimColor>
              · {clip(visible(e.path), inner - 4)}
            </Text>
          ))}
          {selection.length > 3 ? <Text dimColor>· …另 {selection.length - 3} 项</Text> : null}
          <Box>
            <Text inverse={!confirmYes}> 取消 </Text>
            <Text> </Text>
            <Text inverse={confirmYes} color={confirmYes ? "red" : undefined}>
              {" 删除 "}
            </Text>
          </Box>
          <Text dimColor>←→ 切换 · Enter 确定 · y 直接删 · Esc/q/n 取消</Text>
        </Box>
      );
    }
    if (mode.name === "transfer" && pending) {
      const hasSymlink = pending.kinds.some((k) => k === "symlink");
      return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
          <Text bold>
            {directionText(pending.direction)} {pending.sources.length} 项 →{" "}
            {clip(visible(pending.destDir), inner - 16)}
          </Text>
          {pending.sources.slice(0, 2).map((s) => (
            <Text key={s} dimColor>
              · {clip(visible(s), inner - 4)}
            </Text>
          ))}
          {pending.sources.length > 2 ? (
            <Text dimColor>· …另 {pending.sources.length - 2} 项</Text>
          ) : null}
          {hasSymlink ? <Text color="yellow">符号链接将被跳过并计入结果。</Text> : null}
          <Text dimColor>
            s 同步[{syncDefault ? "✓" : " "}] c 哈希校验[{checksumDefault ? "✓" : " "}] · Enter
            加入队列 · Esc 取消
          </Text>
        </Box>
      );
    }
    if (mode.name === "pathTransfer") {
      const f = mode.field;
      const marker = (i: number): string => (f === i ? "›" : " ");
      return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
          <Text bold>按路径直接传输</Text>
          <Text>
            {marker(0)}方向：{directionText(pathForm.direction)}（←→/u/d 切换）
          </Text>
          <Text>
            {marker(1)}来源：{clip(visible(pathForm.source), inner - 8)}
            {f === 1 ? <Text dimColor>█</Text> : null}
          </Text>
          <Text>
            {marker(2)}目标：{clip(visible(pathForm.dest), inner - 8)}
            {f === 2 ? <Text dimColor>█</Text> : null}
          </Text>
          <Text dimColor>
            来源相对发起侧当前目录，目标相对接收侧当前目录 · Tab/↑↓ 换行 ·{" "}
            {f === 0 ? "s 同步 c 校验 · " : ""}Enter 提交 · Esc 取消
          </Text>
        </Box>
      );
    }
    return null;
  };

  if (tab === "queue") {
    const clamped = Math.min(queueCursor, Math.max(0, jobs.length - 1));
    const selected = jobs[clamped];
    const detail = detailRows(selected, queueDetail, skippedOpen, skippedIndex);
    // Title (1) + list + detail + notice + hints (2) + Q line (1) = height.
    const queueListRows = Math.max(1, height - 4 - detail - (notice ? 1 : 0));
    const ui: QueueUi = {
      jobs,
      cursor: clamped,
      setCursor: setQueueCursor,
      showDetail: queueDetail,
      setShowDetail: setQueueDetail,
      skippedOpen,
      setSkippedOpen,
      skippedIndex,
      setSkippedIndex,
      applyAll,
      setApplyAll,
      resume,
      flash,
      width,
      listRows: queueListRows,
    };
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        <Box paddingX={1}>
          <Text bold>文件</Text>
          <Text dimColor>
            　{clip(visible(uuid), 12)} · 浏览器 | 队列({jobs.length})
            {jobs.length > 0 ? ` · ${clamped + 1}/${jobs.length}` : ""}
          </Text>
        </Box>
        {renderQueueBody(ui)}
        <Box flexGrow={1} />
        {notice ? (
          <Box paddingX={1}>
            <Text color="cyan">{clip(visible(notice), Math.max(10, width - 2))}</Text>
          </Box>
        ) : null}
        {queueHints(selected, skippedOpen).map((hint) => (
          <Box key={hint} paddingX={1}>
            <Text dimColor wrap="truncate">
              {fitLine(hint, Math.max(10, width - 2))}
            </Text>
          </Box>
        ))}
        <Box paddingX={1}>
          <Text dimColor>{clip("Q/Esc 返回浏览器", Math.max(10, width - 2))}</Text>
        </Box>
      </Box>
    );
  }

  const half = Math.max(20, Math.floor((width - 1) / 2));

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box paddingX={1}>
        <Text bold wrap="truncate">
          文件 · {narrow ? (activeSide === "local" ? "本地" : "远程") : "本地 / 远程"} · Q 队列(
          {jobs.length}){busy ? " · 处理中…" : ""}
        </Text>
      </Box>
      <Box flexDirection="row">
        {narrow ? (
          renderPane(activeSide, Math.max(20, width - 2))
        ) : (
          <>
            {renderPane("local", half)}
            {renderPane("remote", width - 1 - half)}
          </>
        )}
      </Box>
      {renderDialog()}
      <Box flexGrow={1} />
      {notice ? (
        <Box paddingX={1}>
          <Text color="cyan">{clip(visible(notice), Math.max(10, width - 2))}</Text>
        </Box>
      ) : null}
      {hintLines.map((hint) => (
        <Box key={hint} paddingX={1}>
          <Text dimColor>{clip(hint, Math.max(10, width - 2))}</Text>
        </Box>
      ))}
    </Box>
  );
}
