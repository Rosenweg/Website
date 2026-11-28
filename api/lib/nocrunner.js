// Runner im NOC: reine Logik. Der Runner-Waechter (scripts/rw-runner-waechter.sh
// auf pve2) schickt nach jedem Lauf (jede Minute) seinen Zustand per POST; die
// Route (routes/nocrunner.js) haelt ihn im Speicher, das Cockpit holt ihn.
// Kein Zugriff auf GitHub von hier: was die API ueber die Runner weiss, hat der
// Waechter schon gelesen (GitHub-App), dieselbe Quelle wie seine Entscheide.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
// Der Waechter laeuft jede Minute: nach 5 Minuten ohne Bericht ist er selbst das Problem.
const STILL_MS = 5 * 60 * 1000;
// Stau: mehr als STAU_JOBS Jobs warten laenger als STAU_S (der Waechter zaehlt die langen).
const STAU_JOBS = 10;
const STAU_S = 20 * 60;
const STAU_PAUSE_MS = 60 * 60 * 1000;

const text = (v, max) => (v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const URL_GH = /^https:\/\/github\.com\/[A-Za-z0-9._\/-]{1,200}$/;
const zahlOder = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const url = (v) => (URL_GH.test(String(v || '')) ? String(v) : null);
function jobPruefen(j) {
  if (!j || typeof j !== 'object') return null;
  return {
    repo: text(j.repo, 80), workflow: text(j.workflow, 100), job: text(j.job, 100),
    branch: text(j.branch, 100), pr: Number.isInteger(j.pr) ? j.pr : null, url: url(j.url),
    schritt: j.schritt ? text(j.schritt, 100) : null,
    schritte_fertig: zahlOder(j.schritte_fertig), schritte_gesamt: zahlOder(j.schritte_gesamt),
    laufzeit_s: zahlOder(j.laufzeit_s), prozent: zahlOder(j.prozent), rest_s: zahlOder(j.rest_s),
  };
}
const zahl = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

// Eingang pruefen. Liefert { bericht } oder { fehler }.
function eingabePruefen(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.runner)) return { fehler: 'runner fehlt' };
  if (body.runner.length > 20) return { fehler: 'zu viele Runner' };
  const runner = [];
  for (const r of body.runner) {
    if (!r || typeof r !== 'object' || !NAME.test(String(r.name || ''))) return { fehler: 'Runner-Name ungueltig' };
    runner.push({
      name: String(r.name),
      art: r.art === 'windows' ? 'windows' : 'linux',
      knoten: text(r.knoten, 20),
      online: !!r.online,
      busy: !!r.busy,
      // vom Waechter gewollt an (Dienst laeuft bzw. Runner 1) - Windows: immer
      soll_an: !!r.soll_an,
      dienst_aktiv: !!r.dienst_aktiv,
      ct: text(r.ct, 20),
      job: jobPruefen(r.job),
      dienst_cpu_pct: zahlOder(r.dienst_cpu_pct), dienst_ram_b: zahlOder(r.dienst_ram_b),
      vm: r.vm && typeof r.vm === 'object'
        ? { cpu: zahlOder(r.vm.cpu), kerne: zahlOder(r.vm.kerne), ram: zahlOder(r.vm.ram), ram_gesamt: zahlOder(r.vm.ram_gesamt) } : null,
    });
  }
  const cts = (Array.isArray(body.cts) ? body.cts : []).slice(0, 10).map((c) => ({
    ct: text(c && c.ct, 20), knoten: text(c && c.knoten, 20), last: zahlOder(c && c.last), kerne: zahlOder(c && c.kerne),
    ram_gesamt_b: zahlOder(c && c.ram_gesamt_b), ram_frei_b: zahlOder(c && c.ram_frei_b),
  }));
  const warteschlange = (Array.isArray(body.warteschlange) ? body.warteschlange : []).slice(0, 10).map((w) => ({
    repo: text(w && w.repo, 80), workflow: text(w && w.workflow, 100), job: text(w && w.job, 100),
    url: url(w && w.url), wartezeit_s: zahlOder(w && w.wartezeit_s),
  }));
  const rel = body.release && typeof body.release === 'object' ? body.release : null;
  const relEintrag = (x) => ({
    repo: text(x && x.repo, 80), tag: text(x && x.tag, 40), seit: text(x && x.seit, 40),
    ergebnis: text(x && x.ergebnis, 40), versuche: zahlOder(x && x.versuche), url: url(x && x.url),
  });
  const release = rel ? {
    aktiv: !!rel.aktiv,
    parallel_max: zahlOder(rel.parallel_max),
    laeuft: (Array.isArray(rel.laeuft) ? rel.laeuft : []).slice(0, 5).map(relEintrag),
    wartend: (Array.isArray(rel.wartend) ? rel.wartend : []).slice(0, 20).map(relEintrag),
    uebersprungen: (Array.isArray(rel.uebersprungen) ? rel.uebersprungen : []).slice(0, 10).map(relEintrag),
    letzte: rel.letzte ? relEintrag(rel.letzte) : null,
    hinweis: rel.hinweis ? text(rel.hinweis, 200) : null,
  } : null;
  const st = body.stau && typeof body.stau === 'object' ? body.stau : null;
  const stau = st ? { wartend: zahlOder(st.wartend) || 0, lange: zahlOder(st.lange) || 0, aeltester_s: zahlOder(st.aeltester_s) } : null;
  const sch = body.letzter_schaltvorgang;
  return { bericht: {
    runner, cts, warteschlange, release, stau,
    wartend: zahl(body.wartend),
    trocken: !!body.trocken,
    fehler: body.fehler ? text(body.fehler, 300) : null,
    letzter_schaltvorgang: sch && typeof sch === 'object'
      ? { zeit: text(sch.zeit, 40), text: text(sch.text, 200) } : null,
  } };
}

// Fuer das NOC: Ampel, Warnungen, Liste.
function zusammenfassung(bericht, empfangen, jetzt = Date.now()) {
  if (!bericht) return { ampel: 'grau', waechter: { zustand: 'nie', alter_min: null }, runner: [], cts: [], warteschlange: [], warnungen: [], wartend: null, letzter_schaltvorgang: null };
  const alter = jetzt - empfangen;
  const still = alter > STILL_MS;
  const warnungen = [];
  if (still) warnungen.push(`Waechter meldet sich nicht (seit ${Math.round(alter / 60000)} Min)`);
  if (bericht.fehler) warnungen.push(`Waechter: ${bericht.fehler}`);
  const runner = bericht.runner.map((r) => {
    let zustand;
    if (r.online) zustand = r.busy ? 'busy' : 'idle';
    else zustand = r.dienst_aktiv ? 'startet' : 'aus';
    const ampel = (r.soll_an && !r.online) ? 'rot' : zustand === 'aus' ? 'grau' : 'gruen';
    if (r.soll_an && !r.online) warnungen.push(`${r.name} ist offline, soll aber laufen`);
    return { ...r, zustand, ampel };
  });
  const stauAktiv = !!(bericht.stau && bericht.stau.lange > STAU_JOBS);
  if (stauAktiv) warnungen.push(`Stau: ${bericht.stau.lange} Jobs warten laenger als ${STAU_S / 60} Min`);
  if (bericht.release && bericht.release.uebersprungen.length) warnungen.push(`Release uebersprungen: ${bericht.release.uebersprungen.map((u) => u.repo + ' ' + u.tag).join(', ')}`);
  // win-runner ist eine eigene VM, die dauernd laufen soll
  return {
    ampel: still || bericht.fehler || stauAktiv || runner.some((r) => r.ampel === 'rot') ? 'rot' : 'gruen',
    waechter: { zustand: still ? 'still' : bericht.fehler ? 'fehler' : 'ok', alter_min: Math.round(alter / 60000), trocken: bericht.trocken },
    runner,
    warnungen,
    wartend: bericht.wartend,
    cts: bericht.cts,
    warteschlange: bericht.warteschlange,
    release: bericht.release,
    stau: bericht.stau ? { ...bericht.stau, grenze_jobs: STAU_JOBS, grenze_min: STAU_S / 60, aktiv: bericht.stau.lange > STAU_JOBS } : null,
    letzter_schaltvorgang: bericht.letzter_schaltvorgang,
    zeit: new Date(empfangen).toISOString(),
  };
}

// Stau-Meldung: hoechstens eine je Stunde, dazu eine Entwarnung, wenn der Stau weg ist.
// zustand = { aktiv, gemeldet, zuletzt } wird veraendert; Rueckgabe 'alarm' | 'entwarnung' | null.
function stauEntscheiden(zustand, stau, jetzt = Date.now()) {
  if (!stau) return null;
  const ist = stau.lange > STAU_JOBS;
  if (ist) {
    zustand.aktiv = true;
    if (!zustand.gemeldet || jetzt - zustand.zuletzt >= STAU_PAUSE_MS) {
      zustand.gemeldet = true; zustand.zuletzt = jetzt;
      return 'alarm';
    }
    return null;
  }
  if (zustand.aktiv) {
    zustand.aktiv = false;
    if (zustand.gemeldet) { zustand.gemeldet = false; return 'entwarnung'; }
  }
  return null;
}

// Ohne Token (NOC_PUBLIC_OPEN): keine Repo-, Workflow- und Branchnamen, keine Links.
function oeffentlich(z) {
  const job = (j) => (j ? { prozent: j.prozent, rest_s: j.rest_s, laufzeit_s: j.laufzeit_s } : null);
  return { ...z, warnungen: z.warnungen.map(() => 'Warnung'), runner: z.runner.map((r) => ({ ...r, job: job(r.job) })),
    warteschlange: [], release: z.release ? { ...z.release, laeuft: [], wartend: [], uebersprungen: [], letzte: null } : null, letzter_schaltvorgang: z.letzter_schaltvorgang ? { zeit: z.letzter_schaltvorgang.zeit, text: '' } : null };
}

module.exports = { oeffentlich, stauEntscheiden, STAU_JOBS, STAU_S, eingabePruefen, zusammenfassung, STILL_MS };
