/* 
 * Ultrasound-based ECG Monitor - Web Version
 *
 * 1. FFT on microphone input
 * 2. Find strongest bin in ultrasound band
 * 3. Map frequency -> normalized ECG-like signal
 * 4. Band-pass filter
 * 5. Display + HR / HRV
 */

// ============================================================================
// DOM ELEMENTS
// ============================================================================
const startButton      = document.getElementById('startButton');
const stopButton       = document.getElementById('stopButton');
const recordButton     = document.getElementById('record30Button');

const heartRateSpan    = document.getElementById('heartRate');
const peakLevelSpan    = document.getElementById('peakLevel');
const peakFreqSpan     = document.getElementById('peakFreq');   // optional
const snrSpan          = document.getElementById('snr');
const sampleRateSpan   = document.getElementById('sampleRate'); // optional
const hrvSpan          = document.getElementById('hrv');

function resolveHrvSpan() {
  // Preferred: <span id="hrv">
  if (hrvSpan) return hrvSpan;

  // Fallback: find the metric card whose label contains 'HRV' and use its value span.
  const cards = document.querySelectorAll('.metric');
  for (const card of cards) {
    const label = card.querySelector('.label');
    if (!label) continue;
    const txt = (label.textContent || '').toLowerCase();
    if (!txt.includes('hrv')) continue;

    // Expected structure: <span class="value"><span>--</span> ms</span>
    const valueSpan = card.querySelector('.value span');
    if (valueSpan) return valueSpan;
  }
  return null;
}

const beatCountSpan    = document.getElementById('beatCount');
const statusText       = document.getElementById('statusText');
const gridInfoSpan     = document.getElementById('gridInfo');

const ultraStartInput  = document.getElementById('ultraStart');
const ultraEndInput    = document.getElementById('ultraEnd');
const signalHPInput    = document.getElementById('signalHighPass');
const signalLPInput    = document.getElementById('signalLowPass');
const invertSignalInput = document.getElementById('invertSignal'); 

const canvas           = document.getElementById('ecgCanvas');
const ctx              = canvas.getContext('2d');

const snapshotSection  = document.getElementById('snapshotSection');
const snapshotImage    = document.getElementById('snapshotImage');
const csvDownloadLink  = document.getElementById('csvDownloadLink'); // <a> for CSV download

if (gridInfoSpan) {
  gridInfoSpan.textContent = '0.5 s per big square';
}

// ============================================================================
// GRID CANVAS (background)
// ============================================================================
const gridCanvas = document.createElement('canvas');
const gridCtx    = gridCanvas.getContext('2d');

const SMALL_GRID_PX = 5;
const BIG_GRID_PX   = 25;

function drawGrid(width, height) {
  gridCtx.clearRect(0, 0, width, height);
  gridCtx.fillStyle = '#020617';
  gridCtx.fillRect(0, 0, width, height);

  // small grid
  gridCtx.lineWidth = 1;
  gridCtx.strokeStyle = 'rgba(148, 163, 184, 0.17)';
  gridCtx.beginPath();
  for (let x = 0; x <= width; x += SMALL_GRID_PX) {
    gridCtx.moveTo(x + 0.5, 0);
    gridCtx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += SMALL_GRID_PX) {
    gridCtx.moveTo(0, y + 0.5);
    gridCtx.lineTo(width, y + 0.5);
  }
  gridCtx.stroke();

  // big grid
  gridCtx.lineWidth = 1.5;
  gridCtx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
  gridCtx.beginPath();
  for (let x = 0; x <= width; x += BIG_GRID_PX) {
    gridCtx.moveTo(x + 0.5, 0);
    gridCtx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += BIG_GRID_PX) {
    gridCtx.moveTo(0, y + 0.5);
    gridCtx.lineTo(width, y + 0.5);
  }
  gridCtx.stroke();
}

// ============================================================================
// AUDIO / DSP STATE
// ============================================================================
let audioCtx   = null;
let stream     = null;
let sourceNode = null;
let analyser   = null;
let freqData   = null;

const DISPLAY_DURATION = 3.0;      // seconds visible in live window
const PROCESS_RATE     = 200;      // Hz
const MAX_SAMPLES      = 5000;

let signalBuffer = [];
let timeBuffer   = [];

// band-pass filter state
const FILTER_DT = 1 / PROCESS_RATE;
let hpPrevIn  = 0;
let hpPrevOut = 0;
let lpPrevOut = 0;

// app state
let running           = false;
let processIntervalId = null;
let renderFrameId     = null;

// metrics accumulation
let metricMagnitudeSum = 0;
let metricFreqSum      = 0;
let metricSnrSum       = 0;
let metricCount        = 0;
let lastMetricTime     = 0;
let lastSnr            = -Infinity;

// ============================================================================
// SCREEN WAKE LOCK
// ============================================================================
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    console.error('Wake Lock error:', err);
  }
}

async function releaseWakeLock() {
  try {
    if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    console.error('Wake Lock release error:', err);
  }
}

// ============================================================================
// 30-SECOND RECORDING STATE
// ============================================================================
const RECORD_DURATION_SEC = 30;

let recordingActive    = false;   // true while the 30 s window is running
let preRecordingActive = false;
let preRecordMode      = null;    // null | 'ACQUIRE' | 'COUNTDOWN'
let recordPrepToken    = 0;       // increments to cancel pending preparation
   // true during the 3 s "get ready" delay
let recordStartTime    = null;
let recordStartDate    = null;    // wall-clock start date/time for CSV & header
let recordSignal       = [];
let recordTime         = [];
let recordPeakTimes    = [];
let recordTimeoutId    = null;
let recordCountdownInterval = null;
let preCountdownInterval    = null;

// Filter settings used for the current 30 s recording
let recordUltraStart = null;
let recordUltraEnd   = null;
let recordHpFreq     = null;
let recordLpFreq     = null;
let recordInvertSignal = false;

// CSV download URL (so we can revoke old blobs)
let csvDownloadUrl = null;

// ============================================================================
// HR / HRV DETECTION STATE (Pan-Tompkins style, matches Python benchmark)
// ============================================================================
//
// Pipeline (200 Hz processing):
// 1) QRS bandpass (approx 5–15 Hz)  -> y
// 2) 5-point derivative (non-causal, implemented with 2-sample delay) -> d
// 3) square -> s
// 4) moving-window integration (150 ms) -> mwi
// 5) local-max peak picking on mwi + adaptive threshold + 250 ms refractory
// 6) refine to true R peak: max(|y|) within ±80 ms around the mwi peak
//
// Note: In Python we used filtfilt (zero-phase). In the browser we run causal
// filters and compensate timing by the refinement step (small fixed delay).

const detectedPeaks    = [];
const MAX_HEART_RATE   = 200;
const MIN_HEART_RATE   = 30;
const BEAT_COUNTER_WINDOW_SEC = 600;  // beats in the last 600 s
const MAX_PEAK_HISTORY       = 6000;  // enough for up to ~6000 peaks



// --- Pan-Tompkins auto (re)training state machine -------------------------
// We only train thresholds once the ultrasound carrier is stable.
// If stability is lost for a moment, we pause and retrain.
const PT_STABLE_SNR_DB       = 12;   // SNR (dB) required to consider the signal "stable"
const PT_STABLE_HOLD_SEC     = 1.0;  // must be stable for this long before training starts
const PT_LOST_HOLD_SEC       = 0.7;  // unstable this long -> retrain
const PT_STATUS_NOTICE_SEC   = 2.0;  // show transient notices this long
const PT_SNR_EMA_ALPHA       = 0.12; // smoothing for stability decision (0..1)
const HR_SMOOTH = 0.2;
let displayBpm  = null;
let lastPeakTime = 0;

// --- Minimal biquad (Direct Form II transposed) -----------------------------
class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
    this.z1 = 0;  this.z2 = 0;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// RBJ-style bandpass biquad. For QRS band we use f0 = sqrt(f1*f2), Q = f0/(f2-f1).
function makeBandpassBiquad(f1, f2, fs) {
  const f0 = Math.sqrt(Math.max(1e-9, f1 * f2));
  const bw = Math.max(1e-6, (f2 - f1));
  const Q = Math.max(0.1, f0 / bw);

  const w0 = 2 * Math.PI * (f0 / fs);
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  // constant skirt gain, peak gain = Q
  let b0 =  alpha;
  let b1 =  0;
  let b2 = -alpha;
  let a0 =  1 + alpha;
  let a1 = -2 * cosw0;
  let a2 =  1 - alpha;

  // normalize so a0 = 1
  b0 /= a0; b1 /= a0; b2 /= a0;
  a1 /= a0; a2 /= a0;

  return new Biquad(b0, b1, b2, a1, a2);
}

// --- Pan-Tompkins detector --------------------------------------------------
class PanTompkinsDetector {
  constructor(fs) {
    this.fs = fs;
    this.warmupSec = 0.5; // ignore first 0.5 s to let filters/DC settle
    this.reset();
  }

  reset() {
    // QRS bandpass (5–15 Hz)
    this.bp = makeBandpassBiquad(5, 15, this.fs);
    if (this.bp && this.bp.reset) this.bp.reset();

    // buffers (small, bounded)
    this.y = [];   // QRS-band samples
    this.t = [];   // timestamps (audioCtx.currentTime)
    this.maxKeep = Math.ceil(this.fs * 3.0); // keep ~3 s for refinement

    // derivative/squared/mwi
    this.win = Math.max(1, Math.round(0.150 * this.fs)); // 150 ms
    this.sqQueue = [];
    this.sqSum = 0;

    // mwi peak detection
    this.mwiHist = []; // last 3 {t, v}
    this.lastAcceptedCandTime = -1e9;

    // adaptive threshold init (first 2 s)
    this.startTime = null;
    this.initDone = false;

    // warmup phase to avoid startup transients (filt + DC step)
    this.warmupUntil = null;
    // baseline tracker (approx median/DC removal)
    this.dc = 0;
    this.dcAlpha = (1 / this.fs) / (0.75 + (1 / this.fs)); // ~0.75 s time constant
    this.initCandVals = [];
    this.initMwiVals = [];
    this.spki = 0;
    this.npki = 0;
    this.thr = 0;

    // refinement queue
    this.pending = []; // {centerTime, finalizeAt}
    this.lastEmittedTime = -1e9;
  }

  _pushY(y, time) {
    this.y.push(y);
    this.t.push(time);
    if (this.y.length > this.maxKeep) {
      this.y.shift();
      this.t.shift();
    }
  }

  _percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const idx = (p / 100) * (a.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    const frac = idx - lo;
    return a[lo] * (1 - frac) + a[hi] * frac;
  }

  _median(arr) { return this._percentile(arr, 50); }

  _maybeInitThresholds(nowTime) {
    if (this.initDone || this.startTime === null) return;
    if (nowTime - this.startTime < 2.0) return;

    // Use candidate peak values if we have them, else fall back to general mwi stats.
        const baseRaw = (this.initCandVals.length > 0) ? this.initCandVals : this.initMwiVals;
    // Trim extreme outliers (startup transients) so they don't set the threshold too high.
    let base = baseRaw;
    if (baseRaw.length >= 30) {
      const p99 = this._percentile(baseRaw, 99);
      const trimmed = baseRaw.filter(v => v <= p99);
      if (trimmed.length >= 10) base = trimmed;
    }
    if (base.length === 0) {
      this.spki = 0;
      this.npki = 0;
      this.thr = 0;
      this.initDone = true;
      return;
    }

    this.spki = this._percentile(base, 90);
    this.npki = this._percentile(base, 10);
    this.thr = this.npki + 0.25 * (this.spki - this.npki);
    this.initDone = true;
  }

  _refinePeak(centerTime) {
    const half = 0.080; // ±80 ms
    const t0 = centerTime - half;
    const t1 = centerTime + half;

    let bestIdx = -1;
    let bestAbs = -Infinity;

    // scan the (small) kept window
    for (let i = 0; i < this.y.length; i++) {
      const ti = this.t[i];
      if (ti < t0 || ti > t1) continue;
      const ai = Math.abs(this.y[i]);
      if (ai > bestAbs) {
        bestAbs = ai;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) return centerTime;
    return this.t[bestIdx];
  }

  /**
   * Process one new sample.
   * Returns an array of refined R-peak times (can be empty).
   */
  process(sample, time) {
    // Warmup: avoid startup transients from step-DC and IIR settling.
    if (this.warmupUntil === null) {
      this.warmupUntil = time + this.warmupSec;
      this.dc = sample; // start DC tracker at first value to avoid step
    }
    if (time < this.warmupUntil) {
      // still update filter/DC state, but do not detect peaks
      this.dc = this.dc + this.dcAlpha * (sample - this.dc);
      const xw = sample - this.dc;
      const yw = this.bp.process(xw);
      this._pushY(yw, time);
      return [];
    }
    // Start 2-second threshold learning window AFTER warmup.
    if (this.startTime === null) {
      this.startTime = time;
      this.initDone = false;
      this.initCandVals = [];
      this.initMwiVals = [];
      this.mwiHist = [];
      this.sqQueue = [];
      this.sqSum = 0;
      this.pending = [];
      this.lastAcceptedCandTime = -1e9;
      this.lastEmittedTime = -1e9;
    }

    // center the normalized signal (roughly remove DC like Python's median subtraction)
    // Track slow baseline and subtract (robust vs the invert + 1 shift)
    this.dc = this.dc + this.dcAlpha * (sample - this.dc);
    const x0 = sample - this.dc;

    // QRS band
    const y = this.bp.process(x0);
    this._pushY(y, time);

    // Need at least 5 samples to compute derivative at center (2-sample delay).
    if (this.y.length < 5) {
      this._flushPending(time);
      return [];
    }

    const n = this.y.length;

    // derivative for center sample (index n-3) using [1,2,0,-2,-1] over [n-5..n-1]
    const d = (this.y[n - 5] * 1) + (this.y[n - 4] * 2) + (this.y[n - 3] * 0) +
              (this.y[n - 2] * -2) + (this.y[n - 1] * -1);
    const dTime = this.t[n - 3];

    // square
    const sq = d * d;

    // moving window integration (causal over last win squared values)
    this.sqQueue.push(sq);
    this.sqSum += sq;
    if (this.sqQueue.length > this.win) {
      this.sqSum -= this.sqQueue.shift();
    }
    const mwi = this.sqSum / this.win;

    // collect init stats
    this.initMwiVals.push(mwi);
    if (this.initMwiVals.length > this.win * 40) this.initMwiVals.shift(); // bound memory

    // local maxima detection on mwi (need 3 points)
    this.mwiHist.push({ t: dTime, v: mwi });
    if (this.mwiHist.length > 3) this.mwiHist.shift();

    // try to initialize thresholds after 2 seconds
    this._maybeInitThresholds(time);

    if (this.mwiHist.length === 3) {
      const a = this.mwiHist[0];
      const b = this.mwiHist[1];
      const c = this.mwiHist[2];

      const isLocalMax = (b.v > a.v) && (b.v > c.v);
      if (isLocalMax) {
        if (!this.initDone) {
          // gather candidate peaks for percentile init
          this.initCandVals.push(b.v);
          if (this.initCandVals.length > 200) this.initCandVals.shift();
        } else {
          this._handleCandidatePeak(b.t, b.v);
        }
      }
    }

    // finalize any pending refinements once we have enough future samples
    return this._flushPending(time);
  }

  _handleCandidatePeak(candTime, candVal) {
    const refractory = 0.250;

    // mimic Python: if within refractory of last accepted candidate, ignore
    if (candTime - this.lastAcceptedCandTime < refractory) return;

    const pk = candVal;

    if (pk > this.thr) {
      // accept
      this.lastAcceptedCandTime = candTime;
      this.spki = 0.125 * pk + 0.875 * this.spki;

      // schedule refinement when we have +80 ms future context
      this.pending.push({ centerTime: candTime, finalizeAt: candTime + 0.080 });
    } else {
      // noise
      this.npki = 0.125 * pk + 0.875 * this.npki;
    }

    // update threshold
    this.thr = this.npki + 0.25 * (this.spki - this.npki);
  }

  _flushPending(nowTime) {
    if (this.pending.length === 0) return [];
    const out = [];

    // finalize any peaks whose finalizeAt has passed
    const keep = [];
    for (const p of this.pending) {
      if (nowTime >= p.finalizeAt) {
        const refinedTime = this._refinePeak(p.centerTime);

        // avoid duplicates if refinement shifts peaks very close
        if (refinedTime - this.lastEmittedTime >= 0.200) {
          out.push(refinedTime);
          this.lastEmittedTime = refinedTime;
        }
      } else {
        keep.push(p);
      }
    }
    this.pending = keep;
    return out;
  }
}

let ptDetector = new PanTompkinsDetector(PROCESS_RATE);

// PT training phases:
// - WAIT_STABLE: wait until SNR is stable for PT_STABLE_HOLD_SEC
// - TRAINING: warmup + learn thresholds for ~2 s
// - RUNNING: peak detection active
let ptPhase = 'WAIT_STABLE';
let ptStableSince = null;
let ptUnstableSince = null;
let ptNotice = null;
let ptNoticeUntil = 0;
let ptSnrEma = -Infinity;

function ptSetNotice(msg, nowTime) {
  ptNotice = msg;
  ptNoticeUntil = nowTime + PT_STATUS_NOTICE_SEC;
}

function resetPeakMetricsUI() {
  detectedPeaks.length = 0;
  displayBpm = null;
  lastPeakTime = 0;
  if (heartRateSpan) heartRateSpan.textContent = '--';
  if (hrvSpan)       hrvSpan.textContent       = '--';
  if (beatCountSpan) beatCountSpan.textContent = '--';
}


// ============================================================================
// CANVAS SETUP
// ============================================================================
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const displayWidth  = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  canvas.width  = Math.floor(displayWidth * dpr);
  canvas.height = Math.floor(displayHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  gridCanvas.width  = Math.floor(displayWidth);
  gridCanvas.height = Math.floor(displayHeight);
  drawGrid(gridCanvas.width, gridCanvas.height);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gridCanvas, 0, 0);
}

// ============================================================================
// START / STOP
// ============================================================================
async function startMonitoring() {
  if (running) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    updateStatus('Microphone not available');
    return;
  }

  startButton.disabled = true;
  stopButton.disabled  = false;
  if (recordButton) recordButton.disabled = false;
  updateStatus('Requesting microphone…');

  try {

    // RESET METRICS UI -------------------------------------------------------
    if (heartRateSpan)   heartRateSpan.textContent = '--';
    if (hrvSpan)         hrvSpan.textContent       = '--';
    if (peakLevelSpan)   peakLevelSpan.textContent = '--';
    if (peakFreqSpan)    peakFreqSpan.textContent  = '--';
    if (snrSpan)         snrSpan.textContent       = '--';
    if (beatCountSpan)   beatCountSpan.textContent = '--';
    // -----------------------------------------------------------------------

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    if (sampleRateSpan) sampleRateSpan.textContent = audioCtx.sampleRate.toString();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 }
      }
    });

    sourceNode = audioCtx.createMediaStreamSource(stream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;

    freqData = new Uint8Array(analyser.frequencyBinCount);
    sourceNode.connect(analyser);

    signalBuffer.length = 0;
    timeBuffer.length   = 0;

    hpPrevIn  = 0;
    hpPrevOut = 0;
    lpPrevOut = 0;

    // Pan-Tompkins detector reset (matches Python benchmark)


    if (typeof ptDetector !== 'undefined' && ptDetector) {


      ptDetector.reset();


    
ptPhase = 'WAIT_STABLE';
ptStableSince = null;
ptUnstableSince = null;
ptSnrEma = -Infinity;
ptSetNotice('Listening… waiting for stable signal.', audioCtx.currentTime);
resetPeakMetricsUI();
}


    lastPeakTime = 0;


    detectedPeaks.length = 0;


    displayBpm = null;

    metricMagnitudeSum = 0;
    metricFreqSum      = 0;
    metricSnrSum       = 0;
    metricCount        = 0;
    lastMetricTime     = audioCtx.currentTime;
    lastSnr            = -Infinity;

    running = true;
    updateStatus('Listening…');
    requestWakeLock();

    processIntervalId = setInterval(processSample, 1000 / PROCESS_RATE);
    renderFrameId     = requestAnimationFrame(renderLoop);

  } catch (err) {
    console.error(err);
    updateStatus('Failed to access microphone: ' + err.message);
    startButton.disabled = false;
    stopButton.disabled  = true;
    if (recordButton) recordButton.disabled = false;
    releaseWakeLock();
  }
}

function stopMonitoring() {
  if (!running && !preRecordingActive && !recordingActive) return;

  // Re-enable filter inputs
  setFilterInputsEnabled(true);

  running = false;
  recordingActive    = false;
  preRecordingActive = false;

  if (processIntervalId !== null) {
    clearInterval(processIntervalId);
    processIntervalId = null;
  }
  if (renderFrameId !== null) {
    cancelAnimationFrame(renderFrameId);
    renderFrameId = null;
  }

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  if (recordTimeoutId) {
    clearTimeout(recordTimeoutId);
    recordTimeoutId = null;
  }
  if (recordCountdownInterval) {
    clearInterval(recordCountdownInterval);
    recordCountdownInterval = null;
  }
  if (preCountdownInterval) {
    clearInterval(preCountdownInterval);
    preCountdownInterval = null;
  }

  if (recordButton) {
    recordButton.disabled = false;
    recordButton.textContent = 'Record 30 seconds';
  }

  //if (beatCountSpan) beatCountSpan.textContent = '--';  // <-- NEW

  releaseWakeLock();

  startButton.disabled = false;
  stopButton.disabled  = true;

  // keep waveform & metrics frozen
  
ptPhase = 'WAIT_STABLE';
ptStableSince = null;
ptUnstableSince = null;
ptNotice = null;
ptNoticeUntil = 0;
ptSnrEma = -Infinity;
updateStatus('Idle — click Start.');
}

function updateStatus(msg) {
  if (statusText) statusText.textContent = msg;
}

// ============================================================================
// 30-SECOND RECORDING WITH 3 s PRE-ROLL
// ============================================================================
function waitForPtReady(timeoutSec, token) {
  // Resolves true once ptPhase becomes RUNNING, or false on timeout/cancel.
  const t0 = (audioCtx ? audioCtx.currentTime : 0);

  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (!running || token !== recordPrepToken || !audioCtx) {
        clearInterval(iv);
        resolve(false);
        return;
      }
      const now = audioCtx.currentTime;
      if ((now - t0) >= timeoutSec) {
        clearInterval(iv);
        resolve(false);
        return;
      }
      if (ptPhase === 'RUNNING') {
        clearInterval(iv);
        resolve(true);
      }
    }, 50);
  });
}


async function start30sRecording() {
  // prevent double-press during pre-roll or recording
  if (recordingActive || preRecordingActive) return;

  // make sure monitor is running
  if (!running) {
    await startMonitoring();
    if (!running) return; // failed to start mic
  }

  // Snapshot filter settings for this recording
  recordUltraStart = parseFloat(ultraStartInput.value);
  recordUltraEnd   = parseFloat(ultraEndInput.value);
  recordHpFreq     = parseFloat(signalHPInput.value);
  recordLpFreq     = parseFloat(signalLPInput.value);
  recordInvertSignal = invertSignalInput ? invertSignalInput.checked : false;

  // Disable filter inputs during pre-roll + recording
  setFilterInputsEnabled(false);

  preRecordingActive = true;


  // ------------------------------------------------------------------------
  // NEW: prepare recording by waiting for stable ultrasound + PT training.
  // This prevents "training on garbage" if the signal was bad earlier.
  // ------------------------------------------------------------------------
  preRecordMode = 'ACQUIRE';
  recordPrepToken += 1;
  const myToken = recordPrepToken;

  if (recordButton) {
    recordButton.disabled = true;
    recordButton.textContent = 'Preparing…';
  }

  // Force retrain from a clean slate
  if (ptDetector) ptDetector.reset();
  ptPhase = 'WAIT_STABLE';
  ptStableSince = null;
  ptUnstableSince = null;
  ptSnrEma = -Infinity;
  ptNotice = null;
  ptNoticeUntil = 0;
  resetPeakMetricsUI();

  // Wait until detector reaches RUNNING (stable + trained)
  const ready = await waitForPtReady(25, myToken);
  if (!ready) {
    // Cancel preparation (timeout or user stopped monitoring)
    preRecordingActive = false;
    preRecordMode = null;
    setFilterInputsEnabled(true);
    if (recordButton) {
      recordButton.disabled = false;
      recordButton.textContent = 'Record 30 seconds';
    }
    ptSetNotice('Could not get a stable signal. Try again.', (audioCtx ? audioCtx.currentTime : 0));
    return;
  }

  // Now that PT is trained, continue with the normal 3 s pre-roll countdown.
  preRecordMode = 'COUNTDOWN';


  // hide old snapshot until the new one is ready
  if (snapshotSection) snapshotSection.classList.add('hidden');
  if (csvDownloadLink) csvDownloadLink.classList.add('hidden');

  // clear any old timers
  if (recordTimeoutId) {
    clearTimeout(recordTimeoutId);
    recordTimeoutId = null;
  }
  if (recordCountdownInterval) {
    clearInterval(recordCountdownInterval);
    recordCountdownInterval = null;
  }
  if (preCountdownInterval) {
    clearInterval(preCountdownInterval);
    preCountdownInterval = null;
  }

  // 3 s "get ready" countdown
  let remainingPrep = 3;
  if (recordButton) {
    recordButton.disabled = true;
    recordButton.textContent = `Get ready ${remainingPrep} s`;
  }
  updateStatus('Recording will start in 3 s…');

  preCountdownInterval = setInterval(() => {
    if (!preRecordingActive) {
      clearInterval(preCountdownInterval);
      preCountdownInterval = null;
      return;
    }
    remainingPrep -= 1;
    if (remainingPrep > 0) {
      if (recordButton) {
        recordButton.textContent = `Get ready ${remainingPrep} s`;
      }
    } else {
      // prep finished -> start actual recording
      clearInterval(preCountdownInterval);
      preCountdownInterval = null;
      preRecordingActive = false;
      preRecordMode = null;
      beginRecordingWindow();
    }
  }, 1000);
}

function beginRecordingWindow() {
  recordingActive = true;
  recordStartTime = null;
  recordStartDate = new Date();
  recordSignal    = [];
  recordTime      = [];
  recordPeakTimes = [];

  // 30 s countdown on button text
  if (recordCountdownInterval) {
    clearInterval(recordCountdownInterval);
    recordCountdownInterval = null;
  }
  let remaining = RECORD_DURATION_SEC;
  if (recordButton) {
    recordButton.disabled = true;
    recordButton.textContent = `Recording ${remaining} s`;
  }
  recordCountdownInterval = setInterval(() => {
    if (!recordingActive) {
      clearInterval(recordCountdownInterval);
      recordCountdownInterval = null;
      return;
    }
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(recordCountdownInterval);
      recordCountdownInterval = null;
      // finishRecordingAndExport will reset button text
    } else if (recordButton) {
      recordButton.textContent = `Recording ${remaining} s`;
    }
  }, 1000);

  if (recordTimeoutId) clearTimeout(recordTimeoutId);
  recordTimeoutId = setTimeout(() => {
    if (recordingActive) finishRecordingAndExport();
  }, RECORD_DURATION_SEC * 1000);

  updateStatus('Recording 30 s…');
}

function finishRecordingAndExport() {
  if (!recordingActive) return;

  recordingActive = false;

  // Re-enable filter inputs
  setFilterInputsEnabled(true);

  if (recordTimeoutId) {
    clearTimeout(recordTimeoutId);
    recordTimeoutId = null;
  }
  if (recordCountdownInterval) {
    clearInterval(recordCountdownInterval);
    recordCountdownInterval = null;
  }
  if (preCountdownInterval) {
    clearInterval(preCountdownInterval);
    preCountdownInterval = null;
  }

  if (recordButton) {
    recordButton.disabled = false;
    recordButton.textContent = 'Record 30 seconds';
  }

  const sig   = recordSignal.slice();
  const tim   = recordTime.slice();
  const peaks = recordPeakTimes.slice();

  // create PNG from raw time / signal (unchanged behaviour)
  generateSnapshotImage(tim, sig, peaks);

  // create CSV from resampled 200 Hz data
  generateCsvFromRaw(tim, sig);

  // stop monitoring; keeps current live graph & metrics frozen
  stopMonitoring();
}


// ============================================================================
// Disable during recording
// ============================================================================
function setFilterInputsEnabled(enabled) {
  const disabled = !enabled;

  if (ultraStartInput) ultraStartInput.disabled = disabled;
  if (ultraEndInput)   ultraEndInput.disabled   = disabled;
  if (signalHPInput)   signalHPInput.disabled   = disabled;
  if (signalLPInput)   signalLPInput.disabled   = disabled;
  if (invertSignalInput) invertSignalInput.disabled = disabled;
}

// ============================================================================
// FILTERS
// ============================================================================
function highPassFilter(x, fc, dt) {
  if (fc <= 0) return x;
  const rc = 1 / (2 * Math.PI * fc);
  const alpha = rc / (rc + dt);
  const y = alpha * (hpPrevOut + x - hpPrevIn);
  hpPrevIn  = x;
  hpPrevOut = y;
  return y;
}

function lowPassFilter(x, fc, dt) {
  if (fc <= 0) return x;
  const rc = 1 / (2 * Math.PI * fc);
  const alpha = dt / (rc + dt);
  lpPrevOut = lpPrevOut + alpha * (x - lpPrevOut);
  return lpPrevOut;
}

// ============================================================================
// MAIN DSP STEP
// ============================================================================
function processSample() {
  if (!running || !audioCtx) return;

  analyser.getByteFrequencyData(freqData);
  const sampleRate = audioCtx.sampleRate;
  const freqRes    = sampleRate / analyser.fftSize;

  const minFreq = parseFloat(ultraStartInput.value);
  const maxFreq = parseFloat(ultraEndInput.value);
  const startBin = Math.max(0, Math.floor(minFreq / freqRes));
  const endBin   = Math.min(Math.ceil(maxFreq / freqRes), freqData.length - 1);
  if (endBin <= startBin) return;

  // peak search
  let peakMagnitude = -Infinity;
  let peakBin = startBin;
  for (let i = startBin; i <= endBin; i++) {
    if (freqData[i] > peakMagnitude) {
      peakMagnitude = freqData[i];
      peakBin = i;
    }
  }

  // parabolic interpolation
  let refinedBin = peakBin;
  if (peakBin > startBin && peakBin < endBin) {
    const left   = freqData[peakBin - 1];
    const center = freqData[peakBin];
    const right  = freqData[peakBin + 1];
    const denom  = (left - 2 * center + right);
    if (denom !== 0) {
      let delta = 0.5 * (left - right) / denom;
      delta = Math.max(-0.5, Math.min(0.5, delta));
      refinedBin = peakBin + delta;
    }
  }

  const peakFrequency = refinedBin * freqRes;

  // noise estimate
  let noiseSum = 0;
  let noiseCount = 0;
  for (let i = 0; i < startBin && i < 100; i++) {
    noiseSum += freqData[i];
    noiseCount++;
  }
  for (let i = endBin + 1; i < freqData.length && i < endBin + 101; i++) {
    noiseSum += freqData[i];
    noiseCount++;
  }
  const noiseLevel = noiseCount > 0 ? noiseSum / noiseCount : 1;
  const snr = peakMagnitude > 0
    ? 20 * Math.log10(peakMagnitude / Math.max(noiseLevel, 1))
    : -Infinity;
  lastSnr = snr;

  // frequency -> normalized signal
  const freqRange = maxFreq - minFreq;
  let normalizedSignal = freqRange > 0 ? (peakFrequency - minFreq) / freqRange : 0.5;
  normalizedSignal = Math.max(0, Math.min(1, normalizedSignal));

  // band-pass
  const hpFreq = parseFloat(signalHPInput.value);
  const lpFreq = parseFloat(signalLPInput.value);
  let filteredSignal = normalizedSignal;
  if (hpFreq > 0) filteredSignal = highPassFilter(filteredSignal, hpFreq, FILTER_DT);
  if (lpFreq > 0) filteredSignal = lowPassFilter(filteredSignal, lpFreq, FILTER_DT);

  // NEW: invert signal if checkbox is checked
  if (invertSignalInput && invertSignalInput.checked) {
    filteredSignal = -filteredSignal;
    filteredSignal = filteredSignal + 1;
  }

  // push to live buffers
  const t = audioCtx.currentTime;
  signalBuffer.push(filteredSignal);
  timeBuffer.push(t);

  const cutoffTime = t - DISPLAY_DURATION;
  while (timeBuffer.length > 0 && timeBuffer[0] < cutoffTime) {
    timeBuffer.shift();
    signalBuffer.shift();
  }
  if (signalBuffer.length > MAX_SAMPLES) {
    signalBuffer.shift();
    timeBuffer.shift();
  }

  // recording buffers
  if (recordingActive) {
    if (recordStartTime === null) recordStartTime = t;
    const relT = t - recordStartTime;  // actual elapsed time in seconds
    recordSignal.push(filteredSignal);
    recordTime.push(relT);
    if (relT >= RECORD_DURATION_SEC) {
      finishRecordingAndExport();
    }
  }

  metricMagnitudeSum += peakMagnitude;
  metricFreqSum      += peakFrequency;
  metricSnrSum       += snr;
  metricCount++;

  updatePeakDetection(filteredSignal, t);
}

// ============================================================================
// HR / HRV DETECTION
// ============================================================================
function updatePeakDetection(sample, time) {
  // SNR gating to avoid false peaks when the ultrasound carrier is missing.
  const MIN_SNR_FOR_HR = 8;

  // Smooth SNR for stability decisions (prevents flickering transitions)
  if (isFinite(lastSnr)) {
    if (!isFinite(ptSnrEma)) ptSnrEma = lastSnr;
    else ptSnrEma = (1 - PT_SNR_EMA_ALPHA) * ptSnrEma + PT_SNR_EMA_ALPHA * lastSnr;
  }

  const snrForUi = isFinite(ptSnrEma) ? ptSnrEma : lastSnr;
  const stableNow = isFinite(snrForUi) && snrForUi >= PT_STABLE_SNR_DB;

  // Track stable/unstable durations
  if (stableNow) {
    if (ptStableSince === null) ptStableSince = time;
    ptUnstableSince = null;
  } else {
    ptStableSince = null;
    if (ptUnstableSince === null) ptUnstableSince = time;
  }

  // If we were running/training and stability is lost long enough -> retrain
  if ((ptPhase === 'RUNNING' || ptPhase === 'TRAINING') &&
      ptUnstableSince !== null &&
      (time - ptUnstableSince) >= PT_LOST_HOLD_SEC) {

    ptPhase = 'WAIT_STABLE';
    if (ptDetector) ptDetector.reset();
    resetPeakMetricsUI();
    ptSetNotice('Signal unstable. Retraining peak detector…', time);
    return; // pause detection until stable again
  }

  // Wait for stability at the beginning (or after a retrain)
  if (ptPhase === 'WAIT_STABLE') {
    if (stableNow && ptStableSince !== null && (time - ptStableSince) >= PT_STABLE_HOLD_SEC) {
      ptPhase = 'TRAINING';
      if (ptDetector) ptDetector.reset();
      resetPeakMetricsUI();
      ptSetNotice('Stable signal detected. Training peak detector…', time);
    } else {
      // still waiting, nothing to do here
      // (bpm will decay below if SNR is too low)
    }
  }

  // If SNR is too low for HR at all, decay displayed bpm and stop here.
  if (!isFinite(lastSnr) || lastSnr < MIN_SNR_FOR_HR) {
    if (displayBpm !== null) {
      displayBpm = displayBpm * 0.98;
      if (displayBpm < MIN_HEART_RATE / 2) {
        displayBpm = null;
        if (heartRateSpan) heartRateSpan.textContent = '--';
        if (hrvSpan)       hrvSpan.textContent       = '--';
      } else {
        if (heartRateSpan) heartRateSpan.textContent = displayBpm.toFixed(1);
      }
    }
    return;
  }

  if (!ptDetector) return;

  // During WAIT_STABLE we intentionally do NOT feed the detector
  // (so training starts from a clean slate once stable).
  if (ptPhase === 'WAIT_STABLE') return;

  const newPeaks = ptDetector.process(sample, time);

  // Training ends once thresholds are initialised
  if (ptPhase === 'TRAINING' && ptDetector.initDone) {
    ptPhase = 'RUNNING';
    ptSetNotice('Peak detector trained. Running…', time);
  }

  if (!newPeaks || newPeaks.length === 0) return;

  for (const peakTime of newPeaks) {
    recordPeak(peakTime);
  }
}

function recordPeak(peakTime) {
  // Update lastPeakTime (used by HR/HRV calculations)
  lastPeakTime = peakTime;


  detectedPeaks.push(peakTime);
  while (
    detectedPeaks.length > MAX_PEAK_HISTORY ||
    (detectedPeaks.length > 1 &&
    peakTime - detectedPeaks[0] > BEAT_COUNTER_WINDOW_SEC + 5) // keep a small margin
  ) {
    detectedPeaks.shift();
  }

  // NEW: update beat counter (number of R-peaks in last BEAT_COUNTER_WINDOW_SEC seconds)
  if (beatCountSpan) {
    const WINDOW = BEAT_COUNTER_WINDOW_SEC;
    let count = 0;
    for (let i = detectedPeaks.length - 1; i >= 0; i--) {
      if (peakTime - detectedPeaks[i] <= WINDOW) {
        count++;
      } else {
        break; // older than the window
      }
    }
    beatCountSpan.textContent = count.toString();
  }


  // store peaks also for 30 s recording
  if (recordingActive && recordStartTime !== null) {
    recordPeakTimes.push(peakTime - recordStartTime);
  }

  // Heart rate
  if (detectedPeaks.length >= 2) {
    const n = detectedPeaks.length;
    const maxIntervals = 8;
    const startIdx = Math.max(1, n - maxIntervals);
    let sumRR = 0;
    let countRR = 0;
    for (let i = startIdx; i < n; i++) {
      const rr = detectedPeaks[i] - detectedPeaks[i - 1];
      if (rr > 0) {
        sumRR += rr;
        countRR++;
      }
    }
    if (countRR > 0) {
      const meanRR = sumRR / countRR;
      let bpm = 60 / meanRR;
      if (bpm >= MIN_HEART_RATE && bpm <= MAX_HEART_RATE) {
        if (displayBpm === null) displayBpm = bpm;
        else displayBpm = (1 - HR_SMOOTH) * displayBpm + HR_SMOOTH * bpm;
        heartRateSpan.textContent = displayBpm.toFixed(1);
      }
    }
  }

  updateHRV();
}

function updateHRV() {
  const el = resolveHrvSpan();
  if (!el) return;
  if (detectedPeaks.length < 5) {
    el.textContent = '--';
    return;
  }
  const n = detectedPeaks.length;
  const maxPeaksForHRV = 20;
  const startIdx = Math.max(1, n - maxPeaksForHRV);
  const rr = [];
  for (let i = startIdx; i < n; i++) {
    const interval = (detectedPeaks[i] - detectedPeaks[i - 1]) * 1000;
    if (interval > 250 && interval < 3500) rr.push(interval);
  }
  if (rr.length < 3) {
    el.textContent = '--';
    return;
  }
  let sum = 0;
  for (const v of rr) sum += v;
  const meanRR = sum / rr.length;
  let sqSum = 0;
  for (const v of rr) {
    const d = v - meanRR;
    sqSum += d * d;
  }
  const sdnn = Math.sqrt(sqSum / rr.length);
  el.textContent = (isFinite(sdnn) && sdnn >= 0) ? sdnn.toFixed(1) : '--';
}

// ============================================================================
// RENDER LOOP
// ============================================================================
function renderLoop() {
  if (!running || !audioCtx) return;

  const dataLength = signalBuffer.length;
  const width  = gridCanvas.width;
  const height = gridCanvas.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gridCanvas, 0, 0);

  if (dataLength >= 2) {
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < dataLength; i++) {
      const v = signalBuffer[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    if (maxVal - minVal < 0.01) {
      const mid = (maxVal + minVal) / 2;
      minVal = mid - 0.005;
      maxVal = mid + 0.005;
    }
    const range = maxVal - minVal;

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2dd4bf';
    ctx.shadowColor = 'rgba(45, 212, 191, 0.5)';
    ctx.shadowBlur = 6;
    ctx.beginPath();

    const now = timeBuffer[timeBuffer.length - 1];
    const startTime = now - DISPLAY_DURATION;

    let first = true;
    for (let i = 0; i < dataLength; i++) {
      const t = timeBuffer[i];
      const v = signalBuffer[i];
      const x = ((t - startTime) / DISPLAY_DURATION) * width;
      const y = height - ((v - minVal) / range) * height;

      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // metric boxes ~10 Hz
  const nowTime = audioCtx.currentTime;
  if (nowTime - lastMetricTime >= 0.1 && metricCount > 0) {
    const avgMag  = metricMagnitudeSum / metricCount;
    const avgFreq = metricFreqSum / metricCount;
    const avgSnr  = metricSnrSum / metricCount;

    peakLevelSpan.textContent =
      `${avgMag.toFixed(1)} @ ${(avgFreq / 1000).toFixed(2)} kHz`;
    if (peakFreqSpan) peakFreqSpan.textContent = (avgFreq / 1000).toFixed(2);
    snrSpan.textContent = isFinite(avgSnr) ? avgSnr.toFixed(1) : '--';

// Status: show PT phase (unless recording UI is using the status line)
const showPtStatus = (running && !recordingActive && (!preRecordingActive || preRecordMode === 'ACQUIRE'));
if (showPtStatus) {
  const now = audioCtx.currentTime;
  let msg = null;
  const preparing = (preRecordingActive && preRecordMode === 'ACQUIRE');
  const prefix = preparing ? 'Preparing recording…' : 'Listening…';

  if (ptNotice && now < ptNoticeUntil) {
    msg = preparing ? `${prefix} ${ptNotice}` : ptNotice;
  } else if (ptPhase === 'WAIT_STABLE') {
    const snrStr = isFinite(ptSnrEma) ? ptSnrEma.toFixed(1)
                 : (isFinite(lastSnr) ? lastSnr.toFixed(1) : '--');
    msg = `${prefix} waiting for stable signal (SNR ${snrStr} dB)`;
    // show hold progress if we are currently stable
    if (ptStableSince !== null) {
      const p = Math.min(1, (now - ptStableSince) / PT_STABLE_HOLD_SEC);
      msg = `${prefix} waiting for stable signal (${Math.round(p * 100)}%, SNR ${snrStr} dB)`;
    }
  } else if (ptPhase === 'TRAINING') {
    if (ptDetector && ptDetector.startTime !== null) {
      const p = Math.min(1, (now - ptDetector.startTime) / 2.0);
      msg = `${prefix} training peak detector (${Math.round(p * 100)}%)`;
    } else {
      msg = `${prefix} training peak detector (warmup…)`;
    }
  } else {
    msg = prefix;
  }

  if (msg) updateStatus(msg);
}


    metricMagnitudeSum = 0;
    metricFreqSum      = 0;
    metricSnrSum       = 0;
    metricCount        = 0;
    lastMetricTime     = nowTime;
  }

  renderFrameId = requestAnimationFrame(renderLoop);
}

// ============================================================================
// SNAPSHOT IMAGE GENERATION
// ============================================================================
function computeAverageHr(peakTimes) {
  if (!peakTimes || peakTimes.length < 2) return null;
  const duration = peakTimes[peakTimes.length - 1] - peakTimes[0];
  if (duration <= 0) return null;
  const beats = peakTimes.length - 1;
  return beats * 60 / duration;
}

function generateSnapshotImage(timeArr, signalArr, peakTimes) {
  if (!timeArr || timeArr.length < 2 ||
      !signalArr || signalArr.length !== timeArr.length) {
    alert('Not enough data recorded to create snapshot.');
    return;
  }

  const width  = 900;
  const height = 1150;
  const offCanvas = document.createElement('canvas');
  offCanvas.width  = width;
  offCanvas.height = height;
  const c = offCanvas.getContext('2d');

  // background
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, width, height);

  const marginX = 40;
  const marginTop = 60;
  const marginBottom = 40;
  const gridWidth = width - 2 * marginX;
  const gridHeight = height - marginTop - marginBottom;

  const numRows = 4;
  const rowDuration = RECORD_DURATION_SEC / numRows; // 7.5 s per row
  const rowHeight = gridHeight / numRows;

  // header (uses recording start time if available)
  const now = recordStartDate ? new Date(recordStartDate) : new Date();
  const recordedStr =
    `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()} ` +
    `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const avgHr = computeAverageHr(peakTimes);
  const hrLabel = avgHr ? `${avgHr.toFixed(0)} BPM` : '--';

  c.fillStyle = '#000000';
  c.font = '12px Arial';
  c.textBaseline = 'top';

  c.fillText(`Recorded: ${recordedStr}`, marginX, 20);
  c.fillText(`Heart Rate: ${hrLabel}`, width / 2, 20);
  const invertLabel = recordInvertSignal ? 'Inverted' : 'Not Inverted'; // NEW
  c.fillText(`Signal: ${invertLabel}`, marginX, 36);               // NEW	
  c.fillText(`Duration: ${RECORD_DURATION_SEC}s`, width / 2, 36);

  // grid
  for (let row = 0; row < numRows; row++) {
    const rowTop = marginTop + row * rowHeight;

    for (let x = 0; x <= gridWidth; x += 5) {
      const isBig = (x % 25 === 0);
      c.lineWidth = isBig ? 0.3 : 0.1;
      c.strokeStyle = isBig ? '#c4b5fd' : '#e5e7eb';
      c.beginPath();
      c.moveTo(marginX + x, rowTop);
      c.lineTo(marginX + x, rowTop + rowHeight);
      c.stroke();
    }

    for (let y = 0; y <= rowHeight; y += 5) {
      const isBig = (y % 25 === 0);
      c.lineWidth = isBig ? 0.3 : 0.1;
      c.strokeStyle = isBig ? '#c4b5fd' : '#e5e7eb';
      c.beginPath();
      c.moveTo(marginX, rowTop + y);
      c.lineTo(marginX + gridWidth, rowTop + y);
      c.stroke();
    }
  }

  // global min / max for y scaling
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const v of signalArr) {
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  if (maxVal - minVal < 1e-6) {
    const mid = (maxVal + minVal) / 2;
    minVal = mid - 0.5;
    maxVal = mid + 0.5;
  }
  const range = maxVal - minVal;

  // waveform
  c.strokeStyle = '#000000';
  c.lineWidth = 1.2;

  let prevRow = -1;
  c.beginPath();

  const paddingY = 10; // margin inside each row

  for (let i = 0; i < timeArr.length; i++) {
    const t = timeArr[i]; // 0..30 s
    if (t < 0 || t > RECORD_DURATION_SEC) continue;

    let row = Math.floor(t / rowDuration);
    if (row < 0) row = 0;
    if (row >= numRows) row = numRows - 1;

    const rowStartT = row * rowDuration;
    const tRow = t - rowStartT;

    const rowTop = marginTop + row * rowHeight;
    const x = marginX + (tRow / rowDuration) * gridWidth;

    const yTop = rowTop + paddingY;
    const yBottom = rowTop + rowHeight - paddingY;
    const norm = (signalArr[i] - minVal) / range; // 0..1
    const y = yBottom - norm * (yBottom - yTop);

    if (row !== prevRow) {
      if (i !== 0) c.stroke();
      c.beginPath();
      c.moveTo(x, y);
      prevRow = row;
    } else {
      c.lineTo(x, y);
    }
  }
  c.stroke();

  // --- Disclaimer text at the bottom ---
  c.font = '10px Arial';
  c.fillStyle = '#000000';
  c.textBaseline = 'bottom';
  c.fillText(
    'The data must not be used to diagnose, monitor, or treat any medical condition.',
    marginX,
    height - 10
  );

  const dataUrl = offCanvas.toDataURL('image/png');
  if (snapshotImage) {
    snapshotImage.src = dataUrl;
  }
  if (snapshotSection) {
    snapshotSection.classList.remove('hidden');

    // NEW: after a 30 s measurement, smoothly scroll to the snapshot section
    // once the image is attached to the DOM.
    setTimeout(() => {
      // Find the scrollable container (works with WordPress, iframes, and custom containers)
      function findScrollableParent(element) {
        let parent = element.parentElement;
        while (parent) {
          const overflowY = window.getComputedStyle(parent).overflowY;
          const isScrollable = overflowY !== 'visible' && overflowY !== 'hidden';
          if (isScrollable && parent.scrollHeight > parent.clientHeight) {
            return parent;
          }
          if (parent === document.body || parent === document.documentElement) {
            break;
          }
          parent = parent.parentElement;
        }
        return null;
      }

      const scrollContainer = findScrollableParent(snapshotSection);
      
      if (scrollContainer) {
        // Scroll within the container
        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = snapshotSection.getBoundingClientRect();
        const offsetPosition = elementRect.top - containerRect.top + scrollContainer.scrollTop - 12;
        
        scrollContainer.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      } else {
        // Fallback to window scroll
        const elementPosition = snapshotSection.getBoundingClientRect().top + window.pageYOffset;
        const offsetPosition = elementPosition - 12;
        
        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      }
    }, 100);
  }
}

// ============================================================================
// CSV GENERATION (200 Hz resampled)
// ============================================================================

// format date/time in European style: DD.MM.YYYY HH:MM:SS
function formatDateTimeEU(date) {
  const d  = String(date.getDate()).padStart(2,'0');
  const m  = String(date.getMonth()+1).padStart(2,'0');
  const y  = date.getFullYear();
  const hh = String(date.getHours()).padStart(2,'0');
  const mm = String(date.getMinutes()).padStart(2,'0');
  const ss = String(date.getSeconds()).padStart(2,'0');
  return `${d}.${m}.${y} ${hh}:${mm}:${ss}`;
}

// Resample irregular (timeArr, sigArr) to uniform grid at rate Hz over duration seconds
function resampleToUniformGrid(timeArr, sigArr, duration, rate) {
  const n = Math.floor(duration * rate);  // e.g. 30 * 200 = 6000
  const outTime   = new Array(n);
  const outSignal = new Array(n);

  if (!timeArr.length || !sigArr.length) {
    for (let i = 0; i < n; i++) {
      outTime[i]   = i / rate;
      outSignal[i] = 0;
    }
    return { time: outTime, signal: outSignal };
  }

  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;      // 0, 0.005, 0.010, ...
    outTime[i] = t;

    while (j + 1 < timeArr.length && timeArr[j + 1] < t) {
      j++;
    }

    if (j + 1 < timeArr.length) {
      const t0 = timeArr[j];
      const t1 = timeArr[j + 1];
      const v0 = sigArr[j];
      const v1 = sigArr[j + 1];
      let v;
      if (t1 === t0) {
        v = v0;
      } else {
        const a = (t - t0) / (t1 - t0);
        v = v0 + a * (v1 - v0);
      }
      outSignal[i] = v;
    } else {
      outSignal[i] = sigArr[sigArr.length - 1];
    }
  }

  return { time: outTime, signal: outSignal };
}

// Build CSV from raw recorded data
function generateCsvFromRaw(rawTime, rawSignal) {
  if (!csvDownloadLink) return;
  if (!rawTime || !rawSignal || rawTime.length < 2 || rawSignal.length !== rawTime.length) {
    return;
  }

  const { time: uniTime, signal: uniSig } =
    resampleToUniformGrid(rawTime, rawSignal, RECORD_DURATION_SEC, PROCESS_RATE);

  const startDate = recordStartDate ? new Date(recordStartDate) : new Date();
  const startStr  = formatDateTimeEU(startDate);

  let csv = '';
  csv += '# ECG snapshot exported from Ultrasound ECG web app\n';
  csv += '# The data must not be used to diagnose/monitor/treat any medical condition.\n';
  csv += `# StartTime: ${startStr}\n`;
  csv += `# UltrasoundBandHz: HP=${recordUltraStart} LP=${recordUltraEnd}\n`;
  csv += `# SignalBandHz: HP=${recordHpFreq} LP=${recordLpFreq}\n`;
  csv += `# SignalInverted: ${recordInvertSignal ? 'yes' : 'no'}\n`; // NEW
  csv += 'time_s,value\n';

  for (let i = 0; i < uniTime.length; i++) {
    const t = uniTime[i].toFixed(3);   // 0.000, 0.005, ...
    const v = uniSig[i].toFixed(4);
    csv += `${t},${v}\n`;
  }

  if (csvDownloadUrl) {
    URL.revokeObjectURL(csvDownloadUrl);
    csvDownloadUrl = null;
  }
  const blob = new Blob([csv], { type: 'text/csv' });
  csvDownloadUrl = URL.createObjectURL(blob);

  csvDownloadLink.href = csvDownloadUrl;

  const fnStamp =
    `${startDate.getFullYear()}` +
    `${String(startDate.getMonth()+1).padStart(2,'0')}` +
    `${String(startDate.getDate()).padStart(2,'0')}_` +
    `${String(startDate.getHours()).padStart(2,'0')}` +
    `${String(startDate.getMinutes()).padStart(2,'0')}` +
    `${String(startDate.getSeconds()).padStart(2,'0')}`;

  csvDownloadLink.download = `ecg_snapshot_${fnStamp}.csv`;
  csvDownloadLink.classList.remove('hidden');
}

// ============================================================================
// EVENT LISTENERS & INITIALIZATION
// ============================================================================
startButton.addEventListener('click', startMonitoring);
stopButton.addEventListener('click', stopMonitoring);
if (recordButton) {
  recordButton.addEventListener('click', start30sRecording);
}
window.addEventListener('resize', resizeCanvas);

resizeCanvas();
ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.drawImage(gridCanvas, 0, 0);
