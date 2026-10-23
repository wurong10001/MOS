/* mos-vfs.js — MOS 虚拟文件系统（零依赖 ESM，浏览器 + Node 通用）
 *
 * 键值模型 + POSIX 风格路径：/system/wallpaper/星空粒子/index.html
 * 后端可注入：IDBBackend(IndexedDB, 浏览器默认) / MemoryBackend(测试)
 */

export function normalizePath(p) {
  if (typeof p !== "string" || !p) return "/";
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

const te = new TextEncoder();
const td = new TextDecoder();

export function MemoryBackend() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async set(k, v) { map.set(k, v); },
    async del(k) { map.delete(k); },
    async keys() { return Array.from(map.keys()); },
  };
}

export function IDBBackend(dbName) {
  let db = null;
  const tx = (mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction("files", mode);
    const req = fn(t.objectStore("files"));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return {
    async open() {
      if (db) return;
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName || "mos-vfs", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("files")) req.result.createObjectStore("files");
        };
        req.onsuccess = () => { db = req.result; resolve(); };
        req.onerror = () => reject(req.error);
      });
    },
    get: (k) => tx("readonly", (s) => s.get(k)),
    set: (k, v) => tx("readwrite", (s) => s.put(v, k)),
    del: (k) => tx("readwrite", (s) => s.delete(k)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
  };
}

export function createVFS({ backend } = {}) {
  const be = backend || IDBBackend();

  async function init() { if (be.open) await be.open(); }

  async function write(path, data) {
    path = normalizePath(path);
    if (path === "/") throw new Error("非法路径: /");
    const u8 = data instanceof Uint8Array ? data
      : (data && data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data));
    await be.set(path, { d: u8, m: Date.now(), s: u8.length });
  }
  async function writeText(path, str) { await write(path, te.encode(str)); }
  async function read(path) {
    const rec = await be.get(normalizePath(path));
    return rec ? rec.d : null;
  }
  async function readText(path) {
    const d = await read(path);
    return d ? td.decode(d) : null;
  }
  async function exists(path) { return (await read(path)) !== null || (await stat(path)) !== null; }
  async function stat(path) {
    path = normalizePath(path);
    const rec = await be.get(path);
    if (rec) return { size: rec.s, mtime: rec.m, isDir: false };
    const prefix = path === "/" ? "/" : path + "/";
    const keys = await be.keys();
    if (keys.some((k) => k.startsWith(prefix))) return { size: 0, mtime: 0, isDir: true };
    return null;
  }
  async function list(dir) {
    dir = normalizePath(dir);
    const prefix = dir === "/" ? "/" : dir + "/";
    const keys = await be.keys();
    const seen = new Map();
    for (const k of keys) {
      if (!k.startsWith(prefix) || k === dir) continue;
      const rest = k.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash < 0) {
        if (!seen.has(rest)) seen.set(rest, { name: rest, isDir: false });
      } else {
        const head = rest.slice(0, slash);
        if (!seen.has(head)) seen.set(head, { name: head, isDir: true });
      }
    }
    // 子树中若存在与文件同名的目录键，目录优先展示为 isDir
    return Array.from(seen.values());
  }
  async function remove(path) {
    path = normalizePath(path);
    await be.del(path);
    const prefix = path + "/";
    const keys = await be.keys();
    for (const k of keys) if (k.startsWith(prefix)) await be.del(k);
  }

  return { init, write, writeText, read, readText, exists, stat, list, remove };
}
