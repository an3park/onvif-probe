import { createSocket } from 'node:dgram'
import { createRequestSoap, parseXML, sendSoapRequest, SoapResponse } from './soap'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DISCOVERY_RETRY_MAX = 3
const DISCOVERY_WAIT = 3000
const DISCOVERY_INTERVAL = 150
const MULTICAST_ADDRESS = '239.255.255.250'
const PORT = 3702

function createUuidV4() {
  return crypto.randomUUID()
}

interface ProbeMatches {
  ProbeMatches: {
    ProbeMatch: {
      EndpointReference: { Address: string }
      Types: string
      Scopes: string
      XAddrs: string
    }
  }
}

export interface OnvifDevice {
  urn: string
  xaddrs: string[]
  scopes?: string[]
  types?: string[]
}

export async function sendProbe() {
  const probeTemplate = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:MessageID>uuid:__uuid__</a:MessageID><a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header><s:Body><Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery"><d:Types xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dp0="http://www.onvif.org/ver10/network/wsdl">dp0:__type__</d:Types></Probe></s:Body></s:Envelope>`

  const soapSet = ['NetworkVideoTransmitter', 'Device', 'NetworkVideoDisplay'].map((type) => {
    return probeTemplate.replace('__type__', type).replace('__uuid__', createUuidV4())
  })

  const soapList: string[] = []
  Array(DISCOVERY_RETRY_MAX)
    .fill(0)
    .forEach(() => {
      soapSet.forEach((s) => {
        soapList.push(s)
      })
    })

  const udp = createSocket('udp4')

  const devices: Record<string, OnvifDevice> = {}

  udp.on('message', (buf) => {
    try {
      const xml = parseXML<SoapResponse<ProbeMatches>>(buf.toString())

      const { ProbeMatch } = xml.Envelope.Body.ProbeMatches

      const device: OnvifDevice = {
        urn: ProbeMatch.EndpointReference?.Address,
        xaddrs: ProbeMatch.XAddrs?.split(/\s+/),
        scopes: ProbeMatch.Scopes?.split(/\s+/),
        types: ProbeMatch.Types?.split(/\s+/),
      }

      devices[device.urn] = Object.assign(devices[device.urn] || {}, device)
    } catch (_) {}
  })

  for (const soap of soapList) {
    const buf = Buffer.from(soap, 'utf8')
    udp.send(buf, 0, buf.length, PORT, MULTICAST_ADDRESS)
    await sleep(DISCOVERY_INTERVAL)
  }
  await sleep(DISCOVERY_WAIT)

  udp.close()

  return Object.values(devices)
}

interface GetCapabilitiesResponse {
  GetCapabilitiesResponse: {
    Capabilities: {
      Media: {
        XAddr: string
        StreamingCapabilities: { RTPMulticast: boolean; RTP_TCP: boolean; RTP_RTSP_TCP: boolean }
        Extension: { ProfileCapabilities: { MaximumNumberOfProfiles: number } }
      }
    }
  }
}

export async function getCapabilities(
  url: string,
  { user, pass }: { user?: string; pass?: string }
) {
  const capabilities = await sendSoapRequest<GetCapabilitiesResponse>(
    url,
    createRequestSoap({
      body: `<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities></s:Body>`,
      xmlns: [
        'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"',
        'xmlns:tt="http://www.onvif.org/ver10/schema"',
      ],
      user,
      pass,
    })
  )
  return capabilities.GetCapabilitiesResponse
}

interface GetProfilesResponse {
  GetProfilesResponse: {
    Profiles: Array<{
      Name: string
      VideoSourceConfiguration: {
        Name: string
        UseCount: number
        SourceToken: number
        Bounds: string
        '@_token': string
      }
      AudioSourceConfiguration: {
        Name: string
        UseCount: number
        SourceToken: number
        '@_token': string
      }
      VideoEncoderConfiguration: {
        Name: string
        UseCount: number
        Encoding: string
        Resolution: { Width: number; Height: number }
        Quality: number
        RateControl: { FrameRateLimit: number; EncodingInterval: number; BitrateLimit: number }
        H264: { GovLength: number; H264Profile: string; H264Level: string }
        Multicast: { Address: unknown; Port: number }
        SessionTimeout: string
        '@_token': string
      }
      AudioEncoderConfiguration: {
        Name: string
        UseCount: number
        Encoding: string
        Bitrate: number
        SampleRate: number
        Multicast: { Address: unknown; Port: number }
        SessionTimeout: string
        '@_token': string
      }
      VideoAnalyticsConfiguration: unknown
      PTZConfiguration: unknown
    }>
  }
}

export async function getProfiles(url: string, { user, pass }: { user?: string; pass?: string }) {
  const profiles = await sendSoapRequest<GetProfilesResponse>(
    url,
    createRequestSoap({
      body: '<trt:GetProfiles/>',
      xmlns: [
        'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
        'xmlns:tt="http://www.onvif.org/ver10/schema"',
      ],
      user,
      pass,
    })
  )
  return profiles.GetProfilesResponse
}

interface GetStreamUriResponse {
  GetStreamUriResponse: {
    MediaUri: {
      Uri: string
      InvalidAfterConnect: boolean
      InvalidAfterReboot: boolean
      Timeout: string
    }
  }
}

export async function getStreamUri(
  url: string,
  {
    user,
    pass,
    protocol,
    profileToken,
  }: { user?: string; pass?: string; protocol: 'UDP' | 'HTTP' | 'RTSP'; profileToken: string }
) {
  let soapBody = ''
  soapBody += '<trt:GetStreamUri>'
  soapBody += '<trt:StreamSetup>'
  soapBody += '<tt:Stream>RTP-Unicast</tt:Stream>'
  soapBody += '<tt:Transport>'
  soapBody += '<tt:Protocol>' + protocol + '</tt:Protocol>'
  soapBody += '</tt:Transport>'
  soapBody += '</trt:StreamSetup>'
  soapBody += '<trt:ProfileToken>' + profileToken + '</trt:ProfileToken>'
  soapBody += '</trt:GetStreamUri>'

  const streamUri = await sendSoapRequest<GetStreamUriResponse>(
    url,
    createRequestSoap({
      body: soapBody,
      xmlns: [
        'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
        'xmlns:tt="http://www.onvif.org/ver10/schema"',
      ],
      user,
      pass,
    })
  )
  return streamUri.GetStreamUriResponse
}
