import { SorobanDataBuilder, type rpc } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { RESOURCE_FEE_MARGIN_STROOPS, WRITE_MARGIN_BYTES, withResourceMargin } from '../src/waterfall/soroban.js';

/** The figures of the `push_batch` that failed on testnet on 2026-11-23. */
const SIMULATED = { instructions: 3_418_368, readBytes: 0, writeBytes: 744, fee: 136_769n };
const REAL_WRITE_BYTES = 968;

const BALANCE_ENTRY_BYTES = 224;
const TRUSTLINE_BYTES = 116;
const HOLDERS_PER_BATCH = 10;

function simulation(): rpc.Api.SimulateTransactionSuccessResponse {
  const transactionData = new SorobanDataBuilder()
    .setResources(SIMULATED.instructions, SIMULATED.readBytes, SIMULATED.writeBytes)
    .setResourceFee(SIMULATED.fee.toString());
  return { transactionData } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

describe('the resource margin of a Soroban transaction', () => {
  it('adds the write margin and the fee margin, and keeps the other resources', () => {
    const simulated = simulation();
    withResourceMargin(simulated);
    const data = simulated.transactionData.build();
    const resources = data.resources();
    expect(resources.instructions()).toBe(SIMULATED.instructions);
    expect(resources.diskReadBytes()).toBe(SIMULATED.readBytes);
    expect(resources.writeBytes()).toBe(SIMULATED.writeBytes + WRITE_MARGIN_BYTES);
    expect(data.resourceFee().toBigInt()).toBe(SIMULATED.fee + RESOURCE_FEE_MARGIN_STROOPS);
  });

  it('covers the write bytes of the failed push and of the worst batch', () => {
    const simulated = simulation();
    withResourceMargin(simulated);
    const declared = simulated.transactionData.build().resources().writeBytes();
    expect(declared).toBeGreaterThanOrEqual(REAL_WRITE_BYTES);
    expect(WRITE_MARGIN_BYTES).toBeGreaterThanOrEqual(BALANCE_ENTRY_BYTES + TRUSTLINE_BYTES * HOLDERS_PER_BATCH);
  });
});
