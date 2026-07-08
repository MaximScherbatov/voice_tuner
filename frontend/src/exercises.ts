export type Lang = "ru" | "en";
export type ExerciseKind = "single" | "arpeggio" | "scale" | "sequence" | "melody";

export type ExerciseDef = {
  id: string;
  title: Record<Lang, string>;
  kind: ExerciseKind;

  // semitone offsets from root (root = 0)
  patternSemis: number[];

  // Flow defaults (legacy)
  defaultHoldMs: number;
  defaultMaxStepMs: number;
  defaultTransposeCount: number;
  defaultTransposeStep: number;

  // Tempo for melodies (note duration)
  tempoMs?: number;
};

export const EXERCISES: ExerciseDef[] = [
  {
    id: "single",
    title: { ru: "Сингл (одна нота)", en: "Single (one note)" },
    kind: "single",
    patternSemis: [0],
    defaultHoldMs: 0,
    defaultMaxStepMs: 60000, // session length
    defaultTransposeCount: 1,
    defaultTransposeStep: 0,
  },

  // ---- Core (flow) ----
  {
    id: "arp_maj_oct",
    title: { ru: "Арпеджио мажор 1-3-5-8-5-3-1", en: "Major arpeggio 1-3-5-8-5-3-1" },
    kind: "arpeggio",
    patternSemis: [0, 4, 7, 12, 7, 4, 0],
    defaultHoldMs: 3000,
    defaultMaxStepMs: 9000,
    defaultTransposeCount: 8,
    defaultTransposeStep: 1,
  },
  {
    id: "scale_5_maj",
    title: { ru: "Мажор 1-2-3-4-5-4-3-2-1", en: "Major 1-2-3-4-5-4-3-2-1" },
    kind: "scale",
    patternSemis: [0, 2, 4, 5, 7, 5, 4, 2, 0],
    defaultHoldMs: 1600,
    defaultMaxStepMs: 6500,
    defaultTransposeCount: 10,
    defaultTransposeStep: 1,
  },
  {
    id: "seq_12321",
    title: { ru: "Секвенция 1-2-3-2-1", en: "Sequence 1-2-3-2-1" },
    kind: "sequence",
    patternSemis: [0, 2, 4, 2, 0],
    defaultHoldMs: 1300,
    defaultMaxStepMs: 5000,
    defaultTransposeCount: 12,
    defaultTransposeStep: 1,
  },

  // ---- Melodic (tempo: play full phrase, then sing full phrase) ----
  {
    id: "mel_1354321",
    title: { ru: "Мелодия 1-3-5-4-3-2-1", en: "Melody 1-3-5-4-3-2-1" },
    kind: "melody",
    patternSemis: [0, 4, 7, 5, 4, 2, 0],
    defaultHoldMs: 0,
    defaultMaxStepMs: 0,
    defaultTransposeCount: 8,
    defaultTransposeStep: 1,
    tempoMs: 420,
  },
  {
    id: "mel_ladder_132435465768",
    title: {
      ru: "Мелодия лесенка 1-3-2-4-3-5-4-6-5-7-6-8",
      en: "Melody ladder 1-3-2-4-3-5-4-6-5-7-6-8",
    },
    kind: "melody",
    patternSemis: [0, 4, 2, 5, 4, 7, 5, 9, 7, 11, 9, 12],
    defaultHoldMs: 0,
    defaultMaxStepMs: 0,
    defaultTransposeCount: 6,
    defaultTransposeStep: 1,
    tempoMs: 380,
  },
  {
    id: "mel_bounce_121212345454321",
    title: {
      ru: "Мелодия пружинка 1-2-1-2-1-2-3-4-5-4-5-4-3-2-1",
      en: "Melody bounce 1-2-1-2-1-2-3-4-5-4-5-4-3-2-1",
    },
    kind: "melody",
    patternSemis: [0, 2, 0, 2, 0, 2, 4, 5, 7, 5, 7, 5, 4, 2, 0],
    defaultHoldMs: 0,
    defaultMaxStepMs: 0,
    defaultTransposeCount: 6,
    defaultTransposeStep: 1,
    tempoMs: 360,
  },
];

export function getExerciseById(id: string): ExerciseDef {
  const ex = EXERCISES.find((e) => e.id === id);
  return ex ?? EXERCISES[0];
}

export function clampMidi(m: number) {
  return Math.max(0, Math.min(127, Math.round(m)));
}

export function buildFlowTargets(
  ex: ExerciseDef,
  rootMidi: number,
  transposeCount: number,
  transposeStep: number,
): number[] {
  const out: number[] = [];
  const base = clampMidi(rootMidi);

  const reps = Math.max(1, Math.round(transposeCount));
  const step = Math.max(0, Math.round(transposeStep));

  for (let r = 0; r < reps; r++) {
    const root = base + r * step;
    for (const semi of ex.patternSemis) out.push(clampMidi(root + semi));
  }

  return out;
}
