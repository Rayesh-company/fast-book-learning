import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';

async function fixture({ role = 'user', email = 'test@example.com' } = {}) {
  const dom = new JSDOM('<main id="app"></main>', {
    url: 'http://localhost/mobile/?demo=1',
    pretendToBeVisual: true,
  });
  dom.window.localStorage.setItem(
    'book-ui-demo-v1',
    JSON.stringify({
      account: { phone: '09121112233', email, role, profile_completed: true },
      quota: 30,
      subscription: null,
      sessions: [],
      notes: [],
      sequence: 1,
    })
  );
  const api = createDemoApi({
    storage: dom.window.localStorage,
    delay: 0,
    quota: 30,
    loginRequired: true,
  });

  const app = createMobileApp({
    root: dom.window.document.querySelector('#app'),
    api,
    storage: dom.window.localStorage,
  });
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

test('non-admin user cannot see admin dashboard navigation in drawer or account view', async () => {
  const f = await fixture({ role: 'operator' });
  // Open drawer
  f.doc.querySelector('[data-action="menu"]').click();
  assert.equal(f.doc.querySelector('.drawer [data-action="open-admin"]'), null);

  // Navigate to account view
  f.doc.querySelector('.drawer [data-action="account"]').click();
  assert.equal(f.doc.querySelector('.admin-quick-link'), null);
  f.close();
});

test('admin user sees admin dashboard navigation in drawer and account view', async () => {
  const f = await fixture({ role: 'admin', email: 'admin@rayesh.ir' });
  // Open drawer
  f.doc.querySelector('[data-action="menu"]').click();
  const adminNavItem = f.doc.querySelector('.drawer [data-action="open-admin"]');
  assert.ok(adminNavItem, 'Admin navigation button must be present in drawer');
  assert.match(adminNavItem.textContent, /میز مدیریت/);

  // Navigate to account view
  f.doc.querySelector('.drawer [data-action="account"]').click();
  const adminCard = f.doc.querySelector('.admin-quick-link');
  assert.ok(adminCard, 'Admin shortcut card must be present in account view');
  assert.ok(adminCard.querySelector('[data-action="open-admin"]'));
  f.close();
});

test('admin dashboard renders accounts list, summary KPIs, and allows search filtering', async () => {
  const f = await fixture({ role: 'admin', email: 'admin@rayesh.ir' });
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('.drawer [data-action="open-admin"]').click();
  await tick();
  await f.app.settled();

  assert.equal(f.doc.querySelector('.phone').dataset.type, 'admin');
  assert.ok(f.doc.querySelector('.admin-dashboard'));

  // KPI cards
  const metricCards = f.doc.querySelectorAll('.admin-metric-card');
  assert.ok(metricCards.length >= 4);

  // Accounts rendered
  const cards = f.doc.querySelectorAll('.admin-account-card');
  assert.ok(cards.length >= 3, 'Demo accounts should be rendered');

  // Search filtering
  const searchInput = f.doc.querySelector('[name="admin-search"]');
  assert.ok(searchInput);
  searchInput.value = 'student';
  searchInput.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  await tick();

  const filteredCards = f.doc.querySelectorAll('.admin-account-card');
  assert.equal(filteredCards.length, 1);
  assert.match(filteredCards[0].textContent, /student@example\.com/);

  // Clear search
  const clearBtn = f.doc.querySelector('[data-action="clear-admin-search"]');
  assert.ok(clearBtn);
  clearBtn.click();
  await tick();
  assert.ok(f.doc.querySelectorAll('.admin-account-card').length >= 3);

  f.close();
});

test('admin topup flow opens modal sheet and increases account balance', async () => {
  const f = await fixture({ role: 'admin', email: 'admin@rayesh.ir' });
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('.drawer [data-action="open-admin"]').click();
  await tick();
  await f.app.settled();

  // Find operator1's card
  const topupBtn = f.doc.querySelector('.admin-account-card [data-action="open-admin-topup"]');
  assert.ok(topupBtn);
  topupBtn.click();
  await tick();

  // Topup sheet should be open
  const form = f.doc.querySelector('[data-admin-topup-form]');
  assert.ok(form, 'Admin topup form should be open');

  // Pick quick chip
  const chip = f.doc.querySelector('.topup-quick-chips [data-action="pick-topup-amount"][data-amount="200000"]');
  assert.ok(chip);
  chip.click();
  assert.equal(form.elements.amount.value, '200000');

  // Submit topup
  form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  await f.app.settled();

  // Toast should show success
  const toast = f.doc.querySelector('.toast');
  assert.match(toast.textContent, /شارژ شد/);

  f.close();
});

test('admin can switch to create tab and create a new account', async () => {
  const f = await fixture({ role: 'admin', email: 'admin@rayesh.ir' });
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('.drawer [data-action="open-admin"]').click();
  await tick();
  await f.app.settled();

  // Switch to create tab
  const createTab = f.doc.querySelector('[data-action="admin-tab"][data-tab="create"]');
  assert.ok(createTab);
  createTab.click();
  await tick();

  const form = f.doc.querySelector('[data-admin-create-form]');
  assert.ok(form, 'Create account form should be visible');

  form.elements.email.value = 'newmember@example.com';
  form.elements.password.value = 'Secret123!';
  form.elements.phone.value = '09129998877';
  form.elements.initial_credit.value = '75000';

  form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  await f.app.settled();

  // Should have returned to accounts tab with new account present
  const cards = f.doc.querySelectorAll('.admin-account-card');
  const emails = Array.from(cards).map(c => c.querySelector('.admin-card-email')?.textContent);
  assert.ok(emails.includes('newmember@example.com'));

  f.close();
});
