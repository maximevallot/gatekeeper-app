// Runs before the page draws, so it never flashes the wrong theme. Light unless the user chose otherwise in
// Settings → Appearance; "system" follows the Mac. Kept in this browser's storage for Gatekeeper's pages.
(function () {
  var choice = "light";
  try { choice = localStorage.getItem("gk-appearance") || "light"; } catch (e) {}
  var dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
