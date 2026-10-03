"""
app.py  —  EcoPulse: Predictive Maintenance & Energy Intelligence Dashboard
Schneider Electric Yuva Yodha | Smart Manufacturing Track

All sensor data is simulated. See the Methodology expander for details.
"""

import time
import numpy as np
import pandas as pd
import streamlit as st
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots

from telemetry_sim import (
    generate_machine_telemetry,
    MOTOR_CATALOGUE,
    ISO_10816_ZONES,
    get_iso_machine_class,
)
from ml_engine import (
    MachineHealthAnalyzer,
    estimate_efficiency_class,
    diagnose_fault,
    build_fleet_action_queue,
)
from audit_engine import EnergyAuditEngine
from report_generator import AuditReportGenerator


# ============================================================
# Page config + dark theme CSS
# ============================================================
st.set_page_config(
    page_title="EcoPulse — Industrial AI",
    page_icon="EcoPulse",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
/* ---- base ---- */
html, body, [data-testid="stApp"] {
    background-color: #0d1b2a;
    color: #dce3ec;
    font-family: 'Inter', 'Segoe UI', sans-serif;
}
/* ---- sidebar ---- */
[data-testid="stSidebar"] {
    background-color: #111f30;
    border-right: 1px solid #1e3048;
}
/* ---- tabs ---- */
[data-testid="stTabs"] button {
    color: #7fa7cc;
    font-weight: 600;
    border-bottom: 2px solid transparent;
}
[data-testid="stTabs"] button[aria-selected="true"] {
    color: #ffba08;
    border-bottom: 2px solid #ffba08;
}
/* ---- expander ---- */
[data-testid="stExpander"] {
    background-color: #111f30;
    border: 1px solid #1e3048;
    border-radius: 6px;
}
/* ---- metrics ---- */
[data-testid="stMetric"] {
    background-color: #111f30;
    border: 1px solid #1e3048;
    border-radius: 8px;
    padding: 10px 14px;
}
/* ---- dataframe ---- */
[data-testid="stDataFrame"] {
    background-color: #111f30;
}
/* ---- KPI cards ---- */
.kpi-card {
    background: #111f30;
    border-radius: 10px;
    padding: 16px 20px;
    border-left: 4px solid #ffba08;
    margin-bottom: 8px;
}
.kpi-card.red   { border-left-color: #e63946; }
.kpi-card.green { border-left-color: #2dc653; }
.kpi-card.amber { border-left-color: #ffba08; }
.kpi-card.blue  { border-left-color: #4895ef; }
.kpi-label  { font-size: 0.73rem; letter-spacing:.08em; color: #7fa7cc; text-transform:uppercase; }
.kpi-value  { font-size: 2.0rem; font-weight: 700; line-height: 1.1; color: #dce3ec; }
.kpi-delta  { font-size: 0.78rem; margin-top:4px; }

/* ---- sim badge ---- */
.sim-badge {
    display: inline-block;
    background: #e63946;
    color: #fff;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: .12em;
    padding: 3px 10px;
    border-radius: 4px;
    vertical-align: middle;
}
/* ---- alert card ---- */
.alert-card {
    background: #1a1200;
    border: 1px solid #e63946;
    border-left: 5px solid #e63946;
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 10px;
}
.alert-card.warn {
    border-color: #ffba08;
    border-left-color: #ffba08;
    background: #1a1500;
}
</style>
""", unsafe_allow_html=True)


# ============================================================
# Simulation badge + methodology  (shown at top of every page)
# ============================================================
def render_sim_badge():
    st.markdown(
        '<span class="sim-badge">SIMULATED DATA</span>',
        unsafe_allow_html=True
    )


def render_methodology():
    with st.expander("Methodology & Standards", expanded=False):
        st.markdown("""
**Data generation** — all sensor readings are produced by a physics-inspired simulator:
- Load profile (shift pattern + duty cycle) drives current draw
- Temperature follows current via a **first-order thermal lag** (τ = 18 s)
- Vibration depends on load baseline and injected fault progress

**Standards cited**
| Standard | Applied to |
|---|---|
| ISO 10816-3 | Vibration zone classification (A / B / C / D) |
| IS 12615 | Motor efficiency thresholds (IE2 / IE3) |
| IEC 60034-30-1 | Efficiency class definitions |
| BEE Guidance Notes | Energy-audit report structure |

Motor ratings follow standard 415 V three-phase values: **7.5 kW, 15 kW, 30 kW**.

**No real plant data is used.** Efficiency class labels are marked *(illustrative)*.
        """)


# ============================================================
# Session-state init
# ============================================================
def _init_state():
    if "fault_injected" not in st.session_state:
        st.session_state.fault_injected    = False
    if "fault_start_time" not in st.session_state:
        st.session_state.fault_start_time  = None
    if "fault_progress" not in st.session_state:
        st.session_state.fault_progress    = 0.0
    if "demo_asset" not in st.session_state:
        st.session_state.demo_asset        = "Induction_Motor_1"
    if "seed_counter" not in st.session_state:
        st.session_state.seed_counter      = 0

_init_state()


# ============================================================
# Cached baseline training
# ============================================================
@st.cache_resource
def get_trained_analyzer():
    from telemetry_sim import generate_machine_telemetry as _gen
    baseline_df = _gen("Induction_Motor_1", num_samples=300,
                        inject_fault=False, fault_progress=0.0)
    ana = MachineHealthAnalyzer(baseline_kw=15.0)
    ana.train_baseline(baseline_df)
    return ana

analyzer = get_trained_analyzer()


# ============================================================
# KPI card helper
# ============================================================
def kpi_card(label: str, value: str, delta: str, colour: str = "amber"):
    st.markdown(f"""
<div class="kpi-card {colour}">
  <div class="kpi-label">{label}</div>
  <div class="kpi-value">{value}</div>
  <div class="kpi-delta" style="color:{'#e63946' if colour=='red' else '#ffba08' if colour=='amber' else '#2dc653' if colour=='green' else '#4895ef'}">
    {delta}
  </div>
</div>""", unsafe_allow_html=True)


# ============================================================
# Alert card helper
# ============================================================
def render_alert_card(asset, severity_label, what, why_contributions, action,
                       cost_band, urgency, severity_level="critical"):
    css_class = "alert-card" if severity_level == "critical" else "alert-card warn"
    icon = "" if severity_level == "critical" else ""
    contrib_html = " &nbsp;|&nbsp; ".join(
        [f"<b>{k}</b>: {v:.0f}%" for k, v in why_contributions.items()]
    )
    st.markdown(f"""
<div class="{css_class}">
  <div style="font-size:1.05rem;font-weight:700;margin-bottom:4px;">{icon} {asset} — {severity_label}</div>
  <div style="font-size:0.85rem;color:#aac4de;margin-bottom:6px;"><b>What happened:</b> {what}</div>
  <div style="font-size:0.82rem;color:#aac4de;margin-bottom:6px;">
    <b>Why (sensor contributions):</b> {contrib_html}
  </div>
  <div style="font-size:0.85rem;margin-bottom:4px;">
    <span style="background:#1e3048;padding:2px 8px;border-radius:4px;">{action}</span>
    &nbsp;&nbsp;
    <span style="background:#1e3048;padding:2px 8px;border-radius:4px;">{cost_band}</span>
    &nbsp;&nbsp;
    <span style="background:#1e3048;padding:2px 8px;border-radius:4px;">{urgency}</span>
  </div>
</div>
""", unsafe_allow_html=True)


# ============================================================
# ISO 10816 zone bands on vibration chart
# ============================================================
def add_iso_zones(fig, rating_kw: float, row: int = 1, col: int = 1,
                  y_max: float = 15.0):
    cls = get_iso_machine_class(rating_kw)
    lims = ISO_10816_ZONES[cls]
    zones = [
        (0,          lims["A"], "#2dc653", "A – Good",       0.07),
        (lims["A"],  lims["B"], "#ffba08", "B – Acceptable", 0.07),
        (lims["B"],  lims["C"], "#ff6b35", "C – Alert",      0.07),
        (lims["C"],  y_max,     "#e63946", "D – Danger",     0.07),
    ]
    for y0, y1, colour, label, opacity in zones:
        fig.add_hrect(
            y0=y0, y1=y1,
            fillcolor=colour,
            opacity=opacity,
            line_width=0,
            annotation_text=label,
            annotation_position="right",
            annotation_font_size=9,
            annotation_font_color=colour,
            row=row, col=col,
        )


# ============================================================
# RUL chart overlay
# ============================================================
def add_rul_overlay(fig, health_series, rul_data, row: int, col: int):
    if not rul_data.get("show_rul"):
        return
    n = min(30, len(health_series))
    window = health_series.iloc[-n:]
    t_end  = n - 1
    slope  = rul_data["slope"]
    # Project forward
    rul_s  = rul_data["rul_hours"] * 3600
    ci_s   = rul_data["ci_hours"]  * 3600
    t_proj = np.array([t_end, t_end + rul_s])
    v_proj = np.array([window.iloc[-1], window.iloc[-1] + slope * rul_s])
    v_hi   = v_proj + np.array([0, abs(slope) * ci_s])
    v_lo   = v_proj - np.array([0, abs(slope) * ci_s])

    fig.add_trace(
        go.Scatter(x=list(range(t_end, t_end + 2)) + list(range(t_end + 1, t_end - 1, -1)),
                   y=list(v_hi) + list(v_lo[::-1]),
                   fill="toself", fillcolor="rgba(230,57,70,0.15)",
                   line=dict(width=0), showlegend=False, name="RUL CI"),
        row=row, col=col
    )
    fig.add_trace(
        go.Scatter(x=list(range(t_end, t_end + 2)), y=list(v_proj),
                   mode="lines", line=dict(color="#e63946", dash="dash", width=1.5),
                   name="RUL projection"),
        row=row, col=col
    )


# ============================================================
# SIDEBAR
# ============================================================
def render_sidebar():
    st.sidebar.markdown(
        "## EcoPulse",
        help="Industrial AI | Predictive Maintenance & Energy Intelligence"
    )
    st.sidebar.markdown("---")

    # Fault injection controls
    st.sidebar.markdown("### Demo Controls")
    col_a, col_b = st.sidebar.columns(2)
    inject_clicked = col_a.button("Inject\nbearing fault", use_container_width=True)
    reset_clicked  = col_b.button("Reset\ndemo",           use_container_width=True)

    if inject_clicked and not st.session_state.fault_injected:
        st.session_state.fault_injected   = True
        st.session_state.fault_start_time = time.time()
        st.session_state.demo_asset       = "Induction_Motor_1"

    if reset_clicked:
        st.session_state.fault_injected   = False
        st.session_state.fault_start_time = None
        st.session_state.fault_progress   = 0.0
        st.session_state.seed_counter    += 1

    # Update fault progress (40-second ramp)
    if st.session_state.fault_injected and st.session_state.fault_start_time:
        elapsed = time.time() - st.session_state.fault_start_time
        st.session_state.fault_progress = min(elapsed / 40.0, 1.0)

    st.sidebar.markdown("---")
    st.sidebar.markdown("### Asset & Window")
    machine_selected = st.sidebar.selectbox(
        "Target Asset",
        list(MOTOR_CATALOGUE.keys()),
        index=list(MOTOR_CATALOGUE.keys()).index(st.session_state.demo_asset)
        if st.session_state.demo_asset in MOTOR_CATALOGUE else 0
    )

    num_samples = st.sidebar.slider("Observation Window (s)", 60, 300, 120, 10)

    st.sidebar.markdown("---")
    st.sidebar.markdown("### Energy & Cost Settings")

    production_rate   = st.sidebar.number_input("Production Rate (units/hr)", value=120, step=10)
    solar_capacity_kw = st.sidebar.number_input("Solar PV Capacity (kW)", value=8.5, step=0.5)
    grid_cost_inr     = st.sidebar.number_input("Grid Tariff (₹/kWh)", value=8.50, step=0.50)
    downtime_inr_hr   = st.sidebar.number_input("Downtime Cost (₹/hr)", value=12000, step=1000)
    hardware_cost     = st.sidebar.number_input("Edge Deployment Cost (₹)", value=25000, step=5000)
    co2_factor        = st.sidebar.number_input("CO₂ Factor (kg/kWh)", value=0.82, step=0.05)

    live_stream  = st.sidebar.toggle("Live Stream", value=True)
    refresh_rate = st.sidebar.slider("Refresh (s)", 1, 5, 2)

    return {
        "machine":        machine_selected,
        "num_samples":    num_samples,
        "production_rate":production_rate,
        "solar_kw":       solar_capacity_kw,
        "grid_cost":      grid_cost_inr,
        "downtime_inr":   downtime_inr_hr,
        "hardware_cost":  hardware_cost,
        "co2_factor":     co2_factor,
        "live_stream":    live_stream,
        "refresh_rate":   refresh_rate,
    }


# ============================================================
# MAIN DASHBOARD
# ============================================================
def render_dashboard(cfg: dict):
    fault_progress = st.session_state.fault_progress
    seed_off       = st.session_state.seed_counter

    # ---------- per-asset telemetry ----------
    tel_df = generate_machine_telemetry(
        cfg["machine"],
        num_samples=cfg["num_samples"],
        inject_fault=st.session_state.fault_injected,
        fault_progress=fault_progress,
        seed_offset=seed_off,
    )
    res_df = analyzer.evaluate_stream(tel_df)

    # solar noise
    rng = np.random.default_rng(int(time.time()) % 10000)
    res_df["solar_kw"] = np.clip(
        rng.normal(cfg["solar_kw"], 0.4, len(res_df)), 0, cfg["solar_kw"] * 1.2
    )

    latest   = res_df.iloc[-1]
    spec     = MOTOR_CATALOGUE[cfg["machine"]]
    rating_kw  = spec["rating_kw"]
    rated_i    = spec["rated_current_a"]

    # ---- health / severity ----
    health      = float(latest["health_score_%"])
    anomaly_pct = round(100.0 - health, 1)

    # ---- efficiency class ----
    eff_pct  = float(latest.get("efficiency_pct", 94.0))
    ec       = estimate_efficiency_class(eff_pct, rating_kw)

    # ---- fleet simulation (all three motors) ----
    fleet_data = []
    fleet_eff  = []
    for name, mspec in MOTOR_CATALOGUE.items():
        fp = fault_progress if name == cfg["machine"] and st.session_state.fault_injected else 0.0
        f_df = generate_machine_telemetry(name, num_samples=60,
                                          inject_fault=fp > 0,
                                          fault_progress=fp, seed_offset=seed_off)
        f_res = analyzer.evaluate_stream(f_df)
        f_lat = f_res.iloc[-1]
        f_h   = float(f_lat["health_score_%"])
        f_sev = round(100.0 - f_h, 1)
        rul   = MachineHealthAnalyzer.compute_rul(f_res["health_score_%"])
        fleet_data.append({
            "name":        name,
            "label":       mspec["label"],
            "health":      f_h,
            "severity":    f_sev,
            "criticality": mspec["criticality"],
            "rul_hours":   rul.get("rul_hours"),
            "trend_slope": rul.get("slope", 0.0),
            "power_kw":    float(f_lat["active_power_kw"]),
            "rating_kw":   mspec["rating_kw"],
            "eff_pct":     float(f_lat.get("efficiency_pct", 94.0)),
            "vib_mm_s":    float(f_lat["vibration_mm_s"]),
            "temp_c":      float(f_lat["temperature_c"]),
        })
        fleet_eff.append(estimate_efficiency_class(float(f_lat.get("efficiency_pct", 94.0)),
                                                    mspec["rating_kw"]))

    fleet_queue = build_fleet_action_queue(fleet_data, inr_per_hour=cfg["downtime_inr"])

    # ---- audit engine ----
    audit_eng = EnergyAuditEngine(
        baseline_sec=15.0 / max(cfg["production_rate"], 1),
        grid_co2_factor=cfg["co2_factor"],
        grid_tariff_inr=cfg["grid_cost"],
    )
    audit_res = audit_eng.evaluate_compliance(
        active_power_kw   =float(latest["active_power_kw"]),
        production_rate_uph=cfg["production_rate"],
        solar_kw          =float(latest["solar_kw"]),
        efficiency_pct    =eff_pct,
        rating_kw         =rating_kw,
    )

    # ---- financials ----
    fleet_fin_df = pd.DataFrame([
        {"active_power_kw": r["power_kw"], "rating_kw": r["rating_kw"]}
        for r in fleet_data
    ])
    fin = audit_eng.fleet_financial_summary(fleet_fin_df, cfg["hardware_cost"])

    # ---- KWh saved vs baseline (rolling window) ----
    kwh_saved_window = float(res_df["wasted_power_kw"].sum()) / 3600 * cfg["num_samples"]

    # ---- active alert count ----
    total_alerts = int(res_df["is_anomaly"].sum())
    inr_at_risk  = round(anomaly_pct / 100 * cfg["downtime_inr"] * 8, 0)

    # ---- RUL ----
    rul_data = MachineHealthAnalyzer.compute_rul(res_df["health_score_%"])

    # ---- fault diagnosis ----
    iso_lims = ISO_10816_ZONES[get_iso_machine_class(rating_kw)]
    fault_diag = diagnose_fault(
        vibration_mm_s  =float(latest["vibration_mm_s"]),
        temperature_c   =float(latest["temperature_c"]),
        current_a       =float(latest["current_a"]),
        load_factor     =float(latest["load_factor"]),
        rated_current_a =rated_i,
        iso_class_limits=iso_lims,
        health_score    =health,
    )

    # ---- explainability contributions ----
    z_vib  = float(latest.get("z_vibration", 0))
    z_temp = float(latest.get("z_temp", 0))
    z_cur  = float(latest.get("z_current", 0))
    z_pwr  = float(latest.get("z_power", 0))
    z_tot  = max(z_vib + z_temp + z_cur + z_pwr, 1e-6)
    contrib = {
        "Vibration": z_vib / z_tot * 100,
        "Temperature": z_temp / z_tot * 100,
        "Current": z_cur / z_tot * 100,
        "Power": z_pwr / z_tot * 100,
    }

    # ============================================================
    # HEADER
    # ============================================================
    col_h1, col_h2 = st.columns([8, 2])
    with col_h1:
        st.markdown("## EcoPulse — Industrial AI Dashboard")
        st.caption("Schneider Electric Yuva Yodha | Smart Manufacturing Track")
    with col_h2:
        render_sim_badge()
        st.caption(f"Asset: **{spec['label']}**")

    render_methodology()

    # ---- fault injection status banner ----
    if st.session_state.fault_injected:
        fp = fault_progress
        pct_bar = int(fp * 100)
        st.markdown(f"""
<div style="background:#1a0a00;border:1px solid #e63946;border-radius:6px;
            padding:10px 16px;margin:8px 0;">
  <b style="color:#e63946;">BEARING FAULT INJECTED</b>&nbsp;&nbsp;
  Progress: <b>{pct_bar}%</b>
  <div style="background:#0d1b2a;border-radius:3px;height:6px;margin-top:6px;">
    <div style="background:#e63946;width:{pct_bar}%;height:6px;border-radius:3px;"></div>
  </div>
</div>""", unsafe_allow_html=True)

    # ============================================================
    # TOP KPI CARDS
    # ============================================================
    st.markdown("---")
    k1, k2, k3, k4 = st.columns(4)

    fleet_avg_health = round(np.mean([r["health"] for r in fleet_data]), 1)
    health_colour = "green" if fleet_avg_health >= 80 else "amber" if fleet_avg_health >= 50 else "red"

    with k1:
        kpi_card("Fleet Health",
                 f"{fleet_avg_health:.1f}%",
                 f"{'Degrading' if fleet_avg_health < 75 else 'Nominal'}",
                 health_colour)
    with k2:
        alert_colour = "green" if total_alerts == 0 else "amber" if total_alerts < 5 else "red"
        kpi_card("Active Alerts", str(total_alerts),
                 f"{'Critical' if health < 50 else 'Warning' if health < 75 else 'Nominal'}",
                 alert_colour)
    with k3:
        kpi_card("₹ at Risk",
                 f"₹{inr_at_risk:,.0f}",
                 f"Downtime exposure (8 h)",
                 "red" if inr_at_risk > 50000 else "amber")
    with k4:
        kpi_card("kWh Saved vs Baseline",
                 f"{kwh_saved_window:.1f} kWh",
                 f"In {cfg['num_samples']}s window",
                 "blue")

    st.markdown("---")

    # ============================================================
    # TABS
    # ============================================================
    tab1, tab2, tab3 = st.tabs([
        "Live Asset Twin",
        "Fleet & Action Queue",
        "Audit Exporter",
    ])

    ts_key = int(time.time() * 1000)

    # ============================================================
    # TAB 1 — LIVE DIGITAL TWIN
    # ============================================================
    with tab1:
        render_sim_badge()
        st.markdown(f"### {spec['label']} — Real-Time Telemetry")

        # quick metrics row
        m1, m2, m3, m4, m5 = st.columns(5)
        m1.metric("Power",      f"{latest['active_power_kw']:.1f} kW")
        m2.metric("Current",    f"{latest['current_a']:.1f} A")
        m3.metric("Temp",       f"{latest['temperature_c']:.1f} °C")
        m4.metric("Vibration",  f"{latest['vibration_mm_s']:.3f} mm/s")
        m5.metric("Health",     f"{health:.1f}%",
                  delta=f"{'Warning' if health < 75 else 'Nominal'}",
                  delta_color="inverse" if health < 75 else "normal")

        st.markdown("---")

        # ---- ALERT CARD ----
        if health < 80 or st.session_state.fault_injected:
            sev_label = "CRITICAL" if health < 50 else "WARNING"
            sev_level = "critical" if health < 50 else "warn"
            what_msg  = (
                "Bearing fault detected — vibration exceeding ISO 10816 zone B"
                if st.session_state.fault_injected
                else "Anomaly pattern detected in sensor stream"
            )
            action_msg = (
                fault_diag[0]["action"] if fault_diag
                else "Inspect motor and reduce load"
            )
            cost_b = fault_diag[0]["cost_band"] if fault_diag else "₹5,000 – ₹20,000"
            urgency = "Immediate (<4 h)" if sev_level == "critical" else "Within 24 h"
            render_alert_card(
                asset=cfg["machine"],
                severity_label=sev_label,
                what=what_msg,
                why_contributions=contrib,
                action=action_msg,
                cost_band=cost_b,
                urgency=urgency,
                severity_level=sev_level,
            )

        # ---- RUL BANNER ----
        if rul_data.get("show_rul"):
            st.markdown(f"""
<div style="background:#1a0000;border:1px solid #e63946;border-radius:6px;
            padding:8px 16px;margin:4px 0 8px 0;">
  <b style="color:#e63946;">Remaining Useful Life:</b>
  &nbsp; ~{rul_data['rul_hours']} h &nbsp; <span style="color:#7fa7cc;">(± {rul_data['ci_hours']} h)</span>
  &nbsp;&nbsp;<span style="font-size:0.8rem;color:#7fa7cc;">Based on health-score trend extrapolation</span>
</div>""", unsafe_allow_html=True)

        # ---- MAIN TELEMETRY CHART ----
        fig = make_subplots(
            rows=4, cols=1,
            shared_xaxes=True,
            vertical_spacing=0.05,
            subplot_titles=(
                "Active Power vs Solar (kW)",
                "Temperature (°C)",
                "Vibration (mm/s)  —  ISO 10816 zones",
                "Health Index (%)",
            )
        )
        fig.update_layout(
            paper_bgcolor="#0d1b2a",
            plot_bgcolor="#111f30",
            font=dict(color="#dce3ec", size=11),
            height=680,
            margin=dict(l=10, r=10, t=30, b=10),
            hovermode="x unified",
            legend=dict(bgcolor="#111f30", bordercolor="#1e3048"),
        )
        for i in range(1, 5):
            fig.update_xaxes(gridcolor="#1e3048", row=i, col=1)
            fig.update_yaxes(gridcolor="#1e3048", row=i, col=1)

        anomalies = res_df[res_df["is_anomaly"]]
        idx = list(range(len(res_df)))

        # Row 1 — power
        fig.add_trace(go.Scatter(x=idx, y=res_df["active_power_kw"],
                                  mode="lines", name="Power",
                                  line=dict(color="#4895ef", width=2)), row=1, col=1)
        fig.add_trace(go.Scatter(x=idx, y=res_df["solar_kw"],
                                  mode="lines", name="Solar",
                                  line=dict(color="#2dc653", width=1.5, dash="dash")), row=1, col=1)
        # Row 2 — temperature
        fig.add_trace(go.Scatter(x=idx, y=res_df["temperature_c"],
                                  mode="lines", name="Temp",
                                  line=dict(color="#ff6b35", width=2)), row=2, col=1)
        # Row 3 — vibration + ISO zones
        add_iso_zones(fig, rating_kw, row=3, col=1,
                      y_max=max(res_df["vibration_mm_s"].max() * 1.3, ISO_10816_ZONES[get_iso_machine_class(rating_kw)]["C"] * 1.2))
        fig.add_trace(go.Scatter(x=idx, y=res_df["vibration_mm_s"],
                                  mode="lines", name="Vibration",
                                  line=dict(color="#b8a7e0", width=2)), row=3, col=1)
        # Row 4 — health + RUL overlay
        fig.add_trace(go.Scatter(x=idx, y=res_df["health_score_%"],
                                  mode="lines", name="Health",
                                  line=dict(color="#2dc653" if health >= 75 else "#ffba08" if health >= 50 else "#e63946",
                                            width=2)), row=4, col=1)
        add_rul_overlay(fig, res_df["health_score_%"], rul_data, row=4, col=1)

        # anomaly markers on power
        if len(anomalies):
            a_idx = anomalies.index.tolist()
            fig.add_trace(go.Scatter(
                x=a_idx, y=anomalies["active_power_kw"],
                mode="markers", name="Anomaly",
                marker=dict(color="#e63946", size=7, symbol="x-thin-open", line=dict(width=2))
            ), row=1, col=1)

        st.plotly_chart(fig, use_container_width=True, key=f"main_chart_{ts_key}")

        st.markdown("---")

        # ---- EXPLAINABILITY ----
        col_e1, col_e2 = st.columns([1, 1])
        with col_e1:
            st.markdown("#### Anomaly Sensor Contributions")
            contrib_df = pd.DataFrame({
                "Sensor":       list(contrib.keys()),
                "Contribution": [round(v, 1) for v in contrib.values()],
            }).sort_values("Contribution", ascending=True)
            fig_contrib = go.Figure(go.Bar(
                x=contrib_df["Contribution"],
                y=contrib_df["Sensor"],
                orientation="h",
                marker_color=["#4895ef", "#ff6b35", "#ffba08", "#e63946"],
                text=[f"{v:.1f}%" for v in contrib_df["Contribution"]],
                textposition="auto",
            ))
            fig_contrib.update_layout(
                paper_bgcolor="#0d1b2a", plot_bgcolor="#111f30",
                font=dict(color="#dce3ec"), height=220,
                xaxis_title="% Contribution",
                margin=dict(l=10, r=10, t=10, b=10),
            )
            st.plotly_chart(fig_contrib, use_container_width=True, key=f"contrib_{ts_key}")

        with col_e2:
            st.markdown("#### Fault Diagnosis  *(signature-based, simulated)*")
            for fd in fault_diag[:4]:
                bar_w = int(fd["likelihood"])
                colour = "#e63946" if fd["likelihood"] >= 40 else "#ffba08" if fd["likelihood"] >= 20 else "#4895ef"
                st.markdown(f"""
<div style="margin-bottom:8px;">
  <div style="font-size:0.82rem;color:#dce3ec;font-weight:600;">{fd['fault']}
    <span style="float:right;color:{colour};">{fd['likelihood']:.1f}%</span>
  </div>
  <div style="background:#1e3048;border-radius:4px;height:6px;margin:3px 0;">
    <div style="background:{colour};width:{bar_w}%;height:6px;border-radius:4px;"></div>
  </div>
  <div style="font-size:0.77rem;color:#7fa7cc;">{fd['action']} &nbsp;|&nbsp; {fd['cost_band']}</div>
</div>""", unsafe_allow_html=True)

        # ---- EFFICIENCY CLASS ----
        st.markdown("---")
        st.markdown("#### Estimated Efficiency Class  *(illustrative — IS 12615 / IEC 60034-30-1)*")
        e1, e2, e3 = st.columns(3)
        e1.metric("Estimated Efficiency", f"{ec['efficiency_pct']}%")
        e2.metric("Class Label", ec["class_label"])
        e3.metric(f"IE3 threshold ({ec['rating_kw']} kW)", f"≥{ec['ie3_threshold']}%")
        st.caption("This is an estimate from simulated mechanical/electrical data. It is not an official BEE star rating.")

    # ============================================================
    # TAB 2 — FLEET & ACTION QUEUE
    # ============================================================
    with tab2:
        render_sim_badge()
        st.markdown("### Fleet Overview")

        # ---- fleet KPI strip ----
        fc1, fc2, fc3 = st.columns(3)
        fix_now_count = (fleet_queue["Action"] == "Fix Now").sum()
        monitor_count = (fleet_queue["Action"] == "Monitor").sum()
        inr_total_avoided = sum(
            float(str(r).replace("₹", "").replace(",", ""))
            for r in fleet_queue["₹ Avoided"]
        )
        fc1.metric("Fix Now", str(fix_now_count), delta="assets need action", delta_color="inverse" if fix_now_count > 0 else "normal")
        fc2.metric("Monitor", str(monitor_count))
        fc3.metric("₹ Downtime Avoided", f"₹{inr_total_avoided:,.0f}")

        st.markdown("---")

        # ---- fleet table ----
        st.markdown("#### Action Queue")
        display_cols = ["Asset", "Health (%)", "Severity", "Risk Index", "Action", "RUL (h)", "₹ Avoided"]
        st.dataframe(
            fleet_queue[display_cols],
            use_container_width=True,
            hide_index=True,
        )

        st.markdown("---")

        # ---- fleet power chart ----
        col_fl1, col_fl2 = st.columns(2)
        with col_fl1:
            fleet_plot_df = pd.DataFrame({
                "Asset":       [r["label"] for r in fleet_data],
                "Power (kW)":  [r["power_kw"] for r in fleet_data],
                "Health (%)":  [r["health"] for r in fleet_data],
                "Action":      fleet_queue["Action"].tolist(),
            })
            colour_map = {"Fix Now": "#e63946", "Monitor": "#ffba08", "Can Wait": "#2dc653"}
            fig_fl = px.bar(
                fleet_plot_df, x="Asset", y="Power (kW)", color="Action",
                color_discrete_map=colour_map,
                title="Fleet Power Consumption by Action Tier",
                text="Health (%)",
            )
            fig_fl.update_layout(
                paper_bgcolor="#0d1b2a", plot_bgcolor="#111f30",
                font=dict(color="#dce3ec"), height=320,
                margin=dict(l=10, r=10, t=40, b=10),
            )
            st.plotly_chart(fig_fl, use_container_width=True, key=f"fleet_bar_{ts_key}")

        with col_fl2:
            # Efficiency class per asset
            st.markdown("#### Estimated Efficiency Class per Asset  *(illustrative)*")
            for r, ef in zip(fleet_data, fleet_eff):
                bar_w = max(int(r["eff_pct"]) - 60, 0)  # scale from 60 %
                st.markdown(f"""
<div style="margin-bottom:10px;">
  <div style="font-size:0.82rem;font-weight:600;color:#dce3ec;">{r['label']}
    <span style="float:right;color:{ef['colour']};">{ef['class_label']}</span>
  </div>
  <div style="background:#1e3048;border-radius:4px;height:6px;margin:3px 0;">
    <div style="background:{ef['colour']};width:{bar_w}%;height:6px;border-radius:4px;"></div>
  </div>
  <div style="font-size:0.75rem;color:#7fa7cc;">η ≈ {r['eff_pct']:.1f}%  |  IE2 ≥ {ef['ie2_threshold']}%  |  IE3 ≥ {ef['ie3_threshold']}%</div>
</div>""", unsafe_allow_html=True)
            st.caption("Illustrative only — not official BEE star ratings.")

        st.markdown("---")

        # ---- Scope 2 / financial ----
        st.markdown("#### Financial & Carbon Recovery Model")
        f1, f2, f3, f4 = st.columns(4)
        f1.metric("Deployment Cost",      f"₹{cfg['hardware_cost']:,.0f}")
        f2.metric("Daily Energy Loss",    f"₹{fin['daily_loss_inr']:,.0f}")
        f3.metric("Annual ₹ Savings est.",f"₹{fin['inr_wasted_yr']:,.0f}")
        f4.metric("Payback Period",       f"{fin['payback_months']} months")

        st.markdown("---")
        co2_annual = audit_res["net_scope2_kg_co2_hr"] * 16 * 300 / 1000
        st.metric("Annual Carbon Offset (Solar)", f"{co2_annual:.2f} t CO₂")

    # ============================================================
    # TAB 3 — AUDIT EXPORTER
    # ============================================================
    with tab3:
        render_sim_badge()
        st.markdown("### Energy & Compliance Audit Export")
        st.caption("All figures are simulated. See methodology expander above.")

        report_gen = AuditReportGenerator(
            asset_name      =cfg["machine"],
            audit_data      =audit_res,
            telemetry_df    =res_df,
            efficiency_class=ec,
            fault_diagnosis =fault_diag,
            rul_data        =rul_data,
            fleet_summary   =fin,
        )

        text_report = report_gen.generate_text_report()

        c1, c2 = st.columns(2)
        with c1:
            st.markdown("#### Report Preview")
            st.text_area("Full audit report", text_report, height=400)

        with c2:
            st.markdown("#### Downloads")

            st.download_button(
                "Download Report (.txt)",
                data=text_report,
                file_name=f"ecopulse_audit_{cfg['machine']}.txt",
                mime="text/plain",
                use_container_width=True,
            )

            csv_data = report_gen.generate_csv_log()
            st.download_button(
                "Download Telemetry (.csv)",
                data=csv_data,
                file_name=f"telemetry_{cfg['machine']}.csv",
                mime="text/csv",
                use_container_width=True,
            )

            pdf_bytes = report_gen.generate_pdf()
            if pdf_bytes:
                st.download_button(
                    "Download Audit Report (.pdf)",
                    data=pdf_bytes,
                    file_name=f"ecopulse_audit_{cfg['machine']}.pdf",
                    mime="application/pdf",
                    use_container_width=True,
                )
            else:
                st.info("PDF export requires `fpdf2`. Run: `pip install fpdf2`")

        st.markdown("---")
        st.markdown("#### Report Sections")
        sections = [
            ("1. Executive Summary",   "Fleet health, anomaly count, savings estimate, payback"),
            ("2. Scope & Method",      "Simulator methodology, standards cited, data generation"),
            ("3. Findings",            "Per-asset telemetry aggregates, SEC, EnPI, efficiency class"),
            ("4. Fault Diagnosis",     "Ranked fault types with actions and cost bands (signature-based)"),
            ("5. Recommendations",     "kWh/year saved, ₹/year saved, CO₂ offset, payback period"),
            ("Annexures",              "Assumptions, standards reference list, data summary, disclaimer"),
        ]
        for title, desc in sections:
            st.markdown(f"**{title}** — {desc}")

        st.markdown("---")
        st.caption(
            "SIMULATION DISCLAIMER: All data in this report is generated by a "
            "physics-inspired simulator. No real plant or machinery data has been used. "
            "This report is produced for demonstration purposes only (Schneider Electric Yuva Yodha)."
        )


# ============================================================
# ENTRY POINT
# ============================================================
cfg = render_sidebar()
render_dashboard(cfg)

if cfg["live_stream"]:
    time.sleep(cfg["refresh_rate"])
    st.rerun()
