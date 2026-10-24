import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';

async function fixture({ profile = null, profileCompleted = false } = {}) {
  const dom = new JSDOM('<main id="app"></main>', {
    url: 'http://localhost/mobile/',
    pretendToBeVisual: true,
  });
  const api = createDemoApi({
    storage: dom.window.localStorage,
    delay: 0,
    loginRequired: true,
  });
  // Setup account in mock demo storage with desired profile state
  if (profileCompleted || profile) {
    await api.saveProfile(profile || { usage_purpose: 'academic' });
  } else {
    // Brand new account without completed profile
    api.me = async () => ({
      phone: '09121112233',
      email: 'user@test.local',
      role: 'user',
      profile: null,
      profile_completed: false,
    });
  }

  const app = createMobileApp({
    root: dom.window.document.querySelector('#app'),
    api,
    storage: dom.window.localStorage,
  });
  // Set demo=false so onboarding routing is active
  app.state.demo = false;
  await app.ready;
  return {
    dom,
    doc: dom.window.document,
    api,
    app,
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}

const tick = () => new Promise(r => setTimeout(r, 10));

test('first-time user without completed profile is routed to onboarding view', async () => {
  const f = await fixture({ profileCompleted: false });
  assert.equal(f.app.state.view, 'onboarding');
  assert.equal(f.doc.querySelector('.phone').dataset.type, 'onboarding');
  assert.ok(f.doc.querySelector('[data-onboarding-form]'));
  assert.match(f.doc.querySelector('h1').textContent, /سبک یادگیری/);

  // Check Q1 (Agent Tone) is required with 4 options
  const toneRadios = f.doc.querySelectorAll('input[name="assistant_tone"]');
  assert.equal(toneRadios.length, 4);
  assert.equal(toneRadios[0].required, true);

  // Check optional fields exist (Age, Knowledge Level)
  assert.ok(f.doc.querySelector('input[name="age"]'));
  assert.ok(f.doc.querySelector('input[name="knowledge_level"]'));

  // Obsolete questions should not be present in the streamlined form
  assert.equal(f.doc.querySelector('input[name="usage_purpose"]'), null);
  assert.equal(f.doc.querySelector('input[name="political_familiarity"]'), null);
  assert.equal(f.doc.querySelector('input[name="religious_familiarity"]'), null);
  assert.equal(f.doc.querySelector('input[name="occupation"]'), null);

  f.close();
});

test('submitting onboarding form saves profile and transitions to reader', async () => {
  const f = await fixture({ profileCompleted: false });
  assert.equal(f.app.state.view, 'onboarding');

  // Select Q1 (Tone: simple)
  const toneRadio = f.doc.querySelector('input[name="assistant_tone"][value="simple"]');
  toneRadio.checked = true;

  // Fill optional fields
  const ageInput = f.doc.querySelector('input[name="age"]');
  if (ageInput) ageInput.value = '24';

  const knowledgeRadio = f.doc.querySelector('input[name="knowledge_level"][value="medium"]');
  if (knowledgeRadio) knowledgeRadio.checked = true;

  const form = f.doc.querySelector('[data-onboarding-form]');
  form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();
  await tick();

  // Profile should now be marked completed and view navigated to reader
  assert.equal(f.app.state.view, 'reader');
  assert.equal(f.app.state.account.profile_completed, true);
  assert.equal(f.app.state.account.profile.assistant_tone, 'simple');
  assert.equal(f.app.state.account.profile.knowledge_level, 'medium');
  assert.equal(f.app.state.account.profile.usage_purpose, 'learning');

  f.close();
});

test('account view displays profile summary and allows editing preferences', async () => {
  const f = await fixture({
    profile: {
      assistant_tone: 'professional',
      age: '28',
      knowledge_level: 'high',
    },
    profileCompleted: true,
  });

  // User with completed profile starts in reader
  assert.equal(f.app.state.view, 'reader');

  // Navigate to account view
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="account"]').click();
  assert.equal(f.app.state.view, 'account');

  // Summary should show the saved preferences
  const summary = f.doc.querySelector('.profile-summary');
  assert.ok(summary);
  assert.match(summary.textContent, /حرفه‌ای/);
  assert.match(summary.textContent, /۲۸/);
  assert.match(summary.textContent, /زیاد/);

  // Click edit profile
  const editBtn = f.doc.querySelector('[data-action="edit-profile"]');
  assert.ok(editBtn);
  editBtn.click();

  assert.equal(f.app.state.view, 'profile');
  const editForm = f.doc.querySelector('[data-profile-form]');
  assert.ok(editForm);

  // Pre-filled values check
  const checkedTone = editForm.querySelector('input[name="assistant_tone"]:checked');
  assert.equal(checkedTone?.value, 'professional');
  const checkedKnowledge = editForm.querySelector('input[name="knowledge_level"]:checked');
  assert.equal(checkedKnowledge?.value, 'high');
  const ageField = editForm.querySelector('input[name="age"]');
  assert.equal(ageField?.value, '28');

  // Change tone to kids and submit
  const kidsRadio = editForm.querySelector('input[name="assistant_tone"][value="kids"]');
  kidsRadio.checked = true;
  editForm.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();
  await tick();

  // Returns back to account view with updated summary
  assert.equal(f.app.state.view, 'account');
  assert.match(f.doc.querySelector('.profile-summary').textContent, /برای نوجوان و کودک/);

  f.close();
});
