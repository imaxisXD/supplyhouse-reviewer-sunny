# 🎯 PR Review System - Complete Implementation Plan

## Document Purpose
This is a **Claude Code implementation plan** - a comprehensive blueprint for building the PR Review System. It defines WHAT to build, WHY, and in WHAT ORDER - not the actual code.

---

# PART 1: SYSTEM OVERVIEW

## 1.1 What We're Building

An AI-powered PR review system that:
- Accepts a BitBucket PR URL + token via web UI
- Analyzes code changes with full codebase context
- Detects issues: duplicates, security flaws, breaking API changes, bugs
- Posts intelligent inline comments to the PR
- Provides real-time progress via dashboard

## 1.2 Key User Journey

```
User Journey:
┌─────────────────────────────────────────────────────────────────┐
│ 1. User opens Dashboard                                         │
│ 2. User enters: PR URL + BitBucket Token                        │
│ 3. User clicks "Start Review"                                   │
│ 4. Dashboard shows real-time progress:                          │
│    - "Fetching PR details..."                                   │
│    - "Building context..." (shows files being analyzed)         │
│    - "Running Security Agent..." (shows findings as they come)  │
│    - "Running Duplication Agent..."                             │
│    - "Synthesizing results..."                                  │
│    - "Posting comments to BitBucket..."                         │
│ 5. Dashboard shows final summary with all findings              │
│ 6. User sees comments appear on their BitBucket PR              │
└─────────────────────────────────────────────────────────────────┘
```

## 1.3 Technology Decisions (Already Made)

| Component | Technology | Reasoning |
|-----------|------------|-----------|
| Runtime | Bun | 4x faster than Node, native TS |
| API Server | Elysia | Fastest TS framework, Eden types |
| Agent Framework | Mastra | Built-in workflows, RAG, evals |
| LLM Access | OpenRouter | 400+ models, unified API, fallbacks |
| Embeddings | Voyage AI (voyage-code-3) | Best for code, 13.8% better than OpenAI |
| Vector DB | Qdrant | Fast similarity search |
| Graph DB | Memgraph | Code dependency tracking |
| Queue | BullMQ + Redis | Reliable job processing |
| Code Parsing | Tree-sitter | Multi-language AST parsing |
| Text Search | ripgrep | Fastest grep alternative |
| Dashboard | React + Vite | Simple, fast |

---

# PART 2: ARCHITECTURE DEEP DIVE

## 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACE                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  React Dashboard                                                  │   │
│  │  - PR URL input form                                              │   │
│  │  - Real-time progress (WebSocket)                                 │   │
│  │  - Results viewer                                                 │   │
│  │  - Trace/Log viewer for observability                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           API LAYER (Elysia)                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ POST /review │  │ GET /status  │  │ POST /index  │  │ WebSocket   │ │
│  │ Submit PR    │  │ Get progress │  │ Index repo   │  │ Real-time   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        JOB QUEUE (BullMQ + Redis)                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Review Queue          │  Index Queue                            │   │
│  │  - Processes PR reviews│  - Processes repo indexing              │   │
│  │  - Retries on failure  │  - Handles incremental updates          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        MASTRA LAYER (AI Orchestration)                   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    REVIEW WORKFLOW                               │   │
│  │                                                                  │   │
│  │  ┌─────────┐   ┌─────────────┐   ┌─────────────────────────┐   │   │
│  │  │ Fetch   │──▶│ Build       │──▶│ Run Agents (Parallel)   │   │   │
│  │  │ PR Diff │   │ Context     │   │ ┌─────┐┌─────┐┌──────┐  │   │   │
│  │  └─────────┘   └─────────────┘   │ │Sec. ││Logic││Dupe  │  │   │   │
│  │                                   │ └─────┘└─────┘└──────┘  │   │   │
│  │                                   │ ┌─────────┐┌─────────┐  │   │   │
│  │                                   │ │Refactor ││API Chg  │  │   │   │
│  │                                   │ └─────────┘└─────────┘  │   │   │
│  │                                   └───────────┬─────────────┘   │   │
│  │                                               ▼                  │   │
│  │                                   ┌─────────────────────────┐   │   │
│  │                                   │ Synthesis Agent         │   │   │
│  │                                   │ (Dedupe & Format)       │   │   │
│  │                                   └───────────┬─────────────┘   │   │
│  │                                               ▼                  │   │
│  │                                   ┌─────────────────────────┐   │   │
│  │                                   │ Post to BitBucket       │   │   │
│  │                                   └─────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    TOOLS (What agents can use)                   │   │
│  │                                                                  │   │
│  │  BitBucket Tools    Graph Tools      Vector Tools    Search     │   │
│  │  ├─ get_pr_diff     ├─ query_callers ├─ search_similar ├─ grep  │   │
│  │  ├─ post_comment    ├─ query_callees ├─ find_duplicates         │   │
│  │  └─ clone_repo      ├─ query_imports                            │   │
│  │                     └─ query_impact                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        DATA LAYER                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Qdrant       │  │ Memgraph     │  │ Redis        │  │ File System │ │
│  │ (Vectors)    │  │ (Graph)      │  │ (Cache/Queue)│  │ (Repos)     │ │
│  │              │  │              │  │              │  │             │ │
│  │ - Embeddings │  │ - Functions  │  │ - Job state  │  │ - Cloned    │ │
│  │ - Similarity │  │ - Calls      │  │ - Cache      │  │   repos     │ │
│  │   search     │  │ - Imports    │  │ - Pub/Sub    │  │             │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL SERVICES                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ OpenRouter   │  │ Voyage AI    │  │ BitBucket API                │  │
│  │ (LLM API)    │  │ (Embeddings) │  │ (PR data, comments)          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2.2 Data Flow: PR Review

```
DETAILED PR REVIEW FLOW
═══════════════════════════════════════════════════════════════════════════

STEP 1: SUBMISSION
──────────────────
User submits:
  - PR URL: https://bitbucket.org/myworkspace/myrepo/pull-requests/123
  - BitBucket Token: app_password_or_token

API validates URL format, creates job in queue, returns reviewId

STEP 2: FETCH PR DATA (via BitBucket API)
─────────────────────────────────────────
Fetch from BitBucket:
  - PR metadata (title, author, description)
  - List of changed files
  - Diff content (unified diff format)
  - Target branch (usually main)

Parse diff to extract:
  - Added lines (+)
  - Removed lines (-)
  - File paths
  - Hunk positions (for inline comments)

STEP 3: BUILD CONTEXT (The Key Part!)
─────────────────────────────────────
For EACH changed file in the PR:

  A. Expand Diff Context
     - Diff shows only changed lines ± 3 lines
     - We need FULL function bodies for analysis
     - Use line numbers to fetch complete functions

  B. Query Graph (Memgraph) for Relationships
     - "Who CALLS functions in this file?"
     - "What does this file IMPORT?"
     - "What files IMPORT this file?"
     - This reveals IMPACT of changes

  C. Query Vectors (Qdrant) for Similar Code
     - For NEW functions: find similar existing functions
     - This reveals DUPLICATES
     - Also finds existing PATTERNS to follow

  D. Query Text (ripgrep) for Exact Matches
     - For RENAMED functions: find all old name usages
     - For REMOVED exports: find all import sites
     - This reveals INCOMPLETE refactoring

Context Package per file:
┌────────────────────────────────────────────────┐
│ File: src/services/user.service.ts             │
│                                                │
│ Diff: (the actual changes)                     │
│ Full Functions: (expanded from diff)           │
│ Callers: [controller.ts:45, api.ts:23]         │
│ Callees: [db.ts:query, validator.ts:validate]  │
│ Similar Code: [auth.service.ts:validateUser]   │
│ Usages Found: ["user.email" used in 4 files]   │
└────────────────────────────────────────────────┘

STEP 4: RUN SPECIALIST AGENTS (Parallel)
────────────────────────────────────────
All agents run IN PARALLEL for speed.
Each agent receives: PR metadata + Context Package

┌─────────────────────────────────────────────────────────────────────┐
│ SECURITY AGENT                                                       │
│ ─────────────────                                                    │
│ Focus: SQL injection, XSS, auth bypass, secrets, unsafe deserialize │
│                                                                      │
│ Input: Diff + context                                                │
│ Process: Analyze new code for security patterns                      │
│ Output: List of security findings with severity                      │
│                                                                      │
│ Example Finding:                                                     │
│ {                                                                    │
│   file: "src/api/users.ts",                                          │
│   line: 45,                                                          │
│   severity: "high",                                                  │
│   issue: "SQL injection: user input in query string",                │
│   suggestion: "Use parameterized query: db.query($1, [userId])"      │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ LOGIC AGENT                                                          │
│ ───────────────                                                      │
│ Focus: Null checks, edge cases, type mismatches, infinite loops     │
│                                                                      │
│ Input: Diff + expanded function context                              │
│ Process: Reason about code logic, find bugs                          │
│ Output: List of potential bugs with explanations                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ DUPLICATION AGENT                                                    │
│ ─────────────────                                                    │
│ Focus: Similar existing code, copy-paste, DRY violations            │
│                                                                      │
│ Input: New functions + similar code from vector search               │
│ Process: Compare similarity scores, check if truly duplicate         │
│ Output: Duplicates found with links to existing code                 │
│                                                                      │
│ Example: "This function is 94% similar to validateEmail() in        │
│          src/utils/validators.ts - consider reusing"                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ API CHANGE AGENT                                                     │
│ ─────────────────                                                    │
│ Focus: Breaking changes, signature changes, return type changes     │
│                                                                      │
│ Input: Diff + callers from graph + usages from grep                  │
│ Process: Detect if changes break downstream code                     │
│ Output: Breaking changes with list of affected files                 │
│                                                                      │
│ Example: "Return type changed from {email} to {contactInfo.email}.  │
│          4 callers still use the old structure:                      │
│          - src/api/users.controller.ts:20                            │
│          - src/services/notification.ts:12"                          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ REFACTOR AGENT                                                       │
│ ───────────────                                                      │
│ Focus: Code quality, naming, structure, best practices              │
│                                                                      │
│ Input: Diff + existing patterns in codebase                          │
│ Process: Compare to project conventions, suggest improvements        │
│ Output: Refactoring suggestions (lower priority than bugs)           │
└─────────────────────────────────────────────────────────────────────┘

STEP 5: SYNTHESIS
─────────────────
Combine all agent outputs:
  - Remove duplicates (same issue found by multiple agents)
  - Resolve conflicts (if agents disagree)
  - Sort by severity (critical → high → medium → low → info)
  - Format for BitBucket comment syntax

STEP 6: POST TO BITBUCKET
─────────────────────────
For each finding:
  - If specific line → POST inline comment at that line
  - If file-level → POST file comment

Finally:
  - POST summary comment with overview
  - Include stats: files analyzed, issues found, time taken

STEP 7: RETURN RESULTS
──────────────────────
Return to dashboard:
  - All findings
  - Traces (which agent found what, timing)
  - Cost breakdown (tokens used, $ spent)
  - Links to posted comments
```

## 2.3 Data Flow: Codebase Indexing

```
INDEXING FLOW (for each supported framework)
═══════════════════════════════════════════════════════════════════════════

STEP 1: CLONE REPOSITORY
────────────────────────
Clone target branch (usually main) to local filesystem
Location: /tmp/pr-review/repos/{repo-id}/

STEP 2: DETECT FRAMEWORK
────────────────────────
Look for indicator files:
  - package.json + tsconfig.json → React/TypeScript
  - pom.xml or build.gradle + *Application.java → Spring Boot
  - pubspec.yaml + lib/main.dart → Flutter
  - pyproject.toml or requirements.txt → Python
  - go.mod → Go

Each framework has DIFFERENT indexing strategy (see below)

STEP 3: PARSE ALL SOURCE FILES
──────────────────────────────
Use Tree-sitter to parse each file into AST
Extract:
  - Functions (name, params, return type, body, line numbers)
  - Classes (name, methods, properties)
  - Imports (what this file imports)
  - Exports (what this file exports)

STEP 4: BUILD GRAPH (Memgraph)
──────────────────────────────
Create nodes:
  - File nodes
  - Function nodes
  - Class nodes

Create edges (relationships):
  - CONTAINS: File → Function
  - CALLS: Function → Function
  - IMPORTS: File → File
  - EXTENDS: Class → Class
  - IMPLEMENTS: Class → Interface

STEP 5: GENERATE EMBEDDINGS (Voyage AI)
───────────────────────────────────────
For each function:
  - Take function body as text
  - Call Voyage AI voyage-code-3 model
  - Get 1024-dimensional vector
  - Store in Qdrant with metadata

Batch processing: 50 functions per API call
Rate limiting: Respect Voyage AI limits

STEP 6: STORE METADATA
──────────────────────
Store in Redis:
  - Index timestamp
  - Last indexed commit SHA
  - File count, function count
  - Framework detected

INCREMENTAL INDEXING (on PR merge)
──────────────────────────────────
Only process CHANGED files:
  1. Get list of changed files from merge
  2. DELETE old nodes/embeddings for those files
  3. Parse only changed files
  4. INSERT new nodes/embeddings
  5. Update timestamp

This takes seconds instead of minutes!
```

---

# PART 3: FRAMEWORK-SPECIFIC INDEXING STRATEGIES

## 3.1 React/TypeScript Strategy

```
REACT APP INDEXING
═══════════════════════════════════════════════════════════════════════════

FILE PATTERNS TO INCLUDE:
  - src/**/*.tsx
  - src/**/*.ts
  - src/**/*.jsx
  - src/**/*.js

FILE PATTERNS TO EXCLUDE:
  - node_modules/**
  - dist/**, build/**, .next/**
  - **/*.test.*, **/*.spec.*
  - **/__tests__/**, **/__mocks__/**

WHAT TO EXTRACT:

1. COMPONENTS
   - Functional components (function X() or const X = () =>)
   - Hooks usage (useState, useEffect, custom hooks)
   - Props interface/type

2. HOOKS
   - Custom hooks (use* naming convention)
   - Dependencies array analysis

3. API CALLS
   - fetch() calls
   - axios calls
   - React Query hooks
   - SWR hooks

4. CONTEXT/STATE
   - Context providers
   - Redux slices/actions
   - Zustand stores

5. IMPORTS/EXPORTS
   - Named exports
   - Default exports
   - Re-exports from index files

SPECIAL HANDLING:
  - Barrel files (index.ts that re-exports) → Track re-export chains
  - Next.js pages → Extract route information
  - API routes → Track as endpoints
```

## 3.2 Java Spring Boot Strategy

```
SPRING BOOT INDEXING
═══════════════════════════════════════════════════════════════════════════

FILE PATTERNS TO INCLUDE:
  - src/main/java/**/*.java
  - src/main/kotlin/**/*.kt

FILE PATTERNS TO EXCLUDE:
  - target/**, build/**
  - src/test/**
  - **/generated/**

WHAT TO EXTRACT:

1. CONTROLLERS (@RestController, @Controller)
   - Endpoint mappings (@GetMapping, @PostMapping, etc.)
   - Request/Response types
   - Path variables, request params

2. SERVICES (@Service)
   - Business logic methods
   - Transaction boundaries (@Transactional)
   - Dependencies (@Autowired)

3. REPOSITORIES (@Repository)
   - Database methods
   - Custom queries (@Query)
   - Entity relationships

4. ENTITIES (@Entity)
   - Table mappings
   - Column definitions
   - Relationships (@ManyToOne, @OneToMany)

5. CONFIGURATION (@Configuration)
   - Bean definitions
   - Property bindings

6. DTOs/MODELS
   - Data transfer objects
   - Request/Response classes

SPECIAL HANDLING:
  - Spring annotations → Extract metadata
  - AOP aspects → Track cross-cutting concerns
  - Event listeners → Track event flows
```

## 3.3 Flutter/Dart Strategy

```
FLUTTER APP INDEXING
═══════════════════════════════════════════════════════════════════════════

FILE PATTERNS TO INCLUDE:
  - lib/**/*.dart

FILE PATTERNS TO EXCLUDE:
  - .dart_tool/**
  - build/**
  - **/*.g.dart (generated)
  - **/*.freezed.dart (generated)
  - test/**

WHAT TO EXTRACT:

1. WIDGETS
   - StatelessWidget subclasses
   - StatefulWidget subclasses
   - Build method analysis

2. STATE MANAGEMENT
   - BLoC classes
   - Cubit classes
   - Provider definitions
   - Riverpod providers
   - GetX controllers

3. SERVICES
   - API service classes
   - Repository classes
   - Data sources

4. MODELS
   - Data classes
   - Freezed models
   - JSON serialization

5. ROUTES
   - Route definitions
   - Navigation calls

SPECIAL HANDLING:
  - Generated files → Skip but note relationships
  - Part files → Track part-of relationships
  - Extension methods → Track extended types
```

## 3.4 Python Strategy

```
PYTHON INDEXING
═══════════════════════════════════════════════════════════════════════════

FILE PATTERNS TO INCLUDE:
  - **/*.py
  - src/**/*.py

FILE PATTERNS TO EXCLUDE:
  - __pycache__/**
  - venv/**, .venv/**, env/**
  - **/*_test.py, **/test_*.py

WHAT TO EXTRACT:

1. FUNCTIONS
   - Regular functions (def)
   - Async functions (async def)
   - Decorators applied

2. CLASSES
   - Class definitions
   - Methods (including __init__)
   - Class variables
   - Inheritance

3. IMPORTS
   - from X import Y
   - import X
   - Relative imports

4. FRAMEWORK-SPECIFIC (FastAPI/Django/Flask)
   - Route decorators
   - Model definitions
   - Dependency injection

SPECIAL HANDLING:
  - Type hints → Parse for relationship info
  - Decorators → Track decorator chains
  - __init__.py → Track package structure
```

---

# PART 4: AGENT SPECIFICATIONS

## 4.1 Agent Design Principles

```
AGENT DESIGN PRINCIPLES
═══════════════════════════════════════════════════════════════════════════

1. SINGLE RESPONSIBILITY
   Each agent focuses on ONE type of analysis
   Don't mix security checks with style suggestions

2. TOOL-FIRST
   Agents should USE TOOLS to gather information
   Don't rely solely on context window
   Tools provide CURRENT, ACCURATE data

3. STRUCTURED OUTPUT
   Every agent returns findings in the SAME format
   Makes synthesis easier
   Enables consistent UI rendering

4. CONFIDENCE SCORES
   Every finding includes confidence (0.0 to 1.0)
   Helps filter noise
   Enables "high confidence only" mode

5. GRACEFUL DEGRADATION
   If a tool fails, agent should continue with available info
   Never crash the whole review
   Log what was skipped

6. COST AWARENESS
   Track tokens used
   Avoid unnecessary LLM calls
   Cache where possible
```

## 4.2 Agent: Security

```
SECURITY AGENT SPECIFICATION
═══════════════════════════════════════════════════════════════════════════

PURPOSE:
  Detect security vulnerabilities in code changes

MODEL:
  claude-sonnet-4 (via OpenRouter)
  Reasoning: Security requires careful, thorough analysis

TOOLS AVAILABLE:
  - grep_codebase: Search for patterns (hardcoded secrets, etc.)
  - search_similar: Find similar code that might have same issue
  - read_file: Get full file context

CHECKS TO PERFORM:

  1. SQL INJECTION
     - String concatenation in queries
     - User input in query strings
     - Missing parameterization

  2. XSS (Cross-Site Scripting)
     - Unsanitized user input in HTML
     - Missing escaping
     - dangerouslySetInnerHTML usage

  3. AUTHENTICATION/AUTHORIZATION
     - Missing auth checks
     - Broken access control
     - JWT issues

  4. SECRETS EXPOSURE
     - Hardcoded API keys
     - Passwords in code
     - Private keys committed

  5. INJECTION ATTACKS
     - Command injection
     - LDAP injection
     - XML injection

  6. INSECURE DESERIALIZATION
     - Unsafe JSON.parse with eval
     - Pickle usage (Python)
     - Yaml.load without safe_load

  7. CRYPTO ISSUES
     - Weak algorithms (MD5, SHA1 for passwords)
     - Hardcoded IVs
     - Insecure random

SEVERITY MAPPING:
  - CRITICAL: Exploitable vulnerability, data breach risk
  - HIGH: Security flaw, needs fix before merge
  - MEDIUM: Potential issue, should fix
  - LOW: Best practice violation

OUTPUT FORMAT:
  {
    findings: [{
      file: string,
      line: number,
      severity: "critical" | "high" | "medium" | "low",
      category: "security",
      title: string,       // Brief: "SQL Injection in user query"
      description: string, // Detailed explanation
      suggestion: string,  // How to fix
      confidence: number,  // 0.0 to 1.0
      cwe: string,         // CWE ID if applicable (e.g., "CWE-89")
    }]
  }
```

## 4.3 Agent: Logic/Bug Detection

```
LOGIC AGENT SPECIFICATION
═══════════════════════════════════════════════════════════════════════════

PURPOSE:
  Detect bugs, logic errors, and edge cases in code changes

MODEL:
  claude-sonnet-4 (via OpenRouter)
  Reasoning: Bug detection requires deep reasoning

TOOLS AVAILABLE:
  - read_file: Get full function context
  - query_callers: See how function is used
  - query_callees: See what function depends on

CHECKS TO PERFORM:

  1. NULL/UNDEFINED HANDLING
     - Missing null checks
     - Optional chaining needed
     - Undefined access

  2. TYPE MISMATCHES
     - Wrong type passed to function
     - Return type doesn't match declaration
     - Array vs single item confusion

  3. EDGE CASES
     - Empty array handling
     - Zero/negative number handling
     - Empty string handling

  4. ASYNC ISSUES
     - Missing await
     - Unhandled promise rejection
     - Race conditions

  5. LOOP ISSUES
     - Off-by-one errors
     - Infinite loop potential
     - Wrong loop variable

  6. CONDITION LOGIC
     - Always true/false conditions
     - Unreachable code
     - Wrong operator (= vs ==)

  7. RESOURCE MANAGEMENT
     - Unclosed resources
     - Memory leaks
     - Missing cleanup

OUTPUT FORMAT:
  Same as Security Agent but category: "bug"
```

## 4.4 Agent: Duplication Detection

```
DUPLICATION AGENT SPECIFICATION
═══════════════════════════════════════════════════════════════════════════

PURPOSE:
  Detect duplicate or highly similar code

MODEL:
  gemini-2-flash (via OpenRouter)
  Reasoning: Pattern matching, can use faster model

TOOLS AVAILABLE:
  - search_similar: MAIN TOOL - find similar code via embeddings
  - read_file: Get full code of similar functions

PROCESS:

  1. For each NEW function in the PR:
     a. Call search_similar with function body
     b. Get top 5 similar functions
     c. Filter by similarity threshold (>0.85)

  2. For each similar match:
     a. Fetch full code of both functions
     b. Compare: Are they truly duplicates?
     c. Check: Same logic? Different names?

  3. Generate finding if:
     - Similarity > 0.90 AND
     - Logic is essentially identical AND
     - Original is in main codebase (not test)

SIMILARITY THRESHOLDS:
  - > 0.95: Almost certainly duplicate
  - 0.90 - 0.95: Very likely duplicate
  - 0.85 - 0.90: Possibly duplicate, needs review
  - < 0.85: Probably not duplicate

OUTPUT FORMAT:
  {
    findings: [{
      file: string,
      line: number,
      severity: "medium",
      category: "duplication",
      title: "Duplicate of existing function",
      description: "This function is X% similar to Y in Z",
      suggestion: "Consider importing from Z instead",
      confidence: number, // The similarity score
      relatedCode: {
        file: string,
        line: number,
        functionName: string,
        similarity: number,
      }
    }]
  }
```

## 4.5 Agent: API Change Detection

```
API CHANGE AGENT SPECIFICATION
═══════════════════════════════════════════════════════════════════════════

PURPOSE:
  Detect breaking API changes and incomplete refactoring

MODEL:
  claude-sonnet-4 (via OpenRouter)
  Reasoning: Needs to understand impact across codebase

TOOLS AVAILABLE:
  - query_callers: Find all callers of changed function
  - query_imports: Find all files that import changed file
  - grep_codebase: Find string usages of changed identifiers

CHECKS TO PERFORM:

  1. SIGNATURE CHANGES
     - Parameter added (breaking if required)
     - Parameter removed
     - Parameter type changed
     - Return type changed

  2. INTERFACE CHANGES
     - Property removed from return object
     - Property renamed
     - Property type changed
     - Nested structure changed (e.g., email → contactInfo.email)

  3. EXPORT CHANGES
     - Function no longer exported
     - Export renamed
     - Default export changed to named

  4. INCOMPLETE REFACTORING
     - Function renamed but not all usages updated
     - Type changed but callers use old type
     - Import removed but usage remains

PROCESS:

  1. Detect what changed (from diff)
  2. Query graph for all callers/importers
  3. Check if callers are updated in this PR
  4. If not updated → potential breaking change

OUTPUT FORMAT:
  {
    findings: [{
      file: string,
      line: number,
      severity: "high",
      category: "api-change",
      title: "Breaking change: X not updated",
      description: "Changed Y but Z still uses old version",
      suggestion: "Update files: A, B, C or add backward compat",
      confidence: number,
      affectedFiles: [{
        file: string,
        line: number,
        usage: string, // The code that uses old API
      }]
    }]
  }
```

## 4.6 Agent: Synthesis

```
SYNTHESIS AGENT SPECIFICATION
═══════════════════════════════════════════════════════════════════════════

PURPOSE:
  Combine all agent findings into coherent review

MODEL:
  claude-sonnet-4 (via OpenRouter)
  Reasoning: Needs good writing for clear comments

INPUT:
  All findings from all agents

PROCESS:

  1. DEDUPLICATE
     - Multiple agents might find same issue
     - Keep highest confidence version
     - Merge related findings

  2. RESOLVE CONFLICTS
     - If agents disagree, use reasoning
     - Security trumps style
     - Bugs trump refactoring

  3. PRIORITIZE
     - Sort by severity
     - Group by file
     - Critical issues first

  4. FORMAT FOR BITBUCKET
     - Convert to Markdown
     - Add code snippets
     - Include links to related code

OUTPUT:
  - List of inline comments (file, line, content)
  - Summary comment (overview of all findings)
```

---

# PART 5: TOOL SPECIFICATIONS

## 5.1 BitBucket Tools

```
BITBUCKET TOOLS
═══════════════════════════════════════════════════════════════════════════

TOOL: get_pr_diff
─────────────────
Purpose: Fetch the diff content of a PR
Input:
  - workspace: string
  - repo_slug: string
  - pr_number: number
  - token: string
Output:
  - files: Array of {
      path: string,
      status: "added" | "modified" | "deleted",
      diff: string (unified diff format),
      additions: number,
      deletions: number,
    }
API: GET /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/diff


TOOL: post_inline_comment
─────────────────────────
Purpose: Post a comment on a specific line in the PR
Input:
  - workspace: string
  - repo_slug: string
  - pr_number: number
  - token: string
  - file_path: string
  - line: number
  - content: string (Markdown)
Output:
  - comment_id: string
  - success: boolean
API: POST /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments


TOOL: post_summary_comment
──────────────────────────
Purpose: Post a general comment on the PR (not line-specific)
Input:
  - workspace: string
  - repo_slug: string
  - pr_number: number
  - token: string
  - content: string (Markdown)
Output:
  - comment_id: string
  - success: boolean


TOOL: clone_repo
────────────────
Purpose: Clone repository to local filesystem (for indexing)
Input:
  - clone_url: string
  - token: string
  - branch: string
  - destination: string
Output:
  - path: string (where cloned)
  - success: boolean
Method: git clone with token auth
```

## 5.2 Graph Tools (Memgraph)

```
GRAPH TOOLS
═══════════════════════════════════════════════════════════════════════════

TOOL: query_callers
───────────────────
Purpose: Find all functions that call a given function
Input:
  - function_name: string (qualified name, e.g., "UserService.getUser")
  - repo_id: string
Output:
  - callers: Array of {
      function_name: string,
      file_path: string,
      line: number,
      call_line: number, // Line where call happens
    }
Cypher:
  MATCH (caller:Function)-[:CALLS]->(target:Function {name: $name})
  WHERE caller.repo_id = $repo_id
  RETURN caller


TOOL: query_callees
───────────────────
Purpose: Find all functions that a given function calls
Input:
  - function_name: string
  - repo_id: string
Output:
  - callees: Array of { function_name, file_path, line }
Cypher:
  MATCH (source:Function {name: $name})-[:CALLS]->(target:Function)
  WHERE source.repo_id = $repo_id
  RETURN target


TOOL: query_imports
───────────────────
Purpose: Find all files that import a given file
Input:
  - file_path: string
  - repo_id: string
Output:
  - importers: Array of {
      file_path: string,
      imported_symbols: string[], // What symbols they import
    }
Cypher:
  MATCH (importer:File)-[:IMPORTS]->(target:File {path: $path})
  WHERE importer.repo_id = $repo_id
  RETURN importer


TOOL: query_impact
──────────────────
Purpose: Find all code that could be affected by a change
Input:
  - file_path: string
  - function_name: string (optional)
  - repo_id: string
Output:
  - impact: {
      direct_callers: number,
      indirect_callers: number,
      importing_files: number,
      affected_paths: string[],
    }
Cypher: Multi-hop query to find transitive dependencies
```

## 5.3 Vector Tools (Qdrant)

```
VECTOR TOOLS
═══════════════════════════════════════════════════════════════════════════

TOOL: search_similar
────────────────────
Purpose: Find semantically similar code
Input:
  - code: string (the code to find similar matches for)
  - repo_id: string
  - top_k: number (default 5)
  - threshold: number (default 0.85)
  - exclude_file: string (optional, exclude same file)
Output:
  - matches: Array of {
      function_name: string,
      file_path: string,
      code: string,
      similarity: number,
      start_line: number,
      end_line: number,
    }
Process:
  1. Embed input code using Voyage AI
  2. Query Qdrant for nearest neighbors
  3. Filter by threshold and repo_id
  4. Return with metadata


TOOL: find_duplicates
─────────────────────
Purpose: Specifically find duplicate functions (wrapper around search_similar)
Input:
  - functions: Array of { name, code, file, line }
  - repo_id: string
  - threshold: number (default 0.90)
Output:
  - duplicates: Array of {
      new_function: { name, file, line },
      existing_function: { name, file, line },
      similarity: number,
    }
```

## 5.4 Search Tools (ripgrep)

```
SEARCH TOOLS
═══════════════════════════════════════════════════════════════════════════

TOOL: grep_codebase
───────────────────
Purpose: Fast text search across codebase
Input:
  - pattern: string (regex pattern)
  - repo_path: string
  - file_glob: string (optional, e.g., "*.ts")
  - ignore_patterns: string[] (optional)
  - max_results: number (default 100)
Output:
  - matches: Array of {
      file: string,
      line: number,
      content: string,
      match: string, // The matched portion
    }
Command: rg --json {pattern} {repo_path}


TOOL: find_usages
─────────────────
Purpose: Find all usages of an identifier
Input:
  - identifier: string (e.g., "validateEmail")
  - repo_path: string
  - exclude_definition: boolean
Output:
  - usages: Array of { file, line, context }
Process: grep + filter out definition site


TOOL: find_definitions
──────────────────────
Purpose: Find where something is defined
Input:
  - identifier: string
  - repo_path: string
Output:
  - definitions: Array of {
      file: string,
      line: number,
      type: "function" | "class" | "variable" | "type",
      signature: string,
    }
```

---

# PART 6: ERROR HANDLING & RESILIENCE

## 6.1 Error Categories

```
ERROR HANDLING STRATEGY
═══════════════════════════════════════════════════════════════════════════

CATEGORY 1: RECOVERABLE ERRORS (Retry)
──────────────────────────────────────
- Network timeouts (BitBucket, OpenRouter, Voyage)
- Rate limits (429 errors)
- Temporary service unavailable (503)

Strategy:
  - Exponential backoff: 1s → 2s → 4s → 8s → 16s
  - Max 5 retries
  - Jitter to prevent thundering herd


CATEGORY 2: PARTIAL FAILURES (Degrade Gracefully)
─────────────────────────────────────────────────
- One agent fails but others succeed
- Graph DB unavailable but vectors work
- Some files fail to parse

Strategy:
  - Continue with available data
  - Mark findings as "limited context"
  - Log what was skipped
  - Still post useful comments


CATEGORY 3: FATAL ERRORS (Fail Fast)
────────────────────────────────────
- Invalid BitBucket token (401)
- PR not found (404)
- LLM API key invalid
- All retries exhausted

Strategy:
  - Fail immediately
  - Clear error message to user
  - Log full error for debugging
  - Suggest remediation


CATEGORY 4: VALIDATION ERRORS (Reject Early)
────────────────────────────────────────────
- Invalid PR URL format
- Missing required fields
- Invalid options

Strategy:
  - Validate at API boundary
  - Return 400 with clear message
  - Don't start job
```

## 6.2 Circuit Breaker Pattern

```
CIRCUIT BREAKER IMPLEMENTATION
═══════════════════════════════════════════════════════════════════════════

Each external service gets its own circuit breaker:
  - OpenRouter (LLM)
  - Voyage AI (Embeddings)
  - BitBucket API
  - Qdrant
  - Memgraph

States:
  CLOSED (normal operation)
    → Failures counted
    → If failures > threshold in window → OPEN

  OPEN (rejecting requests)
    → All requests fail fast
    → After timeout → HALF_OPEN

  HALF_OPEN (testing)
    → Allow one request through
    → If success → CLOSED
    → If failure → OPEN

Configuration per service:
  {
    failureThreshold: 5,      // Failures before opening
    resetTimeout: 30000,      // ms before trying again
    monitorWindow: 60000,     // Window for counting failures
  }

Dashboard shows circuit state for each service
```

## 6.3 Graceful Degradation Modes

```
DEGRADATION MODES
═══════════════════════════════════════════════════════════════════════════

MODE: NO_GRAPH
──────────────
When: Memgraph unavailable
Impact:
  - Can't query callers/callees
  - Can't detect API change impact
Mitigation:
  - Use grep to find usages (slower, less accurate)
  - Mark API Change findings as "low confidence"
  - Still run Security, Logic, Duplication agents


MODE: NO_VECTORS
────────────────
When: Qdrant unavailable or embeddings fail
Impact:
  - Can't do similarity search
  - Duplication agent ineffective
Mitigation:
  - Skip Duplication agent
  - Use AST-based comparison (exact match only)
  - Log that duplication check was skipped


MODE: SLOW_LLM
──────────────
When: OpenRouter slow or rate limited
Impact:
  - Review takes longer
Mitigation:
  - Fall back to cheaper/faster model
  - Reduce parallel agent count
  - Queue subsequent reviews


MODE: LARGE_PR
──────────────
When: PR has >50 files or >5000 lines
Impact:
  - Can't analyze everything in one context
Mitigation:
  - Prioritize files (see priority scoring)
  - Batch analysis
  - Post partial results, then continue
```

---

# PART 7: OBSERVABILITY REQUIREMENTS

## 7.1 Logging

```
LOGGING REQUIREMENTS
═══════════════════════════════════════════════════════════════════════════

LOG FORMAT: Structured JSON (Pino)

{
  "timestamp": "2025-02-01T12:00:00.000Z",
  "level": "info",
  "traceId": "tr_abc123",
  "component": "security-agent",
  "message": "Found potential SQL injection",
  "data": {
    "file": "src/api/users.ts",
    "line": 45,
    "severity": "high"
  }
}

LOG LEVELS:
  - ERROR: Failures that affect functionality
  - WARN: Degraded operation, recoverable issues
  - INFO: Key events (review started, completed, etc.)
  - DEBUG: Detailed operation (tool calls, agent reasoning)
  - TRACE: Very detailed (every API call, timing)

WHAT TO LOG:

  REVIEW LIFECYCLE:
    - Review submitted (INFO)
    - PR fetched (DEBUG)
    - Context built (DEBUG)
    - Each agent started/completed (INFO)
    - Findings found (INFO)
    - Comments posted (INFO)
    - Review completed (INFO)

  ERRORS:
    - API failures (ERROR)
    - Parse failures (WARN)
    - Retry attempts (WARN)
    - Circuit breaker state changes (WARN)

  PERFORMANCE:
    - Token counts per agent (DEBUG)
    - Duration of each phase (DEBUG)
    - Embedding batch times (DEBUG)
```

## 7.2 Tracing

```
TRACING REQUIREMENTS
═══════════════════════════════════════════════════════════════════════════

Every request gets a TRACE ID (tr_xxxxx)
Trace ID flows through entire system

TRACE STRUCTURE:

Review Trace
├── Fetch PR (200ms)
│   └── BitBucket API call
├── Build Context (3s)
│   ├── Expand diff
│   ├── Query graph (callers)
│   ├── Query graph (imports)
│   └── Query vectors (similar)
├── Run Agents (15s) [parallel]
│   ├── Security Agent (5s)
│   │   ├── LLM call (4s, 2000 tokens)
│   │   └── grep tool (100ms)
│   ├── Logic Agent (4s)
│   │   └── LLM call (4s, 1500 tokens)
│   ├── Duplication Agent (3s)
│   │   ├── Embedding (200ms)
│   │   └── Vector search (100ms)
│   └── API Change Agent (5s)
│       ├── Graph query (50ms)
│       └── LLM call (4.5s, 1800 tokens)
├── Synthesis (3s)
│   └── LLM call (3s, 1000 tokens)
└── Post Comments (2s)
    ├── Comment 1 (500ms)
    ├── Comment 2 (500ms)
    └── Summary (500ms)

Total: 23.2s
Total Tokens: 6300
Estimated Cost: $0.08

DASHBOARD SHOWS:
  - Waterfall view of trace
  - Time spent in each phase
  - Token usage breakdown
  - Cost breakdown
```

## 7.3 Metrics

```
METRICS TO TRACK
═══════════════════════════════════════════════════════════════════════════

COUNTERS:
  - reviews_submitted_total
  - reviews_completed_total
  - reviews_failed_total
  - comments_posted_total
  - findings_by_severity{severity="critical|high|medium|low"}
  - findings_by_category{category="security|bug|duplicate|api-change"}

HISTOGRAMS:
  - review_duration_seconds
  - agent_duration_seconds{agent="security|logic|..."}
  - llm_tokens_used{model="claude-sonnet-4|..."}
  - llm_latency_seconds{model="..."}
  - files_per_review
  - findings_per_review

GAUGES:
  - active_reviews
  - queue_depth
  - circuit_breaker_state{service="openrouter|qdrant|..."}

DASHBOARD PANELS:
  - Reviews per hour
  - Average review duration
  - Findings distribution pie chart
  - Cost over time
  - Success/failure rate
  - Agent performance comparison
```

---

# PART 8: DASHBOARD REQUIREMENTS

## 8.1 Dashboard Pages

```
DASHBOARD STRUCTURE
═══════════════════════════════════════════════════════════════════════════

PAGE 1: HOME / SUBMIT REVIEW
────────────────────────────
Components:
  - PR URL input field
  - BitBucket token input (password field)
  - Options:
    □ Skip security analysis
    □ Skip duplication check
    □ Priority files (comma-separated)
  - "Start Review" button
  - Recent reviews list (last 10)

Validation:
  - URL must match BitBucket PR pattern
  - Token must not be empty
  - Show validation errors inline


PAGE 2: REVIEW STATUS (Real-time)
─────────────────────────────────
URL: /review/:reviewId

Components:
  - Progress bar (0-100%)
  - Current phase indicator:
    ○ Queued
    ● Fetching PR...
    ○ Building context...
    ○ Running agents...
    ○ Posting comments...
    ○ Complete
  - Files being analyzed (live list)
  - Findings as they come in (live feed)
  - Time elapsed
  - Estimated time remaining

WebSocket connection for real-time updates


PAGE 3: REVIEW RESULTS
──────────────────────
URL: /review/:reviewId/results

Components:
  - Summary stats:
    - Total findings
    - By severity (4 critical, 8 high, etc.)
    - Files analyzed
    - Time taken
    - Cost
  - Findings table:
    | Severity | File | Line | Issue | Agent |
    | HIGH     | api.ts | 45 | SQL injection | Security |
  - Filter by severity
  - Filter by category
  - Click finding → expand details
  - Link to BitBucket comment


PAGE 4: INDEXING
────────────────
URL: /index

Components:
  - Repository URL input
  - Token input
  - Framework selector (auto-detect, React, Spring, etc.)
  - Branch selector (default: main)
  - "Start Indexing" button
  - Index status/progress
  - Indexed repositories list with stats


PAGE 5: OBSERVABILITY
─────────────────────
URL: /observability

Components:
  - Trace viewer (select review → see waterfall)
  - Log viewer (filterable log stream)
  - Metrics panels:
    - Reviews over time (chart)
    - Success rate (gauge)
    - Average duration (chart)
    - Cost breakdown (pie)
  - System health:
    - Service status (Qdrant, Memgraph, Redis, OpenRouter)
    - Circuit breaker states
    - Queue depth
```

## 8.2 Real-time Updates

```
WEBSOCKET EVENTS
═══════════════════════════════════════════════════════════════════════════

Connection: ws://server/ws?reviewId=xxx

EVENTS FROM SERVER:

{
  "type": "PHASE_CHANGE",
  "phase": "building-context",
  "percentage": 20
}

{
  "type": "FILE_PROCESSING",
  "file": "src/api/users.ts",
  "status": "analyzing"
}

{
  "type": "FINDING_ADDED",
  "finding": {
    "file": "src/api/users.ts",
    "line": 45,
    "severity": "high",
    "title": "SQL Injection detected",
    "agent": "security"
  }
}

{
  "type": "AGENT_COMPLETE",
  "agent": "security",
  "findings_count": 3,
  "duration_ms": 5000
}

{
  "type": "REVIEW_COMPLETE",
  "summary": {
    "total_findings": 12,
    "comments_posted": 10,
    "duration_ms": 23000,
    "cost_usd": 0.08
  }
}

{
  "type": "REVIEW_FAILED",
  "error": "BitBucket token invalid",
  "code": "AUTH_ERROR"
}
```

---

# PART 9: TASK BREAKDOWN

## 9.1 Phase 1: Foundation (Days 1-3)

```
PHASE 1 TASKS
═══════════════════════════════════════════════════════════════════════════

TASK 1.1: Project Setup
───────────────────────
□ Initialize Bun project
□ Set up TypeScript with path aliases
□ Create folder structure (as defined)
□ Add ESLint + Prettier config
□ Create .env.example with all variables
□ Write env validation schema (Zod)
□ Add basic README

TASK 1.2: Docker Compose
────────────────────────
□ Qdrant service definition
□ Memgraph service definition
□ Redis service definition
□ Health check configurations
□ Volume persistence
□ Test: docker compose up works

TASK 1.3: Elysia Server Skeleton
────────────────────────────────
□ Create basic Elysia app
□ Add CORS plugin
□ Add OpenAPI/Swagger plugin
□ Create health endpoint (GET /health)
□ Create trace middleware (generates traceId)
□ Create error middleware (catches all errors)
□ Test: Server starts, health returns 200

TASK 1.4: Database Clients
──────────────────────────
□ Qdrant client wrapper
  - Connection with retry
  - Collection creation
  - Health check method
□ Memgraph client wrapper
  - Connection via neo4j-driver
  - Schema setup
  - Health check method
□ Redis client wrapper
  - Connection with ioredis
  - Basic get/set/pub methods
  - Health check method
□ Test: All DBs connect successfully

TASK 1.5: Logging & Config
──────────────────────────
□ Pino logger setup
□ Log levels from env
□ Request logging middleware
□ Config module that loads validated env
□ Test: Logs appear in structured format

DELIVERABLE: Server starts, connects to all DBs, has health endpoint
```

## 9.2 Phase 2: Indexing (Days 4-7)

```
PHASE 2 TASKS
═══════════════════════════════════════════════════════════════════════════

TASK 2.1: Tree-sitter Setup
───────────────────────────
□ Install tree-sitter + language parsers
□ Create parser factory (language → parser)
□ Create base parser interface
□ Test: Can parse a TS file into AST

TASK 2.2: Framework Detection
─────────────────────────────
□ Define framework configs (file patterns, etc.)
□ Implement detection logic
□ Return confidence score
□ Test: Correctly detects React, Spring, Flutter projects

TASK 2.3: TypeScript/React Parser
─────────────────────────────────
□ Extract functions (name, params, body, lines)
□ Extract classes and methods
□ Extract imports and exports
□ Handle JSX/TSX
□ Test: Parses real React component correctly

TASK 2.4: Java/Spring Parser
────────────────────────────
□ Extract classes and methods
□ Extract annotations
□ Parse Spring-specific patterns
□ Handle generics
□ Test: Parses Spring controller correctly

TASK 2.5: Dart/Flutter Parser
─────────────────────────────
□ Extract classes (including widgets)
□ Extract functions
□ Parse Dart imports
□ Test: Parses Flutter widget correctly

TASK 2.6: Graph Builder
───────────────────────
□ Create File nodes
□ Create Function nodes
□ Create Class nodes
□ Create CALLS edges (function → function)
□ Create IMPORTS edges (file → file)
□ Create CONTAINS edges (file → function)
□ Test: Graph has correct structure

TASK 2.7: Embedding Generator
─────────────────────────────
□ Voyage AI client (voyage-code-3)
□ Batch embedding (50 at a time)
□ Rate limiting
□ Store in Qdrant with metadata
□ Test: Embeddings generated and stored

TASK 2.8: Index API Endpoints
─────────────────────────────
□ POST /api/index - Start indexing
□ GET /api/index/:id/status - Get progress
□ POST /api/index/incremental - Incremental update
□ GET /api/index/frameworks - List frameworks

TASK 2.9: Index Queue Worker
────────────────────────────
□ Clone repository
□ Detect framework
□ Run appropriate parser
□ Build graph
□ Generate embeddings
□ Update status throughout
□ Handle failures gracefully

DELIVERABLE: Can index a React repo, data appears in Qdrant + Memgraph
```

## 9.3 Phase 3: Review Core (Days 8-12)

```
PHASE 3 TASKS
═══════════════════════════════════════════════════════════════════════════

TASK 3.1: BitBucket Client
──────────────────────────
□ Implement get_pr_details
□ Implement get_pr_diff
□ Implement post_inline_comment
□ Implement post_summary_comment
□ Handle auth errors
□ Handle rate limits
□ Test: Can fetch real PR diff

TASK 3.2: Diff Parser
─────────────────────
□ Parse unified diff format
□ Extract file paths
□ Extract added/removed lines
□ Map line numbers (for comments)
□ Test: Parses complex diff correctly

TASK 3.3: Context Builder
─────────────────────────
□ Expand diff to full functions
□ Query graph for callers
□ Query graph for imports
□ Query vectors for similar code
□ Assemble context package
□ Test: Context includes all needed data

TASK 3.4: OpenRouter Client
───────────────────────────
□ Create API client
□ Model selection by role
□ Streaming support
□ Token counting
□ Cost tracking
□ Error handling + retry
□ Test: Can make completion requests

TASK 3.5: Mastra Setup
──────────────────────
□ Initialize Mastra instance
□ Register all tools
□ Configure model routing
□ Set up observability hooks
□ Test: Mastra initializes correctly

TASK 3.6: Create Tools
──────────────────────
□ BitBucket tools (get_pr_diff, post_comment, etc.)
□ Graph tools (query_callers, query_callees, etc.)
□ Vector tools (search_similar, find_duplicates)
□ Search tools (grep_codebase, find_usages)
□ Code tools (read_file, expand_context)
□ Test: Each tool works independently

TASK 3.7: Review API Endpoints
──────────────────────────────
□ POST /api/review - Submit review
□ GET /api/review/:id/status - Get status
□ GET /api/review/:id/result - Get results
□ DELETE /api/review/:id - Cancel
□ Test: API accepts requests

TASK 3.8: Review Queue Worker
─────────────────────────────
□ Process review job
□ Call BitBucket for diff
□ Build context
□ (Placeholder for agents)
□ Post results
□ Update status throughout
□ Test: Worker processes job

DELIVERABLE: Can submit PR, fetch diff, build context, post placeholder comment
```

## 9.4 Phase 4: Agents (Days 13-18)

```
PHASE 4 TASKS
═══════════════════════════════════════════════════════════════════════════

TASK 4.1: Security Agent
────────────────────────
□ Define agent with Mastra
□ Write system prompt (security focus)
□ Define output schema (findings)
□ Implement checks (SQL injection, XSS, etc.)
□ Use grep tool for patterns
□ Test with known vulnerable code

TASK 4.2: Logic Agent
─────────────────────
□ Define agent with Mastra
□ Write system prompt (bug detection)
□ Define output schema
□ Implement checks (null, async, loops)
□ Use read_file tool for context
□ Test with buggy code samples

TASK 4.3: Duplication Agent
───────────────────────────
□ Define agent with Mastra
□ Write system prompt (DRY focus)
□ Use search_similar tool
□ Implement comparison logic
□ Test with duplicate function

TASK 4.4: API Change Agent
──────────────────────────
□ Define agent with Mastra
□ Write system prompt (breaking changes)
□ Use query_callers tool
□ Use grep tool for usages
□ Implement impact analysis
□ Test with breaking change scenario

TASK 4.5: Refactor Agent
────────────────────────
□ Define agent with Mastra
□ Write system prompt (code quality)
□ Lower priority suggestions
□ Test with code smell samples

TASK 4.6: Synthesis Agent
─────────────────────────
□ Define agent with Mastra
□ Write system prompt (combine & format)
□ Implement deduplication
□ Implement conflict resolution
□ Format for BitBucket markdown
□ Test with mixed findings

TASK 4.7: Review Workflow
─────────────────────────
□ Create Mastra workflow
□ Step 1: Fetch PR
□ Step 2: Build context
□ Step 3: Run agents (parallel)
□ Step 4: Synthesis
□ Step 5: Post comments
□ Handle errors at each step
□ Test full flow

TASK 4.8: Integration Testing
─────────────────────────────
□ Test with real React PR
□ Test with real Spring PR
□ Test with large PR (>30 files)
□ Test error scenarios
□ Verify comments posted correctly

DELIVERABLE: Full review works end-to-end, comments appear on BitBucket
```

## 9.5 Phase 5: Dashboard (Days 19-22)

```
PHASE 5 TASKS
═══════════════════════════════════════════════════════════════════════════

TASK 5.1: React Project Setup
─────────────────────────────
□ Create Vite + React project
□ Add Tailwind CSS
□ Add React Router
□ Set up folder structure
□ Create API client (fetch wrapper)

TASK 5.2: Submit Review Page
────────────────────────────
□ PR URL input with validation
□ Token input (password type)
□ Options checkboxes
□ Submit button with loading state
□ Recent reviews list
□ Error display

TASK 5.3: Review Status Page
────────────────────────────
□ WebSocket connection hook
□ Progress bar component
□ Phase indicator component
□ Live findings feed
□ File list with status icons
□ Error handling

TASK 5.4: Review Results Page
─────────────────────────────
□ Summary stats cards
□ Findings table with filters
□ Expandable finding details
□ Link to BitBucket comment
□ Export option (JSON)

TASK 5.5: Indexing Page
───────────────────────
□ Repo URL input
□ Framework selector
□ Progress indicator
□ Indexed repos list
□ Re-index button

TASK 5.6: Observability Page
────────────────────────────
□ Trace viewer component
  - Waterfall visualization
  - Time breakdown
  - Token usage
□ Log viewer component
  - Filterable log stream
  - Level filter
  - Search
□ Metrics panels
  - Reviews over time
  - Success rate
  - Cost tracking

TASK 5.7: WebSocket Server
──────────────────────────
□ Add WebSocket plugin to Elysia
□ Room management (by reviewId)
□ Event broadcasting
□ Connection handling

TASK 5.8: Polish & Testing
──────────────────────────
□ Responsive design
□ Loading states everywhere
□ Error boundaries
□ Test all flows manually
□ Fix edge cases

DELIVERABLE: Full dashboard works, real-time updates, observability visible
```

## 9.6 Phase 6: Hardening (Days 23-25)

```
PHASE 6 TASKS
═══════════════════════════════════════════════════════════════════════════

TASK 6.1: Error Handling
────────────────────────
□ Circuit breaker for each service
□ Retry logic with backoff
□ Graceful degradation modes
□ Clear error messages to UI
□ Error aggregation/reporting

TASK 6.2: Rate Limiting
───────────────────────
□ API rate limiting (100 req/min)
□ LLM rate limit handling
□ Embedding rate limit handling
□ BitBucket rate limit handling

TASK 6.3: Security
──────────────────
□ Token validation
□ Input sanitization
□ No token logging
□ HTTPS in production

TASK 6.4: Performance
─────────────────────
□ Optimize graph queries
□ Embedding caching
□ Parallel where possible
□ Memory management for large repos

TASK 6.5: Testing
─────────────────
□ Unit tests for parsers
□ Unit tests for tools
□ Integration tests for agents
□ E2E test for full review
□ Load testing

TASK 6.6: Documentation
───────────────────────
□ API documentation (OpenAPI)
□ Architecture documentation
□ Deployment guide
□ README with quick start

DELIVERABLE: Production-ready system
```

---

# PART 10: TESTING STRATEGY

## 10.1 Test Categories

```
TESTING STRATEGY
═══════════════════════════════════════════════════════════════════════════

UNIT TESTS (Fast, No External Dependencies)
───────────────────────────────────────────
- Parsers: Given code string → correct AST extraction
- Diff parser: Given unified diff → correct file/line extraction
- Validators: Given input → correct validation result
- Utilities: Hash, retry, circuit breaker

Mock: External services, databases

INTEGRATION TESTS (With Test Databases)
───────────────────────────────────────
- Graph builder: Parse file → nodes/edges in Memgraph
- Embedding: Code → embeddings in Qdrant
- Tools: Tool calls → correct results
- Agents: Agent with mocked LLM → correct findings format

Use: Docker test containers

E2E TESTS (Full System)
───────────────────────
- Submit review → comments posted to test repo
- Index repo → data in both DBs
- Dashboard flow → UI shows correct state

Use: Test BitBucket repo, real APIs (sandbox keys)
```

## 10.2 Test Fixtures

```
TEST FIXTURES NEEDED
═══════════════════════════════════════════════════════════════════════════

SAMPLE CODE:
  - react-component.tsx (with hooks, props)
  - spring-controller.java (with annotations)
  - flutter-widget.dart
  - vulnerable-code.ts (SQL injection, XSS)
  - duplicate-code.ts (similar to existing)
  - breaking-change.ts (API signature change)

SAMPLE DIFFS:
  - simple-change.diff (one file, few lines)
  - multi-file.diff (5 files)
  - large-change.diff (50+ files)
  - rename-refactor.diff (function renamed)

MOCK RESPONSES:
  - bitbucket-pr.json
  - bitbucket-diff.json
  - openrouter-completion.json
  - voyage-embedding.json
```

---

# APPENDIX A: AGENT PROMPT TEMPLATES

## A.1 Security Agent Prompt

```
SECURITY AGENT SYSTEM PROMPT
═══════════════════════════════════════════════════════════════════════════

You are a security-focused code reviewer. Analyze the provided code changes
for security vulnerabilities.

## Your Focus Areas

1. **Injection Attacks**
   - SQL injection (string concatenation in queries)
   - Command injection (user input in shell commands)
   - XSS (unsanitized HTML output)

2. **Authentication & Authorization**
   - Missing authentication checks
   - Broken access control
   - Insecure token handling

3. **Sensitive Data**
   - Hardcoded secrets, API keys, passwords
   - Sensitive data in logs
   - Unencrypted sensitive data

4. **Cryptography**
   - Weak algorithms (MD5, SHA1 for passwords)
   - Hardcoded keys/IVs
   - Insecure random number generation

## Tools Available

- `grep_codebase`: Search for patterns in the codebase
- `search_similar`: Find similar code that might have same vulnerability
- `read_file`: Get full file content for context

## Output Format

Return findings as JSON array:
```json
{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 45,
      "severity": "high",
      "title": "SQL Injection vulnerability",
      "description": "User input directly concatenated into SQL query",
      "suggestion": "Use parameterized queries: db.query($1, [userId])",
      "confidence": 0.95,
      "cwe": "CWE-89"
    }
  ]
}
```

## Severity Guide

- **critical**: Exploitable now, data breach risk
- **high**: Security flaw, fix before merge
- **medium**: Potential issue, should fix
- **low**: Best practice violation

Be thorough but avoid false positives. Only report issues you're confident about.
```

## A.2 Duplication Agent Prompt

```
DUPLICATION AGENT SYSTEM PROMPT
═══════════════════════════════════════════════════════════════════════════

You are a code deduplication specialist. Find duplicate or highly similar
code that should be refactored to follow DRY principles.

## Your Process

1. For each NEW function in the PR:
   - Use `search_similar` tool to find similar existing code
   - Review matches with similarity > 0.85

2. For each potential duplicate:
   - Compare the logic (not just text)
   - Consider if they serve same purpose
   - Check if original is in main codebase (not test)

3. Only report if:
   - Logic is truly duplicated (not just similar names)
   - Existing code is reusable
   - Consolidation would improve maintainability

## Tools Available

- `search_similar`: Find semantically similar code (returns similarity score)
- `read_file`: Get full code of potential duplicate

## Output Format

```json
{
  "findings": [
    {
      "file": "src/services/order.ts",
      "line": 45,
      "severity": "medium",
      "title": "Duplicate of existing function",
      "description": "Function checkEmailFormat is 94% similar to validateEmail in src/utils/validators.ts",
      "suggestion": "Import and use validateEmail from '@/utils/validators' instead",
      "confidence": 0.94,
      "existingCode": {
        "file": "src/utils/validators.ts",
        "function": "validateEmail",
        "line": 12
      }
    }
  ]
}
```

## When NOT to Report

- Test utilities that intentionally duplicate for isolation
- Framework-required boilerplate
- Similar but contextually different logic
- Similarity < 0.85
```

---

# APPENDIX B: BITBUCKET COMMENT FORMATS

## B.1 Inline Comment Format

```markdown
⚠️ **HIGH** | Security

**SQL Injection vulnerability detected**

User input is directly concatenated into the SQL query string, which allows
attackers to execute arbitrary SQL commands.

**Current code:**
```typescript
const user = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
```

**Suggested fix:**
```typescript
const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
```

📚 [CWE-89: SQL Injection](https://cwe.mitre.org/data/definitions/89.html)

---
_AI Code Review • confidence: 95%_
```

## B.2 Summary Comment Format

```markdown
## 🤖 AI Code Review Summary

### Overview
- **Files analyzed:** 12
- **Issues found:** 7
- **Review time:** 45 seconds

### Findings by Severity

| Severity | Count |
|----------|-------|
| 🔴 Critical | 0 |
| 🟠 High | 2 |
| 🟡 Medium | 3 |
| 🔵 Low | 2 |

### Key Issues

1. **SQL Injection** in `src/api/users.ts:45` (High)
2. **Breaking API Change** in `src/services/user.ts:12` (High)
3. **Duplicate Code** in `src/utils/validate.ts:30` (Medium)

### Recommendation

🟡 **Review Suggested** — Please address the 2 high-severity issues before merging.

<details>
<summary>Full findings list</summary>

... detailed list ...

</details>

---
_AI Code Review v1.0 • [View Traces](link) • Cost: $0.08_
```

---

# APPENDIX C: FILE PRIORITY SCORING

```
FILE PRIORITY ALGORITHM
═══════════════════════════════════════════════════════════════════════════

For large PRs, we score files to determine analysis priority:

BASE_SCORES = {
  // Security-critical paths
  "auth/": 100,
  "security/": 100,
  "crypto/": 100,
  "payment/": 100,
  
  // API layer
  "api/": 80,
  "controllers/": 80,
  "routes/": 80,
  "endpoints/": 80,
  
  // Database
  "migrations/": 70,
  "models/": 60,
  "entities/": 60,
  
  // Business logic
  "services/": 50,
  "domain/": 50,
  
  // Lower priority
  "utils/": 30,
  "helpers/": 30,
  "components/": 30,  // UI components
  
  // Skip or minimal
  "tests/": -30,
  "__tests__/": -30,
  "docs/": -50,
  "generated/": -100,
}

MODIFIERS = {
  // File size (more changes = more important)
  lines_changed: min(lines / 10, 20),
  
  // File type
  ".config.": -20,
  ".test.": -30,
  ".spec.": -30,
  ".d.ts": -40,
  
  // Name patterns
  "index.": -10,  // barrel files
  "types.": -15,
}

FINAL_SCORE = base_score + sum(applicable_modifiers)

Process files in descending score order.
Stop when token budget exhausted.
```

---

**END OF IMPLEMENTATION PLAN**

This document should be used as the blueprint for Claude Code to implement the PR Review System. Each task is specific, measurable, and ordered for logical development progression.