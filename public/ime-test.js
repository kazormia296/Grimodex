// IME 診断ページの配線。ime-test.html から外部参照される。
// (CSP script-src 'self' のためインライン script は production で動かない)
// ビルド工程を通らない素の JS — ESM/TS 構文は使わない。

(function () {
  "use strict";

  var editor = document.getElementById("editor");
  var logEl = document.getElementById("log");
  var selRect = document.getElementById("sel-rect");
  var statusEl = document.getElementById("status");
  var envEl = document.getElementById("env");
  var toggleBtn = document.getElementById("toggle-mode");

  var MAX_LINES = 400;
  var lines = [];

  function f1(v) {
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  function fmtRect(r) {
    if (!r) return "∅";
    return (
      "(" + f1(r.left) + "," + f1(r.top) + " " +
      f1(r.width) + "×" + f1(r.height) + ")"
    );
  }

  function caretRect() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var r = sel.getRangeAt(0).getBoundingClientRect();
    // composition 初期フレーム等で全ゼロ rect が返る — 取得不能扱い
    if (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0) {
      return null;
    }
    return r;
  }

  function log(msg) {
    var t = (performance.now() / 1000).toFixed(3);
    lines.push(t + " " + msg);
    if (lines.length > MAX_LINES) lines.shift();
    logEl.textContent = lines.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  ["compositionstart", "compositionupdate", "compositionend"].forEach(
    function (type) {
      editor.addEventListener(type, function (e) {
        log(
          type +
            " data=" + JSON.stringify(e.data == null ? null : e.data) +
            " caret=" + fmtRect(caretRect()),
        );
      });
    },
  );

  editor.addEventListener("beforeinput", function (e) {
    log("beforeinput " + e.inputType + " data=" + JSON.stringify(e.data));
  });

  document.addEventListener("selectionchange", function () {
    var r = caretRect();
    if (r) {
      selRect.style.display = "block";
      selRect.style.left = r.left + "px";
      selRect.style.top = r.top + "px";
      selRect.style.width = Math.max(r.width, 2) + "px";
      selRect.style.height = Math.max(r.height, 2) + "px";
    } else {
      selRect.style.display = "none";
    }
    statusEl.textContent =
      "selection rect: " + fmtRect(r) +
      " / editor scroll: (" + editor.scrollLeft + "," + editor.scrollTop + ")" +
      " / screen: (" + window.screenX + "," + window.screenY + ")";
  });

  toggleBtn.addEventListener("click", function () {
    var vertical = editor.classList.toggle("vertical");
    toggleBtn.textContent = vertical ? "横書きに切替" : "縦書きに切替";
    log("writing-mode → " + (vertical ? "vertical-rl" : "horizontal-tb"));
  });

  document.getElementById("clear-log").addEventListener("click", function () {
    lines.length = 0;
    logEl.textContent = "";
  });

  // clipboard API は権限が絡むので「全選択 → ユーザーが Ctrl+C」方式
  document.getElementById("select-log").addEventListener("click", function () {
    var sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    var range = document.createRange();
    range.selectNodeContents(logEl);
    sel.addRange(range);
  });

  envEl.textContent =
    navigator.userAgent +
    " / dpr=" + window.devicePixelRatio +
    " / inner=" + window.innerWidth + "×" + window.innerHeight;

  log("ready — エディタ内をクリックして日本語入力してください");
})();
