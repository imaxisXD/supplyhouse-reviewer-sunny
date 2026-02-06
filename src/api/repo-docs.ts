import { Elysia, t } from "elysia";
import { createLogger } from "../config/logger.ts";
import {
  buildRepoDocsSummary,
  createRepoDoc,
  deleteRepoDoc,
  getRepoDocById,
  listRepoDocs,
  updateRepoDoc,
} from "../db/repo-docs.ts";

const log = createLogger("api:repo-docs");

export const repoDocsRoutes = new Elysia({ prefix: "/api/docs" })
  .get("/repos/:repoId", ({ params, set }) => {
    const repoId = decodeURIComponent(params.repoId);
    try {
      const docs = listRepoDocs(repoId);
      return { docs };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ repoId, error: msg }, "Failed to list repo docs");
      set.status = 500;
      return { error: "Failed to list repo docs" };
    }
  })
  .get("/repos/:repoId/summary", ({ params, set }) => {
    const repoId = decodeURIComponent(params.repoId);
    try {
      const summary = buildRepoDocsSummary(repoId);
      return summary;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ repoId, error: msg }, "Failed to build repo docs summary");
      set.status = 500;
      return { error: "Failed to build repo docs summary" };
    }
  })
  .get("/:docId", ({ params, set }) => {
    try {
      const doc = getRepoDocById(params.docId);
      if (!doc) {
        set.status = 404;
        return { error: "Doc not found" };
      }
      return doc;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ docId: params.docId, error: msg }, "Failed to fetch repo doc");
      set.status = 500;
      return { error: "Failed to fetch repo doc" };
    }
  })
  .post(
    "/",
    ({ body, set }) => {
      try {
        const doc = createRepoDoc({
          repoId: body.repoId.trim(),
          title: body.title.trim(),
          body: body.body,
        });
        set.status = 201;
        return doc;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ error: msg }, "Failed to create repo doc");
        set.status = 500;
        return { error: "Failed to create repo doc" };
      }
    },
    {
      body: t.Object({
        repoId: t.String({ minLength: 1 }),
        title: t.String({ minLength: 1, maxLength: 200 }),
        body: t.String({ minLength: 1, maxLength: 200_000 }),
      }),
    },
  )
  .put(
    "/:docId",
    ({ params, body, set }) => {
      try {
        const doc = updateRepoDoc(params.docId, {
          title: body.title.trim(),
          body: body.body,
        });
        if (!doc) {
          set.status = 404;
          return { error: "Doc not found" };
        }
        return doc;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ docId: params.docId, error: msg }, "Failed to update repo doc");
        set.status = 500;
        return { error: "Failed to update repo doc" };
      }
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 200 }),
        body: t.String({ minLength: 1, maxLength: 200_000 }),
      }),
    },
  )
  .delete("/:docId", ({ params, set }) => {
    try {
      const deleted = deleteRepoDoc(params.docId);
      if (!deleted) {
        set.status = 404;
        return { error: "Doc not found" };
      }
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ docId: params.docId, error: msg }, "Failed to delete repo doc");
      set.status = 500;
      return { error: "Failed to delete repo doc" };
    }
  });
