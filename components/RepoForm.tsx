'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { parseRepoInput, viewerHref } from '@/lib/repoInput';

export function RepoForm() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [tests, setTests] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      router.push(viewerHref(parseRepoInput(value), tests));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="repo-form glass">
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="github.com/owner/repo  ·  or a /tree/branch/sub/dir URL"
          spellCheck={false}
          aria-label="GitHub repository"
        />
        <button className="btn primary" type="submit" disabled={!value.trim()}>
          Launch ✦
        </button>
      </div>
      <div className="form-options">
        <label>
          <input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} />
          Include tests & stories
        </label>
        {error && <span style={{ color: 'var(--warn)' }}>{error}</span>}
      </div>
    </form>
  );
}
