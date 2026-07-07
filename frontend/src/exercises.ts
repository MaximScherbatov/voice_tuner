export type Lang = "ru" | "en";
export type ExerciseKind = "arpeggio" | "scale" | "sequence";

export type ExerciseDef = {
  id: string;
  title: Record<Lang, string>;
  kind: ExerciseKind;

  // semitone offsets from root (root = 0)
  patternSemis: number[];

  // defaults for Flow mode
  defaultHoldMs: number;        // how long to stay in green to auto-advance
  defaultMaxStepMs: number;     // timeout to force-advance (avoid deadlock)
  defaultTransposeCount: number;
  defaultTransposeStep: number; // semitones per transposition
};

export const EXERCISES: ExerciseDef[] = [
  {
    id: "arp_maj_oct",
    title: {
      ru: "Арпеджио мажор 1-3-5-8-5-3-1",
      en: "Major arpeggio 1-3-5-8-5-3-1",
    },
    kind: "arpeggio",
    patternSemis: [0, 4, 7, 12, 7, 4, 0],
    defaultHoldMs: 3000,
    defaultMaxStepMs: 9000,
    defaultTransposeCount: 8,
    defaultTransposeStep: 1,
  },
  {
    id: "scale_5_maj",
    title: {
      ru: "Мажор 1-2-3-4-5-4-3-2-1",
      en: "Major 1-2-3-4-5-4-3-2-1",
    },
    kind: "scale",
    patternSemis: [0, 2, 4, 5, 7, 5, 4, 2, 0],
    defaultHoldMs: 1600,
    defaultMaxStepMs: 6500,
    defaultTransposeCount: 10,
    defaultTransposeStep: 1,
  },
  {
    id: "seq_12321",
    title: {
      ru: "Секвенция 1-2-3-2-1",
      en: "Sequence 1-2-3-2-1",
    },
    kind: "sequence",
    patternSemis: [0, 2, 4, 2, 0],
    defaultHoldMs: 1300,
    defaultMaxStepMs: 5000,
    defaultTransposeCount: 12,
    defaultTransposeStep: 1,
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
