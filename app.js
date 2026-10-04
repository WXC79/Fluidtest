(() => {
  'use strict';

  const canvas = document.getElementById('stage');
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

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance'
  });

  if (!gl) {
    trackName.textContent = 'This test requires WebGL 2';
    fileInput.disabled = true;
    return;
  }

  const vertexSource = `#version 300 es
    precision highp float;
    const vec2 P[3] = vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
    out vec2 vUv;
    void main(){ vec2 p=P[gl_VertexID]; vUv=p*.5+.5; gl_Position=vec4(p,0.,1.); }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec4 uBlobs[24];
    uniform vec4 uAudio;

    float hash(vec2 p){
      p=fract(p*vec2(123.34,456.21));
      p+=dot(p,p+45.32);
      return fract(p.x*p.y);
    }

    float potential(vec2 p){
      float field=0.;
      for(int i=0;i<24;i++){
        vec4 b=uBlobs[i];
        vec2 d=p-b.xy;
        float rr=b.z;
        float support=rr*1.70;
        float q=dot(d,d)/(support*support);
        field+=pow(max(0.,1.-q),2.);
      }
      return field;
    }

    void main(){
      vec2 p=vUv*2.-1.;
      p.x*=uResolution.x/max(1.,uResolution.y);
      float f=potential(p);
      float eps=.0045;
      vec2 grad=vec2(
        potential(p+vec2(eps,0.))-potential(p-vec2(eps,0.)),
        potential(p+vec2(0.,eps))-potential(p-vec2(0.,eps))
      );
      vec2 n2=normalize(-grad+vec2(.0001));
      vec3 normal=normalize(vec3(n2*.82,.72));
      float mask=smoothstep(.40,.49,f);
      float edge=smoothstep(.24,.42,f)-smoothstep(.48,.68,f);

      vec3 yellow=vec3(.957,.812,.035);
      float paper=(hash(floor(vUv*uResolution*.32))-.5)*.014;
      vec3 bg=yellow+paper;

      vec3 light=normalize(vec3(-.55,.72,.8));
      vec3 light2=normalize(vec3(.70,-.20,.45));
      float broad=pow(max(0.,dot(normal,light)),2.2);
      float hard=pow(max(0.,dot(normal,light)),18.);
      float rim=pow(1.-max(0.,normal.z),2.4);
      float lower=pow(max(0.,dot(normal,light2)),8.);
      float oily=.5+.5*sin(p.x*8.-p.y*5.+uTime*.18+f*.14);

      vec3 fluid=vec3(.004,.005,.004);
      fluid+=vec3(.12,.13,.115)*broad;
      fluid+=vec3(.78,.81,.72)*hard;
      fluid+=vec3(.10,.095,.055)*lower;
      fluid+=vec3(.045,.038,.012)*oily*uAudio.w;
      fluid+=vec3(.16,.16,.13)*rim;

      float shadow=potential(p-vec2(.024,-.035));
      bg*=1.-smoothstep(.18,.52,shadow)*.17*(1.-mask);
      bg=mix(bg,vec3(.20,.17,.015),edge*.14);
      vec3 color=mix(bg,fluid,mask);
      outColor=vec4(color,1.);
    }
  `;

  function shader(type, sourceText) {
    const item = gl.createShader(type);
    gl.shaderSource(item, sourceText);
    gl.compileShader(item);
    if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(item));
    return item;
  }

  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (error) {
    trackName.textContent = `Visual error: ${error.message}`;
    return;
  }
  gl.useProgram(program);

  const uniforms = {
    resolution: gl.getUniformLocation(program, 'uResolution'),
    time: gl.getUniformLocation(program, 'uTime'),
    blobs: gl.getUniformLocation(program, 'uBlobs[0]'),
    audio: gl.getUniformLocation(program, 'uAudio')
  };

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let frequency = null;
  let previous = null;
  let objectUrl = null;
  let lowBase = .07;
  let midBase = .06;
  let highBase = .035;
  let fluxBase = .008;
  let previousLow = 0;
  let previousMid = 0;
  let previousHigh = 0;
  let bass = 0;
  let mids = 0;
  let highs = 0;
  let activity = 0;
  let bassHit = 0;
  let midHit = 0;
  let highHit = 0;
  let phase = 0;
  let last = performance.now();
  let hideTimer = 0;
  const blobData = new Float32Array(24 * 4);
  const lobes = Array.from({ length: 6 }, (_, i) => ({
    x: 0, y: 0, vx: 0, vy: 0,
    angle: i / 6 * Math.PI * 2,
    bias: .82 + ((i * 37) % 29) / 100,
    seed: 1.7 + i * 2.31,
    reach: 0
  }));

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .28;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    frequency = new Uint8Array(analyser.frequencyBinCount);
    previous = new Uint8Array(analyser.frequencyBinCount);
  }

  function band(lowHz, highHz) {
    if (!frequency || !audioCtx) return 0;
    const nyquist = audioCtx.sampleRate * .5;
    const first = Math.max(0, Math.floor(lowHz / nyquist * frequency.length));
    const lastBin = Math.min(frequency.length - 1, Math.ceil(highHz / nyquist * frequency.length));
    let sum = 0;
    let count = 0;
    for (let i = first; i <= lastBin; i++) {
      const value = frequency[i] / 255;
      sum += value * value;
      count++;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  function analyse(dt) {
    if (!analyser || audio.paused) {
      bass = smooth(bass, .06, 2.8, dt);
      mids = smooth(mids, .05, 2.8, dt);
      highs = smooth(highs, .035, 3.2, dt);
      activity = smooth(activity, .07, 2.2, dt);
      bassHit = smooth(bassHit, 0, 5.2, dt);
      midHit = smooth(midHit, 0, 6.2, dt);
      highHit = smooth(highHit, 0, 9, dt);
      return;
    }

    analyser.getByteFrequencyData(frequency);
    const rawLow = band(24, 190);
    const rawMid = band(190, 3000);
    const rawHigh = band(3000, 16000);
    let flux = 0;
    for (let i = 1; i < frequency.length; i++) {
      const rise = frequency[i] - previous[i];
      if (rise > 0) flux += rise / 255;
      previous[i] = frequency[i];
    }
    flux /= frequency.length;

    const adapt = Math.min(1, dt * .42);
    lowBase += (rawLow - lowBase) * adapt;
    midBase += (rawMid - midBase) * adapt;
    highBase += (rawHigh - highBase) * adapt;
    fluxBase += (flux - fluxBase) * Math.min(1, dt * .75);
    const response = Number(impact.value);
    const lowLevel = clamp((rawLow - .012) * 3.6);
    const midLevel = clamp((rawMid - .010) * 3.25);
    const highLevel = clamp((rawHigh - .006) * 4.8);
    const lowRelative = clamp((rawLow / Math.max(.022, lowBase) - .90) * 1.65);
    const midRelative = clamp((rawMid / Math.max(.018, midBase) - .91) * 1.55);
    const highRelative = clamp((rawHigh / Math.max(.010, highBase) - .90) * 1.45);
    const fluxRelative = clamp((flux / Math.max(.0025, fluxBase) - .88) * .85);
    const lowRise = clamp((rawLow - previousLow) * 12.);
    const midRise = clamp((rawMid - previousMid) * 11.);
    const highRise = clamp((rawHigh - previousHigh) * 13.);
    previousLow = rawLow;
    previousMid = rawMid;
    previousHigh = rawHigh;

    const lowTarget = clamp((lowLevel * .82 + lowRelative * .52) * response);
    const midTarget = clamp((midLevel * .84 + midRelative * .50) * response);
    const highTarget = clamp((highLevel * .88 + highRelative * .48 + fluxRelative * .20) * response);
    const lowEvent = clamp(lowRise * 1.35 + Math.max(0, lowRelative - .20) * .75 + fluxRelative * .08);
    const midEvent = clamp(midRise * 1.28 + Math.max(0, midRelative - .18) * .70 + fluxRelative * .18);
    const highEvent = clamp(highRise * 1.30 + Math.max(0, highRelative - .15) * .72 + fluxRelative * .42);

    bassHit = Math.max(bassHit, lowEvent * response);
    midHit = Math.max(midHit, midEvent * response);
    highHit = Math.max(highHit, highEvent * response);
    bassHit = smooth(bassHit, 0, 3.7, dt);
    midHit = smooth(midHit, 0, 4.8, dt);
    highHit = smooth(highHit, 0, 7.2, dt);
    bass = smooth(bass, lowTarget, lowTarget > bass ? 13 : 3.5, dt);
    mids = smooth(mids, midTarget, midTarget > mids ? 12 : 3.8, dt);
    highs = smooth(highs, highTarget, highTarget > highs ? 15 : 5.2, dt);
    const busy = clamp(lowTarget * .34 + midTarget * .46 + highTarget * .34 + Math.max(lowEvent, midEvent, highEvent) * .30);
    activity = smooth(activity, busy, busy > activity ? 10 : 2.1, dt);
  }

  function setBlob(index, x, y, radius, seed) {
    const at = index * 4;
    blobData[at] = x;
    blobData[at + 1] = y;
    blobData[at + 2] = radius;
    blobData[at + 3] = seed;
  }

  function updateFluid(dt, t) {
    phase += dt * (.16 + mids * 1.25 + midHit * 2.4 + highs * .30);
    const aspect = canvas.width / Math.max(1, canvas.height);
    const portrait = aspect < .85;
    const baseScale = portrait ? .86 : 1;
    const centerX = Math.sin(t * .29) * .026 + Math.sin(t * 3.1) * bassHit * .065;
    const centerY = Math.cos(t * .25) * .020 - bassHit * .060;
    setBlob(0, centerX, centerY, (.225 + bass * .055 + bassHit * .075) * baseScale, .3);

    for (let i = 0; i < lobes.length; i++) {
      const lobe = lobes[i];
      const bandType = i % 3;
      const bandLevel = bandType === 0 ? bass : (bandType === 1 ? mids : highs);
      const bandHit = bandType === 0 ? bassHit : (bandType === 1 ? midHit : highHit);
      const drive = clamp(bandLevel * .72 + bandHit * 1.05 + activity * .12);
      lobe.reach = smooth(lobe.reach, drive, drive > lobe.reach ? 21 : (bandType === 0 ? 2.5 : 3.8), dt);

      const direction = i % 2 ? 1 : -.78;
      const frequencyMotion = bandType === 0 ? .12 : (bandType === 1 ? .48 : 1.1);
      const wave = Math.sin(t * (.28 + frequencyMotion) + lobe.seed) * (.08 + bandLevel * .22 + bandHit * .12);
      const angle = lobe.angle + phase * direction + wave;
      const throwDistance = bandType === 0 ? .42 : (bandType === 1 ? .36 : .30);
      const idleDistance = .28 + Math.sin(t * .34 + lobe.seed) * .025;
      const radial = (idleDistance + activity * .10 + lobe.reach * throwDistance) * lobe.bias * baseScale;
      const targetX = centerX + Math.cos(angle) * radial * (portrait ? .82 : 1.14);
      const targetY = centerY + Math.sin(angle) * radial * .78;
      const spring = bandType === 2 ? 125 : (bandType === 1 ? 96 : 76);
      lobe.vx += (targetX - lobe.x) * spring * dt;
      lobe.vy += (targetY - lobe.y) * spring * dt;
      const damping = Math.exp(-(bandType === 0 ? 7.2 : 9.2) * dt);
      lobe.vx *= damping;
      lobe.vy *= damping;
      lobe.x += lobe.vx * dt;
      lobe.y += lobe.vy * dt;
      const sizeBase = bandType === 0 ? .145 : (bandType === 1 ? .125 : .100);
      const size = (sizeBase + bandLevel * .035 + bandHit * .025) * baseScale;
      setBlob(1 + i, lobe.x, lobe.y, size, lobe.seed);

      // Two rounded joints per limb make long, bending liquid arms while keeping
      // every moving end glob joined to the central pool.
      const dx = lobe.x - centerX;
      const dy = lobe.y - centerY;
      const length = Math.max(.001, Math.hypot(dx, dy));
      const nx = -dy / length;
      const ny = dx / length;
      const bend = bandType === 1
        ? Math.sin(t * 1.15 + lobe.seed) * (.025 + mids * .075 + midHit * .055)
        : Math.sin(t * (.55 + bandType * .35) + lobe.seed) * (.012 + bandLevel * .025);
      const jointSize = (bandType === 0 ? .132 : (bandType === 1 ? .116 : .094)) + activity * .018;
      setBlob(7 + i,
        centerX + dx * .34 + nx * bend,
        centerY + dy * .34 + ny * bend,
        jointSize * baseScale,
        lobe.seed + 8.2
      );
      setBlob(13 + i,
        centerX + dx * .67 - nx * bend * .55,
        centerY + dy * .67 - ny * bend * .55,
        (jointSize * .92 + bandHit * .010) * baseScale,
        lobe.seed + 14.4
      );
    }

    // Small rounded beads migrate within the joined structure. High-frequency
    // energy makes them dart rapidly, but they stay inside the connected field.
    for (let i = 0; i < 5; i++) {
      const a = phase * (i % 2 ? -1.15 : 1.32) + i / 5 * Math.PI * 2 + Math.sin(t * .7 + i) * .18;
      const r = (.13 + activity * .12 + highs * .055 + highHit * .045) * baseScale;
      setBlob(19 + i,
        centerX + Math.cos(a) * r * (portrait ? .80 : 1.14),
        centerY + Math.sin(a) * r * .76,
        (.070 + highs * .025 + highHit * .018 + (i % 2) * .006) * baseScale,
        24. + i * 2.1
      );
    }
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(innerWidth * dpr);
    const height = Math.round(innerHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
  }

  function frame(now) {
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000));
    last = now;
    resize();
    analyse(dt);
    updateFluid(dt, now / 1000);
    gl.useProgram(program);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, now / 1000);
    gl.uniform4fv(uniforms.blobs, blobData);
    gl.uniform4f(uniforms.audio, clamp(bass + bassHit * .65), clamp(mids + midHit * .70), clamp(highs + highHit * .90), activity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

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
