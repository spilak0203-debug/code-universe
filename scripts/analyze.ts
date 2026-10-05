/**
 * CLI for exercising the analyzer without the web UI.
 *   npm run analyze -- pmndrs/zustand [--tests] [--out graph.json]
 */
import { writeFileSync } from 'node:fs';
import { analyzeRepository } from '../lib/analyzer/analyze';
import { parseRepoInput } from '../lib/analyzer/github';
import { DEFAULT_ANALYZE_OPTIONS, type CodeGraph } from '../lib/graph/types';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: analyze <owner/repo | github url> [--tests] [--out file.json]');
  process.exit(1);
}
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;

const spec = parseRepoInput(input);
const options = { ...DEFAULT_ANALYZE_OPTIONS, includeTests: args.includes('--tests') };

let lastLine = '';
const { graph } = await analyzeRepository(spec, options, (e) => {
  if (e.type !== 'progress') return;
  const line = `[${e.stage}] ${e.message}${e.total ? ` ${e.done}/${e.total}` : ''}`;
  if (line !== lastLine) process.stderr.write(`\r${line.padEnd(90)}`);
  lastLine = line;
});
process.stderr.write('\n');

report(graph);
if (out) {
  writeFileSync(out, JSON.stringify(graph));
  console.log(`\nwrote ${out} (${(JSON.stringify(graph).length / 1024).toFixed(0)} KB)`);
}

function report(g: CodeGraph) {
  const s = g.stats;
  console.log(`${g.repo.owner}/${g.repo.repo}@${g.repo.sha?.slice(0, 7) ?? g.repo.ref}${g.repo.subdir ? ` (${g.repo.subdir})` : ''}`);
  console.log(`  files ${s.files}  functions ${s.functions}  classes ${s.classes}  methods ${s.methods}  externals ${s.externals}  loc ${s.totalLoc}`);
  console.log(`  edges: import ${s.importEdges}  call ${s.callEdges}  render ${s.renderEdges}  inherit ${s.inheritEdges}`);
  console.log(`  call sites resolved ${s.resolvedCalls}/${s.resolvedCalls + s.unresolvedCalls}  mode ${s.mode}  skipped ${s.skippedFiles}${s.truncated ? ' (truncated)' : ''}`);
  console.log(`  timings ms: download ${s.timings.download}  parse ${s.timings.parse}  resolve ${s.timings.resolve}  total ${s.timings.total}`);
  console.log(`  groups: ${g.groups.map((x) => `${x.name}(${x.files})`).join(', ')}`);

  const incoming = new Map<number, number>();
  for (const e of g.edges) if (e.kind === 'call' || e.kind === 'render') incoming.set(e.target, (incoming.get(e.target) ?? 0) + e.weight);
  const top = [...incoming.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('  most called:');
  for (const [id, n] of top) console.log(`    ${n.toString().padStart(4)}  ${g.nodes[id].name}  (${g.nodes[id].path}:${g.nodes[id].line})`);

  const name = (id: number) => (g.nodes[id].path || g.nodes[id].name) + (g.nodes[id].kind !== 'file' && g.nodes[id].kind !== 'external' ? `#${g.nodes[id].name}` : '');
  const sample = (kind: string, n = 6) => g.edges.filter((e) => e.kind === kind).slice(0, n).map((e) => `    ${name(e.source)} → ${name(e.target)}${e.weight > 1 ? ` ×${e.weight}` : ''}`);
  console.log('  sample calls:\n' + sample('call').join('\n'));
  console.log('  sample imports:\n' + sample('import').join('\n'));
  if (g.cycles.length) console.log(`  cycles: ${g.cycles.length} (largest ${g.cycles[0].length} files: ${g.cycles[0].slice(0, 5).map((id) => g.nodes[id].path).join(' → ')}${g.cycles[0].length > 5 ? ' …' : ''})`);
}
