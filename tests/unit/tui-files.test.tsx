import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import type { FileEntry, FileSide } from "../../src/ssh/file-types.js";
import type { TransferJob } from "../../src/ssh/queue-types.js";
import { FilesScreen } from "../../src/tui/screens/files.js";

/**
 * Queue failures are part of the files screen's normal life: lock contention, persistence
 * errors, and settled conflicts throw by design. Thrown inside Ink's input dispatch they
 * used to escape and kill the whole TUI; now they surface as a notice on the screen
 * instead. Likewise an open delete dialog freezes its targets, so a transfer finishing
 * behind it cannot retarget the dialog at the wrong paths.
 */

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const TAB = "\t";
const ENTER = "\r";

const REMOTE_DIR = "/root/autodl-tmp/dataset";
const REMOTE_A = "/root/autodl-tmp/old-a.ckpt";
const REMOTE_B = "/root/autodl-tmp/old-b.ckpt";

const remoteEntries: FileEntry[] = [
  { name: "dataset", path: REMOTE_DIR, kind: "directory", size: 0, mtime: 0 },
  { name: "old-a.ckpt", path: REMOTE_A, kind: "file", size: 3, mtime: 0 },
  { name: "old-b.ckpt", path: REMOTE_B, kind: "file", size: 4, mtime: 0 },
];
const localEntries: FileEntry[] = [
  { name: "up.bin", path: `${process.cwd()}/up.bin`, kind: "file", size: 10, mtime: 0 },
];

interface WorkspaceCalls {
  remove: string[];
  rename: [string, string][];
  mkdir: string[];
}

function makeWorkspace() {
  const calls: WorkspaceCalls = { remove: [], rename: [], mkdir: [] };
  const workspace = {
    list: async (side: FileSide): Promise<FileEntry[]> =>
      side === "local" ? [...localEntries] : [...remoteEntries],
    mkdir: async (_side: FileSide, path: string): Promise<void> => {
      calls.mkdir.push(path);
    },
    rename: async (_side: FileSide, from: string, to: string): Promise<void> => {
      calls.rename.push([from, to]);
    },
    remove: async (_side: FileSide, path: string): Promise<void> => {
      calls.remove.push(path);
    },
    dispose: () => undefined,
  };
  return { calls, workspace };
}

interface QueueErrors {
  enqueue: Error | null;
  cancel: Error | null;
  resume: Error | null;
  resolve: Error | null;
}

const queueState: { jobs: TransferJob[]; errors: QueueErrors } = {
  jobs: [],
  errors: { enqueue: null, cancel: null, resume: null, resolve: null },
};
const listeners = new Set<() => void>();
const emitQueue = () => {
  for (const listener of listeners) listener();
};

const fakeQueue = {
  snapshot: (): readonly TransferJob[] => queueState.jobs,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  enqueue: (): string => {
    if (queueState.errors.enqueue) throw queueState.errors.enqueue;
    return "job-new";
  },
  resume: (id: string): void => {
    if (queueState.errors.resume) throw queueState.errors.resume;
    void id;
  },
  cancel: (id: string): void => {
    if (queueState.errors.cancel) throw queueState.errors.cancel;
    void id;
  },
  resolveConflict: (id: string): void => {
    if (queueState.errors.resolve) throw queueState.errors.resolve;
    void id;
  },
  hasPending: (): boolean => false,
  pauseAll: async (): Promise<void> => undefined,
  dispose: async (): Promise<void> => undefined,
};

const job = (id: string, state: TransferJob["state"]): TransferJob => ({
  request: {
    id,
    uuid: "pro-1",
    direction: "upload",
    sources: ["/x"],
    destination: "/root/autodl-tmp",
    sync: false,
    checksum: false,
  },
  state,
});

beforeEach(() => {
  queueState.jobs = [];
  queueState.errors = { enqueue: null, cancel: null, resume: null, resolve: null };
  listeners.clear();
});

const mount = (workspace: ReturnType<typeof makeWorkspace>["workspace"]) =>
  render(
    <FilesScreen
      workspace={workspace}
      queue={fakeQueue}
      uuid="pro-1"
      width={100}
      height={30}
      onBack={() => undefined}
    />,
  );

describe("an open delete dialog keeps its targets", () => {
  it("deletes the checked files even when a transfer completes behind it", async () => {
    const { calls, workspace } = makeWorkspace();
    const { stdin, lastFrame } = mount(workspace);
    await flush();

    stdin.write(TAB); // remote pane
    await flush();
    stdin.write("j"); // old-a.ckpt
    await flush();
    stdin.write(" "); // check old-a.ckpt, cursor advances
    await flush();
    stdin.write(" "); // check old-b.ckpt
    await flush();
    stdin.write("x"); // open the delete dialog
    await flush();
    expect(plain(lastFrame())).toContain("永久删除 2 项");
    expect(plain(lastFrame())).toContain("old-a.ckpt");

    // A transfer for this instance finishes while the dialog is open.
    queueState.jobs = [job("job-done", "completed")];
    emitQueue();
    await flush();

    // The dialog still names the two checked files, not the reloaded pane's
    // first entry (the dataset directory).
    expect(plain(lastFrame())).toContain("永久删除 2 项");
    expect(plain(lastFrame())).toContain("old-a.ckpt");

    stdin.write("y");
    await flush();
    expect(calls.remove).toEqual([REMOTE_A, REMOTE_B]);
  });
});

describe("queue failures surface as notices instead of crashing", () => {
  it("flashes when enqueue loses the queue lock", async () => {
    queueState.errors.enqueue = new Error(
      "传输队列正由进程 4242 独占使用：同一时间只允许一个写入者",
    );
    const { workspace } = makeWorkspace();
    const { stdin, lastFrame } = mount(workspace);
    await flush();

    stdin.write("u"); // transfer the cursor entry
    await flush();
    stdin.write(ENTER); // confirm into the queue
    await flush();

    // No exception escaped stdin.write (the test would have thrown); the
    // reason is on screen instead.
    expect(plain(lastFrame())).toContain("独占使用");
  });

  it("flashes when a path transfer cannot enqueue", async () => {
    queueState.errors.enqueue = new Error("传输队列持久化失败：ENOSPC");
    const { workspace } = makeWorkspace();
    const { stdin, lastFrame } = mount(workspace);
    await flush();

    stdin.write("p"); // path-transfer form
    await flush();
    stdin.write("z"); // source text (destination is prefilled)
    await flush();
    stdin.write(ENTER); // submit
    await flush();

    expect(plain(lastFrame())).toContain("持久化失败");
  });

  it("flashes when cancelling a job fails", async () => {
    queueState.jobs = [job("job-1", "paused")];
    queueState.errors.cancel = new Error(
      "传输队列正由进程 4242 独占使用：同一时间只允许一个写入者",
    );
    const { workspace } = makeWorkspace();
    const { stdin, lastFrame } = mount(workspace);
    await flush();

    stdin.write("Q"); // queue tab
    await flush();
    stdin.write("c"); // cancel the paused job
    await flush();

    expect(plain(lastFrame())).toContain("独占使用");
  });

  it("flashes when resuming a job fails", async () => {
    queueState.jobs = [job("job-1", "paused")];
    queueState.errors.resume = new Error(
      "传输队列正由进程 4242 独占使用：同一时间只允许一个写入者",
    );
    const { workspace } = makeWorkspace();
    const { stdin, lastFrame } = mount(workspace);
    await flush();

    stdin.write("Q");
    await flush();
    stdin.write("r");
    await flush();

    expect(plain(lastFrame())).toContain("独占使用");
  });

  it("flashes when resolving a conflict fails", async () => {
    queueState.jobs = [job("job-1", "conflict")];
    queueState.errors.resolve = new Error("任务 job-1 当前没有待处理的冲突");
    const { workspace } = makeWorkspace();
    const { stdin, lastFrame } = mount(workspace);
    await flush();

    stdin.write("Q");
    await flush();
    stdin.write("o"); // overwrite
    await flush();

    expect(plain(lastFrame())).toContain("没有待处理的冲突");
  });
});
