'use client';

import { useView } from '@/lib/store';
import { KIND_LABEL, nodeColorCss, nodeSubtitle } from '@/lib/viz/describe';
import type { UniverseModel } from '@/lib/viz/model';

interface Props {
  model: UniverseModel;
  id: number;
  /** Right-aligned number (weight, LOC, fan-in...). */
  value?: string | number;
  active?: boolean;
  onPick?: (id: number) => void;
  showPath?: boolean;
}

/** A clickable node reference used in every list of the HUD. */
export function NodeRow({ model, id, value, active, onPick, showPath = true }: Props) {
  const select = useView((s) => s.select);
  const setHovered = useView((s) => s.setHovered);
  const sub = showPath ? nodeSubtitle(model, id) : '';
  return (
    <button
      className={`row${active ? ' active' : ''}`}
      onClick={() => (onPick ? onPick(id) : select(id, { fly: true }))}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(-1)}
      title={model.displayName[id]}
    >
      <span className="dot" style={{ color: nodeColorCss(model, id) }} />
      <span className="main">
        {model.displayName[id]}
        {sub && <div className="sub">{sub}</div>}
      </span>
      <span className="kind-badge">{KIND_LABEL[model.kind[id]]}</span>
      {value !== undefined && <span className="num">{value}</span>}
    </button>
  );
}
