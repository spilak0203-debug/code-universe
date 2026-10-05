import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildGraph } from '../lib/analyzer/build';
import { NodeFlag } from '../lib/graph/types';
import { find, getGraph, hasEdge } from './fixture';

describe('analyzer', () => {
  test('resolves calls through barrels, renamed re-exports and workspace packages', async () => {
    const g = await getGraph();
    const app = find(g, 'apps/web/src/App.tsx', 'App');
    assert.ok(hasEdge(g, app, find(g, 'packages/core/src/math.ts', 'add'), 'call'), 'App → add');
    assert.ok(hasEdge(g, app, find(g, 'packages/core/src/math.ts', 'square'), 'call'), 'App → square');
    assert.ok(hasEdge(g, app, find(g, 'packages/core/src/format.ts', 'formatMoney'), 'call'), 'App → formatMoney via `money` alias');
  });

  test('resolves tsconfig path aliases and default imports', async () => {
    const g = await getGraph();
    const app = find(g, 'apps/web/src/App.tsx', 'App');
    assert.ok(hasEdge(g, app, find(g, 'apps/web/src/utils/greet.ts', 'greet'), 'call'));
    assert.ok(hasEdge(g, find(g, 'apps/web/src/App.tsx'), find(g, 'apps/web/src/utils/greet.ts'), 'import'));
  });

  test('links constructors, inherited and this-dispatched methods', async () => {
    const g = await getGraph();
    const app = find(g, 'apps/web/src/App.tsx', 'App');
    const shape = find(g, 'apps/web/src/model/shape.ts', 'Shape');
    const circle = find(g, 'apps/web/src/model/shape.ts', 'Circle');
    assert.ok(hasEdge(g, app, circle, 'call'), 'new Circle()');
    assert.ok(hasEdge(g, circle, shape, 'inherit'), 'Circle extends Shape');
    const describeId = g.nodes.find((n) => n.name === 'describe' && n.parent === shape)!.id;
    const areaId = g.nodes.find((n) => n.name === 'area' && n.parent === shape)!.id;
    assert.ok(hasEdge(g, app, describeId, 'call'), 's.describe() via declared type');
    assert.ok(hasEdge(g, describeId, areaId, 'call'), 'this.area()');
  });

  test('JSX elements become render edges, through HOC wrappers', async () => {
    const g = await getGraph();
    const app = find(g, 'apps/web/src/App.tsx', 'App');
    const button = find(g, 'apps/web/src/components/Button.tsx', 'Button');
    assert.ok(hasEdge(g, app, button, 'render'));
    assert.ok(g.nodes[app].flags & NodeFlag.Component);
  });

  test('marks type-only imports and keeps them out of runtime cycles', async () => {
    const g = await getGraph();
    const appFile = find(g, 'apps/web/src/App.tsx');
    const shapeFile = find(g, 'apps/web/src/model/shape.ts');
    const edge = g.edges.find((e) => e.source === appFile && e.target === shapeFile && e.kind === 'import');
    assert.ok(edge, 'import edge exists');
    assert.equal(edge.typeOnly, undefined, 'mixed type + value imports are runtime imports');
    assert.equal(edge.weight, 2);
    const back = g.edges.find((e) => e.source === shapeFile && e.target === appFile && e.kind === 'import');
    assert.equal(back?.typeOnly, true, '`import type` back-reference is type-only');
    assert.ok(!g.cycles.some((c) => c.includes(appFile)), 'type-only back edge must not form a runtime cycle');
  });

  test('follows CommonJS require/exports and detects the a ↔ b cycle', async () => {
    const g = await getGraph();
    const run = find(g, 'legacy/a.js', 'run');
    const helper = find(g, 'legacy/b.js', 'helper');
    assert.ok(hasEdge(g, run, helper, 'call'), 'run → b.helper()');
    const a = find(g, 'legacy/a.js');
    const b = find(g, 'legacy/b.js');
    assert.ok(g.cycles.some((c) => c.includes(a) && c.includes(b)));
    assert.ok(g.nodes[a].flags & NodeFlag.InCycle);
  });

  test('externals, groups and dark matter', async () => {
    const g = await getGraph();
    const react = g.nodes.find((n) => n.kind === 'external' && n.name === 'react');
    assert.ok(react, 'react external node');
    const neverUsed = g.nodes[find(g, 'packages/core/src/math.ts', 'neverUsed')];
    const mul = g.nodes[find(g, 'packages/core/src/math.ts', 'mul')];
    assert.equal(neverUsed.flags & (NodeFlag.Exported | NodeFlag.Referenced), 0, 'neverUsed is unreferenced');
    assert.ok(mul.flags & NodeFlag.Referenced, 'mul is referenced by square');
    const groupNames = g.groups.map((x) => x.name).sort();
    assert.ok(groupNames.includes('@acme/core') && groupNames.includes('web'), `groups: ${groupNames}`);
  });
});

test('deeply nested generated expressions do not overflow the AST walk', async () => {
  const deep = `export const s = ${Array.from({ length: 30000 }, (_, i) => `"p${i}"`).join(' + ')};\n` +
    'export function ok() { return helper(); }\nfunction helper() { return 1; }\n';
  const g = await buildGraph(
    {
      sources: new Map([['deep.ts', deep]]),
      configs: new Map(),
      repo: { owner: 'test', repo: 'deep', ref: 'HEAD', sha: null, subdir: '' },
      options: { includeTests: false, maxFiles: 10 },
    },
    () => {},
  );
  assert.equal(g.stats.unlinkedFiles, 0);
  assert.ok(hasEdge(g, find(g, 'deep.ts', 'ok'), find(g, 'deep.ts', 'helper'), 'call'));
});
