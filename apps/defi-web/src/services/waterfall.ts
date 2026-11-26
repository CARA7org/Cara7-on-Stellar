/**
 * Read-only view of the abs-deal contract (waterfall v4) via RPC simulation:
 * note factors, outstanding nominals and principal repaid per class, in
 * seniority order (senior first), plus per-holder funding subscriptions and
 * paying-agent claimables. Interest AND principal both reach noteholders
 * through the PAYING AGENT contract - nothing is ever paid into the note
 * tokens.
 */
import {
  rpc,
  TransactionBuilder,
  Contract,
  BASE_FEE,
  Account,
  Keypair,
  scValToNative,
  nativeToScVal,
  Address,
  xdr,
} from "@stellar/stellar-sdk";
import { RPC_URL, NETWORK_PASSPHRASE } from "./trancheTx";

const EURC_DECIMALS = 7;
/** 100% in note-factor units (7 dp) - mirrors the abs-deal FACTOR_SCALE. */
const FACTOR_SCALE = 10_000_000;

export interface WaterfallClassState {
  /** Outstanding / original face, in percent (100 = par). */
  noteFactorPct: number;
  outstandingEurc: number;
  principalRepaidEurc: number;
}

export interface WaterfallState {
  /** One note of any class, in EURC (POC: 100). */
  noteDenominationEurc: number;
  /** Senior first, by on-chain class index (see trancheClassIndex()). */
  classes: WaterfallClassState[];
}

/**
 * Class index from the seniority label, for an old registry row that has no
 * class index. The reference deal has one class per label: A, B, C.
 */
export function seniorityIndex(seniority: "SENIOR" | "MEZZANINE" | "JUNIOR"): number {
  return seniority === "SENIOR" ? 0 : seniority === "MEZZANINE" ? 1 : 2;
}

/**
 * On-chain class index of a tranche (0 = most senior). The registry gives it.
 * The seniority label gives it only when the registry row has no class index.
 */
export function trancheClassIndex(tranche: {
  classIndex?: number | null;
  seniority: "SENIOR" | "MEZZANINE" | "JUNIOR";
}): number {
  return tranche.classIndex ?? seniorityIndex(tranche.seniority);
}

/** Class letter of an on-chain class index: 0 gives "A", 1 gives "B", and so on. */
export function classLetter(classIndex: number): string {
  return String.fromCharCode(65 + classIndex);
}

/** A failed read-only simulation. `detail` keeps the error text of the RPC. */
export class SimulationError extends Error {
  readonly detail: string;

  constructor(method: string, detail: string) {
    super(`simulation failed: ${method}`);
    this.name = "SimulationError";
    this.detail = detail;
  }
}

/** Read-only contract call through RPC simulation. Throws a SimulationError on a simulation error. */
export async function simulateCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<unknown> {
  const server = new rpc.Server(RPC_URL);
  const contract = new Contract(contractId);
  const simAccount = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(simAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new SimulationError(method, sim.error);
  }
  if (!sim.result?.retval) {
    throw new SimulationError(method, "no return value");
  }
  return scValToNative(sim.result.retval);
}

/* The deal config does not change after the deployment, so one read is enough. */
const denominationCache = new Map<string, bigint>();

/**
 * Face value of one note of the deal, in base units of the settlement asset
 * (`get_config().note_denomination`). Null when the read fails.
 */
export async function fetchNoteDenomination(dealContractId: string): Promise<bigint | null> {
  const cached = denominationCache.get(dealContractId);
  if (cached !== undefined) return cached;
  try {
    const config = (await simulateCall(dealContractId, "get_config")) as {
      note_denomination?: unknown;
    };
    const denomination = config.note_denomination;
    if (typeof denomination !== "bigint" || denomination <= BigInt(0)) return null;
    denominationCache.set(dealContractId, denomination);
    return denomination;
  } catch {
    return null;
  }
}

/**
 * The RPC gives this host error for a call to a function that the contract
 * does not export. The diagnostic text can also name the cause.
 */
function isMissingFunction(detail: string): boolean {
  return (
    detail.includes("Error(WasmVm, MissingValue)") ||
    detail.includes("non-existent contract function")
  );
}

/**
 * Whitelist check of the deal: `is_eligible(holder)`. An old deal (the
 * reference deal, Series 2) has no `is_eligible` function and no whitelist:
 * every address is then eligible. Null when the read fails for another
 * reason. The chain still checks each subscription.
 */
export async function fetchEligibility(
  dealContractId: string,
  address: string
): Promise<boolean | null> {
  try {
    const eligible = await simulateCall(dealContractId, "is_eligible", [
      new Address(address).toScVal(),
    ]);
    return typeof eligible === "boolean" ? eligible : null;
  } catch (e) {
    if (e instanceof SimulationError && isMissingFunction(e.detail)) return true;
    return null;
  }
}

export async function fetchWaterfallState(
  dealContractId: string
): Promise<WaterfallState | null> {
  try {
    const [factors, outstanding, config] = (await Promise.all([
      simulateCall(dealContractId, "get_note_factors"),
      simulateCall(dealContractId, "get_outstanding"),
      simulateCall(dealContractId, "get_config"),
    ])) as [
      bigint[],
      bigint[],
      { note_denomination: bigint; classes: { total_notes: bigint }[] },
    ];
    const classes = factors.map((factor, index) => {
      const nominal = outstanding[index] ?? BigInt(0);
      const initial =
        (config.classes[index]?.total_notes ?? BigInt(0)) * config.note_denomination;
      return {
        // Factors are stored in FACTOR_SCALE units (10_000_000 = 100%).
        noteFactorPct: Number(factor) / (FACTOR_SCALE / 100),
        outstandingEurc: Number(nominal) / 10 ** EURC_DECIMALS,
        principalRepaidEurc: Number(initial - nominal) / 10 ** EURC_DECIMALS,
      };
    });
    return {
      noteDenominationEurc: Number(config.note_denomination) / 10 ** EURC_DECIMALS,
      classes,
    };
  } catch {
    return null;
  }
}

/**
 * Pending funding-window subscription of `address` on `classIndex`, in whole
 * notes (0 when none, or on any failure).
 */
export async function fetchSubscription(
  dealContractId: string,
  classIndex: number,
  address: string
): Promise<number> {
  try {
    const notes = (await simulateCall(dealContractId, "get_subscription", [
      nativeToScVal(classIndex, { type: "u32" }),
      new Address(address).toScVal(),
    ])) as bigint;
    return Number(notes);
  } catch {
    return 0;
  }
}

export interface FundingProgress {
  /** Whole notes subscribed per class, senior first. */
  subscribedNotes: number[];
  /** Class sizes in whole notes, senior first. */
  totalNotes: number[];
}

/** Book-building progress of the funding window (null on any failure). */
export async function fetchFundingProgress(
  dealContractId: string
): Promise<FundingProgress | null> {
  try {
    const [totals, config] = (await Promise.all([
      simulateCall(dealContractId, "get_sub_totals"),
      simulateCall(dealContractId, "get_config"),
    ])) as [bigint[], { classes: { total_notes: bigint }[] }];
    return {
      subscribedNotes: totals.map(Number),
      totalNotes: config.classes.map((cls) => Number(cls.total_notes)),
    };
  } catch {
    return null;
  }
}

export interface ClaimableAmounts {
  interest: bigint; // base units
  principal: bigint; // base units
}

/**
 * Payments parked on the paying agent for `address` after a failed push -
 * claimable any time with `claim(holder)`.
 */
export async function fetchClaimable(
  payingAgentContractId: string,
  classIndex: number,
  address: string
): Promise<ClaimableAmounts> {
  try {
    const claimable = (await simulateCall(payingAgentContractId, "get_claimable", [
      nativeToScVal(classIndex, { type: "u32" }),
      new Address(address).toScVal(),
    ])) as { interest: bigint; principal: bigint };
    return { interest: claimable.interest, principal: claimable.principal };
  } catch {
    return { interest: BigInt(0), principal: BigInt(0) };
  }
}
