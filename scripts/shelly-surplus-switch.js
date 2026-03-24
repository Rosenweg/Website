// Shelly Überschuss-Steuerung (Gen2: 1PM / 2PM)
// Einschalten bei >= on_threshold Watt Überschuss
// Ausschalten wenn Verbrauch am Ausgang < off_power Watt
//
// Installation: Shelly Web UI → Scripts → Add Script → Code einfügen → Start on boot
//
// Endpoints:
//   /api/energy/surplus           — Netto (was ins Netz geht)
//   /api/energy/surplus-available — Inkl. Heizstab-Verbrauch (was verfügbar wäre)

let CONFIG = {
  url: "http://rosenweg.net/api/energy/surplus",
  check_interval: 15,   // Sekunden
  on_threshold: 1000,   // Watt Überschuss zum Einschalten
  off_power: 10,        // Watt am Ausgang unter dem abgeschaltet wird
  outputs: [0]           // [0] für 1PM, [0, 1] für 2PM
};

let timer = null;

function checkSurplus() {
  Shelly.call("HTTP.GET", { url: CONFIG.url, timeout: 5 }, function (res, err) {
    if (err || !res || res.code !== 200) {
      print("API error, skip");
      return;
    }

    let data = JSON.parse(res.body);
    let surplus = data.surplus_w;
    print("Surplus: " + JSON.stringify(surplus) + "W");

    for (let i = 0; i < CONFIG.outputs.length; i++) {
      let ch = CONFIG.outputs[i];
      let status = Shelly.getComponentStatus("switch:" + JSON.stringify(ch));
      let is_on = status.output;
      let power = status.apower || 0;

      if (!is_on && surplus >= CONFIG.on_threshold) {
        print("CH" + JSON.stringify(ch) + " EIN (Überschuss: " + JSON.stringify(surplus) + "W)");
        Shelly.call("Switch.Set", { id: ch, on: true });
      } else if (is_on && power < CONFIG.off_power) {
        print("CH" + JSON.stringify(ch) + " AUS (Verbrauch: " + JSON.stringify(power) + "W)");
        Shelly.call("Switch.Set", { id: ch, on: false });
      }
    }
  });
}

timer = Timer.set(CONFIG.check_interval * 1000, true, checkSurplus);
checkSurplus();
print("Überschuss-Steuerung gestartet");
