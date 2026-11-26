/**
 * Client for the custody API (apps/custody-api). The investor logs in with a
 * passkey (WebAuthn). The custody API holds the Dfns credentials and starts
 * each signature request for the investor's Dfns wallet. This client keeps
 * only the session token, in sessionStorage. It never holds a key.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

const BASE =
  process.env.NEXT_PUBLIC_CUSTODY_API_URL?.replace(/\/$/, "") ?? "http://localhost:8091";
const SESSION_KEY = "cara7.custody.session";
const REQUEST_TIMEOUT_MS = 30_000;
/** Registration creates the Dfns wallet and funds it with Friendbot, so it can take longer. */
const REGISTER_TIMEOUT_MS = 90_000;

export interface Investor {
  id: string;
  displayName: string;
  address: string;
  walletId: string;
  network: "testnet" | "mainnet";
}

export interface RequestSummary {
  kind: "subscribe" | "cancel" | "claim" | "change_trust";
  contractId?: string;
  classIndex?: number;
  notes?: string;
  amountEurc?: string;
  limit?: string;
}

export interface SignResult {
  requestId: string;
  status: "signed" | "pending" | "rejected" | "failed";
  /** Base64 envelope. Only when the status is "signed". */
  signedTxXdr?: string;
  approvalId?: string;
  reason?: string;
  decision?: "auto" | "needs_approval";
  summary?: RequestSummary;
}

/** An error from the custody API or from the passkey ceremony. */
export class CustodyError extends Error {
  readonly code: string;
  /** The HTTP status. 0 when no HTTP answer came. */
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "CustodyError";
    this.code = code;
    this.status = status;
  }
}

/* ---- session token (sessionStorage; private mode can throw) ---- */

interface StoredSession {
  token: string;
  expiresAt: string | null;
}

const sessionEndedListeners = new Set<() => void>();

/** Calls the listener when the custody API ends the session (HTTP 401). */
export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => {
    sessionEndedListeners.delete(listener);
  };
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    const expiresAt = typeof parsed.expiresAt === "string" ? parsed.expiresAt : null;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      clearSession();
      return null;
    }
    return { token: parsed.token, expiresAt };
  } catch {
    return null;
  }
}

function writeSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // private mode: the session lasts only while this page stays open
  }
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // private mode: nothing to remove
  }
}

/** True when a session token exists. The token can still be invalid on the server. */
export function hasSession(): boolean {
  return readSession() !== null;
}

/* ---- HTTP ---- */

async function errorOf(res: Response): Promise<CustodyError> {
  let message: string | null = null;
  let code = "unknown";
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // the body is not JSON
  }
  return new CustodyError(
    message ?? `The custody service answered with HTTP ${res.status}.`,
    code,
    res.status
  );
}

/** Sends one request. The bearer token goes on every route except the passkey ceremony. */
async function send(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const session = readSession();
  const ceremony = path.startsWith("/auth/") && path !== "/auth/logout";
  if (session && !ceremony) headers.Authorization = `Bearer ${session.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw new CustodyError("The custody service is not reachable.", "custody_unavailable", 0);
  } finally {
    clearTimeout(timer);
  }

  // A 401 ends the session only when this request carried the token.
  if (res.status === 401 && session && !ceremony) {
    clearSession();
    sessionEndedListeners.forEach((listener) => listener());
  }
  if (!res.ok) throw await errorOf(res);
  return res;
}

async function sendJson(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const res = await send(method, path, body, timeoutMs);
  try {
    return await res.json();
  } catch {
    throw badAnswer();
  }
}

/* ---- answer checks (the custody API is a separate service) ---- */

function badAnswer(): CustodyError {
  return new CustodyError("The custody service sent an answer that this page cannot read.", "bad_response", 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asInvestor(value: unknown): Investor {
  if (!isRecord(value)) throw badAnswer();
  const { id, displayName, address, walletId, network } = value;
  if (
    typeof id !== "string" ||
    typeof displayName !== "string" ||
    typeof address !== "string" ||
    typeof walletId !== "string" ||
    (network !== "testnet" && network !== "mainnet")
  ) {
    throw badAnswer();
  }
  return { id, displayName, address, walletId, network };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asSignResult(value: unknown): SignResult {
  if (!isRecord(value) || typeof value.requestId !== "string") throw badAnswer();
  const status = value.status;
  if (status !== "signed" && status !== "pending" && status !== "rejected" && status !== "failed") {
    throw badAnswer();
  }
  return {
    requestId: value.requestId,
    status,
    signedTxXdr: optionalString(value.signedTxXdr),
    approvalId: optionalString(value.approvalId),
    reason: optionalString(value.reason),
    decision:
      value.decision === "auto" || value.decision === "needs_approval" ? value.decision : undefined,
    summary: isRecord(value.summary) ? (value.summary as unknown as RequestSummary) : undefined,
  };
}

function asChallenge<T>(value: unknown): { challengeId: string; options: T } {
  if (!isRecord(value) || typeof value.challengeId !== "string" || !isRecord(value.options)) {
    throw badAnswer();
  }
  return { challengeId: value.challengeId, options: value.options as T };
}

/** Keeps the session token of a verify answer and gives the investor. */
function openSession(value: unknown): Investor {
  if (!isRecord(value) || typeof value.sessionToken !== "string") throw badAnswer();
  const investor = asInvestor(value.investor);
  writeSession({
    token: value.sessionToken,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
  });
  return investor;
}

/* ---- passkey ceremony ---- */

async function loadWebAuthn() {
  const webauthn = await import("@simplewebauthn/browser");
  if (!webauthn.browserSupportsWebAuthn()) {
    throw new CustodyError("This browser does not support passkeys.", "passkey_unsupported", 0);
  }
  return webauthn;
}

/** Runs the browser passkey prompt and gives a readable error when it stops. */
async function runCeremony<T>(ceremony: () => Promise<T>): Promise<T> {
  try {
    return await ceremony();
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const code = isRecord(e) && typeof e.code === "string" ? e.code : "";
    if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") {
      throw new CustodyError(
        "The passkey request was cancelled or timed out.",
        "passkey_cancelled",
        0
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    throw new CustodyError(`The passkey request failed: ${message}`, "passkey_failed", 0);
  }
}

/** Creates an investor, its passkey and its Dfns wallet, then opens a session. */
export async function registerWithPasskey(displayName: string): Promise<Investor> {
  const name = displayName.trim();
  if (name.length < 1 || name.length > 64) {
    throw new CustodyError("Enter a display name of 1 to 64 characters.", "bad_request", 400);
  }
  const { startRegistration } = await loadWebAuthn();
  const { challengeId, options } = asChallenge<PublicKeyCredentialCreationOptionsJSON>(
    await sendJson("POST", "/auth/register/options", { displayName: name })
  );
  const response: RegistrationResponseJSON = await runCeremony(() =>
    startRegistration({ optionsJSON: options })
  );
  return openSession(
    await sendJson("POST", "/auth/register/verify", { challengeId, response }, REGISTER_TIMEOUT_MS)
  );
}

/** Logs in with a discoverable passkey, then opens a session. */
export async function loginWithPasskey(): Promise<Investor> {
  const { startAuthentication } = await loadWebAuthn();
  const { challengeId, options } = asChallenge<PublicKeyCredentialRequestOptionsJSON>(
    await sendJson("POST", "/auth/login/options", {})
  );
  const response: AuthenticationResponseJSON = await runCeremony(() =>
    startAuthentication({ optionsJSON: options })
  );
  return openSession(await sendJson("POST", "/auth/login/verify", { challengeId, response }));
}

/** The investor of the current session. */
export async function me(): Promise<Investor> {
  const body = await sendJson("GET", "/me");
  if (!isRecord(body)) throw badAnswer();
  return asInvestor(body.investor);
}

/** Ends the session on the server when possible, and always on this page. */
export async function logout(): Promise<void> {
  try {
    if (readSession()) await send("POST", "/auth/logout");
  } catch {
    // the token is removed below in all cases
  } finally {
    clearSession();
  }
}

/* ---- signature requests ---- */

/** Asks the custody API to sign a prepared envelope (base64) with the investor's Dfns wallet. */
export async function requestSignature(
  transactionXdr: string,
  networkPassphrase: string
): Promise<SignResult> {
  return asSignResult(await sendJson("POST", "/sign", { transactionXdr, networkPassphrase }));
}

/** The current state of a signature request. The custody API refreshes it from Dfns. */
export async function fetchSignature(requestId: string): Promise<SignResult> {
  return asSignResult(await sendJson("GET", `/sign/${encodeURIComponent(requestId)}`));
}
