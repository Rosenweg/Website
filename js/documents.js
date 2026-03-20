/**
 * Rosenweg Documents Module
 * Loads documents from /api/documents, displays them grouped by folder.
 * Admins can upload and delete files.
 */
const RosenwegDocs = {
  container: null,
  docs: [],
  canManage: false,
  isTechnik: false,
  groups: [],
  writableFolders: [],

  STWEG_GROUPS: {
    1: ['stweg1-bewohner', 'stweg1-eigentuemer', 'stweg1-ausschuss'],
    2: ['stweg2-bewohner', 'stweg2-eigentuemer', 'stweg2-ausschuss'],
    3: ['r9-bewohner', 'r9-eigentuemer', 'stweg3-ausschuss'],
    4: ['stweg4-bewohner', 'stweg4-eigentuemer', 'stweg4-ausschuss'],
    5: ['stweg5-bewohner', 'stweg5-eigentuemer', 'stweg5-ausschuss'],
    6: ['r1-bewohner', 'r1-eigentuemer', 'stweg6-ausschuss'],
    7: ['stweg7-bewohner', 'stweg7-eigentuemer', 'stweg7-ausschuss'],
    8: ['stweg8-ausschuss'],
  },

  CATEGORY_LABELS: {
    'allgemein': 'Allgemein',
    'Scans': 'Scans',
    'stweg1': 'STWEG 1 – Rosenweg 17/18',
    'stweg2': 'STWEG 2 – Rosenweg 13/14/16',
    'stweg3': 'STWEG 3 – Rosenweg 9',
    'stweg4': 'STWEG 4 – Rosenweg 10/12',
    'stweg5': 'STWEG 5 – Rosenweg 5/6/8',
    'stweg6': 'STWEG 6 – Rosenweg 1',
    'stweg7': 'STWEG 7 – Rosenweg 2/4',
    'stweg8': 'STWEG 8 – Gesamtanlage',
  },

  FILE_ICONS: {
    pdf: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>',
    xlsx: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
    xls: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
    docx: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
    doc: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
    default: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
  },

  EXT_COLORS: {
    pdf: 'text-red-500',
    xlsx: 'text-green-600', xls: 'text-green-600', csv: 'text-green-600',
    docx: 'text-blue-600', doc: 'text-blue-600',
    pptx: 'text-orange-500',
    png: 'text-purple-500', jpg: 'text-purple-500', jpeg: 'text-purple-500',
    txt: 'text-gray-500',
  },

  VIEWABLE_EXTS: new Set(['pdf', 'png', 'jpg', 'jpeg', 'txt', 'csv']),
  OFFICE_EXTS: new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'dotx']),

  /** Escape string for safe HTML insertion */
  _escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  _isViewable(ext) {
    return this.VIEWABLE_EXTS.has(ext) || this.OFFICE_EXTS.has(ext);
  },

  _getWritableFolders() {
    if (this.isTechnik) return Object.keys(this.CATEGORY_LABELS);
    if (!this.canManage) return [];
    const folders = ['allgemein'];
    for (const [nr, groupNames] of Object.entries(this.STWEG_GROUPS)) {
      if (this.groups.some(g => groupNames.includes(g.toLowerCase()) && g.toLowerCase().endsWith('-ausschuss'))) {
        folders.push(`stweg${nr}`);
      }
    }
    return folders;
  },

  _canWritePath(path) {
    if (this.isTechnik) return true;
    const folder = path.includes('/') ? path.split('/')[0] : 'allgemein';
    return this.writableFolders.includes(folder);
  },

  async init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    const user = AuthentikAuth.getUser();
    this.groups = user?.groups || [];
    this.isTechnik = this.groups.some(g => g.toLowerCase() === 'technik');
    this.canManage = this.groups.some(g => {
      const gl = g.toLowerCase();
      return gl === 'technik' || gl.endsWith('-ausschuss');
    });
    this.writableFolders = this._getWritableFolders();

    const token = AuthentikAuth.getToken();
    if (!token) {
      this.renderLoginHint();
      return;
    }

    await this.loadAndRender();
  },

  renderLoginHint() {
    this.container.innerHTML = `
      <div class="bg-blue-50 border-l-4 border-blue-500 p-6 rounded-lg">
        <p class="text-gray-700">
          <svg class="h-5 w-5 inline mr-2 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
          </svg>
          Bitte <a href="#" onclick="AuthentikAuth.login(); return false;" class="text-blue-600 underline font-semibold">einloggen</a>, um Dokumente zu sehen.
        </p>
      </div>`;
  },

  async loadAndRender() {
    this.container.innerHTML = '<p class="text-center text-gray-500 py-8">Dokumente werden geladen...</p>';

    try {
      const resp = await AuthentikAuth.apiFetch('/api/documents');
      if (!resp.ok) throw new Error('API error');
      this.docs = await resp.json();
      this.render();
    } catch (err) {
      this.container.innerHTML = '<p class="text-center text-red-500 py-8">Dokumente konnten nicht geladen werden.</p>';
    }
  },

  groupByFolder() {
    const groups = {};
    for (const doc of this.docs) {
      const parts = doc.path.split('/');
      const folder = parts.length > 1 ? parts[0] : 'allgemein';
      if (!groups[folder]) groups[folder] = [];
      groups[folder].push(doc);
    }
    // Sort files alphabetically within each group
    for (const folder of Object.keys(groups)) {
      groups[folder].sort((a, b) => a.path.localeCompare(b.path));
    }
    return groups;
  },

  formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  getExt(path) {
    return path.split('.').pop().toLowerCase();
  },

  getFileName(path) {
    return path.split('/').pop();
  },

  /** Sanitize filename: replace spaces/special chars with hyphens, lowercase */
  sanitizeFileName(name) {
    return name
      .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove remaining accents
      .replace(/[^a-zA-Z0-9._-]/g, '-')                // Replace special chars with hyphens
      .replace(/-+/g, '-')                              // Collapse multiple hyphens
      .replace(/^-|-$/g, '')                            // Trim leading/trailing hyphens
      .toLowerCase();
  },

  getIcon(ext) {
    const iconPath = this.FILE_ICONS[ext] || this.FILE_ICONS.default;
    const color = this.EXT_COLORS[ext] || 'text-gray-500';
    return `<svg class="h-5 w-5 ${color} flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${iconPath}</svg>`;
  },

  render() {
    const groups = this.groupByFolder();
    const folderOrder = Object.keys(this.CATEGORY_LABELS);
    // Add any folders not in predefined labels
    const allFolders = [...new Set([...folderOrder, ...Object.keys(groups)])];

    let html = '';

    // Admin: upload button
    if (this.canManage) {
      html += `
        <div class="mb-6 flex justify-end">
          <button onclick="RosenwegDocs.showUploadDialog()" class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition flex items-center gap-2 text-sm">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            Dokument hochladen
          </button>
        </div>`;
    }

    let hasAny = false;
    for (const folder of allFolders) {
      const files = groups[folder];
      if (!files || files.length === 0) continue;
      hasAny = true;

      const label = this.CATEGORY_LABELS[folder] || folder;
      html += `
        <div class="mb-6">
          <h3 class="text-lg font-semibold text-gray-700 mb-3 border-b pb-2">${label}</h3>
          <div class="space-y-2">`;

      for (const doc of files) {
        const ext = this.getExt(doc.path);
        const fileName = this.getFileName(doc.path);
        const safeFileName = this._escapeHtml(fileName);
        const safePath = this._escapeHtml(doc.path);
        const safeUrl = this._escapeHtml(doc.url || `/api/documents/${doc.path}`);
        const size = this.formatSize(doc.size);
        const extBadge = ext.toUpperCase();
        const viewable = this._isViewable(ext);
        // Escape for JS string inside onclick attributes
        const jsPath = doc.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const jsFileName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const jsUrl = (doc.url || `/api/documents/${doc.path}`).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const clickAction = viewable
          ? `RosenwegDocs.viewFile('${jsPath}', '${jsFileName}', '${ext}')`
          : `RosenwegDocs.downloadFile('${jsUrl}', '${jsFileName}')`;

        html += `
            <div class="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 hover:bg-gray-100 transition group">
              <a href="#" onclick="${clickAction}; return false;" class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                ${this.getIcon(ext)}
                <span class="truncate text-gray-800">${safeFileName}</span>
                <span class="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600 flex-shrink-0">${extBadge}</span>
                <span class="text-xs text-gray-400 flex-shrink-0">${size}</span>
                ${viewable ? '<span class="text-xs text-blue-500 flex-shrink-0"><svg class="h-3.5 w-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg></span>' : ''}
              </a>
              <div class="flex items-center gap-2 ml-2">
                <a href="#" onclick="RosenwegDocs.downloadFile('${jsUrl}', '${jsFileName}'); return false;" class="text-blue-600 hover:text-blue-800 p-1" title="Herunterladen">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                </a>
                ${this._canWritePath(doc.path) ? `
                <button onclick="RosenwegDocs.showReplaceDialog('${jsPath}')" class="text-yellow-600 hover:text-yellow-800 p-1 opacity-0 group-hover:opacity-100 transition" title="Ersetzen">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                </button>
                <button onclick="RosenwegDocs.confirmDelete('${jsPath}')" class="text-red-500 hover:text-red-700 p-1 opacity-0 group-hover:opacity-100 transition" title="Löschen">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                  </svg>
                </button>` : ''}
              </div>
            </div>`;
      }

      html += `
          </div>
        </div>`;
    }

    if (!hasAny) {
      html += '<p class="text-center text-gray-500 py-8">Noch keine Dokumente vorhanden.</p>';
    }

    this.container.innerHTML = html;
  },

  showUploadDialog(prefillPath) {
    const folders = Object.entries(this.CATEGORY_LABELS)
      .filter(([key]) => this.writableFolders.includes(key))
      .map(([key, label]) => `<option value="${key}"${prefillPath && prefillPath.startsWith(key) ? ' selected' : ''}>${label}</option>`)
      .join('');

    const modal = document.createElement('div');
    modal.id = 'docs-upload-modal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <h3 class="text-lg font-bold mb-4">Dokument hochladen</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Ordner</label>
            <select id="upload-folder" class="w-full border rounded-lg px-3 py-2">
              ${folders}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Datei</label>
            <input type="file" id="upload-file" class="w-full border rounded-lg px-3 py-2"
              accept=".pdf,.xlsx,.xls,.docx,.doc,.pptx,.png,.jpg,.jpeg,.txt,.csv">
          </div>
          <div id="upload-progress" class="hidden">
            <div class="flex items-center justify-between text-sm mb-1">
              <span id="upload-status-text" class="text-gray-600">Wird hochgeladen...</span>
              <span id="upload-percent" class="text-gray-500 font-mono">0%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
              <div id="upload-bar" class="h-full bg-blue-600 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
            <p id="upload-size-info" class="text-xs text-gray-400 mt-1"></p>
          </div>
          <div id="upload-error" class="text-sm text-red-600 hidden"></div>
          <div class="flex justify-end gap-3 pt-2">
            <button onclick="RosenwegDocs.closeModal()" class="px-4 py-2 text-gray-600 hover:text-gray-800">Abbrechen</button>
            <button onclick="RosenwegDocs.doUpload()" id="upload-btn" class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition">Hochladen</button>
          </div>
        </div>
      </div>`;
    modal.addEventListener('click', (e) => { if (e.target === modal) this.closeModal(); });
    document.body.appendChild(modal);
  },

  showReplaceDialog(path) {
    const fileName = this.getFileName(path);
    const modal = document.createElement('div');
    modal.id = 'docs-upload-modal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <h3 class="text-lg font-bold mb-4">Dokument ersetzen</h3>
        <p class="text-sm text-gray-600 mb-4">Aktuelle Datei: <strong>${fileName}</strong></p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Neue Datei</label>
            <input type="file" id="upload-file" class="w-full border rounded-lg px-3 py-2"
              accept=".pdf,.xlsx,.xls,.docx,.doc,.pptx,.png,.jpg,.jpeg,.txt,.csv">
          </div>
          <input type="hidden" id="replace-path" value="${path}">
          <div id="upload-progress" class="hidden">
            <div class="flex items-center justify-between text-sm mb-1">
              <span id="upload-status-text" class="text-gray-600">Wird hochgeladen...</span>
              <span id="upload-percent" class="text-gray-500 font-mono">0%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
              <div id="upload-bar" class="h-full bg-blue-600 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
            <p id="upload-size-info" class="text-xs text-gray-400 mt-1"></p>
          </div>
          <div id="upload-error" class="text-sm text-red-600 hidden"></div>
          <div class="flex justify-end gap-3 pt-2">
            <button onclick="RosenwegDocs.closeModal()" class="px-4 py-2 text-gray-600 hover:text-gray-800">Abbrechen</button>
            <button onclick="RosenwegDocs.doReplace()" id="upload-btn" class="bg-yellow-600 text-white px-4 py-2 rounded-lg hover:bg-yellow-700 transition">Ersetzen</button>
          </div>
        </div>
      </div>`;
    modal.addEventListener('click', (e) => { if (e.target === modal) this.closeModal(); });
    document.body.appendChild(modal);
  },

  closeModal() {
    const modal = document.getElementById('docs-upload-modal');
    if (modal) modal.remove();
  },

  _showProgress(file) {
    const progress = document.getElementById('upload-progress');
    const sizeInfo = document.getElementById('upload-size-info');
    progress.classList.remove('hidden');
    sizeInfo.textContent = `0 / ${this.formatSize(file.size)}`;
  },

  _updateProgress(loaded, total, fileName) {
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    const bar = document.getElementById('upload-bar');
    const percent = document.getElementById('upload-percent');
    const statusText = document.getElementById('upload-status-text');
    const sizeInfo = document.getElementById('upload-size-info');
    if (bar) bar.style.width = pct + '%';
    if (percent) percent.textContent = pct + '%';
    if (statusText) statusText.textContent = pct < 100 ? `Lade ${fileName} hoch...` : 'Wird verarbeitet...';
    if (sizeInfo) sizeInfo.textContent = `${this.formatSize(loaded)} / ${this.formatSize(total)}`;
    // Change bar color when processing server-side
    if (pct >= 100 && bar) {
      bar.classList.remove('bg-blue-600');
      bar.classList.add('bg-yellow-500', 'animate-pulse');
    }
  },

  _showUploadSuccess() {
    const bar = document.getElementById('upload-bar');
    const statusText = document.getElementById('upload-status-text');
    const percent = document.getElementById('upload-percent');
    if (bar) { bar.classList.remove('bg-yellow-500', 'animate-pulse'); bar.classList.add('bg-green-500'); }
    if (statusText) statusText.textContent = 'Erfolgreich hochgeladen!';
    if (percent) percent.textContent = '100%';
  },

  _showUploadError(msg) {
    const errorEl = document.getElementById('upload-error');
    const progress = document.getElementById('upload-progress');
    if (progress) progress.classList.add('hidden');
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
  },

  async _uploadFile(url, file) {
    const buffer = await file.arrayBuffer();
    const fileName = this.sanitizeFileName(file.name);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) this._updateProgress(e.loaded, e.total, fileName);
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          this._showUploadSuccess();
          resolve(xhr);
        } else {
          reject(new Error(`Upload fehlgeschlagen (${xhr.status})`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Netzwerkfehler')));
      xhr.addEventListener('abort', () => reject(new Error('Upload abgebrochen')));

      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      const token = AuthentikAuth.getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(buffer);
    });
  },

  async doUpload() {
    const folder = document.getElementById('upload-folder').value;
    const fileInput = document.getElementById('upload-file');
    const btn = document.getElementById('upload-btn');

    if (!fileInput.files.length) {
      this._showUploadError('Bitte eine Datei auswählen.');
      return;
    }

    const file = fileInput.files[0];
    const safeName = this.sanitizeFileName(file.name);
    const path = `${folder}/${safeName}`;

    btn.disabled = true;
    btn.textContent = 'Wird hochgeladen...';
    this._showProgress(file);

    try {
      await this._uploadFile(`/api/documents/${path}`, file);
      setTimeout(() => { this.closeModal(); this.loadAndRender(); }, 500);
    } catch (err) {
      this._showUploadError('Fehler: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Hochladen';
    }
  },

  async doReplace() {
    const path = document.getElementById('replace-path').value;
    const fileInput = document.getElementById('upload-file');
    const btn = document.getElementById('upload-btn');

    if (!fileInput.files.length) {
      this._showUploadError('Bitte eine Datei auswählen.');
      return;
    }

    const file = fileInput.files[0];
    const folder = path.substring(0, path.lastIndexOf('/'));
    const safeName = this.sanitizeFileName(file.name);
    const uploadPath = `${folder}/${safeName}`;

    btn.disabled = true;
    btn.textContent = 'Wird ersetzt...';
    this._showProgress(file);

    try {
      if (uploadPath !== path) {
        await AuthentikAuth.apiFetch(`/api/documents/${path}`, { method: 'DELETE' });
      }
      await this._uploadFile(`/api/documents/${uploadPath}`, file);
      setTimeout(() => { this.closeModal(); this.loadAndRender(); }, 500);
    } catch (err) {
      this._showUploadError('Fehler: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Ersetzen';
    }
  },

  async viewFile(path, fileName, ext) {
    const downloadUrl = `/api/documents/${path}`;
    const safeFileName = this._escapeHtml(fileName);
    const jsDownloadUrl = downloadUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const jsFileName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const isOffice = this.OFFICE_EXTS.has(ext);
    const modal = document.createElement('div');
    modal.id = 'docs-viewer-modal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-80 z-50 flex flex-col';
    modal.innerHTML = `
      <div class="flex items-center justify-between px-4 py-3 bg-gray-900 text-white flex-shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="font-medium truncate">${safeFileName}</span>
          ${isOffice ? '<span class="text-xs bg-blue-600 px-2 py-0.5 rounded">PDF-Vorschau</span>' : ''}
        </div>
        <div class="flex items-center gap-2 ml-4 flex-shrink-0">
          <button onclick="RosenwegDocs.downloadFile('${jsDownloadUrl}', '${jsFileName}'); return false;" class="text-gray-300 hover:text-white p-1.5 rounded hover:bg-gray-700 transition" title="Original herunterladen">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          </button>
          <button onclick="RosenwegDocs.closeViewer()" class="text-gray-300 hover:text-white p-1.5 rounded hover:bg-gray-700 transition" title="Schließen">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="flex-1 flex items-center justify-center overflow-auto p-4">
        <div class="text-white text-center">
          <svg class="animate-spin h-8 w-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          ${isOffice ? 'Wird konvertiert...' : 'Wird geladen...'}
        </div>
      </div>`;
    modal.addEventListener('click', (e) => { if (e.target === modal) this.closeViewer(); });
    document.addEventListener('keydown', this._viewerKeyHandler = (e) => {
      if (e.key === 'Escape') this.closeViewer();
    });
    document.body.appendChild(modal);

    try {
      let blob;
      if (isOffice) {
        // Convert via server-side Gotenberg
        const resp = await AuthentikAuth.apiFetch('/api/documents-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Konvertierung fehlgeschlagen');
        }
        blob = await resp.blob();
      } else {
        const resp = await AuthentikAuth.apiFetch(downloadUrl);
        if (!resp.ok) throw new Error('Laden fehlgeschlagen');
        blob = await resp.blob();
      }

      const blobUrl = URL.createObjectURL(blob);
      const contentArea = modal.querySelector('.flex-1');

      if (ext === 'pdf' || isOffice) {
        contentArea.innerHTML = `<iframe src="${blobUrl}" class="w-full h-full rounded" style="min-height: 80vh;"></iframe>`;
        contentArea.className = 'flex-1 p-4';
      } else if (['png', 'jpg', 'jpeg'].includes(ext)) {
        contentArea.innerHTML = `<img src="${blobUrl}" class="max-w-full max-h-full object-contain rounded shadow-lg" alt="${fileName}">`;
      } else if (['txt', 'csv'].includes(ext)) {
        const text = await blob.text();
        contentArea.innerHTML = `<pre class="bg-white text-gray-800 rounded-lg p-6 max-w-4xl w-full max-h-[80vh] overflow-auto text-sm font-mono whitespace-pre-wrap">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
      }

      modal._blobUrl = blobUrl;
    } catch (err) {
      const contentArea = modal.querySelector('.flex-1');
      contentArea.innerHTML = `
        <div class="text-center">
          <p class="text-red-400 mb-4">Fehler: ${this._escapeHtml(err.message)}</p>
          <button onclick="RosenwegDocs.downloadFile('${jsDownloadUrl}', '${jsFileName}'); RosenwegDocs.closeViewer();"
            class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition">
            Stattdessen herunterladen
          </button>
        </div>`;
    }
  },

  closeViewer() {
    const modal = document.getElementById('docs-viewer-modal');
    if (modal) {
      if (modal._blobUrl) URL.revokeObjectURL(modal._blobUrl);
      modal.remove();
    }
    if (this._viewerKeyHandler) {
      document.removeEventListener('keydown', this._viewerKeyHandler);
      this._viewerKeyHandler = null;
    }
  },

  async downloadFile(url, fileName) {
    try {
      const resp = await AuthentikAuth.apiFetch(url);
      if (!resp.ok) throw new Error('Download fehlgeschlagen');
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      alert('Fehler beim Download: ' + err.message);
    }
  },

  async confirmDelete(path) {
    const fileName = this.getFileName(path);
    if (!confirm(`"${fileName}" wirklich löschen?`)) return;

    try {
      const resp = await AuthentikAuth.apiFetch(`/api/documents/${path}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error('Löschen fehlgeschlagen');
      await this.loadAndRender();
    } catch (err) {
      alert('Fehler beim Löschen: ' + err.message);
    }
  },
};
