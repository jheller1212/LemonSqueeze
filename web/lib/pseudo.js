// Author pseudonyms, identical to the command-line tool: SHA-256 of salt + name, hex.
// The salt lives only in this browser (localStorage) unless the researcher copies it out;
// with the same salt the web app and the CLI give the same pseudonym for the same account,
// so files from both can be linked without ever storing a user name.
export const KEEP_AS_IS = ["[deleted]", "[removed]", "AutoModerator", ""];
const SALT_KEY = "ls_author_salt";

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSalt() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function validSalt(s) { return typeof s === "string" && /^[0-9a-f]{32,128}$/i.test(s.trim()); }

// storage: anything with getItem/setItem (localStorage in the page, a stub in tests)
export function loadOrCreateSalt(storage) {
  let salt = null;
  try { salt = storage.getItem(SALT_KEY); } catch { /* storage blocked */ }
  if (validSalt(salt)) return { salt: salt.trim(), created: false, persistent: true };
  salt = newSalt();
  let persistent = true;
  try { storage.setItem(SALT_KEY, salt); } catch { persistent = false; }
  return { salt, created: true, persistent };
}

export function importSalt(storage, salt) {
  if (!validSalt(salt)) throw new Error("A salt is 32–128 hexadecimal characters (the CLI's .salt file holds 64).");
  storage.setItem(SALT_KEY, salt.trim().toLowerCase());
  return salt.trim().toLowerCase();
}

export function createPseudonymiser(salt) {
  const cache = new Map();
  for (const k of KEEP_AS_IS) cache.set(k, k);
  async function learn(names) {
    const todo = Array.from(new Set(names)).filter((n) => !cache.has(n ?? ""));
    const hashes = await Promise.all(todo.map((n) => sha256Hex(salt + n)));
    todo.forEach((n, i) => cache.set(n, hashes[i]));
  }
  const of = (name) => cache.get(name ?? "") ?? "";
  // posts with their comments → copies whose author fields are pseudonyms
  async function apply(posts) {
    const names = [];
    for (const p of posts) { names.push(p.author ?? ""); for (const c of p.comments || []) names.push(c.author ?? ""); }
    await learn(names);
    return posts.map((p) => ({ ...p, author: of(p.author), comments: (p.comments || []).map((c) => ({ ...c, author: of(c.author) })) }));
  }
  return { learn, of, apply };
}

const api = { KEEP_AS_IS, sha256Hex, newSalt, validSalt, loadOrCreateSalt, importSalt, createPseudonymiser };
if (typeof window !== "undefined") window.Pseudo = api;
export default api;
