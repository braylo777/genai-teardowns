// Minimal SSE helpers: write events, and parse a byte stream into {event, data} records.
export function writeEvent(res, data, event) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

export class SSEParser {
  constructor() { this.buf = ''; }
  push(chunk) {
    this.buf += chunk;
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message'; const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}

// Read an SSE response (fetch Response) as an async iterator of events.
export async function* readSSE(body) {
  const p = new SSEParser();
  const dec = new TextDecoder();
  for await (const chunk of body) for (const e of p.push(dec.decode(chunk, { stream: true }))) yield e;
}
