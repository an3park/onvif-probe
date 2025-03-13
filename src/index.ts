import mri from 'mri'
import colors from 'picocolors'
import { OnvifDevice, startProbe } from './node-onvif-ts'

const { blue, blueBright, cyan, green, greenBright, magenta, red, redBright, reset, yellow } =
  colors

const argv = mri<{
  login?: string | string[]
  help?: boolean
  overwrite?: boolean
}>(process.argv.slice(2), {
  alias: { h: 'help', l: 'login' },
  boolean: ['help', 'overwrite'],
  string: ['login'],
})
// const cwd = process.cwd()

// prettier-ignore
const helpMessage = `\
Usage: onvif-probe [OPTION]...

Options:
  -l, --login admin:admin     try to login with this credentials
  -h, --help                  display this help and exit`

if (argv.help) {
  console.log(helpMessage)
  process.exit(0)
}

const loginList: [string, string][] = [
  ['', ''],
  ['admin', 'admin'],
  ['admin', '1234'],
  ['root', '1'],
]

if (argv.login) {
  if (Array.isArray(argv.login)) {
    for (const pair of argv.login) {
      loginList.push(pair.split(':', 2) as [string, string])
    }
  } else {
    loginList.push(argv.login.split(':', 2) as [string, string])
  }
}

async function main() {
  const deviceInfoList = await startProbe()
  // console.log(deviceInfoList)
  for (const { xaddrs, urn, name } of deviceInfoList) {
    console.log(`${name} (${urn})`)
    for (const xaddr of xaddrs) {
      console.log(prefix(1) + xaddr)
      const device = new OnvifDevice({ xaddr })
      try {
        // try login with provided credentials
        for (const [user, pass] of loginList) {
          device.setAuth(user, pass)
          try {
            await device.init()
            break
          } catch (e: any) {
            console.log(red(prefix(3) + (e.message || e)))
          }
        }

        console.log(
          green(prefix(3) + `Auth: ${device.user || '<empty>'}:${device.pass || '<empty>'}`)
        )
        for (const { stream } of device.getProfileList()) {
          const streamurl = stream.rtsp || stream.udp
          console.log(prefix(3) + streamurl)
        }
      } catch (e: any) {
        console.log(red(prefix(3) + (e.message || e)))
      }
    }
    console.log()
  }
}

main().catch(console.error)

function prefix(spaces: number) {
  return String.fromCharCode(...new Array(spaces).fill(32), 9492, 9472, 32)
}
