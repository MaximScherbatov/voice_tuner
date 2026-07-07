export type GhostPack = {
  exerciseId: string;
  createdAt: string; // ISO
  scoreTotal?: number | null;
  totalTimeMs?: number | null;
  stepsCount?: number | null;
  trace: any[];
};

function key(exerciseId: string) {
  return `vtp_ghost_pack_${exerciseId}`;
}

export function stepsCountFromTrace(trace: any[]): number | null {
  if (!trace || !trace.length) return null;
  let mx = -1;
  for (const p of trace) {
    const i = typeof p.step_index === "number" ? p.step_index : -1;
    if (i > mx) mx = i;
  }
  return mx >= 0 ? mx + 1 : null;
}

export function loadGhostPack(exerciseId: string): GhostPack | null {
  try {
    const raw = localStorage.getItem(key(exerciseId));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.trace)) return null;
    return j as GhostPack;
  } catch {
    return null;
  }
}

export function saveGhostPack(exerciseId: string, payload: any): GhostPack {
  const pack: GhostPack = {
    exerciseId,
    createdAt: new Date().toISOString(),
    scoreTotal: payload?.score_total ?? null,
    totalTimeMs: payload?.total_time_ms ?? null,
    stepsCount: payload?.steps?.length ?? stepsCountFromTrace(payload?.trace ?? []) ?? null,
    trace: payload?.trace ?? [],
  };
  try {
    localStorage.setItem(key(exerciseId), JSON.stringify(pack));
  } catch {
    // ignore quota errors
  }
  return pack;
}

export function isGhostCompatible(ghost: GhostPack, payload: any): boolean {
  const curSteps =
    (Array.isArray(payload?.steps) ? payload.steps.length : null) ??
    stepsCountFromTrace(payload?.trace ?? []);

  if (!curSteps || !ghost.stepsCount) return false;

  // простое правило: одинаковое число шагов
  return ghost.stepsCount === curSteps;
}
