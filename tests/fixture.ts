import assert from 'node:assert/strict';
import { buildGraph } from '../lib/analyzer/build';
import type { CodeGraph, EdgeKind } from '../lib/graph/types';

/** A miniature monorepo exercising every resolution path the analyzer supports. */
const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*'] }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['apps/web/src/*'] } } }),

  // --- workspace package consumed by name -------------------------------------------------
  'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js', types: 'dist/index.d.ts' }),
  'packages/core/src/index.ts': `export * from './math';\nexport { formatMoney as money } from './format';\n`,
  'packages/core/src/math.ts': `
    export function add(a: number, b: number) { return a + b; }
    export const square = (x: number) => mul(x, x);
    function mul(a: number, b: number) { return a * b; }
    function neverUsed() { return 42; }
  `,
  'packages/core/src/format.ts': `
    import { add } from './math';
    export function formatMoney(n: number) { return '$' + add(n, 0).toFixed(2); }
  `,

  // --- app using aliases, classes, JSX ----------------------------------------------------
  'apps/web/package.json': JSON.stringify({ name: 'web' }),
  'apps/web/src/utils/greet.ts': `export default function greet(name: string) { return 'hi ' + name; }\n`,
  'apps/web/src/model/shape.ts': `
    import type { App } from '../App';
    export type Renderer = typeof App;
    export class Shape {
      area(): number { return 0; }
      describe() { return 'area=' + this.area(); }
    }
    export class Circle extends Shape {
      constructor(private r: number) { super(); }
      area() { return Math.PI * this.r * this.r; }
    }
  `,
  'apps/web/src/components/Button.tsx': `
    import { memo } from 'react';
    export const Button = memo(function Button(props: { label: string }) { return <button>{props.label}</button>; });
  `,
  'apps/web/src/App.tsx': `
    import type { Shape } from './model/shape';
    import { Circle } from './model/shape';
    import greet from '@/utils/greet';
    import { add, money, square } from '@acme/core';
    import { Button } from './components/Button';
    import React from 'react';

    export function App() {
      const c = new Circle(2);
      const s: Shape = c;
      const label = greet('you') + money(add(1, square(2))) + s.describe();
      return <div><Button label={label} /></div>;
    }
  `,

  // --- CommonJS + an import cycle ----------------------------------------------------------
  'legacy/a.js': `
    const b = require('./b');
    function run() { return b.helper() + 1; }
    module.exports = { run };
  `,
  'legacy/b.js': `
    const a = require('./a');
    exports.helper = function helper() { return 2; };
  `,
};

let graph: CodeGraph | undefined;

export async function getGraph(): Promise<CodeGraph> {
  if (graph) return graph;
  const sources = new Map<string, string>();
  const configs = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) (path.endsWith('.json') ? configs : sources).set(path, text);
  graph = await buildGraph(
    {
      sources,
      configs,
      repo: { owner: 'test', repo: 'fixture', ref: 'HEAD', sha: null, subdir: '' },
      options: { includeTests: false, maxFiles: 1000 },
    },
    () => {},
  );
  return graph;
}

export function find(g: CodeGraph, path: string, name?: string): number {
  const node = g.nodes.find((n) => n.path === path && (name === undefined ? n.kind === 'file' : n.name === name && n.kind !== 'file'));
  assert.ok(node, `node ${path}${name ? `#${name}` : ''} not found`);
  return node.id;
}

export function hasEdge(g: CodeGraph, source: number, target: number, kind: EdgeKind): boolean {
  return g.edges.some((e) => e.source === source && e.target === target && e.kind === kind);
}
