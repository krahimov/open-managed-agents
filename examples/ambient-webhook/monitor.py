#!/usr/bin/env python3
"""Poll the MLOps demo's /state and deliver new regressions to an ambient hook.

Uses only the Python standard library. The first successful poll establishes a
baseline; existing incidents are not replayed. State and pending deliveries
survive restarts. Run one monitor per state file.
"""
import argparse
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

BAD = {"degraded", "broken"}


def detect(state, snapshot):
    """Update the baseline and durably queue one event per status transition."""
    if not snapshot.get("ok"):
        raise ValueError("Dashboard is not ready")
    model = snapshot["production"]["model_id"]
    statuses = {row["window_id"]: row["status"] for row in snapshot["windows"]}
    previous = state.get("statuses")
    # A deployment re-scores historical windows. Establish its baseline without
    # treating these changed scores as fresh incoming production incidents.
    if previous is not None and model == state.get("model_id"):
        for row in snapshot["windows"]:
            wid, status = row["window_id"], row["status"]
            if status in BAD and status != previous.get(wid):
                state.setdefault("pending", []).append({
                    "event_id": f"mlops-{wid}-{uuid4()}",
                    "data": {"kind": "model_regression", "window_id": wid,
                             "production_model": model, "status": status,
                             "auc": row.get("auc"), "delta": row.get("delta"),
                             "error": row.get("error")},
                })
    state.update(model_id=model, statuses=statuses)


def save(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    tmp.replace(path)


def deliver(state, send):
    remaining = []
    for event in state.get("pending", []):
        try:
            result = send(event)
            state["last_delivery"] = {**event, **result}
            print(json.dumps({"delivered": event["event_id"], **result}), flush=True)
        except HTTPError as exc:
            if exc.code in (408, 425, 429, 503, 504):
                remaining.append(event)
            else:
                # 409/502 can mean execution already began. Preserve for
                # inspection instead of generating a fresh event ID.
                failure = {**event, "http_status": exc.code,
                           "response": exc.read().decode(errors="replace")}
                state.setdefault("failed", []).append(failure)
                print(json.dumps({"delivery_needs_attention": failure}), flush=True)
        except (URLError, TimeoutError, ConnectionError):
            remaining.append(event)
    state["pending"] = remaining


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-url", default="http://localhost:8000/state")
    parser.add_argument("--webhook-url", required=True)
    parser.add_argument("--state-file", type=Path, default=Path(".ambient-monitor.json"))
    parser.add_argument("--interval", type=float, default=2)
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be positive")
    state = json.loads(args.state_file.read_text()) if args.state_file.exists() else {}
    if state.get("webhook_url", args.webhook_url) != args.webhook_url:
        parser.error("State file belongs to another webhook; use a separate state file")
    state["webhook_url"] = args.webhook_url
    headers = {"Content-Type": "application/json"}
    if os.getenv("OMA_API_KEY"):
        headers["x-api-key"] = os.environ["OMA_API_KEY"]

    def send(event):
        request = Request(args.webhook_url, json.dumps(event).encode(), headers)
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    print("Monitoring; new regressions will trigger the ambient webhook.", flush=True)
    while True:
        try:
            with urlopen(args.state_url, timeout=30) as response:
                detect(state, json.load(response))
            save(args.state_file, state)  # Persist event ID before attempting delivery.
            deliver(state, send)
            save(args.state_file, state)
        except (URLError, TimeoutError, ValueError, OSError) as exc:
            print(f"Monitor retry: {exc}", flush=True)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
