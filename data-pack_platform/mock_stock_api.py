"""Mock Ridgeline stock API (read-only). Python 3.9+, standard library only.

Run:   python mock_stock_api.py            (serves on http://localhost:8080)
Env:   PORT=8080
       MOCK_FAILURE_RATE=0.1   share of requests that return 503 (simulates an unreliable upstream)
       MOCK_LATENCY_MS=150     added delay per request
"""
import json, os, random, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

STOCK = json.loads((Path(__file__).parent / "stock_fixture.json").read_text())
FAIL = float(os.environ.get("MOCK_FAILURE_RATE", "0.1"))
LAT = int(os.environ.get("MOCK_LATENCY_MS", "150"))

class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        time.sleep(LAT / 1000)
        if random.random() < FAIL:
            return self._send(503, {"error": "service_unavailable", "retry_after_seconds": 2})
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["v1", "health"]:
            return self._send(200, {"status": "ok"})
        if len(parts) == 3 and parts[:2] == ["v1", "stock"]:
            item = STOCK.get(parts[2])
            return self._send(200, item) if item else self._send(404, {"error": "not_found", "part_number": parts[2]})
        if parts == ["v1", "stock"]:
            pns = [p for p in parse_qs(u.query).get("part_numbers", [""])[0].split(",") if p][:50]
            if not pns:
                return self._send(400, {"error": "part_numbers query parameter required (max 50)"})
            return self._send(200, {"items": [STOCK[p] for p in pns if p in STOCK], "not_found": [p for p in pns if p not in STOCK]})
        self._send(404, {"error": "unknown_route"})

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"Mock stock API on http://localhost:{port}  (failure rate {FAIL}, latency {LAT} ms)")
    HTTPServer(("", port), H).serve_forever()
