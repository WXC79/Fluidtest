(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const ctx = stage.getContext('2d', { alpha: false });
  const audio = document.getElementById('audio');
  const fileInput = document.getElementById('fileInput');
  const trackName = document.getElementById('trackName');
  const queueCount = document.getElementById('queueCount');
  const playBtn = document.getElementById('playBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const fullBtn = document.getElementById('fullBtn');
  const seek = document.getElementById('seek');
  const timeNow = document.getElementById('timeNow');
  const timeTotal = document.getElementById('timeTotal');
  const reactivity = document.getElementById('reactivity');
  const statusEl = document.getElementById('status');
  const growthReadout = document.getElementById('growthReadout');
  const controls = document.getElementById('controls');
  const menuBtn = document.getElementById('menuBtn');

  const CULTURE_SIZE = 900;
  const CULTURE_CENTER = CULTURE_SIZE / 2;
  const CULTURE_RADIUS = 416;
  const growthCanvas = document.createElement('canvas');
  growthCanvas.width = CULTURE_SIZE;
  growthCanvas.height = CULTURE_SIZE;
  const growthCtx = growthCanvas.getContext('2d');
  const agarTexture = document.createElement('canvas');
  agarTexture.width = 600;
  agarTexture.height = 600;
  const agarCtx = agarTexture.getContext('2d');

  const PALETTE = [
    [122, 255, 203],
    [72, 225, 238],
    [202, 133, 255],
    [247, 242, 196],
    [255, 130, 118]
  ];

  let width = 1;
  let height = 1;
  let dpr = 1;
  let playlist = [];
  let playlistIndex = -1;
  let audioCtx = null;
  let sourceNode = null;
  let analyser = null;
  let leftAnalyser = null;
  let rightAnalyser = null;
  let splitter = null;
  let meterSink = null;
  let frequency = null;
  let previousFrequency = null;
  let timeDomain = null;
  let leftFrequency = null;
  let rightFrequency = null;
  let rng = Math.random;
  let lastFrame = performance.now();
  let hideTimer = 0;
  let screenWakeLock = null;
  let growthClock = 0;
  let cellAccumulator = 0;
  let colonyAccumulator = 0;
  let mutationCooldown = 0;
  let growthMarks = 0;
  let lastSeekValue = 0;

  const agents = [];
  const colonies = [];
  const liveBursts = [];
  const condensation = [];

  const F = {
    sub: 0, low: 0, mid: 0, presence: 0, high: 0,
    overall: 0, flux: 0, centroid: .35, stereo: 0,
    kick: 0, snap: 0, glitch: 0
  };
  const baseline = { sub: .05, low: .05, mid: .045, presence: .035, high: .022, overall: .05, flux: .006 };
  const previousRaw = { sub: 0, low: 0, mid: 0, presence: 0, high: 0, overall: 0 };

  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const smooth = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
  const lerp = (a, b, t) => a + (b - a) * t;

  function mulberry32(seed) {
    return function random() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function rgba(color, alpha) {
    return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
  }

  function buildAgarTexture() {
    agarCtx.clearRect(0, 0, agarTexture.width, agarTexture.height);
    const image = agarCtx.createImageData(agarTexture.width, agarTexture.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const grain = Math.floor((Math.random() - .5) * 15);
      image.data[i] = 19 + grain;
      image.data[i + 1] = 54 + grain;
      image.data[i + 2] = 51 + grain;
      image.data[i + 3] = 34;
    }
    agarCtx.putImageData(image, 0, 0);
    agarCtx.globalAlpha = .11;
    for (let i = 0; i < 160; i++) {
      const x = Math.random() * 600;
      const y = Math.random() * 600;
      const radius = .5 + Math.random() * 2.5;
      agarCtx.fillStyle = Math.random() > .5 ? '#d6fff0' : '#032522';
      agarCtx.beginPath();
      agarCtx.arc(x, y, radius, 0, Math.PI * 2);
      agarCtx.fill();
    }
    agarCtx.globalAlpha = 1;
  }

  function rebuildCondensation() {
    condensation.length = 0;
    const random = mulberry32(71591);
    for (let i = 0; i < 54; i++) {
      const angle = random() * Math.PI * 2;
      const radial = Math.sqrt(random()) * .92;
      condensation.push({
        x: Math.cos(angle) * radial,
        y: Math.sin(angle) * radial,
        radius: .004 + random() * .012,
        alpha: .035 + random() * .09
      });
    }
  }

  function resetFeatures() {
    Object.assign(F, {
      sub: 0, low: 0, mid: 0, presence: 0, high: 0,
      overall: 0, flux: 0, centroid: .35, stereo: 0,
      kick: 0, snap: 0, glitch: 0
    });
    Object.assign(baseline, { sub: .05, low: .05, mid: .045, presence: .035, high: .022, overall: .05, flux: .006 });
    Object.assign(previousRaw, { sub: 0, low: 0, mid: 0, presence: 0, high: 0, overall: 0 });
    if (previousFrequency) previousFrequency.fill(0);
  }

  function resetCulture(label = '') {
    growthCtx.clearRect(0, 0, CULTURE_SIZE, CULTURE_SIZE);
    agents.length = 0;
    colonies.length = 0;
    liveBursts.length = 0;
    growthClock = 0;
    cellAccumulator = 0;
    colonyAccumulator = 0;
    mutationCooldown = 0;
    growthMarks = 0;
    rng = mulberry32(hashText(`${label}-${Date.now()}`));
    resetFeatures();
    statusEl.textContent = 'STERILE';
    growthReadout.textContent = '0% GROWTH';
  }

  function ensureAudioGraph() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .30;
    splitter = audioCtx.createChannelSplitter(2);
    leftAnalyser = audioCtx.createAnalyser();
    rightAnalyser = audioCtx.createAnalyser();
    leftAnalyser.fftSize = 256;
    rightAnalyser.fftSize = 256;
    leftAnalyser.smoothingTimeConstant = .48;
    rightAnalyser.smoothingTimeConstant = .48;
    meterSink = audioCtx.createGain();
    meterSink.gain.value = 0;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    sourceNode.connect(splitter);
    splitter.connect(leftAnalyser, 0);
    splitter.connect(rightAnalyser, 1);
    leftAnalyser.connect(meterSink);
    rightAnalyser.connect(meterSink);
    meterSink.connect(audioCtx.destination);
    frequency = new Uint8Array(analyser.frequencyBinCount);
    previousFrequency = new Uint8Array(analyser.frequencyBinCount);
    timeDomain = new Uint8Array(analyser.fftSize);
    leftFrequency = new Uint8Array(leftAnalyser.frequencyBinCount);
    rightFrequency = new Uint8Array(rightAnalyser.frequencyBinCount);
  }

  function bandEnergy(data, lowHz, highHz, sampleRate = audioCtx.sampleRate) {
    if (!data || !audioCtx) return 0;
    const nyquist = sampleRate * .5;
    const first = Math.max(0, Math.floor(lowHz / nyquist * data.length));
    const last = Math.min(data.length - 1, Math.ceil(highHz / nyquist * data.length));
    let sum = 0;
    let count = 0;
    for (let i = first; i <= last; i++) {
      const value = data[i] / 255;
      sum += value * value;
      count++;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  function adaptiveTarget(raw, key, absoluteScale, dt) {
    const base = baseline[key];
    baseline[key] = smooth(base, raw, .38, dt);
    const absolute = clamp((raw - .006) * absoluteScale);
    const relative = clamp((raw / Math.max(.009, baseline[key]) - .91) * 1.55);
    return clamp(absolute * .78 + relative * .52);
  }

  function analyseAudio(dt) {
    if (!analyser || audio.paused) {
      for (const key of ['sub', 'low', 'mid', 'presence', 'high', 'overall', 'flux', 'kick', 'snap', 'glitch']) {
        F[key] = smooth(F[key], 0, 5, dt);
      }
      F.stereo = smooth(F.stereo, 0, 3, dt);
      return;
    }

    analyser.getByteFrequencyData(frequency);
    analyser.getByteTimeDomainData(timeDomain);
    leftAnalyser.getByteFrequencyData(leftFrequency);
    rightAnalyser.getByteFrequencyData(rightFrequency);

    const raw = {
      sub: bandEnergy(frequency, 22, 85),
      low: bandEnergy(frequency, 85, 230),
      mid: bandEnergy(frequency, 230, 1200),
      presence: bandEnergy(frequency, 1200, 4200),
      high: bandEnergy(frequency, 4200, 16000),
      overall: 0
    };
    let rms = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const value = (timeDomain[i] - 128) / 128;
      rms += value * value;
    }
    raw.overall = Math.sqrt(rms / timeDomain.length);

    let flux = 0;
    let magnitude = 0;
    let weighted = 0;
    for (let i = 1; i < frequency.length; i++) {
      const value = frequency[i] / 255;
      const rise = frequency[i] - previousFrequency[i];
      if (rise > 0) flux += rise / 255;
      previousFrequency[i] = frequency[i];
      magnitude += value;
      weighted += value * i;
    }
    flux /= frequency.length;
    const centroid = magnitude ? weighted / magnitude / frequency.length : .35;
    const response = Number(reactivity.value);
    const targets = {
      sub: adaptiveTarget(raw.sub, 'sub', 3.4, dt),
      low: adaptiveTarget(raw.low, 'low', 3.25, dt),
      mid: adaptiveTarget(raw.mid, 'mid', 3.0, dt),
      presence: adaptiveTarget(raw.presence, 'presence', 3.5, dt),
      high: adaptiveTarget(raw.high, 'high', 4.6, dt),
      overall: adaptiveTarget(raw.overall, 'overall', 3.2, dt),
      flux: adaptiveTarget(flux, 'flux', 12, dt)
    };

    const lowRise = clamp((raw.sub - previousRaw.sub) * 11 + (raw.low - previousRaw.low) * 9);
    const midRise = clamp((raw.mid - previousRaw.mid) * 11 + (raw.presence - previousRaw.presence) * 7);
    const highRise = clamp((raw.high - previousRaw.high) * 15 + flux * 5);
    Object.assign(previousRaw, raw);

    F.kick = Math.max(F.kick, clamp((lowRise * 1.2 + targets.sub * .30 + targets.low * .24) * response));
    F.snap = Math.max(F.snap, clamp((midRise * 1.15 + targets.presence * .24 + targets.flux * .22) * response));
    F.glitch = Math.max(F.glitch, clamp((highRise * 1.05 + targets.flux * .75 + targets.high * .24) * response));
    F.kick = smooth(F.kick, 0, 5.0, dt);
    F.snap = smooth(F.snap, 0, 7.0, dt);
    F.glitch = smooth(F.glitch, 0, 10.5, dt);
    for (const key of ['sub', 'low', 'mid', 'presence', 'high', 'overall', 'flux']) {
      const target = clamp(targets[key] * response);
      F[key] = smooth(F[key], target, target > F[key] ? 14 : 4.5, dt);
    }
    F.centroid = smooth(F.centroid, clamp(centroid * 1.6), 4, dt);

    const left = bandEnergy(leftFrequency, 35, 12000);
    const right = bandEnergy(rightFrequency, 35, 12000);
    const stereo = (right - left) / Math.max(.015, right + left);
    F.stereo = smooth(F.stereo, clamp(stereo * 2.4, -1, 1), 7, dt);
  }

  function culturePoint(margin = 28, stereoBias = 0) {
    const angle = rng() * Math.PI * 2;
    const radial = Math.sqrt(rng()) * (CULTURE_RADIUS - margin);
    return {
      x: CULTURE_CENTER + Math.cos(angle) * radial + stereoBias * 90,
      y: CULTURE_CENTER + Math.sin(angle) * radial
    };
  }

  function insideCulture(x, y, margin = 10) {
    return Math.hypot(x - CULTURE_CENTER, y - CULTURE_CENTER) < CULTURE_RADIUS - margin;
  }

  function spawnAgent(x, y, angle, generation = 0, colorIndex = 0) {
    if (agents.length >= 100) return;
    agents.push({
      x, y, px: x, py: y, angle,
      age: 0,
      life: 2.8 + rng() * 6.5,
      generation,
      colorIndex,
      width: Math.max(.55, 2.4 - generation * .23 + rng() * 1.7),
      curl: rng() * 10,
      branchDelay: .25 + rng() * .9
    });
  }

  function seedCulture() {
    if (agents.length) return;
    const seedCount = 4;
    for (let i = 0; i < seedCount; i++) {
      const point = culturePoint(170, F.stereo * .18);
      const color = i % 3;
      spawnAgent(point.x, point.y, rng() * Math.PI * 2, 0, color);
      spawnColony(.22 + rng() * .18, color, point);
    }
  }

  function spawnColony(strength = .4, colorIndex = 0, at = null) {
    if (colonies.length >= 58) return;
    const point = at || culturePoint(58, F.stereo);
    const radius = 2 + rng() * 4;
    colonies.push({
      x: point.x, y: point.y,
      radius,
      maxRadius: 18 + strength * 68 + rng() * 28,
      speed: .6 + strength * 3.5 + rng() * 1.8,
      phase: rng() * Math.PI * 2,
      lobes: 5 + Math.floor(rng() * 8),
      colorIndex: colorIndex % PALETTE.length,
      opacity: .12 + strength * .13,
      dormant: false
    });
    const color = PALETTE[colorIndex % PALETTE.length];
    const gradient = growthCtx.createRadialGradient(point.x - 2, point.y - 2, 0, point.x, point.y, radius * 2.4);
    gradient.addColorStop(0, rgba(color, .42));
    gradient.addColorStop(.35, rgba(color, .18));
    gradient.addColorStop(1, rgba(color, 0));
    growthCtx.fillStyle = gradient;
    growthCtx.beginPath();
    growthCtx.arc(point.x, point.y, radius * 2.4, 0, Math.PI * 2);
    growthCtx.fill();
  }

  function drawColonyGrowth(colony, dt, durationScale) {
    if (colony.dormant) return;
    const drive = .18 + F.low * 1.4 + F.sub * .9 + F.kick * 2.4;
    colony.radius += colony.speed * drive * dt * durationScale;
    if (colony.radius >= colony.maxRadius) {
      colony.radius = colony.maxRadius;
      colony.dormant = true;
    }
    const color = PALETTE[colony.colorIndex];
    const points = 70;
    growthCtx.save();
    growthCtx.globalCompositeOperation = 'source-over';
    growthCtx.strokeStyle = rgba(color, colony.opacity * (.55 + F.low * .65));
    growthCtx.lineWidth = .5 + F.sub * 1.4;
    growthCtx.shadowColor = rgba(color, .20);
    growthCtx.shadowBlur = 2 + F.low * 4;
    growthCtx.beginPath();
    for (let i = 0; i <= points; i++) {
      const angle = i / points * Math.PI * 2;
      const rough = Math.sin(angle * colony.lobes + colony.phase) * (.6 + colony.radius * .032)
        + Math.sin(angle * (colony.lobes * 2 + 3) - colony.phase * .7) * colony.radius * .012;
      const radius = colony.radius + rough;
      const x = colony.x + Math.cos(angle) * radius;
      const y = colony.y + Math.sin(angle) * radius;
      if (!i) growthCtx.moveTo(x, y); else growthCtx.lineTo(x, y);
    }
    growthCtx.closePath();
    growthCtx.stroke();
    if (Math.floor(colony.radius) % 4 === 0) {
      growthCtx.globalAlpha = .018 + F.low * .018;
      growthCtx.fillStyle = rgba(color, .35);
      growthCtx.fill();
    }
    growthCtx.restore();
    growthMarks++;
  }

  function updateAgents(dt, durationScale) {
    const liveCount = agents.length;
    for (let i = liveCount - 1; i >= 0; i--) {
      const agent = agents[i];
      agent.age += dt * durationScale;
      agent.branchDelay -= dt;
      agent.px = agent.x;
      agent.py = agent.y;
      const bandTurn = Math.sin(growthClock * (1.3 + F.presence * 2.2) + agent.curl) * (.35 + F.mid * 1.2);
      const glitchTurn = (rng() - .5) * F.glitch * 1.9;
      const inward = Math.atan2(CULTURE_CENTER - agent.y, CULTURE_CENTER - agent.x);
      if (!insideCulture(agent.x, agent.y, 32)) {
        const delta = Math.atan2(Math.sin(inward - agent.angle), Math.cos(inward - agent.angle));
        agent.angle += delta * .38;
      }
      agent.angle += (bandTurn * .022 + glitchTurn * .11) * durationScale;
      const speed = (5 + F.mid * 28 + F.presence * 20 + F.overall * 10) * durationScale;
      agent.x += Math.cos(agent.angle) * speed * dt;
      agent.y += Math.sin(agent.angle) * speed * dt;

      const color = PALETTE[agent.colorIndex % PALETTE.length];
      growthCtx.save();
      growthCtx.lineCap = 'round';
      growthCtx.lineJoin = 'round';
      growthCtx.strokeStyle = rgba(color, .055 + F.mid * .12 + F.presence * .055);
      growthCtx.lineWidth = agent.width * (.65 + F.sub * .65);
      growthCtx.shadowColor = rgba(color, .25);
      growthCtx.shadowBlur = 1 + F.high * 3;
      growthCtx.beginPath();
      growthCtx.moveTo(agent.px, agent.py);
      growthCtx.quadraticCurveTo(
        (agent.px + agent.x) * .5 + Math.sin(agent.age * 3 + agent.curl) * 1.4,
        (agent.py + agent.y) * .5 + Math.cos(agent.age * 2.7 + agent.curl) * 1.4,
        agent.x, agent.y
      );
      growthCtx.stroke();
      growthCtx.restore();
      growthMarks++;

      const branchChance = dt * durationScale * (.04 + F.mid * .32 + F.snap * .82 + F.glitch * .25);
      if (agent.branchDelay <= 0 && agent.generation < 6 && rng() < branchChance) {
        const direction = rng() > .5 ? 1 : -1;
        spawnAgent(agent.x, agent.y, agent.angle + direction * (.28 + rng() * .58), agent.generation + 1, agent.colorIndex + (F.centroid > .55 ? 1 : 0));
        agent.branchDelay = .35 + rng() * 1.1;
      }
      if (agent.age > agent.life || !insideCulture(agent.x, agent.y, 4)) {
        if (agents.length < 26 && insideCulture(agent.x, agent.y, 30)) {
          spawnAgent(agent.x, agent.y, agent.angle + (rng() - .5) * 1.2, Math.max(0, agent.generation - 2), agent.colorIndex + 1);
        }
        agents.splice(i, 1);
      }
    }
  }

  function drawMicroCell(x, y, colorIndex, strength) {
    const color = PALETTE[colorIndex % PALETTE.length];
    const angle = rng() * Math.PI * 2;
    const length = 1.2 + rng() * (3.5 + strength * 4.5);
    const radius = .45 + rng() * 1.15;
    growthCtx.save();
    growthCtx.translate(x, y);
    growthCtx.rotate(angle);
    growthCtx.strokeStyle = rgba(color, .14 + strength * .24);
    growthCtx.lineWidth = radius;
    growthCtx.lineCap = 'round';
    growthCtx.shadowColor = rgba(color, .30);
    growthCtx.shadowBlur = 1 + strength * 3;
    growthCtx.beginPath();
    growthCtx.moveTo(-length * .5, 0);
    growthCtx.lineTo(length * .5, 0);
    growthCtx.stroke();
    growthCtx.restore();
    growthMarks++;
  }

  function spawnMicroCells(dt, durationScale) {
    cellAccumulator += dt * durationScale * (1.2 + F.high * 38 + F.presence * 12 + F.glitch * 55);
    let count = Math.min(18, Math.floor(cellAccumulator));
    cellAccumulator -= count;
    while (count-- > 0) {
      let x;
      let y;
      if (agents.length && rng() < .68) {
        const agent = agents[Math.floor(rng() * agents.length)];
        x = agent.x + (rng() - .5) * (16 + F.high * 38);
        y = agent.y + (rng() - .5) * (16 + F.high * 38);
      } else {
        const point = culturePoint(28, F.stereo);
        x = point.x;
        y = point.y;
      }
      if (insideCulture(x, y, 8)) drawMicroCell(x, y, 1 + Math.floor(F.centroid * 3), clamp(F.high + F.glitch * .6));
    }
  }

  function triggerMutation() {
    const point = culturePoint(80, F.stereo);
    const colorIndex = 2 + Math.floor(rng() * 3);
    const color = PALETTE[colorIndex % PALETTE.length];
    const radius = 10 + F.glitch * 46 + rng() * 22;
    growthCtx.save();
    growthCtx.translate(point.x, point.y);
    growthCtx.rotate(rng() * Math.PI);
    growthCtx.strokeStyle = rgba(color, .16 + F.glitch * .22);
    growthCtx.lineWidth = .8 + F.glitch * 1.6;
    growthCtx.setLineDash([2 + rng() * 5, 3 + rng() * 8]);
    for (let ring = 0; ring < 3; ring++) {
      growthCtx.beginPath();
      growthCtx.ellipse(0, 0, radius * (1 + ring * .23), radius * (.30 + ring * .07), 0, 0, Math.PI * 2);
      growthCtx.stroke();
    }
    growthCtx.restore();
    liveBursts.push({ x: point.x, y: point.y, radius, life: 1, colorIndex });
    for (let i = 0; i < 3; i++) spawnAgent(point.x, point.y, rng() * Math.PI * 2, 2, colorIndex);
    spawnColony(.45 + F.glitch * .45, colorIndex, point);
  }

  function simulateGrowth(dt) {
    if (audio.paused || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    seedCulture();
    const durationScale = clamp(210 / audio.duration, .62, 1.8);
    growthClock += dt * durationScale;
    mutationCooldown -= dt;
    const progress = clamp(audio.currentTime / audio.duration);

    growthCtx.save();
    growthCtx.beginPath();
    growthCtx.arc(CULTURE_CENTER, CULTURE_CENTER, CULTURE_RADIUS, 0, Math.PI * 2);
    growthCtx.clip();
    updateAgents(dt, durationScale);
    for (const colony of colonies) drawColonyGrowth(colony, dt, durationScale);
    spawnMicroCells(dt, durationScale);

    colonyAccumulator += dt * durationScale * (.035 + F.low * .34 + F.kick * .72 + progress * .035);
    while (colonyAccumulator >= 1) {
      colonyAccumulator--;
      spawnColony(.25 + F.low * .45 + F.kick * .35, F.kick > .55 ? 4 : Math.floor(rng() * 3));
    }
    if (mutationCooldown <= 0 && F.glitch > .46) {
      triggerMutation();
      mutationCooldown = .18 + rng() * .55;
    }
    growthCtx.restore();

    statusEl.textContent = progress < .04 ? 'INOCULATING' : (F.glitch > .52 ? 'MUTATION EVENT' : 'CULTURING');
    growthReadout.textContent = `${Math.round(progress * 100)}% GROWTH`;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, innerWidth);
    height = Math.max(1, innerHeight);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (stage.width !== pixelWidth || stage.height !== pixelHeight) {
      stage.width = pixelWidth;
      stage.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function plateLayout() {
    const reserved = height < 590 ? 94 : 195;
    const availableHeight = Math.max(220, height - reserved);
    const radius = Math.max(112, Math.min(width * .445, availableHeight * .465, 340));
    const centerY = Math.max(radius + 32, availableHeight * .50 + 12);
    return { x: width * .5, y: centerY, radius };
  }

  function drawBackdrop(plate) {
    const backdrop = ctx.createRadialGradient(plate.x, plate.y, plate.radius * .2, plate.x, plate.y, Math.max(width, height) * .75);
    backdrop.addColorStop(0, '#eeece5');
    backdrop.addColorStop(.58, '#dcdbd4');
    backdrop.addColorStop(1, '#c7c6bf');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalAlpha = .035;
    ctx.fillStyle = '#23302d';
    for (let i = 0; i < 90; i++) {
      const x = ((i * 173) % 997) / 997 * width;
      const y = ((i * 311) % 991) / 991 * height;
      ctx.fillRect(x, y, .7, .7);
    }
    ctx.restore();
  }

  function drawLiveMembrane(plate) {
    if (!timeDomain || audio.paused) return;
    const samples = 180;
    const baseRadius = plate.radius * (.32 + F.low * .055);
    const amplitude = 2 + F.overall * 12 + F.glitch * 8;
    ctx.save();
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.radius * .93, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = `rgba(168,255,225,${.10 + F.overall * .28 + F.flux * .18})`;
    ctx.lineWidth = .7 + F.high * 1.2;
    ctx.shadowColor = 'rgba(100,255,216,.4)';
    ctx.shadowBlur = 4 + F.high * 10;
    ctx.beginPath();
    for (let i = 0; i <= samples; i++) {
      const angle = i / samples * Math.PI * 2;
      const sample = (timeDomain[Math.floor(i / samples * (timeDomain.length - 1))] - 128) / 128;
      const harmonic = Math.sin(angle * (5 + Math.floor(F.centroid * 8)) + growthClock * 1.7) * F.presence * 3;
      const radius = baseRadius + sample * amplitude + harmonic;
      const x = plate.x + Math.cos(angle) * radius;
      const y = plate.y + Math.sin(angle) * radius;
      if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawPlate(plate, dt) {
    ctx.save();
    ctx.translate(plate.x, plate.y + plate.radius * .07);
    ctx.scale(1, .18);
    const shadow = ctx.createRadialGradient(0, 0, plate.radius * .2, 0, 0, plate.radius * 1.3);
    shadow.addColorStop(0, 'rgba(12,25,23,.30)');
    shadow.addColorStop(.6, 'rgba(12,25,23,.15)');
    shadow.addColorStop(1, 'rgba(12,25,23,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(0, 0, plate.radius * 1.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(17,32,29,.26)';
    ctx.shadowBlur = 28;
    ctx.fillStyle = 'rgba(238,248,243,.52)';
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    const innerRadius = plate.radius * .908;
    ctx.save();
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, innerRadius, 0, Math.PI * 2);
    ctx.clip();
    const agar = ctx.createRadialGradient(
      plate.x - innerRadius * .30,
      plate.y - innerRadius * .36,
      innerRadius * .05,
      plate.x,
      plate.y,
      innerRadius * 1.08
    );
    agar.addColorStop(0, '#315e59');
    agar.addColorStop(.30, '#183f3b');
    agar.addColorStop(.72, '#0b2b29');
    agar.addColorStop(1, '#061d1c');
    ctx.fillStyle = agar;
    ctx.fillRect(plate.x - innerRadius, plate.y - innerRadius, innerRadius * 2, innerRadius * 2);
    ctx.globalAlpha = .44;
    ctx.drawImage(agarTexture, plate.x - innerRadius, plate.y - innerRadius, innerRadius * 2, innerRadius * 2);
    ctx.globalAlpha = 1;
    ctx.drawImage(growthCanvas, plate.x - innerRadius, plate.y - innerRadius, innerRadius * 2, innerRadius * 2);

    for (let i = liveBursts.length - 1; i >= 0; i--) {
      const burst = liveBursts[i];
      burst.life -= dt * 2.5;
      if (burst.life <= 0) {
        liveBursts.splice(i, 1);
        continue;
      }
      const x = plate.x - innerRadius + burst.x / CULTURE_SIZE * innerRadius * 2;
      const y = plate.y - innerRadius + burst.y / CULTURE_SIZE * innerRadius * 2;
      const radius = burst.radius / CULTURE_SIZE * innerRadius * 2 * (1.4 - burst.life * .35);
      const color = PALETTE[burst.colorIndex % PALETTE.length];
      ctx.strokeStyle = rgba(color, burst.life * .35);
      ctx.lineWidth = .7;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    drawLiveMembrane(plate);

    const rim = ctx.createRadialGradient(
      plate.x - plate.radius * .35,
      plate.y - plate.radius * .40,
      plate.radius * .2,
      plate.x,
      plate.y,
      plate.radius
    );
    rim.addColorStop(.78, 'rgba(255,255,255,0)');
    rim.addColorStop(.88, 'rgba(239,252,247,.20)');
    rim.addColorStop(.94, 'rgba(255,255,255,.68)');
    rim.addColorStop(1, 'rgba(117,143,137,.24)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.72)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(64,91,85,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.radius * .925, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.radius * .97, 0, Math.PI * 2);
    ctx.clip();
    for (const drop of condensation) {
      const x = plate.x + drop.x * plate.radius;
      const y = plate.y + drop.y * plate.radius;
      const radius = drop.radius * plate.radius;
      const gradient = ctx.createRadialGradient(x - radius * .3, y - radius * .4, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(255,255,255,${drop.alpha * 2.4})`);
      gradient.addColorStop(.45, `rgba(255,255,255,${drop.alpha})`);
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.36)';
    ctx.lineWidth = plate.radius * .028;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.radius * .945, Math.PI * 1.12, Math.PI * 1.53);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00';
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }

  function updateQueue() {
    const total = playlist.length;
    queueCount.textContent = total ? `${playlistIndex + 1} / ${total}` : '—';
    prevBtn.disabled = playlistIndex <= 0;
    nextBtn.disabled = playlistIndex < 0 || playlistIndex >= total - 1;
  }

  function loadTrack(index, autoplay = false) {
    if (!playlist.length) return;
    playlistIndex = clamp(index, 0, playlist.length - 1);
    const item = playlist[playlistIndex];
    audio.pause();
    audio.src = item.url;
    audio.load();
    trackName.textContent = item.name.replace(/\.[^.]+$/, '');
    timeNow.textContent = '0:00';
    timeTotal.textContent = '0:00';
    seek.value = 0;
    resetCulture(item.name);
    updateQueue();
    playBtn.disabled = false;
    seek.disabled = false;
    showControls();
    if (autoplay) startPlayback();
  }

  async function startPlayback() {
    try {
      ensureAudioGraph();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await audio.play();
      requestWakeLock();
    } catch (error) {
      statusEl.textContent = 'PLAYBACK ERROR';
      showControls();
    }
  }

  function showControls() {
    controls.classList.remove('hidden');
    clearTimeout(hideTimer);
    if (!audio.paused) hideTimer = setTimeout(() => controls.classList.add('hidden'), 4800);
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      if (!screenWakeLock) {
        screenWakeLock = await navigator.wakeLock.request('screen');
        screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
      }
    } catch (_) {}
  }

  async function releaseWakeLock() {
    if (!screenWakeLock) return;
    try { await screenWakeLock.release(); } catch (_) {}
    screenWakeLock = null;
  }

  function frame(now) {
    const dt = Math.min(.05, Math.max(.001, (now - lastFrame) / 1000));
    lastFrame = now;
    resize();
    analyseAudio(dt);
    simulateGrowth(dt);
    const plate = plateLayout();
    drawBackdrop(plate);
    drawPlate(plate, dt);

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seek.max = audio.duration;
      if (!seek.matches(':active')) seek.value = audio.currentTime;
      lastSeekValue = audio.currentTime;
      timeNow.textContent = formatTime(audio.currentTime);
      timeTotal.textContent = formatTime(audio.duration);
    }
    requestAnimationFrame(frame);
  }

  fileInput.addEventListener('change', () => {
    for (const item of playlist) URL.revokeObjectURL(item.url);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const files = Array.from(fileInput.files || []).sort((a, b) => collator.compare(a.name, b.name));
    playlist = files.map(file => ({ name: file.name, url: URL.createObjectURL(file) }));
    if (playlist.length) loadTrack(0, false);
  });

  playBtn.addEventListener('click', async () => {
    if (audio.paused) await startPlayback();
    else audio.pause();
  });
  prevBtn.addEventListener('click', () => loadTrack(playlistIndex - 1, !audio.paused));
  nextBtn.addEventListener('click', () => loadTrack(playlistIndex + 1, !audio.paused));

  audio.addEventListener('play', () => {
    playBtn.textContent = 'Ⅱ';
    playBtn.setAttribute('aria-label', 'Pause');
    statusEl.textContent = audio.currentTime < .5 ? 'INOCULATING' : 'CULTURING';
    showControls();
  });
  audio.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
    clearTimeout(hideTimer);
    if (!audio.ended && audio.currentTime > 0) statusEl.textContent = 'CULTURE PAUSED';
    releaseWakeLock();
  });
  audio.addEventListener('ended', () => {
    if (playlistIndex < playlist.length - 1) loadTrack(playlistIndex + 1, true);
    else {
      playBtn.textContent = '▶';
      statusEl.textContent = 'CULTURE COMPLETE';
      growthReadout.textContent = '100% GROWTH';
      showControls();
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration)) {
      seek.max = audio.duration;
      timeTotal.textContent = formatTime(audio.duration);
    }
  });
  seek.addEventListener('input', () => {
    if (!Number.isFinite(audio.duration)) return;
    const target = Number(seek.value);
    if (Math.abs(target - lastSeekValue) > 2) resetCulture(playlist[playlistIndex]?.name || 'seek');
    audio.currentTime = target;
    lastSeekValue = target;
  });
  fullBtn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {}
  });
  menuBtn.addEventListener('click', showControls);
  stage.addEventListener('pointerdown', () => {
    if (controls.classList.contains('hidden')) showControls();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      audio.pause();
      releaseWakeLock();
    } else if (!audio.paused) requestWakeLock();
  });
  window.addEventListener('resize', resize, { passive: true });

  buildAgarTexture();
  rebuildCondensation();
  resetCulture('initial');
  resize();
  requestAnimationFrame(frame);
})();
