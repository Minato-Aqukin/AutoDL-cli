import { spawn } from "node:child_process";
import type { AutoDLClient } from "../core/client.js";
import { SSHError } from "../core/errors.js";
import { note } from "../output/format.js";
import { type CredentialOptions, getCredentials, type SSHCredentials } from "./credentials.js";

/**
 * Interactive login hands off to the system `ssh` binary rather than ssh2: the user
 * gets their own terminal handling, agent forwarding, ProxyJump, ~/.ssh/config, etc.
 */
export async function connectInteractive(
  client: AutoDLClient,
  uuid: string,
  options: CredentialOptions & { extraArgs?: string[] } = {},
): Promise<number> {
  const creds = await getCredentials(client, uuid, options);
  const args = [
    "-p",
    String(creds.port),
    // The proxy hosts recycle host keys across instances, so strict checking would
    // fail on every new rental and train users to ignore the warning.
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    ...(options.extraArgs ?? []),
    `${creds.user}@${creds.host}`,
  ];

  note(`ssh -p ${creds.port} ${creds.user}@${creds.host}`);
  note(`密码：${creds.password}`);

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", (err) =>
      reject(
        new SSHError(`无法启动 ssh 客户端：${err.message}`, {
          hint: "确认系统已安装 OpenSSH 客户端（which ssh）。",
          cause: err,
        }),
      ),
    );
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/** The connection details, for printing or for feeding another tool. */
export function formatSSHCommand(creds: SSHCredentials): string {
  return `ssh -p ${creds.port} ${creds.user}@${creds.host}`;
}
