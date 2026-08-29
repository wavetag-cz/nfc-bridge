import { WebSocketServer } from "ws";
import { NFC } from "nfc-pcsc";

const PORT = 7788;
const ALLOWED_ORIGINS = ["https://admin.wavetag.cz", "http://localhost:5173"];
const CHIPS = {
  0x12: { chip: "NTAG213", capacity: 144 },
  0x3e: { chip: "NTAG215", capacity: 504 },
  0x6d: { chip: "NTAG216", capacity: 888 },
};
const URI_PREFIXES = {
  0x00: "",
  0x01: "http://www.",
  0x02: "https://www.",
  0x03: "http://",
  0x04: "https://",
};

let currentReader = null;
let currentCard = null;
let busy = false;

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: (info) => ALLOWED_ORIGINS.includes(info.origin),
});

const status = () => {
  return JSON.stringify({
    type: "status",
    reader: currentReader ? currentReader.name : null,
    card: currentCard,
  });
};

const broadcastStatus = () => {
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(status());
    }
  }
};

const buildNdefUrl = (url) => {
  let prefix = 0x00;
  let rest = url;

  if (url.startsWith("https://")) {
    prefix = 0x04;
    rest = url.slice(8);
  } else if (url.startsWith("http://")) {
    prefix = 0x03;
    rest = url.slice(7);
  }

  const payload = Buffer.concat([
    Buffer.from([prefix]),
    Buffer.from(rest, "utf8"),
  ]);

  if (payload.length > 255 || payload.length + 4 > 255) {
    return null;
  }

  const record = Buffer.concat([
    Buffer.from([0xd1, 0x01, payload.length, 0x55]),
    payload,
  ]);
  const tlv = Buffer.concat([
    Buffer.from([0x03, record.length]),
    record,
    Buffer.from([0xfe]),
  ]);
  const data = Buffer.alloc(Math.ceil(tlv.length / 4) * 4);
  tlv.copy(data);

  return data;
};

// Walks the TLV blocks on the tag and returns the body of the NDEF one. Tags
// written by phone apps often carry a lock or memory control block first, and
// a message over 254 bytes uses the three byte length form.
const findNdefMessage = (data) => {
  let i = 0;

  while (i + 1 < data.length) {
    const tag = data[i];

    if (tag === 0x00) {
      i++;
      continue;
    }

    if (tag === 0xfe) {
      return null;
    }

    let len = data[i + 1];
    let header = 2;

    if (len === 0xff) {
      if (i + 3 >= data.length) {
        return null;
      }

      len = data.readUInt16BE(i + 2);
      header = 4;
    }

    if (i + header + len > data.length) {
      return null;
    }

    if (tag === 0x03) {
      return data.slice(i + header, i + header + len);
    }

    i += header + len;
  }

  return null;
};

// Returns the first URI record in the message. Anything else in there (a text
// record, an Android application record) is skipped rather than rejected.
const findUriRecord = (message) => {
  let i = 0;

  while (i < message.length) {
    const header = message[i];
    const tnf = header & 0x07;
    const shortRecord = (header & 0x10) !== 0;
    const hasId = (header & 0x08) !== 0;
    let p = i + 1;

    if (p >= message.length) {
      return null;
    }

    const typeLen = message[p];
    p += 1;

    let payloadLen;

    if (shortRecord) {
      if (p >= message.length) {
        return null;
      }

      payloadLen = message[p];
      p += 1;
    } else {
      if (p + 4 > message.length) {
        return null;
      }

      payloadLen = message.readUInt32BE(p);
      p += 4;
    }

    const idLen = hasId ? message[p++] : 0;
    const type = message.slice(p, p + typeLen);
    p += typeLen + idLen;

    const payload = message.slice(p, p + payloadLen);
    p += payloadLen;

    if (p > message.length) {
      return null;
    }

    // TNF 1 is an NFC Forum well known type, "U" is the URI record.
    if (tnf === 0x01 && type.toString("ascii") === "U" && payload.length) {
      const prefix = URI_PREFIXES[payload[0]];

      if (prefix === undefined) {
        return null;
      }

      return prefix + payload.slice(1).toString("utf8");
    }

    // Message End flag: nothing follows this record.
    if ((header & 0x40) !== 0) {
      return null;
    }

    i = p;
  }

  return null;
};

const parseNdefUrl = (data) => {
  const message = findNdefMessage(data);

  return message ? findUriRecord(message) : null;
};

const writeUrl = async (url) => {
  if (busy) {
    return "nfc-busy";
  }

  if (!currentReader) {
    return "nfc-no-reader";
  }

  if (!currentCard || !currentCard.capacity) {
    return "nfc-no-card";
  }

  const data = buildNdefUrl(url);

  if (!data || data.length > currentCard.capacity) {
    return "nfc-too-long";
  }

  busy = true;

  try {
    try {
      await currentReader.write(4, data, 4);
    } catch (error) {
      console.error("Write failed:", error.message);
      return "nfc-write-failed";
    }

    try {
      const written = await currentReader.read(4, data.length, 4);

      if (!written.equals(data)) {
        return "nfc-verify-failed";
      }
    } catch (error) {
      console.error("Write verification failed:", error.message);
      return "nfc-verify-failed";
    }

    return null;
  } finally {
    busy = false;
  }
};

const lockTag = async () => {
  if (busy) {
    return "nfc-busy";
  }

  if (!currentReader) {
    return "nfc-no-reader";
  }

  if (!currentCard || !currentCard.capacity) {
    return "nfc-no-card";
  }

  busy = true;

  try {
    const cc = await currentReader.read(3, 4, 4);
    const locked = Buffer.from([cc[0], cc[1], cc[2], cc[3] | 0x0f]);

    await currentReader.write(3, locked, 4);

    const written = await currentReader.read(3, 4, 4);

    if (!written.equals(locked)) {
      return "nfc-lock-failed";
    }

    return null;
  } catch (error) {
    console.error("Lock failed:", error.message);
    return "nfc-lock-failed";
  } finally {
    busy = false;
  }
};

const readUrl = async () => {
  if (busy) {
    return { error: "nfc-busy" };
  }

  if (!currentReader) {
    return { error: "nfc-no-reader" };
  }

  if (!currentCard || !currentCard.capacity) {
    return { error: "nfc-no-card" };
  }

  busy = true;

  try {
    let data;

    try {
      data = await currentReader.read(4, currentCard.capacity, 4);
    } catch (error) {
      console.error("Read failed:", error.message);
      return { error: "nfc-read-failed" };
    }

    const url = parseNdefUrl(data);

    if (!url) {
      console.error("No URL on tag, first bytes:", data.slice(0, 48).toString("hex"));
      return { error: "nfc-no-ndef" };
    }

    return { url };
  } finally {
    busy = false;
  }
};

const sendResult = (ws, id, extra) => {
  ws.send(JSON.stringify({ type: "result", id: id ?? null, ...extra }));
};

wss.on("connection", (ws) => {
  ws.send(status());

  ws.on("message", async (message) => {
    let request;

    try {
      request = JSON.parse(message);
    } catch {
      sendResult(ws, null, { ok: false, error: "nfc-bad-request" });
      return;
    }

    if (
      !request ||
      typeof request !== "object" ||
      (request.type !== "writeUrl" &&
        request.type !== "readUrl" &&
        request.type !== "lock") ||
      (request.type === "writeUrl" && !request.url)
    ) {
      sendResult(
        ws,
        request && typeof request === "object" ? request.id : null,
        {
          ok: false,
          error: "nfc-bad-request",
        },
      );
      return;
    }

    if (request.type === "writeUrl") {
      console.log("Writing", request.url);
      const error = await writeUrl(request.url);
      sendResult(ws, request.id, { ok: !error, ...(error && { error }) });
      return;
    }

    if (request.type === "lock") {
      console.log("Locking tag");
      const error = await lockTag();
      sendResult(ws, request.id, { ok: !error, ...(error && { error }) });
      return;
    }

    console.log("Reading URL from tag");
    const result = await readUrl();
    sendResult(
      ws,
      request.id,
      result.error
        ? { ok: false, error: result.error }
        : { ok: true, url: result.url },
    );
  });
});

const nfc = new NFC();

nfc.on("reader", (reader) => {
  // Only the contactless side of the ACR1252. Laptops often expose a built in
  // smart card slot and a SIM reader as well, and those would otherwise
  // overwrite currentReader and report cards the bridge cannot process.
  if (!/acr1252/i.test(reader.name) || /sam/i.test(reader.name)) {
    console.log("Ignoring reader:", reader.name);
    // An emitter with no error listener throws, and these readers do emit
    // errors for whatever they hold, such as an inserted SIM card.
    reader.on("error", () => {});
    return;
  }

  console.log("Reader connected:", reader.name);
  currentReader = reader;
  broadcastStatus();

  reader.on("card", async (card) => {
    try {
      const cc = await reader.read(3, 4, 4);
      const chip = CHIPS[cc[2]] || { chip: "unknown", capacity: null };
      currentCard = { uid: card.uid, ...chip };
    } catch (error) {
      console.error("Failed to read tag:", error.message);
      currentCard = { uid: card.uid, chip: "unknown", capacity: null };
    }
    broadcastStatus();
  });

  reader.on("card.off", () => {
    currentCard = null;
    broadcastStatus();
  });

  reader.on("error", (error) => {
    console.error("Reader error:", error.message);
    if (currentReader === reader) {
      currentReader = null;
      currentCard = null;
    }
    broadcastStatus();
  });

  reader.on("end", () => {
    console.log("Reader disconnected:", reader.name);
    if (currentReader === reader) {
      currentReader = null;
      currentCard = null;
    }
    broadcastStatus();
  });
});

nfc.on("error", (error) => {
  console.error("NFC error:", error.message);
});

console.log("WaveTag NFC bridge running on ws://127.0.0.1:" + PORT);
