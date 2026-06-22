// Shared light/dark theme toggle for the Apollo design system.
// The theme class lives on <html> and is persisted in localStorage.
(function () {
  const STORAGE_KEY = "apollo-theme";
  const SUN = "☀️"; // ☀️ shown while in dark mode (click → go light)
  const MOON = "\u{1F319}";   // 🌙 shown while in light mode (click → go dark)

  function current() {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }

  function apply(theme) {
    const root = document.documentElement;
    root.classList.add("apollo-design");
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme !== "dark");
    localStorage.setItem(STORAGE_KEY, theme);
    // Reflect the next action on every toggle button on the page.
    for (const btn of document.querySelectorAll("[data-theme-toggle], #themeToggle")) {
      btn.textContent = theme === "dark" ? SUN : MOON;
    }
  }

  // Ensure a class is present even if the pre-paint inline script was skipped.
  apply(localStorage.getItem(STORAGE_KEY) || current());

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-toggle], #themeToggle");
    if (!btn) return;
    apply(current() === "dark" ? "light" : "dark");
  });
})();
