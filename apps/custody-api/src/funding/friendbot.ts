// The funding port. On testnet, Friendbot creates and funds each new
// investor account, so that the account can pay its own fees.

export interface WalletFunder {
  fund(address: string): Promise<void>;
}

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundingError';
  }
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/// One HTTP GET to Friendbot. An account that exists already counts as funded.
export function createFriendbotFunder(friendbotUrl: string, fetcher: Fetch = fetch): WalletFunder {
  return {
    async fund(address) {
      const url = new URL(friendbotUrl);
      url.searchParams.set('addr', address);
      let response: Awaited<ReturnType<Fetch>>;
      try {
        response = await fetcher(url.toString());
      } catch (error) {
        throw new FundingError(`Friendbot did not answer: ${(error as Error).message}`);
      }
      if (response.ok) return;
      const body = await response.text().catch(() => '');
      if (response.status === 400 && /already|op_already_exists|createAccountAlreadyExist/i.test(body)) {
        return;
      }
      throw new FundingError(`Friendbot answered HTTP ${response.status}.`);
    },
  };
}

/// On mainnet there is no Friendbot. The investor funds the account.
export const noFunding: WalletFunder = { async fund() {} };
