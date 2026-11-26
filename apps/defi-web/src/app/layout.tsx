import type { Metadata } from "next";
import { Caladea, Carlito } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";

// Metric-compatible free stand-ins for Eric's brand fonts: Caladea matches
// Cambria (titles), Carlito matches Calibri (text). The real MS fonts win
// when installed (they lead the Tailwind stacks); these self-hosted
// webfonts guarantee the same rendering everywhere else.
const caladea = Caladea({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-caladea" });
const carlito = Carlito({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-carlito" });

export const metadata: Metadata = {
  title: "CARA7 - Investor Dashboard",
  description:
    "Invest in tokenized ABS notes on Stellar - subscribe at issuance, get repaid through the priority of payments",
  icons: { icon: "/cara7-logo.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${caladea.variable} ${carlito.variable}`}>
      <head>
        {/* Re-apply the persisted theme before first paint (default: light). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}",
          }}
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
