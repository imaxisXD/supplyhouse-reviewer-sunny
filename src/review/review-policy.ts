import type { Finding } from "../types/findings.ts";
import type { ReviewPolicy } from "./strategies/index.ts";

const LEGACY_BROWSER_PATTERN = /\b(optional chaining|older browsers|internet explorer|ie11|ie 11|legacy browser)\b/i;

export function applyReviewPolicy(
  findings: Finding[],
  policy: ReviewPolicy,
): { findings: Finding[]; dropped: number } {
  if (!policy.suppressLegacyBrowserWarnings) {
    return { findings, dropped: 0 };
  }

  const kept: Finding[] = [];
  let dropped = 0;

  for (const finding of findings) {
    const text = `${finding.title} ${finding.description}`;
    if (!LEGACY_BROWSER_PATTERN.test(text)) {
      kept.push(finding);
      continue;
    }

    if (policy.suppressLegacyBrowserWarningsInTemplatesOnly) {
      const file = finding.file ?? "";
      const isTemplate = policy.templateExtensions.some((ext) => file.endsWith(ext));
      if (!isTemplate) {
        kept.push(finding);
        continue;
      }
    }

    dropped++;
  }

  return { findings: kept, dropped };
}
