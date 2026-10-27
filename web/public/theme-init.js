// Set the theme before first paint to avoid a flash of the wrong theme.
// (A separate file rather than an inline script, so the Content-Security-Policy can forbid inline scripts.)
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("omnipilot-theme");
  } catch (e) {}
  var theme = stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
