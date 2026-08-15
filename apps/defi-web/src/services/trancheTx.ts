/**
 * Onchain deal / note interactions signed by the user's wallet (Stellar
 * Wallets Kit). Flow: build invoke tx -> simulate/assemble (RPC) -> sign
 * (wallet) -> send -> poll. The dapp never touches a secret key; auth is
 * `require_auth(investor|from|holder)` onchain.
 *
 * Primary market: `subscribe`/`cancel` on the abs-deal contract during the
 * funding window only. After closing there is no deposit and no withdraw -
 * notes repay through the priority of payments; the remaining user actions
 * are note transfers (SEP-41) and claiming held paying-agent payments.
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

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
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
 * Balance of any Soroban token for an account, via simulated
 * `balance(address)` - works for EURC or USDC alike. Returns a display
 * amount (base units / 10^decimals); 0 on any failure. On a NOTE token
 * pass decimals = 0: the balance is an integer number of notes.
 */
export async function fetchTokenBalance(
  tokenContractId: string,
  address: string,
  decimals: number
): Promise<number> {
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
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return 0;
    const raw = scValToNative(sim.result.retval) as bigint;
    return Number(raw) / 10 ** decimals;
  } catch {
    return 0;
  }
}

function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // surface the contract error code when present, e.g. "Error(Contract, #13)"
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) return `Contract rejected the call (error #${m[1]}).`;
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

/**
 * Shared simulate -> sign -> send -> poll pipeline for any contract invoke
 * signed by the connected wallet. Resolves to the tx hash.
 */
async function submitInvoke(
  contractId: string,
  caller: string,
  method: string,
  args: xdr.ScVal[]
): Promise<{ hash: string }> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(caller);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  let prepared;
  try {
    // simulates, attaches soroban data + auth, bumps fee
    prepared = await server.prepareTransaction(tx);
  } catch (e) {
    throw new Error(readableError(e));
  }

  const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit");
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(prepared.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: caller,
  });

  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
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
 * number of notes (1 note = 100 EURC paid/refunded at par).
 */
export async function invokeDeal(
  method: "subscribe" | "cancel",
  opts: { dealContractId: string; caller: string; classIndex: number; notes: bigint }
): Promise<{ hash: string }> {
  return submitInvoke(opts.dealContractId, opts.caller, method, [
    new Address(opts.caller).toScVal(), // investor
    nativeToScVal(opts.classIndex, { type: "u32" }), // class (0=A, 1=B, 2=C)
    nativeToScVal(opts.notes, { type: "i128" }), // notes
  ]);
}

/**
 * SEP-41 `transfer(from, to, notes)` on a note token. Notes are integers
 * (decimals 0); the next coupon is split day-weighted between seller and
 * buyer at the next payment date.
 */
export async function transferNotes(opts: {
  noteContractId: string;
  from: string;
  to: string;
  notes: bigint;
}): Promise<{ hash: string }> {
  return submitInvoke(opts.noteContractId, opts.from, "transfer", [
    new Address(opts.from).toScVal(),
    new Address(opts.to).toScVal(),
    nativeToScVal(opts.notes, { type: "i128" }),
  ]);
}

/**
 * `claim(holder)` on the paying agent: pull any payments whose push failed
 * (missing trustline, frozen account...). Drains every class at once.
 */
export async function claimHeldPayments(opts: {
  payingAgentContractId: string;
  holder: string;
}): Promise<{ hash: string }> {
  return submitInvoke(opts.payingAgentContractId, opts.holder, "claim", [
    new Address(opts.holder).toScVal(),
  ]);
}
