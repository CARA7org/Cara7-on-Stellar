import cron from 'node-cron';
import { createDfnsClient } from '../custody/client.js';
import { consoleLogger } from '../deps.js';
import { loadPolicy } from '../policy/policy.js';
import { createChecker } from './checker.js';
import { cronExpression, parseCheckerEnvironment } from './config.js';
import { createDfnsApprovals } from './dfns.js';

// The checker process (pnpm checker). It uses only the checker service
// account. In production it runs on a separate host from the server.

const environment = parseCheckerEnvironment(process.env);
const policy = loadPolicy(environment.STELLAR_NETWORK);
const client = createDfnsClient({
  apiUrl: environment.DFNS_API_URL,
  orgId: environment.DFNS_ORG_ID,
  authToken: environment.CHECKER_DFNS_AUTH_TOKEN,
  credId: environment.CHECKER_DFNS_CRED_ID,
  privateKey: environment.CHECKER_DFNS_PRIVATE_KEY,
});
const checker = createChecker({
  approvals: createDfnsApprovals(client),
  policy,
  now: () => new Date(),
  log: consoleLogger,
});

const seconds = environment.CHECKER_INTERVAL_SECONDS;
cron.schedule(cronExpression(seconds), () => {
  void checker.tick();
});
console.log(
  `checker: ${environment.STELLAR_NETWORK}, ${policy.deals.length} deals, every ${seconds}s`,
);
void checker.tick(); // first cycle right away
