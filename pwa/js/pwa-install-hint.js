// pwa-install-hint.js — geteilt über alle PWA-Seiten.
// iOS kann eine Web-App NUR aus der echten Safari "Zum Home-Bildschirm" hinzufügen.
// In-App-Browsern (WhatsApp/Mail/Instagram …) und Chrome/Firefox-iOS fehlt diese Option.
// Erkennt diesen Fall und blendet oben einen klaren "in Safari öffnen"-Hinweis ein.
(function () {
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  if (!isIOS) return; // Android/Desktop: hier kein Thema (eigene Install-Logik greift)

  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  if (standalone) return; // schon als App installiert/gestartet

  // Echte Safari hat "Safari" + "Version/" und KEINE Dritt-/In-App-Tokens.
  var inAppOrThirdParty = /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|Pinterest|GSA|DuckDuckGo/i.test(ua);
  var realSafari = /Safari/.test(ua) && /Version\//.test(ua) && !inAppOrThirdParty;
  if (realSafari) return; // echte Safari → die normale "Zum Home-Bildschirm"-Anleitung passt

  try { if (sessionStorage.getItem('pwaSafariHintDismissed')) return; } catch (e) {}

  function inject() {
    var bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1d4ed8;color:#fff;' +
      'padding:10px 12px;font:14px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);' +
      'display:flex;gap:10px;align-items:flex-start';
    bar.innerHTML =
      '<span style="font-size:18px;flex:0 0 auto">📲</span>' +
      '<div style="flex:1 1 auto">Zum <strong>Installieren als App</strong> bitte in <strong>Safari</strong> öffnen — ' +
      'im aktuellen Browser (z.B. WhatsApp/Mail) gibt es kein „Zum Home-Bildschirm". ' +
      'Tippe auf das Menü <strong>(⋯ bzw. Pfeil-Symbol)</strong> → <strong>„In Safari öffnen"</strong>.</div>' +
      '<button aria-label="Hinweis schließen" style="flex:0 0 auto;background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px">&times;</button>';
    bar.querySelector('button').addEventListener('click', function () {
      bar.remove();
      document.body.style.paddingTop = '';
      try { sessionStorage.setItem('pwaSafariHintDismissed', '1'); } catch (e) {}
    });
    document.body.appendChild(bar);
    // Inhalt nicht verdecken
    document.body.style.paddingTop = bar.offsetHeight + 'px';
  }

  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();
