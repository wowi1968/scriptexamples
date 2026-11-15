// Modbus TCP: Bits oder Register schreiben (FC5, FC6, FC15, FC16), wie der Logikbaustein Modbus.
// FC5 und FC6 schreiben jeden neuen Wert sofort (trigger wird nicht gebraucht); FC15 und FC16 schreiben alle Werte
// bei einem true an trigger, sobald jeder Werteingang einen Wert erhalten hat. Für mehr Werte im Kopf die Anzahl der
// Eingänge erhöhen, weitere Eingänge valueN ergänzen und sie in "values" unten eintragen (höchstens 16 Werte).
// errorCode: 0 = ok, sonst die Fehler-Codes des Modbus-Bausteins (siehe Funktion request).
//
// @inputs 3
// @params 7
// @outputs 1
// @input1 trigger: bool = false
// @input2 value1 = 0
// @input3 value2 = 0
// @param1 host: string = "192.168.1.20"
// @param2 port: integer = 502 [1..65535]
// @param3 unitId: integer = 1 [0..255]
// @param4 fc: integer = 16 [5..16]
// @param5 start: integer = 1 [1..65536]
// @param6 format: integer = 16 [16..32]
// @param7 highWordFirst: bool = true
// @output1 errorCode: integer

// Die Werteingänge in ihrer Reihenfolge: bei weiteren Eingängen hier ergänzen.
const values = { value1, value2 };

if (node.trigger !== 'input') return;
if (![5, 6, 15, 16].includes(fc)) throw new Error(`Modbus-Funktion FC${fc} kann nicht schreiben (5, 6, 15 oder 16)`);
if (format !== 16 && format !== 32) throw new Error('format muss 16 oder 32 sein');

const NAMES = Object.keys(values);
const isBits = fc === 5 || fc === 15;
const perValue = !isBits && format === 32 ? 2 : 1;

// Werteingänge, die seit dem Start der Logik einen Wert erhalten haben; vorher gelten nur die Standardwerte.
const received = (node.state.received ??= {});
for (const name of node.changed) if (name in values) received[name] = true;

let writes;
if (fc === 15 || fc === 16) {
  if (!node.changed.includes('trigger') || !trigger || !NAMES.every((name) => received[name])) return;
  writes = [{ index: 0, items: NAMES.map((name) => values[name]) }];
} else {
  writes = NAMES.filter((name) => node.changed.includes(name)).map((name) => ({ index: NAMES.indexOf(name), items: [values[name]] }));
  if (writes.length === 0) return;
}

try {
  if (NAMES.length < 1 || NAMES.length > 16) throw 2;
  if (start - 1 + NAMES.length * perValue > 65536) throw 10;
  for (const { index, items } of writes) await request(pdu(start - 1 + index * perValue, items));
  return { errorCode: 0 };
} catch (error) {
  if (typeof error === 'number') return { errorCode: error };
  throw error;
}

// Die Anfrage für die Werte ab einer Adresse.
function pdu(address, items) {
  if (fc === 5) return words(5, address, items[0] ? 0xff00 : 0x0000);
  if (fc === 15) return multiple(15, address, items.length, packBits(items));
  const registers = items.flatMap(toRegisters);
  if (fc === 6 && registers.length === 1) return words(6, address, registers[0]);
  // FC16, und FC6 mit 32 Bit: beide Register in einer Anfrage, damit kein Lesezugriff einen halben Wert erhält.
  return multiple(16, address, registers.length, registerBytes(registers));
}

// Ein Wert als Register: Nachkommastellen abgeschnitten, nur die unteren 16 bzw. 32 Bit (Zweierkomplement).
function toRegisters(item) {
  const number = Number(item);
  if (!Number.isFinite(number)) throw 3;
  const value = Math.trunc(number) >>> 0;
  if (perValue === 1) return [value & 0xffff];
  return highWordFirst ? [value >>> 16, value & 0xffff] : [value & 0xffff, value >>> 16];
}

// Funktionscode, Adresse und 16-Bit-Wörter (FC5, FC6)
function words(code, address, ...items) {
  const bytes = new Uint8Array(3 + 2 * items.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = code;
  view.setUint16(1, address);
  items.forEach((item, i) => view.setUint16(3 + 2 * i, item));
  return bytes;
}

// Funktionscode, Adresse, Anzahl, Byte-Anzahl und Daten (FC15, FC16)
function multiple(code, address, quantity, data) {
  const bytes = new Uint8Array(6 + data.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = code;
  view.setUint16(1, address);
  view.setUint16(3, quantity);
  bytes[5] = data.length;
  bytes.set(data, 6);
  return bytes;
}

function packBits(items) {
  const bytes = new Uint8Array((items.length + 7) >> 3);
  items.forEach((item, i) => {
    if (item) bytes[i >> 3] |= 1 << (i & 7);
  });
  return bytes;
}

function registerBytes(registers) {
  const bytes = new Uint8Array(2 * registers.length);
  const view = new DataView(bytes.buffer);
  registers.forEach((register, i) => view.setUint16(2 * i, register));
  return bytes;
}

// Eine Modbus-TCP-Transaktion. Wirft einen Fehler-Code (Zahl) wie der Modbus-Baustein:
// 1 bis 3 Exception des Geräts, 4 keine Antwort, 5 ungültige Antwort, 11 unbekannter Fehler,
// 12 keine Verbindung, 13 Zeitüberschreitung beim Verbinden.
async function request(body) {
  let conn;
  try {
    conn = await net.connect({ host, port, timeout: 3 });
  } catch (error) {
    throw error.code === 'ETIMEDOUT' ? 13 : 12;
  }

  try {
    const id = (node.state.transaction = ((node.state.transaction ?? 0) + 1) & 0xffff);
    const frame = new Uint8Array(7 + body.length);
    const view = new DataView(frame.buffer);
    view.setUint16(0, id); // Transaction-ID
    view.setUint16(2, 0); // Protokoll-ID
    view.setUint16(4, body.length + 1); // Länge: Unit-ID und PDU
    frame[6] = unitId;
    frame.set(body, 7);
    await conn.write(frame);

    const header = new DataView((await conn.read(7)).buffer);
    const length = header.getUint16(4);
    if (header.getUint16(0) !== id || length < 3 || length > 254) throw 5;
    const reply = await conn.read(length - 1);
    if (reply[0] === (body[0] | 0x80)) throw reply[1] <= 3 ? reply[1] : 11; // Exception des Geräts
    if (reply[0] !== body[0]) throw 5;
    return reply;
  } catch (error) {
    if (typeof error === 'number' || !error.code) throw error;
    throw error.code === 'ETIMEDOUT' ? 4 : 5;
  } finally {
    conn.close();
  }
}
