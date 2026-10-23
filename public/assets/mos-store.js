/* mos-store.js — 应用商店核心（零依赖 ESM，浏览器 + Node 通用）
 *
 * 职责: 从软件源条目(item)安装应用/壁纸到 VFS，SHA256 先验后写；卸载；已装列表。
 * 布局:
 *   zip 应用   → /system/apps/<id>/...            元数据 <dir>/.app.json
 *   单文件应用 → /system/apps/<文件名>             元数据 /system/apps/.<id>.meta.json(隐藏)
 *   壁纸/主题  → 复用 mos-theme-core（/system/wallpaper/...）
 * 网络与校验解耦：fetcher(item)->Promise<ArrayBuffer> 注入（浏览器用 MosRepo，测试用 fixture）
 */
import { openZip, sanitizeEntryName } from "./mos-zip.js";
import { isZip, installWallpaper } from "./mos-theme-core.js";

export const APPS_ROOT = "/system/apps";

const asU8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x.buffer || x));
const baseName = (n) => (n || "").replace(/\.[^.]+$/, "") || "app";
const extOf = (n) => { const i = (n || "").lastIndexOf("."); return i < 0 ? "" : n.slice(i + 1).toLowerCase(); };
export function sanitizeId(s) {
  const out = String(s || "").replace(/[\/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return out || "app";
}

export async function defaultSha256(arrayBuffer) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error("环境缺少 crypto.subtle，无法校验");
  const d = await subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 安装一个软件源条目。
 * @param item  索引条目 {name, path, category, sha256, size...}
 * @param vfs   createVFS() 实例
 * @param fetcher (item) => Promise<ArrayBuffer>
 * @returns 应用: {kind:'app', id, dir, files} / 壁纸: {kind:'theme'|'image', ...}
 */
export async function installItem(item, vfs, fetcher, { sha256 = defaultSha256 } = {}) {
  const buf = await fetcher(item);

  // 先验后写：校验失败不产生任何文件
  if (item.sha256) {
    const hex = await sha256(buf);
    if (hex !== item.sha256) {
      throw new Error(`SHA256 校验失败: ${item.name}（期望 ${item.sha256.slice(0, 12)}… 实际 ${hex.slice(0, 12)}…）`);
    }
  }

  if (item.category === "wallpaper") {
    return await installWallpaper(buf, item.name, vfs);
  }

  const id = sanitizeId(baseName(item.name));
  const now = new Date().toISOString();
  const meta = { id, source: item.path, name: item.name,
    sha256: item.sha256 || null, installed_at: now };

  if (isZip(buf)) {
    const zip = await openZip(buf);
    const files = [];
    for (const e of zip.entries) {
      if (e.name.endsWith("/")) continue;
      const clean = sanitizeEntryName(e.name);
      if (!clean) continue;
      await vfs.write(`${APPS_ROOT}/${id}/${clean}`, asU8(await zip.read(e)));
      files.push(clean);
    }
    meta.files = files;
    meta.dir = `${APPS_ROOT}/${id}`;
    await vfs.writeText(`${APPS_ROOT}/${id}/.app.json`, JSON.stringify(meta));
    return { kind: "app", id, dir: `${APPS_ROOT}/${id}`, files };
  }

  const ext = extOf(item.name);
  const filePath = `${APPS_ROOT}/${id}${ext ? "." + ext : ""}`;
  await vfs.write(filePath, asU8(buf));
  await vfs.writeText(`${APPS_ROOT}/.${id}.meta.json`,
    JSON.stringify({ ...meta, files: [filePath] }));
  return { kind: "app", id, dir: `${APPS_ROOT}`, files: [filePath] };
}

/** 已安装列表（应用区；壁纸不在此列） */
export async function listInstalled(vfs) {
  const out = [];
  const children = await vfs.list(APPS_ROOT);
  for (const c of children) {
    if (c.isDir) {
      const metaTxt = await vfs.readText(`${APPS_ROOT}/${c.name}/.app.json`);
      if (metaTxt) {
        try {
          const m = JSON.parse(metaTxt);
          out.push({ id: c.name, kind: "app", dir: `${APPS_ROOT}/${c.name}`,
            name: m.name, files: m.files || [], installed_at: m.installed_at });
        } catch (e) { /* 坏元数据忽略 */ }
      }
    } else if (!c.name.startsWith(".")) {
      const id = baseName(c.name);
      out.push({ id, kind: "app", dir: APPS_ROOT, name: c.name,
        files: [`${APPS_ROOT}/${c.name}`] });
    }
  }
  return out;
}

/** 按 id 卸载（目录应用与单文件应用通用） */
export async function uninstallApp(id, vfs) {
  const safe = sanitizeId(id);
  const dirPath = `${APPS_ROOT}/${safe}`;
  const st = await vfs.stat(dirPath);
  if (st && st.isDir) { await vfs.remove(dirPath); return true; }
  let removed = false;
  for (const c of await vfs.list(APPS_ROOT)) {
    if (c.isDir) continue;
    if (baseName(c.name) === safe) { await vfs.remove(`${APPS_ROOT}/${c.name}`); removed = true; }
    if (c.name.startsWith(".")) {
      const metaName = `.${safe}.meta.json`;
      if (c.name === metaName) await vfs.remove(`${APPS_ROOT}/${c.name}`);
    }
  }
  return removed;
}

/** 该索引条目是否已安装（按 id 匹配） */
export async function isInstalled(vfs, item) {
  const id = sanitizeId(baseName(item.name));
  const list = await listInstalled(vfs);
  return list.some((a) => a.id === id);
}
