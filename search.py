#!/usr/bin/env python3
"""Search non-stop economy flights via Google Flights (fli library).

Usage: python search.py <ORIGIN> <DESTINATION> <YYYY-MM-DD>
Prints a JSON array of flights sorted by price ascending.
"""

import sys
import json


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


def fmt_time(dt) -> str:
    if dt is None:
        return ""
    if hasattr(dt, "strftime"):
        return dt.strftime("%H:%M")
    return str(dt)[:5]


def _get_price_tier(data: list) -> int:
    """Return data[0][22][7] — an internal tier value that tracks price levels."""
    try:
        return data[0][22][7] or 0
    except (IndexError, TypeError):
        return 0


def search_route(origin: str, destination: str, date_str: str) -> list:
    import json as _json
    from fli.models import (
        Airport, FlightSearchFilters, FlightSegment,
        MaxStops, PassengerInfo, SeatType, SortBy, TripType,
    )
    from fli.search.flights import SearchFlights
    from fli.search.client import get_client

    dep_airport = getattr(Airport, origin)
    arr_airport = getattr(Airport, destination)

    sys.stderr.write(f"[search] {origin} -> {destination} on {date_str}\n")

    filters = FlightSearchFilters(
        trip_type=TripType.ONE_WAY,
        passenger_info=PassengerInfo(adults=1),
        flight_segments=[
            FlightSegment(
                departure_airport=[[dep_airport, 0]],
                arrival_airport=[[arr_airport, 0]],
                travel_date=date_str,
            )
        ],
        seat_type=SeatType.ECONOMY,
        stops=MaxStops.NON_STOP,
        sort_by=SortBy.CHEAPEST,
    )

    # Make the raw API call so we can capture both flight data and the price range.
    encoded = filters.encode()
    client = get_client()
    resp = client.post(
        url=SearchFlights.BASE_URL,
        data=f"f.req={encoded}",
        impersonate="chrome",
        allow_redirects=True,
    )
    resp.raise_for_status()

    parsed_outer = _json.loads(resp.text.lstrip(")]}'"))[0][2]
    if not parsed_outer:
        sys.stderr.write("[search] empty API response\n")
        return []

    ef = _json.loads(parsed_outer)
    raw_rows = [
        item
        for i in [2, 3]
        if isinstance(ef[i], list)
        for item in ef[i][0]
    ]
    sys.stderr.write(f"[search] raw rows: {len(raw_rows)}\n")

    # Price range from ef[7][0]: [[None, min_price], [None, max_price]]
    # These are accurate BRL values for Brazilian IPs (or USD for US IPs).
    price_min = price_max = None
    try:
        pr = ef[7][0]
        price_min = pr[0][1]
        price_max = pr[1][1] if len(pr) > 1 else price_min
    except (IndexError, TypeError, KeyError):
        pass
    sys.stderr.write(f"[search] price range from API: min={price_min} max={price_max}\n")

    # Collect tier values and parse flight details.
    sf = SearchFlights()
    raw_flights = []
    for row in raw_rows:
        try:
            result = sf._parse_flights_data(row)
        except Exception as e:
            sys.stderr.write(f"[search] parse error: {e}\n")
            continue

        legs = result.legs or []
        if not legs:
            continue

        # USD price from standard price block (works on US IPs / Render).
        usd_price = float(result.price) if result.price and result.price > 0 else 0.0

        # Internal tier value — use to distinguish price tiers when USD price is absent.
        tier = _get_price_tier(row)

        leg = legs[0]
        airline_name = normalize_airline(
            leg.airline.value if hasattr(leg.airline, "value") else str(leg.airline)
        )
        raw_flights.append({
            "airline":        airline_name,
            "flight_number":  str(leg.flight_number or ""),
            "departure_time": fmt_time(leg.departure_datetime),
            "arrival_time":   fmt_time(leg.arrival_datetime),
            "airport":        destination,
            "_usd_price":     usd_price,
            "_tier":          tier,
        })

    if not raw_flights:
        return []

    # If we have real USD prices, use them directly.
    if all(f["_usd_price"] > 0 for f in raw_flights):
        sys.stderr.write("[search] using USD prices from price block\n")
        flights = [
            {k: v for k, v in f.items() if not k.startswith("_")} | {"price": round(f["_usd_price"], 2)}
            for f in raw_flights
        ]
    elif price_min is not None:
        # BRL IP: map tier values linearly onto the price range.
        tiers = sorted(set(f["_tier"] for f in raw_flights if f["_tier"] > 0))
        tier_min = tiers[0] if tiers else 1
        tier_max = tiers[-1] if tiers else 1
        sys.stderr.write(f"[search] BRL price mapping: tiers={tiers} -> {price_min}..{price_max}\n")

        def map_price(tier_val: int) -> float:
            if tier_min == tier_max:
                return float(price_min)
            frac = (tier_val - tier_min) / (tier_max - tier_min)
            return price_min + frac * (price_max - price_min)

        flights = []
        for f in raw_flights:
            price = map_price(f["_tier"]) if f["_tier"] > 0 else float(price_min)
            row = {k: v for k, v in f.items() if not k.startswith("_")}
            row["price"] = round(price, 2)
            flights.append(row)
    else:
        sys.stderr.write("[search] no price data available, skipping all results\n")
        return []

    flights.sort(key=lambda x: x["price"])
    sys.stderr.write(f"[search] returning {len(flights)} flights\n")
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
