import "./style.css";
import { AudioEngine, midiToHz } from "./audio";
import { EXERCISES, ExerciseDef, getExerciseById, buildFlowTargets } from "./exercises";

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

window.addEventListener("error", (e) =>
  showCrash("RUNTIME ERROR:", (e as any).error || (e as any).message || e),
);

window.addEventListener("unhandledrejection", (e) =>
  showCrash("UNHANDLED PROMISE REJECTION:", (e as any).reason || e),
);

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
function slopeCentsPerS(series: Array<{ t: number; cents: number }>): number | null {
  // linear regression slope cents/sec using t in seconds
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
    } catch {
      // allow anonymous save for legacy mode
    }
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

async function saveAttempt(payload: any) {
  const urls = ["/api/training/attempts", "/training/attempts"];
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

  throw new Error(`Save failed: ${String(lastErr)}`);
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
function applyTheme(t: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("vtp_theme", t);
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

/** Defaults/migration */
function ensureDefaults() {
  const setIfNull = (k: string, v: string) => {
    if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  };

  setIfNull("vtp_theme", "dark");
  setIfNull("vtp_ringMode", "live");
  setIfNull("vtp_trainMode", "assist");
  setIfNull("vtp_tolPct", "1.5");

  const rv = Number(localStorage.getItem("vtp_refVol"));
  if (!Number.isFinite(rv) || rv <= 0) localStorage.setItem("vtp_refVol", "45");

  const ms = Number(localStorage.getItem("vtp_micSens"));
  if (!Number.isFinite(ms) || ms <= 0) localStorage.setItem("vtp_micSens", "120");

  // default target: C4
  const userSet = localStorage.getItem("vtp_targetUserSet");
  const cur = Number(localStorage.getItem("vtp_targetMidi"));
  if (!userSet) {
    if (!Number.isFinite(cur) || localStorage.getItem("vtp_targetMidi") === null) localStorage.setItem("vtp_targetMidi", "60");
    else if (cur === 69) localStorage.setItem("vtp_targetMidi", "60");
  }

  // exercise defaults
  setIfNull("vtp_exId", EXERCISES[0].id);
  setIfNull("vtp_exHoldMs", String(EXERCISES[0].defaultHoldMs));
  setIfNull("vtp_exMaxStepMs", String(EXERCISES[0].defaultMaxStepMs));
  setIfNull("vtp_exTransposeCount", String(EXERCISES[0].defaultTransposeCount));
  setIfNull("vtp_exTransposeStep", String(EXERCISES[0].defaultTransposeStep));
}

/** stable gesture binding (no double toggle) */
function bindUserGesture(el: HTMLElement, fn: () => void) {
  let last = 0;
  const h = (e: Event) => {
    const n = nowMs();
    if (n - last < 350) return;
    last = n;
    e.preventDefault();
    fn();
  };

  if ("PointerEvent" in window) el.addEventListener("pointerdown", h);
  else el.addEventListener("touchstart", h, { passive: false });

  el.addEventListener("click", h);
}

const ICONS = {
  mic: `<svg class="ico" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>`,
  spk: `<svg class="ico" viewBox="0 0 24 24"><path d="M3 10v4h4l5 4V6L7 10H3Zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12Zm0-9.5v2.12A9 9 0 0 1 20 12a9 9 0 0 1-3.5 7.38v2.12A11 11 0 0 0 22 12 11 11 0 0 0 16.5 2.5Z"/></svg>`,
  dot: `<svg class="ico" viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5a10 10 0 1 1 0 20 10 10 0 0 1 0-20Z"/></svg>`,
  play: `<svg class="ico" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
  stop: `<svg class="ico" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>`,
  gear: `<svg class="ico" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.51.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>`,
};

try {
  ensureDefaults();
  applyTheme(getInitialTheme());

  // try to ensure token early (non-blocking)
  ensureAuthToken().catch(() => { /* ignore */ });

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

  let targetMidi = Number(localStorage.getItem("vtp_targetMidi") ?? "60");
  if (!Number.isFinite(targetMidi)) targetMidi = 60;
  let targetHz = midiToHz(targetMidi);

  // constants
  const HOLD_MS = 2500;
  const SAMPLE_MS = 50;

  const MIN_HZ = 70;
  const MAX_HZ = 1000;

  const CLARITY_ON = 0.72;
  const CLARITY_OFF = 0.62;

  const RMS_MIN = 0.006;

  // SNR / noise-floor (фон)
  const NOISE_RMS_INIT = 0.003;
  const NOISE_ALPHA_UP = 0.002;
  const NOISE_ALPHA_DOWN = 0.06;

  const SNR_ON = 3.0;
  const SNR_OFF = 1.8;

  const SILENCE_RELEASE_MS = 260;
  const HOLD_WHILE_ENERGY_MS = 2500;

  const DROPOUT_HOLD_MS = 650;

  const TOL_SCORE_CENTS = 50;
  const BAR_RANGE = 100;

  const getWindowMs = () => (ringMode === "score" ? 900 : 450);
  const getAlpha = () => (ringMode === "score" ? 0.2 : 0.35);
  const getRingAlpha = () => (ringMode === "score" ? 0.2 : 0.28);

  // runtime state
  let running = false;
  let lastSampleTs = 0;

  let hzDisp: number | null = null;
  let ratioDisp: number | null = null;

  let ringFill = 0;
  let ringErrFill = 0;

  let lastFrame = { hz: null as number | null, cents: null as number | null, clarity: 0, rms: 0 };

  // attempt (single note TRY)
  let attemptActive = false;
  let attemptStart = 0;
  let attemptValid = 0;
  let attemptGood = 0;
  let attemptAbsCents: number[] = [];
  let attemptClaritySum = 0;

  // success feedback
  let inTuneMs = 0;
  let lastSuccessAt = 0;
  const SUCCESS_HOLD = 250;
  const SUCCESS_COOLDOWN = 1200;

  // hint lock
  let hintLockUntil = 0;
  let hintEl: HTMLDivElement;
  const setHint = (msg: string, lockMs = 0) => {
    hintEl.textContent = msg;
    hintLockUntil = Math.max(hintLockUntil, nowMs() + lockMs);
  };

  // window samples
  type Sample = { t: number; hz: number; ratio: number; errPct: number; cents: number };
  let win: Sample[] = [];

  // gating/hold state
  let gateOn = false;
  let lastGoodAt = 0;
  let lastStableAt = 0;
  let lastGoodSample: Sample | null = null;
  let centsHold: number | null = null;

  // SNR/noise floor state
  let noiseRms = NOISE_RMS_INIT;
  let snrDbDisp = 0;
  let energyKeepDisp = false;
  let belowEnergySince = 0;

  // recent real pitch timestamp (for exercise gating)
  let recentRealPitchAt = 0;

  // EQ
  const EQ_N = 18;
  let eqVals = Array(EQ_N).fill(0);

  // ----------------------------
  // Exercise Runner (Flow)
  // ----------------------------
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
    pitch_midi_x100: number; // quantized
    cents_x10: number;
    clarity_x100: number;
    rms_x10000: number;
  };

  let exActive = false;
  let exDef: ExerciseDef | null = null;
  let exTargets: number[] = [];
  let exStepIdx = 0;

  let exStartedAt = 0;
  let exStepStartedAt = 0;

  let exHoldMs = loadNum("vtp_exHoldMs", EXERCISES[0].defaultHoldMs);
  let exMaxStepMs = loadNum("vtp_exMaxStepMs", EXERCISES[0].defaultMaxStepMs);
  let exTransposeCount = loadNum("vtp_exTransposeCount", EXERCISES[0].defaultTransposeCount);
  let exTransposeStep = loadNum("vtp_exTransposeStep", EXERCISES[0].defaultTransposeStep);

  // per step accumulators
  let exGreenConfirmMs = 0;
  let exTimeToGreenMs: number | null = null;
  let exTimeInGreenMs = 0;

  let exAbsCents: number[] = [];
  let exAbsCentsAll: number[] = [];
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

  function exResetStepAccumulators() {
    exGreenConfirmMs = 0;
    exTimeToGreenMs = null;
    exTimeInGreenMs = 0;

    exAbsCents = [];
    exClaritySum = 0;
    exRmsSum = 0;
    exFrames = 0;

    exOvershootMax = 0;
    exCorrectionCount = 0;
    exPrevSign = null;

    exDriftSeries = [];
  }

  function exStartStep(stepIndex: number) {
    exStepIdx = stepIndex;
    exStepStartedAt = nowMs();
    exResetStepAccumulators();

    const midi = exTargets[exStepIdx];
    setTargetMidi(midi, false);

    // важно: не смешивать окна разных целей
    resetPitchState();

    // Assist: даём короткий эталон на старте шага
    if (trainMode === "assist") {
      applyAudioSettings();
      engine.playReference(targetHz, 0.55);
    }

    setHint(`Exercise: ${exDef?.title ?? ""} • шаг ${exStepIdx + 1}/${exTargets.length}`, 1200);
  }

  function exFinalizeStep(): StepMetric {
    const stepDur = nowMs() - exStepStartedAt;

    const medAbs = median(exAbsCents);
    const p95Abs = p95(exAbsCents);

    const pctGreen = stepDur > 0 ? (100 * exTimeInGreenMs) / stepDur : 0;

    const drift = slopeCentsPerS(exDriftSeries);

    return {
      step_index: exStepIdx,
      target_midi: exTargets[exStepIdx],

      time_to_green_ms: exTimeToGreenMs,
      time_in_green_ms: exTimeInGreenMs,
      pct_in_green: clamp(pctGreen, 0, 100),

      median_abs_cents: medAbs,
      p95_abs_cents: p95Abs,

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

    const steps = exSteps.slice();

    // aggregates
    const t2g = steps.map((s) => s.time_to_green_ms).filter((x): x is number => x !== null);
    const medAbsAll = median(exAbsCentsAll);
    const p95AbsAll = p95(exAbsCentsAll);

    const scoreTotal = (() => {
      // MVP score: 50% hold quality + 30% accuracy + 20% speed
      // (не идеал, но даст понятную динамику)
      let scoreSum = 0;
      let n = 0;

      for (const s of steps) {
        const holdScore = clamp((s.time_in_green_ms ?? 0) / Math.max(1, exHoldMs), 0, 1);

        const acc = s.median_abs_cents === null ? 0 : clamp(1 - s.median_abs_cents / 50, 0, 1);

        const speed =
          s.time_to_green_ms === null ? 0 : clamp(1 - s.time_to_green_ms / Math.max(600, exMaxStepMs * 0.6), 0, 1);

        const stepScore = 100 * (0.5 * holdScore + 0.3 * acc + 0.2 * speed);
        scoreSum += stepScore;
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

      avg_abs_cents: medAbsAll !== null ? mean(exAbsCentsAll) : null,
      p95_abs_cents: p95AbsAll,

      steps,
      trace: exTrace,
    };

    badgeSave.textContent = "Save: saving…";
    setHint(`Упражнение завершено (${reason}). Score ~${payload.score_total}%. Сохраняю…`, 2500);

    try {
      const res = await saveExerciseAttempt(payload);
      badgeSave.textContent = `Save: id=${res.id}`;
      setHint(`Сохранено: упражнение ${payload.exercise_id}, score ${payload.score_total}%`, 5000);
    } catch (e) {
      badgeSave.textContent = "Save: error";
      setHint(`Ошибка сохранения упражнения: ${String(e)}`, 7000);
    }

    // show quick summary overlay (lightweight)
    renderExerciseOverlay(payload);
  }

  // overlay UI (minimal, without touching style.css)
  let overlayEl: HTMLDivElement | null = null;
  let overlaySummaryEl: HTMLDivElement | null = null;
  let overlayTableEl: HTMLDivElement | null = null;
  let overlayCanvas: HTMLCanvasElement | null = null;

  function ensureOverlay() {
    if (overlayEl) return;

    const el = document.createElement("div");
    el.id = "exOverlay";
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.background = "rgba(0,0,0,.55)";
    el.style.display = "none";
    el.style.zIndex = "9999";
    el.style.padding = "18px";
    el.style.overflow = "auto";

    el.innerHTML = `
      <div style="max-width:980px;margin:0 auto;background:rgba(17,24,39,.92);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="font-weight:700;font-size:16px">Результат упражнения</div>
          <button id="exClose" class="iconBtn" style="padding:10px 12px">${ICONS.stop}<span class="lbl">CLOSE</span></button>
        </div>

        <div id="exSummary" style="margin-top:10px;color:rgba(255,255,255,.8);font-size:13px;line-height:1.35"></div>

        <div style="margin-top:12px">
          <canvas id="exCanvas" width="920" height="240" style="width:100%;height:220px;border-radius:12px;background:rgba(255,255,255,.04)"></canvas>
          <div style="margin-top:6px;color:rgba(255,255,255,.55);font-size:12px">
            график: pitch (MIDI) vs target (MIDI), по trace (downsample ~10Hz)
          </div>
        </div>

        <div id="exTable" style="margin-top:12px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:12px;color:rgba(255,255,255,.85);white-space:pre;overflow:auto;background:rgba(255,255,255,.03);border-radius:12px;padding:12px"></div>
      </div>
    `;

    document.body.appendChild(el);

    overlayEl = el;
    overlaySummaryEl = el.querySelector("#exSummary") as HTMLDivElement;
    overlayTableEl = el.querySelector("#exTable") as HTMLDivElement;
    overlayCanvas = el.querySelector("#exCanvas") as HTMLCanvasElement;

    const btnClose = el.querySelector("#exClose") as HTMLButtonElement;
    btnClose.onclick = () => {
      if (overlayEl) overlayEl.style.display = "none";
    };

    el.addEventListener("click", (ev) => {
      if (ev.target === el) el.style.display = "none";
    });
  }

  function drawTrace(canvas: HTMLCanvasElement, trace: TracePoint[]) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!trace.length) {
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.font = "14px ui-sans-serif";
      ctx.fillText("нет trace данных", 12, 24);
      return;
    }

    // compute bounds
    const tMax = Math.max(...trace.map((p) => p.t_ms));
    const pitch = trace.map((p) => p.pitch_midi_x100 / 100);
    const target = trace.map((p) => p.target_midi / 1); // already integer midi

    const yVals = pitch.concat(target);
    const yMin = Math.min(...yVals) - 0.8;
    const yMax = Math.max(...yVals) + 0.8;

    const xScale = (t: number) => 12 + (tMax <= 0 ? 0 : (t / tMax) * (w - 24));
    const yScale = (y: number) => 12 + ((yMax - y) / Math.max(1e-6, (yMax - yMin))) * (h - 24);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const yy = 12 + (i / 4) * (h - 24);
      ctx.beginPath();
      ctx.moveTo(12, yy);
      ctx.lineTo(w - 12, yy);
      ctx.stroke();
    }

    // target (stair-ish by connecting points)
    ctx.strokeStyle = "rgba(52,211,153,.65)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const x = xScale(trace[i].t_ms);
      const y = yScale(trace[i].target_midi);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // pitch
    ctx.strokeStyle = "rgba(96,165,250,.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const x = xScale(trace[i].t_ms);
      const y = yScale(trace[i].pitch_midi_x100 / 100);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function renderExerciseOverlay(payload: any) {
    ensureOverlay();
    if (!overlayEl || !overlaySummaryEl || !overlayTableEl || !overlayCanvas) return;

    const steps: StepMetric[] = payload.steps ?? [];

    overlaySummaryEl.textContent =
      `Exercise: ${payload.exercise_id} • mode=${payload.mode} • flow • ` +
      `score=${payload.score_total}% • time=${Math.round((payload.total_time_ms ?? 0) / 1000)}s • ` +
      `avg t2g=${payload.avg_time_to_green_ms ? Math.round(payload.avg_time_to_green_ms) + "ms" : "—"} • ` +
      `p95 abs cents=${payload.p95_abs_cents ? payload.p95_abs_cents.toFixed(1) : "—"}`;

    // table
    const lines: string[] = [];
    lines.push("idx  midi  t2g(ms)  inGreen(ms)  %green  medAbsC  p95AbsC  corr  drift(c/s)");
    for (const s of steps) {
      const drift = s.drift_cents_per_s === null ? "—" : s.drift_cents_per_s.toFixed(2);
      lines.push(
        `${String(s.step_index + 1).padStart(3)}  ${String(s.target_midi).padStart(4)}  ` +
        `${String(s.time_to_green_ms ?? "—").padStart(7)}  ${String(s.time_in_green_ms).padStart(10)}  ` +
        `${s.pct_in_green.toFixed(0).padStart(6)}  ` +
        `${(s.median_abs_cents ?? NaN).toFixed(1).padStart(7)}  ${(s.p95_abs_cents ?? NaN).toFixed(1).padStart(7)}  ` +
        `${String(s.correction_count).padStart(4)}  ${drift.padStart(9)}`
      );
    }
    overlayTableEl.textContent = lines.join("\n");

    // chart
    drawTrace(overlayCanvas, payload.trace ?? []);

    overlayEl.style.display = "block";
  }

  // UI
  const refVol0 = loadNum("vtp_refVol", 45);
  const micSens0 = loadNum("vtp_micSens", 120);

  app.innerHTML = `
  <div class="container">

    <div id="viewTrain" class="view active">
      <div class="card">

        <div class="header">
          <div>
            <div class="brand">Voice Trainer Pro</div>
            <div class="subtle">Hi‑end tuner • Assist / Challenge • Exercises</div>
          </div>

          <div class="badges">
            <span class="badge" id="badgeState">Status: idle</span>
            <span class="badge" id="badgeSave">Save: —</span>
          </div>
        </div>

        <div class="controls">
          <button class="iconBtn primary" id="btnMic">${ICONS.mic}<span class="lbl">MIC</span></button>
          <button class="iconBtn" id="btnRef">${ICONS.spk}<span class="lbl">REF</span></button>
          <button class="iconBtn" id="btnTry">${ICONS.dot}<span class="lbl">TRY</span></button>
        </div>

        <div class="row" style="margin-top:10px;gap:10px;flex-wrap:wrap">
          <select class="btnLike" id="selExercise" style="min-width:280px"></select>

          <button class="iconBtn" id="btnExStart">${ICONS.play}<span class="lbl">START</span></button>
          <button class="iconBtn" id="btnExStop">${ICONS.stop}<span class="lbl">STOP</span></button>

          <div style="flex:1"></div>

          <div class="small" id="exMeta" style="min-width:260px;text-align:right;opacity:.85"></div>
        </div>

        <div class="stateLine" id="stateLine">—</div>

        <div class="grid">
          <div class="ringWrap">
            <div class="ring" id="ringBox">
              <svg viewBox="0 0 100 100">
                <!-- outer (error overflow) ring -->
                <circle cx="50" cy="50" r="46" stroke="rgba(255,255,255,.06)" stroke-width="5" fill="none"/>
                <circle id="ringErr" cx="50" cy="50" r="46" stroke="rgba(255,255,255,.10)" stroke-width="5"
                  stroke-linecap="round" fill="none"
                  stroke-dasharray="289.03" stroke-dashoffset="289.03"
                  transform="rotate(-90 50 50)"/>

                <!-- inner (ratio) ring -->
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
            <div class="targetLine" id="targetLine">—</div>
            <div class="hint" id="hint">Нажмите REF для эталона или MIC для микрофона.</div>

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
    </div>

    <div id="viewSettings" class="view">
      <div class="card">

        <div class="header">
          <div class="brand">Настройки</div>
          <button class="iconBtn" id="btnTheme">${ICONS.gear}<span class="lbl">THEME</span></button>
        </div>

        <div class="hr"></div>

        <div class="small">Целевая нота</div>
        <div class="row">
          <select class="btnLike" id="selNote"></select>
          <select class="btnLike" id="selOct"></select>
          <button class="iconBtn" id="btnPlayTarget">${ICONS.spk}<span class="lbl">PLAY</span></button>
        </div>
        <div class="small" id="noteMeta"></div>

        <div class="hr"></div>

        <div class="small">Mode</div>
        <div class="row">
          <button class="iconBtn" id="modeAssist">${ICONS.spk}<span class="lbl">ASSIST</span></button>
          <button class="iconBtn" id="modeChallenge">${ICONS.dot}<span class="lbl">CHALLENGE</span></button>
        </div>
        <div class="small" id="modeMeta"></div>

        <div class="hr"></div>

        <div class="small">Ring mode</div>
        <div class="row">
          <button class="iconBtn" id="ringLive">${ICONS.dot}<span class="lbl">LIVE</span></button>
          <button class="iconBtn" id="ringScore">${ICONS.dot}<span class="lbl">SCORE</span></button>
        </div>
        <div class="small" id="ringMeta"></div>

        <div class="hr"></div>

        <div class="small">Зелёная зона ±%</div>
        <input class="slider" id="tolPct" type="range" min="0.5" max="3.0" step="0.1" value="${tolPct}" />
        <div class="small" id="tolMeta">±${tolPct.toFixed(1)}%</div>

        <div class="hr"></div>

        <div class="small">Exercises: hold ms (Flow)</div>
        <input class="slider" id="exHoldMs" type="range" min="500" max="4000" step="100" value="${exHoldMs}" />
        <div class="small" id="exHoldMeta">${Math.round(exHoldMs)} ms</div>

        <div style="height:12px"></div>

        <div class="small">Exercises: max step ms</div>
        <input class="slider" id="exMaxStepMs" type="range" min="2000" max="15000" step="250" value="${exMaxStepMs}" />
        <div class="small" id="exMaxStepMeta">${Math.round(exMaxStepMs)} ms</div>

        <div style="height:12px"></div>

        <div class="small">Exercises: transpositions</div>
        <input class="slider" id="exTrCount" type="range" min="1" max="24" step="1" value="${exTransposeCount}" />
        <div class="small" id="exTrMeta">${Math.round(exTransposeCount)} reps</div>

        <div class="hr"></div>

        <div class="small">Ref volume</div>
        <input class="slider" id="refVol" type="range" min="0" max="100" value="${refVol0}" />

        <div style="height:12px"></div>

        <div class="small">Mic sensitivity</div>
        <input class="slider" id="micSens" type="range" min="50" max="300" value="${micSens0}" />
        <div class="small" id="micMeta"></div>

      </div>
    </div>

    <div class="tabbar">
      <div class="tabbarInner">
        <button class="tab active" id="tabTrain">${ICONS.dot}<span>Тренировка</span></button>
        <button class="tab" id="tabSettings">${ICONS.gear}<span>Настройки</span></button>
      </div>
    </div>

  </div>
  `;

  const q = <T extends Element>(sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`UI element not found: ${sel}`);
    return el as T;
  };

  // tabs
  const viewTrain = q<HTMLDivElement>("#viewTrain");
  const viewSettings = q<HTMLDivElement>("#viewSettings");
  const tabTrain = q<HTMLButtonElement>("#tabTrain");
  const tabSettings = q<HTMLButtonElement>("#tabSettings");

  const showView = (name: "train" | "settings") => {
    const train = name === "train";
    viewTrain.classList.toggle("active", train);
    viewSettings.classList.toggle("active", !train);
    tabTrain.classList.toggle("active", train);
    tabSettings.classList.toggle("active", !train);
  };

  tabTrain.onclick = () => showView("train");
  tabSettings.onclick = () => showView("settings");

  // train refs
  const btnMic = q<HTMLButtonElement>("#btnMic");
  const btnRef = q<HTMLButtonElement>("#btnRef");
  const btnTry = q<HTMLButtonElement>("#btnTry");

  const selExercise = q<HTMLSelectElement>("#selExercise");
  const btnExStart = q<HTMLButtonElement>("#btnExStart");
  const btnExStop = q<HTMLButtonElement>("#btnExStop");
  const exMeta = q<HTMLDivElement>("#exMeta");

  const badgeState = q<HTMLSpanElement>("#badgeState");
  const badgeSave = q<HTMLSpanElement>("#badgeSave");
  const stateLine = q<HTMLDivElement>("#stateLine");

  const ringBox = q<HTMLDivElement>("#ringBox");
  const ringProg = q<SVGCircleElement>("#ringProg");
  const ringErr = q<SVGCircleElement>("#ringErr");

  const noteRu = q<HTMLDivElement>("#noteRu");
  const noteBig = q<HTMLDivElement>("#noteBig");
  const hzBig = q<HTMLDivElement>("#hzBig");
  const delta = q<HTMLDivElement>("#delta");

  const targetLine = q<HTMLDivElement>("#targetLine");
  hintEl = q<HTMLDivElement>("#hint");
  const tipPhones = q<HTMLDivElement>("#tipPhones");

  const eq = q<HTMLDivElement>("#eq");
  const marker = q<HTMLDivElement>("#marker");

  eq.innerHTML = Array.from({ length: EQ_N }).map(() => "<span></span>").join("");
  const eqBars = Array.from(eq.querySelectorAll("span")) as HTMLSpanElement[];

  // settings refs
  const btnTheme = q<HTMLButtonElement>("#btnTheme");

  const selNote = q<HTMLSelectElement>("#selNote");
  const selOct = q<HTMLSelectElement>("#selOct");
  const btnPlayTarget = q<HTMLButtonElement>("#btnPlayTarget");
  const noteMeta = q<HTMLDivElement>("#noteMeta");

  const modeAssistBtn = q<HTMLButtonElement>("#modeAssist");
  const modeChallengeBtn = q<HTMLButtonElement>("#modeChallenge");
  const modeMeta = q<HTMLDivElement>("#modeMeta");

  const ringLiveBtn = q<HTMLButtonElement>("#ringLive");
  const ringScoreBtn = q<HTMLButtonElement>("#ringScore");
  const ringMeta = q<HTMLDivElement>("#ringMeta");

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

  // theme
  btnTheme.onclick = () => {
    const t = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(t);
  };

  // audio apply
  const applyAudioSettings = () => {
    engine.setReferenceVolume((Number(refVol.value) / 100) * 0.6);
    engine.setMicSensitivity(Number(micSens.value) / 100);
  };

  refVol.oninput = () => {
    saveNum("vtp_refVol", Number(refVol.value));
    applyAudioSettings();
  };

  micSens.oninput = () => {
    saveNum("vtp_micSens", Number(micSens.value));
    applyAudioSettings();
  };

  applyAudioSettings();

  // tol %
  tolPctSlider.oninput = () => {
    tolPct = clamp(Number(tolPctSlider.value), 0.5, 3.0);
    localStorage.setItem("vtp_tolPct", String(tolPct));
    tolMeta.textContent = `±${tolPct.toFixed(1)}%`;
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
    modeMeta.textContent = trainMode === "assist" ? "Assist: REF toggle" : "Challenge: REF short + TRY";
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
    ringMeta.textContent = ringMode === "live" ? "Live: быстрее" : "Score: сглажено";
  };

  const resetPitchState = () => {
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

    inTuneMs = 0;

    noiseRms = NOISE_RMS_INIT;
    snrDbDisp = 0;
    energyKeepDisp = false;
    belowEnergySince = 0;

    recentRealPitchAt = 0;
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

  const setTargetMidi = (m: number, userSet = true) => {
    targetMidi = m;
    targetHz = midiToHz(targetMidi);
    saveNum("vtp_targetMidi", targetMidi);
    if (userSet) localStorage.setItem("vtp_targetUserSet", "1");

    const n = midiToNote(targetMidi);
    noteRu.textContent = n.ru;
    noteBig.textContent = `${n.name}${n.octave}`;

    selNote.value = n.name;
    selOct.value = String(n.octave);

    noteMeta.textContent = `Текущая: ${n.ru} (${n.name}${n.octave}) ${targetHz.toFixed(1)} Hz`;

    if (engine.isReferencePlaying()) engine.startReference(targetHz);
  };

  setTargetMidi(targetMidi, false);

  selNote.onchange = () => setTargetMidi(noteOctToMidi(selNote.value, Number(selOct.value)), true);
  selOct.onchange = () => setTargetMidi(noteOctToMidi(selNote.value, Number(selOct.value)), true);

  bindUserGesture(btnPlayTarget, () => {
    applyAudioSettings();
    engine.playReference(targetHz, 1.0);
  });

  // exercise select
  selExercise.innerHTML = EXERCISES.map((e) => `<option value="${e.id}">${e.title}</option>`).join("");
  const exIdSaved = localStorage.getItem("vtp_exId") ?? EXERCISES[0].id;
  selExercise.value = getExerciseById(exIdSaved).id;

  function renderExMeta() {
    const id = selExercise.value;
    const ex = getExerciseById(id);
    const reps = Math.round(exTransposeCount);
    const totalSteps = buildFlowTargets(ex, targetMidi, reps, Math.round(exTransposeStep)).length;
    exMeta.textContent = `hold=${Math.round(exHoldMs)}ms • max=${Math.round(exMaxStepMs)}ms • steps=${totalSteps}`;
  }
  renderExMeta();

  selExercise.onchange = () => {
    localStorage.setItem("vtp_exId", selExercise.value);
    const ex = getExerciseById(selExercise.value);

    // auto-tune defaults once (only if values are missing/invalid)
    if (!Number.isFinite(exHoldMs) || exHoldMs <= 0) exHoldMs = ex.defaultHoldMs;
    if (!Number.isFinite(exMaxStepMs) || exMaxStepMs <= 0) exMaxStepMs = ex.defaultMaxStepMs;

    renderExMeta();
  };

  // visuals
  const setMarkerCents = (cents: number | null) => {
    if (cents === null) {
      marker.style.opacity = "0";
      marker.style.left = "50%";
      return;
    }
    const c = clamp(cents, -BAR_RANGE, BAR_RANGE);
    const t = (c + BAR_RANGE) / (2 * BAR_RANGE);
    marker.style.opacity = "1";
    marker.style.left = `${t * 100}%`;
  };

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

  const flashSuccess = () => {
    ringBox.classList.add("flash");
    setTimeout(() => ringBox.classList.remove("flash"), 180);
  };

  const updateUI = () => {
    const n = midiToNote(targetMidi);

    btnMic.classList.toggle("on-mic", running && engine.isMicReady());
    btnRef.classList.toggle("on-ref", engine.isReferencePlaying());

    tipPhones.style.display = trainMode === "assist" && engine.isReferencePlaying() ? "block" : "none";

    const exLine = exActive && exDef
      ? ` • EX: ${exDef.id} step ${exStepIdx + 1}/${exTargets.length}`
      : "";

    stateLine.textContent =
      `MIC: ${running && engine.isMicReady() ? "on" : "off"} • ` +
      `REF: ${engine.isReferencePlaying() ? "on" : "off"} • ` +
      `MODE: ${trainMode.toUpperCase()} • RING: ${ringMode.toUpperCase()} • ±${tolPct.toFixed(1)}%` +
      exLine;

    micMeta.textContent =
      `rms: ${lastFrame.rms.toFixed(3)} • clarity: ${(lastFrame.rms >= RMS_MIN ? lastFrame.clarity : 0).toFixed(2)} • ` +
      `noise: ${noiseRms.toFixed(4)} • snr: ${snrDbDisp.toFixed(1)} dB • keep: ${energyKeepDisp ? "yes" : "no"}`;

    if (!running || !engine.isMicReady()) {
      badgeState.textContent = "Status: idle";
      hzBig.textContent = "— Hz";
      delta.textContent = "—%";
      targetLine.textContent = `Нота ${n.ru} (${n.name}${n.octave}) • ${targetHz.toFixed(1)} Hz`;
      setMarkerCents(null);
      setRing(ringFill, ringErrFill, null);
      return;
    }

    badgeState.textContent = exActive ? "Status: exercise" : (attemptActive ? "Status: attempt" : "Status: listening");

    if (hzDisp === null || ratioDisp === null) {
      hzBig.textContent = "— Hz";
      delta.textContent = "—%";
      targetLine.textContent = `Нота ${n.ru} (${n.name}${n.octave}) • ${targetHz.toFixed(1)} Hz`;
      setMarkerCents(null);
      setRing(ringFill, ringErrFill, null);
      return;
    }

    const pct = ratioDisp * 100;
    const errPct = (ratioDisp - 1) * 100;

    hzBig.textContent = `${hzDisp.toFixed(1)} Hz`;
    delta.textContent = `${pct.toFixed(1)}%`;
    targetLine.textContent = `Нота ${n.ru} (${n.name}${n.octave}) • ${targetHz.toFixed(1)} Hz • Δ ${errPct.toFixed(2)}%`;

    setMarkerCents(centsHold);
    setRing(ringFill, ringErrFill, errPct);
  };

  const rafLoop = () => {
    if (!running) return;

    const fr = engine.frame(targetHz);
    const t = nowMs();

    // EQ
    const spec = engine.getSpectrumBars(18);
    for (let i = 0; i < 18; i++) {
      eqVals[i] = eqVals[i] * 0.75 + spec[i] * 0.25;
      const h = 6 + Math.round(eqVals[i] * 48);
      eqBars[i].style.height = `${h}px`;
    }

    // strict pitch (for scoring, exercises)
    const pitchOk = fr.hz !== null && fr.hz >= MIN_HZ && fr.hz <= MAX_HZ;
    const notMuted = !engine.isMicMuted();

    const hasPitchRaw =
      fr.hz !== null &&
      fr.cents !== null &&
      pitchOk &&
      fr.clarity >= CLARITY_ON &&
      fr.rms >= RMS_MIN &&
      notMuted;

    if (hasPitchRaw) recentRealPitchAt = t;

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
      lastGoodAt = t;
      belowEnergySince = 0;

      const ratio = fr.hz! / targetHz;
      const errPct = (ratio - 1) * 100;
      lastGoodSample = { t, hz: fr.hz!, ratio, errPct, cents: fr.cents! };
      centsHold = fr.cents!;
    } else {
      if (gateOn) {
        const holdMs = energyKeep ? HOLD_WHILE_ENERGY_MS : DROPOUT_HOLD_MS;

        if (!energyKeep) {
          if (!belowEnergySince) belowEnergySince = t;
        } else {
          belowEnergySince = 0;
        }

        const silenceLongEnough = belowEnergySince ? (t - belowEnergySince >= SILENCE_RELEASE_MS) : false;
        const noPitchTooLong = t - lastGoodAt > holdMs;

        if (silenceLongEnough && noPitchTooLong) {
          gateOn = false;
          belowEnergySince = 0;
        }
      } else {
        belowEnergySince = 0;
      }
    }

    // sample @ 20 fps
    if (t - lastSampleTs >= SAMPLE_MS) {
      lastSampleTs = t;

      // window
      const winMs = getWindowMs();
      win = win.filter((s) => t - s.t <= winMs);

      if (gatePitch) {
        const ratio = fr.hz! / targetHz;
        const errPct = (ratio - 1) * 100;
        win.push({ t, hz: fr.hz!, ratio, errPct, cents: fr.cents! });
      } else if (gateOn && lastGoodSample && energyKeep) {
        win.push({ ...lastGoodSample, t });
      }

      if (win.length >= 6) {
        // robust filter via MAD on cents
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

        // outer ring: overflow outside tolerance
        const absErr = Math.abs(medErrPct);
        let errFillTarget = 0;
        if (absErr > tolPct) {
          const excess = absErr - tolPct;
          const full = Math.max(tolPct * 2.0, 2.0);
          errFillTarget = clamp(excess / full, 0, 1);
        }
        ringErrFill = ema(ringErrFill, errFillTarget, getRingAlpha());

        // success beep/flash for single-note listening (don’t spam during exercise)
        if (!exActive) {
          if (Math.abs(medErrPct) <= tolPct) inTuneMs += SAMPLE_MS;
          else inTuneMs = Math.max(0, inTuneMs - SAMPLE_MS * 2);

          if (inTuneMs >= SUCCESS_HOLD && t - lastSuccessAt > SUCCESS_COOLDOWN) {
            lastSuccessAt = t;
            engine.playSuccessBeep();
            flashSuccess();
          }
        }

        lastStableAt = t;

        // -------------------------
        // Exercise update on stable sample
        // -------------------------
        if (exActive && exDef) {
          // only count if we saw real pitch recently (avoid “held” cheating)
          const realRecent = t - recentRealPitchAt <= 220;

          const inGreen = realRecent && Math.abs(medErrPct) <= tolPct;

          if (inGreen) {
            exGreenConfirmMs += SAMPLE_MS;
            exTimeInGreenMs += SAMPLE_MS;
          } else {
            exGreenConfirmMs = 0;
          }

          if (exTimeToGreenMs === null && exGreenConfirmMs >= EX_CONFIRM_MS) {
            // approximate first entry moment
            exTimeToGreenMs = Math.max(0, Math.round(t - exStepStartedAt - exGreenConfirmMs + EX_CONFIRM_MS));
          }

          // accumulate accuracy metrics (only if realRecent)
          if (realRecent) {
            const absC = Math.abs(medC);
            exAbsCents.push(absC);
            exAbsCentsAll.push(absC);

            exClaritySum += fr.clarity;
            exRmsSum += fr.rms;
            exFrames += 1;

            // before stable green -> overshoot/corrections
            if (exTimeToGreenMs === null) {
              exOvershootMax = Math.max(exOvershootMax, absC);

              const sign = (medC > 1e-3 ? 1 : (medC < -1e-3 ? -1 : 0)) as -1 | 0 | 1;
              if (sign !== 0) {
                if (exPrevSign !== null && exPrevSign !== 0 && exPrevSign !== sign) exCorrectionCount += 1;
                exPrevSign = sign;
              }
            } else {
              // after taking note -> track drift series
              exDriftSeries.push({ t: t - exStepStartedAt, cents: medC });
            }

            // trace (downsample)
            if (t - exLastTraceAt >= EX_TRACE_PERIOD_MS) {
              exLastTraceAt = t;
              const pitchMidi = hzToMidi(medHz);
              exTrace.push({
                t_ms: Math.round(t - exStartedAt),
                step_index: exStepIdx,
                target_midi: exTargets[exStepIdx],
                pitch_midi_x100: Math.round(pitchMidi * 100),
                cents_x10: Math.round(medC * 10),
                clarity_x100: Math.round(clamp(fr.clarity, 0, 1) * 100),
                rms_x10000: Math.round(clamp(fr.rms, 0, 1) * 10000),
              });
            }
          }

          // step advance rules
          const stepElapsed = t - exStepStartedAt;
          const heldEnough = exTimeToGreenMs !== null && exTimeInGreenMs >= exHoldMs;

          if (heldEnough || stepElapsed >= exMaxStepMs) {
            const metric = exFinalizeStep();
            exSteps.push(metric);

            const isLast = exStepIdx >= exTargets.length - 1;
            if (isLast) {
              exFinish(heldEnough ? "completed" : "timeout").catch(() => { /* ignore */ });
            } else {
              exStartStep(exStepIdx + 1);
            }
          }
        }
      } else {
        // win not ready: slow decay, avoid hard reset on short dropouts
        const withinGrace =
          gateOn &&
          (energyKeep ? t - lastGoodAt <= HOLD_WHILE_ENERGY_MS : t - lastGoodAt <= DROPOUT_HOLD_MS);

        const recentlyStable = t - lastStableAt <= (energyKeep ? HOLD_WHILE_ENERGY_MS : DROPOUT_HOLD_MS);

        if (withinGrace || recentlyStable) {
          ringFill *= 0.985;
          ringErrFill *= 0.985;
          inTuneMs = Math.max(0, inTuneMs - SAMPLE_MS);
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

          inTuneMs = 0;
        }
      }

      lastFrame = { hz: fr.hz, cents: fr.cents, clarity: fr.clarity, rms: fr.rms };
    }

    // single note TRY scoring (strict)
    if (attemptActive) {
      if (hasPitchRaw) {
        attemptValid += 1;
        const absC = Math.abs(fr.cents!);
        attemptAbsCents.push(absC);
        attemptClaritySum += fr.clarity;
        if (absC <= TOL_SCORE_CENTS) attemptGood += 1;
      }

      if (t - attemptStart >= HOLD_MS) {
        attemptActive = false;

        if (attemptValid < 10) {
          setHint("Попытка: слишком мало данных. Повторите.", 3000);
        } else {
          const score = 100 * (attemptGood / attemptValid);

          const payload = {
            midi_note: targetMidi,
            score,
            cents_abs_mean: mean(attemptAbsCents),
            cents_p95_abs: p95(attemptAbsCents),
            confidence_mean: attemptValid ? attemptClaritySum / attemptValid : null,
            duration_ms: HOLD_MS,
          };

          badgeSave.textContent = "Save: saving…";
          setHint(`Попытка завершена: score ${score.toFixed(0)}%. Сохраняю…`, 2500);

          saveAttempt(payload)
            .then((res) => {
              badgeSave.textContent = `Save: id=${res.id}`;
              setHint(`Сохранено: score ${score.toFixed(0)}% (id=${res.id})`, 5000);
            })
            .catch((e) => {
              badgeSave.textContent = "Save: error";
              setHint(`Ошибка сохранения: ${String(e)}`, 7000);
            });
        }
      }
    }

    requestAnimationFrame(rafLoop);
  };

  async function ensureMicOn() {
    if (running && engine.isMicReady()) return true;

    try {
      await engine.initMic();
      running = true;

      noiseRms = NOISE_RMS_INIT;
      snrDbDisp = 0;
      energyKeepDisp = false;
      belowEnergySince = 0;
      recentRealPitchAt = 0;

      applyAudioSettings();
      badgeSave.textContent = "Save: —";

      requestAnimationFrame(rafLoop);
      return true;
    } catch (e) {
      setHint(`Ошибка микрофона: ${String(e)}`, 7000);
      return false;
    }
  }

  // MIC toggle
  btnMic.onclick = async () => {
    if (exActive) {
      setHint("Сначала остановите упражнение (STOP).", 1800);
      return;
    }

    if (running && engine.isMicReady()) {
      running = false;
      engine.stopReference();
      engine.stopMic();
      setHint("MIC выключен.", 1200);
      return;
    }

    await ensureMicOn();
  };

  // REF
  bindUserGesture(btnRef, () => {
    if (exActive) {
      setHint("Во время упражнения REF управляется автоматически.", 1600);
      return;
    }

    applyAudioSettings();

    if (trainMode === "assist") {
      if (engine.isReferencePlaying()) {
        engine.stopReference();
        setHint("REF выключен.", 900);
      } else {
        engine.startReference(targetHz);
        setHint("REF включен. Наушники рекомендованы.", 1800);
      }
    } else {
      engine.playReference(targetHz, 1.0);
      setHint("REF проигран.", 900);
    }
  });

  // TRY
  btnTry.onclick = async () => {
    if (exActive) {
      setHint("Во время упражнения TRY недоступен. Нажмите STOP.", 1800);
      return;
    }

    const ok = await ensureMicOn();
    if (!ok) return;

    if (attemptActive) return;
    if (trainMode === "challenge" && engine.isReferencePlaying()) engine.stopReference();

    attemptActive = true;
    attemptStart = nowMs();
    attemptValid = 0;
    attemptGood = 0;
    attemptAbsCents = [];
    attemptClaritySum = 0;

    badgeSave.textContent = "Save: —";
    setHint("Попытка началась: удерживайте ноту 2.5 сек.", 2000);
  };

  // Exercise START/STOP
  btnExStart.onclick = async () => {
    if (exActive) return;

    const ok = await ensureMicOn();
    if (!ok) return;

    exDef = getExerciseById(selExercise.value);
    localStorage.setItem("vtp_exId", exDef.id);

    // build targets from current selected targetMidi (as root)
    exTargets = buildFlowTargets(exDef, targetMidi, Math.round(exTransposeCount), Math.round(exTransposeStep));
    if (!exTargets.length) {
      setHint("Упражнение пустое (targets=0).", 2500);
      return;
    }

    // reset global exercise state
    exActive = true;
    exSteps = [];
    exTrace = [];
    exAbsCentsAll = [];
    exLastTraceAt = 0;

    exStartedAt = nowMs();

    badgeSave.textContent = "Save: —";
    setHint(`START: ${exDef.title}`, 1200);

    // kick first step
    exStartStep(0);
    renderExMeta();
  };

  btnExStop.onclick = () => {
    if (!exActive) return;
    exFinish("stopped").catch(() => { /* ignore */ });
  };

  // render initial note UI
  {
    const n = midiToNote(targetMidi);
    noteRu.textContent = n.ru;
    noteBig.textContent = `${n.name}${n.octave}`;
  }

  // periodic UI update
  setInterval(updateUI, 140);
} catch (e) {
  showCrash("BOOT ERROR:", e);
}
