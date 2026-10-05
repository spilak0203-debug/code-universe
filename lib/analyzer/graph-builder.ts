import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from '../graph/types';

/** Accumulates nodes and de-duplicated, weighted edges. */
export class GraphBuilder {
  readonly nodes: GraphNode[] = [];
  private readonly edgeIndex = new Map<string, GraphEdge>();

  addNode(node: Omit<GraphNode, 'id'>): number {
    const id = this.nodes.length;
    this.nodes.push({ id, ...node });
    return id;
  }

  addEdge(source: number, target: number, kind: EdgeKind, typeOnly = false): void {
    if (source < 0 || target < 0 || source === target) return;
    const key = `${source},${target},${kind}`;
    const existing = this.edgeIndex.get(key);
    if (existing) {
      existing.weight++;
      // An edge is type-only only if every occurrence was.
      if (existing.typeOnly && !typeOnly) delete existing.typeOnly;
      return;
    }
    const edge: GraphEdge = { source, target, kind, weight: 1 };
    if (kind === 'import' && typeOnly) edge.typeOnly = true;
    this.edgeIndex.set(key, edge);
  }

  setFlag(id: number, flag: number): void {
    if (id >= 0) this.nodes[id].flags |= flag;
  }

  get edges(): GraphEdge[] {
    return [...this.edgeIndex.values()];
  }

  count(kind: NodeKind): number {
    let n = 0;
    for (const node of this.nodes) if (node.kind === kind) n++;
    return n;
  }
}
