const { OnvifDevice, startProbe } = require('node-onvif-ts')
const fs = require('fs').promises
const path = require('path')
const { red, green, cyan } = require('chalk')

async function scan() {
  const deviceInfoList = await startProbe()
  // console.log(deviceInfoList)
  for (const { xaddrs, urn, name } of deviceInfoList) {
    console.log(`${name} (${urn})`)
    for (const xaddr of xaddrs) {
      console.log(prefix(1) + xaddr)
      const device = new OnvifDeviceRacer({ xaddr })
      try {
        const { HardwareId } = await device.init()
        console.log(green(prefix(3) + device.user + ' / ' + device.pass))
        for (const { stream } of device.getProfileList()) {
          const streamurl = stream.rtsp || stream.udp
          console.log(prefix(3) + streamurl)
        }
      } catch (e) {
        console.log(red(prefix(3) + (e.message || e)))
      }
    }
    console.log()
  }
}

scan()//.then(exitOnAnyKey)

/**
 * @param {number} spaces
 */
function prefix(spaces) {
  return String.fromCharCode(...new Array(spaces).fill(32), 9492, 9472, 32)
}

const authData = fs
  .readFile(path.join(__dirname, 'auth.cfg'), 'utf-8')
  .then(file => file.split(/\n|\n\r/).map(line => line.split(':')))
  .catch(() => {
    console.log(red('File `auth.cfg` not found or corrupted'))
    console.log(cyan('It need to match ONVIF auth'))
    console.log('`auth.cfg` example:\nadmin:admin\nadmin:1234\n')
    console.log(green('Fallback to admin:admin\n'))
  })

class OnvifDeviceRacer extends OnvifDevice {
  async init() {
    const auth = await authData || [['admin', 'admin']]
    for (let i = 0; i < auth.length; ++i) {
      const [user, pass] = auth[i]
      this.setAuth(user, pass)
      try {
        return await super.init()
      } catch (_) {}
    }
    throw 'wrong passwords'
  }
}

function exitOnAnyKey() {
  console.log('Press any key to exit...')
  process.stdin.setRawMode(true)
  process.stdin.on('data', () => process.exit())
}
