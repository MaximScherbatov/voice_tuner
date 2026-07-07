import "./style.css";
import { AudioEngine, midiToHz } from "./audio";
import { EXERCISES, ExerciseDef, Lang, getExerciseById, buildFlowTargets } from "./exercises";

/** Crash overlay */
const showCrash = (title: string, err: any) => {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  document.documentElement.style.background = "#0b0f14";
  document.body.style.margin = "0";
  document.body.innerHTML = `
<pre style="white-space:pre-wrap;padding:16px;background:#0b0f14;color:#fb7185;
font:14px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">

${title}

${msg}

</pre>`;
};
window.addEventListener("error", (e) => showCrash("RUNTIME ERROR:", (e as any).error || (e as any).message || e));
window.addEventListener("unhandledrejection", (e) =>
  showCrash("UNHANDLED PROMISE REJECTION:", (e as any).reason || e),
);

/** i18n */
const getLang = (): Lang => {
  const v = localStorage.getItem("vtp_lang");
  return v === "en" || v === "ru" ? v : "ru";
};
let LANG: Lang = getLang();
document.documentElement.lang = LANG;

const I18N: Record<Lang, Record<string, string>> = {
  ru: {
    theme: "Тема",
    settings: "Настройки",
    close: "Закрыть",
    language: "Язык",
    target_note: "Целевая нота",
    mode: "Режим",
    assist: "ASSIST",
    challenge: "CHALLENGE",
    ring_mode: "Режим кольца",
    live: "LIVE",
    score: "SCORE",
    green_zone: "Зелёная зона ±%",
    exercises_hold: "Упражнения: удержание (Flow), мс",
    exercises_max_step: "Упражнения: max шаг / длительность Single, мс",
    exercises_reps: "Упражнения: транспозиции (reps)",
    ref_volume: "Громкость эталона",
    mic_sens: "Чувствительность микрофона",
    start: "START",
    stop: "STOP",
    results_title: "Результат упражнения",
    saved: "Сохранено",
    save_error: "Ошибка сохранения",
    stop_to_edit_root: "Остановите упражнение (STOP), чтобы менять стартовую ноту.",
    hint_start: "Нажмите START, чтобы начать упражнение.",
  },
  en: {
    theme: "Theme",
    settings: "Settings",
    close: "Close",
    language: "Language",
    target_note: "Target note",
    mode: "Mode",
    assist: "ASSIST",
    challenge: "CHALLENGE",
    ring_mode: "Ring mode",
    live: "LIVE",
    score: "SCORE",
    green_zone: "Green zone ±%",
    exercises_hold: "Exercises: hold (Flow), ms",
    exercises_max_step: "Exercises: max step / Single duration, ms",
    exercises_reps: "Exercises: transpositions (reps)",
    ref_volume: "Ref volume",
    mic_sens: "Mic sensitivity",
    start: "START",
    stop: "STOP",
    results_title: "Exercise result",
    saved: "Saved",
    save_error: "Save error",
    stop_to_edit_root: "Stop the exercise (STOP) to change the root note.",
    hint_start: "Press START to begin the exercise.",
  },
};
const t = (k: string) => I18N[LANG][k] ?? k;

/** utils */
function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function ema(prev: number | null, next: number, alpha: number) {
  return prev === null ? next : prev * (1 - alpha) + next * alpha;
}
function mad(xs: number[], med: number): number {
  const dev = xs.map((x) => Math.abs(x - med));
  return median(dev) ?? 0;
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function p95(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.floor(0.95 * (a.length - 1))];
}
function nowMs() {
  return performance.now();
}
function hzToMidi(hz: number) {
  return 69 + 12 * Math.log2(hz / 440);
}
function formatDt(dt: Date) {
  const loc = LANG === "ru" ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(loc, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(dt);
}
function slopeCentsPerS(series: Array<{ t: number; cents: number }>): number | null {
  if (series.length < 3) return null;
  const ts = series.map((p) => p.t / 1000);
  const cs = series.map((p) => p.cents);
  const n = series.length;
  const tMean = ts.reduce((a, b) => a + b, 0) / n;
  const cMean = cs.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - tMean;
    num += dt * (cs[i] - cMean);
    den += dt * dt;
  }
  if (den <= 1e-9) return null;
  return num / den;
}

/** auth + API */
let AUTH_TOKEN: string | null = localStorage.getItem("vtp_token");

async function ensureAuthToken() {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  const urls = ["/api/auth/anonymous", "/auth/anonymous"];
  let lastErr: any = null;

  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "POST" });
      if (!r.ok) {
        lastErr = await r.text();
        continue;
      }
      const j = await r.json();
      AUTH_TOKEN = j.token;
      localStorage.setItem("vtp_token", AUTH_TOKEN);
      return AUTH_TOKEN;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Cannot create anonymous user token: ${String(lastErr)}`);
}

async function postJson(url: string, data: any) {
  if (!AUTH_TOKEN) {
    try {
      await ensureAuthToken();
    } catch {}
  }
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(data),
  });
}

async function saveExerciseAttempt(payload: any) {
  const urls = ["/api/exercise_attempts", "/exercise_attempts"];
  let lastErr: any = null;

  for (const u of urls) {
    try {
      const r = await postJson(u, payload);
      if (r.ok) return await r.json();
      lastErr = await r.text();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Save exercise failed: ${String(lastErr)}`);
}

/** Theme */
function getInitialTheme(): "dark" | "light" {
  const saved = localStorage.getItem("vtp_theme");
  return saved === "light" || saved === "dark" ? saved : "dark";
}
function applyTheme(t0: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", t0);
  localStorage.setItem("vtp_theme", t0);
}

/** Notes */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_RU: Record<string, string> = { C: "До", D: "Ре", E: "Ми", F: "Фа", G: "Соль", A: "Ля", B: "Си" };
function midiToNote(midi: number) {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  const base = name.replace("#", "");
  const ru = NOTE_RU[base] ?? name;
  return { name, octave, ru };
}
function noteOctToMidi(noteName: string, octave: number) {
  const idx = NOTE_NAMES.indexOf(noteName);
  return (octave + 1) * 12 + idx;
}

/** Defaults */
function ensureDefaults() {
  const setIfNull = (k: string, v: string) => {
    if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  };

  setIfNull("vtp_theme", "dark");
  setIfNull("vtp_ringMode", "live");
  setIfNull("vtp_trainMode", "assist");
  setIfNull("vtp_tolPct", "1.5");
  setIfNull("vtp_lang", LANG);

  // Ref volume default: >= 50 and sticky
  const rvStr = localStorage.getItem("vtp_refVol");
  const rv = Number(rvStr);
  const rvUserSet = localStorage.getItem("vtp_refVolUserSet");
  if (rvStr === null || !Number.isFinite(rv)) localStorage.setItem("vtp_refVol", "60");
  else if (!rvUserSet && rv < 50) localStorage.setItem("vtp_refVol", "60");

  const ms = Number(localStorage.getItem("vtp_micSens"));
  if (!Number.isFinite(ms) || ms <= 0) localStorage.setItem("vtp_micSens", "120");

  const userSet = localStorage.getItem("vtp_targetUserSet");
  const cur = Number(localStorage.getItem("vtp_targetMidi"));
  if (!userSet) {
    if (!Number.isFinite(cur) || localStorage.getItem("vtp_targetMidi") === null) localStorage.setItem("vtp_targetMidi", "60");
    else if (cur === 69) localStorage.setItem("vtp_targetMidi", "60");
  }

  setIfNull("vtp_exId", "single");
  setIfNull("vtp_exHoldMs", "3000");
  setIfNull("vtp_exMaxStepMs", "60000");
  setIfNull("vtp_exTransposeCount", "8");
  setIfNull("vtp_exTransposeStep", "1");
}

const ICONS = {
  mic: `<svg class="ico" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>`,
  spk: `<svg class="ico" viewBox="0 0 24 24"><path d="M3 10v4h4l5 4V6L7 10H3Zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12Zm0-9.5v2.12A9 9 0 0 1 20 12a9 9 0 0 1-3.5 7.38v2.12A11 11 0 0 0 22 12 11 11 0 0 0 16.5 2.5Z"/></svg>`,
  play: `<svg class="ico" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
  stop: `<svg class="ico" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>`,
  gear: `<svg class="ico" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.51.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>`,
  copy: `<svg class="ico" viewBox="0 0 24 24"><path d="M16 1H6a2 2 0 0 0-2 2v10h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z"/></svg>`,
  download: `<svg class="ico" viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2Zm7-18v10.17l3.59-3.58L17 10l-5 5-5-5 1.41-1.41L11 12.17V2h1Z"/></svg>`,
  share: `<svg class="ico" viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7a2.5 2.5 0 0 0 0-1.39l7-4.11A2.99 2.99 0 1 0 14 5a2.9 2.9 0 0 0 .04.49l-7 4.11a3 3 0 1 0 0 4.8l7.12 4.17c-.03.16-.05.32-.05.49a3 3 0 1 0 3-3Z"/></svg>`,
  left: `<svg class="ico" viewBox="0 0 24 24"><path d="M15.4 7.4 14 6 8 12l6 6 1.4-1.4L10.8 12z"/></svg>`,
  right: `<svg class="ico" viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4L13.2 12z"/></svg>`,
  minus: `<svg class="ico" viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>`,
  plus: `<svg class="ico" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
};

try {
  ensureDefaults();
  applyTheme(getInitialTheme());
  ensureAuthToken().catch(() => {});

  const app = document.getElementById("app");
  if (!app) throw new Error("#app not found");

  const engine = new AudioEngine();

  const loadNum = (k: string, def: number) => {
    const v = Number(localStorage.getItem(k));
    return Number.isFinite(v) ? v : def;
  };
  const saveNum = (k: string, v: number) => localStorage.setItem(k, String(v));

  type RingMode = "live" | "score";
  let ringMode: RingMode = (localStorage.getItem("vtp_ringMode") as RingMode) || "live";
  if (ringMode !== "live" && ringMode !== "score") ringMode = "live";

  type TrainMode = "assist" | "challenge";
  let trainMode: TrainMode = (localStorage.getItem("vtp_trainMode") as TrainMode) || "assist";
  if (trainMode !== "assist" && trainMode !== "challenge") trainMode = "assist";

  let tolPct = clamp(loadNum("vtp_tolPct", 1.5), 0.5, 3.0);

  let rootMidiUser = Number(localStorage.getItem("vtp_targetMidi") ?? "60");
  if (!Number.isFinite(rootMidiUser)) rootMidiUser = 60;

  let targetMidi = rootMidiUser;
  let targetHz = midiToHz(targetMidi);

  const SAMPLE_MS = 50;
  const MIN_HZ = 70;
  const MAX_HZ = 1000;

  const CLARITY_ON = 0.72;
  const CLARITY_OFF = 0.62;
  const RMS_MIN = 0.006;

  const NOISE_RMS_INIT = 0.003;
  const NOISE_ALPHA_UP = 0.002;
  const NOISE_ALPHA_DOWN = 0.06;
  const SNR_ON = 3.0;
  const SNR_OFF = 1.8;
  const SILENCE_RELEASE_MS = 260;
  const HOLD_WHILE_ENERGY_MS = 2500;
  const DROPOUT_HOLD_MS = 650;

  const BAR_RANGE = 100;

  const getWindowMs = () => (ringMode === "score" ? 900 : 450);
  const getAlpha = () => (ringMode === "score" ? 0.2 : 0.35);
  const getRingAlpha = () => (ringMode === "score" ? 0.2 : 0.28);

  let running = false;
  let lastSampleTs = 0;

  let hzDisp: number | null = null;
  let ratioDisp: number | null = null;

  let ringFill = 0;
  let ringErrFill = 0;

  let lastFrame = { hz: null as number | null, cents: null as number | null, clarity: 0, rms: 0 };

  let hintEl: HTMLDivElement;
  let hintLockUntil = 0;
  const setHint = (msg: string, lockMs = 0) => {
    hintEl.textContent = msg;
    hintLockUntil = Math.max(hintLockUntil, nowMs() + lockMs);
  };

  type Sample = { t: number; hz: number; ratio: number; errPct: number; cents: number };
  let win: Sample[] = [];

  let gateOn = false;
  let lastGoodAt = 0;
  let lastStableAt = 0;
  let lastGoodSample: Sample | null = null;
  let centsHold: number | null = null;

  let noiseRms = NOISE_RMS_INIT;
  let snrDbDisp = 0;
  let energyKeepDisp = false;
  let belowEnergySince = 0;

  let recentRealPitchAt = 0;

  const EQ_N = 18;
  let eqVals = Array(EQ_N).fill(0);

  type StepMetric = {
    step_index: number;
    target_midi: number;

    time_to_green_ms: number | null;
    time_in_green_ms: number;
    pct_in_green: number;

    median_abs_cents: number | null;
    p95_abs_cents: number | null;

    overshoot_max_cents: number | null;
    drift_cents_per_s: number | null;
    correction_count: number;

    clarity_mean: number | null;
    rms_mean: number | null;
  };

  type TracePoint = {
    t_ms: number;
    step_index: number;
    target_midi: number;
    pitch_midi_x100: number;
    cents_x10: number;
    clarity_x100: number;
    rms_x10000: number;
  };

  let exActive = false;
  let exDef: ExerciseDef | null = null;
  let exTargets: number[] = [];
  let exStepIdx = 0;

  let exStartedAt = 0;
  let exTotalMaxMs = 0;

  let exStepStartedAt = 0;

  let exHoldMs = loadNum("vtp_exHoldMs", 3000);
  let exMaxStepMs = loadNum("vtp_exMaxStepMs", 60000);
  let exTransposeCount = loadNum("vtp_exTransposeCount", 8);
  let exTransposeStep = loadNum("vtp_exTransposeStep", 1);

  let exGreenConfirmMs = 0;
  let exTimeToGreenMs: number | null = null;
  let exTimeInGreenMs = 0;

  let exAbsCentsStepAll: number[] = [];
  let exAbsCentsStepStable: number[] = [];
  let exAbsCentsAllExercise: number[] = [];

  let exClaritySum = 0;
  let exRmsSum = 0;
  let exFrames = 0;

  let exOvershootMax = 0;
  let exCorrectionCount = 0;
  let exPrevSign: -1 | 0 | 1 | null = null;

  let exDriftSeries: Array<{ t: number; cents: number }> = [];

  let exSteps: StepMetric[] = [];
  let exTrace: TracePoint[] = [];
  let exLastTraceAt = 0;

  const EX_CONFIRM_MS = 220;
  const EX_TRACE_PERIOD_MS = 100;

  let lastExercisePayload: any = null;
  let lastExerciseTitle = "";
  let lastExerciseFinishedAt: Date | null = null;

  function resetPitchState() {
    win = [];
    hzDisp = null;
    ratioDisp = null;
    ringFill = 0;
    ringErrFill = 0;

    gateOn = false;
    lastGoodAt = 0;
    lastStableAt = 0;
    lastGoodSample = null;
    centsHold = null;

    noiseRms = NOISE_RMS_INIT;
    snrDbDisp = 0;
    energyKeepDisp = false;
    belowEnergySince = 0;

    recentRealPitchAt = 0;
  }

  function exResetStepAccumulators() {
    exGreenConfirmMs = 0;
    exTimeToGreenMs = null;
    exTimeInGreenMs = 0;

    exAbsCentsStepAll = [];
    exAbsCentsStepStable = [];

    exClaritySum = 0;
    exRmsSum = 0;
    exFrames = 0;

    exOvershootMax = 0;
    exCorrectionCount = 0;
    exPrevSign = null;

    exDriftSeries = [];
  }

  function setRuntimeTargetMidi(m: number) {
    targetMidi = clamp(m, 0, 127);
    targetHz = midiToHz(targetMidi);
  }

  function setUserRootMidi(m: number) {
    rootMidiUser = clamp(m, 0, 127);
    localStorage.setItem("vtp_targetMidi", String(rootMidiUser));
    localStorage.setItem("vtp_targetUserSet", "1");
    if (!exActive) {
      setRuntimeTargetMidi(rootMidiUser);
      resetPitchState();
    }
  }

  const refVol0 = loadNum("vtp_refVol", 60);
  const micSens0 = loadNum("vtp_micSens", 120);

  app.innerHTML = `
  <div class="container">

    <div class="card">
      <div class="header">
        <div>
          <div class="brand">Voice Trainer</div>
        </div>

        <div class="badges" style="display:flex; gap:10px; align-items:center">
          <button class="iconBtn mini" id="btnTopLang"><span class="lbl">${LANG.toUpperCase()}</span></button>
          <button class="iconBtn mini" id="btnTopTheme">${ICONS.stop}<span class="lbl">${t("theme")}</span></button>
          <button class="iconBtn mini" id="btnTopSettings">${ICONS.gear}<span class="lbl">${t("settings")}</span></button>
        </div>
      </div>

      <!-- subtitle + chips (moved down) -->
      <div class="row" style="margin-top:10px;gap:10px;align-items:center;flex-wrap:wrap">
        <div class="small" id="subTitle">—</div>
        <span class="badge" id="badgeState">Status: idle</span>
        <span class="badge" id="badgeSave">Save: —</span>
      </div>

      <div class="row" style="margin-top:10px;gap:10px;flex-wrap:wrap">
        <select class="btnLike" id="selExercise" style="min-width:280px"></select>

        <button class="iconBtn" id="btnStart">${ICONS.play}<span class="lbl">${t("start")}</span></button>
        <button class="iconBtn" id="btnStop">${ICONS.stop}<span class="lbl">${t("stop")}</span></button>
      </div>

      <!-- Note Picker -->
      <div class="notePickerRow">
        <button class="iconBtn mini" id="btnSemiDown">${ICONS.left}<span class="lbl">-1</span></button>
        <div class="notePill" id="rootNotePill">C3</div>
        <button class="iconBtn mini" id="btnSemiUp">${ICONS.right}<span class="lbl">+1</span></button>

        <button class="iconBtn mini" id="btnOctDown">${ICONS.minus}<span class="lbl">oct-</span></button>
        <div class="notePill notePillSmall" id="octPill">Oct 3</div>
        <button class="iconBtn mini" id="btnOctUp">${ICONS.plus}<span class="lbl">oct+</span></button>

        <div style="flex:1"></div>
        <div class="small" id="rootHzLabel" style="opacity:.85"></div>
      </div>

      <div class="stateLine" id="stateLine">
        <span id="stRoot">Root: —</span>
        <span class="stateSep">•</span>
        <span class="stateItem"><span class="indIcon" id="indMic">${ICONS.mic}</span><span id="stMic">off</span></span>
        <span class="stateSep">•</span>
        <span class="stateItem"><span class="indIcon" id="indSpk">${ICONS.spk}</span><span id="stRef">off</span></span>
        <span class="stateSep" id="stExSep" style="display:none">•</span>
        <span id="stEx" style="display:none"></span>
      </div>

      <div class="grid">
        <div class="ringWrap">
          <div class="ring" id="ringBox">

            <svg viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" stroke="rgba(255,255,255,.06)" stroke-width="5" fill="none"/>
              <circle id="ringErr" cx="50" cy="50" r="46" stroke="rgba(255,255,255,.10)" stroke-width="5"
                stroke-linecap="round" fill="none"
                stroke-dasharray="289.03" stroke-dashoffset="289.03"
                transform="rotate(-90 50 50)"/>

              <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,.10)" stroke-width="9" fill="none"/>
              <circle id="ringProg" cx="50" cy="50" r="42" stroke="rgba(52,211,153,.95)" stroke-width="9"
                stroke-linecap="round" fill="none"
                stroke-dasharray="263.89" stroke-dashoffset="263.89"
                transform="rotate(-90 50 50)"/>
            </svg>

            <div class="ringContent">
              <div class="noteRu" id="noteRu">До</div>
              <div class="noteBig" id="noteBig">C4</div>
              <div class="hzBig" id="hzBig">— Hz</div>
              <div class="delta" id="delta">—%</div>
            </div>
          </div>

          <div class="tip" id="tipPhones" style="display:none">
            Assist: рекомендованы наушники (иначе микрофон может “слышать” эталон).
          </div>
        </div>

        <div>
          <div class="targetHzBig" id="targetHzBig">— Hz</div>
          <div class="targetLine" id="targetLine">—</div>
          <div class="hint" id="hint">—</div>

          <div class="eqWrap">
            <div class="eq" id="eq"></div>
            <div class="small" style="margin-top:10px">Input spectrum</div>
          </div>

          <div class="tunerWrap">
            <div class="tunerBar">
              <div class="tunerCenter"></div>
              <div class="marker" id="marker"></div>
            </div>
            <div class="tunerMeta"><span>-100c</span><span>0</span><span>+100c</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card resultsWrap" id="resultsWrap">
      <div class="header">
        <div>
          <div class="brand" id="resultsTitle">${t("results_title")}</div>
          <div class="resultsMeta" id="resultsMeta"></div>
        </div>
        <div class="resultsActions">
          <button class="iconBtn mini" id="btnResCopy">${ICONS.copy}<span class="lbl">copy</span></button>
          <button class="iconBtn mini" id="btnResDownload">${ICONS.download}<span class="lbl">download</span></button>
          <button class="iconBtn mini" id="btnResShare">${ICONS.share}<span class="lbl">share</span></button>
        </div>
      </div>

      <div style="margin-top:10px">
        <canvas id="resultsCanvas" class="resultsCanvas" width="980" height="260"></canvas>
      </div>

      <div class="hr"></div>

      <div style="overflow:auto">
        <table class="resultsTable" id="resultsTable"></table>
      </div>
    </div>

    <div class="modalBackdrop" id="settingsModal">
      <div class="card modalCard">
        <div class="modalHeader">
          <div class="brand">${t("settings")}</div>
          <button class="iconBtn" id="btnSettingsClose">${ICONS.stop}<span class="lbl">${t("close")}</span></button>
        </div>

        <div class="hr"></div>

        <div class="small">${t("language")}</div>
        <div class="row">
          <select class="btnLike" id="selLang">
            <option value="ru">RU</option>
            <option value="en">EN</option>
          </select>
        </div>

        <div class="hr"></div>

        <div class="small">${t("target_note")}</div>
        <div class="row">
          <select class="btnLike" id="selNote"></select>
          <select class="btnLike" id="selOct"></select>
        </div>
        <div class="small" id="noteMeta"></div>

        <div class="hr"></div>

        <div class="small">${t("mode")}</div>
        <div class="row">
          <button class="iconBtn" id="modeAssist"><span class="lbl">${t("assist")}</span></button>
          <button class="iconBtn" id="modeChallenge"><span class="lbl">${t("challenge")}</span></button>
        </div>

        <div class="hr"></div>

        <div class="small">${t("ring_mode")}</div>
        <div class="row">
          <button class="iconBtn" id="ringLive"><span class="lbl">${t("live")}</span></button>
          <button class="iconBtn" id="ringScore"><span class="lbl">${t("score")}</span></button>
        </div>

        <div class="hr"></div>

        <div class="small">${t("green_zone")}</div>
        <input class="slider" id="tolPct" type="range" min="0.5" max="3.0" step="0.1" value="${tolPct}" />
        <div class="small" id="tolMeta">±${tolPct.toFixed(1)}%</div>

        <div class="hr"></div>

        <div class="small">${t("exercises_hold")}</div>
        <input class="slider" id="exHoldMs" type="range" min="0" max="4000" step="100" value="${exHoldMs}" />
        <div class="small" id="exHoldMeta">${Math.round(exHoldMs)} ms</div>

        <div style="height:12px"></div>

        <div class="small">${t("exercises_max_step")}</div>
        <input class="slider" id="exMaxStepMs" type="range" min="2000" max="120000" step="250" value="${exMaxStepMs}" />
        <div class="small" id="exMaxStepMeta">${Math.round(exMaxStepMs)} ms</div>

        <div style="height:12px"></div>

        <div class="small">${t("exercises_reps")}</div>
        <input class="slider" id="exTrCount" type="range" min="1" max="24" step="1" value="${exTransposeCount}" />
        <div class="small" id="exTrMeta">${Math.round(exTransposeCount)} reps</div>

        <div class="hr"></div>

        <div class="small">${t("ref_volume")}</div>
        <input class="slider" id="refVol" type="range" min="0" max="100" value="${refVol0}" />

        <div style="height:12px"></div>

        <div class="small">${t("mic_sens")}</div>
        <input class="slider" id="micSens" type="range" min="50" max="300" value="${micSens0}" />
        <div class="small" id="micMeta"></div>
      </div>
    </div>

  </div>
  `;

  const q = <T extends Element>(sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`UI element not found: ${sel}`);
    return el as T;
  };

  const subTitle = q<HTMLDivElement>("#subTitle");
  const badgeState = q<HTMLSpanElement>("#badgeState");
  const badgeSave = q<HTMLSpanElement>("#badgeSave");

  const indMic = q<HTMLSpanElement>("#indMic");
  const indSpk = q<HTMLSpanElement>("#indSpk");

  const btnTopLang = q<HTMLButtonElement>("#btnTopLang");
  const btnTopTheme = q<HTMLButtonElement>("#btnTopTheme");
  const btnTopSettings = q<HTMLButtonElement>("#btnTopSettings");

  const selExercise = q<HTMLSelectElement>("#selExercise");
  const btnStart = q<HTMLButtonElement>("#btnStart");
  const btnStop = q<HTMLButtonElement>("#btnStop");

  const btnSemiDown = q<HTMLButtonElement>("#btnSemiDown");
  const btnSemiUp = q<HTMLButtonElement>("#btnSemiUp");
  const btnOctDown = q<HTMLButtonElement>("#btnOctDown");
  const btnOctUp = q<HTMLButtonElement>("#btnOctUp");
  const rootNotePill = q<HTMLDivElement>("#rootNotePill");
  const octPill = q<HTMLDivElement>("#octPill");
  const rootHzLabel = q<HTMLDivElement>("#rootHzLabel");

  const stateLine = q<HTMLDivElement>("#stateLine");
  const stRoot = q<HTMLSpanElement>("#stRoot");
  const stMic = q<HTMLSpanElement>("#stMic");
  const stRef = q<HTMLSpanElement>("#stRef");
  const stExSep = q<HTMLSpanElement>("#stExSep");
  const stEx = q<HTMLSpanElement>("#stEx");
  const ringProg = q<SVGCircleElement>("#ringProg");
  const ringErr = q<SVGCircleElement>("#ringErr");

  const noteRu = q<HTMLDivElement>("#noteRu");
  const noteBig = q<HTMLDivElement>("#noteBig");
  const hzBig = q<HTMLDivElement>("#hzBig");
  const delta = q<HTMLDivElement>("#delta");

  const targetHzBig = q<HTMLDivElement>("#targetHzBig");
  const targetLine = q<HTMLDivElement>("#targetLine");
  hintEl = q<HTMLDivElement>("#hint");
  const tipPhones = q<HTMLDivElement>("#tipPhones");

  const eq = q<HTMLDivElement>("#eq");
  const marker = q<HTMLDivElement>("#marker");

  const resultsWrap = q<HTMLDivElement>("#resultsWrap");
  const resultsTitle = q<HTMLDivElement>("#resultsTitle");
  const resultsMeta = q<HTMLDivElement>("#resultsMeta");
  const resultsCanvas = q<HTMLCanvasElement>("#resultsCanvas");
  const resultsTable = q<HTMLTableElement>("#resultsTable");
  const btnResCopy = q<HTMLButtonElement>("#btnResCopy");
  const btnResDownload = q<HTMLButtonElement>("#btnResDownload");
  const btnResShare = q<HTMLButtonElement>("#btnResShare");

  const settingsModal = q<HTMLDivElement>("#settingsModal");
  const btnSettingsClose = q<HTMLButtonElement>("#btnSettingsClose");
  const selLang = q<HTMLSelectElement>("#selLang");

  const selNote = q<HTMLSelectElement>("#selNote");
  const selOct = q<HTMLSelectElement>("#selOct");
  const noteMeta = q<HTMLDivElement>("#noteMeta");

  const modeAssistBtn = q<HTMLButtonElement>("#modeAssist");
  const modeChallengeBtn = q<HTMLButtonElement>("#modeChallenge");

  const ringLiveBtn = q<HTMLButtonElement>("#ringLive");
  const ringScoreBtn = q<HTMLButtonElement>("#ringScore");

  const tolPctSlider = q<HTMLInputElement>("#tolPct");
  const tolMeta = q<HTMLDivElement>("#tolMeta");

  const exHoldSlider = q<HTMLInputElement>("#exHoldMs");
  const exHoldMeta = q<HTMLDivElement>("#exHoldMeta");
  const exMaxStepSlider = q<HTMLInputElement>("#exMaxStepMs");
  const exMaxStepMeta = q<HTMLDivElement>("#exMaxStepMeta");
  const exTrCountSlider = q<HTMLInputElement>("#exTrCount");
  const exTrMeta = q<HTMLDivElement>("#exTrMeta");

  const refVol = q<HTMLInputElement>("#refVol");
  const micSens = q<HTMLInputElement>("#micSens");
  const micMeta = q<HTMLDivElement>("#micMeta");

  // EQ bars
  eq.innerHTML = Array.from({ length: EQ_N }).map(() => "<span></span>").join("");
  const eqBars = Array.from(eq.querySelectorAll("span")) as HTMLSpanElement[];

  // modal open/close
  const openSettings = () => {
    settingsModal.style.display = "block";
    selLang.value = LANG;
  };
  const closeSettings = () => {
    settingsModal.style.display = "none";
  };
  btnTopSettings.onclick = openSettings;
  btnSettingsClose.onclick = closeSettings;
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  btnTopLang.onclick = () => {
    const v = LANG === "ru" ? "en" : "ru";
    localStorage.setItem("vtp_lang", v);
    location.reload();
  };
  btnTopTheme.onclick = () => {
    const t0 = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(t0);
    if (lastExercisePayload) renderResults(lastExercisePayload);
  };

  // language dropdown
  selLang.value = LANG;
  selLang.onchange = () => {
    const v = selLang.value === "en" ? "en" : "ru";
    localStorage.setItem("vtp_lang", v);
    location.reload();
  };

  // audio
  const applyAudioSettings = () => {
    engine.setReferenceVolume((Number(refVol.value) / 100) * 0.6);
    engine.setMicSensitivity(Number(micSens.value) / 100);
  };
  refVol.oninput = () => {
    localStorage.setItem("vtp_refVolUserSet", "1");
    saveNum("vtp_refVol", Number(refVol.value));
    applyAudioSettings();
  };
  micSens.oninput = () => {
    saveNum("vtp_micSens", Number(micSens.value));
    applyAudioSettings();
  };
  applyAudioSettings();

  // tol
  tolPctSlider.oninput = () => {
    tolPct = clamp(Number(tolPctSlider.value), 0.5, 3.0);
    localStorage.setItem("vtp_tolPct", String(tolPct));
    tolMeta.textContent = `±${tolPct.toFixed(1)}%`;
    if (lastExercisePayload) renderResults(lastExercisePayload);
  };

  // exercise sliders
  exHoldSlider.oninput = () => {
    exHoldMs = Number(exHoldSlider.value);
    localStorage.setItem("vtp_exHoldMs", String(exHoldMs));
    exHoldMeta.textContent = `${Math.round(exHoldMs)} ms`;
  };
  exMaxStepSlider.oninput = () => {
    exMaxStepMs = Number(exMaxStepSlider.value);
    localStorage.setItem("vtp_exMaxStepMs", String(exMaxStepMs));
    exMaxStepMeta.textContent = `${Math.round(exMaxStepMs)} ms`;
  };
  exTrCountSlider.oninput = () => {
    exTransposeCount = Number(exTrCountSlider.value);
    localStorage.setItem("vtp_exTransposeCount", String(exTransposeCount));
    exTrMeta.textContent = `${Math.round(exTransposeCount)} reps`;
  };

  // modes
  const renderTrainMode = () => {
    modeAssistBtn.classList.toggle("primary", trainMode === "assist");
    modeChallengeBtn.classList.toggle("primary", trainMode === "challenge");
  };
  modeAssistBtn.onclick = () => {
    trainMode = "assist";
    localStorage.setItem("vtp_trainMode", "assist");
    renderTrainMode();
  };
  modeChallengeBtn.onclick = () => {
    trainMode = "challenge";
    localStorage.setItem("vtp_trainMode", "challenge");
    renderTrainMode();
  };
  renderTrainMode();

  const renderRingMode = () => {
    ringLiveBtn.classList.toggle("primary", ringMode === "live");
    ringScoreBtn.classList.toggle("primary", ringMode === "score");
  };
  ringLiveBtn.onclick = () => {
    ringMode = "live";
    localStorage.setItem("vtp_ringMode", "live");
    resetPitchState();
    renderRingMode();
  };
  ringScoreBtn.onclick = () => {
    ringMode = "score";
    localStorage.setItem("vtp_ringMode", "score");
    resetPitchState();
    renderRingMode();
  };
  renderRingMode();

  // note selects
  const OCT = [2, 3, 4, 5];
  selNote.innerHTML = NOTE_NAMES.map((n) => `<option value="${n}">${n}</option>`).join("");
  selOct.innerHTML = OCT.map((o) => `<option value="${o}">${o}</option>`).join("");

  function syncRootUI() {
    const n = midiToNote(rootMidiUser);
    rootNotePill.textContent = `${n.name}${n.octave}`;
    octPill.textContent = `Oct ${n.octave}`;
    rootHzLabel.textContent = `${midiToHz(rootMidiUser).toFixed(1)} Hz`;

    selNote.value = n.name;
    selOct.value = String(n.octave);
    noteMeta.textContent = `${n.ru} (${n.name}${n.octave}) ${midiToHz(rootMidiUser).toFixed(1)} Hz`;
  }

  selNote.onchange = () => {
    if (exActive) return;
    setUserRootMidi(noteOctToMidi(selNote.value, Number(selOct.value)));
    setRuntimeTargetMidi(rootMidiUser);
    resetPitchState();
    syncRootUI();
  };
  selOct.onchange = () => {
    if (exActive) return;
    setUserRootMidi(noteOctToMidi(selNote.value, Number(selOct.value)));
    setRuntimeTargetMidi(rootMidiUser);
    resetPitchState();
    syncRootUI();
  };

  const changeRoot = (deltaSemi: number) => {
    if (exActive) {
      setHint(t("stop_to_edit_root"), 1600);
      return;
    }
    setUserRootMidi(rootMidiUser + deltaSemi);
    setRuntimeTargetMidi(rootMidiUser);
    resetPitchState();
    syncRootUI();
  };

  btnSemiDown.onclick = () => changeRoot(-1);
  btnSemiUp.onclick = () => changeRoot(+1);
  btnOctDown.onclick = () => changeRoot(-12);
  btnOctUp.onclick = () => changeRoot(+12);

  // exercise select
  selExercise.innerHTML = EXERCISES.map((e) => `<option value="${e.id}">${e.title[LANG]}</option>`).join("");
  const exIdSaved = localStorage.getItem("vtp_exId") ?? "single";
  selExercise.value = getExerciseById(exIdSaved).id;
  selExercise.onchange = () => localStorage.setItem("vtp_exId", selExercise.value);

  // init runtime target
  setRuntimeTargetMidi(rootMidiUser);
  syncRootUI();

  // marker
  const setMarkerCents = (cents: number | null) => {
    if (cents === null) {
      marker.style.opacity = "0";
      marker.style.left = "50%";
      return;
    }
    const c = clamp(cents, -BAR_RANGE, BAR_RANGE);
    const tt = (c + BAR_RANGE) / (2 * BAR_RANGE);
    marker.style.opacity = "1";
    marker.style.left = `${tt * 100}%`;
  };

  // ring
  const setRing = (fill01: number, errFill01: number, errPct: number | null) => {
    const CIRC_IN = 263.89;
    const CIRC_OUT = 289.03;
    ringProg.setAttribute("stroke-dashoffset", String(CIRC_IN * (1 - clamp(fill01, 0, 1))));
    ringErr.setAttribute("stroke-dashoffset", String(CIRC_OUT * (1 - clamp(errFill01, 0, 1))));
    if (errPct === null) {
      ringProg.setAttribute("stroke", "rgba(255,255,255,.25)");
      ringErr.setAttribute("stroke", "rgba(255,255,255,.10)");
      return;
    }
    if (Math.abs(errPct) <= tolPct) {
      ringProg.setAttribute("stroke", "rgba(52,211,153,.95)");
      ringErr.setAttribute("stroke", "rgba(255,255,255,.10)");
    } else if (errPct > 0) {
      ringProg.setAttribute("stroke", "rgba(251,113,133,.95)");
      ringErr.setAttribute("stroke", "rgba(251,113,133,.95)");
    } else {
      ringProg.setAttribute("stroke", "rgba(96,165,250,.95)");
      ringErr.setAttribute("stroke", "rgba(96,165,250,.95)");
    }
  };

  // results actions
  btnResCopy.onclick = async () => {
    if (!lastExercisePayload) return;
    await navigator.clipboard.writeText(JSON.stringify(lastExercisePayload, null, 2));
    setHint("Copied.", 900);
  };
  btnResDownload.onclick = () => {
    if (!lastExercisePayload) return;
    const blob = new Blob([JSON.stringify(lastExercisePayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dt = lastExerciseFinishedAt ? formatDt(lastExerciseFinishedAt).replace(/[^\d]/g, "") : "result";
    a.href = url;
    a.download = `exercise_${lastExercisePayload.exercise_id}_${dt}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  btnResShare.onclick = async () => {
    const dt = lastExerciseFinishedAt ? formatDt(lastExerciseFinishedAt) : "";
    const score = lastExercisePayload?.score_total ?? "—";
    const timeS = lastExercisePayload?.total_time_ms ? Math.round(lastExercisePayload.total_time_ms / 1000) : "—";
    const text = `${lastExerciseTitle}. ${dt}\nscore: ${score}%\ntime: ${timeS}s`;
    // @ts-ignore
    if (navigator.share) {
      try {
        // @ts-ignore
        await navigator.share({ text, title: "Voice Trainer" });
      } catch {}
    } else {
      await navigator.clipboard.writeText(text);
      setHint("Share text copied.", 1200);
    }
  };

  function drawResultsTrace(canvas: HTMLCanvasElement, payload: any) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const trace: TracePoint[] = payload.trace ?? [];
    if (!trace.length) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const grid = theme === "light" ? "rgba(15,23,42,.08)" : "rgba(255,255,255,.06)";
    const label = theme === "light" ? "rgba(15,23,42,.60)" : "rgba(255,255,255,.60)";
    const sep = theme === "light" ? "rgba(15,23,42,.10)" : "rgba(255,255,255,.08)";

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const tMax = Math.max(...trace.map((p) => p.t_ms), 1);

    const yVals: number[] = [];
    for (const p of trace) {
      yVals.push(p.target_midi);
      yVals.push(p.pitch_midi_x100 / 100);
    }
    const yMin = Math.min(...yVals) - 1.0;
    const yMax = Math.max(...yVals) + 1.0;

    const padL = 42, padR = 14, padT = 14, padB = 22;
    const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;

    const xScale = (tms: number) => x0 + (tms / tMax) * (x1 - x0);
    const yScale = (midi: number) => y0 + ((yMax - midi) / Math.max(1e-6, (yMax - yMin))) * (y1 - y0);

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const yy = y0 + (i / 4) * (y1 - y0);
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
    }

    const tolCents = 1200 * Math.log2(1 + tolPct / 100);
    const tolSemi = tolCents / 100;

    ctx.fillStyle = "rgba(52,211,153,.10)";
    ctx.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const x = xScale(trace[i].t_ms);
      const y = yScale(trace[i].target_midi + tolSemi);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = trace.length - 1; i >= 0; i--) {
      const x = xScale(trace[i].t_ms);
      const y = yScale(trace[i].target_midi - tolSemi);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = sep;
    ctx.lineWidth = 1;
    for (let i = 1; i < trace.length; i++) {
      if (trace[i].step_index !== trace[i - 1].step_index) {
        const x = xScale(trace[i].t_ms);
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "rgba(52,211,153,.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const x = xScale(trace[i].t_ms);
      const y = yScale(trace[i].target_midi);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(96,165,250,.95)";
    ctx.lineWidth = 2;
    let sm: number | null = null;
    ctx.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const x = xScale(trace[i].t_ms);
      const raw = trace[i].pitch_midi_x100 / 100;
      sm = sm === null ? raw : sm * 0.75 + raw * 0.25;
      const y = yScale(sm);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = label;
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillText(String(yMax.toFixed(1)), 8, y0 + 10);
    ctx.fillText(String(yMin.toFixed(1)), 8, y1);
  }

  function renderResults(payload: any) {
    const steps: StepMetric[] = payload.steps ?? [];
    resultsWrap.style.display = "block";

    if (!lastExerciseFinishedAt) lastExerciseFinishedAt = new Date();
    resultsTitle.textContent = `${lastExerciseTitle}. ${formatDt(lastExerciseFinishedAt)}`;

    const score = payload.score_total ?? "—";
    const timeS = payload.total_time_ms ? Math.round(payload.total_time_ms / 1000) : "—";
    const avgT2g = payload.avg_time_to_green_ms ? Math.round(payload.avg_time_to_green_ms) : null;

    resultsMeta.textContent = `score: ${score}% • time: ${timeS}s` + (avgT2g !== null ? ` • avg time-to-green: ${avgT2g}ms` : "");

    const head = `
      <tr>
        <th>Step</th><th>Note</th><th>T2G</th><th>Green</th><th>%</th><th>Med</th><th>P95</th><th>Corr</th><th>Drift</th>
      </tr>
    `;
    const rows = steps.map((s) => {
      const n = midiToNote(s.target_midi);
      const noteLabel = `${n.name}${n.octave}`;
      const t2g = s.time_to_green_ms === null ? "—" : String(Math.round(s.time_to_green_ms));
      const drift = s.drift_cents_per_s === null ? "—" : s.drift_cents_per_s.toFixed(2);
      const med = s.median_abs_cents === null ? "—" : s.median_abs_cents.toFixed(1);
      const p = s.p95_abs_cents === null ? "—" : s.p95_abs_cents.toFixed(1);
      return `<tr>
        <td class="smallMono">${s.step_index + 1}</td>
        <td class="smallMono">${noteLabel}</td>
        <td class="smallMono">${t2g}</td>
        <td class="smallMono">${Math.round(s.time_in_green_ms)}</td>
        <td class="smallMono">${s.pct_in_green.toFixed(0)}%</td>
        <td class="smallMono">${med}</td>
        <td class="smallMono">${p}</td>
        <td class="smallMono">${s.correction_count}</td>
        <td class="smallMono">${drift}</td>
      </tr>`;
    }).join("");

    resultsTable.innerHTML = head + rows;
    drawResultsTrace(resultsCanvas, payload);
  }

  function exStartStep(stepIndex: number) {
    exStepIdx = stepIndex;
    exStepStartedAt = nowMs();
    exResetStepAccumulators();

    setRuntimeTargetMidi(exTargets[exStepIdx]);
    resetPitchState();
    applyAudioSettings();

    if (trainMode === "assist") engine.startReference(targetHz);
    else engine.playReference(targetHz, 0.55);
  }

  function exFinalizeStep(): StepMetric {
    const stepDur = nowMs() - exStepStartedAt;
    const arr = exAbsCentsStepStable.length ? exAbsCentsStepStable : exAbsCentsStepAll;

    const medAbs = median(arr);
    const p = p95(arr);
    const pctGreen = stepDur > 0 ? (100 * exTimeInGreenMs) / stepDur : 0;
    const drift = slopeCentsPerS(exDriftSeries);

    return {
      step_index: exStepIdx,
      target_midi: exTargets[exStepIdx],
      time_to_green_ms: exTimeToGreenMs,
      time_in_green_ms: exTimeInGreenMs,
      pct_in_green: clamp(pctGreen, 0, 100),
      median_abs_cents: medAbs,
      p95_abs_cents: p,
      overshoot_max_cents: exTimeToGreenMs === null ? null : exOvershootMax,
      drift_cents_per_s: drift,
      correction_count: exCorrectionCount,
      clarity_mean: exFrames ? exClaritySum / exFrames : null,
      rms_mean: exFrames ? exRmsSum / exFrames : null,
    };
  }

  async function exFinish(reason: string) {
    const totalTime = nowMs() - exStartedAt;

    exActive = false;
    engine.stopReference();

    setRuntimeTargetMidi(rootMidiUser);
    resetPitchState();

    const steps = exSteps.slice();
    const t2g = steps.map((s) => s.time_to_green_ms).filter((x): x is number => x !== null);

    const p95AbsAll = p95(exAbsCentsAllExercise);
    const avgAbsAll = mean(exAbsCentsAllExercise);

    const scoreTotal = (() => {
      let scoreSum = 0;
      let n = 0;
      for (const s of steps) {
        const holdScore = exDef?.kind === "single"
          ? clamp((s.pct_in_green ?? 0) / 100, 0, 1)
          : clamp((s.time_in_green_ms ?? 0) / Math.max(1, exHoldMs), 0, 1);

        const acc = s.median_abs_cents === null ? 0 : clamp(1 - s.median_abs_cents / 50, 0, 1);
        const speed = s.time_to_green_ms === null ? 0 : clamp(1 - s.time_to_green_ms / Math.max(600, exMaxStepMs * 0.6), 0, 1);

        scoreSum += 100 * (0.5 * holdScore + 0.3 * acc + 0.2 * speed);
        n += 1;
      }
      return n ? scoreSum / n : 0;
    })();

    const payload = {
      exercise_id: exDef?.id ?? "unknown",
      mode: trainMode,
      timing_mode: "flow",
      total_time_ms: Math.round(totalTime),
      score_total: Math.round(scoreTotal * 10) / 10,
      avg_time_to_green_ms: t2g.length ? t2g.reduce((a, b) => a + b, 0) / t2g.length : null,
      p95_time_to_green_ms: t2g.length ? p95(t2g) : null,
      avg_abs_cents: avgAbsAll,
      p95_abs_cents: p95AbsAll,
      steps,
      trace: exTrace,
      stop_reason: reason,
    };

    lastExercisePayload = payload;
    lastExerciseTitle = exDef?.title?.[LANG] ?? payload.exercise_id;
    lastExerciseFinishedAt = new Date();

    badgeSave.textContent = "Save: saving…";
    try {
      const res = await saveExerciseAttempt(payload);
      badgeSave.textContent = `Save: id=${res.id}`;
      setHint(`${t("saved")}: ${lastExerciseTitle}`, 2000);
    } catch (e) {
      badgeSave.textContent = "Save: error";
      setHint(`${t("save_error")}: ${String(e)}`, 7000);
    }

    renderResults(payload);
    resultsWrap.scrollIntoView({ behavior: "smooth", block: "start" });

    running = false;
    engine.stopMic();
  }

  async function ensureMicOn() {
    if (running && engine.isMicReady()) return true;
    try {
      await engine.initMic();
      running = true;
      applyAudioSettings();
      requestAnimationFrame(rafLoop);
      return true;
    } catch (e) {
      setHint(`Mic error: ${String(e)}`, 7000);
      running = false;
      return false;
    }
  }

  function exStart() {
    exDef = getExerciseById(selExercise.value);
    localStorage.setItem("vtp_exId", exDef.id);

    if (exDef.kind === "single") {
      exTargets = [rootMidiUser];
      exTotalMaxMs = clamp(exMaxStepMs, 2000, 10 * 60 * 1000);
    } else {
      exTargets = buildFlowTargets(exDef, rootMidiUser, Math.round(exTransposeCount), Math.round(exTransposeStep));
      exTotalMaxMs = Math.min(10 * 60 * 1000, exTargets.length * exMaxStepMs + 3000);
    }

    exActive = true;
    exSteps = [];
    exTrace = [];
    exAbsCentsAllExercise = [];
    exLastTraceAt = 0;
    exStartedAt = nowMs();

    badgeSave.textContent = "Save: —";
    badgeState.textContent = "Status: exercise";

    exStartStep(0);
  }

  function exStop(reason = "stopped") {
    if (!exActive) {
      engine.stopReference();
      running = false;
      engine.stopMic();
      return;
    }
    exSteps.push(exFinalizeStep());
    exFinish(reason).catch(() => {});
  }

  btnStart.onclick = async () => {
    if (exActive) return;
    const ok = await ensureMicOn();
    if (!ok) return;
    exStart();
  };
  btnStop.onclick = () => exStop("stopped");

  const rafLoop = () => {
    if (!running) return;

    const fr = engine.frame(targetHz);
    const tNow = nowMs();

    // EQ
    const spec = engine.getSpectrumBars(18);
    for (let i = 0; i < 18; i++) {
      eqVals[i] = eqVals[i] * 0.75 + spec[i] * 0.25;
      const h = 6 + Math.round(eqVals[i] * 48);
      eqBars[i].style.height = `${h}px`;
    }

    // strict pitch
    const pitchOk = fr.hz !== null && fr.hz >= MIN_HZ && fr.hz <= MAX_HZ;
    const notMuted = !engine.isMicMuted();

    const hasPitchRaw =
      fr.hz !== null &&
      fr.cents !== null &&
      pitchOk &&
      fr.clarity >= CLARITY_ON &&
      fr.rms >= RMS_MIN &&
      notMuted;

    if (hasPitchRaw) recentRealPitchAt = tNow;

    // noise learning
    const snrPre = fr.rms / Math.max(1e-6, noiseRms);
    const learnNoise = !gateOn && snrPre < SNR_ON;
    if (learnNoise) {
      const a = fr.rms > noiseRms ? NOISE_ALPHA_UP : NOISE_ALPHA_DOWN;
      noiseRms = noiseRms * (1 - a) + fr.rms * a;
      noiseRms = clamp(noiseRms, 0.0002, 0.05);
    }

    const snr = fr.rms / Math.max(1e-6, noiseRms);
    snrDbDisp = 20 * Math.log10(Math.max(1e-6, snr));

    const energyOn = fr.rms >= Math.max(RMS_MIN * 0.7, noiseRms * SNR_ON);
    const energyKeep = fr.rms >= Math.max(RMS_MIN * 0.55, noiseRms * SNR_OFF);
    energyKeepDisp = energyKeep;

    const clarityThr = gateOn ? CLARITY_OFF : CLARITY_ON;

    const gatePitch =
      fr.hz !== null &&
      fr.cents !== null &&
      pitchOk &&
      fr.clarity >= clarityThr &&
      energyOn &&
      notMuted;

    if (gatePitch) {
      gateOn = true;
      lastGoodAt = tNow;
      belowEnergySince = 0;

      const ratio = fr.hz! / targetHz;
      const errPct = (ratio - 1) * 100;
      lastGoodSample = { t: tNow, hz: fr.hz!, ratio, errPct, cents: fr.cents! };
      centsHold = fr.cents!;
    } else {
      if (gateOn) {
        const holdMs = energyKeep ? HOLD_WHILE_ENERGY_MS : DROPOUT_HOLD_MS;
        if (!energyKeep) {
          if (!belowEnergySince) belowEnergySince = tNow;
        } else {
          belowEnergySince = 0;
        }
        const silenceLongEnough = belowEnergySince ? (tNow - belowEnergySince >= SILENCE_RELEASE_MS) : false;
        const noPitchTooLong = tNow - lastGoodAt > holdMs;
        if (silenceLongEnough && noPitchTooLong) {
          gateOn = false;
          belowEnergySince = 0;
        }
      } else {
        belowEnergySince = 0;
      }
    }

    if (tNow - lastSampleTs >= SAMPLE_MS) {
      lastSampleTs = tNow;

      const winMs = getWindowMs();
      win = win.filter((s) => tNow - s.t <= winMs);

      if (gatePitch) {
        const ratio = fr.hz! / targetHz;
        const errPct = (ratio - 1) * 100;
        win.push({ t: tNow, hz: fr.hz!, ratio, errPct, cents: fr.cents! });
      } else if (gateOn && lastGoodSample && energyKeep) {
        win.push({ ...lastGoodSample, t: tNow });
      }

      if (win.length >= 6) {
        const centsArr = win.map((s) => s.cents);
        const medC = median(centsArr)!;
        const m = mad(centsArr, medC);
        const thr = Math.max(3 * m, 20);

        const filtered = win.filter((s) => Math.abs(s.cents - medC) <= thr);
        const base = filtered.length >= 4 ? filtered : win;

        const medHz = median(base.map((s) => s.hz))!;
        const medRatio = median(base.map((s) => s.ratio))!;
        const medErrPct = median(base.map((s) => s.errPct))!;

        const a = getAlpha();
        hzDisp = ema(hzDisp, medHz, a);
        ratioDisp = ema(ratioDisp, medRatio, a);

        const fillTarget = clamp(ratioDisp!, 0, 1);
        ringFill = ema(ringFill, fillTarget, getRingAlpha());

        const absErr = Math.abs(medErrPct);
        let errFillTarget = 0;
        if (absErr > tolPct) {
          const excess = absErr - tolPct;
          const full = Math.max(tolPct * 2.0, 2.0);
          errFillTarget = clamp(excess / full, 0, 1);
        }
        ringErrFill = ema(ringErrFill, errFillTarget, getRingAlpha());

        lastStableAt = tNow;

        // Exercise update (same logic as before)
        if (exActive && exDef) {
          if (tNow - exStartedAt >= exTotalMaxMs) {
            exSteps.push(exFinalizeStep());
            exFinish("timeout_total").catch(() => {});
          } else {
            const realRecent = tNow - recentRealPitchAt <= 220;
            const inGreen = realRecent && Math.abs(medErrPct) <= tolPct;

            if (inGreen) {
              exGreenConfirmMs += SAMPLE_MS;
              exTimeInGreenMs += SAMPLE_MS;
            } else {
              exGreenConfirmMs = 0;
            }

            if (exTimeToGreenMs === null && exGreenConfirmMs >= EX_CONFIRM_MS) {
              exTimeToGreenMs = Math.max(0, Math.round(tNow - exStepStartedAt - exGreenConfirmMs + EX_CONFIRM_MS));
            }

            if (realRecent) {
              const absC = Math.abs(medC);
              exAbsCentsStepAll.push(absC);
              exAbsCentsAllExercise.push(absC);
              if (exTimeToGreenMs !== null) exAbsCentsStepStable.push(absC);

              exClaritySum += fr.clarity;
              exRmsSum += fr.rms;
              exFrames += 1;

              if (exTimeToGreenMs === null) {
                exOvershootMax = Math.max(exOvershootMax, absC);
                const sign = (medC > 1e-3 ? 1 : medC < -1e-3 ? -1 : 0) as -1 | 0 | 1;
                if (sign !== 0) {
                  if (exPrevSign !== null && exPrevSign !== 0 && exPrevSign !== sign) exCorrectionCount += 1;
                  exPrevSign = sign;
                }
              } else {
                exDriftSeries.push({ t: tNow - exStepStartedAt, cents: medC });
              }

              if (tNow - exLastTraceAt >= EX_TRACE_PERIOD_MS) {
                exLastTraceAt = tNow;
                const pitchMidi = hzToMidi(medHz);
                exTrace.push({
                  t_ms: Math.round(tNow - exStartedAt),
                  step_index: exStepIdx,
                  target_midi: exTargets[exStepIdx],
                  pitch_midi_x100: Math.round(pitchMidi * 100),
                  cents_x10: Math.round(medC * 10),
                  clarity_x100: Math.round(clamp(fr.clarity, 0, 1) * 100),
                  rms_x10000: Math.round(clamp(fr.rms, 0, 1) * 10000),
                });
              }
            }

            const stepElapsed = tNow - exStepStartedAt;
            const isSingle = exDef.kind === "single";
            const heldEnough = !isSingle && exTimeToGreenMs !== null && exTimeInGreenMs >= exHoldMs;
            const stepTimeout = stepElapsed >= exMaxStepMs;

            if (isSingle && stepTimeout) {
              exSteps.push(exFinalizeStep());
              exFinish("completed_single").catch(() => {});
            } else if (!isSingle && (heldEnough || stepTimeout)) {
              exSteps.push(exFinalizeStep());
              const isLast = exStepIdx >= exTargets.length - 1;
              if (isLast) exFinish(heldEnough ? "completed" : "timeout_step").catch(() => {});
              else exStartStep(exStepIdx + 1);
            }
          }
        }
      } else {
        const withinGrace =
          gateOn && (energyKeep ? tNow - lastGoodAt <= HOLD_WHILE_ENERGY_MS : tNow - lastGoodAt <= DROPOUT_HOLD_MS);
        const recentlyStable = tNow - lastStableAt <= (energyKeep ? HOLD_WHILE_ENERGY_MS : DROPOUT_HOLD_MS);

        if (withinGrace || recentlyStable) {
          ringFill *= 0.985;
          ringErrFill *= 0.985;
        } else {
          ringFill *= 0.92;
          ringErrFill *= 0.92;
          if (ringFill < 0.02) {
            ringFill = 0;
            ringErrFill = 0;
            hzDisp = null;
            ratioDisp = null;
            centsHold = null;
          }
        }
      }

      lastFrame = { hz: fr.hz, cents: fr.cents, clarity: fr.clarity, rms: fr.rms };
    }

    requestAnimationFrame(rafLoop);
  };

  const updateUI = () => {
    subTitle.textContent = `${trainMode.toUpperCase()} • ${ringMode.toUpperCase()} • ±${tolPct.toFixed(1)}%`;

    // indicators (not buttons)
    indMic.classList.toggle("on-mic", running && engine.isMicReady());
    indSpk.classList.toggle("on-ref", engine.isReferencePlaying());

    tipPhones.style.display = trainMode === "assist" && engine.isReferencePlaying() ? "block" : "none";

    badgeState.textContent = exActive ? "Status: exercise" : (running ? "Status: idle (mic on)" : "Status: idle");

    stRoot.textContent =
      `Root: ${midiToNote(rootMidiUser).name}${midiToNote(rootMidiUser).octave}`;

    stMic.textContent = (running && engine.isMicReady()) ? "on" : "off";
    stRef.textContent = engine.isReferencePlaying() ? "on" : "off";

    if (exActive && exDef) {
      stExSep.style.display = "inline";
      stEx.style.display = "inline";
      stEx.textContent = `EX: ${exDef.id} ${exStepIdx + 1}/${exTargets.length}`;
    } else {
      stExSep.style.display = "none";
      stEx.style.display = "none";
      stEx.textContent = "";
    }


    micMeta.textContent =
      `rms: ${lastFrame.rms.toFixed(3)} • clarity: ${(lastFrame.rms >= RMS_MIN ? lastFrame.clarity : 0).toFixed(2)} • ` +
      `noise: ${noiseRms.toFixed(4)} • snr: ${snrDbDisp.toFixed(1)} dB • keep: ${energyKeepDisp ? "yes" : "no"}`;

    targetHzBig.textContent = `${targetHz.toFixed(1)} Hz`;
    {
      const n = midiToNote(targetMidi);
      const label = LANG === "ru" ? `Нота ${n.ru} (${n.name}${n.octave})` : `Note ${n.name}${n.octave}`;
      targetLine.textContent = label;
      noteRu.textContent = n.ru;
      noteBig.textContent = `${n.name}${n.octave}`;
    }

    if (!running || !engine.isMicReady()) {
      hzBig.textContent = "— Hz";
      delta.textContent = "—%";
      setMarkerCents(null);
      setRing(ringFill, ringErrFill, null);
      if (nowMs() >= hintLockUntil) setHint(t("hint_start"), 0);
      return;
    }

    if (hzDisp === null || ratioDisp === null) {
      hzBig.textContent = "— Hz";
      delta.textContent = "—%";
      setMarkerCents(null);
      setRing(ringFill, ringErrFill, null);
      return;
    }

    const pct = ratioDisp * 100;
    const errPct = (ratioDisp - 1) * 100;

    hzBig.textContent = `${hzDisp.toFixed(1)} Hz`;
    delta.textContent = `${pct.toFixed(1)}%`;

    setMarkerCents(centsHold);
    setRing(ringFill, ringErrFill, errPct);
  };

  // init settings UI
  tolMeta.textContent = `±${tolPct.toFixed(1)}%`;
  exHoldMeta.textContent = `${Math.round(exHoldMs)} ms`;
  exMaxStepMeta.textContent = `${Math.round(exMaxStepMs)} ms`;
  exTrMeta.textContent = `${Math.round(exTransposeCount)} reps`;

  setHint(t("hint_start"), 0);
  setInterval(updateUI, 140);
} catch (e) {
  showCrash("BOOT ERROR:", e);
}
