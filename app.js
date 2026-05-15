(() => {
  'use strict';

  const LEVELS = [
    { label: 'BOSKI',          comment: 'Pachniesz jak letni poranek w sadzie.' },
    { label: 'ŁADNY',          comment: 'Bardzo przyzwoity zapach, gratulacje.' },
    { label: 'UJDZIE',         comment: 'W tłumie nie wyróżnisz się ani w jedną, ani w drugą stronę.' },
    { label: 'TROCHĘ DAJESZ',  comment: 'Czas rozważyć prysznic albo dezodorant.' },
    { label: 'POZIOM MENEL',   comment: 'Ewakuacja zalecana. Powtórz pomiar po kąpieli.' },
  ];

  const COLORS = ['#7CFC9F', '#9BE7C4', '#E5E7EB', '#FB923C', '#F87171'];

  const els = {
    body: document.body,
    bg: document.getElementById('bg'),
    cam: document.getElementById('cam'),
    startBtn: document.getElementById('start-btn'),
    resetBtn: document.getElementById('reset-btn'),
    meter: document.getElementById('meter'),
    calibration: document.getElementById('calibration'),
    barFill: document.getElementById('bar-fill'),
    bar: document.querySelector('.bar'),
    result: document.getElementById('result'),
    resultValue: document.getElementById('result-value'),
    resultComment: document.getElementById('result-comment'),
    error: document.getElementById('error'),
  };

  let stream = null;
  let rafId = null;
  let fallbackTimer = null;
  let calibrationTimer = null;
  let fill = 0;
  let sniffStarted = false;
  let audioCtx = null;
  let canvas = null;
  let ctx = null;

  const FAR_BRIGHTNESS = 120;
  const CLOSE_BRIGHTNESS = 35;
  const FILL_RATE = 2.6;
  const DRAIN_RATE = 1.3;
  const FALLBACK_MS = 3200;
  const CALIBRATION_MS = 3000;

  function setState(s) {
    els.body.dataset.state = s;
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }
  function clearError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function playSniff() {
    const ac = getAudioCtx();
    if (!ac) return;
    const start = ac.currentTime + 0.05;
    const sniffs = [
      { t: 0.00, dur: 0.18, gain: 0.45, freq: 1600 },
      { t: 0.42, dur: 0.20, gain: 0.50, freq: 1500 },
      { t: 0.90, dur: 0.28, gain: 0.55, freq: 1400 },
    ];
    sniffs.forEach(s => {
      const t0 = start + s.t;
      const len = Math.floor(ac.sampleRate * s.dur);
      const buffer = ac.createBuffer(1, len, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = s.freq;
      filter.Q.value = 0.7;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(s.gain, t0 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.005, t0 + s.dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ac.destination);
      src.start(t0);
      src.stop(t0 + s.dur + 0.02);
    });
  }

  function playPing() {
    const ac = getAudioCtx();
    if (!ac) return;
    const now = ac.currentTime;
    const partials = [
      { freq: 1568, gain: 0.38, decay: 1.6 },
      { freq: 3136, gain: 0.14, decay: 0.9 },
      { freq: 4704, gain: 0.05, decay: 0.5 },
    ];
    partials.forEach(p => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = p.freq;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(p.gain, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now);
      osc.stop(now + p.decay + 0.05);
    });
  }

  async function preflightCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      s.getTracks().forEach(t => t.stop());
    } catch (err) {
      console.warn('Camera preflight failed:', err);
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      els.cam.srcObject = stream;
      await els.cam.play();
      return true;
    } catch (err) {
      console.warn('Camera unavailable:', err);
      return false;
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    els.cam.srcObject = null;
  }

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }

  function sampleBrightness() {
    const v = els.cam;
    if (!v.videoWidth || !v.videoHeight) return null;
    ensureCanvas();
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    return sum / n;
  }

  function updateBar(value) {
    const prev = fill;
    fill = Math.max(0, Math.min(100, value));
    els.barFill.style.width = fill + '%';
    els.bar.setAttribute('aria-valuenow', String(Math.round(fill)));
    if (!sniffStarted && fill > 0 && prev <= 0) {
      sniffStarted = true;
      playSniff();
    }
  }

  function tick() {
    const b = sampleBrightness();
    if (b !== null) {
      let target;
      if (b <= CLOSE_BRIGHTNESS) target = 1;
      else if (b >= FAR_BRIGHTNESS) target = 0;
      else target = (FAR_BRIGHTNESS - b) / (FAR_BRIGHTNESS - CLOSE_BRIGHTNESS);

      if (target > 0.45) {
        updateBar(fill + FILL_RATE * target);
      } else {
        updateBar(fill - DRAIN_RATE);
      }

      if (fill >= 100) {
        finishMeasurement();
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function startFallback() {
    const startT = performance.now();
    const step = () => {
      const elapsed = performance.now() - startT;
      updateBar((elapsed / FALLBACK_MS) * 100);
      if (fill >= 100) {
        finishMeasurement();
        return;
      }
      fallbackTimer = requestAnimationFrame(step);
    };
    fallbackTimer = requestAnimationFrame(step);
  }

  function pickResult() {
    const idx = Math.floor(Math.random() * LEVELS.length);
    return { ...LEVELS[idx], color: COLORS[idx] };
  }

  function finishMeasurement() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (fallbackTimer) { cancelAnimationFrame(fallbackTimer); fallbackTimer = null; }
    stopCamera();
    try { els.bg.pause(); } catch (_) {}
    playPing();

    const r = pickResult();
    els.resultValue.textContent = r.label;
    els.resultValue.style.color = r.color;
    els.resultComment.textContent = r.comment;

    els.meter.hidden = true;
    els.result.hidden = false;
    els.startBtn.hidden = true;
    els.resetBtn.hidden = false;
    setState('result');
  }

  async function start() {
    clearError();
    setState('calibrating');
    els.calibration.hidden = false;
    els.meter.hidden = true;
    els.result.hidden = true;
    els.startBtn.hidden = true;
    els.resetBtn.hidden = true;
    sniffStarted = false;
    fill = 0;
    updateBar(0);

    getAudioCtx();

    try {
      els.bg.currentTime = 0;
      await els.bg.play();
    } catch (err) {
      console.warn('Background video play failed:', err);
    }

    calibrationTimer = setTimeout(async () => {
      calibrationTimer = null;
      if (els.body.dataset.state !== 'calibrating') return;

      els.calibration.hidden = true;
      els.meter.hidden = false;
      setState('measuring');

      const ok = await startCamera();
      if (!ok) {
        showError('Brak dostępu do kamery — symulacja pomiaru.');
        startFallback();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }, CALIBRATION_MS);
  }

  function reset() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (fallbackTimer) { cancelAnimationFrame(fallbackTimer); fallbackTimer = null; }
    if (calibrationTimer) { clearTimeout(calibrationTimer); calibrationTimer = null; }
    stopCamera();
    clearError();
    sniffStarted = false;
    fill = 0;
    updateBar(0);
    try {
      els.bg.pause();
      els.bg.currentTime = 0;
    } catch (_) {}
    els.calibration.hidden = true;
    els.meter.hidden = true;
    els.result.hidden = true;
    els.startBtn.hidden = false;
    els.resetBtn.hidden = true;
    setState('idle');
  }

  els.startBtn.addEventListener('click', start);
  els.resetBtn.addEventListener('click', reset);

  async function showFirstFrame() {
    try {
      await els.bg.play();
      if (els.body.dataset.state === 'idle') {
        els.bg.pause();
        els.bg.currentTime = 0;
      }
    } catch (_) { /* autoplay blocked — first interaction will start it */ }
  }
  if (els.bg.readyState >= 2) {
    showFirstFrame();
  } else {
    els.bg.addEventListener('loadeddata', showFirstFrame, { once: true });
  }

  preflightCamera();

  document.addEventListener('visibilitychange', () => {
    const s = els.body.dataset.state;
    if (document.hidden && (s === 'measuring' || s === 'calibrating')) {
      reset();
    }
  });

  setState('idle');
})();
