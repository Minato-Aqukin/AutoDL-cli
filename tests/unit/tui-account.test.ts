import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { identityFromToken } from "../../src/tui/account.js";

/**
 * AutoDL's open API has no user endpoint — /dev/user/info and friends all 404 — so the
 * account identity has to be decoded from the JWT the user already gave us. There is no
 * display name to be had anywhere; the uid is the identity.
 */

function jwt(payload: unknown): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
}

describe("identityFromToken", () => {
  it("reads the fields a real AutoDL developer token carries", () => {
    const token = jwt({
      uid: 785976,
      uuid: "3c9c106fb9b5614e",
      tenant: "autodl",
      aud: "develop_api",
    });
    expect(identityFromToken(token)).toEqual({
      uid: 785976,
      uuid: "3c9c106fb9b5614e",
      tenant: "autodl",
    });
  });

  it("never throws on malformed input", () => {
    // A bad token should surface as "unknown account", not as a crashed dashboard.
    for (const bad of ["", "not-a-jwt", "a.b", "a.!!!.c", "a..c"]) {
      expect(() => identityFromToken(bad)).not.toThrow();
      expect(identityFromToken(bad).uid).toBeNull();
    }
  });

  it("ignores fields of the wrong type instead of trusting them", () => {
    const token = jwt({ uid: "785976", uuid: 42 });
    expect(identityFromToken(token)).toEqual({ uid: null, uuid: null, tenant: null });
  });

  it("handles base64url padding", () => {
    // Payload lengths that need 0, 1 and 2 pad characters.
    for (const uid of [1, 12, 123]) {
      expect(identityFromToken(jwt({ uid })).uid).toBe(uid);
    }
  });
});
