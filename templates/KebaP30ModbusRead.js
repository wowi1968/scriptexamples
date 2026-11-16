// KEBA KeContact P30: alle lesbaren Modbus-TCP-Register zyklisch lesen und formatiert ausgeben.
// Voraussetzung: Modbus TCP an der Wallbox aktiviert (DIP-Schalter DSW1.3 / Webinterface).
// Die Wallbox liefert je Anfrage nur ein Register (UINT32, High Word zuerst), Unit-ID immer 255.
// Die RFID-Karte (1500) ist nur lesbar, wenn das an der Wallbox zusätzlich freigegeben ist.
// Liefert die Wallbox ein Register nicht (Modbus-Exception), bleibt dessen Ausgang unverändert.
// Ist die Wallbox nicht erreichbar, melden "Fehler" und "Fehlermeldung" den Grund.
//
// @inputs 0
// @params 3
// @outputs 23
// @param1 host: string = "192.168.1.30"
// @param2 port: integer = 502 [1..65535]
// @param3 interval: timespan = 30s
// @output1 chargingState: string
// @output2 cableState: string
// @output3 errorCode: string
// @output4 currentL1_A: number
// @output5 currentL2_A: number
// @output6 currentL3_A: number
// @output7 serialNumber: string
// @output8 product: string
// @output9 firmware: string
// @output10 activePower_W: number
// @output11 totalEnergy_kWh: number
// @output12 voltageL1_V: number
// @output13 voltageL2_V: number
// @output14 voltageL3_V: number
// @output15 powerFactor: number
// @output16 maxCurrent_A: number
// @output17 maxHwCurrent_A: number
// @output18 rfidCard: string
// @output19 sessionEnergy_kWh: number
// @output20 phaseSource: string
// @output21 phaseState: string
// @output22 failsafeCurrent_A: number
// @output23 failsafeTimeout_s: integer

const UNIT_ID = 255;

// Beim Start der Logik den Abfragetakt starten (KEBA empfiehlt mindestens 0,5 s, hier mindestens 1 s)
if (node.trigger === 'startup') node.every(Math.max(interval, 1000), 'poll');

const CHARGING_STATE = {
  0: 'Startvorgang',
  1: 'Nicht bereit',
  2: 'Bereit, wartet auf Fahrzeug',
  3: 'Lädt',
  4: 'Fehler',
  5: 'Unterbrochen (Übertemperatur oder pausiert)',
};
const CABLE_STATE = {
  0: 'Kein Kabel',
  1: 'Kabel an Ladestation',
  3: 'Kabel an Ladestation, verriegelt',
  5: 'Kabel an Ladestation und Fahrzeug',
  7: 'Kabel an Ladestation und Fahrzeug, verriegelt',
};
const PHASE_SOURCE = { 0: 'Keine', 1: 'OCPP', 2: 'REST-API', 3: 'Modbus TCP', 4: 'UDP' };
const PHASE_STATE = { 0: 'Einphasig', 1: 'Dreiphasig' };

const text = (map) => (v) => map[v] ?? `Unbekannt (${v})`;
const scale = (factor, digits) => (v) => round(v * factor, digits);
const hex = (v) => v.toString(16).toUpperCase();

// [Register (bei mehreren: erstes lesbares), Ausgang, Formatierung]
const REGISTERS = [
  [1000, 'chargingState', text(CHARGING_STATE)],
  [1004, 'cableState', text(CABLE_STATE)],
  [1006, 'errorCode', (v) => (v === 0 ? 'Kein Fehler' : `0x${hex(v)}`)],
  [1008, 'currentL1_A', scale(0.001, 3)],
  [1010, 'currentL2_A', scale(0.001, 3)],
  [1012, 'currentL3_A', scale(0.001, 3)],
  [1014, 'serialNumber', (v) => String(v)],
  [1016, 'product', formatProduct],
  [[1018, 1013], 'firmware', (v) => `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`], // 1013 bei Modbus-Version 1.11
  [1020, 'activePower_W', scale(0.001, 1)],
  [1036, 'totalEnergy_kWh', scale(0.0001, 4)],
  [1040, 'voltageL1_V', scale(1, 0)],
  [1042, 'voltageL2_V', scale(1, 0)],
  [1044, 'voltageL3_V', scale(1, 0)],
  [1046, 'powerFactor', scale(0.001, 3)], // cos phi, 0 … 1
  [1100, 'maxCurrent_A', scale(0.001, 3)],
  [1110, 'maxHwCurrent_A', scale(0.001, 3)],
  [1500, 'rfidCard', (v) => (v === 0 ? '' : hex(v).padStart(8, '0'))],
  [1502, 'sessionEnergy_kWh', scale(0.0001, 4)],
  [1550, 'phaseSource', text(PHASE_SOURCE)],
  [1552, 'phaseState', text(PHASE_STATE)],
  [1600, 'failsafeCurrent_A', scale(0.001, 3)],
  [1602, 'failsafeTimeout_s', (v) => v],
];

let conn;
try {
  conn = await net.connect({ host, port, timeout: 3 });
} catch (error) {
  throw new Error(`Keine Verbindung zur Wallbox ${host}:${port} (${error.code ?? error.message})`);
}

const result = {};
try {
  for (const [registers, name, format] of REGISTERS) {
    for (const address of [].concat(registers)) {
      const raw = await readRegister(address);
      if (raw !== null) {
        result[name] = format(raw);
        break;
      }
    }
  }
} finally {
  conn.close();
}
return result;

// Ein Register mit FC03 lesen (2 Wörter = UINT32). null bei einer Modbus-Exception der Wallbox.
async function readRegister(address) {
  const id = (node.state.transaction = ((node.state.transaction ?? 0) + 1) & 0xffff);
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  view.setUint16(0, id); // Transaction-ID
  view.setUint16(2, 0); // Protokoll-ID
  view.setUint16(4, 6); // Länge: Unit-ID und PDU
  frame[6] = UNIT_ID;
  frame[7] = 0x03; // Read Holding Registers
  view.setUint16(8, address);
  view.setUint16(10, 2); // 2 Register

  let reply;
  try {
    await conn.write(frame);
    const header = await conn.read(7);
    const headerView = new DataView(header.buffer, header.byteOffset);
    const length = headerView.getUint16(4);
    if (length < 3 || length > 254) throw new Error('ungültige Länge');
    reply = await conn.read(length - 1);
    if (headerView.getUint16(0) !== id) throw new Error('falsche Transaction-ID');
  } catch (error) {
    throw new Error(`Register ${address}: ${error.code ?? error.message}`);
  }

  if (reply[0] === 0x83) {
    warnOnce(address, `Register ${address} nicht lesbar (Modbus-Exception ${reply[1]})`);
    return null;
  }
  if (reply[0] !== 0x03 || reply[1] < 4) throw new Error(`Register ${address}: ungültige Antwort`);
  return new DataView(reply.buffer, reply.byteOffset).getUint32(2); // High Word zuerst
}

// 1016: Ziffern = Produkt, Kabel/Steckdose, Strom, Serie, Energiezähler, Autorisierung (z. B. 304111)
function formatProduct(v) {
  const d = String(v).padStart(6, '0');
  return [
    d[0] === '3' ? 'KC-P30' : `Typ ${d[0]}`,
    { 0: 'Steckdose', 1: 'Kabel' }[d[1]],
    { 1: '13 A', 2: '16 A', 3: '20 A', 4: '32 A' }[d[2]],
    { 0: 'x-series', 1: 'c-series' }[d[3]],
    { 1: 'Energiezähler nicht geeicht', 2: 'Energiezähler geeicht (MID)', 3: 'Energiezähler geeicht (national)' }[d[4]],
    { 0: 'ohne RFID', 1: 'mit RFID' }[d[5]],
  ]
    .filter(Boolean)
    .join(', ');
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Jede nicht lesbare Adresse nur einmal ins Protokoll schreiben
function warnOnce(address, message) {
  node.state.warned ??= {};
  if (node.state.warned[address]) return;
  node.state.warned[address] = true;
  console.warn(message);
}
