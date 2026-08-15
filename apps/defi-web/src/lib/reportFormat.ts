import type { Locale } from "@/lib/i18n";

/**
 * Locale-aware formatters for the investor report. Explicit BCP 47 tags so
 * output is stable whatever the browser locale: en → en-GB, fr → fr-FR.
 * All formats reproduce the dashboard mockups verbatim.
 */
const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", fr: "fr-FR" };

/**
 * "€574.3m" / "574,3 M€". Built manually from (eur / 1e6): at least 1
 * decimal, up to 2 so the reserve and cushion totals print "€5.15m" /
 * "79,55 M€" exactly like the mockups.
 */
export function fmtMillions(locale: Locale, eur: number): string {
  const millions = (eur / 1e6).toLocaleString(INTL_LOCALE[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
  return locale === "fr" ? `${millions} M€` : `€${millions}m`;
}

/** "€746,886" / "746 886 €" - Intl EUR currency, whole euros. */
export function fmtEur(locale: Locale, eur: number): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(eur);
}

/**
 * "0.06%" / "0,06%". Manual "%" suffix: Intl style:"percent" would multiply
 * by 100 and fr-FR would insert a space before "%" - the mockups have none.
 */
export function fmtPct(locale: Locale, value: number, decimals: number): string {
  const formatted = value.toLocaleString(INTL_LOCALE[locale], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${formatted}%`;
}

/**
 * "31 Jan 2026" / "31 janv. 2026". The calendar date is parsed with Date.UTC
 * and rendered in UTC so the local timezone can never shift the day.
 */
/**
 * Date + time ("3 Aug 2026, 18:36") for on-chain event timestamps: several
 * demo waterfall periods can run the same day, the time keeps rows distinct.
 */
export function fmtDateTime(locale: Locale, iso: string): string {
  return new Date(iso).toLocaleString(INTL_LOCALE[locale], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDate(locale: Locale, iso: string): string {
  const [year = 1970, month = 1, day = 1] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
    INTL_LOCALE[locale],
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }
  );
}

/**
 * "Jul" / "juil." from "2025-07" (Date.UTC parse - no timezone off-by-one).
 * en-GB emits "July"/"Sept"; the mockup x-axis uses 3-letter forms, so the
 * EN label is truncated to 3 characters.
 */
export function fmtMonthShort(locale: Locale, isoMonth: string): string {
  const [year = 1970, month = 1] = isoMonth.split("-").map(Number);
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(
    INTL_LOCALE[locale],
    { month: "short", timeZone: "UTC" }
  );
  return locale === "en" ? label.slice(0, 3) : label;
}

/** "€250k" / "250 k€" - y-axis ticks of the net-losses chart. */
export function fmtEurK(locale: Locale, eur: number): string {
  const thousands = (eur / 1000).toLocaleString(INTL_LOCALE[locale], {
    maximumFractionDigits: 1,
  });
  return locale === "fr" ? `${thousands} k€` : `€${thousands}k`;
}
