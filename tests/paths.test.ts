import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildModel, type UniverseModel } from '../lib/viz/model';
import { findPath } from '../lib/viz/paths';
import { find, getGraph } from './fixture';

let model: UniverseModel;
async function getModel() {
  return (model ??= buildModel(await getGraph()));
}

const names = (m: UniverseModel, ids: number[]) => ids.map((id) => m.displayName[id]);

describe('path finder', () => {
  test('finds the shortest multi-hop call chain', async () => {
    const m = await getModel();
    const app = find(m.graph, 'apps/web/src/App.tsx', 'App');
    const shape = find(m.graph, 'apps/web/src/model/shape.ts', 'Shape');
    const area = m.graph.nodes.find((n) => n.name === 'area' && n.parent === shape)!.id;
    const path = findPath(m, app, area)!;
    assert.equal(path.kind, 'call');
    assert.equal(path.reversed, false);
    assert.deepEqual(names(m, path.nodes), ['App', 'Shape.describe', 'Shape.area']);
    assert.equal(path.edges.length, 2);
    for (let i = 0; i < path.edges.length; i++) {
      assert.equal(m.edgeSource[path.edges[i]], path.nodes[i]);
      assert.equal(m.edgeTarget[path.edges[i]], path.nodes[i + 1]);
    }
  });

  test('a picked file starts chains from any of its symbols', async () => {
    const m = await getModel();
    const appFile = find(m.graph, 'apps/web/src/App.tsx');
    const mul = find(m.graph, 'packages/core/src/math.ts', 'mul');
    const path = findPath(m, appFile, mul)!;
    assert.equal(path.kind, 'call');
    assert.deepEqual(names(m, path.nodes), ['App', 'square', 'mul']);
  });

  test('falls back to the reverse direction', async () => {
    const m = await getModel();
    const app = find(m.graph, 'apps/web/src/App.tsx', 'App');
    const greet = find(m.graph, 'apps/web/src/utils/greet.ts', 'greet');
    const path = findPath(m, greet, app)!;
    assert.equal(path.reversed, true);
    assert.deepEqual(names(m, path.nodes), ['App', 'greet']);
  });

  test('falls back to an import chain when no call chain exists', async () => {
    const m = await getModel();
    const shapeFile = find(m.graph, 'apps/web/src/model/shape.ts');
    const appFile = find(m.graph, 'apps/web/src/App.tsx');
    const path = findPath(m, shapeFile, appFile)!;
    assert.equal(path.kind, 'import');
    assert.equal(path.reversed, false);
    assert.deepEqual(path.nodes, [shapeFile, appFile]);
  });

  test('reports unconnected bodies and ignores self-routes', async () => {
    const m = await getModel();
    const neverUsed = find(m.graph, 'packages/core/src/math.ts', 'neverUsed');
    const helper = find(m.graph, 'legacy/b.js', 'helper');
    assert.equal(findPath(m, neverUsed, helper), null);
    assert.equal(findPath(m, helper, helper), null);
  });
});
