/**
 * Wire format shared by the analyzer (server) and the viewer (client).
 * Node ids are dense indices into `CodeGraph.nodes`.
 */

export type NodeKind = 'dir' | 'file' | 'function' | 'class' | 'method' | 'external';

export type EdgeKind =
  /** dir → dir/file, file → top-level symbol, class → method */
  | 'contains'
  /** file → file / file → external package (static, dynamic or require) */
  | 'import'
  /** symbol|file → function/class/method (call or `new`) */
  | 'call'
  /** component → component (JSX element) */
  | 'render'
  /** class → base class / implemented class */
  | 'inherit';

export const EDGE_KINDS: readonly EdgeKind[] = ['contains', 'import', 'call', 'render', 'inherit'];

export interface GraphNode {
  id: number;
  kind: NodeKind;
  /** Display name: basename for files/dirs, identifier for symbols, package name for externals. */
  name: string;
  /** Repo-relative path of the file (or dir) this node lives in. Empty for externals. */
  path: string;
  /** Containing node: dir for files/dirs, file for top-level symbols, class for methods. -1 for root/external. */
  parent: number;
  /** Index into `CodeGraph.groups` (top-level directory or workspace package). -1 for externals. */
  group: number;
  /** 1-based line range in `path` (0 for dirs/externals). */
  line: number;
  endLine: number;
  /** Lines of code: file length for files, span for symbols, subtree total for dirs. */
  loc: number;
  /** Bit set of NodeFlag. */
  flags: number;
}

export const NodeFlag = {
  Exported: 1 << 0,
  /** Default export. */
  Default: 1 << 1,
  /** Referenced by name somewhere other than a call (callback, JSX prop, assignment...). */
  Referenced: 1 << 2,
  /** Imported by another file through an import specifier. */
  Imported: 1 << 3,
  Async: 1 << 4,
  /** React-component-looking function (PascalCase and returns/contains JSX). */
  Component: 1 << 5,
  /** React hook (`useXxx`). */
  Hook: 1 << 6,
  Static: 1 << 7,
  /** Node belongs to a strongly connected import cycle. */
  InCycle: 1 << 8,
  /** File is TSX/JSX. */
  Jsx: 1 << 9,
  /** Node.js builtin module (external only). */
  Builtin: 1 << 10,
} as const;

export interface GraphEdge {
  source: number;
  target: number;
  kind: EdgeKind;
  /** Number of syntactic occurrences collapsed into this edge. */
  weight: number;
  /** Import edges only: every specifier was type-only (`import type`), so it does not exist at runtime. */
  typeOnly?: boolean;
}

export interface Group {
  name: string;
  /** Number of files in the group. */
  files: number;
}

export interface RepoRef {
  owner: string;
  repo: string;
  /** Ref that was requested (branch/tag/sha or HEAD). */
  ref: string;
  /** Resolved commit sha, when known. */
  sha: string | null;
  /** Analyzed subdirectory (repo-relative, no leading/trailing slash) or ''. */
  subdir: string;
}

export interface AnalysisStats {
  files: number;
  functions: number;
  classes: number;
  methods: number;
  externals: number;
  importEdges: number;
  callEdges: number;
  renderEdges: number;
  inheritEdges: number;
  /** Call sites whose target could not be resolved to a declaration in the repo. */
  unresolvedCalls: number;
  resolvedCalls: number;
  /** Files that matched the language filter but were skipped (size/limit/vendored). */
  skippedFiles: number;
  /** Files whose links could not be extracted (parser/checker failure); their declarations remain. */
  unlinkedFiles: number;
  /** True when the file limit cut the repo short. */
  truncated: boolean;
  /** 'semantic' = every file resolved with the type checker; 'partial' = time budget hit, rest syntactic. */
  mode: 'semantic' | 'partial';
  totalLoc: number;
  downloadBytes: number;
  timings: { download: number; parse: number; resolve: number; total: number };
}

export interface CodeGraph {
  version: 1;
  repo: RepoRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: Group[];
  /** Strongly connected components (≥2 files, or a self-import) of the runtime file import graph. */
  cycles: number[][];
  stats: AnalysisStats;
}

/** NDJSON messages streamed by /api/analyze. */
export type AnalyzeEvent =
  | { type: 'progress'; stage: AnalyzeStage; message: string; done?: number; total?: number }
  | { type: 'result'; graph: CodeGraph; cached: boolean }
  | { type: 'error'; message: string };

export type AnalyzeStage = 'resolve' | 'download' | 'parse' | 'link' | 'finalize';

export interface AnalyzeOptions {
  includeTests: boolean;
  maxFiles: number;
}

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  includeTests: false,
  maxFiles: 2500,
};

export function hasFlag(node: GraphNode, flag: number): boolean {
  return (node.flags & flag) !== 0;
}
