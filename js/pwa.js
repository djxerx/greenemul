// Offline support and update checks (see sw.js), modelled on the video poker
// app's, adapted for a game made of many files.
//
// 1. Register the service worker. Once it is in control, hand it the list of
//    every same-origin file this page actually loaded (page, stylesheet, each
//    ES module...) so it can keep a copy of all of them for offline play.
// 2. iOS keeps home-screen apps resident for days, so a page that is never
//    relaunched would never see a new build. Whenever the app comes to the
//    foreground, regains connectivity, or every 30 minutes, compare each
//    file's version tag (ETag, else Last-Modified) with the one it launched
//    with, by HEAD request -- a few hundred bytes each, and HEAD bypasses the
//    service worker, so it always asks the live server. Offline, the checks
//    simply fail quietly.
// 3. If anything changed, show a slim "New version available -- tap to update"
//    bar; one tap reloads into the new build.

const CHECK_EVERY_MS = 30 * 60 * 1000;
const SKIP = [];                             // (nothing live on this server)

// every same-origin file the page has loaded so far
function loadedFiles() {
  const out = new Set([location.pathname === "/" ? "/index.html" : location.pathname]);
  for (const e of performance.getEntriesByType("resource")) {
    let u;
    try { u = new URL(e.name); } catch { continue; }
    if (u.origin !== location.origin || SKIP.includes(u.pathname)) continue;
    out.add(u.pathname);
  }
  return [...out];
}

// ---------------------------------------------------------------- versions
let baseline = null;                         // path -> version tag at launch
let bannerShown = false;

async function versionsOf(paths) {
  const tags = {};
  await Promise.all(paths.map(async (p) => {
    try {
      const res = await fetch(p, { method: "HEAD", cache: "no-store" });
      if (!res.ok) return;
      const tag = res.headers.get("etag") || res.headers.get("last-modified");
      if (tag) tags[p] = tag;
    } catch { /* offline */ }
  }));
  return tags;
}

async function checkForUpdate() {
  if (navigator.onLine === false || bannerShown) return;
  const paths = loadedFiles();
  const now = await versionsOf(paths);
  if (!Object.keys(now).length) return;      // could not reach the server
  if (!baseline) { baseline = now; return; }
  // a changed tag, or a file that appeared since launch, is a new build
  for (const p of Object.keys(now)) {
    if (baseline[p] === undefined) baseline[p] = now[p];
    else if (baseline[p] !== now[p]) { showUpdateBanner(); return; }
  }
}

function showUpdateBanner() {
  if (bannerShown) return;
  bannerShown = true;
  const bar = document.createElement("div");
  bar.id = "update-bar";
  bar.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:20000",
    "display:flex", "align-items:center", "justify-content:center", "gap:14px",
    "padding:10px 14px", "padding-top:calc(10px + env(safe-area-inset-top, 0px))",
    "background:#01230a", "border-bottom:2px solid #20ff40",
    "font-family:'Courier New', monospace", "font-size:14px", "font-weight:bold",
    "color:#20ff40", "letter-spacing:1px", "cursor:pointer",
    "box-shadow:0 4px 18px rgba(0,0,0,0.6)",
  ].join(";");
  const msg = document.createElement("span");
  msg.textContent = "New version available — tap to update";
  const dismiss = document.createElement("span");
  dismiss.textContent = "✕";
  dismiss.style.cssText = "opacity:.6;padding:0 6px;font-size:16px;";
  dismiss.addEventListener("click", (e) => { e.stopPropagation(); bar.remove(); });
  bar.append(msg, dismiss);
  bar.addEventListener("click", () => location.reload());   // network-first: the new build
  document.body.appendChild(bar);
}

// ---------------------------------------------------------------- register
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // hand the worker the file list as soon as it controls this page (on a
      // first visit that is right after it activates)
      const sendList = () => {
        const sw = navigator.serviceWorker.controller || reg.active;
        if (sw) sw.postMessage({ t: "cache", urls: loadedFiles() });
      };
      if (navigator.serviceWorker.controller) sendList();
      navigator.serviceWorker.addEventListener("controllerchange", sendList);
      navigator.serviceWorker.ready.then(sendList);
      // ...and make sure it got them all: the first visit's handoff can lose
      // one, and a single missing file (a code module, a ROM) breaks the app
      // offline. Look in the cache directly and re-send what is missing.
      const verify = async (round = 0) => {
        await new Promise(r => setTimeout(r, 4000));
        if (!("caches" in window) || navigator.onLine === false) return;
        const missing = [];
        for (const p of loadedFiles()) if (!(await caches.match(p))) missing.push(p);
        const sw = navigator.serviceWorker.controller || reg.active;
        if (missing.length && sw && round < 3) {
          sw.postMessage({ t: "cache", urls: missing });
          verify(round + 1);
        }
      };
      verify();

      const check = () => { reg.update().catch(() => {}); checkForUpdate(); };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      addEventListener("online", check);
      setInterval(check, CHECK_EVERY_MS);
      checkForUpdate();                      // record this launch's versions
    }).catch((err) => console.warn("service worker registration failed:", err));
  });
}

// (testing) force a check now
window.__checkForUpdate = checkForUpdate;
