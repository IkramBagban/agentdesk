// Set the theme before first paint so there is no flash (external file: CSP forbids inline scripts).
try {
  var p = localStorage.getItem('agentdesk-theme');
  var dark = p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
