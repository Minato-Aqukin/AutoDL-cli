import { listExpired, trackInstance, untrackInstance } from "../config/state.js";
import type { AutoDLClient } from "../core/client.js";
import { formatDuration } from "../core/duration.js";
import { getInstanceStatus, powerOffInstance } from "../core/endpoints/instance.js";
import { debug, warn } from "../output/format.js";
import { t } from "../output/i18n.js";
import { execCommand } from "../ssh/exec.js";

/**
 * Auto-shutdown, in two layers.
 *
 * Layer 1 — inside the instance. A detached `sleep N && shutdown` runs on the box
 * itself, so it fires even if this CLI is killed, the laptop sleeps, or the network
 * drops. This is the one that actually protects the wallet.
 *
 * Layer 2 — the local ledger (config/state.ts) swept on every command. It catches the
 * cases layer 1 can't: a start_command that silently failed, or a manual power-on that
 * came back without a timer.
 *
 * AutoDL bills purely on power state, not GPU use, so an unattended instance is a
 * meter running at full rate. Neither layer is optional in agent workflows.
 */

const PID_FILE = "/tmp/.autodl-cli-ttl.pid";

/**
 * Shell snippet that arms the in-instance timer.
 *
 * Deliberately quote-free: it is embedded in AutoDL's `start_command` field, and we
 * can't see how that string is re-parsed on their side. A subshell with `&&` expresses
 * "wait then shut down" without a single quote character.
 */
export function buildTTLSnippet(seconds: number): string {
  return `(sleep ${seconds} && /usr/bin/shutdown -h now) >/dev/null 2>&1 &`;
}

/** Compose the boot command: arm the timer first, then run whatever the user asked for. */
export function composeStartCommand(
  ttlSeconds: number | undefined,
  userCommand: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (ttlSeconds && ttlSeconds > 0) parts.push(buildTTLSnippet(ttlSeconds));
  if (userCommand?.trim()) parts.push(userCommand.trim());
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Arm (or re-arm) the timer on an already-running instance over SSH.
 * Used by `autodl start --ttl`, where there is no create payload to piggyback on.
 */
export async function armTTLOverSSH(
  client: AutoDLClient,
  uuid: string,
  seconds: number,
): Promise<boolean> {
  // Quoting is safe here — we own the whole command string, unlike start_command.
  const command = [
    `if [ -f ${PID_FILE} ]; then kill "$(cat ${PID_FILE})" 2>/dev/null || true; fi`,
    `(sleep ${seconds} && /usr/bin/shutdown -h now) >/dev/null 2>&1 &`,
    `echo $! > ${PID_FILE}`,
  ].join("; ");

  try {
    const result = await execCommand(client, uuid, command, { capture: true, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      debug(`定时关机命令退出码 ${result.exitCode}：${result.stderr.trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    debug(`定时关机命令执行失败：${(err as Error).message}`);
    return false;
  }
}

/** Cancel a previously armed in-instance timer. */
export async function disarmTTLOverSSH(client: AutoDLClient, uuid: string): Promise<boolean> {
  const command = `if [ -f ${PID_FILE} ]; then kill "$(cat ${PID_FILE})" 2>/dev/null; rm -f ${PID_FILE}; fi; /usr/bin/shutdown -c 2>/dev/null || true`;
  try {
    await execCommand(client, uuid, command, { capture: false, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export interface RecordTTLInput {
  uuid: string;
  name?: string;
  ttlSeconds: number;
  inInstanceTimer: boolean;
}

/** Add the instance to the local ledger so the sweep can catch it later. */
export function recordTTL(input: RecordTTLInput): void {
  const now = Date.now();
  trackInstance({
    uuid: input.uuid,
    ...(input.name ? { name: input.name } : {}),
    ttlSeconds: input.ttlSeconds,
    expiresAt: now + input.ttlSeconds * 1000,
    createdAt: now,
    inInstanceTimer: input.inInstanceTimer,
  });
}

export interface SweepResult {
  stopped: string[];
  alreadyStopped: string[];
  failed: { uuid: string; reason: string }[];
}

/**
 * Power off any tracked instance past its TTL.
 *
 * Runs opportunistically before every command, so an agent that forgot to clean up
 * gets caught the next time anything touches the CLI. Failures here are reported but
 * never abort the command the user actually asked for.
 */
export async function sweepExpired(client: AutoDLClient): Promise<SweepResult> {
  const result: SweepResult = { stopped: [], alreadyStopped: [], failed: [] };
  const expired = listExpired();
  if (expired.length === 0) return result;

  for (const entry of expired) {
    try {
      const status = await getInstanceStatus(client, entry.uuid);
      if (status === "running" || status === "starting") {
        await powerOffInstance(client, entry.uuid);

        // Confirm it actually took. A power_off issued while the instance is still
        // coming up was observed not to take effect, and untracking on an unverified
        // call would drop the entry and let the instance bill indefinitely — the exact
        // outcome this guard exists to prevent. Leaving it tracked costs one status
        // call on the next command; dropping it costs money.
        const after = await getInstanceStatus(client, entry.uuid).catch(() => status);
        if (after === "running" || after === "starting") {
          result.failed.push({ uuid: entry.uuid, reason: `关机未生效（状态仍为 ${after}）` });
          warn(
            `${entry.name ?? entry.uuid} 关机未生效（状态 ${after}），保留在台账中，下次命令会重试`,
          );
          continue;
        }

        result.stopped.push(entry.uuid);
        warn(
          `${t("guard.sweptOne")}：${entry.name ?? entry.uuid}（TTL ${formatDuration(entry.ttlSeconds)}）`,
        );
      } else {
        result.alreadyStopped.push(entry.uuid);
      }
      untrackInstance(entry.uuid);
    } catch (err) {
      const reason = (err as Error).message;
      result.failed.push({ uuid: entry.uuid, reason });
      debug(`清理超时实例 ${entry.uuid} 失败：${reason}`);
      // A released instance will 404 forever — stop tracking it so we don't retry endlessly.
      if (/不存在|not found/i.test(reason)) untrackInstance(entry.uuid);
    }
  }
  return result;
}

export { untrackInstance };
