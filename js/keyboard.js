/* Comfortable life — собственная экранная клавиатура (русский и английский).
   Системная клавиатура телефона не появляется: у полей ввода ставится inputmode="none",
   а текст вводится нажатиями на клавиши ниже. Поля с датой и временем остаются системными.
   Включена на сенсорных экранах; в Настройках её можно выключить (например, для голосового ввода). */
(function () {
  'use strict';
  var CL = (window.CL = window.CL || {});

  var ROWS = {
    ru: ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'],
    en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
  };
  var SYM = ['1234567890', '-/:;()₽&@"', ".,?!'%+=#"];
  var TEXT_TYPES = ['', 'text', 'search', 'email', 'password', 'tel', 'url'];

  var kb = null, target = null, layout = null, layer = 'abc', shift = 'off', lastShift = 0, hideTimer = null, repeat = null;

  function meta() { return CL.store && CL.store.meta ? CL.store.meta() : {}; }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  /* по умолчанию — только на сенсорных экранах; пользователь может включить или выключить */
  function enabled() { var v = meta().vkb; return v === true || (v !== false && coarse()); }

  function eligible(el) {
    if (!el || el.disabled || el.readOnly || (el.hasAttribute && el.hasAttribute('data-native'))) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXT_TYPES.indexOf((el.getAttribute('type') || '').toLowerCase()) > -1;
  }
  /* убираем системную клавиатуру; цифровые поля помечаем, чтобы показать цифровую панель */
  function prepare(el) {
    if (!eligible(el)) return;
    var im = el.getAttribute('inputmode');
    if (im && im !== 'none' && /^(numeric|decimal|tel)$/.test(im) && !el.getAttribute('data-kb')) el.setAttribute('data-kb', 'num');
    if (im !== 'none') el.setAttribute('inputmode', 'none');
  }
  function scan(root) {
    if (!enabled()) return;
    var list = root.querySelectorAll ? root.querySelectorAll('input, textarea') : [];
    Array.prototype.forEach.call(list, prepare);
    if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') prepare(root);
  }

  /* ---------- вставка текста ---------- */
  function hasSel(el) { try { return typeof el.selectionStart === 'number'; } catch (e) { return false; } }
  function fire(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }
  function put(el, str) {
    var s = hasSel(el) ? el.selectionStart : el.value.length, e = hasSel(el) ? el.selectionEnd : s;
    if (el.maxLength > 0 && el.value.length - (e - s) + str.length > el.maxLength) return;
    if (hasSel(el)) el.setRangeText(str, s, e, 'end'); else el.value += str;
    fire(el);
  }
  function back(el) {
    if (hasSel(el)) {
      var s = el.selectionStart, e = el.selectionEnd;
      if (s !== e) el.setRangeText('', s, e, 'end');
      else if (s > 0) el.setRangeText('', s - 1, s, 'end');
      else return;
    } else el.value = el.value.slice(0, -1);
    fire(el);
  }
  function before(el) { return hasSel(el) ? el.value.slice(0, el.selectionStart) : el.value; }

  /* первая буква предложения — заглавная (не для почты и паролей) */
  function autoShift() {
    if (!target || layer !== 'abc' || shift === 'lock') return;
    var type = (target.getAttribute('type') || 'text').toLowerCase();
    if (target.tagName !== 'TEXTAREA' && type !== 'text' && type !== 'search') { shift = 'off'; return; }
    var b = before(target);
    shift = (!b.trim() || /[.!?]\s+$/.test(b) || /\n$/.test(b)) ? 'once' : 'off';
  }

  /* ---------- клавиши ---------- */
  function key(label, cls, act, aria) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'k ' + (cls || ''); b.tabIndex = -1;
    if (aria) b.setAttribute('aria-label', aria);
    b.textContent = label;
    b._act = act;
    return b;
  }
  function row(cls, keys) { var r = document.createElement('div'); r.className = 'kr ' + (cls || ''); keys.forEach(function (k) { r.appendChild(k); }); return r; }
  function letter(ch) {
    var show = (shift !== 'off' && layer === 'abc') ? ch.toUpperCase() : ch;
    return key(show, '', function () { put(target, show); if (shift === 'once') shift = 'off'; if (shift === 'off') autoShift(); build(); });
  }
  function sym(ch) { return key(ch, '', function () { put(target, ch); }); }

  function build() {
    if (!kb) return;
    kb.textContent = '';
    var num = target && target.getAttribute('data-kb') === 'num';
    var type = target ? (target.getAttribute('type') || '').toLowerCase() : '';
    var t = CL.i18n.t;

    var done = key('⌄', 'k-fn', function () { if (target) target.blur(); hide(); }, t('kb.hide'));
    var del = key('⌫', 'k-fn k-del', function () { back(target); autoShift(); build(); }, t('kb.backspace'));
    del._repeat = true;

    if (num) {
      kb.appendChild(row('num', ['1', '2', '3'].map(sym)));
      kb.appendChild(row('num', ['4', '5', '6'].map(sym)));
      kb.appendChild(row('num', ['7', '8', '9'].map(sym)));
      kb.appendChild(row('num', [sym('.'), sym('0'), del]));
      kb.appendChild(row('num', [done, key(t('kb.ok'), 'k-go', function () { enter(); })]));
      return;
    }

    if (layer === 'sym') {
      kb.appendChild(row('', SYM[0].split('').map(sym)));
      kb.appendChild(row('', SYM[1].split('').map(sym)));
      kb.appendChild(row('', SYM[2].split('').map(sym).concat([del])));
    } else {
      var rows = ROWS[layout];
      kb.appendChild(row('', rows[0].split('').map(letter)));
      kb.appendChild(row('r2', rows[1].split('').map(letter)));
      var sh = key(shift === 'lock' ? '⇪' : '⇧', 'k-fn' + (shift !== 'off' ? ' on' : ''), function () {
        var now = Date.now();
        shift = (shift === 'off') ? 'once' : (shift === 'once' && now - lastShift < 500) ? 'lock' : 'off';
        lastShift = now; build();
      }, t('kb.shift'));
      kb.appendChild(row('', [sh].concat(rows[2].split('').map(letter), [del])));
    }
    var left = type === 'email' ? '@' : ',';
    kb.appendChild(row('bottom', [
      key(layer === 'abc' ? '123' : 'АБВ', 'k-fn', function () { layer = layer === 'abc' ? 'sym' : 'abc'; build(); }, t('kb.symbols')),
      key(layout === 'ru' ? 'RU' : 'EN', 'k-fn', function () { layout = layout === 'ru' ? 'en' : 'ru'; layer = 'abc'; autoShift(); build(); }, t('kb.language')),
      sym(left),
      key('', 'k-space', function () { put(target, ' '); autoShift(); build(); }, t('kb.space')),
      sym('.'),
      key('⏎', 'k-go', function () { enter(); }, t('kb.enter')),
      done
    ]));
  }

  function enter() {
    if (!target) return;
    if (target.tagName === 'TEXTAREA') { put(target, '\n'); autoShift(); build(); return; }
    var form = target.form;
    if (form) { if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
    else { target.blur(); hide(); }
  }

  /* ---------- показать и спрятать ---------- */
  function host() { return document.querySelector('dialog[open]') || document.body; }
  function setHeight() {
    document.documentElement.style.setProperty('--kb-h', (kb && !kb.hidden ? kb.offsetHeight : 0) + 'px');
  }
  function ensure() {
    if (kb) return;
    kb = document.createElement('div');
    kb.className = 'vkb'; kb.hidden = true; kb.setAttribute('role', 'group'); kb.setAttribute('aria-label', CL.i18n.t('kb.title'));
    function down(e) {
      var b = e.target.closest && e.target.closest('.k');
      e.preventDefault();                       // фокус остаётся в поле
      if (!b || !b._act || !target) return;
      clearInterval(repeat); clearTimeout(repeat);
      b._act();
      if (b._repeat) repeat = setTimeout(function () { repeat = setInterval(function () { if (target) { back(target); } }, 70); }, 420);
    }
    function up() { clearInterval(repeat); clearTimeout(repeat); }
    kb.addEventListener('pointerdown', down);
    kb.addEventListener('mousedown', function (e) { e.preventDefault(); });
    kb.addEventListener('pointerup', up); kb.addEventListener('pointercancel', up); kb.addEventListener('pointerleave', up);
  }
  function show(el) {
    if (!enabled() || !eligible(el)) return;
    clearTimeout(hideTimer);
    ensure();
    target = el;
    if (!layout) layout = CL.i18n.getLang() === 'en' ? 'en' : 'ru';
    var num = el.getAttribute('data-kb') === 'num';
    if (!num) layer = 'abc';
    shift = 'off'; autoShift();
    build();
    var hst = host();
    if (kb.parentNode !== hst) hst.appendChild(kb);
    kb.hidden = false;
    document.body.classList.add('kb-open');
    setHeight();
    requestAnimationFrame(function () {
      setHeight();
      try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
    });
  }
  function hide() {
    clearTimeout(hideTimer);
    if (!kb) return;
    kb.hidden = true; target = null;
    if (kb.parentNode !== document.body) document.body.appendChild(kb);
    document.body.classList.remove('kb-open');
    setHeight();
  }

  document.addEventListener('focusin', function (e) {
    if (!enabled()) return;
    prepare(e.target);
    if (eligible(e.target)) show(e.target);
  });
  document.addEventListener('focusout', function () {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      var a = document.activeElement;
      if (a && eligible(a)) return;
      hide();
    }, 120);
  });
  /* окно закрылось или поле исчезло — прячем клавиатуру */
  var mo = new MutationObserver(function (list) {
    list.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) scan(n); }); });
    if (kb && !kb.hidden && target && !document.contains(target)) hide();
  });
  function start() {
    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('hashchange', hide);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  CL.kbd = {
    enabled: enabled, hide: hide,
    /* переключатель из Настроек: true / false */
    set: function (on) {
      meta().vkb = !!on; CL.store.saveMeta();
      if (on) scan(document.body);
      else { hide(); Array.prototype.forEach.call(document.querySelectorAll('input[inputmode="none"], textarea[inputmode="none"]'), function (el) { if (el.getAttribute('data-kb')) el.setAttribute('inputmode', 'decimal'); else el.removeAttribute('inputmode'); }); }
    }
  };
})();
