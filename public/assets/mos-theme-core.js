/* mos-theme-core.js — 壁纸/主题协议核心（零依赖，浏览器 + Node 通用）
 *
 * 规则（对应用户的壁纸主题设计）:
 *  - zip 且能解析出 HTML 入口(manifest.entry 优先; 命名候选 desktop-wallpaper.html
 *    > index.html > wallpaper/ 与 theme/ 下同名; 再兜底根下唯一 *.html) => "动态主题":
 *    全量文件入库 /system/wallpaper/<壁纸名>/, css/js 外链内联成可渲染文档, 宿主放入 sandbox iframe
 *  - zip 但无 HTML 入口 => "图片包": 仅图片扩展名条目入库(防目录穿越)
 *  - 非 zip 但图片扩展名 => 单图入库 /system/wallpaper/<文件名>
 *  - 其余 => 抛错, 不落盘
 *  - 当前壁纸指针: /system/wallpaper/.last = {kind:'image'|'theme', path}
 *  - 主题元数据: <themeDir>/.theme.json = {entryName, manifest}
 */
import { openZip, sanitizeEntryName } from "./mos-zip.js";

const td = new TextDecoder();
const te = new TextEncoder();
const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]);

export function isZip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

const asU8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x.buffer || x));
const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};
const baseOf = (name) => name.replace(/\.[^.]+$/, "") || name;
const dirOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

function resolveRel(baseDir, href) {
  let h = String(href).split("#")[0].split("?")[0];
  if (/^[a-z]+:\/\//i.test(h) || h.startsWith("//") || h.startsWith("data:")) return null;
  h = h.replace(/^\.\//, "");
  if (h.startsWith("/")) h = h.slice(1);
  const parts = (baseDir ? baseDir.split("/") : []).concat(h.split("/"));
  const out = [];
  for (const s of parts) {
    if (!s || s === ".") continue;
    if (s === "..") { out.pop(); continue; }
    out.push(s);
  }
  return out.join("/");
}

function sanitizeName(name) {
  const s = String(name || "").replace(/[\/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return s || "theme";
}

async function readText(zip, name) { return td.decode(await zip.read(name)); }

/* ---------- 主题协议 ---------- */
export async function resolveTheme(zip) {
  const names = zip.entries.map((e) => e.name);
  let manifest = null;
  const mi = names.indexOf("manifest.json");
  if (mi >= 0) {
    try { manifest = JSON.parse(await readText(zip, "manifest.json")); } catch (e) { manifest = null; }
  }
  const cands = [];
  if (manifest && manifest.entry) cands.push(String(manifest.entry).replace(/^\.?\//, ""));
  cands.push("desktop-wallpaper.html", "index.html",
    "wallpaper/desktop-wallpaper.html", "wallpaper/index.html", "theme/index.html");
  for (const c of cands) if (names.includes(c)) return { entryName: c, manifest };
  const roots = names.filter((n) => !n.includes("/") && /\.html$/i.test(n)).sort();
  if (roots.length) return { entryName: roots[0], manifest };
  throw new Error("zip 里没有壁纸入口（缺 index.html / manifest.entry / 根下单个 html）");
}

export async function buildThemeDocument(zip, entryName) {
  let html = await readText(zip, entryName);
  const base = dirOf(entryName);

  async function replaceAll(rx, fn) {
    const ms = Array.from(html.matchAll(rx));
    for (const m of ms) {
      const rep = await fn(m);
      if (rep !== null) html = html.split(m[0]).join(rep);
    }
  }

  await replaceAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, async (m) => {
    if (!/stylesheet/i.test(m[0])) return null;
    const name = resolveRel(base, m[1]);
    if (!name || !zip.entries.some((e) => e.name === name)) return null;
    return "<style>" + (await readText(zip, name)) + "</style>";
  });

  await replaceAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, async (m) => {
    const name = resolveRel(base, m[1]);
    if (!name || !zip.entries.some((e) => e.name === name)) return null;
    const js = (await readText(zip, name)).replace(/<\/script/gi, "<\\/script");
    return "<script>" + js + "</script>";
  });

  return html;
}

/* VFS 目录 -> zip 兼容读取器（供宿主从已入库主题重建文档） */
export function vfsZip(vfs, dir) {
  dir = dir.replace(/\/+$/, "");
  return {
    entries: [],
    _loaded: false,
    async load() {
      const acc = [];
      const walk = async (sub) => {
        const items = await vfs.list(sub || dir);
        for (const it of items) {
          const p = (sub ? sub + "/" : dir + "/") + it.name;
          if (it.isDir) await walk(p);
          else acc.push({ name: p.slice(dir.length + 1), size: 0 });
        }
      };
      await walk("");
      this.entries = acc;
      this._loaded = true;
    },
    async read(nameOrEntry) {
      const name = typeof nameOrEntry === "string" ? nameOrEntry : nameOrEntry.name;
      if (name === "manifest.json" && !this._loaded) { /* 允许先读 manifest */ }
      const d = await vfs.read(dir + "/" + name);
      if (!d) throw new Error("主题文件缺失: " + name);
      return d;
    },
  };
}

export async function installTheme(bufferOrZip, name, vfs) {
  const zip = typeof bufferOrZip === "object" && bufferOrZip.read
    ? bufferOrZip : await openZip(bufferOrZip);
  const { entryName, manifest } = await resolveTheme(zip);
  const themeName = sanitizeName(baseOf(name)); // 目录名跟随文件名（壁纸名），manifest.name 仅做显示
  const displayName = (manifest && manifest.name) || themeName;
  const themeDir = "/system/wallpaper/" + themeName;
  for (const e of zip.entries) {
    if (e.name.endsWith("/")) continue;
    const clean = sanitizeEntryName(e.name);
    if (!clean) continue;
    await vfs.write(themeDir + "/" + clean, asU8(await zip.read(e)));
  }
  const meta = te.encode(JSON.stringify({
    entryName, manifest: manifest || null, name: themeName, displayName,
  }));
  await vfs.write(themeDir + "/.theme.json", meta);
  const document = await buildThemeDocument(zip, entryName);
  return { kind: "theme", themeDir, entryName, manifest, name: themeName, displayName, document };
}

/* ---------- 统一入口 ---------- */
export async function installWallpaper(buffer, name, vfs) {
  if (isZip(buffer)) {
    const zip = await openZip(buffer);
    let themeErr = null;
    try {
      return await installTheme(zip, name, vfs);
    } catch (e) { themeErr = e; }
    const dirName = sanitizeName(baseOf(name));
    const files = [];
    for (const e of zip.entries) {
      if (e.name.endsWith("/")) continue;
      if (!IMG_EXT.has(extOf(e.name))) continue;
      const clean = sanitizeEntryName(e.name);
      if (!clean) continue;
      await vfs.write("/system/wallpaper/" + dirName + "/" + clean, asU8(await zip.read(e)));
      files.push("/system/wallpaper/" + dirName + "/" + clean);
    }
    if (!files.length) {
      throw new Error("zip 没有可见内容（既无壁纸入口也没有图片）: " +
        (themeErr ? themeErr.message : ""));
    }
    return { kind: "image", files, name: dirName };
  }
  const ext = extOf(name);
  if (!IMG_EXT.has(ext)) throw new Error("不是壁纸文件或主题 zip: " + name);
  const path = "/system/wallpaper/" + sanitizeName(name);
  await vfs.write(path, asU8(buffer));
  return { kind: "image", files: [path], name: baseOf(name) };
}

/* ---------- 当前壁纸指针 ---------- */
export async function setDesktopWallpaper(vfs, path) {
  const st = await vfs.stat(path);
  if (!st) throw new Error("壁纸路径不存在: " + path);
  const kind = st.isDir ? "theme" : "image";
  await vfs.writeText("/system/wallpaper/.last", JSON.stringify({ kind, path }));
  return { kind, path };
}
export async function getDesktopWallpaper(vfs) {
  const txt = await vfs.readText("/system/wallpaper/.last");
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}
