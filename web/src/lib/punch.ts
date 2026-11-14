// Browser punching: canonical payload v1 (byte-identical to the server and
// the HRMS Android app), passkey registration/assertion, and the punch flow.
// Order: server challenge -> FRESH location sample -> passkey prompt (the
// passkey signs the payload, location included) -> submit. Unlike Android the
// location must be read before the prompt because it is part of what is
// signed; a slow prompt can therefore end in LOCATION_STALE (retryable).

import { ApiError, newOperationId, post, rpc, type Envelope } from "./api";

export interface PunchFields {
  challengeId: string;
  nonce: string;
  operationKey: string;
  employeeId: string;
  deviceId: string;
  action: "IN" | "OUT";
  targetId: string;
  officeId: string;
  latitude: string;
  longitude: string;
  accuracy: string;
  sampleAtMs: string;
}

export const lat = (v: number) => v.toFixed(7);
export const lng = (v: number) => v.toFixed(7);
/** Accuracy in metres with 2 decimals, clamped to what the server accepts. */
export const acc = (v: number) => Math.min(Math.max(v, 0.01), 9999.99).toFixed(2);

export function canonicalPayloadV1(f: PunchFields): string {
  return [
    "hrms-punch-v1",
    f.challengeId.toLowerCase(),
    f.nonce,
    f.operationKey.toLowerCase(),
    f.employeeId.toLowerCase(),
    f.deviceId.toLowerCase(),
    f.action,
    f.targetId.toLowerCase(),
    f.officeId.toLowerCase(),
    f.latitude,
    f.longitude,
    f.accuracy,
    f.sampleAtMs,
  ].join("\n");
}

export function toB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export const registrationChallenge = (challengeId: string, nonce: string) =>
  sha256(`hrms-device-v1\n${challengeId.toLowerCase()}\n${nonce}`);
export const punchChallenge = (f: PunchFields) => sha256(canonicalPayloadV1(f));

/** Great-circle distance in metres (display only; the server decides). */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------- dependencies

export interface Sample {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface PunchDeps {
  /** A fresh high-accuracy reading (never a cached one). */
  locate(): Promise<Sample>;
  credentials: Pick<CredentialsContainer, "create" | "get">;
  now(): number;
  rpc: typeof rpc;
  post: typeof post;
  operationId(): string;
  rpId: string;
}

export function browserDeps(): PunchDeps {
  return {
    locate: () =>
      new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) return reject(new LocationError("unsupported"));
        navigator.geolocation.getCurrentPosition(
          (p) =>
            resolve({
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: p.coords.accuracy,
              timestamp: p.timestamp,
            }),
          (e) => reject(new LocationError(e.code === 1 ? "denied" : e.code === 3 ? "timeout" : "unavailable")),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
        );
      }),
    credentials: navigator.credentials,
    now: () => Date.now(),
    rpc,
    post,
    operationId: newOperationId,
    rpId: location.hostname,
  };
}

export class LocationError extends Error {
  readonly reason: "denied" | "timeout" | "unavailable" | "unsupported";
  constructor(reason: "denied" | "timeout" | "unavailable" | "unsupported") {
    super(
      reason === "denied"
        ? "Allow location access for this site in your browser settings, then try again."
        : reason === "unsupported"
          ? "This browser cannot share your location."
          : "Could not get a precise location. Move near a window or outdoors, then try again.",
    );
    this.reason = reason;
  }
}

export class PasskeyError extends Error {
  readonly reason: "cancelled" | "unsupported" | "failed";
  constructor(reason: "cancelled" | "unsupported" | "failed", message?: string) {
    super(
      message ??
        (reason === "cancelled"
          ? "Verification was cancelled."
          : reason === "unsupported"
            ? "This browser does not support passkeys. Use Chrome, Safari or Edge on a device with a screen lock."
            : "Your device could not verify you. Please try again."),
    );
    this.reason = reason;
  }
}

function passkeyFailure(e: unknown): PasskeyError {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled");
  if (name === "NotSupportedError" || name === "SecurityError") return new PasskeyError("unsupported");
  if (name === "InvalidStateError")
    return new PasskeyError("failed", "A passkey for this account already exists on this device. Remove it, then try again.");
  return new PasskeyError("failed");
}

// ---------------------------------------------------------------- registration

export interface Me {
  id: string;
  code: string;
  name: string;
}

export async function registerPasskey(deps: PunchDeps, me: Me, label?: string): Promise<{ device_id: string }> {
  if (!deps.credentials?.create) throw new PasskeyError("unsupported");
  const ch = await deps.rpc<{ challenge_id: string; nonce: string }>("create_device_challenge");
  let cred: PublicKeyCredential | null;
  try {
    cred = (await deps.credentials.create({
      publicKey: {
        challenge: await registrationChallenge(ch.challenge_id, ch.nonce),
        rp: { id: deps.rpId, name: "HRMS" },
        user: { id: new TextEncoder().encode(me.id), name: me.code, displayName: me.name },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
        attestation: "none",
        timeout: 120000,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw passkeyFailure(e);
  }
  if (!cred) throw new PasskeyError("cancelled");
  const res = cred.response as AuthenticatorAttestationResponse;
  if (typeof res.getAuthenticatorData !== "function") throw new PasskeyError("unsupported");
  const out = await deps.post<Envelope<{ device_id: string }>>("/punch/device", {
    challenge_id: ch.challenge_id,
    nonce: ch.nonce,
    credential_id: toB64url(cred.rawId),
    client_data_json: toB64url(res.clientDataJSON),
    authenticator_data: toB64url(res.getAuthenticatorData()),
    device_label: label,
  });
  return out.data;
}

// ---------------------------------------------------------------- punch

export interface PunchTarget {
  action: "IN" | "OUT";
  targetId: string;
  officeId: string;
  deviceId: string;
  credentialId?: string | null;
}

export interface PunchResult {
  ok: true;
  data: {
    action: "IN" | "OUT";
    event_id: string;
    server_time: string;
    distance_m: number;
    is_late: boolean;
    late_seconds: number;
    is_early_departure: boolean;
    session: Record<string, unknown>;
  };
}

/** Max age of the location sample when submitted (server allows the office's
 * max_sample_age_s, default 10 s; stay well inside it). */
export const MAX_SAMPLE_AGE_MS = 8000;

export async function submitPunch(deps: PunchDeps, me: Me, t: PunchTarget): Promise<PunchResult> {
  if (!deps.credentials?.get) throw new PasskeyError("unsupported");
  const operationKey = deps.operationId();
  const ch = await deps.rpc<{ challenge_id: string; nonce: string; server_time: string }>("create_punch_challenge", {
    p_action: t.action,
    p_target_id: t.targetId,
    p_device_id: t.deviceId,
  });
  // Server clock skew, so the sample time is in server time.
  const skew = Date.parse(ch.server_time) - deps.now();
  const sample = await deps.locate();
  const age = deps.now() - sample.timestamp;
  if (!(age < MAX_SAMPLE_AGE_MS)) throw new LocationError("timeout");
  const fields: PunchFields = {
    challengeId: ch.challenge_id,
    nonce: ch.nonce,
    operationKey,
    employeeId: me.id,
    deviceId: t.deviceId,
    action: t.action,
    targetId: t.targetId,
    officeId: t.officeId,
    latitude: lat(sample.latitude),
    longitude: lng(sample.longitude),
    accuracy: acc(sample.accuracy),
    sampleAtMs: String(Math.round(sample.timestamp + (Number.isFinite(skew) ? skew : 0))),
  };
  let cred: PublicKeyCredential | null;
  try {
    cred = (await deps.credentials.get({
      publicKey: {
        challenge: await punchChallenge(fields),
        rpId: deps.rpId,
        allowCredentials: t.credentialId ? [{ type: "public-key", id: fromB64url(t.credentialId) }] : [],
        userVerification: "required",
        timeout: 60000,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw passkeyFailure(e);
  }
  if (!cred) throw new PasskeyError("cancelled");
  const res = cred.response as AuthenticatorAssertionResponse;
  const body = {
    operation_key: fields.operationKey,
    challenge_id: fields.challengeId,
    nonce: fields.nonce,
    action: fields.action,
    target_id: fields.targetId,
    device_id: fields.deviceId,
    office_id: fields.officeId,
    employee_id: fields.employeeId,
    latitude: fields.latitude,
    longitude: fields.longitude,
    accuracy: fields.accuracy,
    sample_at_ms: fields.sampleAtMs,
    credential_id: toB64url(cred.rawId),
    client_data_json: toB64url(res.clientDataJSON),
    authenticator_data: toB64url(res.authenticatorData),
    signature: toB64url(res.signature),
  };
  try {
    return await deps.post<PunchResult>("/punch", body);
  } catch (e) {
    // The network dropped after sending: ask whether this exact operation
    // was committed before telling the person it failed.
    if (e instanceof ApiError && e.isNetwork) {
      try {
        const op = await deps.rpc<{ found: boolean; result?: PunchResult }>("get_punch_operation", {
          p_operation_key: operationKey,
        });
        if (op.found && op.result?.ok) return op.result;
      } catch {
        /* still offline: report the original error */
      }
    }
    throw e;
  }
}

/** Short human text for a punch failure (server messages are already plain). */
export function punchErrorText(e: unknown): string {
  if (e instanceof LocationError || e instanceof PasskeyError) return e.message;
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Please try again.";
}
