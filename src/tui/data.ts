import { useCallback, useEffect, useRef, useState } from "react";
import { listTracked } from "../config/state.js";
import type { AutoDLClient } from "../core/client.js";
import {
  getInstanceSnapshot,
  getInstanceStatus,
  listAllInstances,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "../core/endpoints/instance.js";
import { isAuthError } from "../core/errors.js";
import { estimateCost } from "../core/money.js";
import type { Instance, InstanceSnapshot } from "../core/schemas.js";
import { waitForShutdown } from "../core/waiters.js";

/**
 * The only place in the TUI that touches the API.
 *
 * Everything here delegates to the same core the CLI and MCP server use — the TUI adds
 * polling cadence and caching, never its own request logic, so all three entry points
 * stay consistent.
 */

/** An instance plus everything the dashboard derives for it. */
export interface DashboardRow {
  instance: Instance;
  /** Seconds since power-on, or null when not running. */
  uptimeSeconds: number | null;
  /** Yuan per hour, only knowable from a running instance's snapshot. */
  priceYuanPerHour: number | null;
  /**
   * Estimated spend this power-on. Null whenever the price is unknown — a stopped
   * instance's rate is simply not exposed, and inventing a number would be worse than
   * showing none.
   */
  estimatedCostYuan: number | null;
  /** Milliseconds until the tracked TTL expires; negative once overdue. */
  ttlRemainingMs: number | null;
  ttlSeconds: number | null;
}

export const isLive = (status: string): boolean => status === "running" || status === "starting";

/** Elapsed seconds, measured against the caller's clock so one render is consistent. */
function secondsSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((now - started) / 1000));
}

export function buildRow(
  instance: Instance,
  snapshot: InstanceSnapshot | undefined,
  now: number,
): DashboardRow {
  const uptimeSeconds =
    instance.status === "running" ? secondsSince(instance.startedAt, now) : null;
  const price = snapshot?.priceYuanPerHour ?? null;
  const tracked = listTracked().find((entry) => entry.uuid === instance.uuid);

  return {
    instance,
    uptimeSeconds,
    priceYuanPerHour: price && price > 0 ? price : null,
    estimatedCostYuan:
      uptimeSeconds !== null && price && price > 0 ? estimateCost(price, uptimeSeconds) : null,
    ttlRemainingMs: tracked ? tracked.expiresAt - now : null,
    ttlSeconds: tracked?.ttlSeconds ?? null,
  };
}

export interface InstancesState {
  rows: DashboardRow[];
  loading: boolean;
  /** Last error, kept visible without clearing the table — a dashboard that blanks on a
   *  transient failure is worse than one showing slightly stale data. */
  error: string | null;
  /**
   * Set once the API has rejected the token. Distinct from `error` because it is not
   * something a retry can fix: the session is over, and the caller has to say so.
   */
  authError: string | null;
  lastUpdated: number | null;
  refresh: () => void;
  /** Snapshot for one instance, fetched on demand and cached. */
  snapshotFor: (uuid: string) => InstanceSnapshot | undefined;
  /** Recent CPU and memory samples for one instance, for the dashboard's sparklines. */
  historyFor: (uuid: string) => UsageHistory | undefined;
  loadSnapshot: (uuid: string) => void;
}

/** Percentages, oldest sample first. Empty until the first snapshot lands. */
export interface UsageHistory {
  cpu: number[];
  mem: number[];
}

export interface PollOptions {
  intervalMs?: number;
  /** Suspends polling while a modal owns the screen. */
  paused?: boolean;
  /**
   * Instance whose snapshot is refreshed alongside each list poll.
   *
   * One at a time, and only the one on screen: the dashboard's gauges are a live view,
   * but snapshotting every instance every tick would be N requests for figures nothing
   * is displaying.
   */
  watch?: string | undefined;
}

/**
 * A snapshot plus the power-on it describes.
 *
 * AutoDL rotates the SSH host, port and root password on every power cycle, so a
 * snapshot outlives its own contents: cached across a stop/start it hands back
 * credentials that no longer open anything, and a password the user would paste
 * somewhere. `startedAt` is what tells the two power-ons apart.
 */
interface CachedSnapshot {
  startedAt: string | null;
  snapshot: InstanceSnapshot;
  /**
   * Samples accumulated over this power-on, one per poll.
   *
   * Held beside the snapshot so it expires with it: a chart that carried the previous
   * boot's load across a restart would describe work that is no longer running.
   */
  history: UsageHistory;
}

/**
 * How many samples a sparkline keeps.
 *
 * At the 10s poll interval this is a little over five minutes of history, which is long
 * enough to tell "the job is running" from "the job finished and the meter is still on".
 */
const HISTORY_POINTS = 32;

const appendSample = (series: number[], value: number | null): number[] =>
  value === null ? series : [...series, value].slice(-HISTORY_POINTS);

export function useInstances(
  client: AutoDLClient,
  { intervalMs = 10_000, paused = false, watch }: PollOptions = {},
): InstancesState {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, CachedSnapshot>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mounted = useRef(true);
  /** Guards against a slow poll overlapping the next tick or a manual refresh. */
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Read through a ref so `loadSnapshot` keeps one identity for the life of the hook.
  // It is an effect dependency in the dashboard, and a function that changed on every
  // poll would re-fire that effect on every poll for reasons unrelated to the selection.
  const instancesRef = useRef<Instance[]>(instances);
  instancesRef.current = instances;
  const watchRef = useRef<string | undefined>(watch);
  watchRef.current = watch;

  const loadSnapshot = useCallback(
    (uuid: string) => {
      const instance = instancesRef.current.find((i) => i.uuid === uuid);
      if (instance?.status !== "running") return;
      const startedAt = instance.startedAt;
      getInstanceSnapshot(client, uuid)
        .then((snapshot) =>
          setSnapshots((prev) => {
            // Only a cache entry from this same power-on may carry its history forward.
            const previous = prev[uuid];
            const carried =
              previous && previous.startedAt === startedAt
                ? previous.history
                : { cpu: [], mem: [] };
            return {
              ...prev,
              [uuid]: {
                startedAt,
                snapshot,
                history: {
                  cpu: appendSample(carried.cpu, snapshot.usage.cpuPercent),
                  mem: appendSample(carried.mem, snapshot.usage.memPercent),
                },
              },
            };
          }),
        )
        // A missing snapshot only costs a price column; never surface it as an error.
        .catch(() => undefined);
    },
    [client],
  );

  // Exposed directly rather than via a counter the effect happens to depend on:
  // refreshing is just "load again", and expressing it that way keeps the manual
  // refresh key and the interval on one code path.
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await listAllInstances(client);
      if (!mounted.current) return;
      setInstances(next);
      // Updated here as well as on render: the watched instance's snapshot is fetched
      // below, in this same tick, and it has to see the statuses that just arrived
      // rather than the ones from the previous poll.
      instancesRef.current = next;
      setError(null);
      setLastUpdated(Date.now());
      // One sample per poll, so the dashboard's gauges track the list they sit under.
      if (watchRef.current) loadSnapshot(watchRef.current);
    } catch (err) {
      if (mounted.current) {
        setError((err as Error).message);
        if (isAuthError(err)) setAuthError((err as Error).message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [client, loadSnapshot]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // A dead token makes every further request a guaranteed 401; polling on would only
    // spam the API behind whatever the caller shows the user.
    if (authError) return;
    void load();
    if (paused) return;
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs, paused, authError]);

  // Serve a cached entry only for the power-on it was taken during. Returning undefined
  // instead of stale data also re-arms the caller's fetch-on-demand effect, so the next
  // poll replaces it with credentials that work.
  const freshEntry = (instance: Instance): CachedSnapshot | undefined => {
    const cached = snapshots[instance.uuid];
    if (!cached || instance.status !== "running") return undefined;
    return cached.startedAt === instance.startedAt ? cached : undefined;
  };

  const freshSnapshot = (instance: Instance): InstanceSnapshot | undefined =>
    freshEntry(instance)?.snapshot;

  const now = Date.now();
  const rows = instances.map((instance) => buildRow(instance, freshSnapshot(instance), now));

  return {
    rows,
    loading,
    error,
    authError,
    lastUpdated,
    refresh,
    snapshotFor: (uuid) => {
      const instance = instances.find((i) => i.uuid === uuid);
      return instance ? freshSnapshot(instance) : undefined;
    },
    historyFor: (uuid) => {
      const instance = instances.find((i) => i.uuid === uuid);
      return instance ? freshEntry(instance)?.history : undefined;
    },
    loadSnapshot,
  };
}

/**
 * Power an instance off and confirm it actually stopped.
 *
 * A power_off issued while an instance is still coming up was measured not to take
 * effect, so reporting success on the call alone would tell the user the meter had
 * stopped when it had not.
 */
export async function stopInstance(
  client: AutoDLClient,
  uuid: string,
): Promise<{ stopped: boolean; status: string }> {
  await powerOffInstance(client, uuid);
  const status = await getInstanceStatus(client, uuid).catch(() => "unknown");
  return { stopped: status !== "running" && status !== "starting", status };
}

export async function startInstance(client: AutoDLClient, uuid: string): Promise<void> {
  await powerOnInstance(client, uuid);
}

/** Release, waiting out the shutdown AutoDL requires before it will accept the call. */
export async function destroyInstance(client: AutoDLClient, uuid: string): Promise<void> {
  const status = await getInstanceStatus(client, uuid).catch(() => "unknown");
  if (status !== "shutdown") {
    if (status !== "shutting_down") await powerOffInstance(client, uuid);
    await waitForShutdown(client, uuid, { timeoutMs: 10 * 60_000 });
  }
  await releaseInstance(client, uuid);
}
