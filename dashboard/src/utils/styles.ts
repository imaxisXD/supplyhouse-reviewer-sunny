/**
 * Shared CSS class constants used across dashboard pages.
 * Eliminates duplication of identical Tailwind class strings.
 */

export const panelClass = "border border-ink-900 bg-white p-4";
export const panelSoftClass = "border border-dashed border-ink-900 bg-warm-50 p-4";
export const panelTitleClass = "text-[10px] uppercase tracking-[0.35em] text-ink-600";

export const labelClass = "text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-600";
export const inputClass =
  "w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500";

export const buttonPrimaryClass =
  "inline-flex items-center justify-center gap-2 border border-brand-500 bg-brand-500 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60";
export const buttonSecondaryClass =
  "inline-flex items-center justify-center gap-2 border border-ink-900 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-ink-700 transition hover:bg-warm-100 disabled:cursor-not-allowed disabled:opacity-60";

export const statCardClass = "border border-ink-900 bg-white p-4";
export const statLabelClass = "text-[10px] uppercase tracking-[0.3em] text-ink-600";
export const statValueClass = "mt-2 text-xl font-semibold text-ink-950";

export const tableHeaderClass = "px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-ink-600";
export const tableRowClass = "border-t border-ink-900 hover:bg-warm-100/60 transition";
export const tableCellClass = "px-4 py-3 text-ink-700";

export const badgeBrandClass =
  "inline-flex items-center gap-1 border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-700";
export const badgeBaseClass =
  "inline-flex items-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em]";
