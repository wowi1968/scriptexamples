// @inputs 3
// @params 3
// @outputs 10
// @input1 setOn: bool = false
// @input2 setBrightness: integer = 0 [0..100]
// @input3 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @output1 online: bool
// @output2 on: bool
// @output3 brightness: integer
// @output4 power: number
// @output5 current: number
// @output6 energy: number
// @output7 voltage: number
// @output8 temperature: number
// @output9 rssi: number
// @output10 errors: string
//
// Shelly Dimmer Gen4 und Dimmer 0/1-10V PM Gen4 (Komponente light:0).
//
// Eingänge:
//   setOn          true = ein (mit der letzten Helligkeit), false = aus.
//   setBrightness  Helligkeit 0 … 100 %; 0 schaltet aus, alles andere schaltet ein.
//   refresh        Jeder Wert fragt den Status sofort ab.
// Ausgänge (nur bei Änderung):
//   on, brightness  Zustand und Helligkeit des Dimmers.
//   power, current, energy, voltage, temperature, rssi, errors  wie bei den Schaltern;
//   Werte, die das Gerät nicht misst, bleiben leer.

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
  if (node.trigger === 'input') {
    if (node.changed.includes('setBrightness')) {
      await rpc('Light.Set', setBrightness > 0 ? { id: 0, on: true, brightness: setBrightness } : { id: 0, on: false });
    } else if (node.changed.includes('setOn')) {
      await rpc('Light.Set', { id: 0, on: setOn });
    }
  }
  const status = await rpc('Shelly.GetStatus');
  const l = status['light:0'];
  if (!l) throw new Error('Keine Komponente light:0 – ist das ein Dimmer?');
  return onlyChanged({
    online: true,
    on: l.output,
    brightness: Number.isFinite(l.brightness) ? Math.round(l.brightness) : undefined,
    power: round(l.apower, 1),
    current: round(l.current, 2),
    energy: kwh(l.aenergy),
    voltage: round(l.voltage, 1),
    temperature: round(l.temperature?.tC, 1),
    rssi: status.wifi?.rssi,
    errors: errorList(l.errors).join(', '),
  });
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
