/* 引用抽取与压缩守卫：这是「别把站点压坏」的核心，回归测试必须盯死。 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSET_EXT_RE,
  buildReferenceReport,
  extractJsRefs,
  extractRefs,
  isExternalRef,
  resolveRef,
} from "../src/refs.js";
import { minifyCss, minifyHtml, minifyJs } from "../src/optimize/text.js";

test("resolveRef：相对路径、./、/、query、大小写外的归一化", () => {
  assert.equal(resolveRef("./icons/a.png", "index.html"), "icons/a.png");
  assert.equal(resolveRef("icons/a.png", "index.html"), "icons/a.png");
  assert.equal(resolveRef("/icons/a.png", "sub/page.html"), "icons/a.png");
  assert.equal(resolveRef("../icons/a.png", "sub/page.html"), "icons/a.png");
  assert.equal(resolveRef("a.png?v=2#x", "css/main.css"), "css/a.png");
  assert.equal(resolveRef("a%20b.png", "index.html"), "a b.png");
  assert.equal(resolveRef("../../outside.png", "a/b/c.html"), "outside.png"); // 回到站点根，仍在站内
  assert.equal(resolveRef("../../../outside.png", "a/b/c.html"), null); // 跑出站点根 → 丢弃
  assert.equal(resolveRef("https://cdn.x/a.png", "index.html"), null);
  assert.equal(resolveRef("data:image/png;base64,AAA", "index.html"), null);
});

test("外链 / data: / 模板不算站内引用", () => {
  assert.equal(isExternalRef("https://a/b.js"), true);
  assert.equal(isExternalRef("//cdn/b.js"), true);
  assert.equal(isExternalRef("#anchor"), true);
  assert.equal(isExternalRef("data:text/plain,x"), true);
  assert.equal(isExternalRef("${base}/a.js"), true);
  assert.equal(isExternalRef("fonts/a.woff2"), false);
  assert.equal(ASSET_EXT_RE.test("a.woff2"), true);
  assert.equal(ASSET_EXT_RE.test("a.webmanifest"), true);
});

test("HTML：带引号、不带引号、srcset 三种属性写法都要认", () => {
  const html = `<link rel="manifest" href="manifest.webmanifest">
<img src=icons/plain.png alt=x>
<img srcset="./icons/a.png 1x, ./icons/b.png 2x">
<style>body{background:url(../bg.png)}</style>
<a href="https://cdn.x/y">x</a>`;
  const { refs } = extractRefs(html, "sub/page.html");
  assert.ok(refs.has("sub/manifest.webmanifest"), [...refs].join(","));
  assert.ok(refs.has("sub/icons/plain.png"), [...refs].join(","));
  assert.ok(refs.has("sub/icons/a.png"));
  assert.ok(refs.has("sub/icons/b.png"));
  assert.ok(refs.has("bg.png"));
  assert.equal([...refs].some((r) => r.includes("cdn.x")), false);
});

test("JS：压缩过、带 \\uXXXX 转义的代码里，字符串也要被完整抽出来", () => {
  // 正则配对引号会在这里跑偏（转义里的反斜杠 + 一整行），所以必须走 AST
  const code = String.raw`(function(){"use strict";var s="\u5728 Safari \u4E2D";navigator.serviceWorker.register("sw.js");document.fonts.load('400 12px "Inter"');var p="fonts/inter-400.woff2"})();`;
  const { refs } = extractJsRefs(code, "pwa.js");
  assert.ok(refs.has("sw.js"), `refs=${[...refs].join(",")}`);
  assert.ok(refs.has("fonts/inter-400.woff2"));
});

test("JS 压缩：裸全局脚本的顶层名字绝不能被改名（跨文件引用靠它）", async () => {
  const code = `var NixieChain = { create: function () { return 1 } };\nwindow.NixieChain = NixieChain;\nvar UNUSED_GLOBAL = 42;`;
  const r = await minifyJs(code);
  assert.match(r.code, /NixieChain/);
  assert.match(r.code, /UNUSED_GLOBAL/);
  assert.ok(r.code.length <= code.length);
});

test("JS 压缩：IIFE 内部可以随便改名，但资源引用要原样保留", async () => {
  const code = `(function(){var fontPath="fonts/barlow-condensed-100.woff2";var longName={a:1,b:2};window.X=fontPath+JSON.stringify(longName)})();`;
  const r = await minifyJs(code);
  assert.match(r.code, /fonts\/barlow-condensed-100\.woff2/);
  assert.ok(r.code.length < code.length);
});

test("JS 压缩：new URL(req.url) 不能被当成资源引用，否则会误判「引用丢失」", async () => {
  const code = `(function(){self.addEventListener("fetch",function(e){var req=e.request;var u=new URL(req.url);if(u.origin!==location.origin)return;caches.match(req).then(function(h){return h||fetch(req)})})})();`;
  const r = await minifyJs(code);
  assert.equal(r.mode, "full", r.notes.join("；"));
  assert.ok(r.code.length < code.length);
});

test("CSS 压缩：类名 / id 不能被弄丢，url() 要保留", async () => {
  const css = `/* c */\n.card-x { color : red ; background: url("img/a.png") }\n#main-id .y:hover{ margin: 0 0 0 0 }`;
  const r = await minifyCss(css);
  assert.match(r.code, /\.card-x/);
  assert.match(r.code, /#main-id/);
  assert.match(r.code, /img\/a\.png/);
  assert.ok(r.code.length < css.length);
});

test("HTML 压缩：去属性引号之后引用仍在（守卫不能因此误杀）", async () => {
  const html = `<!doctype html><html><head><link rel="manifest" href="manifest.webmanifest"><style>body{color:red}</style></head><body><img src="icons/a.png"><script src="app.js"></script></body></html>`;
  const r = await minifyHtml(html, { aggressive: true });
  assert.notEqual(r.mode, "skipped", r.notes.join("；"));
  assert.match(r.code, /manifest\.webmanifest/);
  assert.match(r.code, /icons\/a\.png/);
  assert.match(r.code, /app\.js/);
});

test("死文件判定：目录前缀兜底不能把整个目录都算成「被引用」", () => {
  const files = [{ path: "index.html" }, { path: "icons/used.png" }, { path: "icons/orphan.png" }];
  const graph = new Map([
    ["index.html", { refs: new Set(["icons/used.png"]), locals: new Set(["used.png"]), dirs: new Set() }],
  ]);
  const report = buildReferenceReport(files, graph);
  assert.deepEqual(report.unreferenced, ["icons/orphan.png"]);
  assert.deepEqual(report.unresolved, []);
});

test("死文件判定：字符串拼接式引用（fonts/ 前缀 + 名字）要放过整个目录", () => {
  const files = [{ path: "index.html" }, { path: "fonts/a.woff2" }, { path: "fonts/b.woff2" }];
  const graph = new Map([
    ["index.html", { refs: new Set(), locals: new Set(), dirs: new Set(["fonts/"]) }],
  ]);
  const report = buildReferenceReport(files, graph);
  assert.deepEqual(report.unreferenced, []);
});

test("断链会被报出来", () => {
  const files = [{ path: "index.html" }, { path: "app.js" }];
  const graph = new Map([
    ["index.html", { refs: new Set(["app.js", "missing.png"]), locals: new Set(), dirs: new Set() }],
  ]);
  const report = buildReferenceReport(files, graph);
  assert.deepEqual(report.unresolved, [{ from: "index.html", ref: "missing.png" }]);
});
