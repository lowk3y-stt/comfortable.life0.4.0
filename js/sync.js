/* Comfortable life — синхронизация семьи.
   Общее (заметки и события с пометкой «семейное», устройства, сценарии) шифруется на телефоне
   ключом семьи (AES-GCM) и лежит на сервере. Ключ семьи выдаёт сервер участникам семьи.
   Слияние по меткам времени: у каждой записи своя метка, побеждает более поздняя; удаления помнятся.
   Вход в аккаунт и семьи: js/account.js. */
(function () {
  'use strict';
  var CL = (window.CL = window.CL || {});
  var S = CL.store;
  var COLS = ['notes', 'events'];
  var status = { state: 'idle', error: '' };
  var listeners = [];
  var running = false, again = false, applying = false, timer = null, poll = null, lastMe = 0;

  function t(k, v) { return CL.i18n.t(k, v); }
  function st() { return S.get(); }
  /* вошли в аккаунт */
  function acct() { var s = st(); return s && s.sync && s.sync.token ? s.sync : null; }
  /* вошли и состоим в семье: только тогда данные синхронизируются */
  function cfg() { var a = acct(); return a && a.fid ? a : null; }
  function serverUrl() {
    var s = st(), u = s && s.sync && s.sync.url;
    return u || (window.CL_CONFIG && window.CL_CONFIG.serverUrl) || '';
  }

  /* ---------- кодирование ---------- */
  function b64(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function hex(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }

  function canon(o) {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
    return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(o[k]); }).join(',') + '}';
  }
  function hash(o) {
    var s = canon(o), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  /* ---------- шифрование ---------- */
  function aesKey(keyB64) { return crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']); }
  function encrypt(obj, key) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))).then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  function decrypt(box, key) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct)).then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }
  /* пароль никогда не уходит на сервер: отправляется только результат PBKDF2 */
  function passHash(email, password) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']).then(function (base) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('cl-pw:' + String(email).trim().toLowerCase()), iterations: 200000, hash: 'SHA-256' }, base, 256);
    }).then(hex);
  }

  /* ---------- связь с сервером ---------- */
  function call(body, ms) {
    var url = serverUrl();
    if (!url) return Promise.reject({ error: 'nourl' });
    var s = st(), a = s && s.sync;
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 25000);
    var payload = Object.assign({}, a && a.token ? { aid: a.aid, token: a.token } : {}, body);
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
      body: JSON.stringify(payload), signal: ctl ? ctl.signal : undefined
    }).then(function (r) { clearTimeout(to); return r.json(); }, function (e) { clearTimeout(to); throw e; }).then(function (r) {
      if (r && r.error === 'session' && acct()) { signedOutLocally(); }
      return r;
    });
  }
  /* запросы к данным семьи */
  function api(body) {
    var sy = cfg(); if (!sy) return Promise.reject({ error: 'off' });
    return call(Object.assign({ fid: sy.fid }, body));
  }
  /* сервер больше не признаёт вход: выходим на этом телефоне */
  function signedOutLocally() {
    var s = st(); if (!s || !s.sync) return;
    var url = s.sync.url;
    s.sync = url ? { url: url } : {};
    s.devices = s.devices.filter(function (d) { return d.src !== 'yandex'; }); delete s.yaPick;
    stop(); setStatus('idle');
    S.save();
    if (CL.ui) CL.ui.toast(t('acc.err.session'));
  }

  /* ---------- что синхронизируется ---------- */
  function isShared(col, it) { return !!it.shared; }
  function strip(it) { return JSON.parse(JSON.stringify(it)); }
  function sharedItems() {
    var out = {};
    COLS.forEach(function (col) { st()[col].forEach(function (it) { if (isShared(col, it)) out[col + ':' + it.id] = it; }); });
    return out;
  }
  function stampLocal(sy) {
    var now = Date.now(), cur = sharedItems();
    sy.stamps = sy.stamps || {}; sy.tomb = sy.tomb || {};
    Object.keys(cur).forEach(function (k) {
      var h = hash(strip(cur[k])), e = sy.stamps[k];
      if (!e || e.h !== h) sy.stamps[k] = { h: h, u: now };
    });
    Object.keys(sy.stamps).forEach(function (k) {
      if (!cur[k]) { sy.tomb[k] = now; delete sy.stamps[k]; }
    });
    return cur;
  }
  function merge(cur, sy, remote) {
    var items = {}, tomb = {};
    Object.keys(cur).forEach(function (k) { items[k] = { u: sy.stamps[k].u, d: strip(cur[k]) }; });
    var ri = remote.items || {};
    Object.keys(ri).forEach(function (k) { if (!items[k] || ri[k].u > items[k].u) items[k] = ri[k]; });
    [sy.tomb || {}, remote.tomb || {}].forEach(function (m) { Object.keys(m).forEach(function (k) { tomb[k] = Math.max(tomb[k] || 0, m[k]); }); });
    var cut = Date.now() - 90 * 86400000;
    Object.keys(tomb).forEach(function (k) {
      if (items[k] && items[k].u < tomb[k]) delete items[k];
      if (tomb[k] < cut) delete tomb[k];
    });
    return { items: items, tomb: tomb };
  }
  function snapshot() {
    var cur = sharedItems();
    return canon(Object.keys(cur).map(function (k) { return [k, strip(cur[k])]; }));
  }
  function apply(sy, m) {
    var s = st(), before = snapshot();
    COLS.forEach(function (col) {
      var mine = s[col].filter(function (it) { return !isShared(col, it); });
      var list = [];
      Object.keys(m.items).forEach(function (k) { if (k.indexOf(col + ':') === 0) list.push(JSON.parse(JSON.stringify(m.items[k].d))); });
      s[col] = mine.concat(list);
    });
    sy.stamps = {};
    Object.keys(m.items).forEach(function (k) { sy.stamps[k] = { h: hash(m.items[k].d), u: m.items[k].u }; });
    sy.tomb = m.tomb;
    return before !== snapshot();
  }

  /* ---------- один цикл: получить, слить, при необходимости отправить ---------- */
  function cycle(tries) {
    var sy = cfg();
    return api({ op: 'get' }).then(function (r) {
      if (!r.ok) throw r;
      sy.key = r.key; sy.rev = r.rev;
      return aesKey(r.key).then(function (key) {
        var p = r.ct ? decrypt({ iv: r.iv, ct: r.ct }, key) : Promise.resolve(null);
        return p.then(function (rem) {
          var remote = { items: (rem && rem.items) || {}, tomb: (rem && rem.tomb) || {} };
          var cur = stampLocal(sy);
          var m = merge(cur, sy, remote);
          var changed = apply(sy, m);
          var out = { items: m.items, tomb: m.tomb };
          var push = canon(out) !== canon(remote);
          var done = function () {
            if (changed) { applying = true; try { S.save(); } finally { applying = false; } } else S.flush();
          };
          if (!push) { done(); return; }
          return encrypt({ v: 1, items: out.items, tomb: out.tomb }, key).then(function (box) {
            return api({ op: 'put', rev: r.rev, iv: box.iv, ct: box.ct }).then(function (pr) {
              if (pr.ok) { sy.rev = pr.rev; done(); return; }
              if (pr.error === 'conflict' && tries < 3) return cycle(tries + 1);
              throw pr;
            });
          });
        });
      });
    });
  }

  function setStatus(state, error) {
    status.state = state; status.error = error || '';
    listeners.forEach(function (f) { try { f(status); } catch (e) {} });
  }
  function message(e) {
    if (!e) return t('sync.err.net');
    if (e.code === 'url') return t('sync.err.url');
    if (e.code === 'crypto') return t('sync.err.crypto');
    if (e.code && /^(email|password|mismatch|self|profile|birth|gender)$/.test(e.code)) return t('acc.err.' + e.code);
    var known = /^(email|taken|login|locked|code|wait|mailquota|notfound|member|session|self|limit|owner|noinvite|auth|exists|profile|birth|gender|badcode|infam|noai|aiquota|noyandex)$/;
    if (e.error === 'nourl') return t('sync.err.url');
    if (e.error === 'yandex') return t('ya.err');
    if (known.test(e.error || '')) return t('acc.err.' + e.error);
    if (e.error === 'server') return t('sync.err.server', { m: e.message || '' });
    if (e.error) return t('sync.err.server', { m: e.error });
    if (e.name === 'OperationError') return t('acc.err.auth');
    return t('sync.err.net');
  }

  var PING_FAMILY = 8000, PING_ALONE = 20000;
  function run() {
    if (!cfg() || !st()) return Promise.resolve();
    if (running) { again = true; return Promise.resolve(); }
    running = true; setStatus('busy');
    return cycle(0).then(function () {
      if (cfg()) cfg().last = Date.now();
      setStatus('ok');
    }, function (e) { setStatus('error', message(e)); }).then(function () {
      running = false;
      if (st()) S.flush();
      if (again) { again = false; schedule(500); }
    });
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(run, ms); }

  /* ---------- подключение семьи к этому телефону ---------- */
  /* joining = true: телефон входит в уже существующую семью, его старые записи уступают общим */
  function attachFamily(fid, joining) {
    var sy = acct(); if (!sy) return;
    sy.fid = fid; sy.key = ''; sy.tomb = {}; sy.stamps = {}; sy.last = 0;
    if (joining) {
      var cur = sharedItems();
      Object.keys(cur).forEach(function (k) { sy.stamps[k] = { h: hash(strip(cur[k])), u: 0 }; });
    }
  }
  /* телефон покидает семью: чужие общие записи убираем, свои остаются у вас */
  function detachFamily() {
    var sy = acct(); if (!sy) return;
    var me = sy.aid, s = st();
    ['fid', 'key', 'stamps', 'tomb', 'last', 'fam'].forEach(function (k) { delete sy[k]; });
    ['notes', 'events'].forEach(function (col) {
      s[col] = s[col].filter(function (it) { return !(it.shared && it.by && it.by !== me); });
    });
  }

  function start() {
    stop();
    if (!acct()) return;
    var go = function () {
      if (!acct()) return Promise.resolve();
      return (CL.account ? CL.account.refresh(true) : Promise.resolve()).then(function () { return run(); });
    };
    go();
    /* быстрый опрос: дешёвый запрос «изменилась ли версия?», полная синхронизация только если да */
    var lastPing = 0;
    poll = setInterval(function () {
      if (document.hidden || !acct()) return;
      var sy = cfg(), now = Date.now();
      var every = sy && sy.fam && sy.fam.members && sy.fam.members.length > 1 ? PING_FAMILY : PING_ALONE;
      if (sy && !running && now - lastPing >= every - 500) {
        lastPing = now;
        api({ op: 'rev' }).then(function (r) { if (r.ok && cfg() && r.rev !== cfg().rev) run(); }, function () {});
      }
      var gap = sy ? 300000 : 120000;
      if (CL.account && now - (CL.account.lastRefresh || 0) > gap) CL.account.refresh(true);
    }, 1000);
  }
  function stop() { clearInterval(poll); clearTimeout(timer); poll = null; timer = null; }

  S.subscribe(function () { if (!applying && cfg()) schedule(800); });
  document.addEventListener('visibilitychange', function () {
    if (!st() || !acct()) return;
    if (cfg()) run();
    if (CL.account && !document.hidden && Date.now() - (CL.account.lastRefresh || 0) > 60000) CL.account.refresh(true);
  });

  CL.sync = {
    acct: acct, cfg: cfg, call: call, api: api, serverUrl: serverUrl, message: message, passHash: passHash,
    attachFamily: attachFamily, detachFamily: detachFamily, signedOutLocally: signedOutLocally,
    start: start, stop: stop, run: run,
    status: function () { return status; },
    notify: function () { listeners.forEach(function (f) { try { f(status); } catch (e) {} }); },
    onChange: function (f) { listeners.push(f); },
    URL_OK: /^(https:\/\/script\.google(usercontent)?\.com\/.+\/exec|http:\/\/localhost:\d+\/.*)$/
  };
})();
