import { describe, expect, it } from "vitest";
import {
  normalizeBalance,
  normalizeInstance,
  normalizeSnapshot,
  redactSnapshot,
} from "../../src/core/schemas.js";
import { balanceResponse, sampleInstanceRaw, snapshotResponse } from "../fixtures/responses.js";

describe("normalizeInstance", () => {
  const raw = sampleInstanceRaw;

  it("flattens Go sql.NullTime into string | null", () => {
    const instance = normalizeInstance(raw);
    expect(instance.startedAt).toBe("2025-12-15T17:31:05+08:00");
    // Valid:false must become null, not the zero-value "0001-01-01" timestamp.
    expect(instance.stoppedAt).toBeNull();
    expect(instance.expiredAt).toBeNull();
    expect(instance.timedShutdownAt).toBeNull();
  });

  it("renames fields to the documented camelCase contract", () => {
    const instance = normalizeInstance(raw);
    expect(instance.gpuSpec).toBe("pro6000-p");
    expect(instance.gpuNum).toBe(1);
    expect(instance.regionName).toBe("内蒙C区");
    expect(instance.chargeType).toBe("payg");
  });

  it("turns empty strings into null so agents can test for absence uniformly", () => {
    const instance = normalizeInstance(raw);
    expect(instance.subStatus).toBeNull();
  });

  it("keeps statuses it doesn't recognise instead of throwing", () => {
    // AutoDL can add states at any time; a strict enum would break the CLI.
    const instance = normalizeInstance({ ...raw, status: "some_new_state" });
    expect(instance.status).toBe("some_new_state");
  });
});

describe("normalizeSnapshot", () => {
  const snapshot = normalizeSnapshot(snapshotResponse.data);

  it("converts milliyuan prices to yuan", () => {
    expect(snapshot.priceYuanPerHour).toBe(1.97);
    expect(snapshot.originalPriceYuanPerHour).toBe(3.03);
  });

  it("extracts the SSH credentials the whole ssh layer depends on", () => {
    expect(snapshot.ssh.host).toBe("connect.xxx.autodl.com");
    expect(snapshot.ssh.port).toBe(34222);
    expect(snapshot.ssh.password).toBe("jbeOXgTWUxq+");
    expect(snapshot.ssh.user).toBe("root");
  });

  it("collapses the dynamic service_<port>_domain keys into a sorted list", () => {
    expect(snapshot.services).toEqual([
      { port: 6006, domain: "u1-h1tr7dnhvxyvm4uacvq9.xxx.autodl.com:8443", protocol: "http" },
      { port: 6008, domain: "uu1-yufv2v0fcxtvr5lv4j80.xxx.autodl.com:8443", protocol: "http" },
    ]);
  });

  it("surfaces usage stats", () => {
    expect(snapshot.usage.cpuPercent).toBe(3.34);
    expect(snapshot.usage.memLimitBytes).toBe(21_474_836_480);
  });

  it("tolerates a snapshot with no SSH info yet", () => {
    const booting = normalizeSnapshot({ region_sign: "bj-B1" });
    expect(booting.ssh.port).toBeNull();
    expect(booting.services).toEqual([]);
  });
});

describe("redactSnapshot", () => {
  it("masks the password and jupyter token", () => {
    const redacted = redactSnapshot(normalizeSnapshot(snapshotResponse.data));
    expect(redacted.ssh.password).toBe("***");
    expect(redacted.jupyter.token).toBe("***");
    // Non-secret fields must survive so the output stays useful.
    expect(redacted.ssh.port).toBe(34222);
  });

  it("leaves absent secrets as null rather than masking nothing", () => {
    const redacted = redactSnapshot(normalizeSnapshot({}));
    expect(redacted.ssh.password).toBeNull();
  });
});

describe("normalizeBalance", () => {
  it("converts every monetary field to yuan", () => {
    expect(normalizeBalance(balanceResponse.data)).toEqual({
      balanceYuan: 12.34,
      accumulatedYuan: 987.65,
      voucherYuan: 5,
    });
  });
});
