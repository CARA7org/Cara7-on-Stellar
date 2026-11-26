/**
 * The classic path for the trustline of the deal asset. The deal asset
 * (EURC) is the Stellar Asset Contract of a classic asset. An account must
 * hold a trustline before it can hold EURC. The SAC `name()` gives
 * "CODE:ISSUER". The connected signer signs the ChangeTrust and Horizon
 * receives it. This is the only classic operation of the app.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  NotFoundError,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { connectedSigner, signAndSubmit, type SignedTransaction, type TxOptions } from "./signers";
import { HORIZON_URL, NETWORK_PASSPHRASE, toBaseUnits } from "./trancheTx";
import { simulateCall } from "./waterfall";

/** Classic amounts have 7 decimals. */
const CLASSIC_DECIMALS = 7;

export interface ClassicAsset {
  code: string;
  issuer: string;
}

/** The trustline of one account. Amounts are in base units (7 decimals). */
export type TrustlineState =
  | { exists: false }
  | { exists: true; balance: bigint; buyingLiabilities: bigint };

/** "EURC:G..." -> { code, issuer }. Null for the native SAC or for a token that is not a SAC. */
export function parseSacName(name: unknown): ClassicAsset | null {
  if (typeof name !== "string") return null;
  const [code, issuer, extra] = name.split(":");
  if (extra !== undefined || !code || !issuer) return null;
  if (code.length > 12 || !StrKey.isValidEd25519PublicKey(issuer)) return null;
  return { code, issuer };
}

const assetCache = new Map<string, ClassicAsset>();

/** The classic asset behind a SAC, from its `name()`. Null on any failure. */
export async function fetchClassicAsset(tokenContractId: string): Promise<ClassicAsset | null> {
  const cached = assetCache.get(tokenContractId);
  if (cached) return cached;
  try {
    const asset = parseSacName(await simulateCall(tokenContractId, "name"));
    if (asset) assetCache.set(tokenContractId, asset);
    return asset;
  } catch {
    return null;
  }
}

interface HorizonBalance {
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  buying_liabilities?: string;
}

/** The trustline of an account, from the Horizon balances. Null when Horizon does not answer. */
export async function fetchTrustline(
  address: string,
  asset: ClassicAsset
): Promise<TrustlineState | null> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`, { cache: "no-store" });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return null;
    const account = (await res.json()) as { balances: HorizonBalance[] };
    const line = account.balances.find(
      (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer
    );
    if (!line) return { exists: false };
    return {
      exists: true,
      balance: toBaseUnits(line.balance, CLASSIC_DECIMALS),
      buyingLiabilities: toBaseUnits(line.buying_liabilities ?? "0", CLASSIC_DECIMALS),
    };
  } catch {
    return null;
  }
}

/** True or false when Horizon answers. Null when it does not. */
export async function fetchHasTrustline(
  address: string,
  asset: ClassicAsset
): Promise<boolean | null> {
  const state = await fetchTrustline(address, asset);
  return state ? state.exists : null;
}

/** A ChangeTrust with limit 0 removes a trustline only when it holds 0 and has no liabilities. */
export function canRemoveTrustline(state: TrustlineState | null): boolean {
  return state !== null && state.exists && state.balance === BigInt(0) && state.buyingLiabilities === BigInt(0);
}

/* ---- change events: every trustline view refreshes after a change ---- */

const changeListeners = new Set<() => void>();

export function onTrustlineChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/* ---- ChangeTrust ---- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Horizon puts the result codes in `extras.result_codes` of its problem body. */
function horizonError(e: unknown): string {
  const response = isRecord(e) ? e.response : undefined;
  const bodies = [response, isRecord(response) ? response.data : undefined];
  for (const body of bodies) {
    if (!isRecord(body) || !isRecord(body.extras) || !isRecord(body.extras.result_codes)) continue;
    const codes = body.extras.result_codes;
    const ops = Array.isArray(codes.operations) ? codes.operations.join(", ") : "";
    return `Horizon rejected the transaction (${String(codes.transaction ?? "unknown")}${ops ? `: ${ops}` : ""}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function loadAccount(horizon: Horizon.Server, address: string) {
  try {
    return await horizon.loadAccount(address);
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw new Error("The wallet account does not exist on the network. Fund it with XLM first.");
    }
    throw new Error(horizonError(e));
  }
}

/** Submits a signed classic transaction through Horizon. Gives the hash. */
export async function submitToHorizon(signed: SignedTransaction): Promise<{ hash: string }> {
  const horizon = new Horizon.Server(HORIZON_URL);
  let hash: string;
  try {
    ({ hash } = await horizon.submitTransaction(signed));
  } catch (e) {
    throw new Error(horizonError(e));
  }
  changeListeners.forEach((listener) => listener());
  return { hash };
}

async function changeTrust(
  opts: { tokenContractId: string; address: string; limit?: string },
  options: TxOptions
): Promise<{ hash: string }> {
  const asset = await fetchClassicAsset(opts.tokenContractId);
  if (!asset) throw new Error("The deal asset is not a classic Stellar asset.");
  const signer = connectedSigner();
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await loadAccount(horizon, opts.address);

  // No limit gives the maximum limit. Limit "0" removes the trustline.
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer), limit: opts.limit }))
    .setTimeout(signer.txTimeoutSeconds)
    .build();

  return signAndSubmit(
    signer,
    tx,
    {
      address: opts.address,
      networkPassphrase: NETWORK_PASSPHRASE,
      onAwaitingApproval: options.onAwaitingApproval,
      pending: { kind: "change_trust", submitVia: "horizon" },
    },
    submitToHorizon
  );
}

/** Opens the trustline of the deal asset (ChangeTrust, maximum limit). Gives the hash. */
export function enableTrustline(
  opts: { tokenContractId: string; address: string },
  options: TxOptions = {}
): Promise<{ hash: string }> {
  return changeTrust(opts, options);
}

/** Removes the trustline of the deal asset (ChangeTrust, limit 0). Gives the hash. */
export function removeTrustline(
  opts: { tokenContractId: string; address: string },
  options: TxOptions = {}
): Promise<{ hash: string }> {
  return changeTrust({ ...opts, limit: "0" }, options);
}
