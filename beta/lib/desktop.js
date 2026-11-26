/* Field Tools — desktop layout switch.
   On screens 1024px and wider, adds class "ftd" to <html> so lib/desktop.css can lay pages out for a
   big screen. Phones are unaffected. A page picks its layout with data-ftd on <html>:
     (none)  centred column (default width 1080px, or data-ftd-width)
     split   list/controls on the left, map fixed on the right (Station / Offset, Station Photos)
     wide    full width                                                                         */
(function () {
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(min-width: 1024px)') : { matches: false };
  function apply() {
    var on = !!mq.matches;
    root.classList.toggle('ftd', on);
    var w = /^(wide|split)$/.test(root.getAttribute('data-ftd') || '') ? 1e9 : (+root.getAttribute('data-ftd-width') || 1080);
    root.style.setProperty('--ftd-pad', Math.max(0, Math.floor((root.clientWidth - w) / 2)) + 'px');
    var nav = document.querySelector('.top-nav:not(.hidden)');
    if (nav && nav.offsetHeight) root.style.setProperty('--ftd-top', nav.offsetHeight + 'px');
  }
  window.ftIsDesktop = function () { return !!mq.matches; };
  apply();
  window.addEventListener('resize', apply);
  document.addEventListener('DOMContentLoaded', apply);
  var was = !!mq.matches;
  function changed() {
    apply();
    if (was !== !!mq.matches) { was = !!mq.matches; window.dispatchEvent(new Event('ftdesktopchange')); }
  }
  if (mq.addEventListener) mq.addEventListener('change', changed); else if (mq.addListener) mq.addListener(changed);
})();
