from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib import resources
from socketserver import ThreadingMixIn
from typing import Dict, Optional, Tuple, TYPE_CHECKING
from urllib.parse import parse_qs

if TYPE_CHECKING:  # pragma: no cover
    from ..ros2_graph_node import GraphSnapshot


class _ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class GraphWebServer:
    """Lightweight HTTP server that serves graph data and a simple UI."""

    def __init__(self, host: str, port: int, logger, topic_tool_handler=None, node_tool_handler=None) -> None:
        self._host = host
        self._port = port
        self._logger = logger
        self._lock = threading.Lock()
        self._latest_payload: Optional[str] = None
        self._server = _ThreadingHTTPServer((host, port), self._create_handler())
        self._dot_path = shutil.which('dot')
        self._graphviz_warning_logged = False
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._running = False
        self._topic_tool_handler = topic_tool_handler
        self._node_tool_handler = node_tool_handler

    def _create_handler(self):
        parent = self

        class GraphRequestHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                raw_path = self.path
                if '?' in raw_path:
                    path, query = raw_path.split('?', 1)
                    params = parse_qs(query, keep_blank_values=True)
                else:
                    path = raw_path
                    params = {}
                if path in ('/', '/index.html', '/styles.css', '/app.js'):
                    parent._serve_static(self, path)
                elif path == '/graph':
                    parent._serve_graph(self)
                elif path == '/topic_tool':
                    parent._serve_topic_tool(self, params)
                elif path == '/node_tool':
                    parent._serve_node_tool(self, params)
                elif path == '/healthz':
                    parent._serve_health(self)
                else:
                    self.send_error(404, 'Not Found')

            def do_POST(self) -> None:
                raw_path = self.path
                if '?' in raw_path:
                    path, query = raw_path.split('?', 1)
                    params = parse_qs(query, keep_blank_values=True)
                else:
                    path = raw_path
                    params = {}
                length_header = self.headers.get('Content-Length', '0')
                try:
                    length = int(length_header)
                except (TypeError, ValueError):
                    length = 0
                body = b''
                if length > 0:
                    body = self.rfile.read(length)
                try:
                    payload = json.loads(body.decode('utf-8')) if body else {}
                    if payload is None:
                        payload = {}
                except json.JSONDecodeError:
                    parent._send_json(self, 400, {'error': 'invalid JSON body'})
                    return
                if path == '/node_tool':
                    parent._serve_node_tool(self, params, payload)
                else:
                    self.send_error(404, 'Not Found')

            def log_message(self, format: str, *args) -> None:  # noqa: A003
                parent._logger.debug(f'web: {format % args}')

        return GraphRequestHandler

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread.start()
        self._logger.info(
            f'web UI available at http://{self._host}:{self._port} '
            '(open in a browser for live updates)'
        )

    def stop(self) -> None:
        if not self._running:
            return
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2.0)
        self._running = False

    def publish(self, snapshot: 'GraphSnapshot', fingerprint: str) -> None:
        graph_dict = snapshot.to_dict()
        graphviz_ids = snapshot.graphviz_id_map()
        plain_layout = self._compute_graphviz_plain(snapshot)
        graphviz_info = {}
        if plain_layout is not None:
            graphviz_info['engine'] = 'dot'
            graphviz_info['plain'] = plain_layout
        if graphviz_ids:
            graphviz_info['ids'] = graphviz_ids
        if graphviz_info:
            graph_dict['graphviz'] = graphviz_info
        payload = {
            'fingerprint': fingerprint,
            'generated_at': time.time(),
            'graph': graph_dict,
        }
        payload_json = json.dumps(payload, separators=(',', ':'))
        with self._lock:
            self._latest_payload = payload_json

    def _latest(self) -> Optional[str]:
        with self._lock:
            return self._latest_payload

    def _serve_static(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        rel_path, content_type = STATIC_FILES[path]
        try:
            data = resources.files(__package__).joinpath('static', rel_path).read_bytes()
        except FileNotFoundError:
            handler.send_error(404, 'Asset not found')
            return

        handler.send_response(200)
        handler.send_header('Content-Type', content_type)
        handler.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _serve_graph(self, handler: BaseHTTPRequestHandler) -> None:
        payload = self._latest()
        if payload is None:
            message = b'{"error":"graph not ready yet"}'
            handler.send_response(503)
            handler.send_header('Content-Type', 'application/json')
            handler.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            handler.send_header('Content-Length', str(len(message)))
            handler.end_headers()
            handler.wfile.write(message)
            return

        data = payload.encode('utf-8')
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _serve_health(self, handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header('Content-Type', 'text/plain')
        handler.send_header('Cache-Control', 'no-cache')
        handler.end_headers()
        handler.wfile.write(b'ok')

    def _send_json(self, handler: BaseHTTPRequestHandler, status: int, payload: Dict[str, object]) -> None:
        data = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        handler.send_response(status)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _serve_topic_tool(self, handler: BaseHTTPRequestHandler, params: Dict[str, list]) -> None:
        if self._topic_tool_handler is None:
            self._send_json(handler, 503, {'error': 'topic tools unavailable'})
            return
        topic = params.get('topic', [''])[0].strip()
        action = params.get('action', [''])[0].strip().lower()
        peer = params.get('peer', [''])[0].strip()
        if not topic or not action:
            self._send_json(handler, 400, {'error': 'missing topic or action'})
            return
        try:
            status, payload = self._topic_tool_handler(action, topic, peer or None, params)
        except Exception as exc:  # pragma: no cover - defensive
            self._logger.exception('topic_tool handler raised an exception')
            self._send_json(handler, 500, {'error': f'failed to process request: {exc}'})
            return
        if not isinstance(status, int):
            status = 500
        if not isinstance(payload, dict):
            payload = {'error': 'invalid response from handler'}
            status = 500
        self._send_json(handler, status, payload)

    def _serve_node_tool(
        self,
        handler: BaseHTTPRequestHandler,
        params: Dict[str, list],
        body: Optional[Dict[str, object]] = None,
    ) -> None:
        if self._node_tool_handler is None:
            self._send_json(handler, 503, {'error': 'node tools unavailable'})
            return
        extras: Optional[Dict[str, object]] = None
        if isinstance(body, dict):
            extras = dict(body)
        node = ''
        action = ''
        if extras:
            node = str(extras.get('node', '') or '').strip()
            action = str(extras.get('action', '') or '').strip().lower()
        if not node:
            node = params.get('node', [''])[0].strip()
        if not action:
            action = params.get('action', [''])[0].strip().lower()
        if not node or not action:
            self._send_json(handler, 400, {'error': 'missing node or action'})
            return
        try:
            status, payload = self._node_tool_handler(action, node, extras)
        except Exception as exc:  # pragma: no cover - defensive
            tb = traceback.format_exc()
            self._logger.error(f'node_tool handler raised an exception: {exc}\n{tb}')
            self._send_json(handler, 500, {'error': f'failed to process request: {exc}'})
            return
        if not isinstance(status, int):
            status = 500
        if not isinstance(payload, dict):
            payload = {'error': 'invalid response from handler'}
            status = 500
        self._send_json(handler, status, payload)

    def _compute_graphviz_plain(self, snapshot: 'GraphSnapshot') -> Optional[str]:
        if not self._dot_path:
            if not self._graphviz_warning_logged:
                self._logger.warning(
                    'Graphviz "dot" executable not found; web UI layout will be unavailable'
                )
                self._graphviz_warning_logged = True
            return None

        try:
            completed = subprocess.run(
                [self._dot_path, '-Tplain'],
                input=snapshot.to_dot(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                text=True,
                encoding='utf-8',
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            if not self._graphviz_warning_logged:
                details = ''
                if isinstance(exc, subprocess.CalledProcessError):
                    stderr_output = exc.stderr.strip()
                    if stderr_output:
                        details = f' ({stderr_output})'
                self._logger.warning(
                    'Graphviz layout failed; web UI layout will be unavailable%s', details
                )
                self._graphviz_warning_logged = True
            return None

        return completed.stdout


STATIC_FILES: Dict[str, Tuple[str, str]] = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
    '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
}
