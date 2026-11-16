// @inputs 4
// @params 4
// @outputs 11
// @input1 move: bool = false
// @input2 stop: bool = false
// @input3 setPosition: integer = 0 [0..100]
// @input4 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @param4 knxPosition: bool = true
// @output1 online: bool
// @output2 state: string
// @output3 moving: bool
// @output4 position: integer
// @output5 power: number
// @output6 current: number
// @output7 energy: number
// @output8 voltage: number
// @output9 temperature: number
// @output10 rssi: number
// @output11 errors: string
//
// Shelly Gen4 im Rollladen-Profil (cover), z. B. Shelly 2PM Gen4.
//
// Eingänge:
//   move         false = auf, true = ab (wie KNX "Auf/Ab").
//   stop         Jeder Wert hält an (wie KNX "Stopp/Lamellen").
//   setPosition  Position 0 … 100 % anfahren (Rollladen muss kalibriert sein).
//   refresh      Jeder Wert fragt den Status sofort ab.
// Parameter:
//   host, password, pollInterval  siehe Schalter-Skripte.
//   knxPosition  true: 0 % = offen, 100 % = zu (KNX); false: wie Shelly (100 % = offen).
// Ausgänge (nur bei Änderung):
//   state        open, closed, opening, closing, stopped oder calibrating.
//   moving       true, solange der Rollladen fährt.
//   position     Aktuelle Position (leer bleibt sie, solange nicht kalibriert).
//   power, current, energy, voltage, temperature, rssi, errors  wie bei den Schaltern.

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

function toShelly(pos) {
  return knxPosition ? 100 - pos : pos;
}

async function main() {
  if (node.trigger === 'request') node.respond('ok');
  if (node.trigger === 'input') {
    if (node.changed.includes('stop')) await rpc('Cover.Stop', { id: 0 });
    else if (node.changed.includes('setPosition')) await rpc('Cover.GoToPosition', { id: 0, pos: toShelly(setPosition) });
    else if (node.changed.includes('move')) await rpc(move ? 'Cover.Close' : 'Cover.Open', { id: 0 });
  }
  const status = await rpc('Shelly.GetStatus');
  const c = status['cover:0'];
  if (!c) throw new Error('Keine Komponente cover:0 – ist der Shelly im Rollladen-Profil (cover)?');
  return onlyChanged({
    online: true,
    state: c.state,
    moving: c.state === 'opening' || c.state === 'closing',
    position: Number.isInteger(c.current_pos) ? toShelly(c.current_pos) : undefined,
    power: round(c.apower, 1),
    current: round(c.current, 2),
    energy: kwh(c.aenergy),
    voltage: round(c.voltage, 1),
    temperature: round(c.temperature?.tC, 1),
    rssi: status.wifi?.rssi,
    errors: errorList(c.errors).join(', '),
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
