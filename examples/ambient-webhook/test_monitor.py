import unittest
from urllib.error import URLError
from monitor import detect, deliver


def snapshot(status="healthy", model="m1"):
    return {"ok": True, "production": {"model_id": model},
            "windows": [{"window_id": "w05", "status": status, "auc": .6, "delta": -.2}]}


class MonitorTests(unittest.TestCase):
    def test_bootstrap_transition_dedup_recovery(self):
        state = {}
        detect(state, snapshot("degraded"))
        self.assertFalse(state.get("pending"))
        detect(state, snapshot())
        detect(state, snapshot("degraded"))
        detect(state, snapshot("degraded"))
        self.assertEqual(len(state["pending"]), 1)
        detect(state, snapshot("broken"))
        self.assertEqual(len(state["pending"]), 2)

    def test_deployment_rescores_do_not_retrigger(self):
        state = {}
        detect(state, snapshot())
        detect(state, snapshot("degraded", "m2"))
        self.assertFalse(state.get("pending"))

    def test_transport_retry_preserves_event_id(self):
        state = {}
        detect(state, snapshot())
        detect(state, snapshot("degraded"))
        event_id = state["pending"][0]["event_id"]
        def unavailable(event):
            raise URLError("offline")
        deliver(state, unavailable)
        self.assertEqual(state["pending"][0]["event_id"], event_id)
        deliver(state, lambda event: {"session_id": "s1"})
        self.assertEqual(state["pending"], [])


if __name__ == "__main__":
    unittest.main()
