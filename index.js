import { WebSocketServer } from "ws";
import { NFC } from "nfc-pcsc";

import { log, logPath } from "./logger.js";

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

let nfc = null;
let currentReader = null;
let currentCard = null;
let busy = false;
let readerMissingSince = Date.now();
let retryDelay = 15000;

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

  if (payload.length + 4 > 255) {
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

    if (tnf === 0x01 && type.toString("ascii") === "U" && payload.length) {
      const prefix = URI_PREFIXES[payload[0]];

      return prefix === undefined
        ? null
        : prefix + payload.slice(1).toString("utf8");
    }

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
  const data = buildNdefUrl(url);

  if (!data || data.length > currentCard.capacity) {
    return { error: "nfc-too-long" };
  }

  try {
    await currentReader.write(4, data, 4);
  } catch (error) {
    log("Write failed:", error.message);
    return { error: "nfc-write-failed" };
  }

  try {
    const written = await currentReader.read(4, data.length, 4);

    if (!written.equals(data)) {
      return { error: "nfc-verify-failed" };
    }
  } catch (error) {
    log("Write verification failed:", error.message);
    return { error: "nfc-verify-failed" };
  }

  return {};
};

const lockTag = async () => {
  try {
    const cc = await currentReader.read(3, 4, 4);
    const locked = Buffer.from([cc[0], cc[1], cc[2], cc[3] | 0x0f]);

    await currentReader.write(3, locked, 4);

    const written = await currentReader.read(3, 4, 4);

    return written.equals(locked) ? {} : { error: "nfc-lock-failed" };
  } catch (error) {
    log("Lock failed:", error.message);
    return { error: "nfc-lock-failed" };
  }
};

const readUrl = async () => {
  let data;

  try {
    data = await currentReader.read(4, currentCard.capacity, 4);
  } catch (error) {
    log("Read failed:", error.message);
    return { error: "nfc-read-failed" };
  }

  const url = parseNdefUrl(data);

  if (!url) {
    log("No URL on tag, first bytes:", data.slice(0, 48).toString("hex"));
    return { error: "nfc-no-ndef" };
  }

  return { url };
};

const runRequest = async (request) => {
  const type = request.type;

  if (type !== "writeUrl" && type !== "readUrl" && type !== "lock") {
    return { error: "nfc-bad-request" };
  }

  if (type === "writeUrl" && typeof request.url !== "string") {
    return { error: "nfc-bad-request" };
  }

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
    if (type === "writeUrl") {
      return await writeUrl(request.url);
    }

    if (type === "lock") {
      return await lockTag();
    }

    return await readUrl();
  } finally {
    busy = false;
  }
};

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: (info) => {
    if (ALLOWED_ORIGINS.includes(info.origin)) {
      return true;
    }

    log("Rejected connection from origin:", info.origin);
    return false;
  },
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

wss.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    log("Port " + PORT + " is taken, another bridge is already running.");
    process.exit(1);
  }

  log("Server error:", error.message);
});

wss.on("connection", (ws) => {
  ws.send(status());

  ws.on("message", async (message) => {
    let request;

    try {
      request = JSON.parse(message);
    } catch {
      request = null;
    }

    if (!request || typeof request !== "object") {
      ws.send(
        JSON.stringify({
          type: "result",
          id: null,
          ok: false,
          error: "nfc-bad-request",
        }),
      );
      return;
    }

    const result = await runRequest(request);

    if (result.error) {
      log(request.type + " failed:", result.error);
    }

    ws.send(
      JSON.stringify({
        type: "result",
        id: request.id ?? null,
        ok: !result.error,
        ...result,
      }),
    );
  });
});

const forgetReader = (reader) => {
  if (currentReader === reader) {
    currentReader = null;
    currentCard = null;
    readerMissingSince = Date.now();
    broadcastStatus();
  }
};

const startNfc = () => {
  readerMissingSince = Date.now();
  nfc = new NFC();

  nfc.on("error", (error) => {
    log("PC/SC error:", error.message);
  });

  nfc.on("reader", (reader) => {
    // Laptops expose a built in smart card slot and the reader's own SIM slot
    // as well, and those would otherwise report cards the bridge cannot handle.
    if (!/acr1252/i.test(reader.name) || /sam/i.test(reader.name)) {
      log("Ignoring reader:", reader.name);
      reader.on("error", () => {});
      return;
    }

    log("Reader connected:", reader.name);
    currentReader = reader;
    retryDelay = 15000;
    broadcastStatus();

    reader.on("card", async (card) => {
      try {
        const cc = await reader.read(3, 4, 4);
        currentCard = {
          uid: card.uid,
          ...(CHIPS[cc[2]] || { chip: "unknown", capacity: null }),
        };
      } catch (error) {
        log("Failed to read tag:", error.message);
        currentCard = { uid: card.uid, chip: "unknown", capacity: null };
      }

      broadcastStatus();
    });

    reader.on("card.off", () => {
      currentCard = null;
      broadcastStatus();
    });

    reader.on("error", (error) => {
      log("Reader error:", error.message);
      forgetReader(reader);
    });

    reader.on("end", () => {
      log("Reader disconnected:", reader.name);
      forgetReader(reader);
    });
  });
};

// pcsclite builds its context once and gives up for good if that fails. On
// Windows the smart card service starts on demand, so it is often still down
// when the bridge starts with the computer, which used to leave the bridge
// running but blind to the reader until someone restarted it by hand. The first
// retries come quickly for that case, then slow down so an unplugged reader
// does not mean a restart every minute for the rest of the day.
const restartNfcIfBlind = () => {
  if (currentReader || busy || Date.now() - readerMissingSince < retryDelay) {
    return;
  }

  log("No reader for " + retryDelay / 1000 + "s, restarting PC/SC");

  try {
    nfc.close();
  } catch (error) {
    log("Closing PC/SC failed:", error.message);
  }

  nfc.removeAllListeners();
  currentCard = null;
  retryDelay = Math.min(retryDelay * 2, 300000);
  startNfc();
};

process.on("uncaughtException", (error) => {
  log("Uncaught exception:", error.stack || error.message);
});

process.on("unhandledRejection", (error) => {
  log("Unhandled rejection:", error);
});

log(
  "WaveTag NFC bridge starting on ws://127.0.0.1:" + PORT,
  "| node " + process.version,
  process.platform + "/" + process.arch,
  "| pid " + process.pid,
);
log("Logging to", logPath);

startNfc();

setInterval(restartNfcIfBlind, 5000);
