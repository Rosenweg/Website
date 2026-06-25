// pwa-install-hint.js — geteilt über alle PWA-Seiten.
// iOS kann eine Web-App NUR aus der echten Safari "Zum Home-Bildschirm" hinzufügen.
// In-App-Browsern (WhatsApp/Mail/Instagram …) und Chrome/Firefox-iOS fehlt das —
// dort gibt es nur ein 3-Punkte-/Menü mit "In Safari öffnen". Wird hier erkannt und
// ein klarer Hinweis + "Link kopieren" eingeblendet.
(function () {
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  if (!isIOS) return; // Android/Desktop: eigene Install-Logik greift

  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  if (standalone) return; // schon als App gestartet

  // Echte Safari: "Safari" + "Version/" und KEINE Dritt-/In-App-Tokens.
  var inApp = /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|Pinterest|GSA|DuckDuckGo/i.test(ua);
  var realSafari = /Safari/.test(ua) && /Version\//.test(ua) && !inApp;
  if (realSafari) return; // echte Safari → normale "Teilen → Zum Home-Bildschirm"-Anleitung passt

  try { if (sessionStorage.getItem('pwaSafariHintDismissed')) return; } catch (e) {}

  function inject() {
    var bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1d4ed8;color:#fff;' +
      'padding:10px 12px;font:14px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);' +
      'display:flex;gap:10px;align-items:flex-start';
    bar.innerHTML =
      '<span style="font-size:18px;flex:0 0 auto">📲</span>' +
      '<div style="flex:1 1 auto">' +
        '<div>Du bist im <strong>In-App-Browser</strong> (z.B. WhatsApp/Mail) — hier lässt sich die App <strong>nicht</strong> installieren.</div>' +
        '<div style="margin-top:4px">Oben/unten auf das <strong>⋯-Menü</strong> tippen → <strong>„In Safari öffnen"</strong>. Dort dann Teilen-Symbol → „Zum Home-Bildschirm".</div>' +
        '<button id="pwaCopyLink" style="margin-top:8px;background:#fff;color:#1d4ed8;border:0;border-radius:6px;padding:6px 11px;font-weight:600;cursor:pointer;font-size:13px">🔗 Link kopieren (in Safari einfügen)</button>' +
      '</div>' +
      '<button id="pwaHintClose" aria-label="Hinweis schließen" style="flex:0 0 auto;background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px">&times;</button>';

    bar.querySelector('#pwaHintClose').addEventListener('click', function () {
      bar.remove();
      document.body.style.paddingTop = '';
      try { sessionStorage.setItem('pwaSafariHintDismissed', '1'); } catch (e) {}
    });
    bar.querySelector('#pwaCopyLink').addEventListener('click', function () {
      var btn = this;
      var done = function () { btn.textContent = '✓ Kopiert — jetzt in Safari einfügen'; };
      try {
        navigator.clipboard.writeText(location.href).then(done, function () {
          window.prompt('Link kopieren und in Safari öffnen:', location.href);
        });
      } catch (e) {
        window.prompt('Link kopieren und in Safari öffnen:', location.href);
      }
    });

    document.body.appendChild(bar);
    document.body.style.paddingTop = bar.offsetHeight + 'px';
  }

  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();
