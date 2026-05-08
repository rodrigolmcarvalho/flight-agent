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
    """Return HH:MM string from a datetime object."""
    if dt is None:
        return ""
    if hasattr(dt, "strftime"):
        return dt.strftime("%H:%M")
    return str(dt)[:5]


def _patched_parse_flights_data(data: list):
    """fli's _parse_flights_data with BRL-price fallback for non-USD responses.

    Google Flights returns an empty price block (data[1][0]=[]) from Brazilian
    IPs. In that case fli ends up with price=0.0. We fall back to data[0][22][7]
    which stores the price in centavos (divide by 100 → BRL).
    """
    from fli.search.flights import SearchFlights as _SF
    result = _SF._orig_parse_flights_data(data)

    if result.price == 0.0:
        try:
            # data[0][22][7] is price in centavos for BRL responses
            centavos = data[0][22][7]
            if centavos and centavos > 0:
                result = result.model_copy(update={"price": centavos / 100.0})
                sys.stderr.write(f"[search] price fallback: {centavos} centavos = R${centavos/100:.2f}\n")
        except (IndexError, TypeError, KeyError):
            pass

    return result


def _install_price_patch():
    """Monkey-patch SearchFlights to use the BRL-aware price parser."""
    from fli.search.flights import SearchFlights
    if not hasattr(SearchFlights, "_orig_parse_flights_data"):
        SearchFlights._orig_parse_flights_data = staticmethod(SearchFlights._parse_flights_data)
        SearchFlights._parse_flights_data = staticmethod(_patched_parse_flights_data)


def search_route(origin: str, destination: str, date_str: str) -> list:
    _install_price_patch()

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

    dep_airport = getattr(Airport, origin)
    arr_airport = getattr(Airport, destination)

    sys.stderr.write(f"[search] {origin}({dep_airport}) -> {destination}({arr_airport}) on {date_str}\n")

    # Each inner list is [Airport, 0] — matches fli's build_flight_segments format
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

    results = SearchFlights().search(filters, top_n=30) or []
    sys.stderr.write(f"[search] raw results count: {len(results)}\n")

    flights = []
    for i, result in enumerate(results):
        try:
            legs = result.legs or []
            if not legs:
                sys.stderr.write(f"[search] result[{i}]: no legs, skipping\n")
                continue
            leg = legs[0]

            price = float(result.price) if result.price else 0.0
            if price <= 0:
                sys.stderr.write(f"[search] result[{i}]: price still 0 after fallback, skipping\n")
                continue

            airline_name = normalize_airline(
                leg.airline.value if hasattr(leg.airline, "value") else str(leg.airline)
            )

            flights.append({
                "airline":        airline_name,
                "flight_number":  str(leg.flight_number or ""),
                "departure_time": fmt_time(leg.departure_datetime),
                "arrival_time":   fmt_time(leg.arrival_datetime),
                "price":          round(price, 2),
                "airport":        destination,
            })
        except Exception as e:
            sys.stderr.write(f"[search] result[{i}] parse error: {e}\n")
            continue

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
