/**
 * 左メニュー（サイドバー）の縮小 / 展開トグル。
 * 状態は localStorage に保存する。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "json2html.sidebar.collapsed";

  function init() {
    var sidebar = document.getElementById("sidebar");
    var button = document.getElementById("sidebar-toggle");
    if (!sidebar || !button) {
      return;
    }

    var icon = button.querySelector(".sidebar-toggle-icon");
    var label = button.querySelector(".sidebar-toggle-label");

    function apply(collapsed) {
      if (collapsed) {
        sidebar.classList.add("is-collapsed");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("title", "メニューを展開");
        button.setAttribute("aria-label", "メニューを展開");
        if (icon) {
          icon.textContent = "»";
        }
        if (label) {
          label.textContent = "展開";
        }
      } else {
        sidebar.classList.remove("is-collapsed");
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("title", "メニューを縮小");
        button.setAttribute("aria-label", "メニューを縮小");
        if (icon) {
          icon.textContent = "«";
        }
        if (label) {
          label.textContent = "メニュー";
        }
      }
    }

    function isCollapsed() {
      return sidebar.classList.contains("is-collapsed");
    }

    function setCollapsed(collapsed) {
      apply(collapsed);
      try {
        localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
      } catch (e) {
        /* ignore quota / private mode */
      }
    }

    var saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      saved = null;
    }
    apply(saved === "1");

    button.addEventListener("click", function () {
      setCollapsed(!isCollapsed());
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
