import { randomBytes } from 'crypto'
import { createSocket, Socket } from 'dgram'
import { parse } from './module/soap'

const DISCOVERY_RETRY_MAX = 3
const DISCOVERY_WAIT = 3000
const DISCOVERY_INTERVAL = 150
const MULTICAST_ADDRESS = '239.255.255.250'
const PORT = 3702
let discoveryIntervalTimer: NodeJS.Timeout | null = null
let discoveryWaitTimer: NodeJS.Timeout | null = null
let udp: Socket | null = null
let devices: { [key: string]: Probe } = {}

export interface Probe {
  urn: string
  name: string
  hardware: string
  location: string
  types: string[]
  xaddrs: string[]
  scopes: string[]
}

// Define a basic interface for the SOAP response
interface SoapResponse {
  Body: {
    ProbeMatches: {
      ProbeMatch: {
        EndpointReference: {
          Address: string
        }
        XAddrs: string
        Scopes: string | { _: string }
        Types: string | { _: string }
      }
    }
  }
}

export function startDiscovery(callback: (probe: Probe | null, error?: unknown) => void) {
  startProbe()
    .then((list) => {
      const execCallback = () => {
        const d = list.shift()
        if (d) {
          callback(d)
          setTimeout(() => {
            execCallback()
          }, 100)
        }
      }
      execCallback()
    })
    .catch((error) => {
      callback(null, error)
    })
}

export function startProbe(): Promise<Probe[]> {
  return new Promise((resolve, reject) => {
    devices = {}
    udp = createSocket('udp4')
    udp.once('error', (error) => {
      console.error(error)
      reject(error)
    })

    udp.on('message', (buf) => {
      parse(buf.toString())
        .then((res: SoapResponse) => {
          let urn: string | undefined
          let xaddrs: string[] = []
          let scopes: string[] = []
          let types: string[] = []
          try {
            const probeMatch = res.Body.ProbeMatches.ProbeMatch
            urn = probeMatch.EndpointReference.Address
            xaddrs = probeMatch.XAddrs.split(/\s+/)

            if (typeof probeMatch.Scopes === 'string') {
              scopes = probeMatch.Scopes.split(/\s+/)
            } else if (
              typeof probeMatch.Scopes === 'object' &&
              typeof probeMatch.Scopes._ === 'string'
            ) {
              scopes = probeMatch.Scopes._.split(/\s+/)
            }

            // modified to support Pelco cameras
            if (typeof probeMatch.Types === 'string') {
              types = probeMatch.Types.split(/\s+/)
            } else if (
              typeof probeMatch.Types === 'object' &&
              typeof probeMatch.Types._ === 'string'
            ) {
              types = probeMatch.Types._.split(/\s+/)
            }
          } catch (e) {
            console.error('Error parsing probe match:', e instanceof Error ? e.message : String(e))
            return
          }

          if (urn && xaddrs.length > 0 && scopes.length > 0) {
            if (!devices[urn]) {
              let name = ''
              let hardware = ''
              let location = ''
              scopes.forEach((s) => {
                if (s.indexOf('onvif://www.onvif.org/hardware/') === 0) {
                  hardware = s.split('/').pop() || ''
                } else if (s.indexOf('onvif://www.onvif.org/location/') === 0) {
                  location = s.split('/').pop() || ''
                } else if (s.indexOf('onvif://www.onvif.org/name/') === 0) {
                  name = s.split('/').pop() || ''
                  name = name.replace(/_/g, ' ')
                }
              })
              const probe = {
                urn,
                name,
                hardware,
                location,
                types,
                xaddrs,
                scopes,
              }
              devices[urn] = probe
            }
          }
        })
        .catch((error: unknown) => {
          console.error(
            'Error parsing SOAP message:',
            error instanceof Error ? error.message : String(error)
          )
        })
    })

    udp.bind(() => {
      if (!udp) {
        reject(new Error('UDP socket was unexpectedly closed'))
        return
      }
      udp.removeAllListeners('error')
      sendProbe().catch((e: unknown) => {
        reject(e instanceof Error ? e : new Error(String(e)))
      })
      discoveryIntervalTimer = setTimeout(() => {
        stopProbe()
          .then(() => {
            resolve(Object.values(devices))
          })
          .catch((err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)))
          })
      }, DISCOVERY_WAIT)
    })
  })
}

function sendProbe() {
  let soapTmpl = ''
  soapTmpl += '<?xml version="1.0" encoding="UTF-8"?>'
  soapTmpl +=
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">'
  soapTmpl += '  <s:Header>'
  soapTmpl +=
    '    <a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>'
  soapTmpl += '    <a:MessageID>uuid:__uuid__</a:MessageID>'
  soapTmpl += '    <a:ReplyTo>'
  soapTmpl +=
    '      <a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address>'
  soapTmpl += '    </a:ReplyTo>'
  soapTmpl += '    <a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>'
  soapTmpl += '  </s:Header>'
  soapTmpl += '  <s:Body>'
  soapTmpl += '    <Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery">'
  soapTmpl +=
    '      <d:Types xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dp0="http://www.onvif.org/ver10/network/wsdl">dp0:__type__</d:Types>'
  soapTmpl += '    </Probe>'
  soapTmpl += '  </s:Body>'
  soapTmpl += '</s:Envelope>'
  soapTmpl = soapTmpl.replace(/\>\s+\</g, '><')
  soapTmpl = soapTmpl.replace(/\s+/, ' ')

  const soapSet = ['NetworkVideoTransmitter', 'Device', 'NetworkVideoDisplay'].map((type) => {
    let s = soapTmpl
    s = s.replace('__type__', type)
    s = s.replace('__uuid__', createUuidV4())
    return s
  })

  const soapList: string[] = []
  Array(DISCOVERY_RETRY_MAX)
    .fill(0)
    .forEach(() => {
      soapSet.forEach((s) => {
        soapList.push(s)
      })
    })

  return new Promise<void>((resolve, reject) => {
    if (!udp) {
      reject(
        new Error('No UDP connection is available. The init() method might not be called yet.')
      )
      return
    }
    const send = () => {
      const soap = soapList.shift()
      if (soap) {
        const buf = Buffer.from(soap, 'utf8')
        if (!udp) {
          reject(new Error('UDP socket was unexpectedly closed'))
          return
        }
        udp.send(buf, 0, buf.length, PORT, MULTICAST_ADDRESS, () => {
          discoveryIntervalTimer = setTimeout(() => {
            send()
          }, DISCOVERY_INTERVAL)
        })
      } else {
        resolve()
      }
    }
    send()
  })
}

function createUuidV4(): string {
  const clist = randomBytes(16).toString('hex').toLowerCase().split('')
  clist[12] = '4'
  // tslint:disable-next-line: no-bitwise
  clist[16] = ((parseInt(clist[16], 16) & 3) | 8).toString(16)
  const m = clist.join('').match(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/)
  if (!m) {
    return randomBytes(16).toString('hex') // Fallback if match fails
  }
  const uuid = [m[1], m[2], m[3], m[4], m[5]].join('-')
  return uuid
}

export function stopDiscovery() {
  return stopProbe()
}

function stopProbe() {
  if (discoveryIntervalTimer !== null) {
    clearTimeout(discoveryIntervalTimer)
    discoveryIntervalTimer = null
  }

  if (discoveryWaitTimer !== null) {
    clearTimeout(discoveryWaitTimer)
    discoveryWaitTimer = null
  }

  return new Promise<void>((resolve) => {
    if (udp) {
      udp.close(() => {
        udp = null
        resolve()
      })
    } else {
      resolve()
    }
  })
}
