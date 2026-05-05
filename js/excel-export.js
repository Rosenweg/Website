// RosenwegExcel — kleine Helper-Library fuer Excel/.xlsx-Export
// Lazy-loaded SheetJS (xlsx.js) von CDN beim ersten Export-Aufruf.
// Verwendung:
//   RosenwegExcel.fromTable(tableEl, 'telefonbuch.xlsx', 'Kontakte');
//   RosenwegExcel.fromData([{Name:'X', Email:'a@b.ch'}, ...], 'export.xlsx');
//   <button data-excel-export data-excel-source="#meine-tabelle" data-excel-name="liste.xlsx">⬇ Excel</button>

(function () {
  'use strict';
  if (window.RosenwegExcel) return;

  const SHEETJS_CDN = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  let _xlsxPromise = null;

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (_xlsxPromise) return _xlsxPromise;
    _xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS_CDN;
      s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX nicht geladen'));
      s.onerror = () => reject(new Error('SheetJS-Download fehlgeschlagen'));
      document.head.appendChild(s);
    });
    return _xlsxPromise;
  }

  function todayStamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function ensureExtension(name) {
    return /\.xlsx$/i.test(name) ? name : `${name}.xlsx`;
  }

  function safeFilename(name) {
    const stamped = name.includes('{date}') ? name.replace('{date}', todayStamp()) : name;
    return ensureExtension(stamped).replace(/[<>:"/\\|?*]/g, '_');
  }

  // Tabelle (HTMLTableElement oder Selector) -> xlsx
  // Headers werden aus <thead> th genommen, Daten aus <tbody> tr/td.
  // Hidden cells (display:none) werden ignoriert.
  async function fromTable(tableOrSelector, filename, sheetName) {
    const table = typeof tableOrSelector === 'string'
      ? document.querySelector(tableOrSelector)
      : tableOrSelector;
    if (!table) throw new Error('Tabelle nicht gefunden');
    const XLSX = await loadSheetJS();

    const isVisible = el => el && el.offsetParent !== null;

    const rows = [];
    const headRow = table.querySelector('thead tr');
    if (headRow) {
      const heads = [...headRow.children]
        .filter(isVisible)
        .map(c => (c.dataset.exportLabel || c.innerText || c.textContent || '').trim());
      rows.push(heads);
    }

    const bodyRows = [...table.querySelectorAll('tbody tr')].filter(tr => isVisible(tr) && !tr.dataset.excelSkip);
    for (const tr of bodyRows) {
      const cells = [...tr.children].filter(isVisible).map(td => {
        // data-export-value > visibler Text
        if (td.dataset.exportValue !== undefined) return td.dataset.exportValue;
        // Inputs/Selects: lese .value
        const input = td.querySelector('input,select,textarea');
        if (input) {
          if (input.type === 'checkbox') return input.checked ? 'ja' : 'nein';
          return input.value;
        }
        return (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
      });
      rows.push(cells);
    }

    if (rows.length === 0) throw new Error('Keine Daten zum Exportieren');

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Auto-Spaltenbreite (cap 60)
    ws['!cols'] = rows[0].map((_, c) => {
      const max = Math.max(...rows.map(r => String(r[c] || '').length));
      return { wch: Math.min(60, Math.max(8, max + 2)) };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Daten').slice(0, 31));
    XLSX.writeFile(wb, safeFilename(filename));
  }

  // Daten-Array -> xlsx. rows = [{col1: val, col2: val}, ...] oder [[a,b,c],...]
  // headers optional fuer Array-of-Arrays
  async function fromData(rows, filename, sheetName, headers) {
    const XLSX = await loadSheetJS();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Keine Daten');
    let ws;
    if (Array.isArray(rows[0])) {
      const all = headers ? [headers, ...rows] : rows;
      ws = XLSX.utils.aoa_to_sheet(all);
    } else {
      ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Daten').slice(0, 31));
    XLSX.writeFile(wb, safeFilename(filename));
  }

  // Auto-init: alle <button data-excel-export> mit data-excel-source binden
  function autoBind() {
    document.querySelectorAll('button[data-excel-export],a[data-excel-export]').forEach(btn => {
      if (btn.dataset.excelBound) return;
      btn.dataset.excelBound = '1';
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const source = btn.dataset.excelSource;
        const name = btn.dataset.excelName || `export-{date}.xlsx`;
        const sheet = btn.dataset.excelSheet || 'Daten';
        const orig = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = '⏳ Lade…';
        try {
          await fromTable(source, name, sheet);
        } catch (err) {
          alert('Excel-Export fehlgeschlagen: ' + err.message);
        } finally {
          btn.disabled = false; btn.innerHTML = orig;
        }
      });
    });
  }

  // Kleiner Helper: standard Tailwind-Button rendern
  function renderButton(opts = {}) {
    const { source, name, sheet, label = '⬇ Excel-Export', cls = 'inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700' } = opts;
    return `<button type="button" class="${cls}" data-excel-export data-excel-source="${source}" data-excel-name="${name || 'export-{date}.xlsx'}" data-excel-sheet="${sheet || 'Daten'}">${label}</button>`;
  }

  window.RosenwegExcel = { fromTable, fromData, autoBind, renderButton };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBind);
  } else {
    autoBind();
  }
  // Beobachte spaeter eingefuegte Buttons (fuer Single-Page-Listen)
  if (window.MutationObserver) {
    new MutationObserver(autoBind).observe(document.body, { childList: true, subtree: true });
  }
})();
