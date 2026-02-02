import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createLogger } from "../config/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { parseDiff } from "../bitbucket/diff-parser.ts";

const log = createLogger("tools:bitbucket");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the BitBucket API base URL from the environment.
 */
function getBaseUrl(): string {
  return process.env.BITBUCKET_BASE_URL || "https://api.bitbucket.org/2.0";
}

/**
 * Makes an authenticated request to the BitBucket API.
 */
async function bitbucketFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };

  return withRetry(
    () =>
      fetch(url, {
        ...options,
        headers,
      }),
    {
      maxRetries: 3,
      baseDelay: 1000,
      retryOn: (error: unknown) => {
        if (error instanceof Response) {
          // Retry on rate limits and server errors
          return error.status === 429 || error.status >= 500;
        }
        return true;
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  oldPath: z.string().optional(),
  diff: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

// ---------------------------------------------------------------------------
// get_pr_diff
// ---------------------------------------------------------------------------

export const getPrDiffTool = createTool({
  id: "get_pr_diff",
  description:
    "Fetch the diff content of a BitBucket pull request. " +
    "Returns the list of changed files with their diff content, additions, and deletions.",
  inputSchema: z.object({
    workspace: z.string().describe("BitBucket workspace slug"),
    repoSlug: z.string().describe("Repository slug"),
    prNumber: z.number().describe("Pull request number"),
    token: z.string().describe("BitBucket API token or app password"),
  }),
  outputSchema: z.object({
    files: z.array(DiffFileSchema),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const { workspace, repoSlug, prNumber, token } = input;
    log.debug({ workspace, repoSlug, prNumber }, "Fetching PR diff");

    try {
      const response = await bitbucketFetch(
        `/repositories/${workspace}/${repoSlug}/pullrequests/${prNumber}/diff`,
        token,
        { headers: { Accept: "text/plain" } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        log.error({ status: response.status, errorText }, "Failed to fetch PR diff");
        return {
          files: [],
          success: false,
          error: `BitBucket API error (${response.status}): ${errorText}`,
        };
      }

      const diffText = await response.text();
      const files = parseDiff(diffText);

      log.debug({ fileCount: files.length }, "PR diff fetched");
      return { files, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error({ error: message }, "Failed to fetch PR diff");
      return { files: [], success: false, error: message };
    }
  },
});

// ---------------------------------------------------------------------------
// post_comment (inline)
// ---------------------------------------------------------------------------

export const postCommentTool = createTool({
  id: "post_inline_comment",
  description:
    "Post an inline comment on a specific file and line in a BitBucket pull request.",
  inputSchema: z.object({
    workspace: z.string().describe("BitBucket workspace slug"),
    repoSlug: z.string().describe("Repository slug"),
    prNumber: z.number().describe("Pull request number"),
    token: z.string().describe("BitBucket API token or app password"),
    filePath: z.string().describe("Path of the file to comment on"),
    line: z.number().describe("Line number to attach the comment to"),
    content: z.string().describe("Comment content in Markdown"),
  }),
  outputSchema: z.object({
    commentId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const { workspace, repoSlug, prNumber, token, filePath, line, content } = input;
    log.debug({ workspace, repoSlug, prNumber, filePath, line }, "Posting inline comment");

    try {
      const response = await bitbucketFetch(
        `/repositories/${workspace}/${repoSlug}/pullrequests/${prNumber}/comments`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            content: { raw: content },
            inline: {
              path: filePath,
              to: line,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        log.error({ status: response.status, errorText }, "Failed to post inline comment");
        return { commentId: "", success: false, error: `BitBucket API error (${response.status}): ${errorText}` };
      }

      const data = (await response.json()) as { id: number };
      const commentId = String(data.id);

      log.info({ commentId, filePath, line }, "Inline comment posted");
      return { commentId, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error({ error: message }, "Failed to post inline comment");
      return { commentId: "", success: false, error: message };
    }
  },
});

// ---------------------------------------------------------------------------
// post_summary
// ---------------------------------------------------------------------------

export const postSummaryTool = createTool({
  id: "post_summary_comment",
  description:
    "Post a general summary comment (not line-specific) on a BitBucket pull request.",
  inputSchema: z.object({
    workspace: z.string().describe("BitBucket workspace slug"),
    repoSlug: z.string().describe("Repository slug"),
    prNumber: z.number().describe("Pull request number"),
    token: z.string().describe("BitBucket API token or app password"),
    content: z.string().describe("Summary comment content in Markdown"),
  }),
  outputSchema: z.object({
    commentId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const { workspace, repoSlug, prNumber, token, content } = input;
    log.debug({ workspace, repoSlug, prNumber }, "Posting summary comment");

    try {
      const response = await bitbucketFetch(
        `/repositories/${workspace}/${repoSlug}/pullrequests/${prNumber}/comments`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            content: { raw: content },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        log.error({ status: response.status, errorText }, "Failed to post summary comment");
        return { commentId: "", success: false, error: `BitBucket API error (${response.status}): ${errorText}` };
      }

      const data = (await response.json()) as { id: number };
      const commentId = String(data.id);

      log.info({ commentId }, "Summary comment posted");
      return { commentId, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error({ error: message }, "Failed to post summary comment");
      return { commentId: "", success: false, error: message };
    }
  },
});
