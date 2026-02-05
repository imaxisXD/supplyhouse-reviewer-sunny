import * as fs from "fs";
import * as path from "path";
import { getIndexingStrategyId } from "../../indexing/strategies/index.ts";
import type { DiffIndex } from "../diff-indexer.ts";
import type { Finding } from "../../types/findings.ts";
import { generateOFBizAutoStampFindings } from "./ofbiz.ts";

export interface ReviewPolicy {
  suppressLegacyBrowserWarnings: boolean;
  suppressLegacyBrowserWarningsInTemplatesOnly: boolean;
  templateExtensions: string[];
}

export interface ReviewStrategy {
  id: string;
  policy: ReviewPolicy;
  extraFindings: (diffIndex: DiffIndex) => Finding[];
  hints: string[];
}

export function getReviewStrategy(repoId: string, repoPath?: string): ReviewStrategy {
  const strategyId = getIndexingStrategyId(repoId);
  if (strategyId === "ofbiz-supplyhouse") {
    return {
      id: strategyId,
      policy: {
        suppressLegacyBrowserWarnings: true,
        suppressLegacyBrowserWarningsInTemplatesOnly: true,
        templateExtensions: [".ftl"],
      },
      extraFindings: generateOFBizAutoStampFindings,
      hints: [
        "OFBiz repository detected. Audit fields are auto-stamped unless no-auto-stamp is true.",
        "FTL templates: avoid browser-compat warnings unless legacy targets are explicitly configured.",
      ],
    };
  }

  return {
    id: strategyId,
    policy: {
      suppressLegacyBrowserWarnings: false,
      suppressLegacyBrowserWarningsInTemplatesOnly: true,
      templateExtensions: [".ftl"],
    },
    extraFindings: () => [],
    hints: detectLegacyBrowserTargets(repoPath)
      ? ["Legacy browser targets detected; browser-compat warnings are allowed."]
      : [],
  };
}

function detectLegacyBrowserTargets(repoPath?: string): boolean {
  if (!repoPath) return false;
  const browserslistFile = path.join(repoPath, ".browserslistrc");
  if (fs.existsSync(browserslistFile)) {
    const contents = fs.readFileSync(browserslistFile, "utf-8");
    if (containsLegacyBrowser(contents)) return true;
  }

  const packageJson = path.join(repoPath, "package.json");
  if (fs.existsSync(packageJson)) {
    try {
      const raw = fs.readFileSync(packageJson, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const browserslist = pkg.browserslist as unknown;
      if (Array.isArray(browserslist) && browserslist.some((entry) => typeof entry === "string" && containsLegacyBrowser(entry))) {
        return true;
      }
      if (browserslist && typeof browserslist === "object") {
        const values = Object.values(browserslist as Record<string, unknown>);
        if (values.some((value) => Array.isArray(value) && value.some((entry) => typeof entry === "string" && containsLegacyBrowser(entry)))) {
          return true;
        }
      }
    } catch {
      return false;
    }
  }

  return false;
}

function containsLegacyBrowser(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("ie ") || normalized.includes("ie11") || normalized.includes("internet explorer");
}
