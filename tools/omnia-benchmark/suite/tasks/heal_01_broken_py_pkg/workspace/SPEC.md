# `quantlib_mini` Financial & Technical Specification

`quantlib_mini` is a pure Python 3.13 (stdlib-only) fixed-income bond pricing package.

## 1. Configuration (`pyproject.toml`)
- `quantlib_mini.config.load_project_config()` parses `pyproject.toml` using `tomllib` and reads `[tool.quantlib_mini]`.
- `pyproject.toml` must be valid TOML.

## 2. Business-Day Calendar
- Weekends (Saturday = 5, Sunday = 6) and fixed/observed US market holidays defined in the business-day calendar module are non-business days.
- Holidays include:
  - 2024: `2024-01-01`, `2024-07-04`, `2024-09-02`, `2024-12-25`
  - 2025: `2025-01-01`, `2025-07-04`, `2025-09-01`, `2025-12-25`
  - 2026: `2026-01-01`, `2026-07-03`, `2026-09-07`, `2026-12-25`
  - 2027: `2027-01-01`, `2027-07-05`, `2027-09-06`, `2027-12-24`
- `is_business_day(d: date) -> bool`: `True` iff `d.weekday() < 5` and `d not in US_HOLIDAYS`.
- `adjust_following(d: date) -> date`: returns `d` if it is a business day; otherwise advances by 1 calendar day repeatedly until a business day is reached.
- Must NOT shadow Python's standard library `calendar` module from the workspace root.

## 3. Zero Yield Curve (`quantlib_mini.curves`)
- Loaded from a CSV file with headers `tenor_years,zero_rate` (decimal continuously compounded zero rates, e.g. `0.045` = 4.5%).
- The CSV loader (`load_yield_curve(path)`) MUST handle UTF-8 files with or without UTF-8 BOM (`\ufeff`), both LF (`\n`) and CRLF (`\r\n`) line endings, and optional surrounding whitespace in headers/values.
- Knot points `(tenor_years, zero_rate)` are sorted ascending by `tenor_years`. Empty curves or duplicate tenors raise `PricingError`.
- **Interpolation (`YieldCurve.zero_rate(t)`)**:
  - Flat extrapolation: if `t <= t_min`, return `r_min`; if `t >= t_max`, return `r_max`.
  - Piecewise linear interpolation for `t_i <= t <= t_{i+1}`:
    `r(t) = r_i + (r_{i+1} - r_i) * (t - t_i) / (t_{i+1} - t_i)`
- **Discount Factor (`YieldCurve.discount_factor(t)`)**:
  - Continuous compounding: `DF(t) = math.exp(-zero_rate(t) * t)` for `t >= 0` (`1.0` when `t == 0`).

## 4. Day-Count Conventions (`quantlib_mini.daycount.day_count_fraction`)
Signature: `day_count_fraction(start_date: date, end_date: date, convention: str) -> float`
- If `end_date < start_date`, raise `ValueError` (or `PricingError`).
- If `end_date == start_date`, return `0.0`.
- Supported conventions (case-insensitive, stripped):
  1. **`ACT/365F`** (Actual/365 Fixed):
     - Exact calendar days divided by `365.0` ALWAYS (including leap years):
       `(end_date - start_date).days / 365.0`
  2. **`ACT/ACT`** (ISDA Actual/Actual):
     - Partition `[start_date, end_date)` by calendar year using stdlib `calendar.isleap(y)`:
       - Days falling in a leap year are divided by `366.0`.
       - Days falling in a non-leap year are divided by `365.0`.
       - Specifically:
         - If `start_date.year == end_date.year`:
           `(end_date - start_date).days / (366.0 if isleap(y) else 365.0)`
         - If `start_date.year < end_date.year`:
           `((date(y1 + 1, 1, 1) - start_date).days / denom(y1)) + (y2 - y1 - 1) + ((end_date - date(y2, 1, 1)).days / denom(y2))`
  3. **`30/360`** (US / Bond Basis):
     - Let `d1 = start_date.day`, `d2 = end_date.day`.
     - If `d1 == 31`: set `d1 = 30`.
     - If `d2 == 31` and `d1 == 30` (i.e., original `d1` was 30 or 31): set `d2 = 30`.
     - Formula:
       `((end_date.year - start_date.year) * 360 + (end_date.month - start_date.month) * 30 + (d2 - d1)) / 360.0`

## 5. Bond Pricing (`quantlib_mini.pricing`)
A `BondSpec` has:
- `bond_id: str`
- `face_value: float`
- `coupon_rate: float` (annual decimal rate)
- `day_count: str` (`"ACT/365F"`, `"ACT/ACT"`, or `"30/360"`)
- `valuation_date: date`
- `accrual_start_date: date`
- `payment_dates: list[date]` (ascending unadjusted scheduled coupon/maturity dates; final date repays principal `face_value`)

Valuation rules:
1. For each period `i` from `prev_date` (`accrual_start_date` for `i=0`, else `payment_dates[i-1]`) to `sched_date = payment_dates[i]`:
   - Period accrual fraction: `alpha_i = day_count_fraction(prev_date, sched_date, bond.day_count)`
   - Coupon cashflow: `coupon_i = bond.face_value * bond.coupon_rate * alpha_i`
   - Total cashflow: `cf_i = coupon_i + (bond.face_value if i == len(payment_dates) - 1 else 0.0)`
   - Adjusted payment date: `pay_date_i = adjust_following(sched_date)`
2. Filter to future cashflows where `pay_date_i > bond.valuation_date`. Let `cashflow_count` be the number of such future cashflows.
3. For each future cashflow:
   - Time to payment: `t_i = day_count_fraction(bond.valuation_date, pay_date_i, bond.day_count)`
   - Present value contribution: `pv_i = cf_i * curve.discount_factor(t_i)`
4. Aggregates:
   - `pv = dirty_price = sum(pv_i)`
   - **Accrued Interest**: Find the unique unadjusted coupon period `[period_start, period_end]` such that `period_start <= valuation_date < period_end`. If found:
     `accrued_interest = bond.face_value * bond.coupon_rate * day_count_fraction(period_start, valuation_date, bond.day_count)`
     Otherwise `0.0`.
   - `clean_price = dirty_price - accrued_interest`
   - `macaulay_duration = sum(t_i * pv_i) / dirty_price` (or `0.0` if `dirty_price == 0`)

## 6. CLI Contract
Command:
```
python -m quantlib_mini.cli --curve <path_to_csv> --bond <path_to_json>
```
Prints a single JSON object to stdout with keys:
- `bond_id` (str)
- `day_count_convention` (str)
- `cashflow_count` (int)
- `pv` (float, rounded to 6 decimals)
- `dirty_price` (float, rounded to 6 decimals)
- `accrued_interest` (float, rounded to 6 decimals)
- `clean_price` (float, rounded to 6 decimals)
- `macaulay_duration` (float, rounded to 6 decimals)
