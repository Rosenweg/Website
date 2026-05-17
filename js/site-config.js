/**
 * Site Configuration Loader
 * Loads /site-config.json and provides it globally.
 * Usage: await SiteConfig.load() or SiteConfig.get()
 */
const SiteConfig = {
  _data: null,
  _promise: null,

  async load() {
    if (this._data) return this._data;
    if (this._promise) return this._promise;

    this._promise = fetch('/site-config.json')
      .then(r => r.json())
      .then(data => { this._data = data; return data; })
      .catch(() => { this._data = {}; return {}; });

    return this._promise;
  },

  get() {
    return this._data;
  },

  getStweg(nr) {
    return this._data?.stwegen?.find(s => s.nr === nr);
  },

  getVerwaltung() {
    // Legacy: liefert statisches Objekt aus site-config.json (Rueckwaerts-Kompat).
    // Neue Aufrufer sollten getVerwaltungForStweg(nr) verwenden.
    return this._data?.verwaltung;
  },

  // Cache fuer dynamische Verwaltungs-Liste aus /api/verwaltungen/public
  _verwPromise: null,
  _verwData: null,

  async _loadVerwaltungen() {
    if (this._verwData) return this._verwData;
    if (this._verwPromise) return this._verwPromise;
    this._verwPromise = fetch('/api/verwaltungen/public')
      .then(r => r.ok ? r.json() : { verwaltungen: [] })
      .then(d => { this._verwData = d.verwaltungen || []; return this._verwData; })
      .catch(() => { this._verwData = []; return []; });
    return this._verwPromise;
  },

  // Liefert die zustaendige Verwaltung fuer einen STWEG.
  // Reihenfolge:
  //   1) Aktive Verwaltung mit passendem stweg
  //   2) Aktive Verwaltung mit stweg=null (uebergreifend)
  //   3) Ausschuss-Fallback (ausschuss_fallback: true) — der Ausschuss uebernimmt
  //      die Verwaltungsaufgaben bis eine neue Verwaltung bestimmt ist
  async getVerwaltungForStweg(nr) {
    await this.load();
    const list = await this._loadVerwaltungen();
    const stwegNr = parseInt(nr, 10);
    let v = Number.isFinite(stwegNr) ? list.find(x => x.stweg === stwegNr) : null;
    if (!v) v = list.find(x => x.stweg === null || x.stweg === undefined);
    if (v) {
      return {
        firma: v.firma_name,
        adresse: v.adresse || '',
        telefon: v.telefon || '',
        email: v.email || '',
        website: v.website || '',
        oeffnungszeiten: v.oeffnungszeiten || '',
        kontakte: v.kontakte || [],
        ausschuss_fallback: false,
        _source: 'api',
      };
    }
    // Keine aktive Verwaltung in der DB → Ausschuss uebernimmt
    return this._buildAusschussFallback(stwegNr);
  },

  _buildAusschussFallback(stwegNr) {
    const stweg = this._data?.stwegen?.find(s => s.nr === stwegNr);
    const stwegEmail = stweg?.email || null;
    const ausschuss = this._data?.ausschuss || {};
    const ausschussEmail = ausschuss.email || 'ausschuss@rosenweg4303.ch';
    return {
      firma: 'Ausschuss (aktuell keine externe Verwaltung beauftragt)',
      adresse: '',
      telefon: '',
      email: stwegEmail || ausschussEmail,
      ausschuss_general_email: ausschussEmail,
      praesident_email: ausschuss.praesident_email || null,
      website: '',
      oeffnungszeiten: '',
      kontakte: [],
      ausschuss_fallback: true,
      _source: 'ausschuss-fallback',
    };
  },

  getEntsorgung() {
    return this._data?.entsorgung;
  },

  getTechnik() {
    return this._data?.technischer_dienst;
  },

  getAusschuss() {
    return this._data?.ausschuss;
  },

  getNotfall() {
    return this._data?.notfall;
  }
};
