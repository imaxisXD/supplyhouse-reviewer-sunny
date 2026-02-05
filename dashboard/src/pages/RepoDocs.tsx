import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { mutate } from "swr";
import type { RepoDoc, RepoDocListItem } from "../api/types";
import {
  useRepoDocs,
  useRepoDoc,
  useCreateRepoDoc,
  useUpdateRepoDoc,
  useDeleteRepoDoc,
} from "../api/hooks";
import { panelClass, labelClass, inputClass } from "../utils/styles";

// RepoDocs uses text-[10px] buttons (slightly smaller than shared text-[11px])
const buttonPrimaryClass =
  "inline-flex items-center justify-center gap-2 border border-brand-500 bg-brand-500 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60";
const buttonSecondaryClass =
  "inline-flex items-center justify-center gap-2 border border-ink-900 bg-white px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-700 transition hover:bg-warm-100 disabled:cursor-not-allowed disabled:opacity-60";

export default function RepoDocs() {
  const { repoId } = useParams<{ repoId: string }>();
  const decodedRepoId = repoId ? decodeURIComponent(repoId) : "";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // SWR hooks for data fetching
  const {
    data: docsData,
    error: docsError,
    isLoading: loading,
  } = useRepoDocs(decodedRepoId || undefined);

  const {
    data: docDetail,
    error: docDetailError,
    isLoading: docLoading,
  } = useRepoDoc(selectedId ?? undefined);

  // Mutation hooks
  const { trigger: triggerCreate } = useCreateRepoDoc();
  const { trigger: triggerUpdate } = useUpdateRepoDoc(selectedId ?? "");
  const { trigger: triggerDelete } = useDeleteRepoDoc();

  const docs: RepoDocListItem[] = docsData?.docs ?? [];
  const docsListKey = decodedRepoId ? `/api/docs/repos/${decodedRepoId}` : null;

  const selectedDoc = useMemo(
    () => docs.find((doc) => doc.id === selectedId) ?? null,
    [docs, selectedId],
  );

  // Sync form fields when a doc is fetched
  useEffect(() => {
    if (docDetail) {
      setTitle(docDetail.title);
      setBody(docDetail.body);
    }
  }, [docDetail]);

  // Propagate fetch errors into local error state
  useEffect(() => {
    if (docsError) {
      setError(docsError instanceof Error ? docsError.message : "Failed to load docs");
    }
  }, [docsError]);

  useEffect(() => {
    if (docDetailError) {
      setError(docDetailError instanceof Error ? docDetailError.message : "Failed to load doc");
    }
  }, [docDetailError]);

  // Reset form when repo changes
  useEffect(() => {
    setSelectedId(null);
    setTitle("");
    setBody("");
    setError("");
    setNotice("");
  }, [decodedRepoId]);

  const handleNew = useCallback(() => {
    setSelectedId(null);
    setTitle("");
    setBody("");
    setNotice("");
    setError("");
  }, []);

  const handleSave = useCallback(async () => {
    if (!decodedRepoId) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required");
      return;
    }
    if (!body.trim()) {
      setError("Body is required");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      let saved: RepoDoc;
      if (selectedId) {
        saved = await triggerUpdate({ title: trimmedTitle, body }) as RepoDoc;
      } else {
        saved = await triggerCreate({ repoId: decodedRepoId, title: trimmedTitle, body }) as RepoDoc;
      }

      await mutate(docsListKey);
      setSelectedId(saved.id);
      setTitle(saved.title);
      setBody(saved.body);
      setNotice(selectedId ? "Document updated" : "Document created");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save doc");
    } finally {
      setSaving(false);
    }
  }, [decodedRepoId, title, body, selectedId, triggerUpdate, triggerCreate, docsListKey]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    const ok = window.confirm("Delete this document? This cannot be undone.");
    if (!ok) return;

    setSaving(true);
    setError("");
    setNotice("");
    try {
      await triggerDelete(selectedId);
      setSelectedId(null);
      setTitle("");
      setBody("");
      await mutate(docsListKey);
      setNotice("Document deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete doc");
    } finally {
      setSaving(false);
    }
  }, [selectedId, triggerDelete, docsListKey]);

  const handleSelectDoc = useCallback((docId: string) => {
    setNotice("");
    setError("");
    setSelectedId(docId);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Repository Docs</div>
          <h1 className="mt-2 text-2xl font-semibold text-ink-950">{decodedRepoId || "Repo Docs"}</h1>
          <p className="mt-2 text-sm text-ink-700">
            Define repo-specific review guidelines. These docs are injected into agent prompts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={decodedRepoId ? `/repo/${encodeURIComponent(decodedRepoId)}` : "/repos"}
            className={buttonSecondaryClass}
          >
            Back to repo
          </Link>
          <button type="button" onClick={handleNew} className={buttonSecondaryClass}>
            New doc
          </button>
          <button type="button" onClick={handleSave} className={buttonPrimaryClass} disabled={saving}>
            {saving ? "Saving\u2026" : "Save"}
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className={`${panelClass} space-y-4`}>
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.35em] text-ink-600">Documents</div>
            <span className="text-[10px] uppercase tracking-[0.3em] text-ink-500">{docs.length}</span>
          </div>

          {loading && <div className="text-xs text-ink-500">Loading docs\u2026</div>}
          {!loading && docs.length === 0 && (
            <div className="border border-dashed border-ink-900 bg-warm-50 p-3 text-xs text-ink-600">
              No docs yet. Create one to start guiding reviews.
            </div>
          )}

          <div className="space-y-2">
            {docs.map((doc) => {
              const isSelected = doc.id === selectedId;
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => handleSelectDoc(doc.id)}
                  className={`w-full text-left border px-3 py-2 transition ${
                    isSelected
                      ? "border-ink-900 bg-warm-100 text-ink-950"
                      : "border-ink-900/40 bg-white text-ink-700 hover:bg-warm-100/70"
                  }`}
                >
                  <div className="text-xs font-semibold truncate">{doc.title}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-ink-500">
                    {doc.updatedAt}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-6">
          <div className={panelClass}>
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.35em] text-ink-600">Editor</div>
              {selectedDoc && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="text-[10px] uppercase tracking-[0.3em] text-rose-700"
                  disabled={saving}
                >
                  Delete
                </button>
              )}
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className={labelClass} htmlFor="doc-title">Title</label>
                <input
                  id="doc-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={`${inputClass} mt-2`}
                  placeholder="Architecture rules, API conventions, security rules\u2026"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="doc-body">Markdown</label>
                <textarea
                  id="doc-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className={`${inputClass} mt-2 min-h-[240px] font-mono text-xs`}
                  placeholder="# Guidelines\n\n- Use service layer for business logic\n- Avoid raw SQL in controllers\n"
                />
              </div>

              {docLoading && <div className="text-xs text-ink-500">Loading doc\u2026</div>}
              {error && (
                <div className="border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                  {error}
                </div>
              )}
              {notice && (
                <div className="border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800">
                  {notice}
                </div>
              )}
            </div>
          </div>

          <div className={panelClass}>
            <div className="text-[10px] uppercase tracking-[0.35em] text-ink-600">Preview</div>
            <div className="mt-3 max-h-[320px] overflow-y-auto border border-ink-900/20 bg-warm-50 p-4">
              {body.trim().length === 0 ? (
                <div className="text-xs text-ink-500">Start typing markdown to see a preview.</div>
              ) : (
                <ReactMarkdown
                  components={{
                    h1: ({ children }) => (
                      <h1 className="text-base font-semibold text-ink-950 mb-3">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-sm font-semibold text-ink-900 mt-4 mb-2">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="text-xs font-semibold uppercase tracking-[0.3em] text-ink-700 mt-3 mb-2">{children}</h3>
                    ),
                    p: ({ children }) => <p className="text-xs text-ink-700 mb-2">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc ml-4 text-xs text-ink-700 space-y-1">{children}</ul>,
                    li: ({ children }) => <li>{children}</li>,
                    em: ({ children }) => <em className="text-ink-600">{children}</em>,
                    strong: ({ children }) => <strong className="text-ink-900">{children}</strong>,
                    code: ({ children }) => (
                      <code className="px-1 py-0.5 bg-white border border-ink-900/10 text-[11px] font-mono text-ink-800">
                        {children}
                      </code>
                    ),
                  }}
                >
                  {body}
                </ReactMarkdown>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
