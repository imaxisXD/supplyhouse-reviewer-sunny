import type { PRDetails, DiffFile } from "../types/bitbucket.ts";
import { withRetry } from "../utils/retry.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("bitbucket");

/**
 * Custom error class for BitBucket API errors with status code and
 * request metadata for easier debugging and conditional retry logic.
 */
export class BitBucketApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = "BitBucketApiError";
  }
}

/**
 * Determines whether a failed request should be retried based on the error.
 * Retries on network errors, 429 (rate-limit), and 5xx server errors.
 * Does NOT retry on 401 (auth) or 404 (not found).
 */
function shouldRetry(error: unknown): boolean {
  if (error instanceof BitBucketApiError) {
    // Rate-limited -- always retry
    if (error.statusCode === 429) return true;
    // Server errors -- retry
    if (error.statusCode >= 500) return true;
    // Client errors (401, 404, etc.) -- do not retry
    return false;
  }
  // Network / unknown errors -- retry
  return true;
}

/**
 * Build standard headers for BitBucket API requests.
 */
function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/**
 * BitBucket REST API client.
 *
 * Wraps the v2 REST endpoints needed by the PR review system:
 * fetching PR metadata, diffs, and posting review comments.
 */
export class BitBucketClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ---------------------------------------------------------------------------
  // PR Details
  // ---------------------------------------------------------------------------

  /**
   * Fetch pull-request metadata.
   * GET /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}
   */
  async getPRDetails(
    workspace: string,
    repoSlug: string,
    prId: number,
    token: string,
  ): Promise<PRDetails> {
    const endpoint = `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`;

    return withRetry(
      async () => {
        const url = `${this.baseUrl}${endpoint}`;
        log.debug({ url }, "Fetching PR details");

        const response = await fetch(url, {
          method: "GET",
          headers: buildHeaders(token),
        });

        await this.assertOk(response, endpoint);
        const body = (await response.json()) as Record<string, unknown>;

        return this.mapPRDetails(body);
      },
      { retryOn: shouldRetry },
    );
  }

  // ---------------------------------------------------------------------------
  // PR Diff
  // ---------------------------------------------------------------------------

  /**
   * Fetch the unified diff for a pull request.
   * GET /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/diff
   */
  async getPRDiff(
    workspace: string,
    repoSlug: string,
    prId: number,
    token: string,
  ): Promise<string> {
    const endpoint = `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/diff`;

    return withRetry(
      async () => {
        const url = `${this.baseUrl}${endpoint}`;
        log.debug({ url }, "Fetching PR diff");

        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/plain",
          },
        });

        await this.assertOk(response, endpoint);
        return response.text();
      },
      { retryOn: shouldRetry },
    );
  }

  // ---------------------------------------------------------------------------
  // Inline Comment
  // ---------------------------------------------------------------------------

  /**
   * Post an inline comment on a specific file and line of the pull request.
   * POST /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments
   */
  async postInlineComment(
    workspace: string,
    repoSlug: string,
    prId: number,
    token: string,
    filePath: string,
    line: number,
    content: string,
  ): Promise<{ id: string }> {
    const endpoint = `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`;

    return withRetry(
      async () => {
        const url = `${this.baseUrl}${endpoint}`;
        log.debug({ url, filePath, line }, "Posting inline comment");

        const response = await fetch(url, {
          method: "POST",
          headers: {
            ...buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: { raw: content },
            inline: {
              path: filePath,
              to: line,
            },
          }),
        });

        await this.assertOk(response, endpoint);
        const body = (await response.json()) as Record<string, unknown>;

        return { id: String(body.id) };
      },
      { retryOn: shouldRetry },
    );
  }

  // ---------------------------------------------------------------------------
  // Summary Comment
  // ---------------------------------------------------------------------------

  /**
   * Post a top-level summary comment on the pull request.
   * POST /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments
   */
  async postSummaryComment(
    workspace: string,
    repoSlug: string,
    prId: number,
    token: string,
    content: string,
  ): Promise<{ id: string }> {
    const endpoint = `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`;

    return withRetry(
      async () => {
        const url = `${this.baseUrl}${endpoint}`;
        log.debug({ url }, "Posting summary comment");

        const response = await fetch(url, {
          method: "POST",
          headers: {
            ...buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: { raw: content },
          }),
        });

        await this.assertOk(response, endpoint);
        const body = (await response.json()) as Record<string, unknown>;

        return { id: String(body.id) };
      },
      { retryOn: shouldRetry },
    );
  }

  // ---------------------------------------------------------------------------
  // Update Comment
  // ---------------------------------------------------------------------------

  /**
   * Update an existing comment on a pull request.
   * PUT /repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments/{comment_id}
   */
  async updateComment(
    workspace: string,
    repoSlug: string,
    prId: number,
    token: string,
    commentId: string,
    content: string,
  ): Promise<{ id: string }> {
    const endpoint = `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments/${commentId}`;

    return withRetry(
      async () => {
        const url = `${this.baseUrl}${endpoint}`;
        log.debug({ url, commentId }, "Updating comment");

        const response = await fetch(url, {
          method: "PUT",
          headers: {
            ...buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: { raw: content },
          }),
        });

        await this.assertOk(response, endpoint);
        const body = (await response.json()) as Record<string, unknown>;

        return { id: String(body.id) };
      },
      { retryOn: shouldRetry },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Assert that a fetch response has a 2xx status code.
   * Throws a `BitBucketApiError` with contextual information otherwise.
   */
  private async assertOk(response: Response, endpoint: string): Promise<void> {
    if (response.ok) return;

    let detail = "";
    try {
      const text = await response.text();
      detail = text.slice(0, 500);
    } catch {
      // Ignore body-reading errors
    }

    const status = response.status;

    if (status === 401) {
      log.warn({ endpoint, status }, "BitBucket authentication failed");
      throw new BitBucketApiError(status, endpoint, `Authentication failed for ${endpoint}: ${detail}`);
    }

    if (status === 404) {
      log.warn({ endpoint, status }, "BitBucket resource not found");
      throw new BitBucketApiError(status, endpoint, `Resource not found: ${endpoint}`);
    }

    if (status === 429) {
      log.warn({ endpoint, status }, "BitBucket rate limit exceeded");
      throw new BitBucketApiError(status, endpoint, `Rate limit exceeded for ${endpoint}`);
    }

    log.error({ endpoint, status, detail }, "BitBucket API error");
    throw new BitBucketApiError(status, endpoint, `BitBucket API error ${status} for ${endpoint}: ${detail}`);
  }

  /**
   * Map the raw BitBucket API response into our internal PRDetails type.
   */
  private mapPRDetails(raw: Record<string, unknown>): PRDetails {
    const author = raw.author as Record<string, unknown> | undefined;
    const source = raw.source as Record<string, unknown> | undefined;
    const destination = raw.destination as Record<string, unknown> | undefined;
    const sourceBranch = source?.branch as Record<string, unknown> | undefined;
    const destBranch = destination?.branch as Record<string, unknown> | undefined;
    const sourceRepo = source?.repository as Record<string, unknown> | undefined;
    const sourceWorkspaceObj = sourceRepo?.workspace as Record<string, unknown> | undefined;
    const sourceWorkspace = (sourceWorkspaceObj?.slug as string) ?? "";
    const sourceRepoSlug = (sourceRepo?.slug as string) ?? "";
    const sourceFullName = (sourceRepo?.full_name as string) ?? "";
    let parsedWorkspace = sourceWorkspace;
    let parsedRepoSlug = sourceRepoSlug;
    if ((!parsedWorkspace || !parsedRepoSlug) && sourceFullName.includes("/")) {
      const [ws, slug] = sourceFullName.split("/");
      if (!parsedWorkspace && ws) parsedWorkspace = ws;
      if (!parsedRepoSlug && slug) parsedRepoSlug = slug;
    }

    return {
      id: raw.id as number,
      title: (raw.title as string) ?? "",
      description: (raw.description as string) ?? "",
      author: {
        displayName: (author?.display_name as string) ?? "",
        uuid: (author?.uuid as string) ?? "",
      },
      sourceBranch: (sourceBranch?.name as string) ?? "",
      targetBranch: (destBranch?.name as string) ?? "",
      sourceWorkspace: parsedWorkspace || undefined,
      sourceRepoSlug: parsedRepoSlug || undefined,
      state: (raw.state as string) ?? "",
      createdOn: (raw.created_on as string) ?? "",
      updatedOn: (raw.updated_on as string) ?? "",
    };
  }
}

/**
 * Singleton BitBucket client configured from environment variables.
 */
export const bitbucketClient = new BitBucketClient(
  process.env.BITBUCKET_BASE_URL || "https://api.bitbucket.org/2.0",
);
