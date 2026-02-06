/**
 * Shared span-tree utilities used by MastraTraceViewer and InlineTracePanel.
 */

import type { MastraSpan } from "../api/types";

export interface SpanTreeNode extends MastraSpan {
  children: SpanTreeNode[];
  depth: number;
}

export const SPAN_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  agent_run: { bg: "bg-brand-500", text: "text-brand-700" },
  model_generation: { bg: "bg-emerald-500", text: "text-emerald-700" },
  tool_call: { bg: "bg-amber-500", text: "text-amber-700" },
  mcp_tool_call: { bg: "bg-violet-500", text: "text-violet-700" },
  workflow_run: { bg: "bg-sky-500", text: "text-sky-700" },
  default: { bg: "bg-ink-400", text: "text-ink-600" },
};

export function getSpanType(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes("agent")) return "agent_run";
  if (lowerName.includes("model") || lowerName.includes("generate")) return "model_generation";
  if (lowerName.includes("mcp")) return "mcp_tool_call";
  if (lowerName.includes("tool")) return "tool_call";
  if (lowerName.includes("workflow")) return "workflow_run";
  return "default";
}

export function buildSpanTree(spans: MastraSpan[]): SpanTreeNode[] {
  const spanMap = new Map<string, SpanTreeNode>();
  const roots: SpanTreeNode[] = [];

  for (const span of spans) {
    spanMap.set(span.id, { ...span, children: [], depth: 0 });
  }

  for (const span of spans) {
    const node = spanMap.get(span.id)!;
    if (span.parentSpanId) {
      const parent = spanMap.get(span.parentSpanId);
      if (parent) {
        node.depth = parent.depth + 1;
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  function sortChildren(node: SpanTreeNode) {
    node.children.sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
    node.children.forEach(sortChildren);
  }
  roots.forEach(sortChildren);

  return roots;
}

export function flattenTree(nodes: SpanTreeNode[]): SpanTreeNode[] {
  const result: SpanTreeNode[] = [];
  function traverse(node: SpanTreeNode) {
    result.push(node);
    node.children.forEach(traverse);
  }
  nodes.forEach(traverse);
  return result;
}
