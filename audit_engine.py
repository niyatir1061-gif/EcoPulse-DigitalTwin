"""
audit_engine.py
Energy audit calculations for EcoPulse.
BEE star logic replaced with IS 12615 / IEC 60034-30-1 efficiency class.
No official BEE star claims are made.
"""

import numpy as np
import pandas as pd


# kWh/year savings assumptions (per asset, per action tier)
ANNUAL_KWH_SAVINGS = {
    "Fix Now":   18_000,
    "Monitor":    6_000,
    "Can Wait":   1_200,
}

# Cost of carbon  (India CEF avg 2024)
CARBON_COST_INR_PER_KG = 2.20


class EnergyAuditEngine:
    def __init__(
        self,
        baseline_sec: float = 0.125,   # kWh / unit
        grid_co2_factor: float = 0.82, # kg CO2 / kWh  (India grid avg)
        grid_tariff_inr: float = 8.50, # ₹ / kWh
    ):
        self.baseline_sec    = baseline_sec
        self.grid_co2_factor = grid_co2_factor
        self.grid_tariff_inr = grid_tariff_inr

    # ------------------------------------------------------------------
    # Per-asset compliance snapshot
    # ------------------------------------------------------------------
    def evaluate_compliance(
        self,
        active_power_kw: float,
        production_rate_uph: float,
        solar_kw: float = 0.0,
        efficiency_pct: float = 94.0,
        rating_kw: float = 15.0,
    ) -> dict:

        current_sec = (
            active_power_kw / production_rate_uph
            if production_rate_uph > 0
            else 0.0
        )

        enpi_variance_pct = (
            (current_sec - self.baseline_sec) / self.baseline_sec * 100.0
            if self.baseline_sec > 0
            else 0.0
        )

        # Scope 2 emissions
        net_grid_kw         = max(0.0, active_power_kw - solar_kw)
        gross_co2_hr        = active_power_kw   * self.grid_co2_factor
        net_co2_hr          = net_grid_kw       * self.grid_co2_factor
        avoided_solar_co2hr = min(solar_kw, active_power_kw) * self.grid_co2_factor

        # Annual savings proxy (wasted power → ₹)
        wasted_kw       = max(active_power_kw - rating_kw * 0.75, 0.0)
        kwh_saved_yr    = wasted_kw * 16 * 300          # 16 h/day, 300 days
        inr_saved_yr    = kwh_saved_yr * self.grid_tariff_inr

        return {
            "current_sec":              round(current_sec, 4),
            "baseline_sec":             self.baseline_sec,
            "enpi_variance_pct":        round(enpi_variance_pct, 1),
            "gross_scope2_kg_co2_hr":   round(gross_co2_hr, 2),
            "net_scope2_kg_co2_hr":     round(net_co2_hr, 2),
            "avoided_solar_kg_co2_hr":  round(avoided_solar_co2hr, 2),
            "kwh_saved_yr":             round(kwh_saved_yr, 0),
            "inr_saved_yr":             round(inr_saved_yr, 0),
            "efficiency_pct":           round(efficiency_pct, 1),
        }

    # ------------------------------------------------------------------
    # Fleet-level financial summary
    # ------------------------------------------------------------------
    def fleet_financial_summary(
        self,
        fleet_df: pd.DataFrame,
        hardware_cost_inr: float = 25_000,
    ) -> dict:
        """
        fleet_df must have columns: active_power_kw, rating_kw, action_tier
        """
        total_wasted_kw = (
            (fleet_df["active_power_kw"] - fleet_df["rating_kw"] * 0.75)
            .clip(lower=0)
            .sum()
        )
        kwh_wasted_yr   = total_wasted_kw * 16 * 300
        inr_wasted_yr   = kwh_wasted_yr   * self.grid_tariff_inr
        daily_loss      = inr_wasted_yr   / 300
        payback_months  = hardware_cost_inr / (daily_loss * 25) if daily_loss > 0 else 0.0

        return {
            "total_wasted_kw":  round(total_wasted_kw, 1),
            "kwh_wasted_yr":    round(kwh_wasted_yr, 0),
            "inr_wasted_yr":    round(inr_wasted_yr, 0),
            "daily_loss_inr":   round(daily_loss, 0),
            "payback_months":   round(payback_months, 1),
        }
