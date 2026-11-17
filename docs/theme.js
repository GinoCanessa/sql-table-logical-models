(() => {
  "use strict";
  const root = document.documentElement;
  const key = `dev-explore:theme:${root.dataset.themeKey}`;
  const choices = new Set(["system", "light", "dark"]);
  let preference = "system";
  let message = "";
  let storage = null;

  function unavailable(error) {
    message = "Appearance applies to this page, but your preference could not be saved or loaded.";
    console.warn("Documentation theme storage is unavailable.", error);
  }

  try {
    storage = window.localStorage;
    const saved = storage.getItem(key);
    if (saved !== null && !choices.has(saved)) {
      message = "An unrecognized saved appearance was ignored. Choose it again.";
      console.warn("Unrecognized documentation appearance.");
    } else if (saved !== null) preference = saved;
  } catch (error) {
    unavailable(error);
  }
  root.dataset.theme = preference;

  function initialize() {
    const control = document.getElementById("theme-control");
    const selector = document.getElementById("theme-choice");
    const status = document.getElementById("theme-status");

    function showStatus() {
      status.textContent = message;
      status.hidden = !message;
    }

    function apply(value) {
      preference = value;
      root.dataset.theme = value;
      selector.value = value;
    }

    apply(preference);
    control.hidden = false;
    showStatus();
    selector.addEventListener("change", () => {
      if (!choices.has(selector.value)) {
        console.error("Unrecognized documentation appearance.");
        selector.value = preference;
        return;
      }
      apply(selector.value);
      try {
        storage = window.localStorage;
        storage.setItem(key, preference);
        message = "";
      } catch (error) {
        unavailable(error);
      }
      showStatus();
    });
    window.addEventListener("storage", (event) => {
      if (event.storageArea !== storage || (event.key !== key && event.key !== null)) return;
      const value = event.newValue === null ? "system" : event.newValue;
      if (!choices.has(value)) {
        message = "Another page saved an unrecognized appearance. Choose it again.";
        console.warn("Unrecognized appearance in a storage event.");
        showStatus();
        return;
      }
      apply(value);
      message = "";
      showStatus();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
