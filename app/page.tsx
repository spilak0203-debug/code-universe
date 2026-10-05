import Link from 'next/link';
import { RepoForm } from '@/components/RepoForm';

const EXAMPLES = [
  { label: 'pmndrs/zustand', href: '/u/pmndrs/zustand', note: 'tiny' },
  { label: 'vercel/swr', href: '/u/vercel/swr', note: 'hooks' },
  { label: 'expressjs/express', href: '/u/expressjs/express', note: 'CommonJS' },
  { label: 'colinhacks/zod', href: '/u/colinhacks/zod', note: 'monorepo' },
  { label: 'excalidraw/excalidraw', href: '/u/excalidraw/excalidraw', note: 'React app' },
  { label: 'mrdoob/three.js › src', href: '/u/mrdoob/three.js?ref=dev&path=src', note: 'classes' },
  { label: 'facebook/react', href: '/u/facebook/react', note: 'huge' },
];

const FEATURES = [
  {
    title: 'Real symbol resolution',
    body: 'Not regex. A TypeScript Program with its type checker follows imports, re-export barrels, aliases, tsconfig paths and monorepo workspace packages to the declaration actually being called.',
  },
  {
    title: 'A galaxy, not a hairball',
    body: 'A Barnes–Hut force simulation in a Web Worker arranges directories into regions of a disk. Functions orbit their files with Kepler-correct periods; methods are moons.',
  },
  {
    title: 'Architecture insights',
    body: 'Spot import cycles (Tarjan SCC), the most-called “supermassive” functions, and dark matter — functions nothing references. Every body links back to its line on GitHub.',
  },
];

export default function Home() {
  return (
    <main className="landing">
      <div className="starfield" />
      <div className="landing-inner">
        <span className="chip">
          <span className="brand-mark" style={{ width: 12, height: 12 }} /> TypeScript Compiler API · Three.js · Force-directed 3D
        </span>
        <h1>
          Fly through any codebase
          <br />
          like it&apos;s a galaxy.
        </h1>
        <p className="lede">
          Paste a GitHub repository. Code Universe parses every JavaScript & TypeScript file, resolves who calls whom, and
          renders the result as a living star map — files are stars, functions are planets, and calls stream between them as
          light.
        </p>
        <RepoForm />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <Link key={ex.href} className="chip" href={ex.href}>
              {ex.label} <span style={{ color: 'var(--muted)' }}>· {ex.note}</span>
            </Link>
          ))}
        </div>

        <div className="features">
          {FEATURES.map((f) => (
            <div className="feature glass" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>

        <div className="pipeline glass">
          <div className="section-title" style={{ margin: 0 }}>
            How a repo becomes a galaxy
          </div>
          <ol>
            <li>
              <b>Stream</b>The tarball is gunzipped and untarred in memory by a streaming parser — only sources are kept.
            </li>
            <li>
              <b>Parse</b>Each file becomes an AST; declarations (functions, classes, methods, CommonJS exports) become bodies.
            </li>
            <li>
              <b>Link</b>The type checker resolves every call, <span className="mono">new</span>, JSX tag and{' '}
              <span className="mono">extends</span> through aliases.
            </li>
            <li>
              <b>Simulate</b>An octree force simulation positions star systems; planets are packed into orbital rings.
            </li>
            <li>
              <b>Render</b>Instanced shader billboards and flowing edge pulses, all in a handful of draw calls.
            </li>
          </ol>
        </div>
      </div>
    </main>
  );
}
