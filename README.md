# SupplyHouse AI Code Reviewer

An AI-powered code review system for Bitbucket pull requests. It uses a multi-agent architecture to analyze code for security vulnerabilities, logic errors, duplication, API breaking changes, and refactoring opportunities -- then posts findings as inline comments on the PR.

## Architecture

```
                          +------------------+
                          |    Dashboard     |
                          |  (React + Vite)  |
                          +--------+---------+
                                   |
                                   v
                          +------------------+
                          |  Elysia Server   |
                          |  (Bun runtime)   |
                          +--------+---------+
                                   |
                  +----------------+----------------+
                  |                |                 |
                  v                v                 v
           +------+------+  +-----+------+  +-------+--------+
           |    Redis     |  |   Qdrant   |  |   Memgraph     |
           | (Queue/Cache)|  |  (Vector)  |  |    (Graph)     |
           +------+-------+  +-----+------+  +-------+--------+
                  |
          +-------+-------+
          |    BullMQ     |
          +---+-------+---+
              |       |
              v       v
     +--------+--+ +--+----------+
     |  Review   | |   Index     |
     |  Worker   | |   Worker    |
     | (5 agents)| |             |
     +-----+-----+ +------+-----+
           |               |
     +-----+-----+  +-----+------+
     |  Mastra   |  |  Voyage AI |
     |    AI     |  | (Embedding)|
     +-----------+  +------------+
           |
     +-----+------+
     |  Bitbucket  |
     |  (Comments) |
     +-------------+
```

**Review Worker Agents:**
- Security Agent -- detects vulnerabilities (CWE-tagged)
- Logic Agent -- identifies logic errors and edge cases
- Duplication Agent -- finds duplicated or near-duplicate code
- API Change Agent -- flags breaking API changes
- Refactor Agent -- suggests structural improvements

**Index Worker:** Parses source code via tree-sitter, generates Voyage AI embeddings, stores vectors in Qdrant and function/call graphs in Memgraph.

## Prerequisites

- Bun 1.0+ (runtime and package manager)
- Docker and Docker Compose (for Redis, Qdrant, Memgraph)
- Bitbucket App Password or Access Token with PR read/write scopes
- Voyage AI API key (for code embeddings)
- OpenRouter API key (for LLM inference)

## Setup

```bash
# Clone the repository
git clone <repo-url>
cd supplyhouse-reviewer-sunny

# Install dependencies
bun install

# Start infrastructure services
docker-compose up -d

# Configure environment variables (see below)
cp .env.example .env  # then edit .env

# Build the dashboard
cd dashboard && bun install && bun run build && cd ..

# Start the development server
bun run dev
```

The server starts at `http://localhost:3000` by default. The dashboard is served as static files from the same origin.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `3000` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `development` |
| `LOG_LEVEL` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `debug` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `QDRANT_URL` | Qdrant vector database URL | `http://localhost:6333` |
| `MEMGRAPH_URL` | Memgraph graph database Bolt URL | `bolt://localhost:7687` |
| `VOYAGE_API_KEY` | Voyage AI API key for code embeddings | (required) |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM inference | (required) |
| `BITBUCKET_BASE_URL` | Bitbucket API base URL | `https://api.bitbucket.org/2.0` |
| `TLS_CERT_PATH` | Path to TLS certificate (production) | (optional) |
| `TLS_KEY_PATH` | Path to TLS private key (production) | (optional) |
| `CLONE_DIR` | Directory for cloning repositories during indexing | (optional) |

## API Reference

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health/` | Basic health check |
| `GET` | `/health/services` | Service health with circuit breaker states |

### Review

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/review` | Submit a PR for review |
| `GET` | `/api/review/:id/status` | Get review progress/status |
| `GET` | `/api/review/:id/result` | Get completed review results |
| `DELETE` | `/api/review/:id` | Cancel a running review |

### Indexing

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/index` | Submit a repository for indexing |
| `POST` | `/api/index/incremental` | Submit incremental index for changed files |
| `GET` | `/api/index/:id/status` | Get indexing job status |
| `GET` | `/api/index/jobs` | List recent indexing jobs |
| `DELETE` | `/api/index/:id` | Cancel a running index job |

### Observability

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/reviews` | List past reviews (with `?limit=N`) |
| `GET` | `/api/metrics` | Aggregate metrics and circuit breaker states |

### WebSocket

| Endpoint | Description |
|---|---|
| `/ws?reviewId=<id>` | Real-time review progress events |
| `/ws?indexId=<id>` | Real-time indexing progress events |

### Review Submission Body

```json
{
  "prUrl": "https://bitbucket.org/workspace/repo/pull-requests/123",
  "token": "bitbucket-access-token",
  "options": {
    "skipSecurity": false,
    "skipDuplication": false,
    "priorityFiles": ["src/critical-module.ts"]
  }
}
```

## Supported Languages

| Language | Parser | Status |
|---|---|---|
| TypeScript / JavaScript | tree-sitter-typescript | Supported |
| Java | tree-sitter-java | Supported |
| Dart | tree-sitter-dart | Supported |
| Python | -- | Excluded |

Language parsers extract functions, classes, imports, and call relationships for graph-based code intelligence.

## Development

```bash
# Run the dev server with hot reload
bun run dev

# Type-check the project
bun run typecheck
# or
npx tsc --noEmit

# Run tests
bun test

# Build the dashboard for production
cd dashboard && bun run build
```

### Project Structure

```
src/
  agents/         # Review agents (security, logic, duplication, api-change, refactor, synthesis)
  api/            # Elysia route handlers (review, index, health, ws, reviews-list)
  bitbucket/      # Bitbucket API client and diff parser
  config/         # Environment validation and logger setup
  db/             # Redis, Qdrant, and Memgraph clients
  indexing/        # Code parsers (tree-sitter), embedding generator, graph builder
  mastra/         # Mastra AI orchestration and model configuration
  middleware/     # Rate limiting
  queue/          # BullMQ review and index workers
  review/         # Context builder, large PR handling, workflow orchestration
  services/       # Circuit breakers and graceful degradation
  tools/          # Agent tools (graph, vector, search, code, bitbucket)
  types/          # TypeScript type definitions
  utils/          # Circuit breaker, retry, priority utilities
  __tests__/      # Unit tests
dashboard/
  src/
    api/          # API client and types
    components/   # Reusable UI components
    pages/        # Page components (Home, Indexing, ReviewResults, etc.)
```

## Deployment

### Docker

The infrastructure services (Redis, Qdrant, Memgraph) are defined in `docker-compose.yml`. For production, the application server can be containerized separately or run directly with Bun.

```bash
# Start all infrastructure
docker-compose up -d

# Run the server in production mode
NODE_ENV=production bun run start
```

### TLS Configuration

For HTTPS in production, set the `TLS_CERT_PATH` and `TLS_KEY_PATH` environment variables to point to your certificate and private key files. The server will automatically enable TLS when both are provided.

## License

Private -- SupplyHouse internal use only.
