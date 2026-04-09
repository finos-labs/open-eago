// Mobile nav toggle
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var header = document.querySelector('.site-header');
  if (!toggle || !header) return;

  toggle.addEventListener('click', function () {
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    header.classList.toggle('nav-open', !expanded);
  });

  // Close nav when a link is clicked
  document.querySelectorAll('.main-nav a').forEach(function (link) {
    link.addEventListener('click', function () {
      toggle.setAttribute('aria-expanded', 'false');
      header.classList.remove('nav-open');
    });
  });
})();
