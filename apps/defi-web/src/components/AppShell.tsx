"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Toaster } from "react-hot-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import Footer from "@/components/Footer";
import ThemeToggle from "@/components/ThemeToggle";
import LanguageToggle from "@/components/LanguageToggle";
import { LocaleProvider, useLocale } from "@/lib/i18n";

const StellarWalletProvider = dynamic(
  () => import("@/components/stellar/StellarWalletProvider"),
  { ssr: false }
);
const StellarConnectButton = dynamic(
  () => import("@/components/stellar/StellarConnectButton"),
  { ssr: false }
);

/** Header lives in its own component so it can read the locale context. */
function Header() {
  const { dictionary } = useLocale();
  return (
    <header className="flex items-center justify-between py-5">
      <Link href="/" className="flex items-baseline gap-2">
        {/* Official CARA7 logotype (brandbook v1.2), light/dark variants */}
        <img src="/cara7-logo.svg" alt="CARA7" className="h-9 w-auto dark:hidden" />
        <img src="/cara7-logo-dark.svg" alt="CARA7" className="hidden h-9 w-auto dark:block" />
      </Link>
      <div className="flex items-center gap-5">
        <Link
          href="/portfolio"
          className="text-sm text-gray-700 dark:text-gray-300 transition-colors hover:text-gray-900 dark:hover:text-white"
        >
          {dictionary.navPortfolio}
        </Link>
        <LanguageToggle />
        <ThemeToggle />
        <StellarConnectButton />
      </div>
    </header>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <StellarWalletProvider>
      <LocaleProvider>
        <TooltipProvider>
        <div className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col px-4">
          <Header />
          <main className="flex-1 pb-16">{children}</main>
        </div>
          <Footer />
          <Toaster toastOptions={{ duration: 8000 }} />
        </TooltipProvider>
      </LocaleProvider>
    </StellarWalletProvider>
  );
}
