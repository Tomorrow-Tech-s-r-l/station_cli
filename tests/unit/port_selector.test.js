// Unit tests for station serial-port auto-detection.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const { pickPort, isStationEmulator } = require("../../dist/utils/port_selector");

const ftdi = { path: "/dev/ttyUSB0", manufacturer: "FTDI", vendorId: "0403", productId: "6001" };
const emulator = {
  path: "/dev/ttyACM0",
  manufacturer: "Amperry",
  pnpId: "usb-Amperry_Station_Emulator_unoq-if00",
};
const modem = { path: "/dev/ttyACM1", manufacturer: "ZTE" };

test("a real interfacer bus is picked exactly as before", () => {
  assert.equal(pickPort([ftdi]), "/dev/ttyUSB0");
  assert.equal(pickPort([{ path: "/dev/tty.usbserial-A10K" }]), "/dev/tty.usbserial-A10K");
  assert.equal(pickPort([{ path: "COM3" }]), "COM3");
});

test("the UNO Q emulator gadget is picked when it is the only station port", () => {
  assert.equal(pickPort([modem, emulator]), "/dev/ttyACM0");
});

test("a real bus always wins over the emulator", () => {
  assert.equal(pickPort([emulator, ftdi]), "/dev/ttyUSB0");
});

test("an anonymous ACM device (modem, other gadget) is never picked", () => {
  assert.equal(pickPort([modem]), undefined);
  assert.equal(pickPort([{ path: "/dev/ttyACM0" }]), undefined);
});

test("the emulator is recognised by manufacturer or by-id name", () => {
  assert.equal(isStationEmulator({ path: "/dev/ttyACM0", manufacturer: "Amperry" }), true);
  assert.equal(
    isStationEmulator({ path: "/dev/ttyACM0", pnpId: "usb-Amperry_Station_Emulator_x-if00" }),
    true
  );
  assert.equal(isStationEmulator(modem), false);
});
