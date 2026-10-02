import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import type { FileEntry, FileSide } from "../../src/ssh/file-types.js";
import type { TransferJob } from "../../src/ssh/queue-types.js";
import { FilesScreen } from "../../src/tui/screens/files.js";

/**
 * Where the file panes keep the cursor.
 *
 * The window used to start at the cursor, gluing the selected entry to the top row with
 * nothing above it, and every reload put the cursor back on the first entry — including
 * the one a finished transfer triggers while you are browsing.
 */

const ROOT = process.cwd();
const B_DIR = join(ROOT, "b-dir");

const file = (name: string, dir = ROOT): FileEntry => ({
  name,
  path: join(dir, name),
  kind: "file",
  size: 1,
  mtime: 0,
});
const dir = (name: string): FileEntry => ({ ...file(name), kind: "directory" });

/** f00 … f39: more than the pane's 23 rows at 100×30. */
const files = Array.from({ length: 40 }, (_, i) => file(`f${String(i).padStart(2, "0")}`));

const listing: { root: FileEntry[] } = { root: files };
let jobs: TransferJob[] = [];
const listeners = new Set<() => void>();

const queue = {
  snapshot: (): readonly TransferJob[] => jobs,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  enqueue: () => "job",
  resume: () => undefined,
  cancel: () => undefined,
  resolveConflict: () => undefined,
  hasPending: () => false,
  pauseAll: async () => undefined,
  dispose: async () => undefined,
};

const workspace = {
  list: async (side: FileSide, path: string): Promise<FileEntry[]> =>
    side === "remote" ? [] : path === B_DIR ? [file("inner.txt", B_DIR)] : [...listing.root],
  mkdir: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  dispose: () => undefined,
};

const flush = () => sleep(60);
const DOWN = "j";
const ENTER = "\r";
const PAGE_DOWN = "\u001B[6~";
const HOME = "\u001B[H";
const END = "\u001B[F";

const mount = () =>
  render(
    <FilesScreen
      workspace={workspace as never}
      queue={queue as never}
      uuid="pro-1"
      width={100}
      height={30}
      onBack={() => undefined}
    />,
  );

async function press(stdin: { write: (data: string) => void }, key: string, times = 1) {
  for (let i = 0; i < times; i += 1) {
    stdin.write(key);
    await flush();
  }
}

beforeEach(() => {
  listing.root = files;
  jobs = [];
  listeners.clear();
});

describe("the file pane window", () => {
  it("keeps the selected entry mid-window, with the entries above it in view", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    await press(stdin, DOWN, 12);

    expect(lastFrame()).toContain("[ ]›f12");
    expect(lastFrame()).toContain("f05");
  });

  it("pages by the visible rows and jumps to either end", async () => {
    const { stdin, lastFrame } = mount();
    await flush();

    await press(stdin, PAGE_DOWN);
    expect(lastFrame()).toContain("[ ]›f23");
    await press(stdin, END);
    expect(lastFrame()).toContain("[ ]›f39");
    await press(stdin, HOME);
    expect(lastFrame()).toContain("[ ]›f00");
  });
});

describe("reloading a pane", () => {
  it("keeps the cursor on its entry when a finished transfer refreshes the listing", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    await press(stdin, DOWN, 12);

    // The download lands a file that sorts first, shifting every index by one.
    listing.root = [file("e-new"), ...files];
    jobs = [
      {
        request: {
          id: "job-1",
          uuid: "pro-1",
          direction: "download",
          sources: ["/root/autodl-tmp/e-new"],
          destination: ROOT,
          sync: false,
          checksum: false,
        },
        state: "completed",
      },
    ];
    for (const listener of listeners) listener();
    await flush();

    // The new listing is in (one more entry), and the cursor followed f12 to its new index.
    expect(lastFrame()).toContain("14/41 项");
    expect(lastFrame()).toContain("[ ]›f12");
  });

  it("lands on the directory just left when going up", async () => {
    listing.root = [dir("a-dir"), dir("b-dir"), ...files];
    const { stdin, lastFrame } = mount();
    await flush();
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    expect(lastFrame()).toContain("inner.txt");

    await press(stdin, "h");
    expect(lastFrame()).toContain("[ ]›b-dir/");
  });
});
