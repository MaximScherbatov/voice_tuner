export type Frame = {
  hz: number | null;
  clarity: number;
  cents: number | null;
  rms: number;
};

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function centsDeviation(actualHz: number, targetHz: number): number {
  return 1200 * Math.log2(actualHz / targetHz);
}

function computeRms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// dynamic import to avoid killing the app at boot
let PitchDetector: any = null;

async function ensurePitchyLoaded() {
  if (PitchDetector) return;
  const mod: any = await import("pitchy");
  PitchDetector = mod.PitchDetector;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;

  // mic
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;

  private analyser: AnalyserNode | null = null;
  private data: Float32Array | null = null;
  private detector: any = null;

  private inputGain: GainNode | null = null;

  // PATCH D: pre-analysis filters/comp (stability)
  private hp: BiquadFilterNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private comp: DynamicsCompressorNode | null = null;

  // spectrum
  private freqData: Uint8Array | null = null;

  // output + reference
  private refVolume = 0.18; // 0..1
  private outGain: GainNode | null = null;

  // reference synth (multiple oscs)
  private refOscs: OscillatorNode[] = [];
  private refGain: GainNode | null = null;

  /** Keep synchronous to stay inside user gesture chain */
  ensureContextUnlockedSync() {
    if (!this.ctx) {
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;

      // PATCH E: latencyHint
      this.ctx = new AudioCtx({ latencyHint: "interactive" });
    }

    if (this.ctx.state !== "running") {
      try {
        this.ctx.resume();
      } catch {}
    }

    if (!this.outGain) {
      this.outGain = this.ctx.createGain();
      this.outGain.gain.value = 1.0;
      this.outGain.connect(this.ctx.destination);
    }
  }

  async initMic(deviceId?: string) {
    this.ensureContextUnlockedSync();
    await ensurePitchyLoaded();
    this.stopMic();

    // PATCH A: prefer RAW mic (no EC/NS/AGC) + advanced(Chromium) + fallback
    const rawConstraints: any = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,

      channelCount: 1,
      sampleRate: 48000,
      sampleSize: 16,

      advanced: [
        { echoCancellation: false },
        { noiseSuppression: false },
        { autoGainControl: false },

        // Chromium-specific (ignored where unsupported)
        { googEchoCancellation: false },
        { googEchoCancellation2: false },
        { googAutoGainControl: false },
        { googNoiseSuppression: false },
        { googHighpassFilter: false },
        { googTypingNoiseDetection: false },
        { googAudioMirroring: false },
      ],
    };

    if (deviceId) rawConstraints.deviceId = { exact: deviceId };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: rawConstraints });
    } catch (e) {
      // fallback (for devices/browsers that reject raw constraints)
      const safeFallback: any = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      };
      if (deviceId) safeFallback.deviceId = { exact: deviceId };
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: safeFallback });
    }

    this.micTrack = this.micStream.getAudioTracks()[0] ?? null;

    // one-time debug: what browser actually applied
    try {
      // eslint-disable-next-line no-console
      console.debug("[mic settings]", this.micTrack?.getSettings(), this.micTrack?.getConstraints());
    } catch {}

    const src = this.ctx!.createMediaStreamSource(this.micStream);

    this.inputGain = this.ctx!.createGain();
    this.inputGain.gain.value = 1.0;

    // PATCH D: filters + compressor before analyser (do NOT connect to destination)
    this.hp = this.ctx!.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = 60;
    this.hp.Q.value = 0.707;

    this.lp = this.ctx!.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 4200;
    this.lp.Q.value = 0.707;

    this.comp = this.ctx!.createDynamicsCompressor();
    this.comp.threshold.value = -30;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 2.5;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.12;

    this.analyser = this.ctx!.createAnalyser();

    // PATCH B: bigger buffer for more stable pitch (esp. lower notes)
    this.analyser.fftSize = 8192;

    this.analyser.smoothingTimeConstant = 0.7;

    // wiring: src -> hp -> lp -> comp -> inputGain -> analyser
    src.connect(this.hp);
    this.hp.connect(this.lp);
    this.lp.connect(this.comp);
    this.comp.connect(this.inputGain);
    this.inputGain.connect(this.analyser);

    const bufLen = this.analyser.fftSize;
    this.data = new Float32Array(bufLen);
    this.detector = PitchDetector.forFloat32Array(bufLen);

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  stopMic() {
    try {
      this.micStream?.getTracks().forEach((t) => t.stop());
    } catch {}

    // best-effort disconnect graph
    try {
      this.hp?.disconnect();
      this.lp?.disconnect();
      this.comp?.disconnect();
      this.inputGain?.disconnect();
      this.analyser?.disconnect();
    } catch {}

    this.micStream = null;
    this.micTrack = null;

    this.analyser = null;
    this.data = null;
    this.detector = null;

    this.inputGain = null;

    this.hp = null;
    this.lp = null;
    this.comp = null;

    this.freqData = null;
  }

  setMicSensitivity(value: number) {
    if (this.inputGain) this.inputGain.gain.value = Math.max(0.1, Math.min(5, value));
  }

  muteMic(muted: boolean) {
    if (this.micTrack) this.micTrack.enabled = !muted;
  }

  isMicMuted(): boolean {
    return this.micTrack ? !this.micTrack.enabled : false;
  }

  isMicReady(): boolean {
    return !!this.analyser && !!this.data && !!this.detector && !!this.ctx;
  }

  setReferenceVolume(value01: number) {
    this.refVolume = Math.max(0, Math.min(1, value01));
    if (this.refGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.refGain.gain.cancelScheduledValues(now);
      this.refGain.gain.setValueAtTime(this.refGain.gain.value, now);
      this.refGain.gain.linearRampToValueAtTime(this.refVolume, now + 0.03);
    }
  }

  /** Continuous reference (Assist), with harmonics to be audible on phone speakers */
  startReference(targetHz: number) {
    this.ensureContextUnlockedSync();
    if (!this.ctx || !this.outGain) throw new Error("AudioContext not initialized");

    // if running -> just retune
    if (this.refOscs.length) {
      const base = targetHz;
      const freqs = [base, base * 2, base * 3];
      for (let i = 0; i < this.refOscs.length; i++) {
        this.refOscs[i].frequency.setValueAtTime(freqs[i] ?? base, this.ctx.currentTime);
      }
      return;
    }

    this.refGain = this.ctx.createGain();
    const now = this.ctx.currentTime;

    // fade in
    this.refGain.gain.setValueAtTime(0.0001, now);
    this.refGain.gain.linearRampToValueAtTime(this.refVolume, now + 0.03);

    // fundamental + harmonics (quiet)
    const freqs = [targetHz, targetHz * 2, targetHz * 3];
    const gains = [1.0, 0.35, 0.18];

    for (let i = 0; i < freqs.length; i++) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();

      o.type = "sine";
      o.frequency.value = freqs[i];

      // per-osc gain; overall volume controlled by refGain
      g.gain.value = gains[i];

      o.connect(g);
      g.connect(this.refGain);
      o.start(now);

      this.refOscs.push(o);
    }

    this.refGain.connect(this.outGain);
  }

  stopReference() {
    if (!this.ctx || !this.refGain || !this.refOscs.length) return;

    const now = this.ctx.currentTime;
    const g = this.refGain;
    const oscs = this.refOscs.slice();

    this.refOscs = [];
    this.refGain = null;

    try {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0.0001, now + 0.05);
      for (const o of oscs) o.stop(now + 0.06);
    } catch {
      for (const o of oscs) {
        try {
          o.stop();
        } catch {}
      }
    }
  }

  isReferencePlaying() {
    return this.refOscs.length > 0;
  }

  /** One-shot reference (Challenge) */
  playReference(targetHz: number, seconds = 1.1) {
    this.startReference(targetHz);
    setTimeout(() => this.stopReference(), Math.max(100, seconds * 1000));
  }

  /** Short success beep */
  playSuccessBeep() {
    this.ensureContextUnlockedSync();
    if (!this.ctx || !this.outGain) return;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.value = 1320;

    const now = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.12, now + 0.01);
    g.gain.linearRampToValueAtTime(0.0001, now + 0.11);

    osc.connect(g);
    g.connect(this.outGain);

    osc.start(now);
    osc.stop(now + 0.13);
  }

  frame(targetHz: number): Frame {
    if (!this.analyser || !this.data || !this.detector || !this.ctx) {
      return { hz: null, clarity: 0, cents: null, rms: 0 };
    }

    this.analyser.getFloatTimeDomainData(this.data);

    // PATCH C: remove DC offset (helps pitch stability)
    let mean = 0;
    for (let i = 0; i < this.data.length; i++) mean += this.data[i];
    mean /= this.data.length;
    for (let i = 0; i < this.data.length; i++) this.data[i] -= mean;

    const rms = computeRms(this.data);

    const [pitch, clarity] = this.detector.findPitch(this.data, this.ctx.sampleRate);

    // PATCH C: robust pitch check
    if (!Number.isFinite(pitch) || pitch <= 0) {
      return { hz: null, clarity, cents: null, rms };
    }

    const cents = centsDeviation(pitch, targetHz);
    return { hz: pitch, clarity, cents, rms };
  }

  getSpectrumBars(nBars = 18): number[] {
    if (!this.analyser || !this.freqData) return Array(nBars).fill(0);

    this.analyser.getByteFrequencyData(this.freqData);

    const bins = this.freqData.length;
    const maxIdx = Math.floor(bins * 0.35); // low-mid focus

    const out: number[] = [];
    for (let i = 0; i < nBars; i++) {
      const t = i / Math.max(1, nBars - 1);
      const idx = Math.floor(Math.pow(t, 2.0) * maxIdx);
      out.push((this.freqData[idx] ?? 0) / 255);
    }

    return out;
  }
}