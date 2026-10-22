/* global briskPages */
'use strict';
// Applies this profile's color to Brisk's own pages.
(function () {
  if (typeof briskPages === 'undefined') return;
  const apply = () =>
    briskPages.profiles().then((r) => {
      const p = r.profiles.find((x) => x.id === r.current);
      if (p) document.documentElement.style.setProperty('--profile', p.color);
    });
  apply();
  briskPages.onChanged((kind) => kind === 'profiles' && apply());
})();
