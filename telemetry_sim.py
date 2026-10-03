"""
telemetry_sim.py
Physics-inspired coupled sensor simulator for EcoPulse.

Coupling chain:
  shift load profile → current → temperature (first-order thermal lag) → vibration
  All values are synthetic. No real plant data is used.
"""

import numpy as np
import pandas as pd
from datetime import datetime, timedelta


# ---------------------------------------------------------------------------
# Motor catalogue  (rating_kw, rated_current_A, criticality 1-3)
# ---------------------------------------------------------------------------
MOTOR_CATALOGUE = {
    "Induction_Motor_1": {
        "rating_kw": 15.0,
        "rated_current_a": 28.5,    # 415 V, PF 0.88, η ~94 %
        "criticality": 3,           # highest — drives main production line
        "label": "15 kW Drive Motor",
    },
    "Compressor_Line_2": {
        "rating_kw": 30.0,
        "rated_current_a": 56.0,
        "criticality": 2,
        "label": "30 kW Compressor",
    },
    "HVAC_Pump_3": {
        "rating_kw": 7.5,
        "rated_current_a": 14.8,
        "criticality": 1,
        "label": "7.5 kW HVAC Pump",
    },
}

# ISO 10816-3 vibration zone limits (mm/s RMS) for machines 15–300 kW
ISO_10816_ZONES = {
    "small":  {"A": 0.71, "B": 1.80, "C": 4.50, "D": float("inf")},  # <15 kW
    "medium": {"A": 1.12, "B": 2.80, "C": 7.10, "D": float("inf")},  # 15–75 kW
    "large":  {"A": 1.80, "B": 4.50, "C": 11.2, "D": float("inf")},  # >75 kW
}

# IE2 / IE3 full-load efficiency thresholds (IS 12615 / IEC 60034-30-1)
# keyed by rated kW: (IE2_min_%, IE3_min_%)
IE_THRESHOLDS = {
    7.5:  (89.8, 91.7),
    15.0: (91.8, 93.6),
    30.0: (93.2, 95.0),
}


_API_CACHE = {"timestamp": 0, "data": None}

def _get_live_api_trades(num_samples: int):
    import time, requests
    now = time.time()
    if _API_CACHE["data"] is not None and (now - _API_CACHE["timestamp"]) < 2.5:
        if len(_API_CACHE["data"]) >= num_samples:
            return _API_CACHE["data"][-num_samples:]
    try:
        url = f"https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=300"
        response = requests.get(url, timeout=1.5)
        if response.status_code == 200:
            data = response.json()
            trades = np.array([float(candle[8]) for candle in data])
            _API_CACHE["timestamp"] = now
            _API_CACHE["data"] = trades
            return trades[-num_samples:]
    except Exception:
        pass
    return None

def _load_profile(num_samples: int, seed: int = 7) -> np.ndarray:
    """
    Fetches live streaming data from API to modulate live load.
    Fallback to synthetic if API is temporarily unavailable.
    """
    trades = _get_live_api_trades(num_samples)
    if trades is not None and len(trades) == num_samples:
        t_min = np.min(trades)
        t_max = np.max(trades)
        if t_max > t_min:
            load = 0.2 + 0.8 * (trades - t_min) / (t_max - t_min)
            window = 3
            smoothed = np.convolve(load, np.ones(window)/window, mode='same')
            return np.clip(smoothed, 0.2, 1.0)

    # Fallback synthetic profile
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 2 * np.pi, num_samples)
    shift_env = 0.55 + 0.35 * np.sin(t - np.pi / 2)
    duty = 0.08 * np.sin(8 * t) + 0.05 * np.sin(13 * t)
    noise = rng.normal(0, 0.02, num_samples)
    load = np.clip(shift_env + duty + noise, 0.2, 1.0)
    return load


def _thermal_lag(current_signal: np.ndarray, tau: float = 18.0,
                 ambient: float = 32.0) -> np.ndarray:
    """
    First-order thermal lag:  T[k] = T[k-1] + (1/tau) * (T_ss - T[k-1])
    T_ss = ambient + gain * I²   (Joule heating proxy)
    """
    gain = 0.055          # °C / A²  (tuned for ~45 °C at rated current)
    temp = np.empty_like(current_signal)
    temp[0] = ambient + gain * current_signal[0] ** 2
    for k in range(1, len(current_signal)):
        t_ss = ambient + gain * current_signal[k] ** 2
        temp[k] = temp[k - 1] + (1.0 / tau) * (t_ss - temp[k - 1])
    return temp


def get_iso_machine_class(rating_kw: float) -> str:
    if rating_kw < 15:
        return "small"
    elif rating_kw <= 75:
        return "medium"
    else:
        return "large"


def get_iso_zone(vibration_mm_s: float, rating_kw: float) -> str:
    """Return ISO 10816 zone label A/B/C/D for a given vibration value."""
    cls = get_iso_machine_class(rating_kw)
    limits = ISO_10816_ZONES[cls]
    if vibration_mm_s <= limits["A"]:
        return "A"
    elif vibration_mm_s <= limits["B"]:
        return "B"
    elif vibration_mm_s <= limits["C"]:
        return "C"
    else:
        return "D"


def generate_machine_telemetry(
    machine_name: str = "Induction_Motor_1",
    num_samples: int = 120,
    inject_fault: bool = False,
    fault_progress: float = 0.0,   # 0.0 = healthy … 1.0 = critical
    seed_offset: int = 0,
) -> pd.DataFrame:
    """
    Generate a physics-coupled telemetry DataFrame.

    fault_progress:  passed in by the UI when a bearing fault is being
                     scripted over ~40 s. 0 = no fault; 1 = full fault.
    """
    spec = MOTOR_CATALOGUE.get(machine_name, MOTOR_CATALOGUE["Induction_Motor_1"])
    rating_kw   = spec["rating_kw"]
    rated_i     = spec["rated_current_a"]
    criticality = spec["criticality"]

    rng = np.random.default_rng(42 + seed_offset)
    iso_cls = get_iso_machine_class(rating_kw)

    # ---- load profile -------------------------------------------------------
    load = _load_profile(num_samples, seed=42 + seed_offset)

    # ---- current (A) --------------------------------------------------------
    i_base = rated_i * 0.75         # typical 75 % loading at mid-shift
    current = i_base * load + rng.normal(0, rated_i * 0.012, num_samples)

    # ---- voltage (V) --------------------------------------------------------
    voltage = rng.normal(415.0, 3.5, num_samples)

    # ---- power factor -------------------------------------------------------
    pf = np.clip(0.88 - (load - 0.75) * 0.06 + rng.normal(0, 0.008, num_samples),
                 0.65, 0.95)

    # ---- temperature (°C) — thermal lag on current --------------------------
    temperature = _thermal_lag(current, tau=18.0, ambient=32.0)
    temperature += rng.normal(0, 0.4, num_samples)

    # ---- vibration (mm/s RMS) — load-dependent baseline --------------------
    # ISO 10816 "good" band upper limit for machine class
    vib_baseline = ISO_10816_ZONES[iso_cls]["A"] * 0.55
    vibration = (
        vib_baseline * (0.7 + 0.5 * load)
        + rng.normal(0, vib_baseline * 0.08, num_samples)
    )

    # ---- fault injection ----------------------------------------------------
    # fault_progress ramps 0 → 1 over the scripted 40-second window
    if inject_fault or fault_progress > 0:
        fp = max(fault_progress, 0.0)
        # Bearing fault: vibration grows super-linearly, temperature rises,
        # current rises slightly from mechanical friction
        vib_fault = ISO_10816_ZONES[iso_cls]["D"] * 1.05 * fp ** 1.8
        vibration += vib_fault * np.ones(num_samples)

        temp_fault = 28.0 * fp          # up to +28 °C at full fault
        temperature += temp_fault * np.ones(num_samples)

        current_fault = rated_i * 0.18 * fp
        current += current_fault * np.ones(num_samples)

    # ---- derived quantities -------------------------------------------------
    active_power_kw = (np.sqrt(3) * voltage * current * pf) / 1000.0

    # Mechanical output estimate:  η ≈ 1 − (wasted friction + core losses)
    # η = 0.94 baseline, degrades with fault_progress
    eta = np.clip(0.94 - 0.22 * max(fault_progress, 0.0), 0.45, 0.94)
    mechanical_power_kw = active_power_kw * eta

    # Efficiency % for IE classification
    efficiency_pct = eta * 100.0

    # Wasted power
    wasted_power_kw = np.maximum(active_power_kw - rating_kw * 0.75, 0.0)

    # Timestamps
    end_time = datetime.now()
    start_time = end_time - timedelta(seconds=num_samples)
    timestamps = [start_time + timedelta(seconds=i) for i in range(num_samples)]

    df = pd.DataFrame({
        "timestamp":          timestamps,
        "machine_name":       machine_name,
        "rating_kw":          np.round(rating_kw, 1),
        "criticality":        criticality,
        "current_a":          np.round(current, 2),
        "voltage_v":          np.round(voltage, 2),
        "power_factor":       np.round(pf, 3),
        "active_power_kw":    np.round(active_power_kw, 2),
        "mechanical_power_kw":np.round(mechanical_power_kw, 2),
        "efficiency_pct":     np.round(efficiency_pct, 1),
        "temperature_c":      np.round(temperature, 2),
        "vibration_mm_s":     np.round(np.clip(vibration, 0, None), 4),
        "load_factor":        np.round(load, 3),
        "wasted_power_kw":    np.round(wasted_power_kw, 2),
        "fault_progress":     round(max(fault_progress, 0.0), 3),
    })

    return df
