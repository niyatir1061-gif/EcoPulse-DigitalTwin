/**
 * dashboard.js — EcoPulse Main Controller
 * Wires the simulator, charts, UI state, fault injection, and live refresh.
 */

/* ============================================================
   STATE
   ============================================================ */
const state = {
  currentPage:    'live',
  faultInjected:  false,
  faultStartTime: null,
  faultProgress:  0,
  seedOffset:     0,
  refreshTimer:   null,
  charts:         {},
  baselines:      {},
  refreshRate:    2000,   // ms
  selectedMotor:  'motor1',
  cfg: {
    numSamples:      120,
    productionRate:  120,
    solarKw:         8.5,
    gridCost:        8.50,
    downtime:        12000,
    hardwareCost:    25000,
    co2Factor:       0.82,
  },
};

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Build baselines once
  Object.keys(MOTORS).forEach(id => {
    state.baselines[id] = buildBaseline(id);
  });

  bindNav();
  bindSidebar();
  bindControls();
  bindExpanders();
  if (typeof initApis === 'function') {
    initApis();
  }
  if (typeof onApiStatus === 'function') {
    onApiStatus(({ weather }) => {
      const badge = document.getElementById('api-status-badge');
      if (badge && weather && weather.data) {
        badge.textContent = `Live API: ${weather.data.location} ${weather.data.temperature}°C`;
      }
    });
  }
  startLive();
  updateClock();
  setInterval(updateClock, 1000);
});

/* ============================================================
   CLOCK
   ============================================================ */
function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (!page) return;
      setPage(page);
    });
  });
}

function setPage(page) {
  state.currentPage = page;
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.page === page)
  );
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === `page-${page}`)
  );
  renderPage(page);
}

/* ============================================================
   SIDEBAR CONTROLS
   ============================================================ */
function bindSidebar() {
  const inject = document.getElementById('btn-inject');
  const reset  = document.getElementById('btn-reset');

  inject.addEventListener('click', () => {
    if (state.faultInjected) return;
    state.faultInjected   = true;
    state.faultStartTime  = Date.now();
    state.faultProgress   = 0;
    state.selectedMotor   = 'motor1';
    document.getElementById('motor-select').value = 'motor1';
    document.getElementById('fault-progress-wrap').classList.add('visible');
    inject.disabled = true;
    inject.textContent = 'Fault Running…';
  });

  reset.addEventListener('click', () => {
    state.faultInjected   = false;
    state.faultStartTime  = null;
    state.faultProgress   = 0;
    state.seedOffset     += 1;
    inject.disabled       = false;
    inject.innerHTML      = 'Inject Bearing Fault';
    document.getElementById('fault-progress-wrap').classList.remove('visible');
    document.getElementById('fault-bar-fill').style.width = '0%';
    document.getElementById('fault-pct-label').textContent = '0%';
    renderPage(state.currentPage);
  });

  document.getElementById('motor-select').addEventListener('change', e => {
    state.selectedMotor = e.target.value;
    renderPage(state.currentPage);
  });
}

function bindControls() {
  const map = [
    ['ctrl-samples',     'numSamples',     v => +v],
    ['ctrl-production',  'productionRate', v => +v],
    ['ctrl-solar',       'solarKw',        v => +v],
    ['ctrl-grid',        'gridCost',       v => +v],
    ['ctrl-downtime',    'downtime',       v => +v],
    ['ctrl-hardware',    'hardwareCost',   v => +v],
    ['ctrl-co2',         'co2Factor',      v => +v],
  ];
  map.forEach(([id, key, parse]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      state.cfg[key] = parse(el.value);
      const valEl = document.getElementById(`${id}-val`);
      if (valEl) valEl.textContent = el.value;
    });
  });

  const rr = document.getElementById('ctrl-refresh');
  if (rr) {
    rr.addEventListener('input', () => {
      state.refreshRate = +rr.value * 1000;
      const valEl = document.getElementById('ctrl-refresh-val');
      if (valEl) valEl.textContent = `${rr.value}s`;
      startLive();
    });
  }
}

function bindExpanders() {
  document.querySelectorAll('.expander-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.expander').classList.toggle('open');
    });
  });
}

/* ============================================================
   LIVE REFRESH LOOP
   ============================================================ */
function startLive() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    // Advance fault progress (40-second ramp)
    if (state.faultInjected && state.faultStartTime) {
      const elapsed = (Date.now() - state.faultStartTime) / 1000;
      state.faultProgress = Math.min(elapsed / 40, 1.0);
      const pct = Math.round(state.faultProgress * 100);
      document.getElementById('fault-bar-fill').style.width   = `${pct}%`;
      document.getElementById('fault-pct-label').textContent   = `${pct}%`;
    }
    renderPage(state.currentPage);
  }, state.refreshRate);
}

/* ============================================================
   PAGE RENDERER
   ============================================================ */
function renderPage(page) {
  if (page === 'live')   renderLivePage();
  if (page === 'fleet')  renderFleetPage();
  if (page === 'audit')  renderAuditPage();
}

/* ============================================================
   HELPERS — data generation
   ============================================================ */
function getMotorData(motorId, samples, faultProg) {
  const tel  = generateTelemetry(motorId, samples, faultProg, state.seedOffset);
  const bl   = state.baselines[motorId];
  const hd   = computeHealthStream(tel, bl);
  const rul  = estimateRUL(hd.map(h => h.health));
  tel.healthData = hd;
  tel.rul        = rul;

  // Solar proxy
  const rng = makePRNG(Date.now() % 9999 + state.seedOffset * 17);
  tel.solarKw = Array.from({ length: samples }, () =>
    Math.max(0, Math.min(state.cfg.solarKw * 1.2,
      state.cfg.solarKw + randNormal(rng, 0, 0.4)))
  );

  // Summary values
  const avgHealth  = hd.reduce((a, h) => a + h.health, 0) / hd.length;
  const lastHealth = hd[hd.length - 1].health;
  const lastH      = hd[hd.length - 1];
  tel.avgHealth    = Math.round(avgHealth * 10) / 10;
  tel.lastHealth   = lastHealth;
  tel.anomalyCount = hd.filter(h => h.anomaly).length;
  tel.avgPower     = tel.activePower.reduce((a, b) => a + b, 0) / samples;
  tel.lastPower    = tel.activePower[samples - 1];
  tel.lastVib      = tel.vibration[samples - 1];
  tel.lastTemp     = tel.temp[samples - 1];
  tel.lastCurrent  = tel.current[samples - 1];
  tel.lastLoad     = tel.load[samples - 1];
  tel.effClass     = estimateEfficiencyClass(tel.efficiencyPct, tel.spec.rating);
  tel.lastH        = lastH;

  const iso   = tel.iso;
  tel.diagFault = diagnoseFault(
    tel.lastVib, tel.lastTemp, tel.lastCurrent, tel.lastLoad,
    tel.spec.ratedCurrent, iso, tel.lastHealth
  );

  return tel;
}

function getFleetData() {
  return Object.keys(MOTORS).map(id => {
    const fp = (id === 'motor1' && state.faultInjected) ? state.faultProgress : 0;
    return getMotorData(id, 60, fp);
  });
}

/* ============================================================
   PAGE 1 — LIVE ASSET TWIN
   ============================================================ */
function renderLivePage() {
  const fp    = state.faultInjected ? state.faultProgress : 0;
  const motor = state.faultInjected ? 'motor1' : state.selectedMotor;
  const samples = state.cfg.numSamples;
  const tel    = getMotorData(motor, samples, state.faultInjected ? state.faultProgress : fp);

  // KPI Cards
  const fld = getFleetData();
  const fleetHealth = fld.reduce((a, f) => a + f.lastHealth, 0) / fld.length;
  const totalAlerts = fld.reduce((a, f) => a + f.anomalyCount, 0);
  const inrAtRisk   = Math.round(((100 - tel.lastHealth) / 100) * state.cfg.downtime * 8);
  const kwSaved     = tel.wastedPower.reduce((a, b) => a + b, 0);

  setKPI('kpi-fleet-health', `${fleetHealth.toFixed(1)}%`,
    fleetHealth >= 80 ? 'Nominal' : fleetHealth >= 50 ? 'Degrading' : 'Critical',
    fleetHealth >= 80 ? 'green' : fleetHealth >= 50 ? 'amber' : 'red');

  setKPI('kpi-alerts', String(totalAlerts),
    totalAlerts === 0 ? 'No anomalies' : `${totalAlerts} events detected`,
    totalAlerts === 0 ? 'green' : totalAlerts < 5 ? 'amber' : 'red');

  setKPI('kpi-risk', `₹${(inrAtRisk).toLocaleString('en-IN')}`,
    'Downtime exposure (8 h)',
    inrAtRisk > 50000 ? 'red' : inrAtRisk > 10000 ? 'amber' : 'green');

  setKPI('kpi-kwh', `${kwSaved.toFixed(1)} kWh`,
    `In ${samples}s window vs baseline`,
    'blue');

  // Metric chips
  setChip('chip-power',   `${tel.lastPower.toFixed(1)} kW`);
  setChip('chip-current', `${tel.lastCurrent.toFixed(1)} A`);
  setChip('chip-temp',    `${tel.lastTemp.toFixed(1)} °C`, tel.lastTemp > 70 ? 'crit' : tel.lastTemp > 55 ? 'warn' : '');
  setChip('chip-vib',     `${tel.lastVib.toFixed(3)} mm/s`, tel.lastVib > tel.iso.B ? 'crit' : tel.lastVib > tel.iso.A ? 'warn' : '');
  setChip('chip-health',  `${tel.lastHealth.toFixed(1)}%`, tel.lastHealth < 50 ? 'crit' : tel.lastHealth < 75 ? 'warn' : 'good');

  // Alert card
  renderAlertCard(tel);

  // RUL banner
  renderRULBanner(tel.rul);

  // Charts (rebuild each tick for live feel)
  rebuildAllLiveCharts(tel);

  // Explainability
  renderContribPanel(tel);

  // Fault diagnosis
  renderFaultDiagnosis(tel.diagFault);

  // Efficiency class (single motor, live page)
  renderEfficiencyClass([tel], 'eff-class-panel');
}

function rebuildAllLiveCharts(tel) {
  state.charts.power  = rebuildChart(state.charts.power,  buildPowerChart, getCanvas('chart-power'), tel, tel.solarKw);
  state.charts.temp   = rebuildChart(state.charts.temp,   buildTempChart,  getCanvas('chart-temp'),  tel);
  state.charts.vib    = rebuildChart(state.charts.vib,    buildVibrationChart, getCanvas('chart-vib'), tel, tel.healthData);
  state.charts.health = rebuildChart(state.charts.health, buildHealthChart, getCanvas('chart-health'), tel.healthData, tel.rul);
}

function getCanvas(id) {
  return document.getElementById(id).getContext('2d');
}

/* ---- KPI helpers ---- */
function setKPI(id, value, delta, colour) {
  const card = document.getElementById(id);
  if (!card) return;
  card.className = `kpi-card ${colour}`;
  const valEl = card.querySelector('.kpi-value');
  if (valEl) valEl.textContent = value;
  const d = card.querySelector('.kpi-delta');
  if (d) {
    d.textContent = delta;
    d.className = `kpi-delta ${colour === 'green' ? 'up' : colour === 'red' ? 'down' : 'warn'}`;
  }
}

function setChip(id, value, cls = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.className = `metric-chip-val ${cls}`.trim();
}

/* ---- alert card ---- */
function renderAlertCard(tel) {
  const el = document.getElementById('alert-card-panel');
  if (!el) return;
  const h    = tel.lastHealth;
  const fp   = state.faultInjected;
  const sev  = h < 50 ? 'critical' : h < 80 || fp ? 'warning' : 'healthy';
  const label= sev === 'critical' ? 'CRITICAL' : sev === 'warning' ? 'WARNING' : 'NOMINAL';
  const icon = '';
  const what = fp
    ? 'Bearing fault injected — vibration climbing through ISO 10816 zones'
    : h < 75
    ? 'Anomaly pattern detected across vibration and temperature sensors'
    : 'All sensors operating within normal bounds';

  const top  = tel.diagFault[0];
  const action = sev !== 'healthy' ? top.action : 'Continue scheduled preventive maintenance';
  const cost   = sev !== 'healthy' ? top.cost   : '—';
  const urg    = sev === 'critical' ? 'Immediate (< 4 h)' : sev === 'warning' ? 'Within 24 h' : 'Next maintenance window';

  // Contributions from z-scores
  const lastH = tel.lastH;
  const total = Math.max(lastH.zV + lastH.zT + lastH.zC + lastH.zP, 0.001);
  const contrib = [
    { label: 'Vibration',   pct: lastH.zV / total * 100, colour: '#7c3aed' },
    { label: 'Temperature', pct: lastH.zT / total * 100, colour: '#d97706' },
    { label: 'Current',     pct: lastH.zC / total * 100, colour: '#0ea5e9' },
    { label: 'Power',       pct: lastH.zP / total * 100, colour: '#16a34a' },
  ];

  el.className = `alert-card ${sev}`;
  el.innerHTML = `
    <div class="alert-header">
      <div class="alert-title">${icon} ${tel.spec.name}</div>
      <span class="alert-badge badge-${sev === 'healthy' ? 'nominal' : sev === 'critical' ? 'critical' : 'warning'}">${label}</span>
    </div>
    <div class="alert-row"><span>What happened</span><span>${what}</span></div>
    <div class="alert-row"><span>Recommended action</span><span>${action}</span></div>
    <div class="alert-row"><span>Est. cost band</span><span>${cost}</span></div>
    <div class="alert-row"><span>Urgency</span><span>${urg}</span></div>
    <div style="margin-top:4px;">
      <div style="font-size:.72rem;font-weight:700;color:var(--text3);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em;">Sensor Contributions</div>
      <div class="contrib-bar">
        ${contrib.map(c => `
          <div class="contrib-item">
            <div class="contrib-label"><span>${c.label}</span><span>${c.pct.toFixed(0)}%</span></div>
            <div class="contrib-track">
              <div class="contrib-fill" style="width:${c.pct.toFixed(0)}%;background:${c.colour}"></div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ---- RUL banner ---- */
function renderRULBanner(rul) {
  const el = document.getElementById('rul-banner');
  if (!el) return;
  el.classList.toggle('visible', !!(rul && rul.show));
  if (rul && rul.show) {
    el.querySelector('.rul-text').innerHTML =
      `<strong>Remaining Useful Life:</strong> ~${rul.rulHours} h
       <span class="rul-ci">&nbsp;(± ${rul.ciHours} h confidence)</span>
       &nbsp;<span style="font-size:.75rem;color:var(--text3)">Based on linear health trend extrapolation</span>`;
  }
}

/* ---- contrib panel ---- */
function renderContribPanel(tel) {
  const lastH = tel.lastH;
  const total = Math.max(lastH.zV + lastH.zT + lastH.zC + lastH.zP, 0.001);
  const contrib = [
    { label: 'Vibration',    value: lastH.zV / total * 100 },
    { label: 'Temperature',  value: lastH.zT / total * 100 },
    { label: 'Current',      value: lastH.zC / total * 100 },
    { label: 'Power',        value: lastH.zP / total * 100 },
  ];
  state.charts.contrib = rebuildChart(state.charts.contrib, buildContribChart,
    getCanvas('chart-contrib'), contrib);
}

/* ---- fault diagnosis ---- */
function renderFaultDiagnosis(diag) {
  const el = document.getElementById('fault-diag-list');
  if (!el) return;
  const colours = ['#dc2626', '#d97706', '#0ea5e9', '#16a34a'];
  el.innerHTML = diag.map((d, i) => `
    <li class="fault-item">
      <div class="fault-header">
        <span class="fault-name">${d.fault}</span>
        <span class="fault-pct" style="color:${colours[i]}">${d.likelihood.toFixed(1)}%</span>
      </div>
      <div class="fault-bar-track">
        <div class="fault-bar-fill" style="width:${d.likelihood}%;background:${colours[i]}"></div>
      </div>
      <div class="fault-detail">
        <span>${d.action}</span>
        <span>${d.cost}</span>
      </div>
    </li>`).join('');
}

/* ---- efficiency class (accepts panel id) ---- */
function renderEfficiencyClass(tels, panelId = 'eff-class-panel') {
  const el = document.getElementById(panelId);
  if (!el) return;
  el.innerHTML = tels.map(tel => {
    const ec = tel.effClass;
    const pct = Math.min(100, Math.max(0, (tel.efficiencyPct - 60) / 40 * 100));
    return `
      <div class="eff-card">
        <div class="eff-header">
          <span class="eff-motor">${tel.spec.name}</span>
          <span class="eff-badge" style="background:${ec.colour}22;color:${ec.colour};border:1px solid ${ec.colour}44">${ec.label}</span>
        </div>
        <div class="eff-bar-wrap">
          <div class="eff-bar-track">
            <div class="eff-bar-fill" style="width:${pct.toFixed(1)}%;background:${ec.colour}"></div>
          </div>
          <span class="eff-pct" style="color:${ec.colour}">${tel.efficiencyPct.toFixed(1)}%</span>
        </div>
        <div class="eff-thresholds">
          <span>IE2 ≥ ${ec.ie2}% &nbsp;|&nbsp; IE3 ≥ ${ec.ie3}% &nbsp;(${ec.key} kW motor)</span>
        </div>
      </div>`;
  }).join('');
}

/* ============================================================
   PAGE 2 — FLEET & ACTION QUEUE
   ============================================================ */
function renderFleetPage() {
  const fleet  = getFleetData();
  const queue  = buildFleetQueue(
    fleet.map(f => ({
      name:       f.spec.name,
      motorId:    f.motorId,
      health:     f.lastHealth,
      severity:   100 - f.lastHealth,
      criticality:f.spec.criticality,
      rulHours:   f.rul && f.rul.show ? f.rul.rulHours : null,
      slope:      f.rul ? f.rul.slope || 0 : 0,
      spec:       f.spec,
      avgPower:   f.avgPower,
      effClass:   f.effClass,
      efficiencyPct: f.efficiencyPct,
    })),
    state.cfg.downtime
  );

  // Fleet KPI chips
  const fix  = queue.filter(q => q.tier === 'Fix Now').length;
  const mon  = queue.filter(q => q.tier === 'Monitor').length;
  const wait = queue.filter(q => q.tier === 'Can Wait').length;
  const totalAvoided = queue.reduce((a, q) => a + q.inrAvoided, 0);

  document.getElementById('fleet-fix-count').textContent  = fix;
  document.getElementById('fleet-mon-count').textContent  = mon;
  document.getElementById('fleet-wait-count').textContent = wait;
  document.getElementById('fleet-avoided').textContent    = `₹${totalAvoided.toLocaleString('en-IN')}`;

  // Fleet table
  const tbody = document.getElementById('fleet-tbody');
  tbody.innerHTML = queue.map(q => {
    const hPct  = q.health;
    const hCol  = hPct >= 75 ? '#16a34a' : hPct >= 50 ? '#d97706' : '#dc2626';
    const tierCls = q.tier === 'Fix Now' ? 'fix' : q.tier === 'Monitor' ? 'mon' : 'wait';
    const tierIcon= '';
    return `
      <tr>
        <td><strong>${q.name}</strong></td>
        <td>
          <div class="health-bar-wrap">
            <div class="health-bar-track">
              <div class="health-bar-fill" style="width:${hPct}%;background:${hCol}"></div>
            </div>
            <span style="font-family:var(--mono);font-size:.78rem;font-weight:700;color:${hCol}">${hPct.toFixed(1)}%</span>
          </div>
        </td>
        <td style="font-family:var(--mono);font-size:.82rem">${(100 - hPct).toFixed(1)}</td>
        <td style="font-family:var(--mono);font-size:.82rem">${q.risk}</td>
        <td><span class="tier-chip ${tierCls}">${tierIcon} ${q.tier}</span></td>
        <td style="font-family:var(--mono);font-size:.82rem">${q.rulHours != null ? q.rulHours + ' h' : '—'}</td>
        <td style="font-family:var(--mono);font-size:.82rem;font-weight:700;color:var(--green)">₹${q.inrAvoided.toLocaleString('en-IN')}</td>
      </tr>`;
  }).join('');

  // Fleet power chart
  const fleetChartData = fleet.map((f, i) => ({
    spec: f.spec,
    avgPower: f.avgPower,
    health: f.lastHealth,
  }));
  state.charts.fleetPower = rebuildChart(
    state.charts.fleetPower, buildFleetPowerChart,
    getCanvas('chart-fleet-power'), fleetChartData
  );

  // Donut
  state.charts.fleetDonut = rebuildChart(
    state.charts.fleetDonut, buildFleetHealthDonut,
    getCanvas('chart-fleet-donut'), fix, mon, wait
  );

  // Efficiency class for all motors
  renderEfficiencyClass(fleet, 'eff-class-panel-fleet');

  // Carbon metrics
  const totalPower = fleet.reduce((a, f) => a + f.lastPower, 0);
  const solarNow   = state.cfg.solarKw;
  const netGrid    = Math.max(0, totalPower - solarNow);
  const grossCO2   = (totalPower * state.cfg.co2Factor).toFixed(2);
  const netCO2     = (netGrid * state.cfg.co2Factor).toFixed(2);
  const avoidedCO2 = (Math.min(solarNow, totalPower) * state.cfg.co2Factor).toFixed(2);
  document.getElementById('carbon-gross').textContent   = `${grossCO2} kg/hr`;
  document.getElementById('carbon-net').textContent     = `${netCO2} kg/hr`;
  document.getElementById('carbon-avoided').textContent = `${avoidedCO2} kg/hr`;

  // Financial
  const totalWasted  = fleet.reduce((a, f) => a + f.wastedPower.reduce((x, y) => x + y, 0), 0) / 3600;
  const kwWastedYr   = totalWasted * 16 * 300;
  const inrWastedYr  = kwWastedYr * state.cfg.gridCost;
  const daily        = inrWastedYr / 300;
  const payback      = daily > 0 ? (state.cfg.hardwareCost / (daily * 25)).toFixed(1) : '—';
  document.getElementById('fin-wasted').textContent  = `${kwWastedYr.toFixed(0)} kWh/yr`;
  document.getElementById('fin-inr').textContent     = `₹${Math.round(inrWastedYr).toLocaleString('en-IN')}/yr`;
  document.getElementById('fin-daily').textContent   = `₹${Math.round(daily).toLocaleString('en-IN')}/day`;
  document.getElementById('fin-payback').textContent = `${payback} months`;
}

/* ============================================================
   PAGE 3 — AUDIT EXPORTER
   ============================================================ */
function renderAuditPage() {
  const fleet = getFleetData();
  const sel   = fleet[0]; // primary asset
  const now   = new Date().toLocaleString('en-IN');
  const avgH  = fleet.reduce((a, f) => a + f.lastHealth, 0) / fleet.length;
  const alerts= fleet.reduce((a, f) => a + f.anomalyCount, 0);

  const totalPower = fleet.reduce((a, f) => a + f.lastPower, 0);
  const kwSavedYr  = fleet.reduce((a, f) => a + f.wastedPower.reduce((x, y) => x + y, 0), 0) / 3600 * 16 * 300;
  const inrSavedYr = kwSavedYr * state.cfg.gridCost;
  const grossCO2hr = (totalPower * state.cfg.co2Factor).toFixed(2);
  const netCO2hr   = (Math.max(0, totalPower - state.cfg.solarKw) * state.cfg.co2Factor).toFixed(2);

  const topFault  = sel.diagFault[0];
  const ec        = sel.effClass;
  const rul       = sel.rul;

  const report = `${'='.repeat(72)}
  ECOPULSE — ENERGY & PREDICTIVE MAINTENANCE AUDIT REPORT
${'='.repeat(72)}
Generated      : ${now}
Primary Asset  : ${sel.spec.name}
Standards Cited: ISO 10816-3 | IS 12615 | IEC 60034-30-1 | BEE Guidance
${'─'.repeat(72)}
SECTION 1 — EXECUTIVE SUMMARY
${'─'.repeat(72)}
Fleet avg health           : ${avgH.toFixed(1)}%  (100 = perfect; < 50 = critical)
Anomaly events (window)    : ${alerts}
Annual energy savings est. : ${kwSavedYr.toFixed(0)} kWh / year
Annual cost savings est.   : ₹${Math.round(inrSavedYr).toLocaleString('en-IN')} / year
${'─'.repeat(72)}
SECTION 2 — SCOPE & METHOD
${'─'.repeat(72)}
All readings are generated by a physics-inspired simulator.
- Load profile (shift pattern + duty cycle) drives current draw
- Temperature follows current via first-order thermal lag (τ = 18 s)
- Vibration depends on load baseline and injected fault progress
- No real plant or machinery data is used.
${'─'.repeat(72)}
SECTION 3 — FINDINGS
${'─'.repeat(72)}
${fleet.map(f => `  ${f.spec.name.padEnd(22)}: Health ${f.lastHealth.toFixed(1)}%  |  Power ${f.lastPower.toFixed(1)} kW  |  η ≈ ${f.efficiencyPct.toFixed(1)}%  [${f.effClass.label}]`).join('\n')}

Gross Scope 2 Emissions     : ${grossCO2hr} kg CO₂/hr
Net Scope 2 (post-solar)    : ${netCO2hr} kg CO₂/hr
${rul && rul.show ? `\nRUL Estimate (Motor 1)      : ~${rul.rulHours} h  (± ${rul.ciHours} h)` : ''}
${'─'.repeat(72)}
SECTION 4 — FAULT DIAGNOSIS  (signature-based, simulated)
${'─'.repeat(72)}
${sel.diagFault.map(d => `  ${d.fault.padEnd(20)} ${d.likelihood.toFixed(1).padStart(5)}%  |  ${d.action}  |  ${d.cost}`).join('\n')}
${'─'.repeat(72)}
SECTION 5 — RECOMMENDATIONS
${'─'.repeat(72)}
  Annual kWh savings (est.)  : ${kwSavedYr.toFixed(0)} kWh
  Annual ₹ savings (est.)    : ₹${Math.round(inrSavedYr).toLocaleString('en-IN')}
  Recommended action         : ${topFault.action}
  Cost band                  : ${topFault.cost}
  Efficiency class (illus.)  : ${ec.label}  [IS 12615 / IEC 60034-30-1]
  IE2 threshold              : ≥ ${ec.ie2}%  |  IE3 threshold: ≥ ${ec.ie3}%
  Note: Efficiency class is illustrative — NOT an official BEE star rating.
${'─'.repeat(72)}
ANNEXURES
${'─'.repeat(72)}
A1. ASSUMPTIONS
    Grid tariff: ₹${state.cfg.gridCost}/kWh  |  CO₂ factor: ${state.cfg.co2Factor} kg/kWh
    16 h/day operation  |  300 working days/year
    Downtime rate: ₹${state.cfg.downtime.toLocaleString('en-IN')}/hr

A2. STANDARDS REFERENCED
    ISO 10816-3 : Vibration zone classification
    IS 12615    : Motor efficiency thresholds (IE2/IE3)
    IEC 60034-30-1 : Efficiency class definitions
    BEE Guidance   : Energy audit report structure

${'='.repeat(72)}
SIMULATION DISCLAIMER
All sensor readings, health scores, energy figures, and financial estimates
are generated by a physics-inspired simulator. No real plant data is used.
This report is for demonstration purposes only (Schneider Electric Yuva Yodha).
${'='.repeat(72)}`;

  document.getElementById('report-preview').textContent = report;

  // Download buttons
  document.getElementById('btn-dl-txt').onclick = () => {
    const blob = new Blob([report], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'ecopulse_audit_report.txt';
    a.click();
  };

  // CSV download
  document.getElementById('btn-dl-csv').onclick = () => {
    const sel2   = getMotorData(state.selectedMotor, state.cfg.numSamples, 0);
    const header = 'timestamp,motor,power_kw,current_a,voltage_v,temp_c,vibration_mm_s,load_factor,efficiency_pct,health,anomaly\n';
    const rows   = sel2.timestamps.map((t, i) =>
      `${t.toISOString()},${sel2.spec.name},${sel2.activePower[i]},${sel2.current[i].toFixed(2)},${sel2.voltage[i].toFixed(1)},${sel2.temp[i].toFixed(2)},${sel2.vibration[i].toFixed(4)},${sel2.load[i].toFixed(3)},${sel2.efficiencyPct.toFixed(1)},${sel2.healthData[i].health},${sel2.healthData[i].anomaly}`
    ).join('\n');
    const blob   = new Blob([header + rows], { type: 'text/csv' });
    const a      = document.createElement('a');
    a.href       = URL.createObjectURL(blob);
    a.download   = 'ecopulse_telemetry.csv';
    a.click();
  };
}
