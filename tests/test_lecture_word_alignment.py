import unittest
import json
from pathlib import Path
from tools.build_lecture_index import Stream
from tools.align_lecture_words import prepare_words,build_cues,validate_cues,PHRASE_SCOPE,build_sentence_focus,add_sentence_onsets


class WordAlignmentTests(unittest.TestCase):
    def fixture(self):
        text='سلام کتاب بلند دنیا'
        stream=Stream({1:[(100-i*20,20,118-i*20,30,w) for i,w in enumerate(text.split())]})
        session={'session':1,'sentences':[{'id':1,'text':text,'start':0,'end':10,'page':1,'page_end':1,'flags':[]}]}
        words=prepare_words(session,stream)
        for w,(a,b) in zip(words,[(1,1.5),(2,2.5),(6,6.5),(8,8.5)]):
            w.update(start=a,end=b,coverage=1,support=1)
        return session,words

    def test_one_pdf_spelling_difference_does_not_hide_the_remaining_sentence(self):
        pdf_text = 'مولانا محمدعلی مولانا شوکتعلی که مولانا یعنی ایتالله مولانا در تعبیر مسلمانان هند'
        text = 'مولانا محمدعلی مولانا شوکتعلی که مولانا یعنی ایتالله مولانا در تعبیر مسلمانان هندوستان'
        stream = Stream({1: [(400-i*25,20,420-i*25,30,w) for i,w in enumerate(pdf_text.split())]})
        session = {'sentences': [{'id':0,'text':text,'start':0,'end':12,'page':1,'page_end':1}]}
        words = prepare_words(session, stream)
        for i, word in enumerate(words):
            word.update(start=i*.5,end=i*.5+.3,coverage=1,support=1)
        cues = build_cues(session, {'words':words,'duration':12}, [])
        self.assertTrue(cues, 'Recognized sentence vanished because one PDF word differs')
        self.assertEqual([w['text'] for w in words if w['boxes']], text.split()[:-1])
        self.assertFalse(words[-1]['boxes'])

    def test_short_sentence_uses_whole_pdf_word_not_substring_of_another_word(self):
        stream = Stream({1: [(100,20,120,30,'خانه'), (70,20,90,30,'نه')]})
        session = {'sentences': [{'id':0,'text':'نه.','start':0,'end':1,'page':1,'page_end':1}]}
        words = prepare_words(session, stream)
        self.assertEqual(words[0]['boxes'], [[1,70,20,90,30]])

    def test_rough_sentence_duration_cannot_exclude_a_readable_sentence_from_audio_alignment(self):
        text = 'پس ایمان لازم است.'
        stream = Stream({1: [(100-i*20,20,118-i*20,30,w) for i,w in enumerate(text.split())]})
        session = {'sentences': [{'id':109,'text':text,'start':1025.08,'end':1025.5,
                                 'page':1,'page_end':1,'flags':['low_confidence']}]}
        words = prepare_words(session, stream)
        self.assertEqual([w['text'] for w in words], text.split())
        self.assertTrue(all(w['boxes'] for w in words))

    def test_real_recognized_session_three_sentence_survives_pdf_spelling_difference(self):
        fixture = json.loads((Path(__file__).parent/'fixtures/lecture-ctc/session-03-pdf-placement.json').read_text())
        stream = Stream({int(p):words for p,words in fixture['pages'].items()})
        prepared = prepare_words(fixture['session'], stream)
        by_offset = {w['text_start']:w for w in prepared}
        observed = [{**w, 'boxes':by_offset[w['text_start']]['boxes']} for w in fixture['observations']]
        cues = build_cues(fixture['session'], {'words':observed,'duration':fixture['duration']}, [])
        shown = [w for c in cues for w in c['words']]
        self.assertEqual(len(shown), 12)
        self.assertEqual(shown[0]['text'], 'مولانا')
        self.assertEqual(shown[0]['start'], 260.78)
        self.assertEqual(shown[-1]['text'], 'هند،')
        self.assertEqual(shown[-1]['end'], 269.18)
        self.assertTrue(all(w['boxes'][0][0] == 91 for w in shown))
        self.assertIn('آیت‌الله،', build_sentence_focus(prepared)[0]['text'])

    def test_approximate_context_cannot_authorize_unrelated_pdf_words(self):
        stream = Stream({1: [(100-i*20,20,118-i*20,30,w) for i,w in enumerate('سلام کتاب بلند دنیا'.split())]})
        session = {'sentences': [{'id':0,'text':'خداحافظ زمین کوتاه فردا',
                                 'start':0,'end':10,'page':1,'page_end':1}]}
        self.assertFalse(any(w['boxes'] for w in prepare_words(session, stream)))

    def test_text_split_uses_words_on_either_side_of_measured_pause(self):
        session,words=self.fixture()
        cues=build_cues(session,{'words':words,'duration':10},[(2.8,5.8),(6.7,7.8)])
        self.assertEqual([c['text'] for c in cues],['سلام کتاب','بلند','دنیا'])
        self.assertEqual(cues[1]['end'],7.25)
        self.assertEqual(cues[2]['start'],7.25)
        self.assertEqual(cues[1]['speech_end'],6.5)
        self.assertEqual(cues[2]['speech_start'],8)
        self.assertTrue(all(not c['timing']['requires_word_alignment'] for c in cues))

    def test_missing_word_cannot_be_inside_a_highlight_rectangle(self):
        session,words=self.fixture()
        cues=build_cues(session,{'words':[words[0],words[2],words[3]],'duration':10},[])
        self.assertNotIn('کتاب',' '.join(c['text'] for c in cues))
        self.assertEqual(cues[0]['boxes'],words[0]['boxes'])
        self.assertLess(cues[0]['end'],cues[1]['start'])

    def test_sentence_context_includes_placeable_words_without_audio_times(self):
        session,words=self.fixture()
        for word in words:
            del word['start'],word['end']
        focus=build_sentence_focus(words)
        self.assertEqual(focus[0]['text'],session['sentences'][0]['text'])
        self.assertEqual(focus[0]['boxes'],[b for w in words for b in w['boxes']])
        self.assertNotIn('start',focus[0])
        self.assertNotIn('words',focus[0])

    def test_sentence_context_does_not_paint_unplaced_or_broken_glyphs(self):
        session,words=self.fixture()
        unplaced_box=words[1]['boxes'][0]
        words[1]['boxes']=[]
        focus=build_sentence_focus(words)[0]
        self.assertEqual(focus['text'],'سلام بلند دنیا')
        self.assertNotIn(unplaced_box,focus['boxes'])
        self.assertEqual(len(focus['boxes']),3)

    def test_silence_inside_a_word_cannot_cut_the_text(self):
        session,words=self.fixture()
        cues=build_cues(session,{'words':words[:2],'duration':10},[(1.1,1.4)])
        self.assertEqual(len(cues),1)
        self.assertEqual(cues[0]['text'],'سلام کتاب')

    def test_a_recognizer_word_wholly_inside_measured_silence_is_not_highlighted(self):
        session,words=self.fixture()
        cues=build_cues(session,{'words':words,'duration':10},[(1.8,2.6)])
        self.assertNotIn('کتاب',' '.join(c['text'] for c in cues))

    def test_pause_before_an_unsupported_word_cannot_advance_to_a_later_word(self):
        session,words=self.fixture()
        words[2].update(start=2.8,end=3.2)
        cues=build_cues(session,{'words':[words[0],words[2]],'duration':10},[(1.6,1.9)])
        self.assertEqual(cues[0]['end'],1.5)
        self.assertEqual(cues[1]['start'],2.8)
        self.assertIsNone(cues[1]['timing']['start_pause'])

    def test_extra_speech_in_a_gap_cannot_be_filled_by_a_distant_pause(self):
        session,words=self.fixture()
        words[1].update(start=2.8,end=3.2)
        cues=build_cues(session,{'words':words[:2],'duration':10},[(1.6,1.9)])
        self.assertEqual(cues[0]['end'],1.5)
        self.assertEqual(cues[1]['start'],2.8)

    def test_unplaced_pdf_text_cannot_borrow_a_neighbours_geometry(self):
        session,words=self.fixture()
        words[1]['boxes']=[]
        cues=build_cues(session,{'words':words,'duration':10},[])
        self.assertNotIn('کتاب',' '.join(c['text'] for c in cues))

    def test_fragments_next_to_missing_pdf_glyphs_are_not_words(self):
        text='قرآن میفرماید ره ▯ا ▯ها عَلَ ▯يهِم رهبانیتی روشن است'
        stream=Stream({1:[(100-i*10,20,109-i*10,30,w) for i,w in enumerate(text.replace('▯','').split())]})
        session={'sentences':[{'id':0,'text':text,'start':0,'end':20,'page':1,'page_end':1,'flags':['garbled_pdf_text']}]}
        words=prepare_words(session,stream)
        placed={w['text'] for w in words if w['boxes']}
        self.assertNotIn('ره',placed)
        self.assertNotIn('عَلَ',placed)
        self.assertNotIn('يهِم',placed)
        self.assertIn('رهبانیتی',placed)

    def test_invalid_word_or_crossed_cue_fails_before_publication(self):
        session,words=self.fixture()
        cues=build_cues(session,{'words':words,'duration':10},[])
        cues[0]['words'][0]['end']=11
        with self.assertRaises(ValueError):validate_cues(cues,10)

    def continuous_phrase(self, text, step=.25):
        stream=Stream({1:[(300-i*10,20,309-i*10,30,w) for i,w in enumerate(text.split())]})
        session={'sentences':[{'id':0,'text':text,'start':0,'end':30,'page':1,'page_end':1,'flags':[]}]}
        words=prepare_words(session,stream)
        for i,w in enumerate(words):w.update(start=1+i*step,end=1+i*step+.2,coverage=1,support=1)
        return session,words

    def test_long_continuous_phrase_is_bounded_without_inventing_silence(self):
        session,words=self.continuous_phrase(' '.join(['کتاب']*19))
        cues=build_cues(session,{'words':words,'duration':30},[])
        self.assertEqual([len(c['words']) for c in cues],[8,8,3])
        self.assertEqual(sum(len(c['words']) for c in cues),len(words))
        self.assertTrue(all(c['timing']['start_pause'] is None and c['timing']['end_pause'] is None for c in cues))
        self.assertEqual(cues[1]['start'],words[8]['start'])

    def test_slow_continuous_phrase_is_bounded_by_duration(self):
        session,words=self.continuous_phrase(' '.join(['کتاب']*8),step=.7)
        cues=build_cues(session,{'words':words,'duration':30},[])
        self.assertEqual([len(c['words']) for c in cues],[6,2])
        self.assertTrue(all(c['speech_end']-c['speech_start']<=PHRASE_SCOPE['max_speech_seconds'] for c in cues))

    def test_natural_clause_boundary_precedes_the_size_limit(self):
        session,words=self.continuous_phrase('سلام کتاب، بلند دنیا')
        cues=build_cues(session,{'words':words,'duration':30},[])
        self.assertEqual([c['text'] for c in cues],['سلام کتاب،','بلند دنیا'])

    def test_measured_pause_still_ends_a_short_phrase(self):
        session,words=self.continuous_phrase('سلام کتاب بلند دنیا',step=.5)
        cues=build_cues(session,{'words':words,'duration':30},[(1.74,1.96)])
        self.assertEqual([c['text'] for c in cues],['سلام کتاب','بلند دنیا'])
        self.assertEqual(cues[1]['start'],1.85)

    def test_a_missing_prefix_does_not_delay_context_past_a_measured_speech_onset(self):
        session,words=self.continuous_phrase('سلام کتاب بلند دنیا')
        words[2].update(start=3.5,end=3.8)
        words[3].update(start=4,end=4.3)
        cues=build_cues(session,{'words':words[2:],'duration':30},[])
        before=[dict(w) for c in cues for w in c['words']]
        add_sentence_onsets(cues,words,[(1.4,2.2)])
        onset=cues[0]['timing']['sentence_onset']
        self.assertEqual(onset['start'],2.2)
        self.assertEqual(onset['prefix_words'],2)
        self.assertEqual(onset['anchor_start'],3.5)
        self.assertEqual([w for c in cues for w in c['words']],before)

    def test_no_pause_or_a_remote_pause_cannot_invent_an_earlier_start(self):
        session,words=self.continuous_phrase('سلام کتاب بلند دنیا')
        for pauses in [[],[(0,.3)],[(.7,.8)]]:
            cues=build_cues(session,{'words':words,'duration':30},[])
            add_sentence_onsets(cues,words,pauses)
            self.assertNotIn('sentence_onset',cues[0]['timing'])

    def test_onset_cannot_borrow_speech_from_the_previous_or_a_skipped_sentence(self):
        session,words=self.continuous_phrase('سلام کتاب بلند دنیا')
        for word in words:word['sentence_id']=word['word_id']
        session['sentences']=[{'id':w['sentence_id'],'text':session['sentences'][0]['text']} for w in words]
        words[0].update(start=1,end=1.8)
        words[1].update(start=2,end=2.2)
        cues=build_cues(session,{'words':words[:2],'duration':30},[])
        add_sentence_onsets(cues,words,[(1.3,1.7)])
        self.assertNotIn('sentence_onset',cues[1]['timing'])
        words[2].update(start=2.5,end=2.8)
        cues=build_cues(session,{'words':[words[0],words[2]],'duration':30},[])
        add_sentence_onsets(cues,words,[(1.8,2.3)])
        self.assertNotIn('sentence_onset',cues[1]['timing'])


if __name__=='__main__':unittest.main()
