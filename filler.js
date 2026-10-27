/* Applyra form filler — runs on job pages that Applyra opened (or when you press "Fill this page" in the popup). */
(() => {
  if (window.__applyraFiller) return; window.__applyraFiller = true;
  if (document.querySelector('meta[name="applyra-app"]')) return;

  const AUTOSUBMIT = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "teamtailor", "bamboohr"];
  const SUCCESS = /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully applied|your application is on its way|application complete/i;
  let combos = [];
  let task = null, profile = null, filledEls = new WeakSet(), submitted = false, clickedApply = false, panel = null, lastReport = "";

  const send = (type, payload) => new Promise((res) => { try { chrome.runtime.sendMessage({ kind: "filler", type, payload }, (r) => { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  /* ---------- What does this field ask for? ---------- */
  function describe(el) {
    const bits = [];
    if (el.id) { try { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) bits.push(l.innerText); } catch (e) {} }
    const wrapLabel = el.closest("label"); if (wrapLabel) bits.push(wrapLabel.innerText);
    if (el.getAttribute("aria-label")) bits.push(el.getAttribute("aria-label"));
    const lb = el.getAttribute("aria-labelledby"); if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(n.innerText); });
    bits.push(el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("autocomplete"), el.getAttribute("data-qa"));
    if (bits.filter(Boolean).join("").length < 3 || el.type === "file" || el.type === "radio") {
      const box = el.closest(".field, .application-question, .form-group, .question, [class*='field'], [class*='Field'], [class*='question'], fieldset, li, div");
      if (box) bits.push((box.querySelector("legend, label, .label, [class*='label'], [class*='Label'], h3, h4, p") || {}).innerText || "");
    }
    return norm(bits.filter(Boolean).join(" | ")).slice(0, 400);
  }

  /* The question a radio/checkbox group or dropdown belongs to (not the option label like "Yes"). */
  function questionOf(el) {
    const fs = el.closest("fieldset"); if (fs) { const lg = fs.querySelector("legend"); if (lg && norm(lg.innerText)) return norm(lg.innerText); }
    const rg = el.closest("[role=radiogroup], [role=group]");
    if (rg) { const lb = rg.getAttribute("aria-labelledby"); const t = (lb && lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" ")) || rg.getAttribute("aria-label"); if (norm(t)) return norm(t); }
    const group = el.name ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
    const optText = new Set(group.map((r) => norm((r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`) || r.closest("label") || {}).innerText || r.value)));
    let a = el.parentElement;
    for (let i = 0; a && i < 7; i++, a = a.parentElement) {
      if (!group.every((r) => a.contains(r))) continue;
      const lines = String(a.innerText || "").split(/\n+/).map(norm).filter((l) => l && !optText.has(l) && l.length > 3);
      if (lines.length) return lines[0].slice(0, 200);
    }
    return "";
  }
  const squash = (x) => norm(x).replace(/[^a-z0-9]/g, "");
  const extraFor = (m, k) => {
    if (m[k] != null) return m[k];
    const nk = squash(k); if (nk.length < 4) return undefined;
    for (const q of Object.keys(m)) { const nq = squash(q); if (nq === nk || (nq.length > 12 && nk.length > 12 && (nq.includes(nk) || nk.includes(nq)))) return m[q]; }
    return undefined;
  };
  const pastEmployer = (company) => { const c = norm(company).split(/[ ,.(]/)[0]; return !!c && c.length > 2 && ((profile && profile.employers) || []).some((e) => norm(e).includes(c)); };

  // Ordered rules: first match wins. Values come from the flat profile + per-job answers.
  const RULES = [
    [/first.?name|given.?name|fname/, (p) => p.firstName], [/last.?name|surname|family.?name|lname/, (p) => p.lastName],
    [/middle.?name/, () => ""], [/preferred.?name/, (p) => p.firstName],
    [/full.?name|^name\b|your name|candidate name|\bname\s*\*?$/, (p) => p.fullName],
    [/e-?mail/, (p) => p.email],
    [/country.?code|dial.?code/, (p) => p.phoneCountryCode],
    [/phone|mobile|contact.?number|whatsapp/, (p) => p.phone],
    [/linkedin/, (p) => p.linkedin], [/github/, (p) => p.github], [/portfolio|website|personal.?site|blog|\burl\b/, (p) => p.website],
    [/current.?(company|employer|organi[sz]ation)|present employer|company name/, (p) => p.currentCompany],
    [/current.?(title|designation|role|position)|job title|designation/, (p) => p.currentTitle],
    [/notice/, (p) => p.noticePeriod],
    [/current.?(ctc|salary|compensation|package)|present (ctc|salary)/, (p) => p.currentCtc],
    [/expected.?(ctc|salary|compensation|package)|salary expectation|desired (salary|pay)|compensation expectation/, (p) => p.expectedCtc],
    [/years? of (relevant |total )?experience|total experience|experience \(years\)|how many years/, (p) => p.yearsExperience],
    [/relocat/, (p) => p.relocate],
    [/sponsor/, (p, el, t) => { const a = String(p.needSponsorship || ""); const abroad = t && t.location && !/india|remote|anywhere|worldwide|gurugram|gurgaon|delhi|noida|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|kolkata|ahmedabad/i.test(t.location); return /outside india/i.test(a) ? (abroad ? "Yes" : "No") : a; }],
    [/authori[sz]ed to work|work authori[sz]ation|legally (able|eligible|authorized)|right to work|eligible to work/, (p, el) => (/india/.test(describe(el)) ? p.workAuthIndia : /india/i.test(String(p.country)) && !/india/.test(describe(el)) ? "No" : p.workAuthIndia)],
    [/nationality|citizenship/, (p) => p.nationality],
    [/pronoun/, (p) => p.pronouns], [/gender|sex\b/, (p) => p.gender],
    [/how did you (hear|find|learn)|source|referr(al|ed) by|where did you/, (p) => p.heardFrom],
    [/\bcity\b|current location|location|where are you based|town/, (p) => p.city || p.location],
    [/country/, (p) => p.country || "India"], [/address/, (p) => p.location],
    [/university|college|school|institution/, (p) => p.school], [/degree|qualification|education/, (p) => p.degree], [/graduat(ion|ed).?(year|date)/, (p) => p.gradYear],
    [/headline/, (p) => p.headline], [/skills/, (p) => p.skills],
    [/(18|eighteen) years|legal (working )?age|at least 18/, () => "Yes"],
    [/(previously|ever|currently) (been )?(employed|worked) (by|at|for|with)|former employee|worked (here|for us) before/, (p, el, t) => (t && pastEmployer(t.company) ? "Yes" : "No")],
    [/(consent|agree|acknowledge|certify|confirm).*(privacy|terms|policy|accurate|true|processing|data)|privacy (policy|notice)/, () => "Yes"],
    [/cover.?letter/, (p, el, t) => t && t.coverLetter],
    [/why (do you want to|are you interested|this company|us|join|work (at|for|with))|interest(ed)? in (this company|working)|what excites/, (p, el, t) => t && t.answers && t.answers.whyCompany],
    [/why (this|the) (role|position)|why are you (a good fit|applying)|fit for (this|the) role/, (p, el, t) => t && t.answers && t.answers.whyRole],
    [/strength|what makes you|why should we hire/, (p, el, t) => t && t.answers && t.answers.strengths],
    [/relevant experience|describe your experience|tell us about (yourself|your experience)|summary|about you/, (p, el, t) => (t && t.answers && t.answers.relevantExperience) || p.summary],
    [/additional information|anything else|comments/, (p, el, t) => t && t.answers && t.answers.additionalInfo],
  ];
  const ask = (el) => { const t = (el.type || "").toLowerCase(); const q = (t === "radio" || t === "checkbox") ? questionOf(el) : ""; return q ? q + " | " + describe(el) : describe(el); };
  const valueFor = (el) => { const d = ask(el);
    const extra = window.__applyraExtra; if (extra) { const v = extraFor(extra, d.split(" | ")[0]); if (v != null && v !== "") return v; } for (const [re, fn] of RULES) if (re.test(d)) return fn(profile || {}, el, task); return undefined; };

  /* ---------- Setting values in a way React/Vue/Angular forms notice ---------- */
  function setNative(el, v) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus({ preventScroll: true }); setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  function pickOption(sel, v) {
    const want = norm(v); if (!want) return false;
    const opts = [...sel.options].filter((o) => o.value !== "" && !/select|choose|--/i.test(o.text));
    const o = opts.find((x) => norm(x.text) === want) || opts.find((x) => norm(x.text).startsWith(want) || want.startsWith(norm(x.text))) ||
      opts.find((x) => norm(x.text).includes(want) || want.includes(norm(x.text))) ||
      (/^(yes|y)\b/.test(want) && opts.find((x) => /^yes/i.test(x.text))) || (/^(no|n)\b/.test(want) && opts.find((x) => /^no/i.test(x.text))) ||
      (/prefer not|decline/.test(want) && opts.find((x) => /prefer not|decline|not to (say|disclose)/i.test(x.text)));
    if (!o) return false; setNative(sel, o.value); return true;
  }
  function b64ToFile(f) { const bin = atob(f.data); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], f.name, { type: f.type }); }
  function attach(input, file) {
    const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ---------- Fill ---------- */
  function fields() {
    return [...document.querySelectorAll("input, textarea, select")].filter((el) => {
      if (el.disabled || el.readOnly) return false;
      const t = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "password", "search"].includes(t)) return false;
      return t === "file" || visible(el);
    });
  }
  function fillAll() {
    if (!profile) return { filled: 0, missing: [] };
    let filled = 0; const missing = [], missDet = [];
    const radios = new Map(); combos = [];
    const addMiss = (q, el, group) => {
      if (!q) return; missing.push(q);
      const options = el.tagName === "SELECT" ? [...el.options].filter((o) => o.value !== "" && !/select|choose|--/i.test(o.text)).map((o) => o.text.trim())
        : group ? group.map(optLabel) : [];
      missDet.push({ q, type: options.length ? "choice" : el.tagName === "TEXTAREA" ? "long" : "short", options: options.slice(0, 30), maxLength: Number(el.getAttribute("maxlength")) || 0 });
    };
    for (const el of fields()) {
      const t = (el.type || "").toLowerCase();
      if (t === "radio") { if (!radios.has(el.name)) radios.set(el.name, []); radios.get(el.name).push(el); continue; }
      if (t === "file") {
        if (filledEls.has(el) || (el.files && el.files.length) || !task || !task.files) continue;
        const d = describe(el);
        const role = /cover/.test(d) ? "cover" : /resume|cv|curriculum/.test(d) || fields().filter((x) => x.type === "file").length === 1 ? "resume" : null;
        const f = role && task.files.find((x) => x.role === role);
        if (f) { try { attach(el, b64ToFile(f)); filledEls.add(el); filled++; } catch (e) {} }
        continue;
      }
      if (t === "checkbox") {
        const d = describe(el);
        if (!el.checked && /i agree|consent|acknowledge|privacy (policy|notice)|terms|accurate|certify/.test(d) && !/marketing|newsletter|future (jobs|opportunities)|sms/.test(d)) { el.click(); filled++; }
        continue;
      }
      if (el.getAttribute("role") === "combobox" && el.tagName === "INPUT") { if (!filledEls.has(el)) combos.push(el); continue; }
      if (filledEls.has(el) || (el.value && el.value.trim() && el.tagName !== "SELECT")) continue;
      if (el.tagName === "SELECT" && el.selectedIndex > 0) continue;
      const v = valueFor(el);
      if (v == null || v === "") { if (isRequired(el)) addMiss(describe(el).split(" | ")[0], el); continue; }
      if (el.tagName === "SELECT") { if (pickOption(el, v)) { filledEls.add(el); filled++; } else if (isRequired(el)) addMiss(describe(el).split(" | ")[0], el); continue; }
      const maxLen = Number(el.getAttribute("maxlength")) || 0;
      setNative(el, maxLen ? String(v).slice(0, maxLen) : String(v)); filledEls.add(el); filled++;
    }
    for (const [, group] of radios) {
      if (group.some((r) => r.checked)) continue;
      const q = ask(group[0]);
      const ans = norm(valueFor(group[0]) || (/disab|veteran|ethnic|race/.test(q) ? "prefer not" : ""));
      if (!ans) { if (group.some(isRequired)) addMiss(q.split(" | ")[0], group[0], group); continue; }
      const lab = (r) => norm((r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`) || r.closest("label") || {}).innerText || r.value);
      const hit = group.find((r) => lab(r) === ans) || group.find((r) => lab(r).startsWith(ans.split(/[ ,]/)[0])) ||
        (/prefer not|decline/.test(ans) && group.find((r) => /prefer not|decline|not to/.test(lab(r))));
      if (hit) { hit.click(); filled++; } else if (group.some(isRequired)) addMiss(q.split(" | ")[0], group[0], group);
    }
    const seenQ = new Set();
    return { filled, missing: [...new Set(missing.filter(Boolean))].slice(0, 12), missDet: missDet.filter((m) => !seenQ.has(m.q) && seenQ.add(m.q)).slice(0, 12) };
  }
  const optLabel = (r) => String((r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`) || r.closest("label") || {}).innerText || r.value || "").trim();
  const isRequired = (el) => el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test((describe(el).split(" | ")[0] || ""));

  async function fillCombos() {
    let filled = 0; const missing = [], missDet = [];
    const miss = (el) => { const q = describe(el).split(" | ")[0]; missing.push(q); missDet.push({ q, type: "short", options: [], maxLength: 0 }); };
    for (const el of combos.slice()) {
      if (filledEls.has(el) || !el.isConnected) continue;
      const box = el.closest("[class*='select'], [class*='Select'], .field, div");
      if (box && box.querySelector("[class*='single-value'], [class*='singleValue']")) { filledEls.add(el); continue; }
      const v = valueFor(el), req = isRequired(el) || /\*\s*$/.test(describe(el).split(" | ")[0] || "");
      if (v == null || v === "") { if (req) miss(el); continue; }
      const want = norm(v).slice(0, 40);
      el.focus(); el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); setNative(el, want.split(/[,(]/)[0].trim().slice(0, 25));
      await sleep(700);
      const opts = [...document.querySelectorAll("[role=option]")].filter(visible);
      const o = opts.find((x) => norm(x.innerText) === want) || opts.find((x) => norm(x.innerText).startsWith(want) || want.startsWith(norm(x.innerText))) ||
        (/^yes/.test(want) && opts.find((x) => /^yes/i.test(x.innerText))) || (/^no\b/.test(want) && opts.find((x) => /^no\b/i.test(x.innerText))) ||
        (/prefer not|decline/.test(want) && opts.find((x) => /prefer not|decline|not to/i.test(x.innerText))) || (opts.length === 1 ? opts[0] : null);
      if (o) { o.click(); filledEls.add(el); filled++; } else { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); if (req) miss(el); }
      await sleep(250);
    }
    return { filled, missing, missDet };
  }

  /* ---------- Navigation helpers ---------- */
  const buttons = () => [...document.querySelectorAll("button, a, input[type=submit], [role=button]")].filter(visible);
  const txt = (b) => norm(b.innerText || b.value || b.getAttribute("aria-label"));
  function clickApplyEntry() {
    if (clickedApply) return false;
    const ats = task && task.ats;
    let b = null;
    if (ats === "linkedin") b = buttons().find((x) => /easy apply/.test(txt(x)));
    else if (ats === "naukri") return false; // Naukri's Apply button submits instantly — left for the user
    else b = buttons().find((x) => /^(apply( for this (job|position|role))?( now)?|i'?m interested|start application|apply online|application)$/.test(txt(x)));
    if (b) { clickedApply = true; b.click(); return true; }
    return false;
  }
  function submitButton() {
    return buttons().find((x) => /^(submit( application| my application)?|send application|apply|complete application|submit & apply)$/.test(txt(x)) && !x.disabled)
      || [...document.querySelectorAll("button[type=submit], input[type=submit]")].find(visible);
  }
  /* ---------- Cookie / consent banners: pick "necessary only" (or accept) so they stop blocking the form ---------- */
  const CONSENT_IDS = ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler", "#CybotCookiebotDialogBodyButtonDecline", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept", "#truste-consent-required", "#truste-consent-button", "#didomi-notice-disagree-button", "#didomi-notice-agree-button",
    "#accept-recommended-btn-handler", ".cc-deny", ".cc-dismiss", ".cc-allow", "#cookie-accept", "#accept-cookies", "[data-cookiebanner='accept_button']", "[data-testid='cookie-policy-manage-dialog-accept-button']"];
  const CONSENT_PREF = /^(reject all|reject( all)? cookies|decline( all)?|only (necessary|essential|required)( cookies)?|(use )?(strictly )?necessary( cookies)?( only)?|essential( cookies)? only|continue without accepting)$/i;
  const CONSENT_OK = /^(accept all( cookies)?|accept( cookies)?|allow all( cookies)?|allow( cookies)?|i agree|agree( and close)?|got it|ok(ay)?|understood|i understand|accept & close|accept and continue)$/i;
  function dismissConsent() {
    for (const sel of CONSENT_IDS) { const b = document.querySelector(sel); if (b && visible(b)) { b.click(); return true; } }
    const uc = document.querySelector("#usercentrics-root");
    if (uc && uc.shadowRoot) { const b = uc.shadowRoot.querySelector("[data-testid='uc-deny-all-button'], [data-testid='uc-accept-all-button']"); if (b) { b.click(); return true; } }
    const boxes = [...document.querySelectorAll("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [aria-label*='cookie' i], [role=dialog], [role=alertdialog]")]
      .filter((b) => visible(b) && /cookie/i.test(b.innerText || "") && b.querySelectorAll("input:not([type=checkbox]):not([type=hidden]), textarea, select").length < 2).slice(0, 6);
    for (const box of boxes) {
      const btns = [...box.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")].filter(visible);
      const pick = btns.find((b) => CONSENT_PREF.test(txt(b))) || btns.find((b) => CONSENT_OK.test(txt(b)));
      if (pick) { pick.click(); return true; }
    }
    return false;
  }
  /* ---------- Captcha: the person ticks it; Applyra then presses Submit ---------- */
  const captchaSolved = () => [...document.querySelectorAll("textarea[name='g-recaptcha-response'], textarea[name='h-captcha-response'], input[name='cf-turnstile-response']")].some((t) => (t.value || "").length > 20);
  let captchaWatch = null;
  function watchCaptcha() {
    if (captchaWatch) return; const t0 = Date.now();
    captchaWatch = setInterval(() => {
      if (submitted || Date.now() - t0 > 15 * 60000) { clearInterval(captchaWatch); captchaWatch = null; return; }
      if (captchaSolved()) { clearInterval(captchaWatch); captchaWatch = null; const b = submitButton(); if (b) { updatePanel(null, "Thanks — submitting…"); b.click(); watchSuccess(); } }
    }, 1000);
  }
  const captcha = () => [...document.querySelectorAll("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']")].some((f) => visible(f) && f.getBoundingClientRect().height > 60);

  async function report(status, detail = "", extra = {}) {
    const key = `${status}:${detail}`; if (key === lastReport) return; lastReport = key;
    await send("result", { status, detail, ...extra }); updatePanel(status, detail);
  }

  /* ---------- Floating status panel ---------- */
  function makePanel() {
    if (panel || window.top !== window) return;
    const host = document.createElement("div"); host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>
      .p{font:13px/1.4 system-ui,sans-serif;background:#101935;color:#fff;border-radius:14px;padding:12px 14px;width:290px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
      .h{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:6px}.h img{width:20px;height:20px}
      .s{color:#c9cfe6;margin-bottom:10px}.r{display:flex;gap:6px;flex-wrap:wrap}
      button{font:600 12px system-ui;border:0;border-radius:99px;padding:7px 11px;cursor:pointer;background:#26336b;color:#fff}
      button.go{background:#f4a300;color:#1b1300}.x{margin-left:auto;background:none;padding:2px 6px;color:#8f97b4}</style>
      <div class="p"><div class="h"><img src="${chrome.runtime.getURL("icons/ext-48.png")}">Applyra<button class="x" id="x">✕</button></div>
      <div class="s" id="s">Getting the form ready…</div>
      <div class="r"><button id="fill">Fill again</button><button id="cl">Copy cover letter</button><button id="done" class="go">I submitted it</button></div></div>`;
    document.documentElement.appendChild(host);
    sh.getElementById("x").onclick = () => host.remove();
    sh.getElementById("fill").onclick = () => run(true);
    sh.getElementById("cl").onclick = () => navigator.clipboard.writeText((task && task.coverLetter) || "").then(() => updatePanel(null, "Cover letter copied — paste it where asked."));
    sh.getElementById("done").onclick = () => { submitted = true; report("submitted", "Confirmed by you"); };
    panel = sh;
  }
  function updatePanel(status, detail) {
    if (!panel) return;
    const msg = status === "submitted" ? "Application submitted. You can close this tab." :
      status === "filled" ? `Form filled. ${detail ? detail + " " : ""}Review, then press the site's submit button.` :
      status === "failed" ? `Couldn't finish: ${detail}` : detail;
    panel.getElementById("s").textContent = msg;
  }

  /* ---------- Main loop ---------- */
  let running = false;
  async function run(manual = false) {
    if (running || submitted) return; running = true;
    try {
      makePanel();
      if (dismissConsent()) await sleep(900);
      let result = fillAll();
      if (!result.filled && !manual && clickApplyEntry()) { await sleep(2500); result = fillAll(); }
      if (combos.length) { const c = await fillCombos(); result.filled += c.filled; result.missing = [...new Set(result.missing.concat(c.missing))].slice(0, 12); result.missDet = result.missDet.concat(c.missDet).slice(0, 12); }
      if (!result.filled && !fields().some((f) => /e-?mail|name/.test(describe(f)))) { updatePanel(null, task && task.ats === "naukri" ? "Press Naukri's Apply button — Applyra answers any questions it recognises." : "Waiting for the application form…"); return; }
      const ready = task && task.autoSubmit && AUTOSUBMIT.includes(task.ats) && !result.missing.length;
      if (task && AUTOSUBMIT.includes(task.ats) && !result.missing.length && captcha()) { report("filled", "The site shows a captcha — tick it and Applyra presses Submit for you.", { captcha: true, missing: [] }); watchCaptcha(); return; }
      const canAuto = ready;
      if (canAuto) {
        await sleep(1200 + Math.random() * 1200);
        const b = submitButton();
        if (b) { dismissConsent(); updatePanel(null, "Submitting…"); b.click(); watchSuccess(); return; }
      }
      const why = result.missing.length ? `Still needed: ${result.missing.map((m) => `"${m}"`).join(", ")}` : captcha() ? "The site asks for a captcha." : "";
      report("filled", why, { missing: result.missDet || [] });
    } finally { running = false; }
  }
  window.__applyraRun = () => { lastReport = ""; return run(false); };
  function watchSuccess() {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const body = document.body ? document.body.innerText.slice(0, 20000) : "";
      if (SUCCESS.test(body) || /thank|confirm|success|submitted/i.test(location.pathname + location.search)) { clearInterval(iv); submitted = true; report("submitted"); }
      else if (Date.now() - t0 > 25000) {
        clearInterval(iv);
        if (captcha()) { report("filled", "The site asked for a captcha after Submit — tick it and Applyra submits for you.", { captcha: true, missing: [] }); watchCaptcha(); return; }
        const errs = [...document.querySelectorAll("[aria-invalid=true], .error, .field-error, [class*='error']")].filter(visible).map((e) => e.innerText).filter(Boolean).slice(0, 3);
        report("filled", errs.length ? `The form flagged: ${errs.join("; ").slice(0, 160)}` : "Couldn't confirm the submission — please check the tab.");
      }
    }, 1000);
  }

  async function start() {
    const r = await send("getTask");
    if (!r || !r.task) return; // Only act on pages Applyra opened.
    task = r.task; profile = { ...(r.profile || {}), ...(task.profile || {}) };
    if (task.extra) window.__applyraExtra = Object.assign({}, task.extra, window.__applyraExtra || {});
    await sleep(1200); run();
    const mo = new MutationObserver(debounce(() => { if (!submitted) { run(); if (SUCCESS.test((document.body || {}).innerText || "")) { submitted = true; report("submitted"); } } }, 900));
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15 * 60000);
  }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // Popup "Fill this page" — works on any form, no task needed.
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m && m.kind === "fillNow") { profile = m.profile; task = task || { files: m.files || null, coverLetter: "", answers: {} }; const r = fillAll(); reply(r); }
  });
  start();
})();
