/**
 * The pending handle of a Dfns action that waits for a policy approval
 * (design section 8.6). The page keeps the handle in sessionStorage. After
 * a reload or a new login, the app resumes the wait, sends the transaction
 * after the approval, then removes the handle. The custody API allows one
 * pending request for each investor, so the page keeps one handle only.
 */

export type PendingKind = "subscribe" | "cancel" | "claim" | "change_trust";
/** Soroban RPC for an invoke transaction. Horizon for a ChangeTrust. */
export type SubmitPath = "soroban" | "horizon";

/** What a wait needs: the request, the time bound and the hash of the prepared body. */
export interface WaitTarget {
  requestId: string;
  /** The transaction time bound, in unix seconds. */
  maxTime: number;
  /** The hash of the prepared transaction (hex). The signed transaction must have the same hash. */
  preparedHash: string;
}

export interface PendingHandle extends WaitTarget {
  approvalId: string | null;
  address: string;
  kind: PendingKind;
  submitVia: SubmitPath;
  /** ISO date of the signature request. */
  createdAt: string;
}

const HANDLE_KEY = "cara7.custody.pending";
/** The wait stops this long before the time bound, so that a late approval cannot land after it. */
const SUBMIT_MARGIN_MS = 10_000;

const listeners = new Set<() => void>();
const activeWaits = new Set<string>();

/** The last moment to accept an approval, in milliseconds since the epoch. */
export function handleDeadlineMs(maxTime: number): number {
  return maxTime * 1000 - SUBMIT_MARGIN_MS;
}

function isPendingHandle(value: unknown): value is PendingHandle {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.requestId === "string" &&
    (h.approvalId === null || typeof h.approvalId === "string") &&
    typeof h.address === "string" &&
    (h.kind === "subscribe" || h.kind === "cancel" || h.kind === "claim" || h.kind === "change_trust") &&
    (h.submitVia === "soroban" || h.submitVia === "horizon") &&
    typeof h.maxTime === "number" &&
    typeof h.preparedHash === "string" &&
    typeof h.createdAt === "string"
  );
}

/** The saved handle, or null. The handle can be past its time bound: see handleDeadlineMs. */
export function readPendingHandle(): PendingHandle | null {
  try {
    const raw = sessionStorage.getItem(HANDLE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingHandle(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeHandle(handle: PendingHandle | null): void {
  try {
    if (handle) sessionStorage.setItem(HANDLE_KEY, JSON.stringify(handle));
    else sessionStorage.removeItem(HANDLE_KEY);
  } catch {
    // private mode: the wait continues on this page, but a reload cannot resume it
  }
  listeners.forEach((listener) => listener());
}

/** Saves the handle. It replaces an earlier handle. */
export function savePendingHandle(handle: PendingHandle): void {
  writeHandle(handle);
}

/** Removes the handle of this request. A handle of another request stays. */
export function clearPendingHandle(requestId: string): void {
  const current = readPendingHandle();
  if (current && current.requestId === requestId) writeHandle(null);
}

/** Keeps the approval id when the custody provider gives it after the first answer. */
export function updatePendingApprovalId(requestId: string, approvalId: string | null): void {
  const current = readPendingHandle();
  if (!current || current.requestId !== requestId || !approvalId) return;
  if (current.approvalId !== approvalId) writeHandle({ ...current, approvalId });
}

export function onPendingHandleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---- the waits that run on this page (one wait for each request) ---- */

export function beginWait(requestId: string): void {
  activeWaits.add(requestId);
}

export function endWait(requestId: string): void {
  activeWaits.delete(requestId);
}

/** True when this page already waits for this request. Then a resume must not start. */
export function isWaitActive(requestId: string): boolean {
  return activeWaits.has(requestId);
}
