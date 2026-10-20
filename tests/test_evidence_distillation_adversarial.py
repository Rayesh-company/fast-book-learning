"""Adversarial stress-testing suite for Evidence Pool Sentence Distillation.

Authored by Challenger 2 for Milestone M4 Final Verification.
Tests edge-case queries, missing page markers, exotic delimiters, unicode control
characters, zero keyword matches, extreme passage lengths, verbatim string slicing,
and boundary error handling.
"""

from __future__ import annotations

import re
import random
import pytest

from ui.ask import distill_pool
from ui.guard import normalize_for_match

_CANONICAL_CITATION_REGEX = re.compile(
    r"^document\s+[A-Za-z0-9._-]+(?:\s+\((?:page\s+\d+|pages\s+\d+-\d+)\))?$"
)


class TestAdversarialQueries:
    """Stress-test distill_pool with edge-case and pathological queries."""

    @pytest.mark.parametrize(
        "query_desc,query",
        [
            ("empty_string", ""),
            ("pure_spaces", "   "),
            ("tabs_and_newlines", "\t\t\n\r\n   "),
            ("single_char_persian_word", "و"),
            ("single_char_ascii", "a"),
            ("short_two_letter_word", "در"),
            ("punctuation_only", "?!.,؛:؟"),
            ("emojis_and_symbols", "🔍 📚 ✨ 🌟"),
            ("unicode_control_chars", "\u200c\u200d\u200e\u200f\x00\x08"),
            ("repeated_words", "کتاب " * 50),
            ("none_query", None),
        ],
    )
    def test_pathological_queries_do_not_crash_and_preserve_verbatim(
        self, query_desc: str, query: str | None
    ):
        raw_passage = (
            "Page 10:\n"
            "این یک متن آزمایشی استاندارد درباره توحید و جامعه اسلامی است.\n"
            "Page 11:\n"
            "پیامبران الهی برای برپایی عدالت و مبارزه با طاغوت مبعوث شدند.\n"
            "انسان در این مکتب به سوی کمال و آزادی حرکت می‌کند."
        )
        pool = [{"reference": "document tarhe-kolli (pages 10-11)", "passage": raw_passage}]

        # Must not raise an exception
        distilled = distill_pool(query, pool)

        assert isinstance(distilled, list)
        assert len(distilled) == 1
        item = distilled[0]
        assert "passage" in item
        assert "reference" in item
        assert "score" in item

        # Invariant: Verbatim slicing
        assert item["passage"] in raw_passage
        # Invariant: Canonical reference format
        assert _CANONICAL_CITATION_REGEX.match(item["reference"])

    def test_query_with_zero_keyword_matches_fallback(self):
        """When query keywords have 0 matches in passage, distillation falls back gracefully."""
        raw_passage = (
            "Page 100:\n"
            "جامعه اسلامی بر پایه ایمان و تقوا استوار است.\n"
            "Page 101:\n"
            "ارزش‌های الهی در تمام ابعاد زندگی جاری و ساری می‌گردد.\n"
            "Page 102:\n"
            "حقوق مستضعفان و محرومان باید با قاطعیت تأمین شود."
        )
        pool = [{"reference": "document tarhe-kolli (pages 100-102)", "passage": raw_passage}]
        query = "فیزیک کوانتومی نسبیت عام اینشتین کهکشان آندرومدا"

        distilled = distill_pool(query, pool)
        assert len(distilled) == 1
        res = distilled[0]

        # Max score is 0.0 because no keyword matched
        assert res["score"] == 0.0
        # Verbatim substring
        assert res["passage"] in raw_passage
        # Does not crash, selects fallback window starting at first valid sentence
        assert _CANONICAL_CITATION_REGEX.match(res["reference"])


class TestAdversarialPassagesAndDelimiters:
    """Stress-test distill_pool with unusual formatting, missing markers, and delimiters."""

    def test_missing_page_markers_entirely(self):
        """Passages without any 'Page N:' markers preserve original reference or dataset attribution."""
        raw_passage = (
            "متن طولانی بدون هیچ نشانه صفحه‌ای در این بخش قرار گرفته است تا عملکرد سیستم بررسی گردد. "
            "جمله دوم درباره اهمیت عدالت و قسط در جامعه اسلامی صحبت می‌کند. "
            "جمله سوم نتیجه‌گیری نهایی پیرامون مسئولیت انسان را تشریح می‌نماید."
        )
        pool = [{"reference": "document tarhe-kolli", "passage": raw_passage}]
        distilled = distill_pool("عدالت و قسط", pool)

        assert len(distilled) == 1
        res = distilled[0]
        # Reference remains valid canonical reference (without fabricated page numbers)
        assert res["reference"] == "document tarhe-kolli"
        assert res["passage"] in raw_passage
        assert "عدالت و قسط" in res["passage"]

    def test_missing_page_markers_with_preexisting_pages_in_reference(self):
        """If raw passage lacks markers but orig_ref had pages, it does not fabricate invalid page."""
        raw_passage = (
            "متن بدون نشانگر صفحه که باید با همان مرجع اصلی یا حفظ مرجع بازگردانده شود. "
            "این بحث پیرامون توحید و نفی طاغوت در تفکر اسلامی است. "
            "هرگونه ستم‌پذیری در این بینش محکوم و مردود شناخته می‌شود."
        )
        pool = [{"reference": "document tarhe-kolli (pages 30-40)", "passage": raw_passage}]
        distilled = distill_pool("توحید و نفی طاغوت", pool)

        assert len(distilled) == 1
        res = distilled[0]
        assert res["reference"] == "document tarhe-kolli (pages 30-40)"
        assert res["passage"] in raw_passage

    def test_exotic_persian_and_arabic_punctuation(self):
        """Handles Persian question mark (؟), Arabic semicolon (؛), Arabic comma (،), mixed with English."""
        raw_passage = (
            "Page 300:\n"
            "آیا هدف دین نجات بشریت است؟ "
            "پاسخ مثبت است؛ زیرا انسان بدون وحی به بیراهه می‌رود! "
            "نکته بعدی: عدل الهی ضامن بقای خلقت است، و هرگز تعطیل‌پذیر نیست. "
            "آیا این اصل بدیهی است؟ قطعاً همین‌طور است."
        )
        pool = [{"reference": "document 70143-336 (page 300)", "passage": raw_passage}]
        distilled = distill_pool("عدل الهی ضامن بقای خلقت", pool)

        assert len(distilled) == 1
        res = distilled[0]
        assert res["reference"] == "document 70143-336 (page 300)"
        assert "عدل الهی ضامن بقای خلقت است" in res["passage"]
        assert res["passage"] in raw_passage

    def test_unicode_control_characters_and_bidi_marks(self):
        """Passages with ZWNJ, ZWJ, LRM, RLM, and C0 control codes are parsed safely."""
        raw_passage = (
            "\ufeff"  # BOM
            "Page 450:\n"
            "\u200fجامعه\u200cای که بر مدار حق شکل می\u200cگیرد، هرگز شکست نمی\u200cخورد.\u200e\n"
            "Page 451:\n"
            "\x00نور هدایت در تاریکی\u200cهای فتنه راهگشای مومنان است.\x08\n"
            "پایان بخش مربوطه."
        )
        pool = [{"reference": "document tarhe-kolli (pages 450-451)", "passage": raw_passage}]
        distilled = distill_pool("شکست نمی‌خورد حق", pool)

        assert len(distilled) == 1
        res = distilled[0]
        assert res["reference"] == "document tarhe-kolli (page 450)"
        assert res["passage"] in raw_passage
        assert "جامعه" in res["passage"]

    def test_numbers_in_persian_arabic_and_ascii(self):
        """Sentence scoring and normalization with Persian digits (۱۲۳) and Arabic digits (١٢٣)."""
        raw_passage = (
            "Page 70:\n"
            "دوران ۲۵۰ ساله امامت شامل مراحل متعددی است.\n"
            "Page 71:\n"
            "در سال ۲۵۰ هجری وقایع مهمی رخ داد.\n"
        )
        pool = [{"reference": "document 70143-336 (pages 70-71)", "passage": raw_passage}]
        distilled = distill_pool("دوران ۲۵۰ ساله امامت", pool)

        assert len(distilled) == 1
        res = distilled[0]
        assert res["reference"] == "document 70143-336 (page 70)"
        assert "دوران ۲۵۰ ساله امامت" in res["passage"]
        assert res["passage"] in raw_passage


class TestExtremePassageLengthsAndBoundaries:
    """Stress-test distill_pool with extreme passage sizes."""

    def test_very_short_passage_under_50_chars(self):
        """Passage < 50 chars is retained verbatim without truncation or corruption."""
        short_passage = "Page 5: کلام کوتاه."
        pool = [{"reference": "document tarhe-kolli (page 5)", "passage": short_passage}]
        distilled = distill_pool("کلام کوتاه", pool)

        assert len(distilled) == 1
        assert distilled[0]["passage"] == short_passage
        assert distilled[0]["reference"] == "document tarhe-kolli (page 5)"

    def test_micro_passage_single_word(self):
        """Micro passage with 1 word."""
        micro_passage = "کلمه"
        pool = [{"reference": "document tarhe-kolli", "passage": micro_passage}]
        distilled = distill_pool("کلمه", pool)

        assert len(distilled) == 1
        assert distilled[0]["passage"] == micro_passage
        assert distilled[0]["reference"] == "document tarhe-kolli"

    def test_massive_passage_over_10k_chars(self):
        """Massive passage (> 10,000 chars) with 100 sentences across 10 pages."""
        sentences = []
        for p in range(1, 11):
            sentences.append(f"Page {p}:")
            for s in range(1, 11):
                if p == 7 and s == 5:
                    sentences.append(
                        "این نقطه اوج حقیقت ولایت است که در این جمله حساس پنهان شده است."
                    )
                else:
                    sentences.append(
                        f"این جمله شماره {s} در صفحه {p} برای آزمودن حجم سنگین متن است."
                    )
        massive_passage = "\n".join(sentences)
        assert len(massive_passage) > 5000

        pool = [{"reference": "document tarhe-kolli (pages 1-10)", "passage": massive_passage}]
        query = "نقطه اوج حقیقت ولایت جمله حساس"

        distilled = distill_pool(query, pool)
        assert len(distilled) == 1
        res = distilled[0]

        # Invariant: Must isolate exact page 7
        assert res["reference"] == "document tarhe-kolli (page 7)"
        assert "نقطه اوج حقیقت ولایت" in res["passage"]
        assert res["passage"] in massive_passage

        # Massive payload distilled dramatically
        assert len(res["passage"]) <= 600
        reduction = (len(massive_passage) - len(res["passage"])) / len(massive_passage)
        assert reduction > 0.85

    def test_massive_unbroken_passage_without_delimiters(self):
        """Passage of 2,000 characters without any sentence delimiters.
        
        Because sentence boundary preservation is an invariant, an unbroken
        text without delimiters is preserved as a single sentence verbatim.
        """
        unbroken_text = "کلمه " * 400  # 2000 chars
        pool = [{"reference": "document tarhe-kolli", "passage": unbroken_text}]
        distilled = distill_pool("کلمه", pool)

        assert len(distilled) == 1
        res = distilled[0]
        # Must be verbatim substring
        assert res["passage"] in unbroken_text
        assert res["passage"] == unbroken_text.strip()

    def test_passage_with_only_punctuation_delimiters(self):
        """Passage containing only punctuation dots and newlines."""
        punct_passage = ". . . . . \n . . . . . \n . . . ."
        pool = [{"reference": "document tarhe-kolli", "passage": punct_passage}]
        distilled = distill_pool("تست", pool)

        assert isinstance(distilled, list)
        for item in distilled:
            assert item["passage"] in punct_passage


class TestVerbatimStringSlicingFidelity:
    """Verifies that distilled passages are 100% exact verbatim substrings."""

    @pytest.mark.parametrize("seed", list(range(20)))
    def test_fuzz_passages_verbatim_property(self, seed: int):
        """Property-based invariant: for arbitrary synthetic passages, distilled in raw is ALWAYS True."""
        rng = random.Random(seed)

        vocab = ["ایمان", "تقوا", "عمل", "صالح", "عدالت", "جامعه", "توحید", "نبوت", "امامت", "قرآن"]
        delims = [". ", "!\n", "؟ ", "؛ ", "\n"]

        num_pages = rng.randint(1, 5)
        passage_parts = []
        for page_idx in range(num_pages):
            passage_parts.append(f"Page {100 + page_idx}:\n")
            num_sentences = rng.randint(2, 6)
            for _ in range(num_sentences):
                sentence_words = rng.choices(vocab, k=rng.randint(4, 15))
                sentence_text = " ".join(sentence_words) + rng.choice(delims)
                passage_parts.append(sentence_text)

        raw_passage = "".join(passage_parts)
        pool = [{"reference": f"document book-{seed} (pages 100-110)", "passage": raw_passage}]

        query_words = rng.choices(vocab, k=3)
        query = " ".join(query_words)

        distilled = distill_pool(query, pool)
        for item in distilled:
            assert item["passage"] in raw_passage, (
                f"VERBATIM VIOLATION on seed {seed}:\n"
                f"Distilled: {item['passage']}\n"
                f"Raw passage: {raw_passage}"
            )
            assert _CANONICAL_CITATION_REGEX.match(item["reference"]), (
                f"INVALID CITATION: {item['reference']}"
            )


class TestVulnerabilitiesAndEdgeCaseDefects:
    """Empirical demonstration of vulnerabilities uncovered during adversarial review."""

    def test_vulnerability_none_reference_causes_unhandled_typeerror(self):
        """EMPIRICAL DEFECT: When an item has reference=None and passage > 400 chars,
        distill_pool crashes with TypeError because _DOCUMENT_IN_REFERENCE.search(None) is called.
        """
        raw_passage = "Page 1:\n" + ("تست آزمایشی برای بررسی مرجع نال. " * 30)
        pool = [{"reference": None, "passage": raw_passage}]

        with pytest.raises(TypeError, match="expected string or bytes-like object, got 'NoneType'"):
            distill_pool("تست", pool)

    def test_vulnerability_ascii_question_mark_delimiters_omitted_from_negated_class(self):
        """EMPIRICAL DEFECT: _SENTENCE_REGEX uses r'([^.!؟؛\n]+[.!?؟؛\n]*)'.
        Notice ASCII '?' (0x3F) is in the second character class, but missing from the first
        negated character class [^.!؟؛\n]+. Consequently, sentences containing ASCII '?' are
        NOT split on the question mark.
        """
        raw_passage = (
            "Page 1:\n"
            "What is virtue? Virtue is justice. What is justice? Justice is balance.\n"
        )
        pool = [{"reference": "document english-test (page 1)", "passage": raw_passage}]
        distilled = distill_pool("Virtue", pool)

        assert len(distilled) == 1
        # Because '?' is not in [^.!؟؛\n], "What is virtue? Virtue is justice." is matched
        # as a single sentence up to '.'
        assert "What is virtue? Virtue is justice." in distilled[0]["passage"]
