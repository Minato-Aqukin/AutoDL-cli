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
  lastUpdated: number | null;
  refresh: () => void;
  /** Snapshot for one instance, fetched on demand and cached. */
  snapshotFor: (uuid: string) => InstanceSnapshot | undefined;
  loadSnapshot: (uuid: string) => void;
}

export interface PollOptions {
  intervalMs?: number;
  /** Suspends polling while a modal owns the screen. */
  paused?: boolean;
}

export function useInstances(
  client: AutoDLClient,
  { intervalMs = 10_000, paused = false }: PollOptions = {},
): InstancesState {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, InstanceSnapshot>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [client]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    if (paused) return;
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs, paused]);

  const loadSnapshot = useCallback(
    (uuid: string) => {
      const instance = instances.find((i) => i.uuid === uuid);
      if (instance?.status !== "running") return;
      getInstanceSnapshot(client, uuid)
        .then((snapshot) => setSnapshots((prev) => ({ ...prev, [uuid]: snapshot })))
        // A missing snapshot only costs a price column; never surface it as an error.
        .catch(() => undefined);
    },
    [client, instances],
  );

  const now = Date.now();
  const rows = instances.map((instance) => buildRow(instance, snapshots[instance.uuid], now));

  return {
    rows,
    loading,
    error,
    lastUpdated,
    refresh,
    snapshotFor: (uuid) => snapshots[uuid],
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
