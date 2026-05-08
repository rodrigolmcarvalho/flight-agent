#!/usr/bin/env python3
"""Search non-stop economy flights via Google Flights (fli library).

Usage: python search.py <ORIGIN> <DESTINATION> <YYYY-MM-DD>
Prints a JSON array of flights sorted by price ascending.
"""

import sys
import json
import re
from datetime import datetime


AIRLINE_NORMALIZE = {
    "azul":  "Azul",
    "gol":   "Gol",
    "latam": "LATAM",
    "tam":   "LATAM",
}


def normalize_airline(name: str) -> str:
    if not name:
        return ""
    lower = name.lower()
    for key, val in AIRLINE_NORMALIZE.items():
        if key in lower:
            return val
    return name.strip()


def parse_price(val) -> float:
    """Extract a positive float from whatever fli returns for price."""
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    # Strip currency symbols and thousand separators, keep decimal point
    s = re.sub(r"[R$\s]", "", str(val)).replace(",", "")
    nums = re.findall(r"\d+(?:\.\d+)?", s)
    return float(nums[0]) if nums else 0.0


def fmt_time(dt) -> str:
    """Return HH:MM string from a datetime or ISO string."""
    if dt is None:
        return ""
    if hasattr(dt, "strftime"):
        return dt.strftime("%H:%M")
    s = str(dt)
    m = re.search(r"(\d{2}:\d{2})", s)
    return m.group(1) if m else s[:5]


def search_route(origin: str, destination: str, date_str: str) -> list:
    from fli.models import (
        Airport,
        FlightSearchFilters,
        FlightSegment,
        MaxStops,
        PassengerInfo,
        SeatType,
        SortBy,
        TripType,
    )
    from fli.search import SearchFlights

    travel_date = datetime.strptime(date_str, "%Y-%m-%d").date()

    filters = FlightSearchFilters(
        trip_type=TripType.ONE_WAY,
        passenger_info=PassengerInfo(adults=1),
        flight_segments=[
            FlightSegment(
                departure_airport=Airport(code=origin),
                arrival_airport=Airport(code=destination),
                travel_date=travel_date,
            )
        ],
        seat_type=SeatType.ECONOMY,
        stops=MaxStops.NON_STOP,
        sort_by=SortBy.CHEAPEST,
    )

    results = SearchFlights().search(filters, top_n=30) or []
    flights = []

    for result in results:
        legs = getattr(result, "legs", None) or []
        if not legs:
            continue
        leg = legs[0]

        price = parse_price(getattr(result, "price", None))
        if price <= 0:
            continue

        flights.append({
            "airline":        normalize_airline(str(getattr(leg, "airline", "") or "")),
            "flight_number":  str(getattr(leg, "flight_number", "") or ""),
            "departure_time": fmt_time(getattr(leg, "departure_datetime", None)),
            "arrival_time":   fmt_time(getattr(leg, "arrival_datetime", None)),
            "price":          round(price, 2),
            "airport":        destination,
        })

    flights.sort(key=lambda x: x["price"])
    return flights


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.stderr.write("Usage: search.py <ORIGIN> <DESTINATION> <YYYY-MM-DD>\n")
        print(json.dumps([]))
        sys.exit(1)

    origin      = sys.argv[1].upper()
    destination = sys.argv[2].upper()
    date_str    = sys.argv[3]

    try:
        result = search_route(origin, destination, date_str)
        print(json.dumps(result))
    except Exception as exc:
        sys.stderr.write(f"search.py error: {exc}\n")
        print(json.dumps([]))
        sys.exit(1)
