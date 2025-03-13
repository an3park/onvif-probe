import { XMLParser } from 'fast-xml-parser'
import { createHash } from 'node:crypto'

const parser = new XMLParser({
  transformTagName(tagName) {
    const match = tagName.match(/^([^\:]+)\:([^\:]+)$/)
    return match ? match[2] : tagName
  },
  ignoreAttributes: false,
})

export function parseXML<T>(data: string) {
  const jObj = parser.parse(data)
  return jObj as T
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

export interface SoapResponse<T> {
  Envelope: {
    Body: T
  }
}

export async function sendSoapRequest<T>(url: string, soapData: string) {
  const res = await fetch(url, {
    method: 'POST',
    body: soapData,
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8;',
    },
  })
  const text = await res.text()
  const xml = parseXML<SoapResponse<T>>(text)
  if (res.ok) {
    return xml.Envelope.Body
  }
  throw new Error((xml.Envelope.Body as any)?.Fault?.Reason?.Text || 'Unknown SOAP error')
}

interface SoapParams {
  xmlns?: string[]
  diff?: number
  user?: string
  pass?: string
  body: string
}

export function createRequestSoap(params: SoapParams): string {
  let soap = ''
  soap += '<?xml version="1.0" encoding="UTF-8"?>'
  soap += '<s:Envelope'
  soap += '  xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
  if (params.xmlns) {
    params.xmlns.forEach((ns) => {
      soap += ' ' + ns
    })
  }
  soap += '>'
  soap += '<s:Header>'
  if (params.user) {
    soap += createSoapUserToken(params.diff || 0, params.user, params.pass || '')
  }
  soap += '</s:Header>'
  soap += '<s:Body>' + params.body + '</s:Body>'
  soap += '</s:Envelope>'

  soap = soap.replace(/\>\s+\</g, '><')
  return soap.replace(/\s+/, ' ')
}

function createSoapUserToken(diff: number, user: string, pass: string) {
  if (!diff) {
    diff = 0
  }
  if (!pass) {
    pass = ''
  }
  const date = new Date(Date.now() + diff).toISOString()
  const nonceBuffer = createNonce(16)
  const nonceBase64 = nonceBuffer.toString('base64')
  const shasum = createHash('sha1')

  shasum.update(Buffer.concat([nonceBuffer, Buffer.from(date), Buffer.from(pass)]))
  const digest = shasum.digest('base64')
  return `<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
        <UsernameToken>
            <Username>${user}</Username>
            <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
            <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBase64}</Nonce>
            <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${date}</Created>
        </UsernameToken>
    </Security>`
}

function createNonce(digit: number) {
  const nonce = Buffer.alloc(digit)
  for (let i = 0; i < digit; i++) {
    nonce.writeUInt8(Math.floor(Math.random() * 256), i)
  }
  return nonce
}
