"""Acoustic checkpoint regressions; run with pytest or stdlib unittest."""
import copy
import unittest

from tools.build_lecture_index import Stream
from tools.refine_lecture_checkpoints import (
    PauseIndex, detect_pauses, phrase_cuts, refine_session, sentence_anchors,
)


class CheckpointTests(unittest.TestCase):
    def test_short_unvoiced_phoneme_is_not_a_pause(self):
        rms = [0.15] * 100 + [0.001] * 4 + [0.15] * 100 + [0.001] * 15 + [0.15] * 100
        self.assertEqual(detect_pauses(rms), [(4.08, 4.38)])

    def test_recording_volume_changes_do_not_create_silence(self):
        rms = [0.2] * 1000 + [0.05] * 1000
        self.assertEqual(detect_pauses(rms), [])

    def test_invalid_energy_is_rejected(self):
        with self.assertRaises(ValueError):
            detect_pauses([0.1, float("nan")])

    def test_boundary_can_move_earlier_or_later_and_switches_in_silence(self):
        sentences = [{"id": 0, "start": 0, "end": 5}, {"id": 1, "start": 5, "end": 10}]
        for silence in [(4.4, 4.8), (5.3, 5.7)]:
            starts, ends = sentence_anchors(sentences, PauseIndex([silence]))
            self.assertEqual(ends[0]["checkpoint"], starts[1]["checkpoint"])
            self.assertGreaterEqual(starts[1]["checkpoint"], silence[0])
            self.assertLessEqual(starts[1]["checkpoint"], silence[1])
            self.assertEqual(ends[0]["speech"], silence[0])
            self.assertEqual(starts[1]["speech"], silence[1])

    def test_no_pause_preserves_original_anchors_and_commentary_gap(self):
        sentences = [{"id": 0, "start": 0, "end": 5}, {"id": 1, "start": 15, "end": 20}]
        starts, ends = sentence_anchors(sentences, PauseIndex([(6, 14)]))
        self.assertEqual([s["checkpoint"] for s in starts], [0, 15])
        self.assertEqual([s["checkpoint"] for s in ends], [5, 20])

    def test_long_breath_can_extend_beyond_the_search_radius_but_checkpoint_cannot(self):
        sentences = [{"id": 0, "start": 0, "end": 5}, {"id": 1, "start": 5, "end": 10}]
        starts, ends = sentence_anchors(sentences, PauseIndex([(3.8, 5.8)]))
        self.assertEqual(ends[0]["checkpoint"], 4.8)
        self.assertEqual(starts[1]["speech"], 5.8)
        self.assertEqual(ends[0]["speech"], 3.8)
        starts, ends = sentence_anchors(sentences, PauseIndex([(5.9, 6.3)]))
        self.assertIsNone(starts[1]["pause"])
        self.assertEqual(ends[0]["checkpoint"], 5)

    def test_phrase_boundaries_need_measured_pauses(self):
        text = "یک دو سه چهار پنج شش، هفت هشت نه ده یازده دوازده"
        self.assertEqual(phrase_cuts(text, 0, 12, PauseIndex([])), [])
        cuts = phrase_cuts(text, 0, 12, PauseIndex([(5.2, 5.5), (6, 6.4)]))
        self.assertTrue(cuts)
        for _, pause in cuts:
            self.assertIn(pause, [(5.2, 5.5), (6, 6.4)])

    def fixture(self, flags=()):
        text = "یک دو سه چهار پنج شش، هفت هشت نه ده یازده دوازده"
        words = [(360 - i * 24, 100, 380 - i * 24, 112, word) for i, word in enumerate(text.split())]
        stream = Stream({1: words})
        sentence = {"id": 10, "text": text, "start": 0, "end": 12, "page": 1, "page_end": 1,
                    "confidence": .8, "flags": list(flags), "boxes": [[1, 90, 100, 380, 112]]}
        return {"session": 1, "sentences": [sentence]}, stream

    def test_exact_pdf_match_yields_smaller_disjoint_boxes_and_intact_sentence(self):
        session, stream = self.fixture()
        original = copy.deepcopy(session)
        cues, report = refine_session(session, PauseIndex([(5.2, 5.5), (6, 6.4)]), stream)
        self.assertGreater(len(cues), 1)
        self.assertEqual(session, original)
        self.assertEqual(" ".join(c["text"] for c in cues), session["sentences"][0]["text"])
        for cue in cues:
            self.assertTrue(cue["boxes"])
            self.assertEqual(cue["sentence_id"], 10)
            self.assertEqual(cue["timing"]["text_boundary"], "estimated")
            self.assertTrue(cue["timing"]["requires_word_alignment"])
        for first, next_ in zip(cues, cues[1:]):
            self.assertLessEqual(first["end"], next_["start"])
            self.assertGreaterEqual(first["boxes"][0][1], next_["boxes"][0][3])
            self.assertLess(first["speech_end"], first["end"])
            self.assertLess(next_["start"], next_["speech_start"])

    def test_uncertain_or_unlocated_text_is_never_subdivided(self):
        for flags in [("rough_timing",), ("interpolated",), ("garbled_pdf_text",), ("low_confidence",)]:
            session, stream = self.fixture(flags)
            cues, _ = refine_session(session, PauseIndex([(5.2, 5.5)]), stream)
            self.assertEqual(len(cues), 1)
            self.assertTrue(cues[0]["timing"]["requires_word_alignment"])
        session, _ = self.fixture()
        cues, _ = refine_session(session, PauseIndex([(5.2, 5.5)]), Stream({1: []}))
        self.assertEqual(len(cues), 1)


if __name__ == "__main__":
    unittest.main()
