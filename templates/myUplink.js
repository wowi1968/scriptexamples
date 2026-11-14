// myUplink: liest Datenpunkte einer Wärmepumpe (NIBE, CTC, ...) aus dem myUplink-Portal.
// @inputs 1
// @params 13
// @outputs 9
// @input1 refresh: bool = false
// @param1 clientId: string
// @param2 clientSecret: string
// @param3 deviceId: string = ""
// @param4 interval: timespan = 5min
// @param5 language: string = "en-GB"
// @param6 point1: string = ""
// @param7 point2: string = ""
// @param8 point3: string = ""
// @param9 point4: string = ""
// @param10 point5: string = ""
// @param11 point6: string = ""
// @param12 point7: string = ""
// @param13 point8: string = ""
// @output1 value1
// @output2 value2
// @output3 value3
// @output4 value4
// @output5 value5
// @output6 value6
// @output7 value7
// @output8 value8
// @output9 data: string
//
// Zugang: Auf https://dev.myuplink.com eine App anlegen (Callback-URL beliebig,
// z. B. https://localhost), Client ID und Client Secret in clientId/clientSecret eintragen.
// Das Skript meldet sich per OAuth2 "client_credentials" an.
//
// point1 ... point8: parameterId (z. B. "40004") oder parameterName
// (z. B. "Outdoor temperature", in der Sprache von language). IDs sind robuster.
// value1 ... value8: der Zahlenwert des Datenpunkts.
// data: alle gewählten Datenpunkte als JSON, z. B.
//   {"40004":{"name":"Outdoor temperature","value":5.3,"unit":"°C","text":"5.3°C","time":"..."}}
//
// deviceId leer: das erste Gerät des Kontos. Abfrage alle interval (mindestens 1 min),
// zusätzlich bei refresh = true.

const API = 'https://api.myuplink.com';
const MIN_INTERVAL = 60 * 1000;

if (node.trigger === 'startup') {
  node.every(Math.max(interval, MIN_INTERVAL), 'poll');
} else if (node.trigger === 'input' && !refresh) {
  return;
}

const st = node.state;

async function getToken(force) {
  if (!force && st.token && st.tokenExpires > node.now() + 60 * 1000) return st.token;
  const body = 'grant_type=client_credentials'
    + `&client_id=${encodeURIComponent(clientId)}`
    + `&client_secret=${encodeURIComponent(clientSecret)}`
    + '&scope=' + encodeURIComponent('READSYSTEM WRITESYSTEM');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeout: 15,
  });
  if (!res.ok) throw new Error(`myUplink-Anmeldung fehlgeschlagen: HTTP ${res.status} ${await res.text()}`);
  const t = await res.json();
  st.token = t.access_token;
  st.tokenExpires = node.now() + (t.expires_in || 3600) * 1000;
  return st.token;
}

async function api(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Language': language || 'en-GB' },
      timeout: 20,
    });
    if (res.status === 401 && attempt === 0) continue; // Token abgelaufen: neu anmelden
    if (!res.ok) throw new Error(`myUplink ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }
}

async function getDeviceId() {
  if (deviceId) return deviceId;
  if (st.deviceId) return st.deviceId;
  const me = await api('/v2/systems/me');
  const device = me.systems?.[0]?.devices?.[0];
  if (!device) throw new Error('Kein Gerät im myUplink-Konto gefunden');
  console.info(`myUplink: Gerät ${device.id} (${device.product?.name}) im System ${me.systems[0].name}`);
  st.deviceId = device.id;
  return device.id;
}

// Namen vergleichen ohne weiche Trennstriche (U+00AD), Groß-/Kleinschreibung und Leerzeichen
const norm = (s) => String(s ?? '').replace(/­/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const selected = [point1, point2, point3, point4, point5, point6, point7, point8]
  .map((p) => String(p ?? '').trim());
const used = selected.filter((p) => p !== '');
const isId = (p) => /^\d+$/.test(p);

const id = await getDeviceId();
// Nur IDs: gezielt abfragen; mit Namen: alle Punkte holen und suchen
const query = used.length && used.every(isId) ? `?parameters=${used.join(',')}` : '';
const points = await api(`/v2/devices/${encodeURIComponent(id)}/points${query}`);

const byId = new Map(points.map((p) => [String(p.parameterId), p]));
const byName = new Map(points.map((p) => [norm(p.parameterName), p]));

const result = {};
const data = {};
selected.forEach((sel, i) => {
  if (!sel) return;
  const p = isId(sel) ? byId.get(sel) : byName.get(norm(sel));
  if (!p) {
    console.warn(`myUplink: Datenpunkt "${sel}" nicht gefunden`);
    return;
  }
  result[`value${i + 1}`] = p.value;
  data[p.parameterId] = {
    name: String(p.parameterName).replace(/­/g, ''),
    value: p.value,
    unit: p.parameterUnit,
    text: p.strVal,
    time: p.timestamp,
  };
});
result.data = JSON.stringify(data);
return result;
