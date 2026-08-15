"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import type { LocalizedText } from "@/data/report";

/** Green compliance chips ("No Enforcement Event", ...). */
export function StatusBadges({ badges }: { badges: LocalizedText[] }): ReactNode {
  const { locale } = useLocale();

  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {badges.map((badge) => (
        <span
          key={badge.en}
          className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
        >
          <Check size={13} aria-hidden />
          {badge[locale]}
        </span>
      ))}
    </div>
  );
}
