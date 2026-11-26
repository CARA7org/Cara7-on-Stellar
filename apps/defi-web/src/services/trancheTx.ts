/**
 * Onchain deal and note actions. The connected wallet signs each action.
 * Flow: build the invoke transaction, simulate and prepare it (RPC), sign
 * it, send it, then poll for the result. The dapp never touches a secret
 * key. The contracts check `require_auth(investor|from|holder)`.
 *
 * Two signers can sign (see services/signers). The Stellar Wallets Kit
 * signs for a self-custody wallet. The custody API signs for a Dfns policy
 * wallet. A Dfns signature can wait for a policy approval: the pipeline
 * then polls the approval and sends the transaction after the approval.
 *
 * Primary market: the investor calls `subscribe` and `cancel` on the
 * abs-deal contract during the funding window only. After the closing, no
 * deposit and no withdrawal occur. The notes repay through the priority of
 * payments. The other user actions are note transfers (SEP-41) and the
 * claim of the payments that the paying agent holds.
 */
import {
  rpc,
  TransactionBuilder,
  Contract,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
} from "@stellar/stellar-sdk";
import {
  connectedSigner,
  signAndSubmit,
  type PendingContext,
  type SignedTransaction,
  type TxOptions,
} from "./signers";

export type { TxOptions } from "./signers";

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx";

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_TX}/${hash}`;
}

/** "12.34" -> 123400000n (string math; no float drift). */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [int, frac = ""] = amount.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(int || "0") * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || "0")
  );
}

/** Native XLM balance of an account (0 if unfunded/unreachable). */
export async function fetchNativeBalance(address: string): Promise<number> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`, { cache: "no-store" });
    if (!res.ok) return 0;
    const acc = (await res.json()) as {
      balances: { asset_type: string; balance: string }[];
    };
    const native = acc.balances.find((b) => b.asset_type === "native");
    return native ? Number(native.balance) : 0;
  } catch {
    return 0;
  }
}

/**
 * Balance of any Soroban token for an account, in base units, via simulated
 * `balance(address)`. Exact (bigint). 0 on any failure.
 */
export async function fetchTokenBalanceUnits(
  tokenContractId: string,
  address: string
): Promise<bigint> {
  try {
    const { Account, Keypair, scValToNative } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server(RPC_URL);
    const contract = new Contract(tokenContractId);
    const simAccount = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(simAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("balance", new Address(address).toScVal()))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return BigInt(0);
    const raw = scValToNative(sim.result.retval);
    return typeof raw === "bigint" ? raw : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

/**
 * Balance of any Soroban token for an account - works for EURC or USDC
 * alike. Returns a display amount (base units / 10^decimals); 0 on any
 * failure. On a NOTE token pass decimals = 0: the balance is an integer
 * number of notes.
 */
export async function fetchTokenBalance(
  tokenContractId: string,
  address: string,
  decimals: number
): Promise<number> {
  const raw = await fetchTokenBalanceUnits(tokenContractId, address);
  return Number(raw) / 10 ** decimals;
}

/** Deal error: the investor is not on the whitelist of the deal (new deals only). */
export const DEAL_ERROR_NOT_ELIGIBLE = 15;
/** Note-token error: the receiver of a transfer is not on the whitelist (new deals only). */
export const NOTE_ERROR_RECEIVER_NOT_ELIGIBLE = 9;

/**
 * The simulation rejected a contract call with a contract error code. The
 * UI uses `method` and `code` to show a known error in the user's language.
 */
export class ContractCallError extends Error {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(message);
    this.name = "ContractCallError";
    this.method = method;
    this.code = code;
  }
}

/** The contract error code in a host error, e.g. 13 for "Error(Contract, #13)". */
function contractErrorCode(msg: string): number | null {
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  return m ? Number(m[1]) : null;
}

function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // surface the contract error code when present, e.g. "Error(Contract, #13)"
  const code = contractErrorCode(msg);
  if (code !== null) return `Contract rejected the call (error #${code}).`;
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

/** The error of a failed prepare. A contract error code gives a ContractCallError. */
function prepareError(method: string, e: unknown): Error {
  const code = contractErrorCode(e instanceof Error ? e.message : String(e));
  const message = readableError(e);
  return code !== null ? new ContractCallError(method, code, message) : new Error(message);
}

/**
 * Shared simulate -> sign -> send -> poll pipeline for any contract invoke
 * signed by the connected wallet. Resolves to the tx hash.
 */
async function submitInvoke(
  contractId: string,
  caller: string,
  method: string,
  args: xdr.ScVal[],
  options: TxOptions = {}
): Promise<{ hash: string }> {
  const server = new rpc.Server(RPC_URL);
  const signer = connectedSigner();
  const account = await server.getAccount(caller);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(signer.txTimeoutSeconds)
    .build();

  let prepared;
  try {
    // simulates, attaches soroban data + auth, bumps fee
    prepared = await server.prepareTransaction(tx);
  } catch (e) {
    throw prepareError(method, e);
  }

  // THE SEAM: the signer of the connected provider signs the prepared envelope.
  // A Dfns signature can wait for a policy approval. Then the send comes after the approval.
  return signAndSubmit(
    signer,
    prepared,
    {
      address: caller,
      networkPassphrase: NETWORK_PASSPHRASE,
      onAwaitingApproval: options.onAwaitingApproval,
      pending: pendingContextOf(method),
    },
    sendAndPoll
  );
}

/** The kind of action that a saved pending handle records. A transfer has no handle. */
function pendingContextOf(method: string): PendingContext | undefined {
  if (method === "subscribe" || method === "cancel" || method === "claim") {
    return { kind: method, submitVia: "soroban" };
  }
  return undefined;
}

/** Sends a signed invoke transaction, then polls until the ledger includes it. */
export async function sendAndPoll(signed: SignedTransaction): Promise<{ hash: string }> {
  const server = new rpc.Server(RPC_URL);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submission failed (${sent.status}).`);
  }

  // poll until the ledger includes it (~5s close time)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === "SUCCESS") return { hash: sent.hash };
    if (res.status === "FAILED") {
      throw new Error("Transaction failed onchain.");
    }
  }
  throw new Error("Timed out waiting for confirmation.");
}

/**
 * Invoke `subscribe(investor, class, notes)` or `cancel(investor, class,
 * notes)` on the abs-deal contract - funding window only. `notes` is a whole
 * number of notes. The deal pays or refunds each note at par: one
 * `note_denomination` of the settlement asset.
 */
export async function invokeDeal(
  method: "subscribe" | "cancel",
  opts: { dealContractId: string; caller: string; classIndex: number; notes: bigint },
  options: TxOptions = {}
): Promise<{ hash: string }> {
  return submitInvoke(
    opts.dealContractId,
    opts.caller,
    method,
    [
      new Address(opts.caller).toScVal(), // investor
      nativeToScVal(opts.classIndex, { type: "u32" }), // on-chain class index (0 = Class A)
      nativeToScVal(opts.notes, { type: "i128" }), // notes
    ],
    options
  );
}

/**
 * SEP-41 `transfer(from, to, notes)` on a note token. Notes are integers
 * (decimals 0); the next coupon is split day-weighted between seller and
 * buyer at the next payment date.
 */
export async function transferNotes(
  opts: { noteContractId: string; from: string; to: string; notes: bigint },
  options: TxOptions = {}
): Promise<{ hash: string }> {
  return submitInvoke(
    opts.noteContractId,
    opts.from,
    "transfer",
    [
      new Address(opts.from).toScVal(),
      new Address(opts.to).toScVal(),
      nativeToScVal(opts.notes, { type: "i128" }),
    ],
    options
  );
}

/**
 * `claim(holder)` on the paying agent: pull any payments whose push failed
 * (missing trustline, frozen account...). Drains every class at once.
 */
export async function claimHeldPayments(
  opts: { payingAgentContractId: string; holder: string },
  options: TxOptions = {}
): Promise<{ hash: string }> {
  return submitInvoke(
    opts.payingAgentContractId,
    opts.holder,
    "claim",
    [new Address(opts.holder).toScVal()],
    options
  );
}
