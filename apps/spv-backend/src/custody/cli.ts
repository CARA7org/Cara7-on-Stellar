import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the file at `moduleUrl` is the script that Node runs. */
export function isMainModule(moduleUrl: string): boolean {
  const script = process.argv[1];
  return script !== undefined && path.resolve(script) === fileURLToPath(moduleUrl);
}

/** pnpm can put a "--" before the script arguments. */
export function scriptArguments(argv: string[] = process.argv.slice(2)): string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

/** Runs a CLI main function and prints a readable error with exit code 1. */
export function runCli(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
