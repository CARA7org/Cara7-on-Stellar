export default function Footer() {
  return (
    <footer className="mt-12 border-t border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 py-8">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 px-4 text-sm text-gray-600 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center">
          <img src="/cara7-logo.svg" alt="CARA7" className="h-6 w-auto dark:hidden" />
          <img src="/cara7-logo-dark.svg" alt="CARA7" className="hidden h-6 w-auto dark:block" />
        </span>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 rounded-full border border-gray-300 dark:border-neutral-700 px-2.5 py-0.5 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Stellar Testnet
          </span>
          <a
            href="https://stellar.expert/explorer/testnet"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Explorer
          </a>
        </div>
      </div>
    </footer>
  );
}
