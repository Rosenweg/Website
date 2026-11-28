// Internet (ISP): welche Wartungen und Stoerungen betreffen MEIN Haus?
// (App Rosenweg Internet, Entscheid Stefan 28.11.2026: bekannte Stoerungen des eigenen Hauses
// zeigen, bevor jemand eine meldet.)
//
// scope einer Wartung (isp_maintenance.scope), wie maintSubscriberRecipientsForScope:
//   { all: true }            alle Anschluesse
//   { houses: [9, 13] }      Haeuser (Hausnummer)
//   { vlans: [99] }          VLANs; ueber vlanZuHaus {99: 9} auf das Haus abgebildet
//   leer / ohne Angaben      gilt wie "alle" (so verschickt auch die Benachrichtigung)

/** Hausnummern aus dem scope; null = alle Haeuser. vlanZuHaus: { '99': 9, … } */
function scopeHaeuser(scope, vlanZuHaus = {}) {
  if (!scope || typeof scope !== 'object' || scope.all) return null;
  const haeuser = new Set((Array.isArray(scope.houses) ? scope.houses : []).map(Number).filter(Number.isFinite));
  for (const v of Array.isArray(scope.vlans) ? scope.vlans : []) {
    const h = vlanZuHaus[Number(v)];
    if (h) haeuser.add(Number(h));
  }
  // Nur VLANs ohne bekanntes Haus (z. B. ein eigenes Netz): betrifft kein Haus.
  const hatAngaben = (Array.isArray(scope.houses) && scope.houses.length) || (Array.isArray(scope.vlans) && scope.vlans.length);
  return hatAngaben ? haeuser : null;
}

/** 'alle' | 'haus' | null: betrifft die Wartung eines der Haeuser der Person? */
function betrifftHaeuser(scope, meineHaeuser, vlanZuHaus = {}) {
  const h = scopeHaeuser(scope, vlanZuHaus);
  if (h === null) return 'alle';
  return (meineHaeuser || []).some(x => h.has(Number(x))) ? 'haus' : null;
}

/** Wartungen der Person: nur die, die eines ihrer Haeuser (oder alle) betreffen. */
function wartungenFuerHaeuser(zeilen, meineHaeuser, vlanZuHaus = {}) {
  const raus = [];
  for (const w of zeilen || []) {
    const betrifft = betrifftHaeuser(w.scope, meineHaeuser, vlanZuHaus);
    if (betrifft) raus.push({
      id: w.id, title: w.title, description: w.description || null, severity: w.severity || 'info',
      status: w.status, start_at: w.start_at || null, end_at: w.end_at || null, betrifft,
    });
  }
  return raus;
}

module.exports = { scopeHaeuser, betrifftHaeuser, wartungenFuerHaeuser };
