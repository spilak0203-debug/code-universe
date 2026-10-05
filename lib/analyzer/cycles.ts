/**
 * Tarjan's strongly connected components, iterative (repos can have import
 * chains deep enough to blow the JS stack with the recursive version).
 *
 * Returns components with more than one member, plus single nodes with a self-loop.
 */
export function stronglyConnectedComponents(nodeCount: number, adjacency: readonly number[][]): number[][] {
  const index = new Int32Array(nodeCount).fill(-1);
  const low = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;

  // Explicit DFS frames: [node, next-neighbour cursor].
  const frames: [number, number][] = [];

  for (let root = 0; root < nodeCount; root++) {
    if (index[root] !== -1 || !adjacency[root]?.length) continue;
    frames.push([root, 0]);
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;

    while (frames.length) {
      const frame = frames[frames.length - 1];
      const [v, cursor] = frame;
      const edges = adjacency[v] ?? [];
      if (cursor < edges.length) {
        frame[1]++;
        const w = edges[cursor];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
        continue;
      }

      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          component.push(w);
        } while (w !== v);
        if (component.length > 1 || edges.includes(v)) result.push(component.reverse());
      }
    }
  }
  return result.sort((a, b) => b.length - a.length);
}
