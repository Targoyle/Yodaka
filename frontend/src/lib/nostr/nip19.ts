const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATORS = [
  0x3b6a57b2,
  0x26508e6d,
  0x1ea119fa,
  0x3d4233dd,
  0x2a1462b3,
];

export function encodeNpub(hex: string) {
  return encodeKey("npub", hex);
}

export function encodeNsec(hex: string) {
  return encodeKey("nsec", hex);
}

function encodeKey(hrp: string, hex: string) {
  const bytes = hexToBytes(hex);

  if (!bytes || bytes.length !== 32) {
    return null;
  }

  const words = convertBits(bytes, 8, 5, true);

  if (!words) {
    return null;
  }

  return bech32Encode(hrp, words);
}

export function decodeNpub(value: string) {
  return decodeKey("npub", value);
}

export function decodeNsec(value: string) {
  return decodeKey("nsec", value);
}

function decodeKey(expectedHrp: string, value: string) {
  const decoded = bech32Decode(value, expectedHrp);

  if (!decoded || decoded.hrp !== expectedHrp) {
    return null;
  }

  const bytes = convertBits(new Uint8Array(decoded.data), 5, 8, false);

  if (!bytes || bytes.length !== 32) {
    return null;
  }

  return bytesToHex(bytes);
}

export function encodeNevent(eventIdHex: string) {
  const eventIdBytes = hexToBytes(eventIdHex);

  if (!eventIdBytes || eventIdBytes.length !== 32) {
    return null;
  }

  const tlv = encodeTlv([
    {
      type: 0,
      value: eventIdBytes,
    },
  ]);
  const words = convertBits(tlv, 8, 5, true);

  if (!words) {
    return null;
  }

  return bech32Encode("nevent", words);
}

export function decodeNevent(value: string) {
  const decoded = bech32Decode(value, "nevent");

  if (!decoded || decoded.hrp !== "nevent") {
    return null;
  }

  const bytes = convertBits(new Uint8Array(decoded.data), 5, 8, false);

  if (!bytes) {
    return null;
  }

  let eventId: string | null = null;
  let authorPubkey: string | null = null;
  const relayUrls: string[] = [];
  let offset = 0;

  while (offset + 2 <= bytes.length) {
    const type = bytes[offset];
    const length = bytes[offset + 1];
    const valueStart = offset + 2;
    const valueEnd = valueStart + length;

    if (valueEnd > bytes.length) {
      return null;
    }

    const entryBytes = Uint8Array.from(bytes.slice(valueStart, valueEnd));

    if (type === 0 && entryBytes.length === 32) {
      eventId = bytesToHex(entryBytes);
    } else if (type === 1 && entryBytes.length > 0) {
      const relayUrl = decodeUtf8(entryBytes).trim();

      if (relayUrl.length > 0) {
        relayUrls.push(relayUrl);
      }
    } else if (type === 2 && entryBytes.length === 32) {
      authorPubkey = bytesToHex(entryBytes);
    }

    offset = valueEnd;
  }

  if (!eventId) {
    return null;
  }

  return {
    eventId,
    relayUrls,
    authorPubkey,
  };
}

function encodeTlv(
  entries: Array<{
    type: number;
    value: Uint8Array;
  }>,
) {
  const totalLength = entries.reduce(
    (length, entry) => length + 2 + entry.value.length,
    0,
  );
  const bytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const entry of entries) {
    bytes[offset] = entry.type;
    bytes[offset + 1] = entry.value.length;
    bytes.set(entry.value, offset + 2);
    offset += 2 + entry.value.length;
  }

  return bytes;
}

function hexToBytes(hex: string) {
  const normalized = hex.trim().toLowerCase().replace(/^0x/, "");

  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    return null;
  }

  if (!/^[0-9a-f]+$/.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }

  return bytes;
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function convertBits(
  data: Uint8Array,
  fromBits: number,
  toBits: number,
  pad: boolean,
) {
  let value = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;

  for (const item of data) {
    if (item < 0 || item >> fromBits !== 0) {
      return null;
    }

    value = ((value << fromBits) | item) & maxAccumulator;
    bits += fromBits;

    while (bits >= toBits) {
      bits -= toBits;
      result.push((value >> bits) & maxValue);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((value << (toBits - bits)) & maxValue);
    }
  } else if (bits >= fromBits || ((value << (toBits - bits)) & maxValue) !== 0) {
    return null;
  }

  return result;
}

function bech32Encode(hrp: string, data: number[]) {
  const checksum = createChecksum(hrp, data);
  const combined = [...data, ...checksum];
  const payload = combined.map((value) => BECH32_CHARSET[value]).join("");

  return `${hrp}1${payload}`;
}

function bech32Decode(value: string, expectedHrp?: string) {
  const normalized = value.trim().replace(/^nostr:/i, "").toLowerCase();
  const separatorIndex = normalized.lastIndexOf("1");
  const hrp = normalized.slice(0, separatorIndex);

  if (
    separatorIndex <= 0 ||
    separatorIndex + 7 > normalized.length ||
    hrp.length === 0 ||
    (expectedHrp !== undefined && hrp !== expectedHrp)
  ) {
    return null;
  }
  const payload = normalized.slice(separatorIndex + 1);
  const data: number[] = [];

  for (const character of payload) {
    const index = BECH32_CHARSET.indexOf(character);

    if (index < 0) {
      return null;
    }

    data.push(index);
  }

  if (!verifyChecksum(hrp, data)) {
    return null;
  }

  return {
    hrp,
    data: data.slice(0, -6),
  };
}

function createChecksum(hrp: string, data: number[]) {
  const values = [...expandHrp(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;

  return Array.from({ length: 6 }, (_, index) => {
    const shift = 5 * (5 - index);
    return (mod >>> shift) & 31;
  });
}

function verifyChecksum(hrp: string, data: number[]) {
  return polymod([...expandHrp(hrp), ...data]) === 1;
}

function expandHrp(hrp: string) {
  const result: number[] = [];

  for (const char of hrp) {
    result.push(char.charCodeAt(0) >> 5);
  }

  result.push(0);

  for (const char of hrp) {
    result.push(char.charCodeAt(0) & 31);
  }

  return result;
}

function polymod(values: number[]) {
  let checksum = 1;

  for (const value of values) {
    const top = checksum >>> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;

    for (let bit = 0; bit < BECH32_GENERATORS.length; bit += 1) {
      if ((top >>> bit) & 1) {
        checksum = (checksum ^ BECH32_GENERATORS[bit]) >>> 0;
      }
    }
  }

  return checksum;
}

function bytesToHex(bytes: ArrayLike<number>) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
