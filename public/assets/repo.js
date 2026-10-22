/* mos-repo 专属软件源客户端（MOS 网页端）
 *
 * 源站: https://github.com/wurong10001/mos-repo
 * 用法:
 *   <script src="/assets/repo.js"></script>
 *   await MosRepo.loadIndex();          // 拉取并缓存 index.json
 *   MosRepo.list("wallpaper");          // 按分类列出文件（wallpaper / mosapp / …）
 *   await MosRepo.download(item);       // 下载并做 SHA256 校验，浏览器保存
 *   const blob = await MosRepo.fetchBlob(item);  // 只要字节（如设为壁纸），同样校验
 *
 * raw.githubusercontent 失败时自动切换 jsDelivr 镜像；下载默认强制校验，
 * 传 {strict:false} 可降级为告警。
 */
(function (global) {
  "use strict";

  const OWNER = "wurong10001";
  const REPO = "mos-repo";
  let cache = null;
  let cacheAt = 0;
  const CACHE_TTL_MS = 60 * 1000;

  function toCdn(url) {
    // files[].url 形如 https://raw.githubusercontent.com/OWNER/REPO/main/<encoded path>
    const prefix = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/`;
    if (url.startsWith(prefix)) {
      return `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@main/` + url.slice(prefix.length);
    }
    return url;
  }

  async function fetchWithFallback(url) {
    let res;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (e) {
      res = await fetch(toCdn(url), { cache: "no-store" }); // raw 网络失败走镜像
    }
    if (!res.ok) {
      const cdn = toCdn(url);
      if (cdn !== url) {
        const retry = await fetch(cdn, { cache: "no-store" });
        if (retry.ok) return retry;
      }
      throw new Error("HTTP " + res.status + " " + url);
    }
    return res;
  }

  async function loadIndex(force) {
    if (!force && cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
    const res = await fetchWithFallback(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/index.json`);
    cache = await res.json();
    cacheAt = Date.now();
    return cache;
  }

  async function list(category) {
    const idx = await loadIndex();
    const files = idx.files || [];
    return category ? files.filter((f) => f.category === category) : files.slice();
  }

  async function categories() {
    const idx = await loadIndex();
    const set = new Set((idx.files || []).map((f) => f.category));
    return Array.from(set).sort();
  }

  async function sha256Hex(buffer) {
    if (!global.crypto || !global.crypto.subtle) throw new Error("crypto.subtle 不可用");
    const digest = await global.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function fetchBlob(item) {
    const res = await fetchWithFallback(item.url);
    const buf = await res.arrayBuffer();
    let verified = false;
    try {
      verified = (await sha256Hex(buf)) === item.sha256;
    } catch (e) {
      console.warn("[MosRepo] 无法校验 SHA256:", e);
    }
    if (!verified && item.sha256 && (item.strict !== false)) {
      throw new Error("SHA256 校验失败: " + item.name);
    }
    return { blob: new Blob([buf]), bytes: buf, verified: verified };
  }

  function saveBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function download(item, opts) {
    opts = opts || {};
    const r = await fetchBlob(Object.assign({}, item, { strict: opts.strict }));
    saveBlob(r.blob, opts.filename || item.name);
    return r;
  }

  global.MosRepo = {
    OWNER: OWNER,
    REPO: REPO,
    loadIndex: loadIndex,
    list: list,
    categories: categories,
    download: download,
    fetchBlob: fetchBlob,
    saveBlob: saveBlob,
    sha256Hex: sha256Hex,
  };
})(window);
