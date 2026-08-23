import { Buffer } from "node:buffer";

/**
 * Identity carried by the developer token itself.
 *
 * AutoDL's open API exposes no user endpoint — /dev/user/info and friends all 404 — so
 * the account id has to come from the JWT payload, decoded locally. There is no display
 * name to be had; the id is the identity.
 */
export interface TokenIdentity {
  uid: number | null;
  uuid: string | null;
  tenant: string | null;
}

/** Decode the JWT payload. Signature is irrelevant here: the server is the verifier. */
export function identityFromToken(token: string): TokenIdentity {
  const empty: TokenIdentity = { uid: null, uuid: null, tenant: null };
  const parts = token.split(".");
  if (parts.length < 2) return empty;
  try {
    const segment = parts[1] as string;
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    return {
      uid: typeof payload.uid === "number" ? payload.uid : null,
      uuid: typeof payload.uuid === "string" ? payload.uuid : null,
      tenant: typeof payload.tenant === "string" ? payload.tenant : null,
    };
  } catch {
    return empty;
  }
}
