// @inputs 0
// @params 1
// @outputs 2
// @webhook shellyflood
// @param1 token: string = ""
// @output1 flood: bool
// @output2 lastSeen: datetime
//
// Shelly Flood Gen4 und Flood S Gen4 (batteriebetrieben).
//
// Batteriegeräte schlafen und lassen sich nicht abfragen. Der Shelly meldet sich
// deshalb selbst über den Webhook dieses Bausteins:
//   Im Shelly unter "Actions" anlegen:
//     bei "Flood detected":  http://<X1-Adresse>:61234/shellyflood?flood=1
//     bei "Flood cleared":   http://<X1-Adresse>:61234/shellyflood?flood=0
//   Mit Parameter token zusätzlich &token=<token> anhängen.
//   Für mehrere Flood-Sensoren je Baustein einen eigenen Webhook-Pfad eintragen.
//
// Ausgänge:
//   flood     true bei Wasser, false wenn es wieder trocken ist.
//   lastSeen  Zeitpunkt der letzten Meldung (für eine Überwachung mit Watchdog).

if (node.trigger !== 'request') return;

const q = node.request.query;
if (token && q.token !== token) {
  node.respond('forbidden', { status: 403 });
  return;
}
node.respond('ok');

const flood = q.flood === undefined ? undefined : ['1', 'true', 'on'].includes(String(q.flood).toLowerCase());
return { flood, lastSeen: new Date(node.now()) };
