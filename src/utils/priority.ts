/** Path segment keywords mapped to their base priority scores. */
const PATH_SEGMENT_SCORES: Record<string, number> = {
  auth: 100,
  security: 100,
  crypto: 100,
  payment: 100,
  api: 80,
  controllers: 80,
  routes: 80,
  migrations: 70,
  models: 60,
  entities: 60,
  services: 50,
  domain: 50,
  utils: 30,
  helpers: 30,
  components: 30,
  tests: -30,
  docs: -50,
  generated: -100,
};

/** Extension-based modifiers applied to file names. */
const EXTENSION_MODIFIERS: { pattern: string; score: number }[] = [
  { pattern: ".config.", score: -20 },
  { pattern: ".test.", score: -30 },
  { pattern: ".spec.", score: -30 },
  { pattern: ".d.ts", score: -40 },
];

/** File name modifiers applied to the base name of the file. */
const NAME_MODIFIERS: { pattern: string; score: number }[] = [
  { pattern: "index.", score: -10 },
  { pattern: "types.", score: -15 },
];

/**
 * Calculate a priority score for a file based on its path and the number of lines changed.
 *
 * Higher scores indicate files that should be reviewed with higher priority.
 * The score is computed from:
 *   - Base scores derived from path segments (directories)
 *   - Modifiers from file extension patterns
 *   - Modifiers from file name patterns
 *   - A bonus based on lines changed: min(linesChanged / 10, 20)
 */
export function calculateFilePriority(filePath: string, linesChanged: number): number {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalizedPath.split("/");
  const fileName = segments[segments.length - 1] ?? "";

  let score = 0;

  // Base scores from path segments
  for (const segment of segments) {
    if (segment in PATH_SEGMENT_SCORES) {
      score += PATH_SEGMENT_SCORES[segment]!;
    }
  }

  // Extension modifiers
  for (const { pattern, score: modifier } of EXTENSION_MODIFIERS) {
    if (normalizedPath.includes(pattern)) {
      score += modifier;
    }
  }

  // Name modifiers
  for (const { pattern, score: modifier } of NAME_MODIFIERS) {
    if (fileName.startsWith(pattern)) {
      score += modifier;
    }
  }

  // Lines changed modifier
  score += Math.min(linesChanged / 10, 20);

  return score;
}
