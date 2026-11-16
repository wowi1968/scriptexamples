// @inputs 3
// @params 3
// @outputs 13
// @input1 relay1: bool = false
// @input2 relay2: bool = false
// @input3 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @output1 online: bool
// @output2 on1: bool
// @output3 power1: number
// @output4 current1: number
// @output5 energy1: number
// @output6 on2: bool
// @output7 power2: number
// @output8 current2: number
// @output9 energy2: number
// @output10 voltage: number
// @output11 temperature: number
// @output12 rssi: number
// @output13 errors: string
//
// Shelly 2PM Gen4 (Profil "switch") über die lokale RPC-API steuern und abfragen.
//
// Eingänge:
//   relay1, relay2  Schaltet Kanal 1 bzw. 2 (true = ein, false = aus).
//   refresh         Jeder Wert fragt den Status sofort ab.
// Parameter:
//   host            IP-Adresse oder Name des Shelly.
//   password        Passwort des Shelly (Benutzer "admin"); leer, wenn kein Passwort gesetzt ist.
//   pollInterval    Abfrage-Intervall (mindestens 1 s).
// Ausgänge (werden nur bei Änderung gesendet):
//   online          false, wenn der Shelly nicht antwortet.
//   on1/on2         Schaltzustand der Kanäle.
//   power1/power2   Wirkleistung in W.
//   current1/2      Strom in A.
//   energy1/2       Zählerstand in kWh (seit Werksreset bzw. Zählerreset des Shelly).
//   voltage         Netzspannung in V.
//   temperature     Gerätetemperatur in °C.
//   rssi            WLAN-Signalstärke in dBm.
//   errors          Fehler des Shelly, z. B. "overtemp, overpower"; leer, wenn keine.
//
// Optional: Mit einem Webhook-Pfad (Parameter im GPA) löst jeder Aufruf eine sofortige
// Abfrage aus. Im Shelly unter "Actions" bei "Output on/off" die URL
// http://<X1-Adresse>:61234/<pfad> eintragen, dann kommen Änderungen ohne Wartezeit an.

const TIMEOUT_S = 3;                        // knapp halten: Die Logik wartet auf die Antwort.
const POLL_MS = Math.max(1000, pollInterval);

// ---------------------------------------------------------------------------
// RPC mit optionaler Digest-Authentifizierung (SHA-256, Benutzer "admin")
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Status auswerten
// ---------------------------------------------------------------------------

function round(value, digits) {
  if (typeof value !== 'number') return undefined;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function mapStatus(status) {
  const ch0 = status['switch:0'];
  const ch1 = status['switch:1'];
  if (!ch0 || !ch1) {
    throw new Error('Keine Kanäle switch:0/switch:1 – ist der Shelly im Rollladen-Profil (cover)?');
  }
  const errors = [...(ch0.errors ?? []).map(e => `K1: ${e}`), ...(ch1.errors ?? []).map(e => `K2: ${e}`)];
  return {
    online: true,
    on1: ch0.output,
    power1: round(ch0.apower, 1),
    current1: round(ch0.current, 2),
    energy1: round((ch0.aenergy?.total ?? NaN) / 1000, 3),
    on2: ch1.output,
    power2: round(ch1.apower, 1),
    current2: round(ch1.current, 2),
    energy2: round((ch1.aenergy?.total ?? NaN) / 1000, 3),
    voltage: round(ch0.voltage ?? ch1.voltage, 1),
    temperature: round(ch0.temperature?.tC ?? ch1.temperature?.tC, 1),
    rssi: status.wifi?.rssi,
    errors: errors.join(', '),
  };
}

// Nur geänderte Werte senden (schont den Bus).
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

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

if (node.trigger === 'startup') node.every(POLL_MS, 'poll');
if (node.trigger === 'request') node.respond('ok');

try {
  if (node.trigger === 'input') {
    if (node.changed.includes('relay1')) await rpc('Switch.Set', { id: 0, on: relay1 });
    if (node.changed.includes('relay2')) await rpc('Switch.Set', { id: 1, on: relay2 });
  }
  const status = await rpc('Shelly.GetStatus');
  return onlyChanged(mapStatus(status));
} catch (e) {
  if (!e.offline) throw e;                  // Auth-/RPC-Fehler → Ausgang "Fehler"
  if (node.state.last?.online !== false) console.warn(e.message);
  return onlyChanged({ online: false });
}
