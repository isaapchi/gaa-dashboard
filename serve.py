"""Dev server with aggressive no-cache headers, on top of stdlib http.server.

Plain `python -m http.server` lets browsers cache JS modules and parquet files,
which is the wrong default for development — after editing dashboard JS you'd
otherwise see stale module imports until the cache happens to expire (or an
import fails on a deleted file). Run this instead while iterating:

    cd site
    python serve.py            # default port 8765
    python serve.py 8000       # custom port
"""

from __future__ import annotations

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    addr = ("", port)
    print(f"Serving HTTP with no-cache headers on http://localhost:{port}/  (Ctrl+C to stop)")
    with ThreadingHTTPServer(addr, NoCacheHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")


if __name__ == "__main__":
    main()
