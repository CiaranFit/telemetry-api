import http.client
import json
import logging
import os
import socket
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from app.hue_client import HueHTTPSConnection, get_resource


class HueAPITests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        import app.storage
        self.old_db = app.storage.DB_PATH
        app.storage.DB_PATH = str(Path(self.temp_dir.name) / "test.db")
        from app import create_app
        self.client = create_app().test_client()
        self.env = patch.dict(os.environ, {
            "HUE_BRIDGE_IP": "192.0.2.1", "HUE_BRIDGE_ID": "0123456789abcdef",
            "HUE_BRIDGE_CA_FILE": "test-ca.pem", "HUE_APPLICATION_KEY": "test-secret-placeholder"
        }, clear=True)
        self.env.start()
        self.context_patch = patch("app.hue_client.ssl.create_default_context")
        self.context = self.context_patch.start().return_value
        self.https = patch("app.hue_client.HueHTTPSConnection")
        self.connection = self.https.start().return_value
        self.addCleanup(self.env.stop)
        self.addCleanup(self.https.stop)
        self.addCleanup(self.context_patch.stop)
        self.addCleanup(self.temp_dir.cleanup)
        self.addCleanup(setattr, app.storage, "DB_PATH", self.old_db)

    def response(self, payload, status=200):
        response = Mock(status=status)
        response.read.return_value = json.dumps(payload).encode()
        self.connection.getresponse.return_value = response
        return response

    def test_resources_and_health(self):
        data = [{"id": "resource-id", "metadata": {"name": "Example"}, "type": "light"}]
        for endpoint, resource in (("lights", "light"), ("rooms", "room"),
                                   ("scenes", "scene"), ("health", "bridge")):
            with self.subTest(endpoint=endpoint):
                self.response({"data": data, "errors": []})
                result = self.client.get("/api/hue/" + endpoint)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json, {"data": data, "error": None})
                self.assertEqual(self.connection.request.call_args.args[:2],
                                 ("GET", "/clip/v2/resource/" + resource))

    def test_missing_config(self):
        with patch.dict(os.environ, {}, clear=True):
            result = self.client.get("/api/hue/lights")
        self.assertEqual(result.status_code, 503)
        self.connection.request.assert_not_called()

    def test_timeout_and_bridge_errors(self):
        self.connection.request.side_effect = socket.timeout("test-secret-placeholder")
        self.assertEqual(self.client.get("/api/hue/lights").status_code, 504)
        self.connection.request.side_effect = OSError("test-secret-placeholder")
        self.assertEqual(self.client.get("/api/hue/lights").status_code, 502)
        self.connection.request.side_effect = None
        for payload, status in (({"data": [], "errors": []}, 403),
                                ({"data": [], "errors": [{"description": "bad"}]}, 200)):
            self.response(payload, status)
            self.assertEqual(self.client.get("/api/hue/lights").status_code, 502)
        self.connection.getresponse.return_value.read.return_value = b"not json"
        self.assertEqual(self.client.get("/api/hue/lights").status_code, 502)
        self.connection.request.side_effect = http.client.RemoteDisconnected()
        self.assertEqual(self.client.get("/api/hue/lights").status_code, 502)

    def test_no_credentials_in_response_or_logs(self):
        secret = os.environ["HUE_APPLICATION_KEY"]
        self.response({"data": [{"id": secret}], "errors": []})
        with self.assertLogs(level=logging.INFO) as logs:
            logging.info("testing Hue response")
            result = self.client.get("/api/hue/lights")
            self.connection.request.side_effect = OSError(secret)
            failure = self.client.get("/api/hue/lights")
        self.assertNotIn(secret, result.get_data(as_text=True))
        self.assertNotIn(secret, failure.get_data(as_text=True))
        self.assertNotIn(secret, " ".join(logs.output))

    def test_cors_excludes_hue(self):
        self.response({"data": [], "errors": []})
        headers = {"Origin": "https://untrusted.example"}
        for method in ("get", "options"):
            result = getattr(self.client, method)("/api/hue/lights", headers=headers)
            self.assertNotIn("Access-Control-Allow-Origin", result.headers)
        self.assertEqual(self.client.get("/api/history", headers=headers).headers.get(
            "Access-Control-Allow-Origin"), headers["Origin"])

    def test_resource_allowlist(self):
        with self.assertRaises(ValueError):
            get_resource("../../other")
        self.connection.request.assert_not_called()

    def test_bridge_id_and_ca_required_and_validated(self):
        for name, value in (("HUE_BRIDGE_ID", ""), ("HUE_BRIDGE_ID", "../bad"),
                            ("HUE_BRIDGE_ID", "0123456789abcdeg"),
                            ("HUE_BRIDGE_CA_FILE", "")):
            with self.subTest(name=name, value=value), patch.dict(os.environ, {name: value}):
                self.assertEqual(self.client.get("/api/hue/lights").status_code, 503)
        self.connection.request.assert_not_called()

    def test_ca_configuration_and_verification_failure(self):
        self.context_patch.stop()
        with patch("app.hue_client.ssl.create_default_context", side_effect=ssl.SSLError("bad CA")):
            self.assertEqual(self.client.get("/api/hue/lights").status_code, 503)
        self.context_patch.start()
        self.connection.request.side_effect = ssl.SSLCertVerificationError("test-secret-placeholder")
        response = self.client.get("/api/hue/lights")
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("test-secret-placeholder", response.get_data(as_text=True))

    def test_connection_configuration(self):
        self.response({"data": [], "errors": []})
        self.client.get("/api/hue/lights")
        self.context_patch.target.create_default_context.assert_called_with(cafile="test-ca.pem")
        self.assertTrue(self.context.hostname_checks_common_name)
        self.https.target.HueHTTPSConnection.assert_called_with(
            "192.0.2.1", "0123456789abcdef", timeout=5, context=self.context)

    def test_real_context_retains_strict_verification(self):
        self.context_patch.stop()
        context = ssl.create_default_context()
        with patch("app.hue_client.ssl.create_default_context", return_value=context):
            self.response({"data": [], "errors": []})
            self.assertEqual(self.client.get("/api/hue/lights").status_code, 200)
        self.context_patch.start()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.hostname_checks_common_name)

    def test_nonexistent_ca_file_is_configuration_error(self):
        self.context_patch.stop()
        with patch.dict(os.environ, {"HUE_BRIDGE_CA_FILE": str(Path(self.temp_dir.name) / "missing.pem")}):
            self.assertEqual(self.client.get("/api/hue/lights").status_code, 503)
        self.context_patch.start()

    def test_tls_uses_bridge_id_as_hostname(self):
        context = Mock()
        tcp_socket = Mock()
        tls_socket = Mock()
        context.wrap_socket.return_value = tls_socket
        connection = HueHTTPSConnection("192.0.2.1", "0123456789abcdef",
                                        timeout=5, context=context)
        with patch("http.client.HTTPConnection.connect", autospec=True) as connect:
            connect.side_effect = lambda conn: setattr(conn, "sock", tcp_socket)
            connection.connect()
        context.wrap_socket.assert_called_once_with(tcp_socket, server_hostname="0123456789abcdef")
        self.assertIs(connection.sock, tls_socket)


if __name__ == "__main__":
    unittest.main()
