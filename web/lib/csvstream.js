// Streaming RFC 4180 reader for large CSV / CSV.gz files chosen in the browser.
// Never holds the file in memory: text arrives in chunks, rows are emitted as they
// complete. Quoted fields may contain commas, quotes ("" escape), CR and LF.

export class CsvParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.row = [];
    this.field = "";
    this.inQuotes = false;
    this.pendingQuote = false; // saw a quote inside a quoted field; next char decides
    this.pendingCR = false;
    this.fieldStarted = false;
  }

  push(chunk) {
    const s = chunk;
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i];
      if (this.inQuotes) {
        if (this.pendingQuote) {
          this.pendingQuote = false;
          if (ch === '"') { this.field += '"'; i++; continue; }
          this.inQuotes = false; // the quote closed the field; reprocess ch unquoted
          continue;
        }
        // take everything up to the next quote in one slice
        const q = s.indexOf('"', i);
        if (q === -1) { this.field += s.slice(i); i = n; break; }
        this.field += s.slice(i, q);
        this.pendingQuote = true;
        i = q + 1;
        continue;
      }
      if (this.pendingCR) {
        this.pendingCR = false;
        if (ch === "\n") { i++; continue; } // CRLF: the CR already ended the row
      }
      if (ch === '"' && !this.fieldStarted) { this.inQuotes = true; this.fieldStarted = true; i++; continue; }
      if (ch === ",") { this.row.push(this.field); this.field = ""; this.fieldStarted = false; i++; continue; }
      if (ch === "\n" || ch === "\r") {
        this.endRow();
        if (ch === "\r") this.pendingCR = true;
        i++;
        continue;
      }
      // unquoted run: slice to the next delimiter
      let j = i + 1;
      while (j < n) { const c = s[j]; if (c === "," || c === "\n" || c === "\r") break; j++; }
      this.field += s.slice(i, j);
      this.fieldStarted = true;
      i = j;
    }
  }

  endRow() {
    if (this.row.length === 0 && this.field === "" && !this.fieldStarted) return; // blank line
    this.row.push(this.field);
    const r = this.row;
    this.row = []; this.field = ""; this.fieldStarted = false;
    this.onRow(r);
  }

  finish() {
    if (this.inQuotes && this.pendingQuote) { this.inQuotes = false; this.pendingQuote = false; }
    if (this.row.length || this.field !== "" || this.fieldStarted) this.endRow();
  }
}

export function parseCsv(text) {
  const rows = [];
  const p = new CsvParser((r) => rows.push(r));
  p.push(text);
  p.finish();
  return rows;
}

// Read a File (plain or .gz) row by row. onRow(row, header) may be async-free for speed;
// onProgress(bytesRead, totalBytes) reports compressed bytes consumed.
export async function readCsvFile(file, onRow, onProgress) {
  let header = null;
  const parser = new CsvParser((r) => { if (!header) header = r; else onRow(r, header); });
  let stream = file.stream();
  let read = 0;
  const counter = new TransformStream({ transform(chunk, ctl) { read += chunk.byteLength; ctl.enqueue(chunk); } });
  stream = stream.pipeThrough(counter);
  if (/\.gz$/i.test(file.name)) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.pipeThrough(new TextDecoderStream("utf-8")).getReader();
  let lastReport = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
    if (onProgress && read - lastReport > 8e6) { lastReport = read; onProgress(read, file.size); await new Promise((r) => setTimeout(r, 0)); }
  }
  parser.finish();
  if (onProgress) onProgress(file.size, file.size);
  return header;
}

const api = { CsvParser, parseCsv, readCsvFile };
if (typeof window !== "undefined") window.CsvStream = api;
export default api;
