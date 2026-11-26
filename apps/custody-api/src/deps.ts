import type { PasskeyVerifier } from './auth/passkeys.js';
import type { CustodyProvider } from './custody/port.js';
import type { WalletFunder } from './funding/friendbot.js';
import type { Policy, StellarNetwork } from './policy/policy.js';
import type { CustodyStore } from './store/port.js';

export interface AppLogger {
  info(message: string): void;
  error(message: string, detail?: unknown): void;
}

/// Everything the HTTP app needs. server.ts builds the real ports from the
/// environment. The tests give an in-memory store and fakes.
export type AppDependencies = {
  store: CustodyStore;
  custody: CustodyProvider;
  passkeys: PasskeyVerifier;
  funder: WalletFunder;
  policy: Policy;
  network: StellarNetwork;
  corsOrigin: string;
  sessionTtlHours: number;
  now: () => Date;
  log: AppLogger;
};

export const consoleLogger: AppLogger = {
  info: (message) => console.log(message),
  error: (message, detail) => console.error(message, detail ?? ''),
};
