import "./style.css";
import { AudioEngine, midiToHz } from "./audio";

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
window.addEventListener("unhandledrejection", (e) => showCrash("UNHANDLED PROMISE REJECTION:", (e as any).reason || e));

/** utils */
function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)); }
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return (a.length % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
}
function ema(prev: number | null, next: number, alpha: number) {
  return prev === null ? next : prev * (1 - alpha) + next * alpha;
}
function mad(xs: number[], med: number): number {
  const dev = xs.map(x => Math.abs(x - med));
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

/** API */
async function postJson(url: string, data: any) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
async function saveAttempt(payload: any) {
  const urls = ["/api/training/attempts", "/training/attempts"];
  let lastErr: any = null;
  for (const u of urls) {
    try {
      const r = await postJson(u, payload);
      if (r.ok) return await r.json();
      lastErr = await r.text();
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Save failed: ${String(lastErr)}`);
}

/** Theme */
function getInitialTheme(): "dark" | "light" {
  const saved = localStorage.getItem("vtp_theme");
  return (saved === "light" || saved === "dark") ? saved : "dark";
}
function applyTheme(t: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("vtp_theme", t);
}

/** Notes */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_RU: Record<string, string> = { "C": "До", "D": "Ре", "E": "Ми", "F": "Фа", "G": "Соль", "A": "Ля", "B": "Си" };
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
}

/** stable gesture binding (no double toggle) */
function bindUserGesture(el: HTMLElement, fn: () => void) {
  let last = 0;
  const h = (e: Event) => {
    const now = performance.now();
    if (now - last < 350) return;
    last = now;
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
  gear: `<svg class="ico" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.51.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>`
};

try {
  ensureDefaults();
  applyTheme(getInitialTheme());

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

  const TOL_SCORE_CENTS = 50;
  const BAR_RANGE = 100; // +/- 100 cents for marker (FIX)

  const getWindowMs = () => (ringMode === "score") ? 900 : 450;
  const getAlpha = () => (ringMode === "score") ? 0.20 : 0.35;
  const getRingAlpha = () => (ringMode === "score") ? 0.20 : 0.28;

  // runtime state
  let running = false;
  let lastSampleTs = 0;

  let hzDisp: number | null = null;
  let ratioDisp: number | null = null;
  let ringFill = 0;

  let lastFrame = { hz: null as number | null, cents: null as number | null, clarity: 0, rms: 0 };

  // attempt
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
    hintLockUntil = Math.max(hintLockUntil, performance.now() + lockMs);
  };

  // window samples
  type Sample = { t: number; hz: number; ratio: number; errPct: number; cents: number; };
  let win: Sample[] = [];

  // EQ
  const EQ_N = 18;
  let eqVals = Array(EQ_N).fill(0);

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
            <div class="subtle">Hi‑end tuner • Assist / Challenge</div>
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
        <div class="stateLine" id="stateLine">—</div>

        <div class="grid">
          <div class="ringWrap">
            <div class="ring" id="ringBox">
              <svg viewBox="0 0 100 100">
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

        <div class="small">Ref volume</div>
        <input class="slider" id="refVol" type="range" min="0" max="100" value="${refVol0}" />

        <div style="height:12px"></div>

        <div class="small">Mic sensitivity</div>
        <input class="slider" id="micSens" type="range" min="50" max="300" value="${micSens0}" />
        <div class="small" id="micMeta"></div>
      </div>
    </div>
  </div>

  <div class="tabbar">
    <div class="tabbarInner">
      <button class="tab active" id="tabTrain">${ICONS.dot}<span>Тренировка</span></button>
      <button class="tab" id="tabSettings">${ICONS.gear}<span>Настройки</span></button>
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

  const badgeState = q<HTMLSpanElement>("#badgeState");
  const badgeSave = q<HTMLSpanElement>("#badgeSave");
  const stateLine = q<HTMLDivElement>("#stateLine");

  const ringBox = q<HTMLDivElement>("#ringBox");
  const ringProg = q<SVGCircleElement>("#ringProg");
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

  const refVol = q<HTMLInputElement>("#refVol");
  const micSens = q<HTMLInputElement>("#micSens");
  const micMeta = q<HTMLDivElement>("#micMeta");

  // theme
  btnTheme.onclick = () => {
    const t = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
    applyTheme(t);
  };

  // audio apply
  const applyAudioSettings = () => {
    engine.setReferenceVolume((Number(refVol.value) / 100) * 0.60);
    engine.setMicSensitivity(Number(micSens.value) / 100);
  };
  refVol.oninput = () => { saveNum("vtp_refVol", Number(refVol.value)); applyAudioSettings(); };
  micSens.oninput = () => { saveNum("vtp_micSens", Number(micSens.value)); applyAudioSettings(); };
  applyAudioSettings();

  // tol %
  tolPctSlider.oninput = () => {
    tolPct = clamp(Number(tolPctSlider.value), 0.5, 3.0);
    localStorage.setItem("vtp_tolPct", String(tolPct));
    tolMeta.textContent = `±${tolPct.toFixed(1)}%`;
  };

  // modes
  const renderTrainMode = () => {
    modeAssistBtn.classList.toggle("primary", trainMode === "assist");
    modeChallengeBtn.classList.toggle("primary", trainMode === "challenge");
    modeMeta.textContent = trainMode === "assist" ? "Assist: REF toggle" : "Challenge: REF short + TRY";
  };
  modeAssistBtn.onclick = () => { trainMode = "assist"; localStorage.setItem("vtp_trainMode", "assist"); renderTrainMode(); };
  modeChallengeBtn.onclick = () => { trainMode = "challenge"; localStorage.setItem("vtp_trainMode", "challenge"); renderTrainMode(); };
  renderTrainMode();

  const renderRingMode = () => {
    ringLiveBtn.classList.toggle("primary", ringMode === "live");
    ringScoreBtn.classList.toggle("primary", ringMode === "score");
    ringMeta.textContent = ringMode === "live" ? "Live: быстрее" : "Score: сглажено";
  };
  ringLiveBtn.onclick = () => { ringMode = "live"; localStorage.setItem("vtp_ringMode", "live"); win = []; hzDisp = null; ratioDisp = null; renderRingMode(); };
  ringScoreBtn.onclick = () => { ringMode = "score"; localStorage.setItem("vtp_ringMode", "score"); win = []; hzDisp = null; ratioDisp = null; renderRingMode(); };
  renderRingMode();

  // note selects
  const OCT = [2, 3, 4, 5];
  selNote.innerHTML = NOTE_NAMES.map(n => `<option value="${n}">${n}</option>`).join("");
  selOct.innerHTML = OCT.map(o => `<option value="${o}">${o}</option>`).join("");

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

    win = [];
    hzDisp = null;
    ratioDisp = null;
    ringFill = 0;
    inTuneMs = 0;
  };

  setTargetMidi(targetMidi, false);
  selNote.onchange = () => setTargetMidi(noteOctToMidi(selNote.value, Number(selOct.value)), true);
  selOct.onchange = () => setTargetMidi(noteOctToMidi(selNote.value, Number(selOct.value)), true);

  bindUserGesture(btnPlayTarget, () => {
    applyAudioSettings();
    engine.playReference(targetHz, 1.0);
  });

  // visuals
  const setMarkerCents = (cents: number | null) => {
    if (cents === null) { marker.style.opacity = "0"; marker.style.left = "50%"; return; }
    const c = clamp(cents, -BAR_RANGE, BAR_RANGE);
    const t = (c + BAR_RANGE) / (2 * BAR_RANGE);
    marker.style.opacity = "1";
    marker.style.left = `${t * 100}%`;
  };

  const setRing = (fill01: number, errPct: number | null) => {
    const CIRC = 263.89;
    ringProg.setAttribute("stroke-dashoffset", String(CIRC * (1 - clamp(fill01, 0, 1))));
    if (errPct === null) ringProg.setAttribute("stroke", "rgba(255,255,255,.25)");
    else if (Math.abs(errPct) <= tolPct) ringProg.setAttribute("stroke", "rgba(52,211,153,.95)");
    else if (errPct > 0) ringProg.setAttribute("stroke", "rgba(251,113,133,.95)");
    else ringProg.setAttribute("stroke", "rgba(96,165,250,.95)");
  };

  const flashSuccess = () => {
    ringBox.classList.add("flash");
    setTimeout(() => ringBox.classList.remove("flash"), 180);
  };

  const updateUI = () => {
    const now = performance.now();
    const n = midiToNote(targetMidi);

    btnMic.classList.toggle("on-mic", running && engine.isMicReady());
    btnRef.classList.toggle("on-ref", engine.isReferencePlaying());
    tipPhones.style.display = (trainMode === "assist" && engine.isReferencePlaying()) ? "block" : "none";

    stateLine.textContent =
      `MIC: ${(running && engine.isMicReady()) ? "on" : "off"} • ` +
      `REF: ${engine.isReferencePlaying() ? "on" : "off"} • ` +
      `MODE: ${trainMode.toUpperCase()} • RING: ${ringMode.toUpperCase()} • ±${tolPct.toFixed(1)}%`;

    micMeta.textContent = `rms: ${lastFrame.rms.toFixed(3)} • clarity: ${(lastFrame.rms >= RMS_MIN ? lastFrame.clarity : 0).toFixed(2)}`;

    if (!running || !engine.isMicReady()) {
      badgeState.textContent = "Status: idle";
      hzBig.textContent = "— Hz";
      delta.textContent = "—%";
      targetLine.textContent = `Нота ${n.ru} (${n.name}${n.octave}) • ${targetHz.toFixed(1)} Hz`;
      if (now >= hintLockUntil) setHint("Нажмите REF для эталона или MIC для микрофона.");
      setMarkerCents(null);
      setRing(ringFill, null);
      return;
    }

    badgeState.textContent = attemptActive ? "Status: attempt" : "Status: listening";

    if (hzDisp === null || ratioDisp === null) {
      hzBig.textContent = "— Hz";
      delta.textContent = "—%";
      targetLine.textContent = `Нота ${n.ru} (${n.name}${n.octave}) • ${targetHz.toFixed(1)} Hz`;
      if (now >= hintLockUntil) setHint("Нет стабильного тона. Пойте протяжнее.");
      setMarkerCents(null);
      setRing(ringFill, null);
      return;
    }

    const pct = ratioDisp * 100;
    const errPct = (ratioDisp - 1) * 100;

    hzBig.textContent = `${hzDisp.toFixed(1)} Hz`;
    delta.textContent = `${pct.toFixed(1)}%`;
    targetLine.textContent = `Нота ${n.ru} (${n.name}${n.octave}) • ${targetHz.toFixed(1)} Hz • Δ ${errPct.toFixed(2)}%`;

    if (now >= hintLockUntil) {
      if (Math.abs(errPct) <= tolPct) setHint("В зелёной зоне. Отлично!");
      else if (errPct > 0) setHint("Выше цели — опуститесь.");
      else setHint("Ниже цели — поднимитесь.");
    }

    setMarkerCents(lastFrame.cents);
    setRing(ringFill, errPct);
  };

  const rafLoop = () => {
    if (!running) return;

    const fr = engine.frame(targetHz);
    const now = performance.now();

    // EQ (always)
    const spec = engine.getSpectrumBars(18);
    for (let i = 0; i < 18; i++) {
      eqVals[i] = eqVals[i] * 0.75 + spec[i] * 0.25;
      const h = 6 + Math.round(eqVals[i] * 48);
      eqBars[i].style.height = `${h}px`;
    }

    // gating
    const pitchOk = fr.hz !== null && fr.hz >= MIN_HZ && fr.hz <= MAX_HZ;
    const hasPitch =
      fr.hz !== null && fr.cents !== null &&
      pitchOk &&
      fr.clarity >= CLARITY_ON &&
      fr.rms >= RMS_MIN &&
      !engine.isMicMuted();

    // sampling @ ~20fps
    if (now - lastSampleTs >= SAMPLE_MS) {
      lastSampleTs = now;

      // window update
      const winMs = getWindowMs();
      win = win.filter(s => now - s.t <= winMs);

      if (hasPitch) {
        const ratio = fr.hz! / targetHz;
        const errPct = (ratio - 1) * 100;
        win.push({ t: now, hz: fr.hz!, ratio, errPct, cents: fr.cents! });
      }

      if (win.length >= 6) {
        // robust filter via MAD on cents
        const centsArr = win.map(s => s.cents);
        const medC = median(centsArr)!;
        const m = mad(centsArr, medC);
        const thr = Math.max(3 * m, 20); // vibrato-friendly minimum

        const filtered = win.filter(s => Math.abs(s.cents - medC) <= thr);
        const base = filtered.length >= 4 ? filtered : win;

        const medHz = median(base.map(s => s.hz))!;
        const medRatio = median(base.map(s => s.ratio))!;
        const medErrPct = median(base.map(s => s.errPct))!;

        const a = getAlpha();
        hzDisp = ema(hzDisp, medHz, a);
        ratioDisp = ema(ratioDisp, medRatio, a);

        // ring fill = percent/100, cap 0..1 (если >100% — будет красная подсветка)
        const fillTarget = clamp(ratioDisp!, 0, 1);
        ringFill = ema(ringFill, fillTarget, getRingAlpha());

        // success detection in green zone
        if (Math.abs(medErrPct) <= tolPct) inTuneMs += SAMPLE_MS;
        else inTuneMs = Math.max(0, inTuneMs - SAMPLE_MS * 2);

        if (inTuneMs >= SUCCESS_HOLD && (now - lastSuccessAt) > SUCCESS_COOLDOWN) {
          lastSuccessAt = now;
          engine.playSuccessBeep();
          flashSuccess();
        }
      } else {
        ringFill *= 0.92;
        hzDisp = null;
        ratioDisp = null;
        inTuneMs = 0;
      }

      lastFrame = { hz: fr.hz, cents: fr.cents, clarity: fr.clarity, rms: fr.rms };
    }

    // attempt scoring (raw cents, tolerant)
    if (attemptActive) {
      if (hasPitch) {
        attemptValid += 1;
        const absC = Math.abs(fr.cents!);
        attemptAbsCents.push(absC);
        attemptClaritySum += fr.clarity;
        if (absC <= TOL_SCORE_CENTS) attemptGood += 1;
      }
      if (now - attemptStart >= HOLD_MS) {
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
            confidence_mean: attemptValid ? (attemptClaritySum / attemptValid) : null,
            duration_ms: HOLD_MS
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
      applyAudioSettings();
      badgeSave.textContent = "Save: —";
      setHint(trainMode === "assist" ? "Assist: включите REF и подстраивайтесь." : "Challenge: REF short + TRY.", 2500);
      requestAnimationFrame(rafLoop);
      return true;
    } catch (e) {
      setHint(`Ошибка микрофона: ${String(e)}`, 7000);
      return false;
    }
  }

  // MIC toggle
  btnMic.onclick = async () => {
    if (running && engine.isMicReady()) {
      running = false;
      engine.stopReference();
      engine.stopMic();
      setHint("MIC выключен.", 1200);
      return;
    }
    await ensureMicOn();
  };

  // REF stable (debounced)
  bindUserGesture(btnRef, () => {
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

  // TRY auto-enables MIC
  btnTry.onclick = async () => {
    const ok = await ensureMicOn();
    if (!ok) return;
    if (attemptActive) return;

    if (trainMode === "challenge" && engine.isReferencePlaying()) engine.stopReference();

    attemptActive = true;
    attemptStart = performance.now();
    attemptValid = 0;
    attemptGood = 0;
    attemptAbsCents = [];
    attemptClaritySum = 0;

    badgeSave.textContent = "Save: —";
    setHint("Попытка началась: удерживайте ноту 2.5 сек.", 2000);
  };

  setInterval(updateUI, 140);
} catch (e) {
  showCrash("BOOT ERROR:", e);
}
