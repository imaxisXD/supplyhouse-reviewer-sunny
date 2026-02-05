import type { DiffFile } from "../types/bitbucket.ts";
import type { Finding, Severity } from "../types/findings.ts";
import type { FileDomainFacts } from "./domain-facts.ts";
import * as fs from "fs";
import * as path from "path";

export interface EvidenceGateOptions {
  repoPath: string;
  diffFiles: DiffFile[];
  domainFactsByFile?: Map<string, FileDomainFacts>;
  strategyId?: string;
}

export interface EvidenceGateStats {
  dropped: number;
  downgraded: number;
  droppedEntityFields: number;
  downgradedSecurity: number;
  droppedLegacyBrowser: number;
  legacyTargetsDetected: boolean;
}

const FRONTEND_EXTENSIONS = [".ftl", ".js", ".css", ".html", ".htm"];
const IDOR_REGEX = /\b(insecure direct object|idor)\b/i;
const CSRF_REGEX = /\bcsrf|cross[- ]site request forgery\b/i;
const ENTITY_FIELD_REGEX = /\b(entity model|entity field|column not found|migration|schema|table|fields?)\b/i;
const LEGACY_BROWSER_PATTERN = /\b(optional chaining|older browsers|internet explorer|ie11|ie 11|legacy browser|pre-chromium|edge legacy)\b/i;

function isFrontendFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return FRONTEND_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function extractEndpoints(text: string): string[] {
  const matches = text.match(/\/[A-Za-z0-9][A-Za-z0-9/_-]*/g) ?? [];
  return uniqueStrings(matches);
}

function hasBackendEvidence(diffFiles: DiffFile[], endpoints: string[]): boolean {
  if (endpoints.length === 0) return false;
  for (const diffFile of diffFiles) {
    if (isFrontendFile(diffFile.path)) continue;
    const diffText = diffFile.diff;
    for (const endpoint of endpoints) {
      if (diffText.includes(endpoint)) {
        return true;
      }
    }
  }
  return false;
}

function downgradeSeverity(severity: Severity): Severity {
  if (severity === "critical" || severity === "high") return "medium";
  if (severity === "medium") return "low";
  return severity;
}

function containsLegacyBrowserTargets(repoPath: string): boolean {
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

function applyLegacyBrowserGate(
  finding: Finding,
  legacyTargets: boolean,
): Finding | null {
  if (legacyTargets) return finding;
  const text = `${finding.title} ${finding.description} ${finding.suggestion ?? ""}`;
  if (!LEGACY_BROWSER_PATTERN.test(text)) return finding;
  return null;
}

function applySecurityEvidenceGate(
  finding: Finding,
  diffFiles: DiffFile[],
): Finding | null {
  const text = `${finding.title} ${finding.description} ${finding.suggestion ?? ""} ${finding.lineText ?? ""}`;
  const isIdor = IDOR_REGEX.test(text);
  const isCsrf = CSRF_REGEX.test(text);
  if (!isIdor && !isCsrf) return finding;

  const endpoints = extractEndpoints(text);
  const hasEvidence = hasBackendEvidence(diffFiles, endpoints);
  if (hasEvidence) return finding;

  const prefix = isIdor
    ? "Evidence check: No server-side authorization logic for this endpoint appears in the PR. Verify backend ownership checks."
    : "Evidence check: No server-side CSRF handling appears in the PR. Verify backend enforcement.";

  return {
    ...finding,
    severity: downgradeSeverity(finding.severity),
    confidence: Math.min(finding.confidence ?? 0.6, 0.6),
    description: `${prefix}\n\n${finding.description}`,
  };
}

function findEntityModelFiles(diffFiles: DiffFile[], repoPath: string): string[] {
  const paths = diffFiles
    .map((f) => f.path)
    .filter((p) => p.toLowerCase().endsWith("entitymodel.xml"));

  const existing: string[] = [];
  for (const rel of paths) {
    const full = path.join(repoPath, rel);
    if (fs.existsSync(full)) {
      existing.push(full);
    }
  }
  return existing;
}

function extractEntityName(finding: Finding, domainFacts?: FileDomainFacts): string | null {
  if (domainFacts?.entities && domainFacts.entities.length > 0) {
    return domainFacts.entities[0] ?? null;
  }

  const sources = [finding.lineText, finding.description, finding.title].filter((v): v is string => Boolean(v));
  for (const source of sources) {
    const match = source.match(/"([A-Za-z0-9_]+)"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractFieldNames(text: string): string[] {
  const fieldsMatch = text.match(/fields?:\s*([A-Za-z0-9_,\s]+)/i);
  if (!fieldsMatch?.[1]) return [];
  return uniqueStrings(
    fieldsMatch[1]
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function entityBlockContainsFields(block: string, fields: string[]): boolean {
  return fields.every((field) => block.includes(`name="${field}"`) || block.includes(`name='${field}'`));
}

function findEntityBlock(content: string, entityName: string): string | null {
  const regex = new RegExp(`<entity[^>]*entity-name=["']${entityName}["'][\\s\\S]*?<\\/entity>`, "i");
  const match = content.match(regex);
  return match ? match[0] : null;
}

function applyEntityFieldGate(
  finding: Finding,
  options: EvidenceGateOptions,
  entityModelContents: string[],
): { finding: Finding | null; dropped: boolean } {
  if (options.strategyId !== "ofbiz-supplyhouse") {
    return { finding, dropped: false };
  }

  const text = `${finding.title} ${finding.description}`;
  if (!ENTITY_FIELD_REGEX.test(text)) {
    return { finding, dropped: false };
  }

  const domainFacts = options.domainFactsByFile?.get(finding.file);
  const entityName = extractEntityName(finding, domainFacts);
  if (!entityName) {
    return { finding, dropped: false };
  }

  const fields = extractFieldNames(finding.description);
  if (fields.length === 0) {
    return { finding, dropped: false };
  }

  for (const content of entityModelContents) {
    const block = findEntityBlock(content, entityName);
    if (!block) continue;
    if (entityBlockContainsFields(block, fields)) {
      return { finding: null, dropped: true };
    }
  }

  return { finding, dropped: false };
}

export function applyEvidenceGates(
  findings: Finding[],
  options: EvidenceGateOptions,
): { findings: Finding[]; stats: EvidenceGateStats } {
  const stats: EvidenceGateStats = {
    dropped: 0,
    downgraded: 0,
    droppedEntityFields: 0,
    downgradedSecurity: 0,
    droppedLegacyBrowser: 0,
    legacyTargetsDetected: false,
  };

  const entityModelFiles = findEntityModelFiles(options.diffFiles, options.repoPath);
  const entityModelContents = entityModelFiles
    .map((filePath) => {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const kept: Finding[] = [];
  const legacyTargets = containsLegacyBrowserTargets(options.repoPath);
  stats.legacyTargetsDetected = legacyTargets;

  for (const finding of findings) {
    let current: Finding | null = finding;

    if (current) {
      const legacyGate = applyLegacyBrowserGate(current, legacyTargets);
      if (!legacyGate) {
        stats.dropped++;
        stats.droppedLegacyBrowser++;
        current = null;
      } else {
        current = legacyGate;
      }
    }

    if (current) {
      const securityGate = applySecurityEvidenceGate(current, options.diffFiles);
      if (securityGate !== current) {
        stats.downgraded++;
        stats.downgradedSecurity++;
      }
      current = securityGate;
    }

    if (current) {
      const { finding: gated, dropped } = applyEntityFieldGate(current, options, entityModelContents);
      if (dropped) {
        stats.dropped++;
        stats.droppedEntityFields++;
        current = null;
      } else {
        current = gated;
      }
    }

    if (current) kept.push(current);
  }

  return { findings: kept, stats };
}
