import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '127.0.0.1';
const AMI_HOST = process.env.AMI_HOST || '127.0.0.1';
const AMI_PORT = Number(process.env.AMI_PORT || 5038);
const AMI_USER = process.env.AMI_USER || 'dashboard';
const AMI_SECRET = process.env.AMI_SECRET;
const GATEWAY_HOST = process.env.GATEWAY_PUBLIC_IP;
const ASTERISK_PUBLIC_IP = process.env.ASTERISK_PUBLIC_IP;
const COUNTRY_CODE = process.env.DIAL_COUNTRY_CODE;
const NATIONAL_PREFIX = process.env.DIAL_NATIONAL_PREFIX;
const LOCAL_LENGTH = Number(process.env.DIAL_LOCAL_LENGTH);
const SIP_ID = process.env.EL_SIP_ID;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname;

if (!AMI_SECRET || !DASHBOARD_TOKEN || !ASTERISK_PUBLIC_IP || !GATEWAY_HOST || !SIP_ID || !COUNTRY_CODE || !NATIONAL_PREFIX || !Number.isInteger(LOCAL_LENGTH)) {
  console.error('AMI, dashboard, SIP host, and dialling configuration are required');
  process.exit(1);
}

const calls = new Map();
const actionCallbacks = new Map();
let amiConnected = false;
let amiAuthenticated = false;
let amiSocket;
let amiBuffer = '';
let reconnectTimer;
let gateway = { state: 'unknown', detail: 'Waiting for Asterisk', checkedAt: null };

function sendAction(fields, timeoutMs = 10000) {
  if (!amiAuthenticated || !amiSocket?.writable) return Promise.reject(new Error('Asterisk manager is unavailable'));
  const actionId = fields.ActionID || randomUUID();
  const payload = { ...fields, ActionID: actionId };
  amiSocket.write(Object.entries(payload).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      actionCallbacks.delete(actionId);
      reject(new Error('Asterisk manager timed out'));
    }, timeoutMs);
    actionCallbacks.set(actionId, { resolve, reject, timer });
  });
}

function parsePacket(raw) {
  const packet = {};
  for (const line of raw.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) packet[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return packet;
}

function setCallStatus(call, status, detail) {
  if (!call || call.status === 'ended' || call.status === 'failed') return;
  call.status = status;
  call.detail = detail;
  call.updatedAt = new Date().toISOString();
  if (status === 'connected' && !call.connectedAt) call.connectedAt = call.updatedAt;
  if (status === 'ended' || status === 'failed') call.endedAt = call.updatedAt;
}

function findCallByPacket(packet) {
  const ids = [packet.uniqueid, packet.linkedid, packet.destuniqueid].filter(Boolean);
  for (const call of calls.values()) {
    if (ids.some((id) => call.uniqueIds.has(id))) return call;
    if (packet.variable === 'DASHBOARD_CALL_ID' && packet.value === call.id) return call;
  }
}

function handleEvent(packet) {
  const event = packet.event?.toLowerCase();
  if (!event) return;

  if (event === 'fullybooted') amiAuthenticated = true;
  if (event === 'contactstatus' && packet.endpointname === 'gsm-gw') {
    const available = packet.contactstatus === 'Reachable' || packet.contactstatus === 'Created';
    gateway = {
      state: available ? 'online' : 'offline',
      detail: packet.contactstatus || 'Unknown',
      latencyMs: packet.roundtripusec ? Math.round(Number(packet.roundtripusec) / 1000) : null,
      checkedAt: new Date().toISOString(),
    };
  }
  if (event === 'contactlist' && (packet.endpointname === 'gsm-gw' || packet.objectname?.startsWith('gsm-gw/'))) {
    const available = packet.status === 'Reachable' || packet.status === 'Avail' || packet.status === 'Created';
    gateway = {
      state: available ? 'online' : 'offline',
      detail: packet.status || 'Unknown',
      latencyMs: packet.roundtripusec ? Math.round(Number(packet.roundtripusec) / 1000) : null,
      checkedAt: new Date().toISOString(),
    };
  }

  if (event === 'originateresponse') {
    const call = calls.get(packet.actionid);
    if (!call) return;
    if (packet.uniqueid) call.uniqueIds.add(packet.uniqueid);
    if (packet.response === 'Success') setCallStatus(call, 'connected', 'Mobile answered; AI agent connected');
    else setCallStatus(call, 'failed', packet.reason === '5' ? 'Mobile rejected or unavailable' : (packet.response || 'Originate failed'));
    return;
  }

  const call = findCallByPacket(packet);
  if (!call) return;
  for (const id of [packet.uniqueid, packet.linkedid, packet.destuniqueid]) if (id) call.uniqueIds.add(id);
  if (packet.channel) call.channels.add(packet.channel);
  if (packet.destchannel) call.channels.add(packet.destchannel);

  if (event === 'newstate' && packet.channelstatedesc === 'Ringing') setCallStatus(call, 'ringing', 'Ringing mobile');
  if (event === 'bridgeenter') setCallStatus(call, 'connected', 'Mobile and AI agent bridged');
  if (event === 'hangup') {
    const normal = packet.cause === '16';
    setCallStatus(call, normal ? 'ended' : 'failed', packet['cause-txt'] || `Hangup cause ${packet.cause || 'unknown'}`);
  }
}

function connectAmi() {
  clearTimeout(reconnectTimer);
  amiSocket = net.createConnection({ host: AMI_HOST, port: AMI_PORT });
  amiSocket.setKeepAlive(true, 10000);
  amiSocket.on('connect', () => {
    amiConnected = true;
    amiSocket.write(`Action: Login\r\nUsername: ${AMI_USER}\r\nSecret: ${AMI_SECRET}\r\nEvents: on\r\n\r\n`);
  });
  amiSocket.on('data', (chunk) => {
    amiBuffer += chunk.toString('utf8');
    let boundary;
    while ((boundary = amiBuffer.indexOf('\r\n\r\n')) >= 0) {
      const raw = amiBuffer.slice(0, boundary);
      amiBuffer = amiBuffer.slice(boundary + 4);
      if (!raw || raw.startsWith('Asterisk Call Manager/')) continue;
      const packet = parsePacket(raw);
      if (packet.response === 'Success' && packet.message === 'Authentication accepted') {
        amiAuthenticated = true;
        Promise.allSettled([
          sendAction({ Action: 'PJSIPShowContacts' }),
          sendAction({ Action: 'PJSIPQualify', Endpoint: 'gsm-gw' }),
        ]).then((results) => {
          for (const result of results) if (result.status === 'rejected') console.error(`Contact check failed: ${result.reason.message}`);
        });
      }
      const pending = packet.actionid && actionCallbacks.get(packet.actionid);
      if (pending && packet.response) {
        clearTimeout(pending.timer);
        actionCallbacks.delete(packet.actionid);
        packet.response === 'Error' ? pending.reject(new Error(packet.message || 'Asterisk rejected the action')) : pending.resolve(packet);
      }
      handleEvent(packet);
    }
  });
  const disconnected = () => {
    amiConnected = false;
    amiAuthenticated = false;
    for (const { reject, timer } of actionCallbacks.values()) {
      clearTimeout(timer);
      reject(new Error('Asterisk manager disconnected'));
    }
    actionCallbacks.clear();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectAmi, 3000);
  };
  amiSocket.once('close', disconnected);
  amiSocket.once('error', (error) => console.error(`AMI connection error: ${error.message}`));
}

function normalizeNumber(input) {
  const value = String(input || '').replace(/[\s().-]/g, '');
  const localPattern = new RegExp(`^[0-9]{${LOCAL_LENGTH}}$`);
  const national = value.startsWith(NATIONAL_PREFIX) ? value.slice(NATIONAL_PREFIX.length) : value;
  if (localPattern.test(national) && (value === national || value === `${NATIONAL_PREFIX}${national}`)) {
    return `${NATIONAL_PREFIX}${national}`;
  }
  if (value.startsWith(`+${COUNTRY_CODE}`) && localPattern.test(value.slice(COUNTRY_CODE.length + 1))) {
    return `${NATIONAL_PREFIX}${value.slice(COUNTRY_CODE.length + 1)}`;
  }
  throw new Error(`Use a national number or +${COUNTRY_CODE} followed by ${LOCAL_LENGTH} digits`);
}

function checkGateway() {
  if (!GATEWAY_HOST) return;
  const socket = dgram.createSocket('udp4');
  const started = Date.now();
  let settled = false;
  const finish = (state, detail) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    gateway = {
      state,
      detail,
      latencyMs: state === 'online' ? Date.now() - started : null,
      checkedAt: new Date().toISOString(),
    };
    socket.close();
  };
  const timer = setTimeout(() => finish('offline', 'No SIP response'), 3000);
  socket.once('error', () => finish('offline', 'SIP check failed'));
  socket.once('message', (message) => {
    const response = message.toString('utf8');
    finish(response.startsWith('SIP/2.0 ') ? 'online' : 'offline', response.startsWith('SIP/2.0 ') ? 'SIP responding' : 'Invalid SIP response');
  });
  socket.bind(0, '0.0.0.0', () => {
    const port = socket.address().port;
    const branch = randomUUID().replaceAll('-', '');
    const payload = [
      `OPTIONS sip:${GATEWAY_HOST}:5060 SIP/2.0`,
      `Via: SIP/2.0/UDP ${ASTERISK_PUBLIC_IP}:${port};rport;branch=z9hG4bK${branch}`,
      'Max-Forwards: 1',
      `From: <sip:dashboard@${ASTERISK_PUBLIC_IP}>;tag=${branch.slice(0, 8)}`,
      `To: <sip:${GATEWAY_HOST}>`,
      `Call-ID: ${branch}@${ASTERISK_PUBLIC_IP}`,
      'CSeq: 1 OPTIONS',
      'User-Agent: GSM-Voice-Console',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');
    socket.send(payload, 5060, GATEWAY_HOST);
  });
}
function isAuthorized(req) {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const expected = Buffer.from(DASHBOARD_TOKEN);

  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

function publicCall(call) {
  return { ...call, uniqueIds: undefined, channels: undefined };
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req)) return json(res, 401, { error: 'Invalid dashboard token' });

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const history = [...calls.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25).map(publicCall);
    return json(res, 200, {
      asterisk: { state: amiAuthenticated ? 'online' : 'offline', detail: amiAuthenticated ? 'AMI connected' : 'AMI disconnected' },
      gateway,
      activeCalls: history.filter((call) => !['ended', 'failed'].includes(call.status)).length,
      calls: history,
      now: new Date().toISOString(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/calls') {
    try {
      const { number } = await readJson(req);
      const normalized = normalizeNumber(number);
      const existing = [...calls.values()].find((call) => call.number === normalized && !['ended', 'failed'].includes(call.status));
      if (existing) return json(res, 409, { error: 'A call to this number is already active' });
      const id = randomUUID();
      const call = {
        id,
        number: normalized,
        displayNumber: `+${COUNTRY_CODE} ${normalized.slice(NATIONAL_PREFIX.length)}`,
        status: 'starting',
        detail: 'Sending call to GSM gateway',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        connectedAt: null,
        endedAt: null,
        uniqueIds: new Set([id]),
        channels: new Set(),
      };
      calls.set(id, call);
      sendAction({
        Action: 'Originate',
        ActionID: id,
        Channel: `PJSIP/${normalized}@gsm-gw`,
        ChannelId: id,
        Variable: `DASHBOARD_CALL_ID=${id}`,
        Application: 'Dial',
        Data: `PJSIP/${SIP_ID}@elevenlabs,120`,
        CallerID: `GSM AI <${SIP_ID}>`,
        Timeout: '60000',
        Async: 'true',
      }).catch((error) => setCallStatus(call, 'failed', error.message));
      setCallStatus(call, 'ringing', 'Waiting for mobile to answer');
      return json(res, 202, publicCall(call));
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  const hangupMatch = req.method === 'POST' && url.pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/hangup$/);
  if (hangupMatch) {
    const call = calls.get(hangupMatch[1]);
    if (!call) return json(res, 404, { error: 'Call not found' });
    if (['ended', 'failed'].includes(call.status)) return json(res, 409, { error: 'Call already finished' });
    const channel = [...call.channels].find((name) => name.startsWith('PJSIP/gsm-gw')) || [...call.channels][0];
    if (!channel) return json(res, 409, { error: 'Call channel is not available yet' });
    try {
      await sendAction({ Action: 'Hangup', Channel: channel, Cause: '16' });
      setCallStatus(call, 'ended', 'Ended from dashboard');
      return json(res, 200, publicCall(call));
    } catch (error) {
      return json(res, 502, { error: error.message });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return json(res, 404, { error: 'Not found' });
    const content = await readFile(join(PUBLIC_DIR, fileName));
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(fileName)] || 'application/octet-stream',
      'Cache-Control': fileName === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    console.error(error);
    return json(res, 500, { error: 'Internal server error' });
  }
});

checkGateway();
setInterval(checkGateway, 15000);
setInterval(() => {
  if (amiAuthenticated) {
    sendAction({ Action: 'PJSIPShowContacts' }).catch(() => {});
    sendAction({ Action: 'PJSIPQualify', Endpoint: 'gsm-gw' }).catch(() => {});
  }
}, 30000);

connectAmi();
server.listen(PORT, HOST, () => console.log(`GSM call dashboard listening on http://${HOST}:${PORT}`));
