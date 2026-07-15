// Heckle loader, the single injected script. Served by the daemon at /heckle.js as a
// classic script so it can run anywhere. It loads rrweb (UMD global) then dynamically
// imports the ES-module widget entry (served type-stripped by the daemon).
(function () {
  "use strict";
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : window.location.origin;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("failed to load " + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  loadScript(origin + "/heckle/vendor/rrweb.js")
    .catch(function () {
      // capture still works without rrweb (console + network only)
    })
    .then(function () {
      return import(origin + "/heckle/index.js");
    })
    .then(function (mod) {
      if (mod && typeof mod.start === "function") mod.start(origin);
    })
    .catch(function (err) {
      console.error("[heckle] failed to start widget", err);
    });
})();
