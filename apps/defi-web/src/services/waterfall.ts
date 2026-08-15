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
  /** Senior first - index with seniorityIndex(). */
  classes: WaterfallClassState[];
}

/** Deal class order is senior -> junior, like the registry rows. */
export function seniorityIndex(seniority: "SENIOR" | "MEZZANINE" | "JUNIOR"): number {
  return seniority === "SENIOR" ? 0 : seniority === "MEZZANINE" ? 1 : 2;
}

async function simulateCall(
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
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) {
    throw new Error(`simulation failed: ${method}`);
  }
  return scValToNative(sim.result.retval);
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
