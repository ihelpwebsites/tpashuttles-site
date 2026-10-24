// One-page booking for /book/ (loaded only on that page). The summary updates as the passenger types;
// one submit validates everything (linked error summary), then:
//   request mode — opens a pre-written email to the company (plus copy / call fallbacks). Nothing on this
//                  page claims a booking, payment or confirmation.
//   live mode    — POST {api}/price for the fare, POST {api}/checkout to book, then the backend's paymentUrl
//                  (merchant-hosted) or its confirmation.
// Answers are kept in sessionStorage, so a refresh doesn't lose them.
(function () {
  'use strict';
  var form = document.querySelector('[data-booking-form]');
  if (!form) return;
  var data = function (k) { return JSON.parse(form.getAttribute('data-' + k)); };
  var cfg = data('config'), pairs = data('pairs'), airports = data('airports'), routes = data('routes'), contact = data('contact');
  var KEY = 'tpa-booking-v2';
  var $ = function (sel, root) { return (root || form).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || form).querySelectorAll(sel)); };
  var el = { from: $('#bk-from'), to: $('#bk-to'), summary: $('[data-summary]'), fare: $('[data-fare]'), submit: $('[data-submit-area]'),
    errors: $('[data-error-summary]'), done: document.querySelector('[data-done]'), bar: document.querySelector('[data-bar]'),
    barText: document.querySelector('[data-bar-text]'), side: document.getElementById('bk-review') };

  // ---- dates ---------------------------------------------------------------------------------
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var iso = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var maxDate = new Date(today.getTime() + cfg.days * 864e5);
  $$('[data-date]').forEach(function (i) { i.min = iso(today); i.max = iso(maxDate); });
  var longDate = function (s) {
    if (!s) return '';
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };
  var time12 = function (t) {
    if (!t) return '';
    var p = t.split(':'), h = +p[0];
    return ((h % 12) || 12) + ':' + p[1] + ' ' + (h >= 12 ? 'pm' : 'am');
  };

  // ---- form state ----------------------------------------------------------------------------
  // Text, select and radio-group values (a radio group's RadioNodeList.value is the checked value).
  var val = function (name) { var f = form.elements[name]; return f ? f.value || '' : ''; };
  var num = function (name) { return parseInt(val(name), 10) || 0; };
  var extras = function () { return $$('input[name="extras"]').filter(function (i) { return i.checked; }).map(function (i) { return i.value; }); };
  var round = function () { return val('trip') === 'round'; };
  var routeOf = function (a, b) { return routes.filter(function (r) { return (r.a === a && r.b === b) || (r.a === b && r.b === a); })[0] || null; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  function save() {
    var s = {};
    $$('input, select, textarea').forEach(function (i) {
      if (!i.name || i.name === 'agree') return;
      if (i.type === 'radio') { if (i.checked) s[i.name] = i.value; }
      else if (i.type === 'checkbox') { (s[i.name] = s[i.name] || []); if (i.checked) s[i.name].push(i.value); }
      else s[i.name] = i.value;
    });
    try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
  }
  function restore() {
    var s = null;
    try { s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    var q = new URLSearchParams(location.search);
    if (q.get('from') || q.get('to')) s = Object.assign(s || {}, { from: q.get('from'), to: q.get('to') });
    if (q.get('date')) s = Object.assign(s || {}, { outDate: q.get('date') });
    if (q.get('adults')) s = Object.assign(s || {}, { adults: q.get('adults') });
    if (!s) return;
    if (s.from && pairs[s.from]) el.from.value = s.from;
    fillTo(s.to);
    Object.keys(s).forEach(function (k) {
      if (k === 'from' || k === 'to') return;
      $$('[name="' + k + '"]').forEach(function (i) {
        if (i.type === 'radio') i.checked = i.value === s[k];
        else if (i.type === 'checkbox') i.checked = (s[k] || []).indexOf(i.value) !== -1;
        else if (s[k] != null) i.value = s[k];
      });
    });
    if (extras().length || val('notes')) $('details.bk-more').open = true;
  }

  // ---- route ---------------------------------------------------------------------------------
  function fillTo(preferred) {
    var allowed = pairs[el.from.value] || [];
    var keep = allowed.indexOf(preferred) !== -1 ? preferred : (allowed.indexOf(el.to.value) !== -1 ? el.to.value : allowed[0]);
    while (el.to.options.length) el.to.remove(0);
    allowed.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = airports[c].short + ' (' + c + ')'; o.selected = c === keep; el.to.appendChild(o); });
  }
  el.from.addEventListener('change', function () { fillTo(el.to.value); refresh(); });
  $('[data-swap]').addEventListener('click', function () { var a = el.from.value, b = el.to.value; el.from.value = b; fillTo(a); refresh(); });

  // ---- legs: flight vs pickup time vs fixed departures ------------------------------------------
  function legEnds(key) { return key === 'out' ? [el.from.value, el.to.value] : [el.to.value, el.from.value]; }
  function legSetup(key) {
    var leg = $('[data-leg="' + key + '"]'), ends = legEnds(key), from = ends[0], to = ends[1];
    leg.querySelector('[data-leg-route]').textContent = airports[from].short + ' to ' + airports[to].short;
    var r = routeOf(from, to), deps = r && r.departures ? r.departures[from] : null;
    var flying = val(key + 'Flying') === 'yes';
    leg.querySelector('[data-flight]').hidden = !flying;
    var depBox = leg.querySelector('[data-departures]');
    if (deps && deps.length) {
      depBox.hidden = false;
      leg.querySelector('[data-pickup-time]').hidden = true;
      var list = depBox.querySelector('[data-departure-list]'), current = val(key + 'Dep');
      list.innerHTML = '';
      deps.forEach(function (t) {
        var l = document.createElement('label'); l.className = 'bk-pill';
        var i = document.createElement('input'); i.type = 'radio'; i.name = key + 'Dep'; i.value = t; i.checked = t === current;
        l.appendChild(i); l.appendChild(document.createTextNode(' ' + t)); list.appendChild(l);
      });
      leg.querySelector('[data-time-hint]').textContent = flying ? 'Choose a departure that leaves time to collect your bags after landing.' : 'Choose your departure.';
    } else {
      depBox.hidden = true;
      leg.querySelector('[data-pickup-time]').hidden = flying;
      leg.querySelector('[data-time-hint]').textContent = flying ? 'We match your pickup to your flight and confirm the departure time with you.' : 'We confirm the nearest departure to your preferred time.';
    }
  }
  var timer = null;
  function refresh() {
    $('[data-leg="ret"]').hidden = !round();
    legSetup('out');
    if (round()) legSetup('ret');
    save();
    clearTimeout(timer);
    timer = setTimeout(summary, 80);
  }
  form.addEventListener('change', refresh);
  form.addEventListener('input', function () { save(); clearTimeout(timer); timer = setTimeout(summary, 150); });

  // ---- small conveniences: flight numbers in capitals, US phone numbers formatted -----------------
  $$('input[name$="Flight"]').forEach(function (i) {
    i.addEventListener('input', function () { var p = i.selectionStart; i.value = i.value.toUpperCase(); try { i.setSelectionRange(p, p); } catch (e) { /* not a text input */ } });
  });
  form.elements.phone.addEventListener('blur', function () {
    var d = this.value.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) this.value = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  });

  // ---- counters --------------------------------------------------------------------------------
  $$('.bk-stepper').forEach(function (s) {
    var input = s.querySelector('input');
    s.querySelectorAll('[data-step]').forEach(function (b) {
      b.hidden = false;
      b.addEventListener('click', function () {
        input.value = Math.max(+input.min, Math.min(+input.max, (parseInt(input.value, 10) || 0) + parseInt(b.getAttribute('data-step'), 10)));
        refresh();
      });
    });
  });

  // ---- summary & fare ----------------------------------------------------------------------------
  function legInfo(key) {
    var ends = legEnds(key), from = ends[0], to = ends[1];
    var flying = val(key + 'Flying') === 'yes', dep = val(key + 'Dep');
    var t = dep ? 'Departure ' + dep : flying ? (val(key + 'Land') ? 'Landing ' + time12(val(key + 'Land')) + (val(key + 'Flight') || val(key + 'Airline') ? ' · ' + [val(key + 'Airline'), val(key + 'Flight')].filter(Boolean).join(' ') : '') : '') : (val(key + 'Time') ? 'Pickup around ' + time12(val(key + 'Time')) : '');
    return { from: from, to: to, route: airports[from].short + ' (' + from + ') to ' + airports[to].short + ' (' + to + ')', date: longDate(val(key + 'Date')), when: t, pickup: airports[from].pickup, guide: airports[from].guide };
  }
  function people() {
    var a = num('adults'), c = num('carSeats');
    return a + ' passenger' + (a === 1 ? '' : 's') + (c ? ' (' + c + ' with a car seat)' : '') + ' · ' + num('bags') + ' checked, ' + num('carryOns') + ' carry-on';
  }
  function localFare() {
    var r = routeOf(el.from.value, el.to.value);
    if (!r || !r.fare) return null;
    var a = num('adults'), one = null;
    if (r.fare.model === 'perParty' && r.fare.table) one = r.fare.table[String(a)];
    if (r.fare.model === 'perPerson' && r.fare.amount) one = r.fare.amount * a;
    if (one == null) return null;
    return { total: one * (round() ? 2 : 1), legs: round() ? 2 : 1, each: one };
  }
  function legHtml(label, info) {
    return '<div class="bk-sum-leg"><p class="bk-sum-label">' + esc(label) + '</p><p class="bk-sum-route">' + esc(info.route) + '</p>' +
      '<p class="bk-sum-meta">' + esc([info.date || 'Choose a date', info.when].filter(Boolean).join(' · ')) + '</p></div>';
  }
  var priceKey = '';
  function summary() {
    var o = legInfo('out');
    var h = legHtml('Going', o);
    if (round()) h += legHtml('Return', legInfo('ret'));
    h += '<p class="bk-sum-line">' + esc(people()) + '</p>';
    if (extras().length) h += '<p class="bk-sum-line">' + esc('Also: ' + extras().join(', ')) + '</p>';
    if (o.pickup) h += '<p class="bk-meet">Meet at ' + esc(airports[o.from].short) + ': <strong>' + esc(o.pickup) + '</strong> · <a href="' + o.guide + '">guide</a></p>';
    el.summary.innerHTML = h;
    if (el.barText) el.barText.textContent = o.from + ' to ' + o.to + (o.date ? ' · ' + o.date.replace(/, \d{4}$/, '') : '') + ' · ' + num('adults') + ' pax';
    if (cfg.mode === 'live') {
      var k = JSON.stringify([el.from.value, el.to.value, val('trip'), val('outDate'), val('retDate'), num('adults'), num('bags'), val('outDep'), val('retDep')]);
      if (k !== priceKey && val('outDate')) { priceKey = k; livePrice(); }
      else if (!val('outDate')) el.fare.innerHTML = '<p class="bk-fare-total">Choose a date to see your fare.</p>';
    } else {
      var f = localFare();
      el.fare.innerHTML = f
        ? '<p class="bk-fare-total"><span>Estimated fare</span><strong>$' + f.total.toFixed(2) + '</strong></p><p class="bk-sub">' + (f.legs === 2 ? '$' + f.each.toFixed(2) + ' each way. ' : '') + 'We confirm the final fare before you pay.</p>'
        : '<p class="bk-fare-total"><span>Fare</span><strong>Confirmed by our team</strong></p><p class="bk-sub">We confirm your fare before you pay. Nothing is charged on this website.</p>';
    }
  }
  el.submit.innerHTML = cfg.mode === 'live'
    ? '<button type="submit" class="btn btn-primary btn-block">Continue to secure payment' + (cfg.merchant ? ' (' + esc(cfg.merchant) + ')' : '') + '</button>'
    : '<button type="submit" class="btn btn-primary btn-block">Send booking request</button><p class="bk-sub">Opens your email app with everything filled in — just press Send. We reply to confirm your seat, departure time and fare.</p>';

  // ---- validation ------------------------------------------------------------------------------
  function legErrors(key, label) {
    var errs = [], d = val(key + 'Date'), dateEl = form.elements[key + 'Date'];
    if (!d) errs.push([dateEl, 'Choose the ' + label + ' date.']);
    else if (d < iso(today)) errs.push([dateEl, 'The ' + label + ' date is in the past.']);
    else if (d > iso(maxDate)) errs.push([dateEl, 'That ' + label + ' date is too far ahead to book online — please call us.']);
    var leg = $('[data-leg="' + key + '"]'), depBox = leg.querySelector('[data-departures]');
    var flying = val(key + 'Flying') === 'yes', t = '';
    if (!depBox.hidden) { if (!val(key + 'Dep')) errs.push([depBox.querySelector('input'), 'Choose a departure for the ' + label + ' trip.']); }
    else if (flying) { t = val(key + 'Land'); if (!t) errs.push([form.elements[key + 'Land'], 'Enter your scheduled landing time for the ' + label + ' trip.']); }
    else { t = val(key + 'Time'); if (!t) errs.push([form.elements[key + 'Time'], 'Choose a preferred pickup time for the ' + label + ' trip.']); }
    if (d && t && d === iso(new Date())) {
      var p = t.split(':'), when = new Date(); when.setHours(+p[0], +p[1], 0, 0);
      if (when.getTime() - Date.now() < 3 * 3600e3) errs.push([form.elements[key + (flying ? 'Land' : 'Time')], 'That’s less than 3 hours away — please call ' + contact.phone + ' to book a same-day ride.']);
    }
    return errs;
  }
  function allErrors() {
    var e = [];
    if (!el.to.value || el.to.value === el.from.value || (pairs[el.from.value] || []).indexOf(el.to.value) === -1) e.push([el.to, 'Choose a destination we serve from ' + airports[el.from.value].short + '.']);
    e = e.concat(legErrors('out', 'going'));
    if (round()) {
      e = e.concat(legErrors('ret', 'return'));
      if (val('retDate') && val('outDate') && val('retDate') < val('outDate')) e.push([form.elements.retDate, 'The return date must be on or after the going date.']);
    }
    var a = num('adults'), c = num('carSeats');
    if (a < 1 || a > cfg.max) e.push([form.elements.adults, 'Passengers must be between 1 and ' + cfg.max + '. For larger groups, please call us.']);
    if (c < 0 || c >= a) e.push([form.elements.carSeats, 'Children needing a seat must be fewer than the total passengers (at least one adult travels).']);
    if (num('bags') < 0 || num('carryOns') < 0) e.push([form.elements.bags, 'Bag counts can’t be negative.']);
    if (!val('first').trim()) e.push([form.elements.first, 'Enter your first name.']);
    if (!val('last').trim()) e.push([form.elements.last, 'Enter your last name.']);
    if (val('phone').replace(/\D/g, '').length < 10) e.push([form.elements.phone, 'Enter a mobile number with area code.']);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email').trim())) e.push([form.elements.email, 'Enter a valid email address.']);
    if (!form.elements.agree.checked) e.push([form.elements.agree, 'Please confirm you’ve read the passenger policies.']);
    return e;
  }
  function showErrors(errs) {
    $$('[aria-invalid]').forEach(function (i) { i.removeAttribute('aria-invalid'); });
    $$('.bk-error-msg').forEach(function (m) { m.remove(); });
    if (!errs.length) { el.errors.hidden = true; el.errors.innerHTML = ''; return true; }
    el.errors.innerHTML = '<h2>There ' + (errs.length === 1 ? 'is 1 thing' : 'are ' + errs.length + ' things') + ' to fix</h2><ul></ul>';
    var ul = el.errors.querySelector('ul');
    errs.forEach(function (pair, i) {
      var input = pair[0], msg = pair[1];
      if (!input) return;
      if (!input.id) input.id = 'bk-err-' + i;
      input.setAttribute('aria-invalid', 'true');
      var m = document.createElement('span'); m.className = 'bk-error-msg'; m.id = input.id + '-err'; m.textContent = msg;
      (input.closest('.bk-field, .bk-counter, .bk-check, .bk-submit') || input.parentNode).appendChild(m);
      var desc = (input.getAttribute('aria-describedby') || '').split(' ').filter(function (x) { return x && x.slice(-4) !== '-err'; });
      desc.push(m.id); input.setAttribute('aria-describedby', desc.join(' '));
      var li = document.createElement('li'), a = document.createElement('a');
      a.href = '#' + input.id; a.textContent = msg;
      a.addEventListener('click', function (ev) { ev.preventDefault(); input.focus(); input.scrollIntoView({ block: 'center' }); });
      li.appendChild(a); ul.appendChild(li);
    });
    el.errors.hidden = false;
    el.errors.scrollIntoView({ block: 'start' });
    el.errors.focus({ preventScroll: true });
    return false;
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (showErrors(allErrors())) finish();
  });

  // ---- finish (request mode) ---------------------------------------------------------------------
  function requestText() {
    var t = 'Hello TPA Shuttles,\n\nI would like to book the following shuttle:\n\n', o = legInfo('out');
    t += 'Going: ' + o.route + ' · ' + o.date + ' · ' + o.when + '\n';
    if (round()) { var r = legInfo('ret'); t += 'Return: ' + r.route + ' · ' + r.date + ' · ' + r.when + '\n'; }
    t += 'Passengers: ' + num('adults') + (num('carSeats') ? ' (including ' + num('carSeats') + ' child' + (num('carSeats') > 1 ? 'ren' : '') + ' needing a car seat — we will bring it)' : '') + '\n';
    t += 'Bags: ' + num('bags') + ' checked, ' + num('carryOns') + ' carry-on\n';
    if (extras().length) t += 'Also bringing: ' + extras().join(', ') + '\n';
    if (val('notes').trim()) t += 'Notes: ' + val('notes').trim() + '\n';
    t += 'Contact: ' + val('first').trim() + ' ' + val('last').trim() + ' · ' + val('phone').trim() + ' · ' + val('email').trim() + '\n';
    t += '\nPlease confirm my seat, the departure time and the fare.\n\nThank you,\n' + val('first').trim() + ' ' + val('last').trim();
    return t;
  }
  function finish() {
    if (cfg.mode === 'live') return liveCheckout();
    var o = legInfo('out');
    var subject = 'Booking request: ' + el.from.value + ' to ' + el.to.value + ', ' + o.date + (round() ? ' (round trip)' : '');
    var body = requestText();
    var mail = 'mailto:' + contact.email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    window.location.href = mail;
    el.done.innerHTML = '<p class="eyebrow">Almost done</p><h2>Press Send in your email app</h2>' +
      '<p>Your email app should have opened with your booking request to <strong>' + esc(contact.email) + '</strong>. Once you send it, we reply to confirm your seat, departure time and fare. Your ride isn’t booked until we confirm it.</p>' +
      '<div class="cta-row"><a class="btn btn-primary" href="' + esc(mail) + '">Open email again</a><button type="button" class="btn btn-secondary" data-copy>Copy booking details</button><a class="btn btn-secondary" href="tel:' + contact.tel + '">Call ' + esc(contact.phone) + '</a></div>' +
      '<p class="bk-sub" data-copy-status role="status"></p><pre class="bk-request">' + esc(body) + '</pre>';
    el.done.hidden = false; form.hidden = true; if (el.bar) el.bar.hidden = true;
    el.done.querySelector('[data-copy]').addEventListener('click', function () {
      var status = el.done.querySelector('[data-copy-status]');
      var ok = function () { status.textContent = 'Copied. Paste it into an email to ' + contact.email + '.'; };
      if (navigator.clipboard) navigator.clipboard.writeText('To: ' + contact.email + '\nSubject: ' + subject + '\n\n' + body).then(ok, function () { status.textContent = 'Copy failed — select the text below instead.'; });
      else status.textContent = 'Select the text below to copy it.';
    });
    el.done.scrollIntoView({ block: 'start' });
    el.done.focus({ preventScroll: true });
  }

  // ---- live mode (backend + merchant) -----------------------------------------------------------
  function payload() {
    var leg = function (k) { var e = legEnds(k); return { from: e[0], to: e[1], date: val(k + 'Date'), departure: val(k + 'Dep') || null, flying: val(k + 'Flying') === 'yes', airline: val(k + 'Airline') || null, flight: val(k + 'Flight') || null, landing: val(k + 'Land') || null, preferredTime: val(k + 'Time') || null }; };
    return { trip: round() ? 'round' : 'oneway', legs: round() ? [leg('out'), leg('ret')] : [leg('out')],
      passengers: num('adults'), carSeats: num('carSeats'), bags: num('bags'), carryOns: num('carryOns'), extras: extras(), notes: val('notes').trim(),
      contact: { first: val('first').trim(), last: val('last').trim(), phone: val('phone').trim(), email: val('email').trim() } };
  }
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
  function api(path, body) {
    return fetch(cfg.api + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); });
  }
  function livePrice() {
    el.fare.innerHTML = '<p class="bk-fare-total"><span>Fare</span><strong>Checking…</strong></p>';
    api('/price', payload()).then(function (p) {
      if (!p.available) { el.fare.innerHTML = '<p class="bk-fare-total">' + esc(p.message || 'That departure isn’t available. Please choose another time or call us.') + '</p>'; return; }
      el.fare.innerHTML = '<dl class="bk-fare-lines">' + (p.lines || []).map(function (l) { return '<div><dt>' + esc(l.label) + '</dt><dd>' + esc(l.amount) + '</dd></div>'; }).join('') + '</dl><p class="bk-fare-total"><span>Total</span><strong>' + esc(p.total) + '</strong></p>';
    }).catch(function (e) { el.fare.innerHTML = '<p class="bk-fare-total">' + esc((e && e.message) || 'We couldn’t check the fare just now.') + ' Call ' + esc(contact.phone) + ' to book.</p>'; });
  }
  function liveCheckout() {
    var btn = el.submit.querySelector('button'); btn.disabled = true; btn.textContent = 'Starting secure payment…';
    api('/checkout', Object.assign(payload(), { consents: { policies: true } })).then(function (r) {
      if (r.paymentUrl) { window.location.href = r.paymentUrl; return; }
      el.done.innerHTML = '<h2>' + esc(r.title || 'Booking received') + '</h2><p>' + esc(r.message || '') + '</p>';
      el.done.hidden = false; form.hidden = true; if (el.bar) el.bar.hidden = true; el.done.focus();
      try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Try again';
      showErrors([[btn, (e && e.message) || 'Something went wrong. Nothing was charged. Please try again or call ' + contact.phone + '.']]);
    });
  }

  // ---- phone review bar: visible while the summary card is off screen (below 64rem) --------------
  if (el.bar && 'IntersectionObserver' in window) {
    var mq = window.matchMedia('(max-width: 63.99rem)');
    var sideVisible = false;
    var sync = function () { el.bar.hidden = !mq.matches || sideVisible || form.hidden; };
    new IntersectionObserver(function (es) { sideVisible = es[0].isIntersecting; sync(); }).observe(el.side);
    if (mq.addEventListener) mq.addEventListener('change', sync);
    el.bar.querySelector('[data-bar-go]').addEventListener('click', function (e) { e.preventDefault(); el.side.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  // ---- start -----------------------------------------------------------------------------------
  fillTo(el.to.value);   // destinations valid for the default pickup, even with nothing saved or prefilled
  restore();
  refresh();
  clearTimeout(timer);   // refresh() scheduled a summary; render it once, now
  summary();
})();
