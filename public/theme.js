// Antes de pintar, para que no parpadee. Va aparte porque la CSP no deja correr scripts dentro del HTML.
try {
  var t = localStorage.getItem('pasalo.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
