"use client";

import type { ReactNode } from "react";
import { useLocale, type Locale } from "@/lib/i18n";

const LOCALES: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "fr", label: "FR" },
];

/**
 * EN|FR two-segment pill, styled like ThemeToggle. The active segment gets
 * the report accent; the choice persists via LocaleProvider (localStorage
 * "lang", fail-soft).
 */
export default function LanguageToggle(): ReactNode {
  const { locale, setLocale } = useLocale();

  return (
    <div className="flex items-center gap-0.5 rounded-full border border-gray-300 p-0.5 dark:border-neutral-700">
      {LOCALES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setLocale(value)}
          aria-pressed={locale === value}
          aria-label={value === "en" ? "Switch to English" : "Passer en français"}
          className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
            locale === value
              ? "bg-[#570a61] text-white"
              : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
