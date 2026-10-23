
(function () {
  'use strict';
  window.tpaSite = true;
  var toggle = document.querySelector('.menu-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.hidden = false;
    var setOpen = function (open, focusToggle) {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      if (!open && focusToggle) toggle.focus();
    };
    toggle.addEventListener('click', function () { setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') setOpen(false, true);
    });
    document.addEventListener('click', function (e) {
      if (toggle.getAttribute('aria-expanded') === 'true' && !nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    var mq = window.matchMedia('(min-width: 64rem)');
    var onMq = function () { if (mq.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  var NAMES = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-route-finder]'), function (form) {
    var urls = JSON.parse(form.getAttribute('data-urls'));
    var pairs = JSON.parse(form.getAttribute('data-pairs'));
    var from = form.querySelector('[data-rf-from]');
    var to = form.querySelector('[data-rf-to]');
    var swap = form.querySelector('[data-rf-swap]');
    var error = form.querySelector('[data-rf-error]');
    Array.prototype.forEach.call(to.options, function (o) { NAMES[o.value] = o.textContent; });
    var clearError = function () {
      error.hidden = true;
      error.textContent = '';
      to.removeAttribute('aria-invalid');
    };
    var showError = function (msg) {
      error.textContent = msg;
      error.hidden = false;
      to.setAttribute('aria-invalid', 'true');
      to.focus();
    };
    var fillDestinations = function (preferred) {
      var allowed = pairs[from.value] || [];
      var keep = allowed.indexOf(preferred) !== -1 ? preferred : allowed[0];
      while (to.options.length) to.remove(0);
      allowed.forEach(function (code) {
        var o = document.createElement('option');
        o.value = code;
        o.textContent = NAMES[code] || code;
        if (code === keep) o.selected = true;
        to.appendChild(o);
      });
      clearError();
    };
    fillDestinations(to.value);
    from.addEventListener('change', function () { fillDestinations(to.value); });
    to.addEventListener('change', clearError);
    if (swap) {
      swap.hidden = false;
      swap.addEventListener('click', function () {
        var a = from.value;
        var b = to.value;
        if (!urls[b + '-' + a]) return;
        from.value = b;
        fillDestinations(a);
        swap.setAttribute('aria-label', 'Swap pickup and destination. Now ' + (NAMES[b] || b) + ' to ' + (NAMES[a] || a));
      });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var key = from.value + '-' + to.value;
      if (from.value === to.value) return showError('Choose a destination airport that is different from your pickup airport.');
      if (!urls[key]) return showError('We don’t run a shuttle between those airports. Every route starts or ends at Tampa (TPA).');
      window.location.href = urls[key];
    });
  });
})();
