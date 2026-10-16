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

test("Windows: built-in and Bluetooth COM ports never shadow the USB adapter", () => {
  const com1 = { path: "COM1", pnpId: "ACPI\\PNP0501\\0" };
  const bt = { path: "COM2", pnpId: "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\7&1" };
  const ftdiCom = { path: "COM5", manufacturer: "FTDI", vendorId: "0403", productId: "6001", pnpId: "FTDIBUS\\VID_0403+PID_6001+A10K\\0000" };
  assert.equal(pickPort([com1, bt, ftdiCom]), "COM5");
  assert.equal(pickPort([com1, bt]), undefined);
});

test("Windows: a COM port reporting a USB vendor id beats one without", () => {
  assert.equal(pickPort([{ path: "COM3" }, { path: "COM7", vendorId: "1A86" }]), "COM7");
});
