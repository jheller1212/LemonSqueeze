import test from "node:test";
import assert from "node:assert/strict";
import { CsvParser, parseCsv } from "../../../web/lib/csvstream.js";

test("plain rows, CRLF and LF, trailing newline optional", () => {
  assert.deepEqual(parseCsv("a,b,c\r\n1,2,3\n4,5,6"), [["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]]);
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("quoted fields: commas, escaped quotes, LF, CRLF and a bare CR inside", () => {
  const rows = parseCsv('id,text\n1,"a, ""quoted"" b"\n2,"line1\nline2"\n3,"cr\rinside"\n4,"crlf\r\ninside"\n');
  assert.deepEqual(rows, [["id", "text"], ["1", 'a, "quoted" b'], ["2", "line1\nline2"], ["3", "cr\rinside"], ["4", "crlf\r\ninside"]]);
});

test("empty fields, empty quoted fields, blank lines skipped", () => {
  assert.deepEqual(parseCsv('a,,c\n"",x,\n\n\n1,2,3\n'), [["a", "", "c"], ["", "x", ""], ["1", "2", "3"]]);
});

test("any chunking gives the same rows", () => {
  const text = 'post_id,title,body\nabc,"Hello, ""world""","multi\r\nline, with ""quotes"""\r\ndef,plain,"x"\n';
  const whole = parseCsv(text);
  for (let size = 1; size <= 9; size++) {
    const rows = [];
    const p = new CsvParser((r) => rows.push(r));
    for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
    p.finish();
    assert.deepEqual(rows, whole, `chunk size ${size}`);
  }
});
