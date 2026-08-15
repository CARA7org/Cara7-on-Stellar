import { nativeToScVal } from '@stellar/stellar-sdk';
import { environment } from '../config.js';
import { invokeSigned, readContract } from '../waterfall/soroban.js';

/**
 * EURIBOR 1M relay - the off-chain leg of the Data Spec Book's rate oracle.
 *
 * Chainlink has no native Stellar/Soroban integration, so the reference
 * architecture (docs/tranche-rates.md, improvement note section 4) is a
 * relay: obtain the fixing from a Chainlink Function in production - the POC
 * reads the EMMI fixing mirrored by euribor-rates.eu - then sign and push it
 * to the RateOracle contract, which enforces staleness and deviation checks
 * on-chain. Run with `pnpm oracle:push` (cron-able; the prospectus cadence
 * is the Interest Determination Date, 2 business days before each period).
 */
interface Fixing {
  ratePct: number;
  date: string;
}

/// POC source: EMMI fixing via euribor-rates.eu. Production: Chainlink Function.
async function fetchEuribor1M(): Promise<Fixing> {
  const response = await fetch(
    'https://www.euribor-rates.eu/en/current-euribor-rates/1/euribor-rate-1-month/',
    { headers: { 'user-agent': 'trueabs-poc-oracle-relay' } },
  );
  if (!response.ok) throw new Error(`euribor-rates.eu -> HTTP ${response.status}`);
  const html = await response.text();
  // First data row of the fixing table: a date cell followed by a rate cell.
  const match = html.match(/(\d{1,2}\/\d{1,2}\/\d{4})[\s\S]{0,200}?(-?\d+\.\d+)\s*%/);
  if (!match?.[1] || !match?.[2]) throw new Error('Fixing not found in the page');
  return { ratePct: Number(match[2]), date: match[1] };
}

async function main(): Promise<void> {
  const override = process.argv[2];
  const fixing: Fixing = override
    ? { ratePct: Number(override), date: 'manual override' }
    : await fetchEuribor1M();
  if (!Number.isFinite(fixing.ratePct)) throw new Error('Invalid fixing value');

  // Contract unit: thousandths of a percent (2.209% -> 2209), signed.
  const units = Math.round(fixing.ratePct * 1000);
  const timestamp = Math.floor(Date.now() / 1000);
  console.log(
    `[oracle-relay] EURIBOR 1M = ${fixing.ratePct}% (${fixing.date}) -> ${units} units`,
  );

  const outcome = (await invokeSigned(environment.RATE_ORACLE_CONTRACT_ID, 'set_rate', [
    nativeToScVal(BigInt(units), { type: 'i128' }),
    nativeToScVal(timestamp, { type: 'u64' }),
  ])) as { hash: string };
  console.log(`[oracle-relay] pushed (tx ${outcome.hash.slice(0, 8)})`);

  const last = (await readContract(environment.RATE_ORACLE_CONTRACT_ID, 'lastprice')) as {
    price: bigint;
    timestamp: bigint;
  } | null;
  console.log(`[oracle-relay] on-chain lastprice: ${last?.price} units`);
}

await main();
