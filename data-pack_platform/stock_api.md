# Ridgeline Stock API (read-only)

Hourly stock snapshot by warehouse. The real API is owned by Ridgeline IT; use `mock_stock_api.py` locally.

Run the mock: `python mock_stock_api.py` (Python 3.9+, no dependencies). Defaults: port 8080, 10% of requests fail with 503, 150 ms latency. Set `MOCK_FAILURE_RATE=0` to turn failures off while developing.

## Endpoints
`GET /v1/health` returns `{"status": "ok"}`

`GET /v1/stock/{part_number}`
- 200: `{"part_number": "RL171482", "warehouses": {"DAL": 101, "PHX": 91, "ATL": 66}, "as_of": "2026-10-12T08:00:00-05:00"}`
- 404: `{"error": "not_found", "part_number": "..."}`

`GET /v1/stock?part_numbers=RL171482,RL120374` (max 50)
- 200: `{"items": [ ... ], "not_found": ["RL120374"]}`

Any endpoint may return 503 `{"error": "service_unavailable", "retry_after_seconds": 2}`.

`as_of` is when the stock reading was taken. Readings can be stale.
