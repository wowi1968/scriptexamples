// @inputs 1
// @params 4
// @outputs 10
// @input1 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @param4 channel: integer = 0 [0..]
// @output1 online: bool
// @output2 power: number
// @output3 current: number
// @output4 voltage: number
// @output5 frequency: number
// @output6 powerFactor: number
// @output7 energy: number
// @output8 returnedEnergy: number
// @output9 rssi: number
// @output10 errors: string
//
// Shelly-Energiemesser der Gen4, z. B. EM Mini Gen4 (Komponente pm1 oder em1/em1data).
//
// Parameter:
//   channel  Messkanal (0 = erster). Bei Geräten mit einem Kanal 0 lassen.
// Ausgänge (nur bei Änderung):
//   power           Wirkleistung in W (negativ bei Einspeisung).
//   current         Strom in A.
//   voltage         Spannung in V.
//   frequency       Netzfrequenz in Hz.
//   powerFactor     Leistungsfaktor.
//   energy          Bezogene Energie in kWh.
//   returnedEnergy  Eingespeiste Energie in kWh.

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

async function main() {
  if (node.trigger === 'request') node.respond('ok');
  const status = await rpc('Shelly.GetStatus');
  const values = { online: true, rssi: status.wifi?.rssi };
  const pm = status[`pm1:${channel}`];
  const em = status[`em1:${channel}`];
  if (pm) {
    Object.assign(values, {
      power: round(pm.apower, 1),
      current: round(pm.current, 3),
      voltage: round(pm.voltage, 1),
      frequency: round(pm.freq, 2),
      powerFactor: round(pm.pf, 2),
      energy: kwh(pm.aenergy),
      returnedEnergy: kwh(pm.ret_aenergy),
      errors: errorList(pm.errors).join(', '),
    });
  } else if (em) {
    const data = status[`em1data:${channel}`];
    Object.assign(values, {
      power: round(em.act_power, 1),
      current: round(em.current, 3),
      voltage: round(em.voltage, 1),
      frequency: round(em.freq, 2),
      powerFactor: round(em.pf, 2),
      energy: round(data?.total_act_energy / 1000, 3),
      returnedEnergy: round(data?.total_act_ret_energy / 1000, 3),
      errors: errorList(em.errors).join(', '),
    });
  } else {
    throw new Error(`Weder pm1:${channel} noch em1:${channel} gefunden – Kanal oder Gerät prüfen.`);
  }
  return onlyChanged(values);
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
