'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useView } from '@/lib/store';
import { searchNodes, type UniverseModel } from '@/lib/viz/model';
import { NodeRow } from './NodeRow';

export function Search({ model }: { model: UniverseModel }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const select = useView((s) => s.select);
  const results = useMemo(() => searchNodes(model, query, 14), [model, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (id: number) => {
    select(id, { fly: true });
    setQuery('');
    input.current?.blur();
  };

  return (
    <div className="search">
      <svg className="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={input}
        value={query}
        placeholder="Search files, functions, classes…"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter' && results[cursor] !== undefined) {
            pick(results[cursor]);
          } else if (e.key === 'Escape') {
            setQuery('');
            input.current?.blur();
            if (!query) useView.getState().cancelRoute();
          }
        }}
      />
      {!query && <span className="hint kbd">/</span>}
      {query && (
        <div className="search-results scroll">
          {results.length === 0 && <div className="sub" style={{ padding: '6px 8px', color: 'var(--muted)' }}>No matches</div>}
          {results.map((id, i) => (
            <NodeRow key={id} model={model} id={id} active={i === cursor} onPick={pick} />
          ))}
        </div>
      )}
    </div>
  );
}
