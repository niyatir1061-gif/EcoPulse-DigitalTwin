"""
ml_engine.py
Health scoring, anomaly detection, RUL projection, fault diagnosis,
explainability, and fleet action queue for EcoPulse.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest


# ---------------------------------------------------------------------------
# IE2 / IE3 efficiency thresholds (IS 12615 / IEC 60034-30-1)
# ---------------------------------------------------------------------------
IE_THRESHOLDS = {
    7.5:  (89.8, 91.7),
    15.0: (91.8, 93.6),
    30.0: (93.2, 95.0),
}

# kW → closest catalogue key
def _nearest_ie_key(rating_kw: float) -> float:
    return min(IE_THRESHOLDS.keys(), key=lambda k: abs(k - rating_kw))


def estimate_efficiency_class(efficiency_pct: float, rating_kw: float) -> dict:
    """
    Compare estimated efficiency against IE2/IE3 thresholds.
    Returns a dict with class label and thresholds for display.
    """
    key = _nearest_ie_key(rating_kw)
    ie2_min, ie3_min = IE_THRESHOLDS[key]

    if efficiency_pct >= ie3_min:
        label = "IE3 (Premium Efficiency)"
        colour = "#2ecc71"
    elif efficiency_pct >= ie2_min:
        label = "IE2 (High Efficiency)"
        colour = "#f39c12"
    else:
        label = "IE1 or below"
        colour = "#e74c3c"

    return {
        "efficiency_pct": round(efficiency_pct, 1),
        "class_label":    label,
        "colour":         colour,
        "ie2_threshold":  ie2_min,
        "ie3_threshold":  ie3_min,
        "rating_kw":      key,
    }


# ---------------------------------------------------------------------------
# Fault diagnosis  (signature-based, simulated)
# ---------------------------------------------------------------------------
def diagnose_fault(
    vibration_mm_s: float,
    temperature_c: float,
    current_a: float,
    load_factor: float,
    rated_current_a: float,
    iso_class_limits: dict,
    health_score: float,
) -> list[dict]:
    """
    Rule-based fault classification.
    Returns a list of fault hypotheses sorted by descending likelihood.
    Each entry: {fault, likelihood_pct, action, cost_band}
    """
    vib_zone_b = iso_class_limits["B"]
    vib_zone_c = iso_class_limits["C"]
    i_ratio    = current_a / max(rated_current_a, 1.0)
    temp_high  = temperature_c > 70.0
    temp_very  = temperature_c > 85.0
    vib_high   = vibration_mm_s > vib_zone_b
    vib_crit   = vibration_mm_s > vib_zone_c

    scores = {
        "Bearing Wear":    0.0,
        "Misalignment":    0.0,
        "Imbalance":       0.0,
        "Thermal Overload":0.0,
    }

    # Bearing wear: high vibration, moderate temp rise, load-independent
    if vib_high:
        scores["Bearing Wear"] += 0.55
    if vib_crit:
        scores["Bearing Wear"] += 0.25
    if temperature_c > 55 and not temp_very:
        scores["Bearing Wear"] += 0.10

    # Misalignment: vibration moderately high, relatively load-independent
    if vib_high and load_factor < 0.65:
        scores["Misalignment"] += 0.40
    if vibration_mm_s > vib_zone_b * 0.7:
        scores["Misalignment"] += 0.15

    # Imbalance: vibration varies with load, current deviation
    if vib_high and i_ratio > 0.95:
        scores["Imbalance"] += 0.35
    if vibration_mm_s > vib_zone_b * 0.5 and load_factor > 0.80:
        scores["Imbalance"] += 0.20

    # Thermal overload: temperature primary driver
    if temp_high:
        scores["Thermal Overload"] += 0.50
    if temp_very:
        scores["Thermal Overload"] += 0.30
    if i_ratio > 1.05:
        scores["Thermal Overload"] += 0.20

    # Normalise to percentages (floor at 5 %)
    total = max(sum(scores.values()), 1e-6)
    results = []
    actions = {
        "Bearing Wear":    ("Replace / relubricate bearing", "₹8,000 – ₹25,000"),
        "Misalignment":    ("Realign shaft coupling",        "₹3,000 – ₹10,000"),
        "Imbalance":       ("Balance rotor; check coupling", "₹5,000 – ₹15,000"),
        "Thermal Overload":("Check cooling, reduce load",    "₹1,500 – ₹6,000"),
    }
    for fault, raw in sorted(scores.items(), key=lambda x: -x[1]):
        pct = max(round(raw / total * 100, 1), 5.0)
        action, cost = actions[fault]
        results.append({
            "fault":       fault,
            "likelihood":  pct,
            "action":      action,
            "cost_band":   cost,
        })

    return results


# ---------------------------------------------------------------------------
# Main health analyser
# ---------------------------------------------------------------------------
class MachineHealthAnalyzer:
    FEATURE_COLUMNS = [
        "current_a",
        "vibration_mm_s",
        "temperature_c",
        "active_power_kw",
    ]

    def __init__(self, baseline_kw: float = 15.0):
        self.baseline_kw      = float(baseline_kw)
        self._baseline_mean   = None
        self._baseline_std    = None
        self._model           = IsolationForest(
            n_estimators=100,
            contamination="auto",
            random_state=42,
        )

    def train_baseline(self, baseline_df: pd.DataFrame):
        feats = baseline_df[self.FEATURE_COLUMNS].astype(float)
        self._baseline_mean = feats.mean()
        self._baseline_std  = feats.std().replace(0, 1.0)
        self._model.fit(feats)
        return self

    def evaluate_stream(self, telemetry_df: pd.DataFrame) -> pd.DataFrame:
        if self._baseline_mean is None:
            raise RuntimeError("Call train_baseline first.")

        df     = telemetry_df.copy()
        feats  = df[self.FEATURE_COLUMNS].astype(float)
        z      = (feats - self._baseline_mean) / self._baseline_std
        sev    = z.abs().clip(upper=6.0).mean(axis=1)

        health = (100.0 - sev * 16.0).clip(0.0, 100.0)
        preds  = self._model.predict(feats)

        df["is_anomaly"]      = (preds == -1) | (sev >= 1.5)
        df["health_score_%"]  = np.round(health, 1)
        df["wasted_power_kw"] = np.round(
            np.maximum(df["active_power_kw"] - self.baseline_kw, 0.0), 2
        )

        # Per-sensor z-score contribution (used for explainability)
        df["z_current"]   = np.round(z["current_a"].abs(), 3)
        df["z_vibration"] = np.round(z["vibration_mm_s"].abs(), 3)
        df["z_temp"]      = np.round(z["temperature_c"].abs(), 3)
        df["z_power"]     = np.round(z["active_power_kw"].abs(), 3)

        return df

    @staticmethod
    def compute_rul(health_series: pd.Series,
                    critical_threshold: float = 30.0,
                    dt_seconds: float = 1.0
                    ) -> dict:
        """
        Fit a linear trend to the last 30 health points and extrapolate.
        Returns dict with:
          show_rul   bool
          rul_hours  float
          ci_hours   float
          slope      float (health-points/second; negative = degrading)
        """
        n = min(30, len(health_series))
        window = health_series.iloc[-n:].values
        t      = np.arange(n) * dt_seconds

        if n < 5:
            return {"show_rul": False}

        coeffs = np.polyfit(t, window, 1)
        slope  = coeffs[0]           # health-points per second

        # Only show RUL if trend is clearly degrading
        if slope >= -0.005:
            return {"show_rul": False}

        current_health = window[-1]
        seconds_to_crit = (current_health - critical_threshold) / (-slope)
        seconds_to_crit = max(seconds_to_crit, 0.0)

        # 90 % CI: residual std → propagated uncertainty
        residuals = window - np.polyval(coeffs, t)
        resid_std = np.std(residuals)
        ci_seconds = 1.645 * resid_std / abs(slope) if abs(slope) > 1e-9 else 0.0

        return {
            "show_rul":  True,
            "rul_hours": round(seconds_to_crit / 3600, 1),
            "ci_hours":  round(ci_seconds / 3600, 1),
            "slope":     round(slope, 6),
        }


# ---------------------------------------------------------------------------
# Fleet action queue
# ---------------------------------------------------------------------------
def build_fleet_action_queue(fleet_rows: list[dict],
                              inr_per_hour: float = 12000.0) -> pd.DataFrame:
    """
    Each fleet_row: {name, health, severity, criticality, rul, trend_slope}
    Returns sorted DataFrame with action tier and ₹ downtime avoided.
    """
    rows = []
    for r in fleet_rows:
        health      = r.get("health", 100.0)
        severity    = r.get("severity", 0.0)    # anomaly score 0–100
        criticality = r.get("criticality", 1)   # 1–3
        rul_hours   = r.get("rul_hours", None)
        slope       = r.get("trend_slope", 0.0)

        # Risk index
        trend_factor = max(-slope * 3600, 0.0)  # health-pts/hour degradation
        risk = (severity / 100.0) * criticality * (1.0 + trend_factor * 0.1)

        if health < 50 or risk > 1.8:
            tier = "Fix Now"
            tier_colour = "#e74c3c"
        elif health < 75 or risk > 0.8:
            tier = "Monitor"
            tier_colour = "#f39c12"
        else:
            tier = "Can Wait"
            tier_colour = "#2ecc71"

        # ₹ downtime avoided = RUL hours × ₹/hour (if RUL known, else estimated)
        if rul_hours and rul_hours > 0:
            inr_avoided = round(rul_hours * inr_per_hour, 0)
        else:
            # rough proxy: 1 day of avoided unplanned downtime
            inr_avoided = round(8 * inr_per_hour * (severity / 100.0), 0)

        rows.append({
            "Asset":          r.get("name", "Unknown"),
            "Health (%)":     round(health, 1),
            "Severity":       round(severity, 1),
            "Risk Index":     round(risk, 2),
            "Action":         tier,
            "_colour":        tier_colour,
            "RUL (h)":        rul_hours if rul_hours else "—",
            "₹ Avoided":      f"₹{inr_avoided:,.0f}",
        })

    rows.sort(key=lambda x: -x["Risk Index"])
    return pd.DataFrame(rows)
