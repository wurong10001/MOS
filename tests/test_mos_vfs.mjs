// MOS 壁纸/主题系统单元测试（Node 运行: node tests/test_mos_vfs.mjs）
// 覆盖: mos-vfs 路径与读写 / mos-zip 解析 / mos-theme-core 主题协议
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const { normalizePath, createVFS, MemoryBackend } = await import(
  join(ROOT, "public/assets/mos-vfs.js"));
const { openZip, sanitizeEntryName } = await import(
  join(ROOT, "public/assets/mos-zip.js"));
const { resolveTheme, buildThemeDocument, installWallpaper, installTheme,
  setDesktopWallpaper, getDesktopWallpaper, isZip } = await import(
  join(ROOT, "public/assets/mos-theme-core.js"));

let passed = 0, failed = 0; const lines = [];
async function t(name, fn) {
  try { await fn(); passed++; lines.push("  PASS " + name); }
  catch (e) { failed++; lines.push("  FAIL " + name + ": " + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: 期望 ${y} 实际 ${x}`); }
const fx = (f) => join(ROOT, "tests/fixtures", f);
const abOf = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// 生成动态 fixture（保证 RED 阶段不依赖实现）
mkdirSync(join(ROOT, "tests/fixtures"), { recursive: true });
execFileSync("python3", ["-c", `
import zipfile
def mk(path, files, deflate=True):
    z = zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED)
    for n, c in files.items(): z.writestr(n, c)
    z.close()
PNG = bytes([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
mk("${fx("theme_test.zip")}", {
 'manifest.json': '{"name":"测试星空","entry":"index.html","allowPointerEvents":false,"allowAudio":false,"author":"wurong"}',
 'index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body class="sky"><img src="assets/logo.png"><script src="script.js"></script></body></html>',
 'style.css': 'body.sky{background:#040a18}',
 'script.js': 'console.log("starry");',
 'assets/logo.png': PNG,
}, True)
# 模仿真实 Hello-world.zip: 根下唯一 html, 无 manifest/index
mk("${fx("single_html.zip")}", {'desktop-wallpaper.html': '.<script>var z=1;</script>'})
mk("${fx("noimg.zip")}", {'readme.txt': b'x'})
mk("${fx("mixed_html.zip")}", {'desktop-wallpaper.html': '<div>wallpaper</div>', 'index.html': '<div>index</div>', 'about.html': '<div>about</div>'})
mk("${fx("wall_test.zip")}", {'sunset.png': PNG, 'nested/deep_blue.png': PNG, 'readme.txt': b'no', '../evil.png': PNG}, True)
mk("${fx("wall_stored.zip")}", {'flat.png': PNG}, False)
`]);

// ---------- VFS ----------
await t("normalizePath 规则", () => {
  eq(normalizePath("system/wallpaper"), "/system/wallpaper", "补前杠");
  eq(normalizePath("/system//wallpaper/"), "/system/wallpaper", "折叠");
  eq(normalizePath("/system/wallpaper/../x"), "/system/x", "..归一");
  eq(normalizePath("/壁纸目录/我的 壁纸.png"), "/壁纸目录/我的 壁纸.png", "unicode");
});
const vfs = createVFS({ backend: MemoryBackend() });
await vfs.init();
await t("write/read/exists/stat/missing", async () => {
  await vfs.write("/system/wallpaper/a.png", new Uint8Array([1, 2, 3, 4, 5]));
  eq(Array.from(await vfs.read("/system/wallpaper/a.png")), [1, 2, 3, 4, 5], "内容");
  assert(await vfs.exists("/system/wallpaper/a.png"), "exists");
  eq((await vfs.stat("/system/wallpaper/a.png")).size, 5, "size");
  eq(await vfs.read("/nope"), null, "缺失返回 null");
});
await t("深层目录 + list 混合项", async () => {
  await vfs.write("/system/wallpaper/Hello-world/nested/d.png", new Uint8Array([9]));
  const items = (await vfs.list("/system/wallpaper")).map(i => i.name).sort();
  eq(items, ["Hello-world", "a.png"], "list");
  const d = (await vfs.list("/system/wallpaper")).find(i => i.name === "Hello-world");
  eq(d.isDir, true, "isDir");
});
await t("text 读写 + remove 子树", async () => {
  await vfs.writeText("/system/wallpaper/t.txt", "你好 vfs");
  eq(await vfs.readText("/system/wallpaper/t.txt"), "你好 vfs", "utf8 往返");
  await vfs.remove("/system/wallpaper/Hello-world");
  eq(await vfs.exists("/system/wallpaper/Hello-world/nested/d.png"), false, "子树删除");
});

// ---------- ZIP ----------
await t("openZip deflate 读取", async () => {
  const zip = await openZip(abOf(fx("wall_test.zip")));
  eq(zip.entries.map(e => e.name).sort(),
    ["../evil.png", "nested/deep_blue.png", "readme.txt", "sunset.png"], "条目");
  const d = await zip.read("sunset.png");
  eq(Array.from(d.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47], "PNG magic");
  eq(d.length, zip.entries.find(e => e.name === "sunset.png").size, "长度=size");
});
await t("openZip stored 读取", async () => {
  const zip = await openZip(abOf(fx("wall_stored.zip")));
  const d = await zip.read("flat.png");
  eq(Array.from(d.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47], "stored PNG");
});
await t("sanitizeEntryName 防穿越", () => {
  eq(sanitizeEntryName("../evil.png"), "evil.png", "上行剥离");
  eq(sanitizeEntryName("/abs/x.png"), "abs/x.png", "绝对剥离");
  eq(sanitizeEntryName("..\\win\\x.png"), "win/x.png", "反斜杠");
});
await t("isZip 魔数判定", async () => {
  assert(isZip(abOf(fx("wall_stored.zip"))), "zip 为 true");
  const zip = await openZip(abOf(fx("wall_stored.zip")));
  const png = await zip.read("flat.png");
  eq(isZip(png.buffer.slice(png.byteOffset, png.byteOffset + png.length)), false, "png 为 false");
});

// ---------- 主题协议 ----------
await t("resolveTheme: manifest.entry 优先", async () => {
  const zip = await openZip(abOf(fx("theme_test.zip")));
  const r = await resolveTheme(zip);
  eq(r.entryName, "index.html", "入口");
  eq(r.manifest.name, "测试星空", "manifest.name");
  eq(r.manifest.allowPointerEvents, false, "manifest.allowPointerEvents");
});
await t("resolveTheme: desktop-wallpaper.html 为正式候选、优先于 index.html", async () => {
  const zip = await openZip(abOf(fx("mixed_html.zip")));
  const r = await resolveTheme(zip);
  eq(r.entryName, "desktop-wallpaper.html", "命名候选优先");
});
await t("resolveTheme: 无 index 时取根下单个 html", async () => {
  const zip = await openZip(abOf(fx("single_html.zip")));
  const r = await resolveTheme(zip);
  eq(r.entryName, "desktop-wallpaper.html", "fallback 入口");
  eq(r.manifest, null, "无 manifest");
});
await t("resolveTheme: 无 html 报错", async () => {
  const zip = await openZip(abOf(fx("noimg.zip")));
  let msg = "";
  try { await resolveTheme(zip); } catch (e) { msg = e.message; }
  assert(/没有壁纸入口/.test(msg), "应报『zip 里没有壁纸入口』, 实际: " + msg);
});
await t("buildThemeDocument: css/js 内联", async () => {
  const zip = await openZip(abOf(fx("theme_test.zip")));
  const html = await buildThemeDocument(zip, "index.html");
  assert(html.includes("body.sky{background:#040a18}"), "css 已内联");
  assert(html.includes('console.log("starry")'), "js 已内联");
  assert(!/<link[^>]+style\.css/.test(html), "link 被替换");
  assert(!/<script[^>]+src=/.test(html), "外链 script 被替换");
});
await t("installTheme: 全量落进 /system/wallpaper/主题名/", async () => {
  const v = createVFS({ backend: MemoryBackend() }); await v.init();
  const r = await installTheme(abOf(fx("theme_test.zip")), "星空粒子.zip", v);
  eq(r.themeDir, "/system/wallpaper/星空粒子", "主题目录");
  eq(r.entryName, "index.html", "入口");
  assert(await v.exists("/system/wallpaper/星空粒子/style.css"), "css 入库");
  assert(await v.exists("/system/wallpaper/星空粒子/assets/logo.png"), "嵌套资源入库");
});
await t("installWallpaper 分发: 图片zip / 单图 / 主题zip / 非壁纸报错", async () => {
  const v = createVFS({ backend: MemoryBackend() }); await v.init();
  const imgs = await installWallpaper(abOf(fx("wall_test.zip")), "壁纸包.zip", v);
  eq(imgs.kind, "image", "图片包 kind");
  eq(imgs.files.sort(), [
    "/system/wallpaper/壁纸包/evil.png",
    "/system/wallpaper/壁纸包/nested/deep_blue.png",
    "/system/wallpaper/壁纸包/sunset.png",
  ].sort(), "只收图片");
  eq(await v.exists("/system/wallpaper/壁纸包/readme.txt"), false, "txt 跳过");

  const zip = await openZip(abOf(fx("wall_stored.zip")));
  const png = await zip.read("flat.png");
  const one = await installWallpaper(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.length), "my_wall.png", v);
  eq(one.kind, "image", "单图 kind");
  eq(one.files, ["/system/wallpaper/my_wall.png"], "单图路径");

  const theme = await installWallpaper(abOf(fx("theme_test.zip")), "t2.zip", v);
  eq(theme.kind, "theme", "主题包识别");

  let msg = "";
  try { await installWallpaper(abOf(fx("noimg.zip")), "bad.zip", v); }
  catch (e) { msg = e.message; }
  assert(/没有可见内容|没有壁纸入口/.test(msg), "无可见内容应报错: " + msg);
});
await t(".last 指针: 图片与主题两种形态", async () => {
  const v = createVFS({ backend: MemoryBackend() }); await v.init();
  const zip = await openZip(abOf(fx("wall_stored.zip")));
  const png = await zip.read("flat.png");
  const one = await installWallpaper(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.length), "w.png", v);
  await setDesktopWallpaper(v, one.files[0]);
  eq(await getDesktopWallpaper(v), { kind: "image", path: "/system/wallpaper/w.png" }, "image 指针");
  const theme = await installTheme(abOf(fx("theme_test.zip")), "s.zip", v);
  await setDesktopWallpaper(v, theme.themeDir);
  eq(await getDesktopWallpaper(v), { kind: "theme", path: theme.themeDir }, "theme 指针");
  eq(await getDesktopWallpaper(await (async () => { const e = createVFS({ backend: MemoryBackend() }); await e.init(); return e; })()),
    null, "空库 null");
});

console.log(lines.join("\n"));
console.log(`\n总计: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
