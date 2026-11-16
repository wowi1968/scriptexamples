// KEBA KeContact P30: alle schreibbaren Modbus-TCP-Register über Eingänge steuern (FC06, Unit-ID 255).
// Jeder neue Wert an einem Eingang wird an die Wallbox geschrieben; nicht verbundene Eingänge tun nichts.
// - KEBA empfiehlt zwischen zwei Schreibbefehlen auf dasselbe Register mindestens 5 s. Kommt ein Wert früher,
//   wartet er und wird dann geschrieben; ein neuerer Wert ersetzt einen wartenden (es gilt der letzte).
// - Nach einer Phasenumschaltung (5052) ignoriert die Wallbox 5 Minuten lang weitere Umschaltungen; das Skript
//   hält eine neue Umschaltung so lange zurück. Den tatsächlichen Zustand zeigt das Leseregister 1552.
// - Failsafe: erst failsafeCurrent_A, dann failsafeTimeout_s (> 0 aktiviert, 0 deaktiviert), bei Bedarf
//   failsafePersist. Der Timeout muss länger sein als der Abstand der Modbus-Befehle (z. B. Abfragetakt).
// - Ausgang waiting: Werte, die noch auf ihren Schreibzeitpunkt warten. Fehler melden "Fehler"/"Fehlermeldung".
//
// @inputs 9
// @params 2
// @outputs 2
// @input1 chargingCurrent_A: number = 16 [6..63]
// @input2 energyLimit_kWh: number = 0 [0..655.35]
// @input3 enable: bool = true
// @input4 unlock: bool = false
// @input5 phaseSource: integer = 3 [0..4]
// @input6 threePhase: bool = true
// @input7 failsafeCurrent_A: number = 6 [0..32]
// @input8 failsafeTimeout_s: integer = 0 [0..600]
// @input9 failsafePersist: bool = false
// @param1 host: string = "192.168.1.30"
// @param2 port: integer = 502 [1..65535]
// @output1 lastWrite: string
// @output2 waiting: string

const UNIT_ID = 255;
const MIN_GAP = 5000; // ms zwischen zwei Schreibbefehlen auf dasselbe Register
const PHASE_COOLDOWN = 5 * 60 * 1000; // ms Sperrzeit nach einer Phasenumschaltung

if (node.trigger === 'startup') return;

const PHASE_SOURCE = { 0: 'keine', 1: 'OCPP', 2: 'REST-API', 3: 'Modbus TCP', 4: 'UDP' };

// [Eingang, Register, Wert -> [Registerwert, Beschreibung] oder null (nichts schreiben)]
// Die Reihenfolge ist die Schreibreihenfolge, wenn mehrere Werte gleichzeitig anstehen
// (z. B. erst sperren, dann entriegeln; erst Failsafe-Strom, dann Timeout, dann speichern).
const COMMANDS = [
  ['chargingCurrent_A', 5004, (v) => {
    const mA = Math.round(v * 1000);
    return [mA, `Ladestrom ${mA / 1000} A`];
  }],
  ['energyLimit_kWh', 5010, (v) => {
    const units = Math.round(v * 100); // Einheit 10 Wh
    return [units, `Energiegrenze ${units / 100} kWh`];
  }],
  ['enable', 5014, (v) => [v ? 1 : 0, v ? 'Ladestation freigegeben' : 'Ladestation gesperrt']],
  ['unlock', 5012, (v) => (v ? [0, 'Stecker entriegeln'] : null)],
  ['phaseSource', 5050, (v) => [v, `Quelle Phasenumschaltung: ${PHASE_SOURCE[v]}`]],
  ['threePhase', 5052, (v) => [v ? 1 : 0, v ? 'Umschalten auf dreiphasig' : 'Umschalten auf einphasig']],
  ['failsafeCurrent_A', 5016, (v) => {
    const mA = Math.round(v * 1000);
    if (mA !== 0 && mA < 6000) throw new Error('failsafeCurrent_A muss 0 (Laden aus) oder 6 bis 32 A sein');
    return [mA, mA === 0 ? 'Failsafe: Laden aus' : `Failsafe-Strom ${mA / 1000} A`];
  }],
  ['failsafeTimeout_s', 5018, (v) => {
    if (v !== 0 && v < 5) throw new Error('failsafeTimeout_s muss 0 (aus) oder 5 bis 600 s sein');
    return [v, v === 0 ? 'Failsafe deaktiviert' : `Failsafe-Timeout ${v} s`];
  }],
  ['failsafePersist', 5020, (v) => (v ? [1, 'Failsafe-Einstellungen speichern'] : null)],
];

const inputs = { chargingCurrent_A, energyLimit_kWh, enable, unlock, phaseSource, threePhase,
  failsafeCurrent_A, failsafeTimeout_s, failsafePersist };
const pending = (node.state.pending ??= {}); // Register -> [Wert, Beschreibung]
const lastTime = (node.state.lastTime ??= {}); // Register -> Zeit des letzten Schreibens

// Neue Eingangswerte vormerken (ein wartender Wert desselben Registers wird ersetzt)
if (node.trigger === 'input') {
  for (const [name, register, convert] of COMMANDS) {
    if (!node.changed.includes(name)) continue;
    const command = convert(inputs[name]);
    if (command) pending[register] = command;
  }
}

// Fällige Werte schreiben, für die übrigen den Timer stellen
const now = node.now();
const written = [];
let conn;
let nextDue = Infinity;
try {
  for (const [, register] of COMMANDS) {
    const command = pending[register];
    if (!command) continue;
    const gap = register === 5052 ? PHASE_COOLDOWN : MIN_GAP;
    const due = (lastTime[register] ?? -Infinity) + gap;
    if (due > now) {
      nextDue = Math.min(nextDue, due);
      continue;
    }
    delete pending[register];
    conn ??= await connect();
    await writeRegister(conn, register, command[0]);
    lastTime[register] = node.now();
    written.push(`${command[1]} (${register} = ${command[0]})`);
  }
} finally {
  conn?.close();
}

if (nextDue !== Infinity) node.after(Math.max(nextDue - now, 50), 'flush');

const waiting = COMMANDS.filter(([, register]) => pending[register])
  .map(([, register]) => {
    const due = lastTime[register] + (register === 5052 ? PHASE_COOLDOWN : MIN_GAP);
    return `${pending[register][1]} in ${Math.ceil((due - now) / 1000)} s`;
  })
  .join('; ');

return { lastWrite: written.length ? written.join('; ') : undefined, waiting };

async function connect() {
  try {
    return await net.connect({ host, port, timeout: 3 });
  } catch (error) {
    throw new Error(`Keine Verbindung zur Wallbox ${host}:${port} (${error.code ?? error.message})`);
  }
}

// Ein Register mit FC06 (Write Single Register) schreiben
async function writeRegister(conn, register, value) {
  const id = (node.state.transaction = ((node.state.transaction ?? 0) + 1) & 0xffff);
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  view.setUint16(0, id); // Transaction-ID
  view.setUint16(2, 0); // Protokoll-ID
  view.setUint16(4, 6); // Länge: Unit-ID und PDU
  frame[6] = UNIT_ID;
  frame[7] = 0x06; // Write Single Register
  view.setUint16(8, register);
  view.setUint16(10, value);

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
    throw new Error(`Register ${register}: ${error.code ?? error.message}`);
  }
  if (reply[0] === 0x86) throw new Error(`Register ${register} = ${value}: Modbus-Exception ${reply[1]}`);
  if (reply[0] !== 0x06) throw new Error(`Register ${register}: ungültige Antwort`);
}
