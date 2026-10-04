(() => {
  'use strict';

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const audio = document.getElementById('audio');
  const fileInput = document.getElementById('fileInput');
  const trackName = document.getElementById('trackName');
  const playBtn = document.getElementById('playBtn');
  const fullBtn = document.getElementById('fullBtn');
  const seek = document.getElementById('seek');
  const timeNow = document.getElementById('timeNow');
  const timeTotal = document.getElementById('timeTotal');
  const impact = document.getElementById('impact');
  const controls = document.getElementById('controls');
  const menuBtn = document.getElementById('menuBtn');

  let width = 1;
  let height = 1;
  let dpr = 1;
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let frequency = null;
  let previous = null;
  let objectUrl = null;
  let lowAverage = 0.08;
  let fluxAverage = 0.02;
  let bass = 0;
  let mids = 0;
  let highs = 0;
  let beat = 0;
  let transient = 0;
  let phase = 0;
  let last = performance.now();
  let hideTimer = 0;

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    frequency = new Uint8Array(analyser.frequencyBinCount);
    previous = new Uint8Array(analyser.frequencyBinCount);
  }

  function band(lowHz, highHz) {
    if (!analyser || !frequency) return 0;
    const nyquist = audioCtx.sampleRate / 2;
    const start = Math.max(0, Math.floor(lowHz / nyquist * frequency.length));
    const end = Math.min(frequency.length - 1, Math.ceil(highHz / nyquist * frequency.length));
    let total = 0;
    let count = 0;
    for (let i = start; i <= end; i++) {
      const value = frequency[i] / 255;
      total += value * value;
      count++;
    }
    return count ? Math.sqrt(total / count) : 0;
  }

  function analyse(dt) {
    if (!analyser || audio.paused) {
      bass = smooth(bass, 0, 4, dt);
      mids = smooth(mids, 0, 4, dt);
      highs = smooth(highs, 0, 4, dt);
      beat = smooth(beat, 0, 5.5, dt);
      transient = smooth(transient, 0, 7, dt);
      return;
    }

    analyser.getByteFrequencyData(frequency);
    const rawBass = band(28, 170);
    const rawMids = band(170, 2600);
    const rawHighs = band(2600, 12000);
    let flux = 0;
    for (let i = 1; i < frequency.length; i++) {
      const rise = frequency[i] - previous[i];
      if (rise > 0) flux += rise / 255;
      previous[i] = frequency[i];
    }
    flux /= frequency.length;

    const adapt = Math.min(1, dt * 1.6);
    lowAverage += (rawBass - lowAverage) * adapt;
    fluxAverage += (flux - fluxAverage) * Math.min(1, dt * 2.1);
    const lowRatio = rawBass / Math.max(.025, lowAverage);
    const fluxRatio = flux / Math.max(.006, fluxAverage);
    const strength = Number(impact.value);
    const kick = clamp((lowRatio - 1.08) * 1.5) * clamp(rawBass * 2.6);
    const snap = clamp((fluxRatio - 1.14) * .72) * clamp((rawMids + rawHighs) * 1.6);
    const hit = clamp(Math.max(kick, snap) * strength);

    beat = Math.max(beat, hit);
    transient = Math.max(transient, snap);
    beat = smooth(beat, 0, 5.0, dt);
    transient = smooth(transient, 0, 8.5, dt);
    bass = smooth(bass, rawBass, 9, dt);
    mids = smooth(mids, rawMids, 8, dt);
    highs = smooth(highs, rawHighs, 10, dt);
  }

  function fluidRadius(angle, t, base, index, count) {
    const idle = Math.sin(angle * 3 + t * .42) * .018 + Math.sin(angle * 7 - t * .31) * .01;
    const frequencyIndex = frequency ? Math.min(frequency.length - 1, Math.floor((index / count) ** 2.2 * frequency.length * .68)) : 0;
    const bin = frequency ? frequency[frequencyIndex] / 255 : 0;
    const spikeCount = 13 + Math.round(mids * 13 + transient * 11);
    const magnetic = Math.pow(Math.max(0, Math.sin(angle * spikeCount + phase)), 10);
    const secondary = Math.pow(Math.max(0, Math.sin(angle * (spikeCount - 4) - phase * .73)), 18);
    const audioShape = bin * (.035 + highs * .08);
    const spike = magnetic * (beat * .48 + highs * .16) + secondary * transient * .20;
    const compression = -beat * .085;
    return base * (1 + idle + audioShape + spike + compression);
  }

  function makeFluidPath(cx, cy, base, t) {
    const count = 190;
    const points = [];
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2;
      const radius = fluidRadius(angle, t, base, i, count);
      const squash = 1 - beat * .07;
      points.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius * squash
      });
    }
    const path = new Path2D();
    for (let i = 0; i < count; i++) {
      const p = points[i];
      const next = points[(i + 1) % count];
      const mx = (p.x + next.x) / 2;
      const my = (p.y + next.y) / 2;
      if (i === 0) path.moveTo(mx, my);
      path.quadraticCurveTo(next.x, next.y, (next.x + points[(i + 2) % count].x) / 2, (next.y + points[(i + 2) % count].y) / 2);
    }
    path.closePath();
    return path;
  }

  function drawField(cx, cy, base, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const alpha = .025 + beat * .055;
    for (let ring = 0; ring < 8; ring++) {
      const radius = base * (1.28 + ring * .13 + beat * .12);
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const a = i / 100 * Math.PI * 2;
        const wobble = Math.sin(a * (7 + ring) + t * (.22 + ring * .025)) * (3 + beat * 12);
        const x = cx + Math.cos(a) * (radius + wobble);
        const y = cy + Math.sin(a) * (radius * .72 + wobble);
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(170,195,206,${alpha * (1 - ring / 10)})`;
      ctx.lineWidth = .7;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles(cx, cy, base, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const count = 46;
    for (let i = 0; i < count; i++) {
      const seed = i * 12.9898;
      const a = seed + t * (.025 + (i % 5) * .004);
      const orbit = base * (1.36 + ((i * 37) % 100) / 78);
      const pull = beat * base * .22 * Math.sin(i * 2.4 + phase);
      const x = cx + Math.cos(a) * (orbit - pull);
      const y = cy + Math.sin(a) * (orbit * .65 - pull * .4);
      const size = .5 + (i % 4) * .32 + beat * (i % 3);
      ctx.fillStyle = `rgba(180,205,214,${.07 + beat * .12})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function draw(t) {
    const background = ctx.createRadialGradient(width * .5, height * .46, 0, width * .5, height * .5, Math.max(width, height) * .72);
    background.addColorStop(0, `rgb(${10 + Math.round(beat * 10)},${13 + Math.round(beat * 12)},${15 + Math.round(beat * 14)})`);
    background.addColorStop(.55, '#07090a');
    background.addColorStop(1, '#020303');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const cx = width * .5 + Math.sin(t * .23) * width * .012 * (1 + mids);
    const cy = height * (height < 560 ? .45 : .43) + Math.cos(t * .19) * height * .008;
    const base = Math.min(width, height) * (height < 560 ? .205 : .19) * (1 + bass * .07);
    drawField(cx, cy, base, t);
    drawParticles(cx, cy, base, t);

    const path = makeFluidPath(cx, cy, base, t);
    ctx.save();
    ctx.shadowColor = `rgba(90,145,164,${.20 + beat * .22})`;
    ctx.shadowBlur = 30 + beat * 50;
    const metal = ctx.createRadialGradient(cx - base * .38, cy - base * .45, base * .06, cx + base * .12, cy + base * .16, base * 1.22);
    metal.addColorStop(0, '#d9e1e2');
    metal.addColorStop(.055, '#78878a');
    metal.addColorStop(.16, '#1d2426');
    metal.addColorStop(.48, '#050708');
    metal.addColorStop(.72, '#121719');
    metal.addColorStop(.89, '#020303');
    metal.addColorStop(1, '#263034');
    ctx.fillStyle = metal;
    ctx.fill(path);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(191,213,219,${.18 + highs * .35 + beat * .18})`;
    ctx.lineWidth = 1.1;
    ctx.stroke(path);

    ctx.clip(path);
    const reflection = ctx.createLinearGradient(cx - base, cy - base, cx + base * .4, cy + base);
    reflection.addColorStop(0, 'rgba(255,255,255,.27)');
    reflection.addColorStop(.18, 'rgba(255,255,255,.03)');
    reflection.addColorStop(.5, 'rgba(255,255,255,0)');
    reflection.addColorStop(.82, `rgba(113,160,174,${.05 + beat * .08})`);
    reflection.addColorStop(1, 'rgba(255,255,255,.02)');
    ctx.fillStyle = reflection;
    ctx.fillRect(cx - base * 1.6, cy - base * 1.6, base * 3.2, base * 3.2);

    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = `rgba(235,247,248,${.17 + beat * .18})`;
    ctx.lineWidth = Math.max(1, base * .018);
    ctx.beginPath();
    ctx.arc(cx - base * .18, cy - base * .18, base * .58, Math.PI * 1.03, Math.PI * 1.58);
    ctx.stroke();
    ctx.restore();

    const floor = ctx.createRadialGradient(cx, cy + base * 1.05, 0, cx, cy + base * 1.05, base * 1.7);
    floor.addColorStop(0, `rgba(118,151,160,${.09 + beat * .06})`);
    floor.addColorStop(.35, 'rgba(20,26,28,.04)');
    floor.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = floor;
    ctx.fillRect(cx - base * 2, cy + base * .7, base * 4, base * 1.6);
  }

  function frame(now) {
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000));
    last = now;
    resize();
    analyse(dt);
    phase += dt * (1.2 + mids * 3 + beat * 8);
    draw(now / 1000);

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seek.max = audio.duration;
      if (!seek.matches(':active')) seek.value = audio.currentTime;
      timeNow.textContent = formatTime(audio.currentTime);
      timeTotal.textContent = formatTime(audio.duration);
    }
    requestAnimationFrame(frame);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00';
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }

  function showControls() {
    controls.classList.remove('hidden');
    clearTimeout(hideTimer);
    if (!audio.paused) hideTimer = setTimeout(() => controls.classList.add('hidden'), 4300);
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    audio.load();
    trackName.textContent = file.name.replace(/\.[^.]+$/, '');
    playBtn.disabled = false;
    seek.disabled = false;
    showControls();
  });

  playBtn.addEventListener('click', async () => {
    if (audio.paused) {
      try {
        ensureAudio();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        await audio.play();
      } catch (error) {
        trackName.textContent = 'Playback failed — tap Play again';
      }
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => {
    playBtn.textContent = 'Ⅱ';
    playBtn.setAttribute('aria-label', 'Pause');
    showControls();
  });
  audio.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
    clearTimeout(hideTimer);
  });
  audio.addEventListener('ended', () => {
    playBtn.textContent = '▶';
    showControls();
  });
  seek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value);
  });

  fullBtn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {}
  });
  menuBtn.addEventListener('click', showControls);
  canvas.addEventListener('pointerdown', () => {
    if (controls.classList.contains('hidden')) showControls();
  });
  window.addEventListener('resize', resize, { passive: true });

  resize();
  requestAnimationFrame(frame);
})();
