#!/usr/bin/env python3
"""Static dev server with caching disabled (so edited ES modules always reload)."""
import http.server, functools, os, sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8321
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
