import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { loadPool } from '../asset-pool/pool.js';
import {
  autoTokenMetadata,
  batteryTokenMetadata,
  obligorTokenMetadata,
  poolTokenMetadata,
} from './metadata.js';
import { putMetadata } from '../ipfs/store.js';
import { invokeSigned, addressArg, servicerPublicKey } from '../waterfall/soroban.js';
import { saveRegistry, type MintedToken, type NftRegistry } from './registry.js';
import { environment } from '../config.js';

/**
 * Mints the Data Spec Book's 61 tokens: 20 Auto + 20 Battery + 20 Obligor + 1
 * Pool. Metadata goes to the content-addressed store first (real CIDv1), then
 * mint_batch() writes ipfs://CID URIs on-chain in chunks - 7 transactions total.
 */
const BATCH_SIZE = 10;

const contractsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contracts.json',
);
const contracts = JSON.parse(readFileSync(contractsPath, 'utf8')) as Record<
  'auto' | 'battery' | 'obligor' | 'pool',
  string
>;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mintBatches(
  tokenType: MintedToken['tokenType'],
  contractId: string,
  entries: { vin: string | null; cid: string }[],
): Promise<MintedToken[]> {
  const holder = servicerPublicKey();
  const minted: MintedToken[] = [];
  for (const batch of chunk(entries, BATCH_SIZE)) {
    const uris = batch.map((entry) => `ipfs://${entry.cid}`);
    const urisArg = xdr.ScVal.scvVec(uris.map((uri) => xdr.ScVal.scvString(uri)));
    const outcome = (await invokeSigned(contractId, 'mint_batch', [
      addressArg(holder),
      urisArg,
    ])) as { hash: string; result: unknown };
    const ids = (outcome.result as number[] | bigint[]).map(Number);
    ids.forEach((tokenId, index) => {
      const entry = batch[index];
      if (!entry) return;
      minted.push({
        tokenType,
        contractId,
        tokenId,
        vin: entry.vin,
        cid: entry.cid,
        tokenUri: `ipfs://${entry.cid}`,
        txHash: outcome.hash,
      });
    });
    console.log(`[${tokenType}] minted ${ids.length} tokens (tx ${outcome.hash.slice(0, 8)})`);
  }
  return minted;
}

async function main(): Promise<void> {
  const pool = loadPool();
  const vehicleCids: Record<string, { auto: string; battery: string; obligor: string }> = {};

  const autoEntries: { vin: string; cid: string }[] = [];
  const batteryEntries: { vin: string; cid: string }[] = [];
  const obligorEntries: { vin: string; cid: string }[] = [];

  for (const entry of pool.vehicles) {
    const autoCid = await putMetadata(autoTokenMetadata(entry));
    const batteryCid = await putMetadata(batteryTokenMetadata(entry));
    const obligorCid = await putMetadata(obligorTokenMetadata(entry));
    vehicleCids[entry.vin] = { auto: autoCid, battery: batteryCid, obligor: obligorCid };
    autoEntries.push({ vin: entry.vin, cid: autoCid });
    batteryEntries.push({ vin: entry.vin, cid: batteryCid });
    obligorEntries.push({ vin: entry.vin, cid: obligorCid });
  }
  console.log(`stored ${pool.vehicles.length * 3} metadata objects in the local IPFS store`);

  const poolCid = await putMetadata(
    poolTokenMetadata(pool, {
      autoTokenContract: contracts.auto,
      batteryTokenContract: contracts.battery,
      obligorTokenContract: contracts.obligor,
      vehicleCids,
    }),
  );
  console.log(`pool metadata CID: ${poolCid}`);

  const tokens: MintedToken[] = [
    ...(await mintBatches('auto', contracts.auto, autoEntries)),
    ...(await mintBatches('battery', contracts.battery, batteryEntries)),
    ...(await mintBatches('obligor', contracts.obligor, obligorEntries)),
    ...(await mintBatches('pool', contracts.pool, [{ vin: null, cid: poolCid }])),
  ];

  const registry: NftRegistry = {
    network: environment.NETWORK_PASSPHRASE,
    admin: servicerPublicKey(),
    mintedAt: new Date().toISOString(),
    contracts,
    tokens,
  };
  saveRegistry(registry);
  console.log(`registry written: ${tokens.length} tokens across 4 contracts`);
}

await main();
