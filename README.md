# XLN

SPCI interface for XLN series Programmable DC Power Supplies

*This is still a work in progress*

## Usage

```
npm install --save xln
```

```
import {tcpXLN} from 'xln';

var conn = new tcpXLN({host: 'hostname or IP'}, () => {
  // Connected
  conn.getIDN(idn => {
    console.log('Device info: ' + idn);

    // Now we can do more stuff with the connection
    // You can't use more than one xln function at a time

    // Setup a 12V source
    conn.setSourceVoltage(12, () => {
      // 1A current limit
      conn.setSourceCurrent(1, () => {
        conn.setOutput(true, () => {
          // Delay just a little bit before checking the current
          setTimeout(() => {
            conn.getMeasuredCurrent(current => {
              console.log(current);
              console.log((parseFloat(current) > 0) ? 'Load detected' : 'No load');

              // Do more stuff...

              // Close the connection
              conn.end();
            });
          }, 400);
        });
      });
    });
  });
});

conn.on('error', err => {
  console.log('Connection error');
  console.log(err);
}
```
