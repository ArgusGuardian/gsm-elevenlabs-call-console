const authDialog = document.querySelector('#auth-dialog');
const authForm = document.querySelector('#auth-form');
const authMessage = document.querySelector('#auth-message');
const tokenInput = document.querySelector('#token');
const callForm = document.querySelector('#call-form');
const callButton = document.querySelector('#call-button');
const phoneInput = document.querySelector('#phone');
const formMessage = document.querySelector('#form-message');
const callList = document.querySelector('#call-list');
const refreshButton = document.querySelector('#refresh-button');
let token = sessionStorage.getItem('dashboardToken') || '';
let refreshTimer;

const statusLabels = {
  starting: 'Starting',
  ringing: 'Ringing',
  connected: 'Connected',
  ended: 'Ended',
  failed: 'Failed',
};

function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    sessionStorage.removeItem('dashboardToken');
    token = '';
    if (!authDialog.open) authDialog.showModal();
    throw new Error('Dashboard token is invalid');
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setSystemStatus(id, status) {
  const label = document.querySelector(`#${id}-label`);
  const dot = document.querySelector(`#${id}-dot`);
  const online = status.state === 'online';
  label.textContent = online ? (id === 'gateway' && status.latencyMs ? `Online · ${status.latencyMs} ms` : 'Online') : (status.detail || 'Offline');
  dot.className = `status-dot ${online ? 'online' : 'offline'}`;
}

function elapsed(call) {
  const start = new Date(call.connectedAt || call.createdAt).getTime();
  const end = call.endedAt ? new Date(call.endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderCalls(calls) {
  if (!calls.length) {
    callList.innerHTML = '<div class="empty-state"><div class="empty-orbit"><span>↗</span></div><h3>No calls yet</h3><p>Started calls and their live state will appear here.</p></div>';
    return;
  }
  callList.innerHTML = calls.map((call) => {
    const active = ['starting', 'ringing', 'connected'].includes(call.status);
    const safeId = escapeHtml(call.id);
    return `<div class="call-row ${active ? 'active' : ''}">
      <div class="call-row-icon">${call.status === 'connected' ? '◖' : '↗'}</div>
      <div>
        <div class="call-number">${escapeHtml(call.displayNumber)}</div>
        <div class="call-detail">${escapeHtml(call.detail)}</div>
      </div>
      <div class="call-meta">
        <span class="badge ${escapeHtml(call.status)}">${escapeHtml(statusLabels[call.status] || call.status)}</span>
        <span class="call-time">${elapsed(call)}</span>
        ${active ? `<button type="button" class="hangup" data-call-id="${safeId}">End call</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function refreshStatus() {
  if (!token) return;
  try {
    const status = await api('/api/status');
    setSystemStatus('asterisk', status.asterisk);
    setSystemStatus('gateway', status.gateway);
    document.querySelector('#active-count').textContent = status.activeCalls;
    document.querySelector('#last-update').textContent = `updated ${new Date(status.now).toLocaleTimeString()}`;
    renderCalls(status.calls);
  } catch (error) {
    if (token) {
      document.querySelector('#asterisk-label').textContent = 'Unavailable';
      document.querySelector('#asterisk-dot').className = 'status-dot offline';
    }
  }
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshStatus();
  refreshTimer = setInterval(refreshStatus, 2000);
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  token = tokenInput.value.trim();
  authMessage.textContent = '';
  try {
    await api('/api/status');
    sessionStorage.setItem('dashboardToken', token);
    authDialog.close();
    startRefresh();
  } catch (error) {
    authMessage.textContent = error.message;
  }
});

callForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const number = phoneInput.value.trim();
  callButton.disabled = true;
  formMessage.className = 'form-message';
  formMessage.textContent = '';
  try {
    await api('/api/calls', { method: 'POST', body: JSON.stringify({ number }) });
    formMessage.className = 'form-message success';
    formMessage.textContent = 'Call sent. Live status appears on the right.';
    phoneInput.value = '';
    await refreshStatus();
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    callButton.disabled = false;
  }
});

callList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-call-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/calls/${button.dataset.callId}/hangup`, { method: 'POST' });
    await refreshStatus();
  } catch (error) {
    formMessage.textContent = error.message;
    button.disabled = false;
  }
});

refreshButton.addEventListener('click', refreshStatus);
setInterval(() => { document.querySelector('#clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);

if (token) startRefresh();
else authDialog.showModal();
