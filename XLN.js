'use strict';

var dgram = require('dgram');
var net = require('net');

const XLN_UDP_PORT = 9221;
const XLN_TCP_PORT = 5025;

export class udpXLN {
  constructor(options, callback) {

    this.host = options.host;
    this.sock = dgram.createSocket('udp4');

    this.sock.bind(options.bindOptions || {}, callback);

    // 96 bytes per message
    this.buff = new Buffer(96);
  }

  send(str, callback) {
    this.sock.once('message', callback);
    this.buff.fill(0);
    this.buff.write(str);
    this.sock.send(this.buff, 0, this.buff.length, XLN_UDP_PORT, this.host);
  }

  readStatus(callback) {
    this.send('MEAS:CURR?', (msg, rinfo) => callback(parseUDPMessage(msg), rinfo));
  }
}

function parseUDPMessage(msg) {
  msg = msg.toString();

  return msg;
}

export class tcpXLN {
  constructor(options, callback) {

    this.host = options.host;
    this.reconnect();
  }

  reconnect() {
    this.sock = net.connect({host: this.host, port: XLN_TCP_PORT});
  }

  send(str, callback) {
    if (callback)
     this.sock.once('data', data => callback(data.toString()));

    return this.sock.write(str + '\n');
  }

  sendValue(str, val, callback) {
    var ret = this.send(str + ' ' + val);

    if (callback) callback(ret);
    return ret;
  }

  clearStatus(callback) {
    return this.send('*CLS', callback);
  }

  getIDN(callback) {
    return this.send('*IDN?', callback);
  }

  recallFromMemory(num, callback) {
    return this.send('*RCL ' + num, callback);
  }

  reset(callback) {
    return this.send('*RST', callback);
  }

  saveToMemory(num, callback) {
    return this.send('*SAV ' + num, callback);
  }

  abort(callback) {
    return this.send(':ABORt', callback);
  }

  getFetchVoltage(callback) {
    return this.send(':FETC:VOLT?', callback);
  }

  getFetchCurrent(callback) {
    return this.send(':FETC:CURR?', callback);
  }

  getMeasuredVoltage(callback) {
    return this.send(':MEAS:VOLT?', callback);
  }

  getMeasuredCurrent(callback) {
    return this.send(':MEAS:CURR?', callback);
  }

  getOutput(callback) {
    return this.send(':OUT?', callback);
  }

  setOutput(enabled, callback) {
    return this.sendValue(':OUT', (enabled ? 1 : 0), callback);
  }

  getOutputVoltageLimit(callback) {
    return this.send(':OUT:LIM:VOLT?', callback);
  }

  getOutputCurrentLimit(callback) {
    return this.send(':OUT:LIM:CURR?', callback);
  }

  getOutputVoltageSlewRate(callback) {
    return this.send(':OUT:SR:VOLT?', callback);
  }

  getOutputCurrentSlewRate(callback) {
    return this.send(':OUT:SR:CURR?', callback);
  }

  setOutputVoltageLimit(val, callback) {
    return this.sendValue(':OUT:LIM:VOLT', val, callback);
  }

  setOutputCurrentLimit(val, callback) {
    return this.sendValue(':OUT:LIM:CURR', val, callback);
  }

  setOutputVoltageSlewRate(val, callback) {
    return this.sendValue(':OUT:SR:VOLT', val, callback);
  }

  setOutputCurrentSlewRate(val, callback) {
    return this.sendValue(':OUT:SR:CURR', val, callback);
  }

  getOutputState(callback) {
    return this.send(':OUT:STAT?', callback);
  }

  resetLatchedProtection(callback) {
    var ret = this.send(':OUT:PROT:CLE');
    if (callback) callback(ret);
    return ret;
  }

  getSourceCurrent(callback) {
    return this.send(':SOUR:CURR?', callback);
  }

  setSourceCurrent(val, callback) {
    return this.sendValue(':SOUR:CURR', val, callback);
  }

  getSourceOverCurrentState(callback) {
    return this.send(':SOUR:CURR:PROT?', callback);
  }

  setSourceOverCurrentState(val, callback) {
    return this.sendValue(':SOUR:CURR:PROT', val ? 1 : 0, callback);
  }

  getSourceOverCurrentLevel(callback) {
    return this.send(':SOUR:CURR:PROT:LEV?', callback);
  }

  setSourceOverCurrentLevel(val, callback) {
    return this.sendValue(':SOUR:CURR:PROT:LEV', val, callback);
  }

  getSourceVoltage(callback) {
    return this.send(':SOUR:VOLT?', callback);
  }

  setSourceVoltage(val, callback) {
    return this.sendValue(':SOUR:VOLT', val, callback);
  }

  getSourceOverVoltageState(callback) {
    return this.send(':SOUR:VOLT:PROT?', callback);
  }

  setSourceOverVoltageState(val, callback) {
    return this.sendValue(':SOUR:VOLT:PROT', val ? 1 : 0, callback);
  }

  getSourceOverVoltageLevel(callback) {
    return this.send(':SOUR:VOLT:PROT:LEV?', callback);
  }

  setSourceOverVoltageLevel(val, callback) {
    return this.sendValue(':SOUR:VOLT:PROT:LEV', val, callback);
  }

  getBeep(callback) {
    return this.send(':SYS:BEEP?', callback);
  }

  setBeep(val, callback) {
    return this.sendValue(':SYS:BEEP', val ? 1 : 0, callback);
  }

  getError(callback) {
    return this.send(':SYS:ERR?', callback);
  }
}
