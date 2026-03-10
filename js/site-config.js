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
    return this._data?.verwaltung;
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
