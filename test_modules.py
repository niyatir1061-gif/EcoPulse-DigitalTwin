"""Quick integration test — run with: python test_modules.py"""
import sys

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

errors = []

def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        errors.append(name)

# ---- telemetry shape ----
df = generate_machine_telemetry("Induction_Motor_1", num_samples=120)
check("telemetry shape",       df.shape == (120, 15))
check("vibration_mm_s exists", "vibration_mm_s" in df.columns)
check("efficiency_pct exists", "efficiency_pct" in df.columns)
check("load_factor exists",    "load_factor"    in df.columns)

# ---- health analyser ----
baseline_df = generate_machine_telemetry("Induction_Motor_1", num_samples=300, inject_fault=False)
ana = MachineHealthAnalyzer(baseline_kw=15.0)
ana.train_baseline(baseline_df)
res = ana.evaluate_stream(df)
check("health in 0-100", res["health_score_%"].between(0, 100).all())
check("z columns exist",  all(c in res.columns for c in ["z_vibration","z_temp","z_current","z_power"]))

# ---- RUL ----
rul_h = MachineHealthAnalyzer.compute_rul(res["health_score_%"])
check("RUL hidden on healthy", not rul_h.get("show_rul", False))

fdf  = generate_machine_telemetry("Induction_Motor_1", num_samples=120, inject_fault=True, fault_progress=0.85)
fres = ana.evaluate_stream(fdf)
rul_f = MachineHealthAnalyzer.compute_rul(fres["health_score_%"])
check("RUL shows on fault", rul_f.get("show_rul", False))

# ---- fault diagnosis ----
lat = fres.iloc[-1]
iso_lims = ISO_10816_ZONES[get_iso_machine_class(15.0)]
diag = diagnose_fault(
    float(lat["vibration_mm_s"]), float(lat["temperature_c"]),
    float(lat["current_a"]),      float(lat["load_factor"]),
    28.5, iso_lims,               float(lat["health_score_%"]),
)
check("fault diag returns 4 items", len(diag) == 4)
check("bearing wear top fault",     diag[0]["fault"] == "Bearing Wear")

# ---- efficiency class ----
ec_ie3 = estimate_efficiency_class(94.0, 15.0)
check("IE3 label",  ec_ie3["class_label"].startswith("IE3"))
ec_ie2 = estimate_efficiency_class(92.0, 15.0)
check("IE2 label",  ec_ie2["class_label"].startswith("IE2"))
ec_ie1 = estimate_efficiency_class(88.0, 15.0)
check("IE1 label",  ec_ie1["class_label"].startswith("IE1"))

# ---- fleet action queue ----
fleet_rows = [
    {"name":"Fix", "health":30, "severity":70, "criticality":3, "rul_hours":5,  "trend_slope":-0.02},
    {"name":"Mon", "health":70, "severity":30, "criticality":2, "rul_hours":None,"trend_slope":0},
    {"name":"Wait","health":95, "severity":5,  "criticality":1, "rul_hours":None,"trend_slope":0},
]
fq = build_fleet_action_queue(fleet_rows, 12000)
check("fleet queue 3 rows", len(fq) == 3)
check("fix-now first",      fq.iloc[0]["Action"] == "Fix Now")

# ---- audit engine ----
ae  = EnergyAuditEngine()
ar  = ae.evaluate_compliance(16.0, 120, solar_kw=5.0, efficiency_pct=91.5, rating_kw=15.0)
check("audit has kwh_saved_yr", "kwh_saved_yr" in ar)
check("audit has inr_saved_yr", "inr_saved_yr" in ar)

# ---- report generator ----
rg  = AuditReportGenerator("Induction_Motor_1", ar, res,
                            efficiency_class=ec_ie2, fault_diagnosis=diag, rul_data=rul_f)
txt = rg.generate_text_report()
check("report has exec summary",    "EXECUTIVE SUMMARY"  in txt)
check("report has disclaimer",      "SIMULATION"         in txt)
check("report has recommendations", "RECOMMENDATIONS"    in txt)
check("report has annexures",       "ANNEXURES"          in txt)

print()
if errors:
    print(f"FAILED: {errors}")
    sys.exit(1)
else:
    print("ALL CHECKS PASSED")
