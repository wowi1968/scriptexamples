// Modbus TCP: Bits oder Register lesen (FC1 bis FC4), wie der Logikbaustein Modbus.
// Ein true an trigger liest. Jeder Ausgang außer errorCode erhält einen Wert ab start. Für mehr Werte im Kopf die
// Anzahl der Ausgänge erhöhen und weitere Ausgänge valueN ergänzen (höchstens 16 Werte).
// errorCode: 0 = ok, sonst die Fehler-Codes des Modbus-Bausteins (siehe Funktion request).
//
// @inputs 1
// @params 8
// @outputs 3
// @input1 trigger: bool
// @param1 host: string = "192.168.1.20"
// @param2 port: integer = 502 [1..65535]
// @param3 unitId: integer = 1 [0..255]
// @param4 fc: integer = 3 [1..4]
// @param5 start: integer = 1 [1..65536]
// @param6 format: integer = 16 [16..32]
// @param7 signed: bool = false
// @param8 highWordFirst: bool = true
// @output1 value1
// @output2 value2
// @output3 errorCode: integer
if (node.trigger !== 'input' || !node.changed.includes('trigger') || !trigger) return;
if (format !== 16 && format !== 32) throw new Error('format muss 16 oder 32 sein');

const OUT = node.outputs.filter((name) => name !== 'errorCode');
const isBits = fc <= 2;
const perValue = !isBits && format === 32 ? 2 : 1;
const count = OUT.length;
const quantity = count * perValue;

try {
  if (count < 1 || count > 16) throw 2;
  if (start - 1 + quantity > 65536) throw 10;

  const response = await request(pdu(fc, start - 1, quantity));
  const expected = isBits ? (count + 7) >> 3 : quantity * 2;
  if (response[1] < expected) throw 5;

  const data = new DataView(response.buffer, response.byteOffset + 2); // nach Funktionscode und Byte-Anzahl
  const result = { errorCode: 0 };
  OUT.forEach((name, i) => {
    if (isBits) {
      result[name] = ((response[2 + (i >> 3)] >> (i & 7)) & 1) === 1;
    } else if (perValue === 1) {
      result[name] = signed ? data.getInt16(2 * i) : data.getUint16(2 * i);
    } else {
      const first = data.getUint16(4 * i);
      const second = data.getUint16(4 * i + 2);
      const value = highWordFirst ? first * 0x10000 + second : second * 0x10000 + first;
      result[name] = signed && value >= 0x80000000 ? value - 0x100000000 : value;
    }
  });
  return result;
} catch (error) {
  if (typeof error === 'number') return { errorCode: error };
  throw error;
}

// Anfrage: Funktionscode, Adresse, Anzahl
function pdu(code, address, quantity) {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  bytes[0] = code;
  view.setUint16(1, address);
  view.setUint16(3, quantity);
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
