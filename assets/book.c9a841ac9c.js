// Booking flow for /book/ (loaded only on that page). Four steps in one form; progress is kept in
// sessionStorage so a refresh or Back doesn't lose anything. Modes come from the page's data-config:
//   request — the final step opens a pre-written email to the company (or a call); nothing is called
//             booked, paid or confirmed by this page.
//   live    — POST {api}/price for the fare, POST {api}/checkout to create the booking, then follow the
//             backend's paymentUrl (merchant-hosted) or show its confirmation.
(function () {
  'use strict';
  var form = document.querySelector('[data-booking-form]');
  if (!form) return;
  var data = function (k) { return JSON.parse(form.getAttribute('data-' + k)); };
  var cfg = data('config'), pairs = data('pairs'), airports = data('airports'), routes = data('routes'), contact = data('contact');
  var KEY = 'tpa-booking-v1';
  var step = 1, total = 4;
  var $ = function (sel, root) { return (root || form).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || form).querySelectorAll(sel)); };
  var el = { from: $('#bk-from'), to: $('#bk-to'), summary: $('[data-summary]'), fare: $('[data-fare]'), submit: $('[data-submit-area]'),
    back: $('[data-back]'), next: $('[data-next]'), errors: $('[data-error-summary]'), done: document.querySelector('[data-done]') };

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
    var p = t.split(':'), h = +p[0], ap = h >= 12 ? 'pm' : 'am';
    return ((h % 12) || 12) + ':' + p[1] + ' ' + ap;
  };

  // ---- form state ----------------------------------------------------------------------------
  // Text, select and radio-group values (a radio group's RadioNodeList.value is the checked value).
  var val = function (name) { var f = form.elements[name]; return f ? f.value || '' : ''; };
  var num = function (name) { return parseInt(val(name), 10) || 0; };
  var extras = function () { return $$('input[name="extras"]').filter(function (i) { return i.checked; }).map(function (i) { return i.value; }); };
  var round = function () { return val('trip') === 'round'; };
  var routeOf = function (a, b) { return routes.filter(function (r) { return (r.a === a && r.b === b) || (r.a === b && r.b === a); })[0] || null; };

  function save() {
    var s = {};
    $$('input, select, textarea').forEach(function (i) {
      if (!i.name || i.name === 'agree') return;
      if (i.type === 'radio') { if (i.checked) s[i.name] = i.value; }
      else if (i.type === 'checkbox') { (s[i.name] = s[i.name] || []); if (i.checked) s[i.name].push(i.value); }
      else s[i.name] = i.value;
    });
    s._step = step;
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
      if (k === 'from' || k === 'to' || k[0] === '_') return;
      $$('[name="' + k + '"]').forEach(function (i) {
        if (i.type === 'radio') i.checked = i.value === s[k];
        else if (i.type === 'checkbox') i.checked = (s[k] || []).indexOf(i.value) !== -1;
        else if (s[k] != null) i.value = s[k];
      });
    });
  }

  // ---- route ---------------------------------------------------------------------------------
  function fillTo(preferred) {
    var allowed = pairs[el.from.value] || [];
    var keep = allowed.indexOf(preferred) !== -1 ? preferred : (allowed.indexOf(el.to.value) !== -1 ? el.to.value : allowed[0]);
    while (el.to.options.length) el.to.remove(0);
    allowed.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = airports[c].short + ' (' + c + ')'; o.selected = c === keep; el.to.appendChild(o); });
  }
  el.from.addEventListener('change', function () { fillTo(el.to.value); refresh(); });
  el.to.addEventListener('change', refresh);
  $('[data-swap]').addEventListener('click', function () {
    var a = el.from.value, b = el.to.value;
    el.from.value = b; fillTo(a); refresh();
  });

  // ---- legs: flight vs pickup time vs fixed departures ------------------------------------------
  function legSetup(key) {
    var leg = $('[data-leg="' + key + '"]');
    var from = key === 'out' ? el.from.value : el.to.value, to = key === 'out' ? el.to.value : el.from.value;
    leg.querySelector('[data-leg-route]').textContent = airports[from].short + ' (' + from + ') to ' + airports[to].short + ' (' + to + ')';
    var r = routeOf(from, to), deps = r && r.departures ? r.departures[from] : null;
    var flying = val(key + 'Flying') === 'yes';
    leg.querySelector('[data-flight]').hidden = !flying;
    var depBox = leg.querySelector('[data-departures]');
    if (deps && deps.length) {
      depBox.hidden = false;
      leg.querySelector('[data-pickup-time]').hidden = true;
      var list = depBox.querySelector('[data-departure-list]');
      var current = val(key + 'Dep');
      list.innerHTML = '';
      deps.forEach(function (t) {
        var l = document.createElement('label'); l.className = 'bk-pill';
        var i = document.createElement('input'); i.type = 'radio'; i.name = key + 'Dep'; i.value = t; i.checked = t === current;
        l.appendChild(i); l.appendChild(document.createTextNode(' ' + t)); list.appendChild(l);
      });
      leg.querySelector('[data-time-hint]').textContent = flying ? 'Choose a departure that leaves you time to collect your bags after landing.' : 'Choose your departure.';
    } else {
      depBox.hidden = true;
      leg.querySelector('[data-pickup-time]').hidden = flying;
      leg.querySelector('[data-time-hint]').textContent = flying ? 'We’ll match your pickup to your flight and confirm the departure time with you.' : 'We’ll confirm the nearest departure to your preferred time.';
    }
  }
  function refresh() {
    $('[data-leg="ret"]').hidden = !round();
    legSetup('out');
    if (round()) legSetup('ret');
    save();
  }
  form.addEventListener('change', function (e) { if (/Flying$|^trip$/.test(e.target.name)) refresh(); else save(); });
  form.addEventListener('input', save);

  // ---- counters --------------------------------------------------------------------------------
  $$('.bk-stepper').forEach(function (s) {
    var input = s.querySelector('input');
    s.querySelectorAll('[data-step]').forEach(function (b) {
      b.hidden = false;
      b.addEventListener('click', function () {
        var v = (parseInt(input.value, 10) || 0) + parseInt(b.getAttribute('data-step'), 10);
        input.value = Math.max(+input.min, Math.min(+input.max, v));
        save();
      });
    });
  });

  // ---- validation ------------------------------------------------------------------------------
  function legErrors(key, label) {
    var errs = [], d = val(key + 'Date');
    var dateEl = form.elements[key + 'Date'];
    if (!d) errs.push([dateEl, 'Choose the ' + label + ' date.']);
    else if (d < iso(today)) errs.push([dateEl, 'The ' + label + ' date is in the past.']);
    else if (d > iso(maxDate)) errs.push([dateEl, 'We can’t take bookings that far ahead yet — please call us.']);
    var leg = $('[data-leg="' + key + '"]');
    var depBox = leg.querySelector('[data-departures]');
    var flying = val(key + 'Flying') === 'yes';
    var t = '';
    if (!depBox.hidden) { if (!val(key + 'Dep')) errs.push([depBox.querySelector('input'), 'Choose a departure for the ' + label + ' trip.']); }
    else if (flying) { t = val(key + 'Land'); if (!t) errs.push([form.elements[key + 'Land'], 'Enter your scheduled landing time for the ' + label + ' trip.']); }
    else { t = val(key + 'Time'); if (!t) errs.push([form.elements[key + 'Time'], 'Choose a preferred pickup time for the ' + label + ' trip.']); }
    if (d && t && d === iso(new Date())) {
      var p = t.split(':'), when = new Date(); when.setHours(+p[0], +p[1], 0, 0);
      if (when.getTime() - Date.now() < 3 * 3600e3) errs.push([form.elements[key + (flying ? 'Land' : 'Time')], 'That’s less than 3 hours away — please call ' + contact.phone + ' to book a same-day ride.']);
    }
    return errs;
  }
  function errorsFor(n) {
    var e = [];
    if (n === 1) {
      if (!el.to.value || el.to.value === el.from.value || (pairs[el.from.value] || []).indexOf(el.to.value) === -1) e.push([el.to, 'Choose a destination we serve from ' + airports[el.from.value].short + '.']);
      e = e.concat(legErrors('out', 'going'));
      if (round()) {
        e = e.concat(legErrors('ret', 'return'));
        if (val('retDate') && val('outDate') && val('retDate') < val('outDate')) e.push([form.elements.retDate, 'The return date must be on or after the going date.']);
      }
    }
    if (n === 2) {
      var a = num('adults'), c = num('carSeats');
      if (a < 1 || a > cfg.max) e.push([form.elements.adults, 'Passengers must be between 1 and ' + cfg.max + '. For larger groups, please call us.']);
      if (c < 0 || c >= a) e.push([form.elements.carSeats, 'Children needing a seat must be fewer than the total passengers (at least one adult travels).']);
      if (num('bags') < 0 || num('carryOns') < 0) e.push([form.elements.bags, 'Bag counts can’t be negative.']);
    }
    if (n === 3) {
      if (!val('first').trim()) e.push([form.elements.first, 'Enter your first name.']);
      if (!val('last').trim()) e.push([form.elements.last, 'Enter your last name.']);
      if (val('phone').replace(/\D/g, '').length < 10) e.push([form.elements.phone, 'Enter a mobile number with area code.']);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email').trim())) e.push([form.elements.email, 'Enter a valid email address.']);
    }
    if (n === 4 && !form.elements.agree.checked) e.push([form.elements.agree, 'Please confirm you’ve read the passenger policies.']);
    return e;
  }
  function showErrors(errs) {
    $$('[aria-invalid]').forEach(function (i) { i.removeAttribute('aria-invalid'); });
    $$('.bk-error-msg').forEach(function (m) { m.remove(); });
    if (!errs.length) { el.errors.hidden = true; el.errors.innerHTML = ''; return true; }
    el.errors.innerHTML = '<h2>Please fix ' + (errs.length === 1 ? 'this' : 'these ' + errs.length + ' things') + '</h2><ul></ul>';
    var ul = el.errors.querySelector('ul');
    errs.forEach(function (pair, i) {
      var input = pair[0], msg = pair[1];
      if (!input) return;
      if (!input.id) input.id = 'bk-err-' + i;
      input.setAttribute('aria-invalid', 'true');
      var m = document.createElement('span'); m.className = 'bk-error-msg'; m.id = input.id + '-err'; m.textContent = msg;
      var host = input.closest('.bk-field, .bk-counter, .bk-check, .bk-departures') || input.parentNode;
      host.appendChild(m);
      var desc = (input.getAttribute('aria-describedby') || '').split(' ').filter(function (x) { return x && x.slice(-4) !== '-err'; });
      desc.push(m.id); input.setAttribute('aria-describedby', desc.join(' '));
      var li = document.createElement('li'), a = document.createElement('a');
      a.href = '#' + input.id; a.textContent = msg;
      a.addEventListener('click', function (ev) { ev.preventDefault(); input.focus(); });
      li.appendChild(a); ul.appendChild(li);
    });
    el.errors.hidden = false;
    el.errors.focus();
    return false;
  }

  // ---- steps -----------------------------------------------------------------------------------
  function go(n, push) {
    step = Math.max(1, Math.min(total, n));
    $$('[data-step-panel]').forEach(function (p) { p.hidden = +p.getAttribute('data-step-panel') !== step; });
    $$('[data-progress]').forEach(function (li) {
      var i = +li.getAttribute('data-progress');
      li.classList.toggle('is-done', i < step);
      if (i === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    el.back.hidden = step === 1;
    el.next.hidden = step === total;
    if (step === total) review();
    showErrors([]);
    if (push !== false) history.pushState({ bk: step }, '', '#step-' + step);
    var h = $('[data-step-panel="' + step + '"] h2');
    if (h && push !== false) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); form.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    save();
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!showErrors(errorsFor(step))) return;
    if (step < total) go(step + 1);
    else finish();
  });
  el.back.addEventListener('click', function () { history.back(); });
  window.addEventListener('popstate', function (e) { var s = e.state && e.state.bk; go(s || 1, false); });

  // ---- review & fare ---------------------------------------------------------------------------
  function legText(key) {
    var from = key === 'out' ? el.from.value : el.to.value, to = key === 'out' ? el.to.value : el.from.value;
    var flying = val(key + 'Flying') === 'yes', dep = val(key + 'Dep');
    var when = dep ? 'Departure ' + dep : flying ? 'Landing ' + time12(val(key + 'Land')) + (val(key + 'Airline') || val(key + 'Flight') ? ' on ' + [val(key + 'Airline'), val(key + 'Flight')].filter(Boolean).join(' ') : '') : 'Preferred pickup ' + time12(val(key + 'Time'));
    return { route: airports[from].short + ' (' + from + ') to ' + airports[to].short + ' (' + to + ')', date: longDate(val(key + 'Date')), when: when, pickup: airports[from].pickup, guide: airports[from].guide, from: from };
  }
  function lines() {
    var out = [], o = legText('out');
    out.push(['Going', o.route + ' · ' + o.date + ' · ' + o.when]);
    if (round()) { var r = legText('ret'); out.push(['Return', r.route + ' · ' + r.date + ' · ' + r.when]); }
    out.push(['Passengers', num('adults') + (num('carSeats') ? ' (including ' + num('carSeats') + ' child' + (num('carSeats') > 1 ? 'ren' : '') + ' needing a car seat — bring your own)' : '')]);
    out.push(['Bags', num('bags') + ' checked, ' + num('carryOns') + ' carry-on']);
    if (extras().length) out.push(['Also bringing', extras().join(', ')]);
    if (val('notes').trim()) out.push(['Notes', val('notes').trim()]);
    out.push(['Contact', val('first').trim() + ' ' + val('last').trim() + ' · ' + val('phone').trim() + ' · ' + val('email').trim()]);
    return out;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function localFare() {
    var r = routeOf(el.from.value, el.to.value);
    if (!r || !r.fare) return null;
    var a = num('adults'), one = null;
    if (r.fare.model === 'perParty' && r.fare.table) one = r.fare.table[String(a)];
    if (r.fare.model === 'perPerson' && r.fare.amount) one = r.fare.amount * a;
    if (one == null) return null;
    return { total: one * (round() ? 2 : 1), legs: round() ? 2 : 1, each: one };
  }
  function review() {
    var rows = lines(), o = legText('out');
    el.summary.innerHTML = '<dl>' + rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl>' +
      '<p class="bk-edit"><button type="button" class="text-btn" data-goto="1">Edit trip</button> <button type="button" class="text-btn" data-goto="2">Edit travelers</button> <button type="button" class="text-btn" data-goto="3">Edit contact</button></p>' +
      (o.pickup ? '<p class="bk-meet">Meeting point at ' + esc(airports[o.from].short) + ': <strong>' + esc(o.pickup) + '</strong> — <a href="' + o.guide + '">pickup guide</a>. We’ll confirm it with you.</p>' : '');
    $$('[data-goto]', el.summary).forEach(function (b) { b.addEventListener('click', function () { go(+b.getAttribute('data-goto')); }); });
    var f = localFare();
    if (cfg.mode === 'live') { el.fare.innerHTML = '<p>Checking your fare…</p>'; livePrice(); }
    else if (f) el.fare.innerHTML = '<p class="bk-fare-total">Estimated fare: <strong>$' + f.total.toFixed(2) + '</strong>' + (f.legs === 2 ? ' ($' + f.each.toFixed(2) + ' each way)' : '') + '</p><p class="bk-sub">We confirm the final fare before you pay.</p>';
    else el.fare.innerHTML = '<p class="bk-fare-total"><strong>Fare:</strong> we’ll confirm your fare with you before you pay — nothing is charged on this website.</p>';
    el.submit.innerHTML = cfg.mode === 'live'
      ? '<button type="submit" class="btn btn-primary btn-block">Continue to secure payment' + (cfg.merchant ? ' (' + esc(cfg.merchant) + ')' : '') + '</button>'
      : '<button type="submit" class="btn btn-primary btn-block">Send booking request</button><p class="bk-sub">This opens your email app with everything filled in — just press Send. We’ll reply to confirm your seat, departure time and fare.</p><p class="bk-alt">Or call <a href="tel:' + contact.tel + '">' + esc(contact.phone) + '</a> to book by phone.</p>';
  }

  // ---- finish ----------------------------------------------------------------------------------
  function requestText() {
    var t = 'Hello TPA Shuttles,\n\nI would like to book the following shuttle:\n\n';
    lines().forEach(function (r) { t += r[0] + ': ' + r[1] + '\n'; });
    t += '\nPlease confirm my seat, the departure time and the fare.\n\nThank you,\n' + val('first').trim() + ' ' + val('last').trim();
    return t;
  }
  function finish() {
    if (cfg.mode === 'live') return liveCheckout();
    var o = legText('out');
    var subject = 'Booking request: ' + el.from.value + ' to ' + el.to.value + ', ' + o.date + (round() ? ' (round trip)' : '');
    var body = requestText();
    var mail = 'mailto:' + contact.email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    window.location.href = mail;
    el.done.innerHTML = '<h2>Almost done — send the email</h2>' +
      '<p>Your email app should have opened with your booking request to <strong>' + esc(contact.email) + '</strong>. Press <strong>Send</strong>, and we’ll reply to confirm your seat, departure time and fare. Your ride isn’t booked until we confirm it.</p>' +
      '<p>Email app didn’t open?</p><div class="cta-row"><a class="btn btn-primary" href="' + esc(mail) + '">Open email again</a><button type="button" class="btn btn-secondary" data-copy>Copy booking details</button><a class="btn btn-secondary" href="tel:' + contact.tel + '">Call ' + esc(contact.phone) + '</a></div>' +
      '<p class="bk-sub" data-copy-status role="status"></p><pre class="bk-request">' + esc(body) + '</pre>';
    el.done.hidden = false;
    form.hidden = true;
    el.done.querySelector('[data-copy]').addEventListener('click', function () {
      var status = el.done.querySelector('[data-copy-status]');
      var ok = function () { status.textContent = 'Copied. Paste it into an email to ' + contact.email + '.'; };
      if (navigator.clipboard) navigator.clipboard.writeText('To: ' + contact.email + '\nSubject: ' + subject + '\n\n' + body).then(ok, function () { status.textContent = 'Copy failed — select the text below instead.'; });
      else status.textContent = 'Select the text below to copy it.';
    });
    el.done.focus();
  }

  // ---- live mode (backend + merchant) -----------------------------------------------------------
  function payload() {
    var leg = function (k) { return { from: k === 'out' ? el.from.value : el.to.value, to: k === 'out' ? el.to.value : el.from.value, date: val(k + 'Date'), departure: val(k + 'Dep') || null, flying: val(k + 'Flying') === 'yes', airline: val(k + 'Airline') || null, flight: val(k + 'Flight') || null, landing: val(k + 'Land') || null, preferredTime: val(k + 'Time') || null }; };
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
    api('/price', payload()).then(function (p) {
      if (!p.available) { el.fare.innerHTML = '<p class="bk-fare-total">' + esc(p.message || 'That departure isn’t available. Please choose another time or call us.') + '</p>'; return; }
      el.fare.innerHTML = '<dl class="bk-fare-lines">' + (p.lines || []).map(function (l) { return '<div><dt>' + esc(l.label) + '</dt><dd>' + esc(l.amount) + '</dd></div>'; }).join('') + '</dl><p class="bk-fare-total">Total: <strong>' + esc(p.total) + '</strong></p>';
    }).catch(function (e) { el.fare.innerHTML = '<p class="bk-fare-total">' + esc((e && e.message) || 'We couldn’t check the fare just now.') + ' Call ' + esc(contact.phone) + ' to book.</p>'; });
  }
  function liveCheckout() {
    var btn = el.submit.querySelector('button'); btn.disabled = true; btn.textContent = 'Starting secure payment…';
    api('/checkout', Object.assign(payload(), { consents: { policies: true } })).then(function (r) {
      if (r.paymentUrl) { window.location.href = r.paymentUrl; return; }
      el.done.innerHTML = '<h2>' + esc(r.title || 'Booking received') + '</h2><p>' + esc(r.message || '') + '</p>';
      el.done.hidden = false; form.hidden = true; el.done.focus();
      try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Try again';
      showErrors([[btn, (e && e.message) || 'Something went wrong. Nothing was charged. Please try again or call ' + contact.phone + '.']]);
    });
  }

  // ---- start -----------------------------------------------------------------------------------
  fillTo(el.to.value);   // destinations valid for the default pickup, even with nothing saved or prefilled
  restore();
  refresh();
  // Always begin at step 1 after a (re)load, with saved answers filled in, so every step is re-validated.
  history.replaceState({ bk: 1 }, '', location.pathname + location.search + '#step-1');
  go(1, false);
})();
