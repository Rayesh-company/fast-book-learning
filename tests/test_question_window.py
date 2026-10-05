"""The Question window (Wayfinder #13, ADR-0017/0018): 30 Questions per
rolling 5 hours per Account — the launch meter that replaces the 5-ask
daily quota. A Question is one Learner message that RECEIVES an agent
answer; these tests pin the window's own arithmetic. The Learner-facing
seam's enforcement lives in test_agent_chat.py."""

import sys

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from ui import question_window  # noqa: E402


def _patch(tmp_path):
    question_window.WINDOW_DB = tmp_path / "window.sqlite3"


def test_counts_only_the_records_inside_the_window(tmp_path):
    _patch(tmp_path)
    now = 1_000_000.0
    # Twenty-nine records inside the five hours, one just past the edge.
    for i in range(29):
        question_window.record_question("09120000000", now=now - i * 60)
    question_window.record_question("09120000000", now=now - 5 * 3600 - 1)
    assert question_window.questions_in_window("09120000000", now=now) == 29


def test_one_account_never_meters_another(tmp_path):
    _patch(tmp_path)
    question_window.record_question("09120000001")
    assert question_window.questions_in_window("09120000002") == 0


def test_the_newest_write_prunes_what_the_window_already_ignored(tmp_path):
    _patch(tmp_path)
    now = 1_000_000.0
    for i in range(50):
        question_window.record_question("09120000000", now=now - i * 3600)
    question_window.record_question("09120000000", now=now)
    # The newest write pruned everything at or past its own five-hour
    # edge: the i=0..4 records plus the new one survive.
    assert question_window.questions_in_window("09120000000", now=now) == 6
