/**
 * Seniority color system, lifted from the CARA7 investor dashboard mockup:
 * Senior = blue, Mezzanine = green, Junior = orange. Dark-theme friendly.
 */
export type Seniority = "SENIOR" | "MEZZANINE" | "JUNIOR";

export const SENIORITY_COLOR: Record<Seniority, string> = {
  SENIOR: "#3B82F6",
  MEZZANINE: "#10B981",
  JUNIOR: "#F97316",
};

export const SENIORITY_BADGE: Record<Seniority, string> = {
  SENIOR: "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800",
  MEZZANINE: "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800",
  JUNIOR: "bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-800",
};

export function SeniorityDot({ seniority }: { seniority: Seniority }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: SENIORITY_COLOR[seniority] }}
    />
  );
}
