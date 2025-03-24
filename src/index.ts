import mri from 'mri'
import colors from 'picocolors'
import { getCapabilities, getProfiles, getStreamUri, sendProbe } from './onvif-probe'

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

interface DeviceData {
  urn: string
  name: string
  xaddrs: Record<
    string,
    {
      scopes: string[]
      auth: { user: string; pass: string }
      streams: string[]
    }
  >
}

const devicesData: Record<string, DeviceData> = {}

const udp = sendProbe(async (device) => {
  const { urn, xaddrs, scopes } = device

  if (devicesData[urn]) {
    return
  }

  const name = scopes
    ?.find((s) => s.startsWith('onvif://www.onvif.org/name/'))
    ?.split('/')
    .pop()

  const deviceData: DeviceData = {
    urn,
    name: name || '',
    xaddrs: {},
  }

  devicesData[urn] = Object.assign(devicesData[urn] || {}, deviceData)

  for (const xaddr of xaddrs) {
    try {
      // try login with provided credentials
      for (const [user, pass] of loginList) {
        const auth = { user, pass }
        try {
          const { Capabilities } = await getCapabilities(xaddr, auth)

          devicesData[urn].xaddrs[xaddr] = {
            scopes: scopes || [],
            auth,
            streams: [],
          }

          if (Capabilities.Media) {
            const { Profiles } = await getProfiles(Capabilities.Media.XAddr, auth)

            const mediaUris: Set<string> = new Set()

            for (const profile of Profiles) {
              for (const protocol of ['RTSP', 'UDP', 'HTTP'] as const) {
                try {
                  const { MediaUri } = await getStreamUri(Capabilities.Media.XAddr, {
                    ...auth,
                    protocol,
                    profileToken:
                      profile.VideoEncoderConfiguration?.['@_token'] ||
                      profile.VideoSourceConfiguration?.['@_token'],
                  })

                  mediaUris.add(MediaUri.Uri)
                } catch (_) {}
              }
            }

            devicesData[urn].xaddrs[xaddr].streams = Array.from(mediaUris)
          }
          break
        } catch (e: any) {
          console.log(red(prefix(3) + (e.message || e)))
        }
      }
    } catch (e: any) {
      console.log(red(prefix(3) + (e.message || e)))
    }
  }

  console.log(`${devicesData[urn].name} (${devicesData[urn].urn})`)

  for (const xaddr of Object.keys(devicesData[urn].xaddrs)) {
    console.log(prefix(1) + xaddr)

    const { user, pass } = devicesData[urn].xaddrs[xaddr].auth

    console.log(green(prefix(3) + `Auth: ${user || '<empty>'}:${pass || '<empty>'}`))

    for (const stream of devicesData[urn].xaddrs[xaddr].streams) {
      console.log(blueBright(prefix(5) + stream))
    }
  }
})

setTimeout(() => {
  udp.close()
}, 10_000)

function prefix(spaces: number) {
  return String.fromCharCode(...new Array(spaces).fill(32), 9492, 9472, 32)
}
