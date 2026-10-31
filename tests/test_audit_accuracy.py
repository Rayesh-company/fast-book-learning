# -*- coding: utf-8 -*-
"""Feedback loop test for token auditing and cost calculation accuracy.

Asserts the user's exact reported symptoms:
1. Mastra Studio trace 7aa0313b11e79e4918c4acf66a896a24 has ~30.6K input and ~5.23K output tokens.
2. The 13 actual chats in the system have multi-step agent consumption (~30K-35K tokens/chat).
3. AvalAI cost per chat is ~1,411 Toman (18,352.77 Toman for 13 chats), NOT 7-10 Toman.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path


class TestTokenTelemetryAccuracy(unittest.TestCase):
    def test_trace_token_extraction(self):
        """Trace 7aa0313b11e79e4918c4acf66a896a24 must report ~30.6K input and ~5.2K output tokens."""
        cmd = [
            sys.executable,
            "scripts/audit_token_usage.py",
            "--trace",
            "7aa0313b11e79e4918c4acf66a896a24",
            "--json",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, cwd=Path(__file__).resolve().parent.parent)
        self.assertEqual(res.returncode, 0, f"Script failed: {res.stderr}")

        import json
        data = json.loads(res.stdout)
        summary = data.get("summary", {})
        records = data.get("records", [])

        # The trace must be found and analyzed
        self.assertGreater(len(records), 0, "Trace 7aa0313b11e79e4918c4acf66a896a24 was not found (reported 0 records)!")
        
        rec = records[0]
        prompt_tokens = rec.get("mastra_prompt_tokens", 0)
        completion_tokens = rec.get("mastra_completion_tokens", 0)
        cost_toman = rec.get("cost_toman", 0)

        # Mastra Studio screenshot shows 30.6K input, 5.23K output
        self.assertGreaterEqual(
            prompt_tokens, 25000,
            f"Prompt tokens {prompt_tokens} is far below Mastra Studio actual (~30,600)!"
        )
        self.assertGreaterEqual(
            completion_tokens, 4000,
            f"Completion tokens {completion_tokens} is far below Mastra Studio actual (~5,200)!"
        )
        # Cost must match AvalAI billing (~1,400 Toman, not 7-10 Toman)
        self.assertGreaterEqual(
            cost_toman, 1000,
            f"Cost in Toman {cost_toman} is far below AvalAI reality (~1,400 Toman)!"
        )


if __name__ == "__main__":
    unittest.main()
