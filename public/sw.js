// KairFlow service worker: shows alerts when no tab is open (Web Push) and opens the app when tapped.
// It caches nothing and never touches app requests, so it cannot serve stale pages.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function parsePush(event) {
  try { return event.data ? event.data.json() : {}; } catch (e) {
    try { return { body: event.data.text() }; } catch (e2) { return {}; }
  }
}

function sameSitePath(value) {
  var url = String(value || "/");
  return url.charAt(0) === "/" && url.charAt(1) !== "/" ? url : "/";
}

self.addEventListener("push", function (event) {
  var data = parsePush(event);
  var title = String(data.title || "KairFlow").slice(0, 120);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
    // A visible, focused tab already shows the alert in the page (with the chosen tone): do not double up.
    var focused = windows.some(function (w) { return w.visibilityState === "visible" && w.focused; });
    if (focused) { windows.forEach(function (w) { w.postMessage({ type: "kf-push", data: data }); }); return undefined; }
    var tag = data.tag ? String(data.tag).slice(0, 80) : undefined;
    return self.registration.showNotification(title, {
      body: String(data.body || "").slice(0, 240),
      tag: tag,
      renotify: Boolean(tag),
      icon: data.icon || "/icon-512.png",
      badge: "/favicon-32.png",
      silent: false, // let the device play its own notification sound; a service worker cannot play custom audio
      data: { url: sameSitePath(data.url) },
    });
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = new URL(sameSitePath(event.notification.data && event.notification.data.url), self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (new URL(w.url).origin !== target.origin) continue;
      var samePage = new URL(w.url).pathname + new URL(w.url).search === target.pathname + target.search;
      var focus = w.focus();
      // The staff app is one page, so just focus it; a portal link may need to navigate.
      return samePage || target.search === "" ? focus : focus.then(function (c) { return c && c.navigate ? c.navigate(target.href) : c; });
    }
    return self.clients.openWindow(target.href);
  }));
});
