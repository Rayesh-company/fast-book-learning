import {icon} from './icons.mjs';

export const digits = n => String(n).replace(/\d/g, c => '۰۱۲۳۴۵۶۷۸۹'[c]);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const BOOK_TOC = {
  'tarhe-kolli': {
    structured: true,
    summaryLabel: 'فهرست کتاب',
    groups: [
      {
        id: 'intro',
        badge: '',
        title: 'مقدمات',
        countUnit: 'بخش',
        items: [
          { id: 'eshareh', badge: '', title: 'اشاره', page: 7, endPage: 34, keywords: 'مقدمه آغازین شروع ۱ یک' },
          { id: 'author-preface', badge: '', title: 'مقدمۀ مؤلف', page: 35, endPage: 39, keywords: 'مقدمه نویسنده پیشگفتار' }
        ]
      },
      {
        id: 'iman',
        badge: 'فصل ۱',
        title: 'ایمان',
        countUnit: 'جلسه',
        items: [
          { id: 's-1', badge: 'جلسۀ ۱', title: 'ایمان (۱)', page: 41, endPage: 61, keywords: 'اول ۱ یک' },
          { id: 's-2', badge: 'جلسۀ ۲', title: 'ایمان (۲)', page: 62, endPage: 87, keywords: 'دوم ۲ دو' },
          { id: 's-3', badge: 'جلسۀ ۳', title: 'ایمان از روی آگاهی', page: 88, endPage: 110, keywords: 'سوم ۳ سه' },
          { id: 's-4', badge: 'جلسۀ ۴', title: 'ایمان زاینده و همراه با تعهدات عملی', page: 111, endPage: 133, keywords: 'چهارم ۴ چهار' },
          { id: 's-5', badge: 'جلسۀ ۵', title: 'ایمان و پایبندی به تعهدات', page: 134, endPage: 161, keywords: 'پنجم ۵ پنج' },
          { id: 's-6', badge: 'جلسۀ ۶', title: 'نویدها (۱)', page: 162, endPage: 186, keywords: 'ششم ۶ شش' },
          { id: 's-7', badge: 'جلسۀ ۷', title: 'نویدها (۲)', page: 187, endPage: 216, keywords: 'هفتم ۷ هفت' }
        ]
      },
      {
        id: 'towhid',
        badge: 'فصل ۲',
        title: 'توحید',
        countUnit: 'جلسه',
        items: [
          { id: 's-8', badge: 'جلسۀ ۸', title: 'توحید در جهان‌بینی اسلام', page: 218, endPage: 242, keywords: 'هشتم ۸ هشت' },
          { id: 's-9', badge: 'جلسۀ ۹', title: 'توحید در ایدئولوژی اسلام', page: 243, endPage: 271, keywords: 'نهم ۹ نه' },
          { id: 's-10', badge: 'جلسۀ ۱۰', title: 'عبادت و اطاعت انحصاری خدا', page: 272, endPage: 296, keywords: 'دهم ۱۰ ده' },
          { id: 's-11', badge: 'جلسۀ ۱۱', title: 'روح توحید: نفی عبودیت غیر خدا', page: 297, endPage: 325, keywords: 'یازدهم ۱۱ یازده' },
          { id: 's-12', badge: 'جلسۀ ۱۲', title: 'توحید و نفی طبقات اجتماعی', page: 326, endPage: 353, keywords: 'دوازدهم ۱۲ دوازده' },
          { id: 's-13', badge: 'جلسۀ ۱۳', title: 'تأثیرات روانی توحید', page: 354, endPage: 380, keywords: 'سیزدهم ۱۳ سیزده' }
        ]
      },
      {
        id: 'nobovvat',
        badge: 'فصل ۳',
        title: 'نبوت',
        countUnit: 'جلسه',
        items: [
          { id: 's-14', badge: 'جلسۀ ۱۴', title: 'فلسفۀ نبوت', page: 382, endPage: 407, keywords: 'چهاردهم ۱۴ چهارده' },
          { id: 's-15', badge: 'جلسۀ ۱۵', title: 'بعثت در نبوت', page: 408, endPage: 437, keywords: 'پانزدهم ۱۵ پانزده' },
          { id: 's-16', badge: 'جلسۀ ۱۶', title: 'رستاخیز اجتماعی نبوت', page: 438, endPage: 471, keywords: 'شانزدهم ۱۶ شانزده' },
          { id: 's-17', badge: 'جلسۀ ۱۷', title: 'هدف‌های نبوت', page: 472, endPage: 501, keywords: 'هفدهم ۱۷ هفده' },
          { id: 's-18', badge: 'جلسۀ ۱۸', title: 'نخستین نغمه‌های دعوت', page: 502, endPage: 533, keywords: 'هجدهم ۱۸ هجده' },
          { id: 's-19', badge: 'جلسۀ ۱۹', title: 'گروه‌های معارض', page: 534, endPage: 563, keywords: 'نوزدهم ۱۹ نوزده' },
          { id: 's-20', badge: 'جلسۀ ۲۰', title: 'فرجام نبوت (۱)', page: 564, endPage: 600, keywords: 'بیستم ۲۰ بیست' },
          { id: 's-21', badge: 'جلسۀ ۲۱', title: 'فرجام نبوت (۲)', page: 601, endPage: 627, keywords: 'بیست و یکم ۲۱' },
          { id: 's-22', badge: 'جلسۀ ۲۲', title: 'تعهد ایمان به نبوت', page: 628, endPage: 653, keywords: 'بیست و دوم ۲۲' }
        ]
      },
      {
        id: 'velayat',
        badge: 'فصل ۴',
        title: 'ولایت',
        countUnit: 'جلسه',
        items: [
          { id: 's-23', badge: 'جلسۀ ۲۳', title: 'ولایت', page: 655, endPage: 686, keywords: 'بیست و سوم ۲۳' },
          { id: 's-24', badge: 'جلسۀ ۲۴', title: 'پیوندهای امت اسلامی', page: 687, endPage: 711, keywords: 'بیست و چهارم ۲۴' },
          { id: 's-25', badge: 'جلسۀ ۲۵', title: 'بهشت ولایت', page: 712, endPage: 737, keywords: 'بیست و پنجم ۲۵' },
          { id: 's-26', badge: 'جلسۀ ۲۶', title: 'در پیرامون ولایت (۱)', page: 738, endPage: 763, keywords: 'بیست و ششم ۲۶' },
          { id: 's-27', badge: 'جلسۀ ۲۷', title: 'در پیرامون ولایت (۲)', page: 764, endPage: 791, keywords: 'بیست و هفتم ۲۷' },
          { id: 's-28', badge: 'جلسۀ ۲۸', title: 'در پیرامون ولایت (۳) · هجرت', page: 792, endPage: 820, keywords: 'بیست و هشتم ۲۸ هجرت' }
        ]
      },
      {
        id: 'indexes',
        badge: 'پیوست',
        title: 'فهرست‌ها',
        countUnit: 'بخش',
        items: [
          { id: 'idx-ayat', badge: '', title: 'فهرست آیات', page: 822, endPage: 846, keywords: 'آیه قران نمایه فهرست آیات' },
          { id: 'idx-revayat', badge: '', title: 'فهرست روایات', page: 847, endPage: 862, keywords: 'حدیث روایات نمایه فهرست روایات' }
        ]
      }
    ]
  },
  '70143-336': {
    structured: true,
    summaryLabel: 'فهرست کتاب',
    groups: [
      {
        id: 'intro',
        badge: '',
        title: 'مقدمات',
        countUnit: 'بخش',
        items: [
          { id: 'eshareh', badge: '', title: 'اشاره', page: 7, endPage: 12, keywords: 'مقدمه آغازین شروع ۱ یک' },
          { id: 'intro-text', badge: '', title: 'مقدمه', page: 13, endPage: 24, keywords: 'پیشگفتار' }
        ]
      },
      {
        id: 'part-1',
        badge: 'بخش ۱',
        title: 'پیامبر اعظم تا امام حسن (ع)',
        countUnit: 'فصل',
        items: [
          { id: 'ch-1', badge: 'فصل اول', title: 'پیامبر اعظم', page: 25, endPage: 56, keywords: 'رسول الله محمد ص ۱ یک' },
          { id: 'ch-2', badge: 'فصل دوم', title: 'امامت', page: 57, endPage: 68, keywords: '۲ دو' },
          { id: 'ch-3', badge: 'فصل سوم', title: 'امیرالمؤمنین', page: 69, endPage: 98, keywords: 'علی علیه السلام ۳ سه' },
          { id: 'ch-4', badge: 'فصل چهارم', title: 'حضرت فاطمه', page: 99, endPage: 112, keywords: 'زهرا سلام الله علیها ۴ چهار' },
          { id: 'ch-5', badge: 'فصل پنجم', title: 'امام حسن', page: 113, endPage: 138, keywords: 'مجتبی ۵ پنج' }
        ]
      },
      {
        id: 'part-2',
        badge: 'بخش ۲',
        title: 'امام حسین تا امام باقر (ع)',
        countUnit: 'فصل',
        items: [
          { id: 'ch-6', badge: 'فصل ششم', title: 'امام حسین', page: 139, endPage: 158, keywords: 'سیدالشهدا عاشورا کربلا ۶ شش' },
          { id: 'ch-7', badge: 'فصل هفتم', title: 'حرکت زینب کبری و سفیران کربلا', page: 159, endPage: 172, keywords: 'سفیران ۷ هفت' },
          { id: 'ch-8', badge: 'فصل هشتم', title: 'شرایط اجتماعی و سیاسی پس از حادثهٔ کربلا', page: 173, endPage: 184, keywords: 'شرایط ۸ هشت' },
          { id: 'ch-9', badge: 'فصل نهم', title: 'امام سجاد', page: 185, endPage: 228, keywords: 'زین العابدین ۹ نه' },
          { id: 'ch-10', badge: 'فصل دهم', title: 'امام باقر', page: 229, endPage: 250, keywords: 'باقرالعلوم ۱۰ ده' }
        ]
      },
      {
        id: 'part-3',
        badge: 'بخش ۳',
        title: 'امام صادق تا امام عسکری (ع)',
        countUnit: 'فصل',
        items: [
          { id: 'ch-11', badge: 'فصل یازدهم', title: 'اواخر حکومت بنی‌امیه و امامت امام صادق', page: 251, endPage: 258, keywords: '۱۱ یازده' },
          { id: 'ch-12', badge: 'فصل دوازدهم', title: 'امام صادق', page: 259, endPage: 276, keywords: 'جعفر ۱۲ دوازده' },
          { id: 'ch-13', badge: 'فصل سیزدهم', title: 'تشکیلات پنهان', page: 277, endPage: 286, keywords: 'مبارزه ۱۳ سیزده' },
          { id: 'ch-14', badge: 'فصل چهاردهم', title: 'امام کاظم', page: 287, endPage: 304, keywords: 'موسی ۱۴ چهارده' },
          { id: 'ch-15', badge: 'فصل پانزدهم', title: 'امام رضا', page: 305, endPage: 318, keywords: 'علی بن موسی الرضا ۱۵ پانزده' },
          { id: 'ch-16', badge: 'فصل شانزدهم', title: 'امام جواد، امام هادی و امام عسکری', page: 319, endPage: 330, keywords: 'جواد هادی عسکری ۱۶ شانزده' }
        ]
      },
      {
        id: 'part-4',
        badge: 'بخش ۴',
        title: 'غایت حرکت و نمایه',
        countUnit: 'بخش',
        items: [
          { id: 'ch-17', badge: 'فصل هفدهم', title: 'غایت حرکت انسان ۲۵۰ ساله', page: 331, endPage: 350, keywords: 'مهدویت ۱۷ هفده' },
          { id: 'idx-detail', badge: '', title: 'فهرست تفصیلی', page: 351, endPage: 390, keywords: 'نمایه فهرست تفصیلی' }
        ]
      }
    ]
  }
};

export function normalizeTocQuery(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064b-\u065f\u0670\u0640\u200c]/g, '')
    .replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))
    .replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function resolveBookToc(bookId, outline = []) {
  if (outline?.length > 0 && outline.some(o => o.title === 'فصل بعد')) {
    return {
      structured: false,
      summaryLabel: 'فهرست کتاب',
      groups: [
        {
          id: 'outline',
          title: 'سرفصل‌ها',
          countUnit: 'عنوان',
          items: outline.map((item, idx) => ({
            id: `outline-${idx}`,
            badge: '',
            title: item.title,
            page: item.page,
            endPage: item.page,
            keywords: ''
          }))
        }
      ]
    };
  }

  const curated = BOOK_TOC[bookId];
  if (curated) return curated;

  if (outline?.length > 0) {
    return {
      structured: false,
      summaryLabel: 'فهرست کتاب',
      groups: [
        {
          id: 'outline',
          title: 'سرفصل‌ها',
          countUnit: 'عنوان',
          items: outline.map((item, idx) => ({
            id: `outline-${idx}`,
            badge: '',
            title: item.title,
            page: item.page,
            endPage: item.page,
            keywords: ''
          }))
        }
      ]
    };
  }

  return null;
}

export function activeTocLocation(toc, currentPage) {
  if (!toc?.groups?.length) return { groupId: null, itemId: null };

  const page = Number(currentPage) || 1;

  for (const group of toc.groups) {
    for (const item of group.items) {
      if (page >= item.page && page <= item.endPage) {
        return { groupId: group.id, itemId: item.id };
      }
    }
  }

  // Handle dividers and boundary pages between sections
  if (page <= 34) return { groupId: 'intro', itemId: toc.groups[0]?.items[0]?.id || null };
  if (page === 40) return { groupId: 'iman', itemId: 's-1' };
  if (page === 217) return { groupId: 'towhid', itemId: 's-8' };
  if (page === 381) return { groupId: 'nobovvat', itemId: 's-14' };
  if (page === 654) return { groupId: 'velayat', itemId: 's-23' };
  if (page === 821) return { groupId: 'indexes', itemId: 'idx-ayat' };

  // Nearest preceding item fallback
  let candidate = null;
  for (const group of toc.groups) {
    for (const item of group.items) {
      if (item.page <= page) {
        candidate = { groupId: group.id, itemId: item.id };
      }
    }
  }

  return candidate || { groupId: toc.groups[0]?.id || null, itemId: toc.groups[0]?.items[0]?.id || null };
}

export function renderTocBodyMarkup({ toc, currentPage, query = '', expandedGroups = new Set() }) {
  if (!toc?.groups?.length) {
    return '<p class="toc-empty-fallback">فهرست قابل‌دسترسی داخل این کتاب موجود نیست. از شمارهٔ صفحه یا جستجوی متن استفاده کنید.</p>';
  }

  const active = activeTocLocation(toc, currentPage);
  const q = normalizeTocQuery(query);
  const isSearching = Boolean(q);

  let totalMatches = 0;
  const filteredGroups = [];

  for (const group of toc.groups) {
    const groupTitleNorm = normalizeTocQuery(group.title);
    const groupBadgeNorm = normalizeTocQuery(group.badge);
    const groupMatches = isSearching && (groupTitleNorm.includes(q) || (groupBadgeNorm && groupBadgeNorm.includes(q)));

    const matchingItems = group.items.filter(item => {
      if (!isSearching || groupMatches) return true;
      const titleNorm = normalizeTocQuery(item.title);
      const badgeNorm = normalizeTocQuery(item.badge);
      const kwNorm = normalizeTocQuery(item.keywords);
      return titleNorm.includes(q) || badgeNorm.includes(q) || kwNorm.includes(q);
    });

    if (!isSearching || matchingItems.length > 0) {
      filteredGroups.push({ group, items: matchingItems, groupMatched: groupMatches });
      if (isSearching) totalMatches += matchingItems.length;
    }
  }

  if (isSearching && filteredGroups.length === 0) {
    return `
      <div class="toc-search-empty" role="status">
        <div class="toc-empty-icon" aria-hidden="true">${icon('search')}</div>
        <p class="toc-empty-title">موردی در عناوین جلسات و سرفصل‌ها یافت نشد</p>
        <p class="toc-empty-desc">می‌توانید عبارت جستجو را تغییر دهید یا همین عبارت را در کل متن کتاب جستجو کنید.</p>
        <div class="toc-empty-actions">
          <button type="button" class="primary-action" data-action="toc-search-in-book">جستجوی «${esc(query.trim())}» در متن کتاب</button>
          <button type="button" class="toc-clear-btn" data-action="clear-toc-search">پاک‌کردن جستجو</button>
        </div>
      </div>
    `;
  }

  const groupsMarkup = filteredGroups.map(({ group: g, items }) => {
    const isOpen = isSearching || expandedGroups.has(g.id);
    const hasActiveItem = g.id === active.groupId;
    const countUnit = g.countUnit || 'مورد';

    const itemsMarkup = items.map(item => {
      const isCurrent = (item.id === active.itemId);
      const badgeMarkup = item.badge ? `<span class="toc-item-badge">${esc(item.badge)}</span>` : '';
      const currentIndicator = isCurrent
        ? '<span class="toc-current-tag">در حال مطالعه</span>'
        : '';

      return `
        <li class="toc-item-wrapper">
          <button type="button" class="toc-item ${isCurrent ? 'is-current' : ''}" data-action="outline-page" data-page="${item.page}" data-group="${g.id}" data-id="${item.id}" ${isCurrent ? 'aria-current="location"' : ''}>
            ${badgeMarkup}
            <span class="toc-item-title">${esc(item.title)}</span>
            ${currentIndicator}
          </button>
        </li>
      `;
    }).join('');

    const collapsedActiveTag = (hasActiveItem && !isOpen)
      ? '<span class="toc-group-active-pill" title="شامل بخش در حال مطالعه">در حال مطالعه</span>'
      : '';
    const groupBadgeMarkup = g.badge ? `<span class="toc-group-badge">${esc(g.badge)}</span>` : '';

    return `
      <section class="toc-group ${isOpen ? 'is-open' : 'is-collapsed'}" data-group="${g.id}">
        <h4 class="toc-group-heading">
          <button type="button" class="toc-group-trigger ${hasActiveItem ? 'has-active' : ''}" data-action="toc-group" data-group="${g.id}" aria-expanded="${isOpen}" aria-controls="toc-panel-${g.id}">
            <span class="toc-group-main">
              ${groupBadgeMarkup}
              <span class="toc-group-title">${esc(g.title)}</span>
            </span>
            ${collapsedActiveTag}
            <span class="toc-group-count">${digits(items.length)} ${countUnit}</span>
            <span class="toc-group-chevron" aria-hidden="true">${icon('chevron')}</span>
          </button>
        </h4>
        <ul id="toc-panel-${g.id}" class="toc-items" role="list" ${isOpen ? '' : 'hidden'}>
          ${itemsMarkup}
        </ul>
      </section>
    `;
  }).join('');

  const searchStatusMarkup = isSearching
    ? `<div class="toc-search-status" role="status"><span>${digits(totalMatches)} مورد یافت شد</span></div>`
    : '';

  return `
    <nav class="toc-body" aria-label="سرفصل‌های کتاب">
      ${searchStatusMarkup}
      <div class="toc-groups">
        ${groupsMarkup}
      </div>
    </nav>
  `;
}
