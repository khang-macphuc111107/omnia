"""Business-day holiday calendar utilities for US fixed-income markets."""

from datetime import date, timedelta

US_HOLIDAYS: frozenset[date] = frozenset(
    {
        # 2024
        date(2024, 1, 1),
        date(2024, 7, 4),
        date(2024, 9, 2),
        date(2024, 12, 25),
        # 2025
        date(2025, 1, 1),
        date(2025, 7, 4),
        date(2025, 9, 1),
        date(2025, 12, 25),
        # 2026
        date(2026, 1, 1),
        date(2026, 7, 3),
        date(2026, 9, 7),
        date(2026, 12, 25),
        # 2027
        date(2027, 1, 1),
        date(2027, 7, 5),
        date(2027, 9, 6),
        date(2027, 12, 24),
    }
)


def is_business_day(d: date) -> bool:
    """Return True if d is a weekday (Mon-Fri) and not a US market holiday."""
    return d.weekday() < 5 and d not in US_HOLIDAYS


def adjust_following(d: date) -> date:
    """Roll d forward day-by-day until it lands on a US business day."""
    current = d
    while not is_business_day(current):
        current += timedelta(days=1)
    return current
