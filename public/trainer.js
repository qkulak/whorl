// TRAINER — Web Bluetooth connection to a smart trainer and HR strap.
//
// Smart trainers speak FTMS (Fitness Machine Service, 0x1826): we read power
// and cadence from Indoor Bike Data and drive ERG mode through the control
// point. A power-only device (Cycling Power, 0x1818) is accepted as a fallback;
// it reports watts but can't be controlled. HR parsing is the same as
// livetrainer's.

const FTMS = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const CONTROL_POINT = 0x2ad9;

const OP = {
  REQUEST_CONTROL: 0x00,
  SET_TARGET_POWER: 0x05,
  START: 0x07,
  SIMULATION: 0x11,
  RESPONSE: 0x80,
};

export class Trainer extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.controlPoint = null;
    this.canControl = false;
    this.simulated = false;
    this.lastTarget = null;
    this.lastCrank = null;
    this.staleCrankCount = 0;
    this._queue = Promise.resolve();
    this._simTimer = null;
    this._simTarget = null;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }, { services: ["cycling_power"] }],
      optionalServices: [FTMS, "cycling_power"],
    });
    const server = await device.gatt.connect();
    this.device = device;
    device.addEventListener("gattserverdisconnected", () => {
      this.canControl = false;
      this.controlPoint = null;
      this._emit("status", { connected: false, name: device.name });
    });

    let ftms = null;
    try {
      ftms = await server.getPrimaryService(FTMS);
    } catch {
      /* power meter or older trainer without FTMS */
    }

    if (ftms) {
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      await data.startNotifications();
      data.addEventListener("characteristicvaluechanged", (e) => this._onIndoorBikeData(e.target.value));

      // Indications on the control point must be on before we write to it.
      const cp = await ftms.getCharacteristic(CONTROL_POINT);
      await cp.startNotifications();
      cp.addEventListener("characteristicvaluechanged", (e) => this._onControlResponse(e.target.value));
      this.controlPoint = cp;
      await this._write([OP.REQUEST_CONTROL]);
      await this._write([OP.START]);
      this.canControl = true;
    } else {
      const svc = await server.getPrimaryService("cycling_power");
      const ch = await svc.getCharacteristic("cycling_power_measurement");
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", (e) => this._onCyclingPower(e.target.value));
    }
    this._emit("status", { connected: true, name: device.name || "trainer", canControl: this.canControl });
  }

  // GATT allows one operation at a time — serialize every write.
  _write(bytes) {
    const run = async () => {
      if (!this.controlPoint) return;
      const buf = new Uint8Array(bytes);
      if (this.controlPoint.writeValueWithResponse) await this.controlPoint.writeValueWithResponse(buf);
      else await this.controlPoint.writeValue(buf);
    };
    this._queue = this._queue.then(run, run).catch((e) => {
      console.warn("control point write failed", e);
      this._emit("error", { message: e.message });
    });
    return this._queue;
  }

  _onControlResponse(dv) {
    if (dv.getUint8(0) !== OP.RESPONSE) return;
    const op = dv.getUint8(1);
    const result = dv.getUint8(2);
    if (result !== 0x01) {
      console.warn(`trainer rejected op 0x${op.toString(16)} (result ${result})`);
      // Control lost (another app took it, or the trainer reset) — reclaim it.
      if (result === 0x05 && op !== OP.REQUEST_CONTROL) this._write([OP.REQUEST_CONTROL]);
    }
  }

  // ERG: hold this many watts regardless of cadence. Skips redundant writes.
  setTargetPower(watts) {
    watts = Math.max(0, Math.round(watts));
    if (this.simulated) {
      this._simTarget = watts;
      return;
    }
    if (!this.canControl || watts === this.lastTarget) return;
    this.lastTarget = watts;
    this._write([OP.SET_TARGET_POWER, watts & 0xff, (watts >> 8) & 0xff]);
  }

  // Leave ERG for a flat-road simulation — used for free-ride blocks and when
  // the rider switches ERG off.
  setFreeRide() {
    this.lastTarget = null;
    if (this.simulated) {
      this._simTarget = null;
      return;
    }
    if (!this.canControl) return;
    const grade = 0; // 0.01% units
    const crr = 40; // 0.0001 → 0.004
    const cw = 51; // 0.01 kg/m → 0.51
    this._write([OP.SIMULATION, 0, 0, grade & 0xff, (grade >> 8) & 0xff, crr, cw]);
  }

  // Indoor Bike Data (0x2AD2): a flags word says which fields follow.
  _onIndoorBikeData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    const out = {};
    if (!(flags & 0x0001)) {
      out.speed = dv.getUint16(o, true) / 100; // km/h ("more data" bit clear → present)
      o += 2;
    }
    if (flags & 0x0002) o += 2; // average speed
    if (flags & 0x0004) {
      out.cadence = Math.round(dv.getUint16(o, true) / 2);
      o += 2;
    }
    if (flags & 0x0008) o += 2; // average cadence
    if (flags & 0x0010) o += 3; // total distance
    if (flags & 0x0020) o += 2; // resistance level
    if (flags & 0x0040) {
      out.power = dv.getInt16(o, true);
      o += 2;
    }
    if (flags & 0x0080) o += 2; // average power
    if (flags & 0x0100) o += 5; // expended energy
    if (flags & 0x0200) {
      const hr = dv.getUint8(o);
      if (hr > 0) out.hr = hr;
      o += 1;
    }
    // Some trainers split one reading across two notifications; only emit
    // what this packet carried.
    if (Object.keys(out).length) this._emit("data", out);
  }

  // Cycling Power Measurement (0x2A63) — same parsing as livetrainer.
  _onCyclingPower(dv) {
    const flags = dv.getUint16(0, true);
    const out = { power: dv.getInt16(2, true) };
    let offset = 4;
    if (flags & 0x01) offset += 1; // pedal power balance
    if (flags & 0x04) offset += 2; // accumulated torque
    if (flags & 0x10) offset += 6; // wheel revolution data
    if (flags & 0x20 && dv.byteLength >= offset + 4) {
      const rpm = this._cadenceFromCrank({
        revs: dv.getUint16(offset, true),
        time: dv.getUint16(offset + 2, true), // unit: 1/1024 s
      });
      if (rpm !== null) out.cadence = rpm;
    }
    this._emit("data", out);
  }

  _cadenceFromCrank(crank) {
    if (!this.lastCrank) {
      this.lastCrank = crank;
      return null;
    }
    // uint16 fields roll over — mask the deltas
    const dRevs = (crank.revs - this.lastCrank.revs + 0x10000) & 0xffff;
    const dTime = (crank.time - this.lastCrank.time + 0x10000) & 0xffff;
    if (dTime === 0) {
      this.staleCrankCount++;
      return this.staleCrankCount >= 3 ? 0 : null;
    }
    this.lastCrank = crank;
    this.staleCrankCount = 0;
    const rpm = Math.round((dRevs * 1024 * 60) / dTime);
    return rpm > 220 ? null : rpm;
  }

  // No hardware handy: a fake trainer that chases the ERG target with some
  // lag and noise, so the ride screen can be exercised at a desk.
  simulate() {
    this.simulated = true;
    this.canControl = true;
    let p = 100;
    this._simTimer = setInterval(() => {
      const goal = this._simTarget ?? 150 + 30 * Math.sin(Date.now() / 20000);
      p += (goal - p) * 0.35 + (Math.random() - 0.5) * 12;
      this._emit("data", {
        power: Math.max(0, Math.round(p)),
        cadence: Math.round(88 + (Math.random() - 0.5) * 6),
        speed: 25 + Math.random() * 3,
        hr: Math.round(110 + p / 6 + Math.random() * 2),
      });
    }, 1000);
    this._emit("status", { connected: true, name: "SIMULATOR", canControl: true });
  }
}

export async function connectHeartRate(onBpm, onDisconnect) {
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ["heart_rate"] }] });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService("heart_rate");
  const ch = await service.getCharacteristic("heart_rate_measurement");
  await ch.startNotifications();
  ch.addEventListener("characteristicvaluechanged", (e) => {
    const dv = e.target.value;
    const flags = dv.getUint8(0);
    onBpm(flags & 0x1 ? dv.getUint16(1, true) : dv.getUint8(1));
  });
  device.addEventListener("gattserverdisconnected", onDisconnect);
  return device.name || "HR strap";
}
