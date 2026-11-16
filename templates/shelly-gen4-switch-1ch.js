// @inputs 2
// @params 3
// @outputs 9
// @input1 relay1: bool = false
// @input2 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @output1 online: bool
// @output2 on1: bool
// @output3 power1: number
// @output4 current1: number
// @output5 energy1: number
// @output6 voltage: number
// @output7 temperature: number
// @output8 rssi: number
// @output9 errors: string
//
// Shelly Gen4 mit 1 Schaltkanal (Komponente switch:0).
//
// Eingänge:
//   relay1  true = ein, false = aus.
//   refresh  Jeder Wert fragt den Status sofort ab.
// Parameter:
//   host          IP-Adresse oder Name des Shelly.
//   password      Passwort des Shelly (Benutzer "admin"); leer, wenn keins gesetzt ist.
//   pollInterval  Abfrage-Intervall (mindestens 1 s).
// Ausgänge (nur bei Änderung):
//   online        false, wenn der Shelly nicht antwortet.
//   onN           Schaltzustand des Kanals N.
//   powerN        Wirkleistung in W.        } Bleiben leer bei Geräten
//   currentN      Strom in A.               } ohne Leistungsmessung
//   energyN       Zählerstand in kWh.       } (z. B. Shelly 1 Gen4).
//   voltage       Netzspannung in V.
//   temperature   Gerätetemperatur in °C.
//   rssi          WLAN-Signalstärke in dBm.
//   errors        Fehler des Shelly, z. B. "overtemp"; leer, wenn keine.
//
// Optional: Mit einem Webhook-Pfad (Parameter im GPA) löst jeder Aufruf eine sofortige
// Abfrage aus. Im Shelly unter "Actions" bei "Output on/off" die URL
// http://<X1-Adresse>:61234/<pfad> eintragen, dann kommen Änderungen ohne Wartezeit an.

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

const CHANNELS = 1;
const RELAYS = [relay1];

async function main() {
  if (node.trigger === 'request') node.respond('ok');
  if (node.trigger === 'input') {
    for (let i = 0; i < CHANNELS; i++) {
      if (node.changed.includes(`relay${i + 1}`)) await rpc('Switch.Set', { id: i, on: RELAYS[i] });
    }
  }
  const status = await rpc('Shelly.GetStatus');
  const values = { online: true };
  const errors = [];
  for (let i = 0; i < CHANNELS; i++) {
    const c = status[`switch:${i}`];
    if (!c) throw new Error(`Keine Komponente switch:${i} – passt das Skript zum Gerät bzw. Profil?`);
    const n = i + 1;
    values[`on${n}`] = c.output;
    values[`power${n}`] = round(c.apower, 1);
    values[`current${n}`] = round(c.current, 2);
    values[`energy${n}`] = kwh(c.aenergy);
    errors.push(...errorList(c.errors, CHANNELS > 1 ? `K${n}` : ''));
  }
  const first = status['switch:0'];
  values.voltage = round(first.voltage, 1);
  values.temperature = round(first.temperature?.tC, 1);
  values.rssi = status.wifi?.rssi;
  values.errors = errors.join(', ');
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
