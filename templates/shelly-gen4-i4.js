// @inputs 1
// @params 4
// @outputs 10
// @input1 refresh: bool = false
// @param1 host: string = "192.168.1.50"
// @param2 password: string = ""
// @param3 pollInterval: timespan = 10s
// @param4 token: string = ""
// @output1 online: bool
// @output2 in1: bool
// @output3 in2: bool
// @output4 in3: bool
// @output5 in4: bool
// @output6 event1: string
// @output7 event2: string
// @output8 event3: string
// @output9 event4: string
// @output10 rssi: number
//
// Shelly i4 Gen4 und i4 DC Gen4 (Komponenten input:0 … input:3).
//
// Ausgänge:
//   in1 … in4        Zustand der Eingänge im Modus "Schalter" (nur bei Änderung).
//                    Im Modus "Taster" haben die Eingänge keinen Zustand.
//   event1 … event4  Tasterereignisse, z. B. single_push, double_push, long_push.
//                    Werden bei jedem Ereignis gesendet, auch wenn es dasselbe ist.
//
// Tasterereignisse kommen nur über den Webhook (Abfragen sehen keine Tastendrücke):
//   1. Im GPA beim Baustein einen Webhook-Pfad eintragen, z. B. shellyi4.
//   2. Im Shelly je Eingang und Ereignis eine Action anlegen mit der URL
//      http://<X1-Adresse>:61234/shellyi4?input=1&event=single_push
//      (input = 1 … 4; mit Parameter token zusätzlich &token=<token>).

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

const EVENTS = ['event1', 'event2', 'event3', 'event4'];

function handleRequest() {
  const q = node.request.query;
  if (token && q.token !== token) {
    node.respond('forbidden', { status: 403 });
    return null;
  }
  node.respond('ok');
  const n = Number(q.input);
  if (Number.isInteger(n) && n >= 1 && n <= 4 && q.event) return { [EVENTS[n - 1]]: String(q.event) };
  return {};
}

async function main() {
  let events = {};
  if (node.trigger === 'request') {
    events = handleRequest();
    if (events === null) return;
  }
  const status = await rpc('Shelly.GetStatus');
  const values = { online: true, rssi: status.wifi?.rssi };
  for (let i = 0; i < 4; i++) {
    const input = status[`input:${i}`];
    if (typeof input?.state === 'boolean') values[`in${i + 1}`] = input.state;
  }
  return { ...onlyChanged(values), ...events };
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
