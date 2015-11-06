'use strict';

var dgram = require('dgram');

const XLN_UDP_PORT = 9221;

export default class udpXLN {
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
    this.send('MEAS:CURR?', (msg, rinfo) => callback(parseMessage(msg), rinfo));
  }
}

function parseMessage(msg) {
  msg = msg.toString();



  return msg;
}
