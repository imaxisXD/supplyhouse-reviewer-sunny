import type { Finding } from "../../types/findings.ts";
import type { DiffIndex } from "../diff-indexer.ts";

interface AutoStampEntityState {
  entityName: string;
  file: string;
  line: number;
  lineText: string;
  fields: Set<string>;
  noAutoStamp?: boolean;
}

const AUTO_STAMP_FIELDS = new Set([
  "lastUpdatedStamp",
  "lastUpdatedTxStamp",
  "createdStamp",
  "createdTxStamp",
]);

export function generateOFBizAutoStampFindings(diffIndex: DiffIndex): Finding[] {
  const findings: Finding[] = [];

  for (const fileIndex of diffIndex.files.values()) {
    if (!fileIndex.file.endsWith("entitymodel.xml")) continue;
    const entityStates = new Map<string, AutoStampEntityState>();
    let currentEntity = "unknown";
    let currentNoAutoStamp = false;

    for (const line of fileIndex.lines) {
      const content = line.content.trim();
      if (!content) continue;

      const entityMatch = content.match(/<entity\b[^>]*entity-name="([^"]+)"/);
      if (entityMatch) {
        currentEntity = entityMatch[1]!;
        currentNoAutoStamp = content.includes("no-auto-stamp=\"true\"");
      }

      if (line.kind !== "add") continue;

      const fieldMatch = content.match(/<field\b[^>]*name="([^"]+)"/);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1]!;
      if (!AUTO_STAMP_FIELDS.has(fieldName)) continue;

      const key = `${fileIndex.file}::${currentEntity}`;
      const existing = entityStates.get(key);
      const nextState: AutoStampEntityState = existing ?? {
        entityName: currentEntity,
        file: fileIndex.file,
        line: line.newLine ?? 0,
        lineText: content,
        fields: new Set(),
        noAutoStamp: currentNoAutoStamp,
      };
      nextState.fields.add(fieldName);
      if (!existing) {
        entityStates.set(key, nextState);
      }
    }

    for (const state of entityStates.values()) {
      if (state.fields.size !== AUTO_STAMP_FIELDS.size) continue;
      if (state.line <= 0) continue;
      const entityLabel = state.entityName === "unknown" ? "this entity" : state.entityName;
      const noAuto = state.noAutoStamp === true;
      const suggestion = noAuto
        ? "This entity disables auto-stamping. Ensure the database schema includes these columns."
        : "These are standard OFBiz audit fields. They are auto-created unless no-auto-stamp is set. Verify schema only if auto-stamp is disabled.";

      findings.push({
        file: state.file,
        line: state.line,
        lineId: `L${state.line}`,
        lineText: state.lineText,
        severity: "medium",
        category: "refactor",
        title: `Entity schema change: ${entityLabel} adds standard audit fields`,
        description:
          "The entity adds the standard OFBiz audit fields: lastUpdatedStamp, lastUpdatedTxStamp, createdStamp, createdTxStamp.",
        suggestion,
        confidence: 0.86,
      });
    }
  }

  return findings;
}
