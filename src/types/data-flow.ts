/**
 * Data Flow Types
 *
 * Types for tracking data flow across multiple languages and frameworks.
 * Supports: TypeScript, JavaScript, Java, Spring Boot, React, Flutter, FreeMarker, etc.
 */

// =============================================================================
// Data Source Classification
// =============================================================================

/**
 * Classification of where data originates
 */
export type DataSourceType =
  | "USER_INPUT"       // User-controlled: form inputs, URL params, request body, cookies
  | "SERVER_GENERATED" // Server-rendered: template context, request attributes
  | "DATABASE"         // Database: ORM queries, entity operations, SQL results
  | "CONFIG"           // Configuration: properties files, env vars, XML config
  | "EXTERNAL_API"     // External: third-party API responses
  | "SESSION"          // Session: session storage, JWT claims
  | "FILE_SYSTEM"      // File: uploaded files, file reads
  | "UNKNOWN";         // Cannot determine

/**
 * Language/framework detection for data flow analysis
 */
export type LanguageFramework =
  | "typescript"
  | "javascript"
  | "react"
  | "java"
  | "spring-boot"
  | "flutter"
  | "dart"
  | "freemarker"
  | "beanshell"
  | "python"
  | "unknown";

// =============================================================================
// Data Flow Trace
// =============================================================================

/**
 * A single step in the data flow path
 */
export interface DataFlowStep {
  file: string;
  line: number;
  expression: string;       // The code expression at this step
  operation: DataFlowOperation;
  language: LanguageFramework;
}

/**
 * Types of data flow operations
 */
export type DataFlowOperation =
  | "source"        // Where data originates (e.g., request.getParameter)
  | "transform"     // Data transformation (e.g., parseInt, sanitize)
  | "propagate"     // Data passed along (e.g., function parameter)
  | "sink"          // Where data is used dangerously (e.g., SQL query)
  | "validate"      // Validation check (e.g., if (input.match(...)))
  | "sanitize";     // Sanitization (e.g., escapeHtml, parameterized query)

/**
 * Complete data flow trace from source to sink
 */
export interface DataFlowTrace {
  variable: string;
  sourceType: DataSourceType;
  sourcePath: DataFlowStep[];
  sinks: DataFlowSink[];
  validationFound: boolean;
  sanitizationFound: boolean;
  confidence: number;
  language: LanguageFramework;
}

/**
 * A dangerous sink where data is used
 */
export interface DataFlowSink {
  file: string;
  line: number;
  sinkType: SinkType;
  expression: string;
  dangerous: boolean;   // true if user input reaches here without sanitization
}

/**
 * Types of dangerous sinks
 */
export type SinkType =
  | "sql_query"       // SQL query construction
  | "command_exec"    // Shell command execution
  | "html_output"     // HTML rendering (XSS)
  | "url_redirect"    // URL redirect (open redirect)
  | "file_path"       // File path construction (path traversal)
  | "deserialization" // Object deserialization
  | "eval"            // Dynamic code execution
  | "ldap_query"      // LDAP query construction
  | "xpath_query"     // XPath query construction
  | "template";       // Template rendering

// =============================================================================
// Language-Specific Patterns
// =============================================================================

/**
 * Patterns for detecting user input sources by language
 */
export const USER_INPUT_PATTERNS: Record<LanguageFramework, RegExp[]> = {
  typescript: [
    /req\.body/i,
    /req\.query/i,
    /req\.params/i,
    /request\.body/i,
    /useSearchParams/i,
    /getServerSideProps.*params/i,
  ],
  javascript: [
    /req\.body/i,
    /req\.query/i,
    /request\.body/i,
    /document\.location/i,
    /window\.location/i,
    /URLSearchParams/i,
    /localStorage\.getItem/i,
    /sessionStorage\.getItem/i,
  ],
  react: [
    /useState.*props\./i,
    /useParams/i,
    /useSearchParams/i,
    /event\.target\.value/i,
    /e\.target\.value/i,
    /formData\.get/i,
  ],
  java: [
    /request\.getParameter/i,
    /request\.getAttribute/i,
    /@RequestParam/i,
    /@PathVariable/i,
    /@RequestBody/i,
    /HttpServletRequest/i,
    /getQueryString/i,
  ],
  "spring-boot": [
    /@RequestParam/i,
    /@PathVariable/i,
    /@RequestBody/i,
    /@RequestHeader/i,
    /@CookieValue/i,
    /BindingResult/i,
  ],
  flutter: [
    /TextEditingController/i,
    /TextField.*controller/i,
    /TextFormField/i,
    /Uri\.parse.*query/i,
  ],
  dart: [
    /stdin\.readLine/i,
    /Uri\.parse.*query/i,
  ],
  freemarker: [
    /\$\{parameters\./i,
    /\$\{request\./i,
    /\$\{RequestParameters\./i,
  ],
  beanshell: [
    /parameters\.get/i,
    /request\.getParameter/i,
    /requestParameters/i,
  ],
  python: [
    /request\.args/i,
    /request\.form/i,
    /request\.json/i,
    /request\.data/i,
    /request\.values/i,
  ],
  unknown: [],
};

/**
 * Patterns for detecting database sources by language
 */
export const DATABASE_PATTERNS: Record<LanguageFramework, RegExp[]> = {
  typescript: [
    /prisma\.\w+\.find/i,
    /\.query\s*\(/i,
    /sequelize/i,
    /typeorm/i,
    /mongoose\.find/i,
  ],
  javascript: [
    /\.query\s*\(/i,
    /\.find\s*\(/i,
    /\.findOne\s*\(/i,
    /mongodb/i,
  ],
  react: [],
  java: [
    /delegator\.find/i,
    /EntityQuery/i,
    /JpaRepository/i,
    /CrudRepository/i,
    /\.createQuery/i,
    /\.createNativeQuery/i,
    /jdbcTemplate/i,
  ],
  "spring-boot": [
    /JpaRepository/i,
    /CrudRepository/i,
    /@Query/i,
    /EntityManager/i,
    /JdbcTemplate/i,
  ],
  flutter: [
    /sqflite/i,
    /\.query\s*\(/i,
    /\.rawQuery/i,
  ],
  dart: [
    /\.query\s*\(/i,
  ],
  freemarker: [],
  beanshell: [
    /delegator\.find/i,
    /EntityQuery/i,
    /runService/i,
  ],
  python: [
    /cursor\.execute/i,
    /\.query\s*\(/i,
    /session\.query/i,
    /Model\.objects/i,
  ],
  unknown: [],
};

/**
 * Patterns for detecting dangerous sinks by language
 */
export const SINK_PATTERNS: Record<SinkType, Record<LanguageFramework, RegExp[]>> = {
  sql_query: {
    typescript: [/\.query\s*\(`/i, /\.raw\s*\(/i],
    javascript: [/\.query\s*\(/i, /mysql\.query/i],
    react: [],
    java: [/createQuery.*\+/i, /executeQuery.*\+/i, /prepareStatement.*\+/i],
    "spring-boot": [/nativeQuery.*\+/i, /jdbcTemplate.*\+/i],
    flutter: [/rawQuery.*\$/i],
    dart: [],
    freemarker: [],
    beanshell: [],
    python: [/cursor\.execute.*%/i, /execute.*format/i],
    unknown: [],
  },
  command_exec: {
    typescript: [/exec\s*\(/i, /spawn\s*\(/i, /execSync/i],
    javascript: [/exec\s*\(/i, /spawn\s*\(/i, /child_process/i],
    react: [],
    java: [/Runtime\.exec/i, /ProcessBuilder/i],
    "spring-boot": [/Runtime\.exec/i, /ProcessBuilder/i],
    flutter: [/Process\.run/i],
    dart: [/Process\.run/i],
    freemarker: [],
    beanshell: [/Runtime\.exec/i],
    python: [/os\.system/i, /subprocess/i, /Popen/i],
    unknown: [],
  },
  html_output: {
    typescript: [/innerHTML/i, /dangerouslySetInnerHTML/i],
    javascript: [/innerHTML/i, /document\.write/i, /outerHTML/i],
    react: [/dangerouslySetInnerHTML/i],
    java: [/\.write\s*\(/i, /PrintWriter/i],
    "spring-boot": [/ResponseEntity\.ok/i],
    flutter: [/Html\.unescape/i],
    dart: [],
    freemarker: [/\$\{[^?]*\}/], // Unescaped output
    beanshell: [],
    python: [/render_template_string/i, /Markup\(/i],
    unknown: [],
  },
  url_redirect: {
    typescript: [/res\.redirect/i, /window\.location/i],
    javascript: [/location\.href/i, /window\.location/i, /location\.replace/i],
    react: [/navigate\s*\(/i, /useNavigate/i],
    java: [/sendRedirect/i, /setHeader.*Location/i],
    "spring-boot": [/redirect:/i, /RedirectView/i],
    flutter: [/Navigator\.push/i],
    dart: [],
    freemarker: [],
    beanshell: [],
    python: [/redirect\s*\(/i, /url_for/i],
    unknown: [],
  },
  file_path: {
    typescript: [/readFile\s*\(/i, /writeFile\s*\(/i, /path\.join.*\+/i],
    javascript: [/readFile\s*\(/i, /writeFile\s*\(/i],
    react: [],
    java: [/new File\s*\(/i, /FileInputStream/i, /FileOutputStream/i],
    "spring-boot": [/Resource/i, /FileCopyUtils/i],
    flutter: [/File\s*\(/i],
    dart: [/File\s*\(/i],
    freemarker: [],
    beanshell: [/new File/i],
    python: [/open\s*\(/i, /os\.path/i],
    unknown: [],
  },
  deserialization: {
    typescript: [/JSON\.parse/i],
    javascript: [/JSON\.parse/i, /eval\s*\(/i],
    react: [],
    java: [/ObjectInputStream/i, /readObject\s*\(/i, /XMLDecoder/i],
    "spring-boot": [/ObjectInputStream/i],
    flutter: [/jsonDecode/i],
    dart: [/jsonDecode/i],
    freemarker: [],
    beanshell: [],
    python: [/pickle\.loads/i, /yaml\.load(?!.*safe)/i],
    unknown: [],
  },
  eval: {
    typescript: [/eval\s*\(/i, /Function\s*\(/i],
    javascript: [/eval\s*\(/i, /Function\s*\(/i, /setTimeout.*string/i],
    react: [],
    java: [/ScriptEngine/i, /Nashorn/i],
    "spring-boot": [],
    flutter: [],
    dart: [],
    freemarker: [],
    beanshell: [/eval\s*\(/i],
    python: [/eval\s*\(/i, /exec\s*\(/i],
    unknown: [],
  },
  ldap_query: {
    typescript: [],
    javascript: [/ldap\.search/i],
    react: [],
    java: [/DirContext/i, /search\s*\(/i],
    "spring-boot": [/LdapTemplate/i],
    flutter: [],
    dart: [],
    freemarker: [],
    beanshell: [],
    python: [/ldap\.search/i],
    unknown: [],
  },
  xpath_query: {
    typescript: [],
    javascript: [/evaluate\s*\(/i],
    react: [],
    java: [/XPath/i, /evaluate\s*\(/i],
    "spring-boot": [],
    flutter: [],
    dart: [],
    freemarker: [],
    beanshell: [],
    python: [/xpath/i],
    unknown: [],
  },
  template: {
    typescript: [],
    javascript: [],
    react: [],
    java: [/Velocity/i, /Freemarker/i],
    "spring-boot": [/Thymeleaf/i],
    flutter: [],
    dart: [],
    freemarker: [/\$\{/],
    beanshell: [],
    python: [/render_template/i, /jinja/i],
    unknown: [],
  },
};

// =============================================================================
// Verification Types
// =============================================================================

/**
 * Result of verifying a single finding
 */
export interface VerificationResult {
  findingId: string;
  verified: boolean;
  disproven: boolean;
  confidence: number;
  reason: string;
  evidence?: VerificationEvidence;
  dataFlowTrace?: DataFlowTrace;
}

/**
 * Evidence gathered during verification
 */
export interface VerificationEvidence {
  fileChecked: boolean;
  lineMatches: boolean;
  validationExists: boolean;
  sanitizationExists: boolean;
  guardExists: boolean;
  dataSourceType?: DataSourceType;
  additionalNotes?: string;
}

// =============================================================================
// Completeness Types
// =============================================================================

/**
 * Security control that should be present
 */
export type SecurityControl =
  | "csrf"
  | "rate_limiting"
  | "authentication"
  | "authorization"
  | "input_validation"
  | "output_encoding"
  | "secure_headers";

/**
 * Business logic check that should be present
 */
export type BusinessLogicCheck =
  | "future_date_validation"
  | "duplicate_prevention"
  | "state_transition"
  | "range_validation"
  | "format_validation";

/**
 * Missing control finding
 */
export interface MissingControlFinding {
  control: SecurityControl | BusinessLogicCheck;
  file: string;
  line: number;
  context: string;
  severity: "critical" | "high" | "medium" | "low";
  suggestion: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Detect language/framework from file extension and content
 */
export function detectLanguageFramework(
  filePath: string,
  content?: string
): LanguageFramework {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";

  // Extension-based detection
  const extMap: Record<string, LanguageFramework> = {
    ts: "typescript",
    tsx: "react",
    js: "javascript",
    jsx: "react",
    java: "java",
    dart: "dart",
    ftl: "freemarker",
    bsh: "beanshell",
    py: "python",
  };

  let detected = extMap[ext] ?? "unknown";

  // Content-based refinement
  if (content) {
    // Detect Spring Boot
    if (detected === "java" && /@SpringBootApplication|@RestController|@Service|@Repository/.test(content)) {
      detected = "spring-boot";
    }

    // Detect Flutter
    if (detected === "dart" && /import.*package:flutter/.test(content)) {
      detected = "flutter";
    }

    // Detect React in JS files
    if (detected === "javascript" && /import.*React|from ['"]react['"]/.test(content)) {
      detected = "react";
    }
  }

  return detected;
}

/**
 * Check if a data source is user-controlled
 */
export function isUserControlled(sourceType: DataSourceType): boolean {
  return sourceType === "USER_INPUT" || sourceType === "FILE_SYSTEM";
}

/**
 * Check if data flow is potentially dangerous
 */
export function isDangerousFlow(trace: DataFlowTrace): boolean {
  return (
    isUserControlled(trace.sourceType) &&
    !trace.sanitizationFound &&
    trace.sinks.some((sink) => sink.dangerous)
  );
}
