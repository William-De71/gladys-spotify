// Renders integration widget contents the way the Gladys front does
// (front/src/components/boxs/external-widget, ExternalWidgetBox +
// WidgetComponents), in plain DOM, with the same slots, order and class
// names. Only the components these widgets use: text, image, card-list (list
// and grid), status, button. Query: ?lang=fr&cards=now_playing,quick_play
/* global DATA */
const params = new URLSearchParams(location.search);
const LANG = params.get('lang') || 'en';
const CARDS = (params.get('cards') || DATA.cards.join(',')).split(',');

const text = (value) =>
  value && typeof value === 'object' ? (value[LANG] ?? value.en ?? '') : (value ?? '');
const formatNumber = (value) =>
  typeof value === 'number'
    ? new Intl.NumberFormat(LANG, { maximumFractionDigits: 2 }).format(value)
    : text(value);
// widgetContentUtils.formatDate ('lll' of dayjs), in a fixed timezone.
const formatDate = (value) =>
  new Intl.DateTimeFormat(LANG, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Paris',
  }).format(new Date(value));
const COLOR = {
  neutral: 'colorNeutral',
  primary: 'colorPrimary',
  success: 'colorSuccess',
  warning: 'colorWarning',
  danger: 'colorDanger',
  info: 'colorInfo',
};
const BADGE_COLOR = {
  primary: 'badgeColorPrimary',
  success: 'badgeColorSuccess',
  warning: 'badgeColorWarning',
  danger: 'badgeColorDanger',
  info: 'badgeColorInfo',
};
const el = (tag, cls, children = []) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const icon = (name, cls = '') => el('i', `fe fe-${name} ${cls}`);

// widgetContentUtils.splitIntoSlots
function splitIntoSlots(components) {
  const slots = { header: [], tiles: [], focal: null, body: null, status: null, buttons: [] };
  for (const c of components) {
    if (c.type === 'text') c.variant === 'body' ? (slots.body = c) : slots.header.push(c);
    else if (c.type === 'value' || c.type === 'gauge') slots.tiles.push(c);
    else if (['chart', 'card-list', 'image'].includes(c.type)) slots.focal = c;
    else if (c.type === 'status') slots.status = c;
    else if (c.type === 'button') slots.buttons.push(c);
  }
  return slots;
}

const header = (components) =>
  el(
    'div',
    'header',
    components.map((c) => el('div', c.variant === 'heading' ? 'heading' : 'caption', text(c.text))),
  );

// LazyWidgetImage, once the image route answered.
function image(key, fit, alt) {
  const img = el('img', fit === 'contain' ? 'imageContain' : 'imageCover');
  img.src = DATA.images[key];
  img.alt = text(alt);
  return el('div', 'imageFrame', img);
}

// WidgetCardList: an item with a description or links is clickable.
const cardList = (component) => {
  const grid = component.display === 'grid';
  return el(
    'div',
    null,
    el(
      'div',
      grid ? 'cardGrid' : 'cardList',
      component.items.map((item) => {
        const clickable = Boolean(item.description) || (item.links && item.links.length > 0);
        const meta = item.date ? formatDate(item.date) : text(item.subtitle);
        const node = el(
          'button',
          `${grid ? 'cardGridItem' : 'cardListItem'} ${clickable ? 'clickable' : ''}`,
          [
            item.image ? image(item.image, 'cover', item.title) : null,
            el('div', 'cardListText', [
              el('span', 'cardTitle', text(item.title)),
              meta ? el('span', 'cardMeta', meta) : null,
              item.badge
                ? el('span', `wbadge ${BADGE_COLOR[item.badge.color] || ''}`, text(item.badge.text))
                : null,
            ]),
          ],
        );
        node.type = 'button';
        node.disabled = !clickable;
        return node;
      }),
    ),
  );
};

const statusList = (component) =>
  el(
    'ul',
    'statusList',
    component.items.map((item) =>
      el('li', 'statusRow', [
        item.icon
          ? icon(item.icon, `statusIcon ${COLOR[item.color || 'neutral']}`)
          : el('span', `statusDot ${COLOR[item.color || 'neutral']}`),
        el('span', 'statusLabel', text(item.label)),
        el('span', 'statusValue', formatNumber(item.value)),
      ]),
    ),
  );

// WidgetButtons: a link shows the domain it opens.
const buttons = (components) =>
  el(
    'div',
    'buttons',
    components.map((c) => {
      const cls = `button ${c.style === 'primary' ? 'buttonPrimary' : ''} ${c.style === 'danger' ? 'buttonDanger' : ''}`;
      if (c.link) {
        return el('a', cls, [
          el('span', 'buttonIcon', icon(c.icon || 'external-link')),
          el('span', 'buttonLabel', text(c.label)),
          el('span', 'buttonDomain', `(${(c.link.url || '').split('/')[2] || ''})`),
        ]);
      }
      const node = el('button', cls, [
        el('span', 'buttonIcon', icon(c.icon || 'play')),
        el('span', 'buttonLabel', text(c.label)),
      ]);
      node.type = 'button';
      return node;
    }),
  );

function card(name) {
  const content = DATA.contents[LANG][name];
  const meta = DATA.cardsMeta[name];
  const slots = splitIntoSlots(content.components);
  const focal = slots.focal;
  return el('div', 'card', [
    el(
      'div',
      'card-header',
      el('h3', 'card-title', [icon(meta.icon || 'grid'), el('span', 'm-1', text(meta.label))]),
    ),
    el(
      'div',
      'card-body',
      el('div', 'slots', [
        slots.header.length ? header(slots.header) : null,
        focal && focal.type === 'card-list' ? cardList(focal) : null,
        focal && focal.type === 'image' ? image(focal.key, focal.fit, focal.alt) : null,
        slots.body ? el('p', 'body', text(slots.body.text)) : null,
        slots.status ? statusList(slots.status) : null,
        slots.buttons.length ? buttons(slots.buttons) : null,
      ]),
    ),
  ]);
}

const row = document.getElementById('row');
for (const name of CARDS) {
  row.append(el('div', 'col', card(name)));
}
document.body.dataset.ready = '1';
