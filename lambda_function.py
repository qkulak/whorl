"""AWS Lambda entry point. Runs each Function URL request through server.Handler
— the same code as `python3 server.py`, sign-in included — by handing it the
request as raw HTTP bytes and reading its raw HTTP response back.

Cognito's pre sign-up trigger (the invite code check) calls this function too.
"""
import base64
import io

import accounts
import server


class _LambdaHandler(server.Handler):
    """server.Handler reading from and writing to memory instead of a socket."""

    def setup(self):
        self.rfile = io.BytesIO(self.request)
        self.wfile = io.BytesIO()

    def handle(self):
        self.handle_one_request()

    def finish(self):
        pass


def _raw_request(event):
    http = event["requestContext"]["http"]
    path = event.get("rawPath") or "/"
    if event.get("rawQueryString"):
        path += "?" + event["rawQueryString"]
    body = event.get("body") or ""
    body = base64.b64decode(body) if event.get("isBase64Encoded") else body.encode("utf-8")

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    headers.pop("cookie", None)  # Function URLs pass cookies separately
    if event.get("cookies"):
        headers["cookie"] = "; ".join(event["cookies"])
    headers["content-length"] = str(len(body))
    lines = [f"{http['method']} {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in headers.items()]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + body


def _lambda_response(raw):
    head, _, body = raw.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode("iso-8859-1").split("\r\n")
    headers, cookies = {}, []
    for line in header_lines:
        name, _, value = line.partition(":")
        name, value = name.strip(), value.strip()
        if name.lower() == "set-cookie":
            cookies.append(value)
        elif name.lower() not in ("server", "date", "content-length"):
            headers[name] = value
    return {
        "statusCode": int(status_line.split()[1]),
        "headers": headers,
        "cookies": cookies,
        "body": base64.b64encode(body).decode("ascii"),
        "isBase64Encoded": True,
    }


def handler(event, context):
    if "triggerSource" in event:
        return accounts.handle_trigger(event)
    source = (event.get("requestContext", {}).get("http", {}).get("sourceIp") or "lambda", 0)
    h = _LambdaHandler(_raw_request(event), source, None)
    return _lambda_response(h.wfile.getvalue())
