/*
 * Standalone runtime for the Hive design screens (*.dc.html).
 * The screens were authored on a design canvas; this small file lets them open
 * directly in a browser, with their clicks working. It understands the subset
 * of the format the screens use: {{path}} holes, <sc-for>, <sc-if>, <helmet>,
 * on* handlers returned from renderVals(), and data-props defaults.
 * URL params override props, e.g. Login.dc.html?state=wrong-domain&dark=false
 */
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) {
      const next = typeof patch === "function" ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, next);
      if (this.__render) this.__render();
    }
    forceUpdate() { if (this.__render) this.__render(); }
  }
  window.DCLogic = DCLogic;

  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(path, scope) {
    if (path === "true") return true;
    if (path === "false") return false;
    if (path === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    if (/^(['"]).*\1$/.test(path)) return path.slice(1, -1);
    let v = scope;
    for (const part of path.split(".")) {
      if (v == null) return undefined;
      // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- reads only; this static mock never assigns.
      v = v[part];
    }
    return v;
  }
  const str = (v) => (v == null || v === false ? "" : String(v));

  function coerceParam(raw, def) {
    if (def && def.editor === "boolean") return raw === "true" || raw === "1";
    if (def && (def.editor === "int" || def.editor === "float" || def.editor === "range")) return Number(raw);
    return raw;
  }

  function processChildren(parent, scope, out) {
    for (const child of Array.from(parent.childNodes)) {
      for (const n of processNode(child, scope)) out.appendChild(n);
    }
    return out;
  }

  function processNode(node, scope) {
    if (node.nodeType === Node.TEXT_NODE) {
      return [document.createTextNode(node.nodeValue.replace(HOLE, (_, p) => str(lookup(p, scope))))];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const tag = node.tagName.toLowerCase();

    if (tag === "sc-for") {
      const m = (node.getAttribute("list") || "").match(WHOLE);
      const list = m ? lookup(m[1], scope) : [];
      const as = node.getAttribute("as") || "item";
      const frag = [];
      (Array.isArray(list) ? list : []).forEach((item, i) => {
        const inner = Object.assign({}, scope, { [as]: item, $index: i });
        for (const child of Array.from(node.childNodes)) frag.push(...processNode(child, inner));
      });
      return frag;
    }
    if (tag === "sc-if") {
      const m = (node.getAttribute("value") || "").match(WHOLE);
      if (!(m && lookup(m[1], scope))) return [];
      const frag = [];
      for (const child of Array.from(node.childNodes)) frag.push(...processNode(child, scope));
      return frag;
    }

    const el = node.cloneNode(false);
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name;
      const whole = attr.value.match(WHOLE);
      if (name.startsWith("on")) {
        el.removeAttribute(name);
        const fn = whole ? lookup(whole[1], scope) : null;
        if (typeof fn === "function") el.addEventListener(name.slice(2), (e) => { e.preventDefault(); fn(e); });
        continue;
      }
      if (name.startsWith("hint-")) { el.removeAttribute(name); continue; }
      if (whole) {
        const v = lookup(whole[1], scope);
        if (v === true) el.setAttribute(name, "");
        else if (v === false || v == null) el.removeAttribute(name);
        else el.setAttribute(name, String(v));
        if ((name === "checked" || name === "value") && "checked" in el && name === "checked") el.checked = v === true || v === "true";
      } else if (HOLE.test(attr.value)) {
        HOLE.lastIndex = 0;
        el.setAttribute(name, attr.value.replace(HOLE, (_, p) => str(lookup(p, scope))));
      }
      HOLE.lastIndex = 0;
    }
    const src = tag === "template" ? node.content : node;
    processChildren(src, scope, el);
    return [el];
  }

  function boot() {
    const xdc = document.querySelector("x-dc");
    const script = document.querySelector("script[data-dc-script]");
    if (!xdc || !script) return;

    const defs = JSON.parse(script.getAttribute("data-props") || "{}");
    const props = {};
    for (const [k, d] of Object.entries(defs)) {
      if (k.startsWith("$") || !d || typeof d !== "object") continue;
      if ("default" in d) props[k] = d.default;
    }
    const params = new URLSearchParams(location.search);
    for (const [k, raw] of params) props[k] = coerceParam(raw, defs[k]);

    const helmet = xdc.querySelector("helmet");
    if (helmet) {
      for (const n of Array.from(helmet.childNodes)) document.head.appendChild(n);
      helmet.remove();
    }

    const tpl = document.createElement("template");
    tpl.innerHTML = xdc.innerHTML;
    const mount = document.createElement("div");
    mount.id = "dc-root";
    xdc.replaceWith(mount);

    const Component = new Function("DCLogic", script.textContent + "\nreturn Component;")(DCLogic);
    const inst = new Component(props);
    inst.props = props;
    if (!inst.state) inst.state = {};
    inst.__render = () => {
      const vals = inst.renderVals();
      const out = document.createDocumentFragment();
      processChildren(tpl.content, vals, out);
      mount.replaceChildren(out);
    };
    inst.__render();
    if (typeof inst.componentDidMount === "function") inst.componentDidMount();
    document.documentElement.setAttribute("data-dc-ready", "");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
