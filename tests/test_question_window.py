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


# --- window_state (issue #23): the at-a-glance read the reply, the
# restore read, and the 429 refusal all carry -----------------------------


def test_window_state_reports_the_remaining_count_and_the_oldest_age_out(
    tmp_path,
):
    _patch(tmp_path)
    now = 1_000_000.0
    # Three Questions inside the window: 27 remain, and the window
    # reopens when the OLDEST of them ages out.
    for i in range(3):
        question_window.record_question("09120000000", now=now - i * 60)
    state = question_window.window_state("09120000000", now=now)
    assert state["remaining"] == question_window.QUESTION_WINDOW_LIMIT - 3
    assert state["reopens_at"] == (now - 2 * 60) + (
        question_window.QUESTION_WINDOW_HOURS * 3600
    )


def test_window_state_clamps_the_remaining_count_at_zero(tmp_path):
    _patch(tmp_path)
    now = 1_000_000.0
    # Nothing stops a store from holding more than the limit (the meter
    # refuses before the write, but the read must stay honest anyway):
    # remaining never goes negative, and the reopen time still names
    # the oldest record's aging out.
    for i in range(question_window.QUESTION_WINDOW_LIMIT + 5):
        question_window.record_question("09120000000", now=now - i)
    state = question_window.window_state("09120000000", now=now)
    assert state["remaining"] == 0
    assert state["reopens_at"] == (now - question_window.QUESTION_WINDOW_LIMIT - 4) + (
        question_window.QUESTION_WINDOW_HOURS * 3600
    )


def test_window_state_ignores_records_past_the_window_edge(tmp_path):
    _patch(tmp_path)
    now = 1_000_000.0
    # A record past the five-hour edge counts for neither number — the
    # remaining count and the reopen time both look only in-window.
    question_window.record_question("09120000000", now=now - 60)
    question_window.record_question("09120000000", now=now - 5 * 3600 - 1)
    state = question_window.window_state("09120000000", now=now)
    assert state["remaining"] == question_window.QUESTION_WINDOW_LIMIT - 1
    assert state["reopens_at"] == (now - 60) + (
        question_window.QUESTION_WINDOW_HOURS * 3600
    )


def test_window_state_on_an_empty_window_has_no_reopen_time(tmp_path):
    _patch(tmp_path)
    # A fresh Account: the full count remains, and no Question is aging
    # out — there is nothing to wait for.
    assert question_window.window_state("09120000000") == {
        "remaining": question_window.QUESTION_WINDOW_LIMIT,
        "reopens_at": None,
    }
