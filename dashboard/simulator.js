/**
 * simulator.js  —  EcoPulse Physics-Coupled Motor Simulator
 *
 * What makes this "live":
 *   - Real wall-clock time (Date.now()) drives rolling 1-second telemetry windows.
 *   - Real ambient temperature & weather from Open-Meteo API (via setAmbientTemp).
 *   - Live API weather modulates load factor and thermal lag in real-time.
 */

/* ------------------------------------------------------------------ */
/*  Motor catalogue  (415 V, three-phase, IS 12615)                   */
/* ------------------------------------------------------------------ */
const MOTORS = {
  motor1: { id: 'motor1', name: 'Induction Motor 1',  rating: 15,  ratedCurrent: 28.5, criticality: 3, isoClass: 'medium' },
  motor2: { id: 'motor2', name: 'Compressor Line 2',  rating: 30,  ratedCurrent: 56.0, criticality: 2, isoClass: 'medium' },
  motor3: { id: 'motor3', name: 'HVAC Pump 3',        rating: 7.5, ratedCurrent: 14.8, criticality: 1, isoClass: 'small'  },
};

/* ISO 10816-3 vibration zone limits (mm/s RMS) */
const ISO_ZONES = {
  small:  { A: 0.71, B: 1.80, C: 4.50 },
  medium: { A: 1.12, B: 2.80, C: 7.10 },
  large:  { A: 1.80, B: 4.50, C: 11.2 },
};

/* IE2 / IE3 full-load efficiency thresholds — IS 12615 / IEC 60034-30-1 */
const IE_THRESHOLDS = {
  7.5:  [89.8, 91.7],
  15.0: [91.8, 93.6],
  30.0: [93.2, 95.0],
};

/* ------------------------------------------------------------------ */
/*  Mutable ambient temperature (updated by api.js)                   */
/* ------------------------------------------------------------------ */
let _ambientTemp = 32.0;
let _liveHumidity = 60.0;
let _liveWindSpeed = 10.0;

function setAmbientTemp(degC, humidity = null, wind = null) {
  _ambientTemp = isFinite(degC) ? degC : 32.0;
  if (humidity !== null && isFinite(humidity)) _liveHumidity = humidity;
  if (wind !== null && isFinite(wind)) _liveWindSpeed = wind;
}

function getAmbientTemp() { return _ambientTemp; }

/* ------------------------------------------------------------------ */
/*  Seeded PRNG (LCG) — deterministic noise per window               */
/* ------------------------------------------------------------------ */
function makePRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randNormal(rng, mean = 0, std = 1) {
  const u = Math.max(1e-10, 1 - rng()), v = rng();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ */
/*  Real-clock-based live load profile                                */
/*  Uses actual wall clock + live weather API factors to produce a    */
/*  smoothly rolling, realistic real-time load signal                 */
/* ------------------------------------------------------------------ */
function realtimeLoadProfile(n, nowMs) {
  const load = new Array(n);
  const humDelta = ((_liveHumidity - 50) / 100) * 0.05;

  for (let i = 0; i < n; i++) {
    const tMs  = nowMs - (n - 1 - i) * 1000;         // each sample = 1 s
    const sec  = (tMs / 1000) % 86400;               // second of day
    const hour = sec / 3600;

    let shiftEnv;
    if      (hour < 6)  shiftEnv = 0.35;
    else if (hour < 9)  shiftEnv = 0.35 + (hour - 6) / 3 * 0.40;
    else if (hour < 17) shiftEnv = 0.75;
    else if (hour < 20) shiftEnv = 0.75 - (hour - 17) / 3 * 0.35;
    else                shiftEnv = 0.40;

    // Fast duty-cycle oscillation (continuous real-time motion)
    const duty = 0.07 * Math.sin(2 * Math.PI * sec / 90)
               + 0.04 * Math.sin(2 * Math.PI * sec / 33)
               + 0.02 * Math.cos(2 * Math.PI * sec / 14);

    load[i] = Math.max(0.20, Math.min(0.98, shiftEnv + duty + humDelta));
  }
  return load;
}

/* ------------------------------------------------------------------ */
/*  First-order thermal lag: T[k] = T[k-1] + (1/tau)*(Tss - T[k-1]) */
/*  Tss = ambient + gain * I^2                                        */
/* ------------------------------------------------------------------ */
function thermalLag(currentArr, ambient, tau = 18) {
  const gain = 0.055;
  const temp = new Array(currentArr.length);
  temp[0] = ambient + gain * currentArr[0] ** 2;
  for (let k = 1; k < currentArr.length; k++) {
    const tss = ambient + gain * currentArr[k] ** 2;
    temp[k] = temp[k - 1] + (1 / tau) * (tss - temp[k - 1]);
  }
  return temp;
}

/* ------------------------------------------------------------------ */
/*  Main generator                                                     */
/* ------------------------------------------------------------------ */
function generateTelemetry(motorId, n = 120, faultProgress = 0, seedOffset = 0) {
  const spec    = MOTORS[motorId] || MOTORS.motor1;
  const nowMs   = Date.now();
  const ambient = _ambientTemp;

  // Seed changes smoothly with time so data moves forward realistically
  const minuteSeed = Math.floor(nowMs / 60000) + seedOffset * 997;
  const rng = makePRNG(minuteSeed + spec.criticality * 31);

  const iso     = ISO_ZONES[spec.isoClass];
  const load    = realtimeLoadProfile(n, nowMs);

  /* ---- Current (A) ---- */
  const iBase   = spec.ratedCurrent * 0.75;
  const current = load.map(l => iBase * l + randNormal(rng, 0, spec.ratedCurrent * 0.012));

  /* ---- Voltage (V) ---- */
  const voltage = Array.from({ length: n }, () => randNormal(rng, 415, 3.5));

  /* ---- Power factor ---- */
  const pf = load.map(l =>
    Math.max(0.65, Math.min(0.95, 0.88 - (l - 0.75) * 0.06 + randNormal(rng, 0, 0.008)))
  );

  /* ---- Temperature — thermal lag on current, anchored to real ambient ---- */
  let temp = thermalLag(current, ambient, 18);
  temp = temp.map(t => t + randNormal(rng, 0, 0.5));

  /* ---- Vibration — load-dependent ---- */
  const vBase = iso.A * 0.55;
  let vibration = load.map(l => Math.max(0, vBase * (0.7 + 0.5 * l) + randNormal(rng, 0, vBase * 0.08)));

  /* ---- Fault injection ---- */
  if (faultProgress > 0) {
    const fp      = Math.max(0, faultProgress);
    const vibFault= iso.C * 1.8 * Math.pow(fp, 1.8);
    const tFault  = 28 * fp;
    const iFault  = spec.ratedCurrent * 0.18 * fp;
    vibration = vibration.map(v => v + vibFault);
    temp      = temp.map(t => t + tFault);
    for (let i = 0; i < n; i++) current[i] += iFault;
  }

  /* ---- Active power (kW) ---- */
  const activePower = current.map((c, i) =>
    Math.max(0, (Math.sqrt(3) * voltage[i] * c * pf[i]) / 1000)
  );

  /* ---- Efficiency — degrades with fault ---- */
  const eta         = Math.max(0.45, Math.min(0.94, 0.94 - 0.22 * Math.max(0, faultProgress)));
  const efficiencyPct = eta * 100;

  /* ---- Wasted power ---- */
  const wastedPower = activePower.map(p => Math.max(0, p - spec.rating * 0.75));

  /* ---- Timestamps (1-s resolution, ending now) ---- */
  const timestamps = Array.from({ length: n }, (_, i) =>
    new Date(nowMs - (n - 1 - i) * 1000)
  );

  return {
    motorId, spec, n, faultProgress, timestamps,
    load, current, voltage, pf,
    temp, vibration, activePower,
    efficiencyPct, wastedPower,
    iso, ambient,
  };
}

/* ------------------------------------------------------------------ */
/*  Baseline (clean, no fault) for z-score health scoring             */
/* ------------------------------------------------------------------ */
function buildBaseline(motorId) {
  const tel  = generateTelemetry(motorId, 300, 0, 0);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const std  = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) || 1;
  const mC = mean(tel.current),     sC = std(tel.current, mC);
  const mV = mean(tel.vibration),   sV = std(tel.vibration, mV);
  const mT = mean(tel.temp),        sT = std(tel.temp, mT);
  const mP = mean(tel.activePower), sP = std(tel.activePower, mP);
  return { meanC: mC, stdC: sC, meanV: mV, stdV: sV, meanT: mT, stdT: sT, meanP: mP, stdP: sP };
}

/* ------------------------------------------------------------------ */
/*  Health scoring                                                     */
/* ------------------------------------------------------------------ */
function computeHealth(tel, baseline) {
  return tel.activePower.map((_, i) => {
    const zC = Math.abs((tel.current[i]     - baseline.meanC) / baseline.stdC);
    const zV = Math.abs((tel.vibration[i]   - baseline.meanV) / baseline.stdV);
    const zT = Math.abs((tel.temp[i]        - baseline.meanT) / baseline.stdT);
    const zP = Math.abs((tel.activePower[i] - baseline.meanP) / baseline.stdP);
    const sev = Math.min((zC + zV + zT + zP) / 4, 6);
    return {
      health:  Math.round(Math.max(0, Math.min(100, 100 - sev * 16)) * 10) / 10,
      anomaly: sev >= 1.5,
      zC, zV, zT, zP,
    };
  });
}

// Aliases for dashboard.js
function computeHealthStream(tel, baseline) {
  return computeHealth(tel, baseline);
}

/* ------------------------------------------------------------------ */
/*  RUL estimation (linear extrapolation of recent health trend)      */
/* ------------------------------------------------------------------ */
function estimateRUL(healthArr, critThreshold = 30) {
  const n   = Math.min(40, healthArr.length);
  const win = healthArr.slice(-n);
  if (n < 6) return { show: false };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += win[i]; sumXY += i * win[i]; sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return { show: false };
  const slope = (n * sumXY - sumX * sumY) / denom;   // health-pts / second

  if (slope >= -0.003) return { show: false };

  const current    = win[n - 1];
  const secToCrit  = (current - critThreshold) / (-slope);
  if (secToCrit <= 0) return { show: false };

  const intercept = (sumY - slope * sumX) / n;
  let resVar = 0;
  for (let i = 0; i < n; i++) resVar += (win[i] - (intercept + slope * i)) ** 2;
  const resStd    = Math.sqrt(resVar / n);
  const ciSeconds = (1.645 * resStd) / Math.abs(slope);

  return {
    show:     true,
    rulHours: Math.round(secToCrit / 36) / 100,
    ciHours:  Math.round(ciSeconds  / 36) / 100,
    slope, intercept, n,
  };
}

/* ------------------------------------------------------------------ */
/*  Fault diagnosis  (signature-based)                                */
/* ------------------------------------------------------------------ */
function diagnoseFault(vib, temp, current, load, ratedCurrent, isoLimits) {
  const iRatio   = current / Math.max(ratedCurrent, 1);
  const tempHigh = temp > 70, tempVery = temp > 85;
  const vibHigh  = vib > isoLimits.B, vibCrit = vib > isoLimits.C;

  const sc = { 'Bearing Wear': 0, 'Misalignment': 0, 'Imbalance': 0, 'Thermal Overload': 0 };
  if (vibHigh)                          sc['Bearing Wear']     += 0.55;
  if (vibCrit)                          sc['Bearing Wear']     += 0.25;
  if (temp > 55 && !tempVery)           sc['Bearing Wear']     += 0.10;
  if (vibHigh && load < 0.65)           sc['Misalignment']     += 0.40;
  if (vib > isoLimits.B * 0.7)         sc['Misalignment']     += 0.15;
  if (vibHigh && iRatio > 0.95)         sc['Imbalance']        += 0.35;
  if (vib > isoLimits.B * 0.5 && load > 0.8) sc['Imbalance'] += 0.20;
  if (tempHigh)                         sc['Thermal Overload'] += 0.50;
  if (tempVery)                         sc['Thermal Overload'] += 0.30;
  if (iRatio > 1.05)                    sc['Thermal Overload'] += 0.20;

  const total = Math.max(Object.values(sc).reduce((a, b) => a + b, 0), 1e-6);
  const meta  = {
    'Bearing Wear':    { action: 'Replace / relubricate bearing',  cost: 'Rs 8,000 - Rs 25,000' },
    'Misalignment':    { action: 'Realign shaft coupling',          cost: 'Rs 3,000 - Rs 10,000' },
    'Imbalance':       { action: 'Balance rotor; check coupling',   cost: 'Rs 5,000 - Rs 15,000' },
    'Thermal Overload':{ action: 'Check cooling, reduce load',      cost: 'Rs 1,500 - Rs 6,000'  },
  };
  return Object.entries(sc)
    .map(([fault, raw]) => ({ fault, likelihood: Math.max(raw / total * 100, 5), ...meta[fault] }))
    .sort((a, b) => b.likelihood - a.likelihood);
}

/* ------------------------------------------------------------------ */
/*  Efficiency class                                                   */
/* ------------------------------------------------------------------ */
function nearestIEKey(r) { return [7.5, 15, 30].reduce((a, b) => Math.abs(b - r) < Math.abs(a - r) ? b : a); }

function estimateEffClass(effPct, rating) {
  const key        = nearestIEKey(rating);
  const [ie2, ie3] = IE_THRESHOLDS[key];
  if (effPct >= ie3) return { label: 'IE3 - Premium Efficiency', colour: '#16a34a', ie2, ie3, key };
  if (effPct >= ie2) return { label: 'IE2 - High Efficiency',    colour: '#d97706', ie2, ie3, key };
  return               { label: 'IE1 or below',                  colour: '#dc2626', ie2, ie3, key };
}

function estimateEfficiencyClass(effPct, rating) {
  return estimateEffClass(effPct, rating);
}

/* ------------------------------------------------------------------ */
/*  Fleet action queue                                                 */
/* ------------------------------------------------------------------ */
function buildFleetQueue(fleet, inrPerHour = 12000) {
  return fleet.map(r => {
    const trendFactor = Math.max(-(r.slope || 0) * 3600, 0);
    const risk = (r.severity / 100) * r.criticality * (1 + trendFactor * 0.1);
    let tier, tcolour;
    if      (r.health < 50 || risk > 1.8) { tier = 'Fix Now';  tcolour = '#dc2626'; }
    else if (r.health < 75 || risk > 0.8) { tier = 'Monitor';  tcolour = '#d97706'; }
    else                                   { tier = 'Can Wait'; tcolour = '#16a34a'; }
    const inrAvoided = r.rulHours
      ? Math.round(r.rulHours * inrPerHour)
      : Math.round(8 * inrPerHour * r.severity / 100);
    return { ...r, tier, tcolour, risk: Math.round(risk * 100) / 100, inrAvoided };
  }).sort((a, b) => b.risk - a.risk);
}
