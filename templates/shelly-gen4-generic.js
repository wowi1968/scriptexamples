// @inputs 2
// @params 7
// @outputs 6
// @input1 call: string = ""
// @input2 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @param4 path1: string = ""
// @param5 path2: string = ""
// @param6 path3: string = ""
// @param7 path4: string = ""
// @output1 online: bool
// @output2 value1
// @output3 value2
// @output4 value3
// @output5 value4
// @output6 result
//
// Allgemeines Skript für jeden Shelly ab Gen2, z. B. Presence Gen4 oder Geräte ohne
// eigenes Skript.
//
// Eingänge:
//   call     Ein RPC-Aufruf: Methode und optional Parameter als JSON, z. B.
//            Switch.Set {"id":0,"on":true}   oder   Shelly.Reboot
//   refresh  Jeder Wert fragt den Status sofort ab.
// Parameter:
//   path1 … path4  Pfade in Shelly.GetStatus, z. B. switch:0.apower, wifi.rssi,
//                  presence:0.value. Leer: Ausgang unbenutzt.
//                  Welche Pfade es gibt, zeigt http://<shelly>/rpc/Shelly.GetStatus.
// Ausgänge:
//   value1 … value4  Die Werte der Pfade (nur bei Änderung; Objekte als JSON).
//   result           Antwort des letzten call als JSON.

// ---------------------------------------------------------------------------
// Gemeinsamer Teil: RPC über HTTP mit optionaler Digest-Authentifizierung
// (SHA-256, Benutzer "admin"), Runden, nur Änderungen senden.
// ---------------------------------------------------------------------------

const TIMEOUT_S = 3;                        // knapp halten: Die Logik wartet auf die Antwort.

function parseChallenge(header) {
  const challenge = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    challenge[m[1]] = m[2] ?? m[3];
  }
  return challenge;
}

function digestHeader(challenge) {
  node.state.nc = (node.state.nc ?? 0) + 1;
  const nc = node.state.nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8);
  const ha1 = crypto.hash('sha256', `admin:${challenge.realm}:${password}`);
  const ha2 = crypto.hash('sha256', 'POST:/rpc');
  const response = crypto.hash('sha256', `${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="admin", realm="${challenge.realm}", nonce="${challenge.nonce}", ` +
    `uri="/rpc", algorithm=SHA-256, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

async function send(body, challenge) {
  const headers = { 'Content-Type': 'application/json' };
  if (challenge && password) headers.Authorization = digestHeader(challenge);
  try {
    return await fetch(`http://${host}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeout: TIMEOUT_S,
    });
  } catch (e) {
    const err = new Error(`Shelly ${host} nicht erreichbar: ${e.message}`);
    err.offline = true;
    throw err;
  }
}

async function rpc(method, params = {}) {
  const body = { id: 1, method, params };
  let res = await send(body, node.state.challenge);
  if (res.status === 401) {
    if (!password) throw new Error('Der Shelly verlangt ein Passwort (Parameter password).');
    const header = res.headers.get('www-authenticate');
    if (!header) throw new Error('401 ohne WWW-Authenticate-Header.');
    node.state.challenge = parseChallenge(header);
    node.state.nc = 0;
    res = await send(body, node.state.challenge);
    if (res.status === 401) throw new Error('Anmeldung am Shelly fehlgeschlagen (Passwort prüfen).');
  }
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message} (Code ${data.error.code})`);
  return data.result;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return undefined;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Energiezähler des Shelly (Wh) in kWh.
function kwh(counter) {
  return round(counter?.total / 1000, 3);
}

// Fehlerliste einer Komponente, z. B. ["overtemp"] → ["K1: overtemp"].
function errorList(list, prefix) {
  return (list ?? []).map(e => (prefix ? `${prefix}: ${e}` : e));
}

// Nur geänderte Werte senden (schont den Bus). undefined/null lässt den Ausgang unverändert.
function onlyChanged(values) {
  const last = (node.state.last ??= {});
  const out = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || Number.isNaN(value)) continue;
    if (last[name] !== value) {
      out[name] = value;
      last[name] = value;
    }
  }
  return out;
}

const PATHS = [path1, path2, path3, path4];

function pick(obj, path) {
  return path.split('.').reduce((value, key) => value?.[key], obj);
}

async function main() {
  if (node.trigger === 'request') node.respond('ok');
  let result;
  if (node.trigger === 'input' && node.changed.includes('call') && call.trim()) {
    const m = call.trim().match(/^([\w.]+)\s*(.*)$/s);
    if (!m) throw new Error(`call nicht lesbar: ${call}`);
    const params = m[2] ? JSON.parse(m[2]) : {};
    result = JSON.stringify(await rpc(m[1], params) ?? null);
  }
  const status = await rpc('Shelly.GetStatus');
  const values = { online: true };
  PATHS.forEach((path, i) => {
    if (!path) return;
    const value = pick(status, path);
    values[`value${i + 1}`] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  });
  return { ...onlyChanged(values), ...(result !== undefined ? { result } : {}) };
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

if (node.trigger === 'startup') node.every(Math.max(1000, pollInterval), 'poll');

try {
  return await main();
} catch (e) {
  if (!e.offline) throw e;                  // Auth-/RPC-Fehler → Ausgang "Fehler"
  if (node.state.last?.online !== false) console.warn(e.message);
  return onlyChanged({ online: false });
}
