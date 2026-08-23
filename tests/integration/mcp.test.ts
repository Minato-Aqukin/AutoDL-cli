import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Drives the real `autodl mcp` process over stdio with a real MCP client, so the
 * agent-facing entry point is verified end to end rather than by inspecting the
 * registration code.
 */

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

let client: Client;

beforeAll(async () => {
  client = new Client({ name: "autodl-cli-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: {
        ...(process.env as Record<string, string>),
        // A token is required to construct the client, but no tool is invoked here,
        // so no request ever reaches AutoDL.
        AUTODL_TOKEN: "test-token",
        AUTODL_BASE_URL: "http://127.0.0.1:1",
        AUTODL_NO_SWEEP: "1",
      },
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("the MCP server", () => {
  it("completes the handshake and reports its name and real version", async () => {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(client.getServerVersion()?.name).toBe("autodl-cli");
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it("ships instructions that warn about AutoDL's power-state billing", () => {
    // Agents read this before calling anything; it's the main defence against a
    // model that rents a GPU and forgets it.
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("计费");
    expect(instructions).toContain("autodl_power_off");
  });

  it("exposes the full documented tool set", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "autodl_account_info",
        "autodl_create_instance",
        "autodl_download",
        "autodl_exec",
        "autodl_get_instance",
        "autodl_list_gpu_specs",
        "autodl_list_images",
        "autodl_list_instances",
        "autodl_power_off",
        "autodl_power_on",
        "autodl_release_instance",
        "autodl_run",
        "autodl_save_image",
        "autodl_sweep_expired",
        "autodl_upload",
      ].sort(),
    );
  });

  it("marks release as destructive and requires an explicit confirm flag", async () => {
    const { tools } = await client.listTools();
    const release = tools.find((tool) => tool.name === "autodl_release_instance");
    expect(release?.annotations?.destructiveHint).toBe(true);
    expect(release?.inputSchema.required).toContain("confirm");
  });

  it("marks read-only tools as such so agents can call them freely", async () => {
    const { tools } = await client.listTools();
    for (const name of ["autodl_account_info", "autodl_list_instances", "autodl_get_instance"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("documents the SSH credential rotation on autodl_get_instance", async () => {
    const { tools } = await client.listTools();
    const get = tools.find((tool) => tool.name === "autodl_get_instance");
    expect(get?.description).toContain("不要缓存");
  });

  it("exposes the instances resource", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain("autodl://instances");
  });

  it("returns a structured error rather than crashing when a call fails", async () => {
    // The base URL points at a closed port. Network errors are retriable, so this
    // also walks the full backoff budget before surfacing — hence the long timeout.
    const result = await client.callTool({ name: "autodl_account_info", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: { code: "NETWORK", message: expect.any(String) },
    });
  }, 60_000);
});
