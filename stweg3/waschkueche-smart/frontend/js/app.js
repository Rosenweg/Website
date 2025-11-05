// API Configuration
const API_BASE_URL = 'http://localhost:3000/api';

// State
let currentUser = null;
let authToken = null;
let devices = [];
let refreshInterval = null;

// DOM Elements
const authSection = document.getElementById('auth-section');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');
const tokenInput = document.getElementById('token-input');
const userInfo = document.getElementById('user-info');
const logoutBtn = document.getElementById('logout-btn');
const refreshBtn = document.getElementById('refresh-btn');
const devicesGrid = document.getElementById('devices-grid');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Check if already logged in
  const savedToken = localStorage.getItem('authToken');
  if (savedToken) {
    authToken = savedToken;
    verifyToken();
  }

  // Setup event listeners
  authForm?.addEventListener('submit', handleLogin);
  logoutBtn?.addEventListener('click', handleLogout);
  refreshBtn?.addEventListener('click', loadDevices);

  // Auto-detect USB token (simulation)
  // In production, this would use WebUSB API or similar
  tokenInput?.focus();
});

// Authentication
async function handleLogin(e) {
  e.preventDefault();

  const token = tokenInput.value.trim();

  if (!token) {
    showAuthError('Bitte Token eingeben');
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Login fehlgeschlagen');
    }

    // Save token and user
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('currentUser', JSON.stringify(currentUser));

    // Show dashboard
    showDashboard();

  } catch (error) {
    console.error('Login error:', error);
    showAuthError(error.message || 'Login fehlgeschlagen. Bitte Token prüfen.');
  }
}

function showAuthError(message) {
  authError.querySelector('p').textContent = message;
  authError.classList.remove('hidden');

  setTimeout(() => {
    authError.classList.add('hidden');
  }, 5000);
}

async function verifyToken() {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/verify`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    const data = await response.json();

    if (data.valid) {
      currentUser = data.user;
      localStorage.setItem('currentUser', JSON.stringify(currentUser));
      showDashboard();
    } else {
      handleLogout();
    }
  } catch (error) {
    console.error('Token verification error:', error);
    handleLogout();
  }
}

function showDashboard() {
  authSection.classList.add('hidden');
  dashboard.classList.remove('hidden');
  userInfo.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');

  // Update user info
  document.getElementById('user-name').textContent = currentUser.name;
  document.getElementById('user-wohnung').textContent = currentUser.wohnung;
  updateBalance(currentUser.balance);

  // Load data
  loadDevices();
  loadUserSessions();

  // Start auto-refresh every 10 seconds
  refreshInterval = setInterval(loadDevices, 10000);
}

function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');

  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  authSection.classList.remove('hidden');
  dashboard.classList.add('hidden');
  userInfo.classList.add('hidden');
  logoutBtn.classList.add('hidden');

  tokenInput.value = '';
}

function updateBalance(balance) {
  const balanceElement = document.getElementById('user-balance');
  const statBalance = document.getElementById('stat-balance');

  const formatted = `CHF ${balance.toFixed(2)}`;
  balanceElement.textContent = formatted;
  statBalance.textContent = formatted;

  // Color coding
  if (balance < 5) {
    balanceElement.className = 'ml-4 px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-semibold';
  } else if (balance < 20) {
    balanceElement.className = 'ml-4 px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-semibold';
  } else {
    balanceElement.className = 'ml-4 px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-semibold';
  }
}

// Devices
async function loadDevices() {
  try {
    const response = await fetch(`${API_BASE_URL}/devices`);
    devices = await response.json();

    renderDevices();
    updateStats();

  } catch (error) {
    console.error('Load devices error:', error);
    devicesGrid.innerHTML = `
      <div class="col-span-2 text-center py-12">
        <p class="text-red-600">Fehler beim Laden der Geräte</p>
      </div>
    `;
  }
}

function renderDevices() {
  if (!devices || devices.length === 0) {
    devicesGrid.innerHTML = `
      <div class="col-span-2 text-center py-12">
        <p class="text-gray-600">Keine Geräte gefunden</p>
      </div>
    `;
    return;
  }

  devicesGrid.innerHTML = devices.map(device => `
    <div class="bg-white rounded-lg shadow-md overflow-hidden border-2 ${device.is_in_use ? 'border-orange-400' : 'border-gray-200'}">
      <div class="p-6">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center">
            ${getDeviceIcon(device.device_type)}
            <div class="ml-3">
              <h3 class="text-lg font-semibold text-gray-800">${device.device_name}</h3>
              <p class="text-sm text-gray-500">${device.location}</p>
            </div>
          </div>
          <div class="flex items-center">
            ${device.is_online
              ? '<span class="flex h-3 w-3"><span class="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-green-400 opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span></span>'
              : '<span class="inline-flex rounded-full h-3 w-3 bg-red-500"></span>'
            }
          </div>
        </div>

        <div class="space-y-3">
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-600">Status:</span>
            <span class="px-3 py-1 rounded-full text-sm font-semibold ${getStatusClass(device)}">
              ${getStatusText(device)}
            </span>
          </div>

          ${device.is_online ? `
            <div class="flex justify-between items-center">
              <span class="text-sm text-gray-600">Leistung:</span>
              <span class="font-semibold">${device.power?.toFixed(1) || '0.0'} W</span>
            </div>

            ${device.is_in_use ? `
              <div class="flex justify-between items-center">
                <span class="text-sm text-gray-600">Verbrauch:</span>
                <span class="font-semibold">${device.totalEnergy?.toFixed(2) || '0.00'} kWh</span>
              </div>
            ` : ''}
          ` : ''}
        </div>

        ${device.is_available && !device.is_in_use ? `
          <button onclick="startSession(${device.id})" class="mt-4 w-full bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition font-semibold">
            Gerät starten
          </button>
        ` : device.is_in_use ? `
          <div class="mt-4 bg-orange-50 border-l-4 border-orange-400 p-3 rounded">
            <p class="text-sm text-orange-800">In Benutzung</p>
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function getDeviceIcon(type) {
  if (type === 'washer') {
    return `<div class="bg-blue-100 rounded-full p-3">
      <svg class="h-8 w-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path>
      </svg>
    </div>`;
  } else {
    return `<div class="bg-orange-100 rounded-full p-3">
      <svg class="h-8 w-8 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>
      </svg>
    </div>`;
  }
}

function getStatusClass(device) {
  if (!device.is_online) return 'bg-red-100 text-red-800';
  if (device.is_in_use) return 'bg-orange-100 text-orange-800';
  if (device.is_available) return 'bg-green-100 text-green-800';
  return 'bg-gray-100 text-gray-800';
}

function getStatusText(device) {
  if (!device.is_online) return 'Offline';
  if (device.is_in_use) return 'In Benutzung';
  if (device.is_available) return 'Verfügbar';
  return 'Nicht verfügbar';
}

function updateStats() {
  const available = devices.filter(d => d.is_available && !d.is_in_use).length;
  const inUse = devices.filter(d => d.is_in_use).length;
  const online = devices.filter(d => d.is_online).length;

  document.getElementById('stat-available').textContent = available;
  document.getElementById('stat-in-use').textContent = inUse;
  document.getElementById('stat-online').textContent = `${online}/${devices.length}`;
}

// Sessions
async function startSession(deviceId) {
  if (!currentUser) {
    alert('Bitte zuerst anmelden');
    return;
  }

  if (!confirm('Möchten Sie dieses Gerät starten?')) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/sessions/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        device_id: deviceId,
        user_token: currentUser.user_token || localStorage.getItem('userToken')
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Fehler beim Starten');
    }

    alert(data.message || 'Gerät erfolgreich gestartet');
    loadDevices();
    loadUserSessions();

  } catch (error) {
    console.error('Start session error:', error);
    alert(error.message || 'Fehler beim Starten des Geräts');
  }
}

async function loadUserSessions() {
  if (!currentUser) return;

  try {
    const response = await fetch(`${API_BASE_URL}/sessions/user/${currentUser.id}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    const sessions = await response.json();

    renderUserSessions(sessions);

  } catch (error) {
    console.error('Load sessions error:', error);
  }
}

function renderUserSessions(sessions) {
  const container = document.getElementById('user-sessions');

  if (!sessions || sessions.length === 0) {
    container.innerHTML = `
      <div class="text-center py-8">
        <p class="text-gray-600">Noch keine Nutzungen</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <table class="w-full">
      <thead class="bg-gray-50">
        <tr>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Gerät</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Datum</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Verbrauch</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kosten</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200">
        ${sessions.map(session => `
          <tr class="hover:bg-gray-50">
            <td class="px-6 py-4">
              <div class="text-sm font-medium text-gray-900">${session.device_name}</div>
              <div class="text-sm text-gray-500">${session.location}</div>
            </td>
            <td class="px-6 py-4 text-sm text-gray-900">
              ${new Date(session.started_at).toLocaleString('de-CH')}
            </td>
            <td class="px-6 py-4 text-sm text-gray-900">
              ${session.energy_consumed ? session.energy_consumed.toFixed(2) + ' kWh' : '-'}
            </td>
            <td class="px-6 py-4 text-sm text-gray-900">
              ${session.cost ? 'CHF ' + session.cost.toFixed(2) : '-'}
            </td>
            <td class="px-6 py-4">
              <span class="px-2 py-1 text-xs rounded-full ${
                session.status === 'completed' ? 'bg-green-100 text-green-800' :
                session.status === 'active' ? 'bg-orange-100 text-orange-800' :
                'bg-gray-100 text-gray-800'
              }">
                ${session.status === 'completed' ? 'Abgeschlossen' :
                  session.status === 'active' ? 'Aktiv' : session.status}
              </span>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
