/* theme_host.js — 浏览器端壁纸宿主（三层结构 + iframe 沙箱渲染）
 *
 * 层级（配合 system.css 新增规则）:
 *   #wallpaper-layer z-index 0（图片层 / sandbox iframe 主题层）
 *   #desktop-ui-layer z-index 10（桌面 UI 永远浮在壁纸上）
 * 沙箱: sandbox="allow-scripts"（可按 manifest 追加 allow-autoplay;
 *       绝不给 allow-same-origin / allow-top-navigation / allow-popups）
 * 协议: 壁纸内可 postMessage({type:'WALLPAPER_READY'})，宿主回 DESKTOP_INFO
 */
import { createVFS } from "./mos-vfs.js";
import { installWallpaper, setDesktopWallpaper, getDesktopWallpaper,
  vfsZip, buildThemeDocument } from "./mos-theme-core.js";

const vfs = createVFS();
const ready = vfs.init();
let lastUrl = null;

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif" };
const extOf = (n) => (n.lastIndexOf(".") >= 0 ? n.slice(n.lastIndexOf(".") + 1) : "").toLowerCase();

async function renderInto(layer, ptr) {
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  layer.innerHTML = "";
  if (!ptr) { document.body.classList.remove("has-wallpaper"); return false; }

  if (ptr.kind === "image") {
    const data = await vfs.read(ptr.path);
    if (!data) return false;
    lastUrl = URL.createObjectURL(new Blob([data], { type: MIME[extOf(ptr.path)] || "application/octet-stream" }));
    const el = document.createElement("div");
    el.className = "wallpaper-image";
    el.style.backgroundImage = 'url("' + lastUrl + '")';
    layer.appendChild(el);
    document.body.classList.add("has-wallpaper");
    return true;
  }

  // theme: 从 VFS 重建内联文档 → sandbox iframe
  const zip = vfsZip(vfs, ptr.path);
  await zip.load();
  let entryName = "index.html", manifest = null;
  const metaTxt = await vfs.readText(ptr.path + "/.theme.json");
  if (metaTxt) { try { const m = JSON.parse(metaTxt); entryName = m.entryName || entryName; manifest = m.manifest || null; } catch (e) {} }
  if (!zip.entries.some((e) => e.name === entryName)) {
    const alt = zip.entries.find((e) => /\.html$/i.test(e.name) && !e.name.includes("/"));
    if (!alt) return false;
    entryName = alt.name;
  }
  const doc = await buildThemeDocument(zip, entryName);
  const ifr = document.createElement("iframe");
  ifr.setAttribute("aria-hidden", "true");
  ifr.setAttribute("sandbox", "allow-scripts" + (manifest && manifest.allowAudio ? " allow-autoplay" : ""));
  ifr.srcdoc = doc;
  if (!(manifest && manifest.allowPointerEvents)) ifr.classList.add("wallpaper-inert");
  layer.appendChild(ifr);
  document.body.classList.add("has-wallpaper");
  return true;
}

export async function mountWallpaper(layer) {
  await ready;
  const ptr = await getDesktopWallpaper(vfs);
  return renderInto(layer, ptr);
}

/* 软件源 item → 下载 → 入库 → 设为当前壁纸；返回安装结果 */
export async function applyFromRepoItem(layer, item) {
  await ready;
  if (!window.MosRepo) throw new Error("MosRepo 未加载");
  const r0 = await window.MosRepo.fetchBlob(item);
  const buf = await r0.blob.arrayBuffer();
  const result = await installWallpaper(buf, item.name, vfs);
  const ptr = await setDesktopWallpaper(vfs,
    result.kind === "theme" ? result.themeDir : result.files[0]);
  localStorage.setItem("mos-theme", ptr.path);
  if (layer) await renderInto(layer, ptr);
  return result;
}

export async function currentWallpaper() {
  await ready;
  return getDesktopWallpaper(vfs);
}

/* 轻量 DESKTOP_INFO 协议应答（不暴露除尺寸/时间/主题外的任何信息） */
window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "WALLPAPER_READY" || !e.source) return;
  try {
    e.source.postMessage({
      type: "DESKTOP_INFO",
      data: {
        width: window.innerWidth,
        height: window.innerHeight,
        time: new Date().toISOString(),
        theme: localStorage.getItem("mos-theme") || "default",
      },
    }, "*");
  } catch (err) { /* 沙箱限制则忽略 */ }
});
