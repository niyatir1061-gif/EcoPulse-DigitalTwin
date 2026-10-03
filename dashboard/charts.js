/**
 * charts.js  —  EcoPulse Chart Builders
 * All charts use Chart.js 4.x.  No emojis anywhere.
 */

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */
const C = {
  blue:        '#2563eb',
  blueLight:   'rgba(37,99,235,.12)',
  green:       '#16a34a',
  greenLight:  'rgba(22,163,74,.12)',
  amber:       '#d97706',
  amberLight:  'rgba(217,119,6,.12)',
  red:         '#dc2626',
  redLight:    'rgba(220,38,38,.12)',
  violet:      '#7c3aed',
  slate:       '#64748b',
  gridLine:    '#e2e8f0',
  textPrimary: '#0f172a',
  textMuted:   '#64748b',
  bg:          '#ffffff',
  bg2:         '#f8fafc',
};

const ISO_FILL = {
  A: 'rgba(22,163,74,.08)',
  B: 'rgba(217,119,6,.08)',
  C: 'rgba(220,38,38,.08)',
  D: 'rgba(127,29,29,.10)',
};

const ISO_STROKE = {
  A: 'rgba(22,163,74,.4)',
  B: 'rgba(217,119,6,.4)',
  C: 'rgba(220,38,38,.4)',
  D: 'rgba(127,29,29,.5)',
};

/* ------------------------------------------------------------------ */
/*  Shared defaults                                                    */
/* ------------------------------------------------------------------ */
const BASE_FONT = { family: "'Inter', system-ui, sans-serif", size: 11 };

function baseOptions(titleText) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: { font: BASE_FONT, color: C.textMuted, boxWidth: 10, padding: 12 },
      },
      title: titleText ? {
        display: true,
        text: titleText,
        font: { ...BASE_FONT, size: 12, weight: '700' },
        color: C.textPrimary,
        align: 'start',
        padding: { bottom: 6 },
      } : { display: false },
      tooltip: {
        backgroundColor: C.bg,
        borderColor: C.gridLine,
        borderWidth: 1,
        titleColor: C.textPrimary,
        bodyColor: C.textMuted,
        titleFont: { ...BASE_FONT, weight: '700' },
        bodyFont: BASE_FONT,
        padding: 10,
        cornerRadius: 6,
        boxPadding: 4,
      },
    },
    scales: {
      x: {
        grid:  { color: C.gridLine, lineWidth: 1 },
        ticks: { font: BASE_FONT, color: C.textMuted, maxTicksLimit: 7, maxRotation: 0 },
        border:{ color: C.gridLine },
      },
      y: {
        grid:  { color: C.gridLine, lineWidth: 1 },
        ticks: { font: BASE_FONT, color: C.textMuted },
        border:{ color: C.gridLine },
      },
    },
  };
}

function timeLabels(timestamps) {
  return timestamps.map((t, i) => {
    if (i % Math.max(1, Math.floor(timestamps.length / 8)) === 0) {
      return t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return '';
  });
}

function getCtx(id) {
  const canvas = document.getElementById(id);
  return canvas ? canvas.getContext('2d') : null;
}

function destroyAndBuild(existing, buildFn) {
  if (existing) { try { existing.destroy(); } catch (_) {} }
  return buildFn();
}

/* ------------------------------------------------------------------ */
/*  1. Power + Solar                                                   */
/* ------------------------------------------------------------------ */
function buildPowerChart(existing, tel, solarArr) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-power');
    if (!ctx) return null;
    const labels = timeLabels(tel.timestamps);
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Active Power (kW)',
            data: tel.activePower,
            borderColor: C.blue,
            backgroundColor: C.blueLight,
            fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0, pointHitRadius: 12,
          },
          {
            label: 'Solar PV (kW)',
            data: solarArr,
            borderColor: C.green,
            backgroundColor: 'transparent',
            fill: false, borderDash: [5, 4], tension: 0.3, borderWidth: 2, pointRadius: 0,
          },
        ],
      },
      options: baseOptions('Active Power vs Solar Generation (kW)'),
    });
  });
}

/* ------------------------------------------------------------------ */
/*  2. Temperature                                                     */
/* ------------------------------------------------------------------ */
function buildTempChart(existing, tel) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-temp');
    if (!ctx) return null;
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeLabels(tel.timestamps),
        datasets: [{
          label: 'Winding Temp (°C)',
          data: tel.temp,
          borderColor: C.amber,
          backgroundColor: C.amberLight,
          fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0,
        }],
      },
      options: {
        ...baseOptions('Winding Temperature (°C)'),
        plugins: {
          ...baseOptions().plugins,
          annotation: undefined,
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  3. Vibration with ISO 10816-3 zone bands                         */
/* ------------------------------------------------------------------ */
function buildVibrationChart(existing, tel, healthData) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-vib');
    if (!ctx) return null;
    const iso    = tel.iso;
    const maxVib = Math.max(...tel.vibration, iso.C * 1.4);
    const n      = tel.n;
    const labels = timeLabels(tel.timestamps);

    const datasets = [
      // ISO zone fills — rendered as filled area datasets behind the signal
      {
        label: 'Zone A – Good',
        data: Array(n).fill(iso.A),
        borderColor: ISO_STROKE.A, backgroundColor: ISO_FILL.A,
        fill: { target: { value: 0 } },
        tension: 0, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, order: 10,
      },
      {
        label: 'Zone B – Acceptable',
        data: Array(n).fill(iso.B),
        borderColor: ISO_STROKE.B, backgroundColor: ISO_FILL.B,
        fill: { target: { value: iso.A } },
        tension: 0, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, order: 9,
      },
      {
        label: 'Zone C – Alert',
        data: Array(n).fill(iso.C),
        borderColor: ISO_STROKE.C, backgroundColor: ISO_FILL.C,
        fill: { target: { value: iso.B } },
        tension: 0, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, order: 8,
      },
      {
        label: 'Zone D – Danger',
        data: Array(n).fill(maxVib),
        borderColor: ISO_STROKE.D, backgroundColor: ISO_FILL.D,
        fill: { target: { value: iso.C } },
        tension: 0, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, order: 7,
      },
      // Actual vibration signal
      {
        label: 'Vibration (mm/s)',
        data: tel.vibration,
        borderColor: C.violet, backgroundColor: 'transparent',
        fill: false, tension: 0.3, borderWidth: 2.5, pointRadius: 0, order: 1,
      },
      // Anomaly cross markers
      {
        label: 'Anomaly',
        data: healthData.map((h, i) => h.anomaly ? tel.vibration[i] : null),
        borderColor: 'transparent', backgroundColor: C.red,
        fill: false, pointRadius: 5, pointStyle: 'crossRot',
        showLine: false, order: 0,
      },
    ];

    return new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        ...baseOptions('Vibration (mm/s)  —  ISO 10816-3 Zones'),
        plugins: {
          ...baseOptions().plugins,
          tooltip: {
            ...baseOptions().plugins.tooltip,
            filter: item => item.datasetIndex >= 4,
          },
        },
        scales: {
          x: { ...baseOptions().scales.x },
          y: {
            min: 0, max: maxVib * 1.06,
            grid: { color: C.gridLine },
            ticks: { font: BASE_FONT, color: C.textMuted },
          },
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  4. Health Index + RUL projection                                  */
/* ------------------------------------------------------------------ */
function buildHealthChart(existing, healthData, rul) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-health');
    if (!ctx) return null;
    const n      = healthData.length;
    const scores = healthData.map(h => h.health);
    const last   = scores[n - 1];
    const lineColor = last < 50 ? C.red : last < 75 ? C.amber : C.green;
    const fillColor = last < 50 ? C.redLight : last < 75 ? C.amberLight : C.greenLight;

    // RUL projection points (extended beyond current window)
    const projData = new Array(n + 10).fill(null);
    projData.fill(undefined, 0, n);
    scores.forEach((v, i) => { projData[i] = v; });

    const datasets = [
      {
        label: 'Health Index (%)',
        data: scores,
        borderColor: lineColor, backgroundColor: fillColor,
        fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0, order: 1,
      },
      {
        label: 'Critical Threshold (30%)',
        data: new Array(n).fill(30),
        borderColor: C.red, borderDash: [6, 4],
        backgroundColor: 'transparent',
        fill: false, borderWidth: 1.5, pointRadius: 0, order: 3,
      },
    ];

    if (rul && rul.show) {
      const startVal = scores[n - 1];
      const proj     = Array(n).fill(null);
      for (let j = Math.max(0, n - 5); j < n; j++) {
        proj[j] = startVal + rul.slope * (j - (n - 1));
      }
      datasets.push({
        label: `RUL ~${rul.rulHours}h (±${rul.ciHours}h)`,
        data: proj,
        borderColor: C.red, borderDash: [4, 3],
        backgroundColor: 'transparent',
        fill: false, borderWidth: 2, pointRadius: 0, order: 2,
      });
    }

    const labels = Array.from({ length: n }, (_, i) => {
      const step = Math.max(1, Math.floor(n / 7));
      return i % step === 0 ? `-${n - i}s` : '';
    });

    return new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        ...baseOptions('Health Index (%)'),
        scales: {
          x: { ...baseOptions().scales.x },
          y: { min: 0, max: 105, grid: { color: C.gridLine }, ticks: { font: BASE_FONT, color: C.textMuted } },
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  5. Sensor Contribution (horizontal bar)                           */
/* ------------------------------------------------------------------ */
function buildContribChart(existing, contrib) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-contrib');
    if (!ctx) return null;
    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels: contrib.map(c => c.label),
        datasets: [{
          data: contrib.map(c => c.value),
          backgroundColor: [C.violet, C.amber, C.blue, C.green],
          borderRadius: 4,
          barThickness: 18,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...baseOptions().plugins.tooltip,
            callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)}%` },
          },
        },
        scales: {
          x: {
            min: 0, max: 100,
            grid: { color: C.gridLine },
            ticks: { font: BASE_FONT, color: C.textMuted, callback: v => `${v}%` },
          },
          y: {
            grid: { display: false },
            ticks: { font: { ...BASE_FONT, weight: '600' }, color: C.textMuted },
          },
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  6. Fleet Power Bar                                                 */
/* ------------------------------------------------------------------ */
function buildFleetPowerChart(existing, motorSummaries) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-fleet-power');
    if (!ctx) return null;
    const colours = motorSummaries.map(m =>
      m.health < 50 ? C.red : m.health < 75 ? C.amber : C.green
    );
    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels: motorSummaries.map(m => m.name),
        datasets: [{
          label: 'Power (kW)',
          data: motorSummaries.map(m => m.avgPower),
          backgroundColor: colours,
          borderRadius: 5, barThickness: 38,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...baseOptions().plugins.tooltip,
            callbacks: {
              label: ctx => ` ${ctx.raw.toFixed(1)} kW  |  Health: ${motorSummaries[ctx.dataIndex].health.toFixed(1)}%`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: BASE_FONT, color: C.textMuted } },
          y: {
            grid: { color: C.gridLine },
            ticks: { font: BASE_FONT, color: C.textMuted },
            title: { display: true, text: 'kW', font: BASE_FONT, color: C.textMuted },
          },
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  7. Fleet Action Donut                                             */
/* ------------------------------------------------------------------ */
function buildFleetDonut(existing, fix, mon, wait) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-fleet-donut');
    if (!ctx) return null;
    return new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Fix Now', 'Monitor', 'Can Wait'],
        datasets: [{
          data: [fix, mon, wait],
          backgroundColor: [C.red, C.amber, C.green],
          borderWidth: 2, borderColor: '#fff', hoverOffset: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '68%',
        animation: { duration: 300 },
        plugins: {
          legend: {
            position: 'right',
            labels: { font: BASE_FONT, color: C.textMuted, boxWidth: 10, padding: 10 },
          },
          tooltip: { ...baseOptions().plugins.tooltip },
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  8. EIA Grid Demand (live line chart)                              */
/* ------------------------------------------------------------------ */
function buildGridDemandChart(existing, eiaData) {
  return destroyAndBuild(existing, () => {
    const ctx = getCtx('chart-grid-demand');
    if (!ctx) return null;
    if (!eiaData) {
      // Draw an empty placeholder
      return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: { ...baseOptions('Grid Demand — EIA (MW)  — API key required') },
      });
    }
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: eiaData.labels,
        datasets: [{
          label: `${eiaData.region} Grid Demand (MW)`,
          data: eiaData.demandMW,
          borderColor: C.blue,
          backgroundColor: C.blueLight,
          fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2,
        }],
      },
      options: {
        ...baseOptions(`Grid Demand — EIA ${eiaData.region} (MW)  |  Last 24 h`),
        scales: {
          x: { ...baseOptions().scales.x },
          y: {
            grid: { color: C.gridLine },
            ticks: {
              font: BASE_FONT, color: C.textMuted,
              callback: v => (v / 1000).toFixed(0) + ' GW',
            },
          },
        },
      },
    });
  });
}

function rebuildChart(existing, buildFn, ctx, ...args) {
  return buildFn(existing, ...args);
}

const buildFleetHealthDonut = buildFleetDonut;
