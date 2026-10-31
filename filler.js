/* Applyra form filler — runs on job pages that Applyra opened (or when you press "Fill this page" in the popup). */
(() => {
  if (window.__applyraFiller) return; window.__applyraFiller = true;
  if (document.querySelector('meta[name="applyra-app"]')) return;
  if (/(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|login\.live\.com)$/i.test(location.hostname)) return; // sign-in screens stay with you

  const AUTOSUBMIT = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "teamtailor", "bamboohr"];
  const SUCCESS = /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully applied|your application is on its way|application complete/i;
  let combos = [];
  let task = null, profile = null, filledEls = new WeakSet(), submitted = false, clickedApply = false, panel = null, lastReport = "";

  const send = (type, payload) => new Promise((res) => { try { chrome.runtime.sendMessage({ kind: "filler", type, payload }, (r) => { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  /* Query that also looks inside web components (open shadow DOM) — SmartRecruiters, Workday and others build forms this way. */
  const qa = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    const walk = (r) => { r.querySelectorAll("*").forEach((n) => { if (n.shadowRoot && !n.hasAttribute("data-applyra-panel")) { out.push(...n.shadowRoot.querySelectorAll(sel)); walk(n.shadowRoot); } }); };
    try { walk(root); } catch (e) {}
    return out;
  };
  const hostsOf = (el) => { const hs = []; let r = el.getRootNode && el.getRootNode(); while (r && r.host) { hs.push(r.host); r = r.host.getRootNode(); } return hs; };

  /* ---------- What does this field ask for? ---------- */
  function describe(el) {
    const bits = [];
    const R = (el.getRootNode && el.getRootNode()) || document;
    if (el.id) { try { const l = (R.querySelector ? R : document).querySelector(`label[for="${CSS.escape(el.id)}"]`) || document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) bits.push(l.innerText); } catch (e) {} }
    const wrapLabel = el.closest("label"); if (wrapLabel) bits.push(wrapLabel.innerText);
    if (el.getAttribute("aria-label")) bits.push(el.getAttribute("aria-label"));
    const lb = el.getAttribute("aria-labelledby"); if (lb) lb.split(/\s+/).forEach((id) => { const n = (R.getElementById ? R.getElementById(id) : null) || document.getElementById(id); if (n) bits.push(n.innerText); });
    hostsOf(el).slice(0, 3).forEach((h) => { bits.push(h.getAttribute("label"), h.getAttribute("aria-label"), h.getAttribute("formcontrolname"), h.getAttribute("name"));
      const hl = h.closest("label"); if (hl) bits.push(hl.innerText);
      if (h.id) { try { const l = document.querySelector(`label[for="${CSS.escape(h.id)}"]`); if (l) bits.push(l.innerText); } catch (e) {} } });
    bits.push(el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("autocomplete"), el.getAttribute("data-qa"));
    if (bits.filter(Boolean).join("").length < 3 || el.type === "file" || el.type === "radio") {
      const box = [el, ...hostsOf(el)].map((n) => n.closest(".field, .application-question, .form-group, .question, [class*='field'], [class*='Field'], [class*='question'], fieldset, li, div")).find(Boolean) || el.closest(".field, .application-question, .form-group, .question, [class*='field'], [class*='Field'], [class*='question'], fieldset, li, div");
      if (box) bits.push((box.querySelector("legend, label, .label, [class*='label'], [class*='Label'], h3, h4, p") || {}).innerText || "");
    }
    return norm(bits.filter(Boolean).join(" | ")).slice(0, 400);
  }

  /* The question a radio/checkbox group or dropdown belongs to (not the option label like "Yes"). */
  function questionOf(el) {
    const fs = el.closest("fieldset"); if (fs) { const lg = fs.querySelector("legend"); if (lg && norm(lg.innerText)) return norm(lg.innerText); }
    const rg = el.closest("[role=radiogroup], [role=group]");
    if (rg) { const lb = rg.getAttribute("aria-labelledby"); const t = (lb && lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" ")) || rg.getAttribute("aria-label"); if (norm(t)) return norm(t); }
    const group = el.name ? qa(`input[name="${CSS.escape(el.name)}"]`) : [el];
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
    [/full.?name|(full )?legal name|^name\b|your name|candidate name|\bname\s*\*?$/, (p) => p.fullName],
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
    return qa("input, textarea, select").filter((el) => {
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
  const optLabel = (r) => { const R = (r.getRootNode && r.getRootNode()) || document; return String((r.id && ((R.querySelector ? R : document).querySelector(`label[for="${CSS.escape(r.id)}"]`) || document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest("label") || {}).innerText || r.value || "").trim(); };
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
      const opts = qa("[role=option]").filter(visible);
      const o = opts.find((x) => norm(x.innerText) === want) || opts.find((x) => norm(x.innerText).startsWith(want) || want.startsWith(norm(x.innerText))) ||
        (/^yes/.test(want) && opts.find((x) => /^yes/i.test(x.innerText))) || (/^no\b/.test(want) && opts.find((x) => /^no\b/i.test(x.innerText))) ||
        (/prefer not|decline/.test(want) && opts.find((x) => /prefer not|decline|not to/i.test(x.innerText))) || (opts.length === 1 ? opts[0] : null);
      if (o) { o.click(); filledEls.add(el); filled++; } else { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); if (req) miss(el); }
      await sleep(250);
    }
    return { filled, missing, missDet };
  }

  /* ---------- Navigation helpers ---------- */
  const buttons = () => qa("button, a, input[type=submit], [role=button]").filter(visible);
  const txt = (b) => norm(b.innerText || b.value || b.getAttribute("aria-label"));
  function clickApplyEntry() {
    if (clickedApply) return false;
    const ats = task && task.ats;
    let b = null;
    if (ats === "linkedin") b = buttons().find((x) => /easy apply/.test(txt(x)));
    else if (ats === "naukri") return false; // Naukri's Apply button submits instantly — left for the user
    else b = buttons().find((x) => /^(apply( for this (job|position|role|opportunity))?( now)?|apply (now )?on (the )?company('s)? (site|website)|i'?m interested|start (your )?application|apply online|application|apply manually|begin application)$/.test(txt(x)) && !/linkedin|indeed|seek/.test(txt(x)));
    if (b) { clickedApply = true; b.click(); return true; }
    return false;
  }
  function submitButton() {
    return buttons().find((x) => /^(submit( application| my application)?|send application|apply|complete application|submit & apply)$/.test(txt(x)) && !x.disabled)
      || qa("button[type=submit], input[type=submit]").find(visible);
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
      if (captchaSolved()) { clearInterval(captchaWatch); captchaWatch = null; const b = submitButton(); if (b) { prog(94, "Captcha done — submitting"); updatePanel(null, "Thanks — submitting…"); b.click(); watchSuccess(); } }
    }, 1000);
  }
  const captcha = () => [...document.querySelectorAll("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']")].some((f) => visible(f) && f.getBoundingClientRect().height > 60);

  async function report(status, detail = "", extra = {}) {
    if (status === "submitted") prog(100, "Submitted ✓ — the site confirmed your application");
    const key = `${status}:${detail}`; if (key === lastReport) return; lastReport = key;
    await send("result", { status, detail, ...extra }); updatePanel(status, detail);
  }

  /* ---------- Floating status panel ---------- */
  function makePanel() {
    if (panel || window.top !== window) return;
    const host = document.createElement("div"); host.setAttribute("data-applyra-panel", "1"); host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>
      .p{font:13px/1.4 system-ui,sans-serif;background:#101935;color:#fff;border-radius:14px;padding:12px 14px;width:290px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
      .h{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:6px}.h img{width:20px;height:20px}
      .s{color:#c9cfe6;margin-bottom:10px}.r{display:flex;gap:6px;flex-wrap:wrap}
      button{font:600 12px system-ui;border:0;border-radius:99px;padding:7px 11px;cursor:pointer;background:#26336b;color:#fff}
      button.go{background:#f4a300;color:#1b1300}.x{margin-left:auto;background:none;padding:2px 6px;color:#8f97b4}
      #ask{display:none;margin:0 0 10px;max-height:46vh;overflow:auto}.q{font-weight:700;margin-bottom:6px}.ql{display:block;margin:8px 0 3px;color:#e6e9f5}
      #ask input:not([type=checkbox]),#ask select,#ask textarea{width:100%;box-sizing:border-box;border-radius:8px;border:0;padding:7px 8px;font:13px system-ui}.rm{display:block;margin:8px 0;color:#c9cfe6;font-size:12px}
      .p{width:320px}</style>
      <div class="p"><div class="h"><img src="${chrome.runtime.getURL("icons/ext-48.png")}">Applyra<button class="x" id="x">✕</button></div>
      <div class="s" id="s">Getting the form ready…</div><div id="ask"></div>
      <div class="r"><button id="fill">Continue</button><button id="cl">Copy cover letter</button><button id="done" class="go">I submitted it</button></div></div>`;
    document.documentElement.appendChild(host);
    sh.getElementById("x").onclick = () => host.remove();
    sh.getElementById("fill").onclick = () => { lastReport = ""; run(); };
    sh.getElementById("cl").onclick = () => navigator.clipboard.writeText((task && task.coverLetter) || "").then(() => updatePanel(null, "Cover letter copied — paste it where asked."));
    sh.getElementById("done").onclick = () => { submitted = true; report("submitted", "Confirmed by you"); };
    panel = sh;
  }
  function updatePanel(status, detail) {
    if (!panel) return;
    const msg = status === "submitted" ? "Application submitted. You can close this tab." :
      status === "filled" ? (/^(Needs your answer|This site needs|Waiting|Tick|The site shows|Filled —)/.test(detail) ? detail : `Form filled. ${detail ? detail + " " : ""}Review, then press the site's submit button.`) :
      status === "failed" ? `Couldn't finish: ${detail}` : detail;
    panel.getElementById("s").textContent = msg;
  }

  /* ---------- Progress 0–100 for the Applyra app ---------- */
  let pctNow = 0, lastProg = "", openedFor = "";
  function prog(pct, text) {
    const m = ((document.body || {}).innerText || "").slice(0, 4000).match(/step\s*(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (m && pct < 90 && pct >= 20) pct = Math.max(pct, Math.round(20 + 65 * (Math.min(+m[1], +m[2]) - 1) / Math.max(1, +m[2])));
    pctNow = Math.max(pctNow, Math.min(100, Math.round(pct)));
    const key = pctNow + "|" + text; if (key === lastProg) return; lastProg = key;
    send("progress", { pct: pctNow, text, page: location.hostname });
  }

  /* ---------- Multi-step engine: scroll, sign-in hand-off, AI answers, next pages ---------- */
  const NEXT_RE = /^(next|continue|save (and|&) continue|save (and|&) next|proceed|next step|continue to next step|review|review (my )?application|continue application)$/;
  const nextButton = () => buttons().find((x) => NEXT_RE.test(txt(x)) && !x.disabled);
  let steps = 0, lastSig = "", scrolledFor = "", aiAskedFor = new Set(), authClicked = false;
  const SK = "applyra_flow";
  const loadFlow = () => { try { const f = JSON.parse(sessionStorage.getItem(SK) || "null"); if (f && task && f.taskId === task.taskId && Date.now() - f.at < 30 * 60000) { steps = Math.max(steps, f.steps || 0); clickedApply = clickedApply || !!f.clickedApply; authClicked = authClicked || !!f.authClicked; pctNow = Math.max(pctNow, f.pct || 0); } } catch (e) {} };
  const saveFlow = () => { try { if (task) sessionStorage.setItem(SK, JSON.stringify({ taskId: task.taskId, steps, clickedApply, authClicked, pct: pctNow, at: Date.now() })); } catch (e) {} };
  const pageSig = () => location.pathname + "|" + fields().map((f) => f.name || f.id || f.type).join(",").slice(0, 600);
  async function autoScroll() {
    if (scrolledFor === location.href) return; scrolledFor = location.href;
    const H = () => Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
    for (let y = 0, i = 0; y < H() && i < 25; y += Math.round(window.innerHeight * 0.85), i++) { window.scrollTo(0, y); await sleep(250); }
    window.scrollTo(0, 0); await sleep(300);
  }
  function authWall() {
    const pw = [...document.querySelectorAll("input[type=password]")].some(visible);
    const words = /sign in|log in|login|create (an )?account|sign up|register/i.test((document.body || {}).innerText ? document.body.innerText.slice(0, 3000) : "");
    return pw || (words && !fields().some((f) => /resume|cv|first.?name|phone/.test(describe(f))));
  }
  function googleButton() {
    return [...document.querySelectorAll("button, a, [role=button], div[aria-label], iframe[src*='accounts.google.com/gsi']")].filter(visible)
      .find((x) => /google/i.test((x.innerText || "") + " " + (x.getAttribute("aria-label") || "") + " " + (x.getAttribute("title") || "") + " " + (x.src || "")) && /sign|log|continue|google/i.test((x.innerText || x.getAttribute("aria-label") || "google")));
  }
  const submitAllowed = () => task && task.autoSubmit && (AUTOSUBMIT.includes(task.ats) || (task.submitAny && !/linkedin\.|naukri\.|indeed\./i.test(location.hostname)));
  async function askAI(missDet) {
    const sig = missDet.map((m) => m.q).join("|"); if (!sig || aiAskedFor.has(sig)) return false; aiAskedFor.add(sig);
    updatePanel(null, `Asking AI about ${missDet.length} question${missDet.length > 1 ? "s" : ""} on this page…`); prog(pctNow + 3, `Asking AI about ${missDet.length} new question${missDet.length > 1 ? "s" : ""}`);
    const r = await send("aiAsk", { questions: missDet, job: { title: task.title, company: task.company, location: task.location, ats: task.ats } });
    const ans = (r && r.answers) || {}; const keys = Object.keys(ans).filter((k) => ans[k] && !/^unknown$/i.test(String(ans[k]).trim()));
    if (!keys.length) return false;
    window.__applyraExtra = Object.assign({}, window.__applyraExtra || {}, ...keys.map((k) => ({ [k]: ans[k] })));
    return true;
  }

  /* ---------- When Applyra is stuck: ask you right on the page, then carry on ---------- */
  let askingFor = "";
  function askPerson(missDet) {
    if (!panel || !missDet.length) return;
    const sig = missDet.map((m) => m.q).join("|"); if (askingFor === sig) return; askingFor = sig;
    send("needInput", { questions: missDet }); // also pops up in the Applyra app — answer there or here
    const box = panel.getElementById("ask"); if (!box) return;
    box.innerHTML = `<div class="q">Applyra needs ${missDet.length === 1 ? "one answer" : missDet.length + " answers"} to continue:</div>` + missDet.map((m, i) => `<label class="ql">${escH(m.q)}</label>` +
      (m.options && m.options.length ? `<select data-i="${i}">${["<option value=''>Choose…</option>"].concat(m.options.map((o) => `<option>${escH(o)}</option>`)).join("")}</select>`
        : m.type === "long" ? `<textarea data-i="${i}" rows="3"></textarea>` : `<input data-i="${i}">`)).join("") +
      `<label class="rm"><input type="checkbox" id="rem" checked> Remember for future applications</label><button class="go" id="goOn">Fill & continue</button>`;
    box.style.display = "block";
    panel.getElementById("goOn").onclick = () => {
      const ans = {};
      box.querySelectorAll("[data-i]").forEach((el) => { const v = el.value.trim(); if (v) ans[missDet[+el.dataset.i].q] = v; });
      if (!Object.keys(ans).length) return;
      window.__applyraExtra = Object.assign({}, window.__applyraExtra || {}, ans);
      if (panel.getElementById("rem").checked) send("learned", { answers: ans });
      applyAnswers(ans);
    };
  }
  const escH = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- Main loop ---------- */
  let running = false;
  let rerun = false;
  async function run(manual = false) {
    if (submitted) return;
    if (running) { rerun = true; return; } // the page changed while busy — go again when free
    running = true; rerun = false; loadFlow();
    try {
      makePanel();
      if (openedFor !== location.href) { openedFor = location.href; prog(8, `Opened ${location.hostname}`); }
      if (dismissConsent()) { prog(10, "Closed the cookie banner"); await sleep(900); }
      if (scrolledFor !== location.href) prog(12, "Reading the job requirements");
      await autoScroll();
      let result = fillAll();
      // Cloud robot: sign-in / create-account pages are handled by the AI agent with your career-site login — don't submit them half-filled.
      if (task && task.background && qa("input[type=password]").some(visible)) { prog(pctNow || 18, "Account page — handing to the AI agent"); report("filled", "This site needs an account.", { auth: true }); return; }
      if (!result.filled && !manual && clickApplyEntry()) { prog(16, "Clicked Apply — opening the application"); saveFlow(); updatePanel(null, "Opening the application…"); await sleep(2500); return; }
      if (!result.filled && authWall()) {
        const g = googleButton();
        if (g && !authClicked && !(task && task.background)) { authClicked = true; prog(18, "Needs an account — clicked “Continue with Google”, waiting for you"); g.click(); report("filled", "This site needs an account — Applyra clicked “Continue with Google”. Pick your Google account in the pop-up and Applyra carries on.", { auth: true }); return; }
        prog(18, "Waiting for you to sign in"); report("filled", authClicked ? "Waiting for you to finish signing in…" : "This site needs you to sign in or create an account first. Sign in in this tab and Applyra carries on.", { auth: true }); return;
      }
      if (combos.length) { const c = await fillCombos(); result.filled += c.filled; result.missing = [...new Set(result.missing.concat(c.missing))].slice(0, 12); result.missDet = result.missDet.concat(c.missDet).slice(0, 12); }
      if (!result.filled && !fields().some((f) => /e-?mail|name|resume|cv|phone/.test(describe(f)))) {
        const nb = nextButton(); if (nb && submitAllowed() && steps < 15) { steps++; saveFlow(); nb.click(); updatePanel(null, `Step ${steps + 1}…`); return; }
        const sb0 = submitButton();
        const reviewish = /review|confirm|summary|step\s*\d+\s*(of|\/)\s*\d+|almost done|final step/i.test(((document.body || {}).innerText || "").slice(0, 3000));
        if (sb0 && submitAllowed() && (steps > 0 || clickedApply || reviewish) && /submit|send|finish|complete/i.test(txt(sb0))) { if (captcha()) { report("filled", "Tick the captcha and Applyra submits for you.", { captcha: true }); watchCaptcha(); return; } dismissConsent(); prog(92, "Submitting the application"); updatePanel(null, "Submitting…"); sb0.click(); watchSuccess(); return; }
        updatePanel(null, task && task.ats === "naukri" ? "Press Naukri's Apply button — Applyra answers any questions it recognises." : "Waiting for the application form…"); return;
      }
      // Questions Applyra doesn't know: ask AI (once per page), then fill again.
      if (result.missing.length && task && (await askAI(result.missDet || []))) {
        result = fillAll();
        if (combos.length) { const c = await fillCombos(); result.filled += c.filled; result.missing = [...new Set(result.missing.concat(c.missing))].slice(0, 12); result.missDet = result.missDet.concat(c.missDet).slice(0, 12); }
      }
      if (result.filled) prog(22 + steps * 15, `Page ${steps + 1}: filled ${result.filled} field${result.filled === 1 ? "" : "s"}${(task && task.files && fields().some((f) => f.type === "file" && f.files && f.files.length)) ? " · resume attached" : ""}`);
      if (result.missing.length) prog(pctNow, `Waiting for your answer: ${result.missing.slice(0, 2).map((m) => `"${m}"`).join(", ")}${result.missing.length > 2 ? "…" : ""}`);
      if (task && !result.missing.length && captcha()) { prog(88, "Everything filled — waiting for you to tick the captcha"); report("filled", "The site shows a captcha — tick it and Applyra presses Submit for you.", { captcha: true, missing: [] }); watchCaptcha(); return; }
      if (submitAllowed() && !result.missing.length) {
        await sleep(900 + Math.random() * 900);
        const sb = submitButton(), nb = nextButton();
        const finalSubmit = sb && !(nb && nb === sb) && /submit|send|apply|finish|complete/i.test(txt(sb) || sb.type || "submit");
        if (nb && !finalSubmit) {
          const sig = pageSig(); if (sig === lastSig) { report("filled", "This step didn't move forward — please check the highlighted fields."); return; }
          lastSig = sig; if (steps++ >= 15) { report("filled", "This application has many steps — please finish it in the tab."); return; }
          updatePanel(null, `Step ${steps} done — next page…`); prog(22 + steps * 15, `Page ${steps} done → next`); saveFlow(); dismissConsent(); nb.click(); return; // the page change triggers the next run
        }
        if (sb) { dismissConsent(); prog(92, "Submitting the application"); updatePanel(null, "Submitting…"); sb.click(); watchSuccess(); return; }
      }
      if (result.missing.length && task && window.top === window && panel) { askPerson(result.missDet || []); report("filled", "Needs your answer below — then Applyra carries on.", { missing: result.missDet || [] }); return; }
      const why = result.missing.length ? `Still needed: ${result.missing.map((m) => `"${m}"`).join(", ")}` : captcha() ? "The site asks for a captcha." : (submitAllowed() ? "" : "Filled — review and press the site's Submit.");
      report("filled", why, { missing: result.missDet || [] });
    } finally { saveFlow(); running = false; if (rerun && !submitted) { rerun = false; setTimeout(() => run(), 600); } }
  }
  window.__applyraRun = () => { lastReport = ""; return run(false); };
  /* ---------- AI page agent hooks (cloud robot): read the page as data, then apply the AI's plan ---------- */
  const AMAP = new Map(); let aidN = 0;
  const aid = (el) => { if (!el.__aid) { el.__aid = "f" + (++aidN); AMAP.set(el.__aid, el); try { el.setAttribute("data-aid", el.__aid); } catch (e) {} } return el.__aid; };
  window.__applyraClick = (id) => { const el = AMAP.get(id); if (!el || !el.isConnected) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; };
  const errNear = (el) => { const box = [el, ...hostsOf(el)].map((n) => n.closest(".field, .form-group, .question, [class*='field'], [class*='Field'], [class*='question'], li")).find(Boolean); if (!box) return "";
    const e = box.querySelector("[class*='error' i], [role=alert], .invalid-feedback, [aria-live]"); return e && visible(e) ? norm(e.innerText).slice(0, 160) : ""; };
  window.__applyraSnap = () => {
    const out = { url: location.href, title: document.title, fields: [], buttons: [], errors: [], captcha: captcha(), auth: !fields().length && authWall(),
      done: SUCCESS.test(((document.body || {}).innerText || "").slice(0, 20000)), text: norm(((document.body || {}).innerText || "")).slice(0, 2500) };
    const seenRadio = new Set();
    for (const el of fields()) {
      const t = (el.type || el.tagName).toLowerCase();
      if (t === "file") { out.fields.push({ id: aid(el), label: describe(el).slice(0, 160), type: "file", value: el.files && el.files.length ? el.files[0].name : "", required: isRequired(el) }); continue; }
      if (t === "radio") {
        if (seenRadio.has(el.name)) continue; seenRadio.add(el.name);
        const group = el.name ? qa(`input[type=radio][name="${CSS.escape(el.name)}"]`) : [el];
        const ch = group.find((r) => r.checked);
        out.fields.push({ id: aid(el), label: questionOf(el) || describe(el).slice(0, 160), type: "radio", options: group.map(optLabel).slice(0, 25), optionIds: group.slice(0, 25).map(aid), value: ch ? optLabel(ch) : "", required: group.some((r) => r.required), error: errNear(el) }); continue;
      }
      const f = { id: aid(el), label: (t === "checkbox" ? describe(el) : (describe(el).split(" | ")[0] || describe(el))).slice(0, 200), type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : t,
        value: t === "checkbox" ? String(el.checked) : String(el.tagName === "SELECT" ? (((o) => (o && o.value !== "" && !/^(select|choose|--|please)/i.test(o.text.trim()) ? o.text : ""))(el.options[el.selectedIndex])) : el.value || "").slice(0, 200), required: isRequired(el), error: errNear(el) || (el.getAttribute("aria-invalid") === "true" ? "invalid" : "") };
      if (el.tagName === "SELECT") f.options = [...el.options].filter((o) => o.value !== "" && !/^(select|choose|--)/i.test(o.text.trim())).map((o) => o.text.trim()).slice(0, 40);
      if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete")) f.type = "combo";
      const ml = Number(el.getAttribute("maxlength")) || 0; if (ml > 0) f.maxLength = ml;
      if (el.getAttribute("pattern")) f.pattern = el.getAttribute("pattern");
      out.fields.push(f);
    }
    // passwords (career-site accounts) and list-box dropdowns (Workday, iCIMS, Oracle…)
    qa("input[type=password]").filter(visible).forEach((el) => out.fields.push({ id: aid(el), label: describe(el).slice(0, 160), type: "password", value: el.value ? "(filled)" : "", required: isRequired(el), error: errNear(el) }));
    const dds = qa("button[aria-haspopup=listbox], [role=button][aria-haspopup=listbox], [role=combobox]:not(input):not(select)").filter(visible);
    dds.forEach((el) => { const lab = el.getAttribute("aria-label") || describe(el); out.fields.push({ id: aid(el), label: norm(lab).slice(0, 200), type: "dropdown", value: norm(el.innerText || "").replace(/^(select one|select|choose one|choose)$/, "").slice(0, 120), required: /required|\*/.test(lab), error: errNear(el) }); });
    out.hasPassword = out.fields.some((f) => f.type === "password");
    out.buttons = buttons().filter((b) => !dds.includes(b) && txt(b) && txt(b).length < 60).slice(0, 40).map((b) => ({ id: aid(b), text: txt(b) }));
    out.errors = [...new Set(qa("[role=alert], [aria-invalid=true], .error, .field-error, [class*='error' i]").filter(visible).map((e) => norm(e.innerText)).filter((x) => x && x.length < 200))].slice(0, 8);
    return out;
  };
  window.__applyraAct = async (plan) => {
    let n = 0;
    for (const a of (plan && plan.fill) || []) {
      const el = AMAP.get(a.id); if (!el || !el.isConnected || a.value == null) continue; const v = String(a.value); const t = (el.type || "").toLowerCase();
      try {
        if (el.tagName === "SELECT") { if (pickOption(el, v)) n++; }
        else if (t === "radio") { const group = el.name ? qa(`input[type=radio][name="${CSS.escape(el.name)}"]`) : [el]; const w = norm(v); const r = group.find((x) => norm(optLabel(x)) === w) || group.find((x) => norm(optLabel(x)).startsWith(w) || w.startsWith(norm(optLabel(x)))); if (r) { r.click(); n++; } }
        else if (t === "checkbox") { const want = /^(true|yes|1|checked|on)$/i.test(v); if (el.checked !== want) { el.click(); n++; } }
        else if (t === "file") { const role = /cover/.test(v) ? "cover" : "resume"; const f = task && task.files && task.files.find((x) => x.role === role); if (f) { attach(el, b64ToFile(f)); n++; } }
        else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete")) {
          el.focus(); el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); setNative(el, v.slice(0, 30)); await sleep(900);
          const w = norm(v); const o = qa("[role=option]").filter(visible); const pick = o.find((x) => norm(x.innerText) === w) || o.find((x) => norm(x.innerText).includes(w) || w.includes(norm(x.innerText))) || o[0];
          if (pick) { pick.click(); n++; } else { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
        } else { setNative(el, v); n++; }
        filledEls.add(el);
      } catch (e) {}
      await sleep(120);
    }
    if (plan && plan.click) { const b = AMAP.get(plan.click); if (b && b.isConnected) { dismissConsent(); await sleep(300); b.click(); return { filled: n, clicked: txt(b) }; } }
    return { filled: n, clicked: "" };
  };
  function watchSuccess() {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const body = document.body ? document.body.innerText.slice(0, 20000) : "";
      if (SUCCESS.test(body) || /thank|confirm|success|submitted/i.test(location.pathname + location.search)) { clearInterval(iv); submitted = true; report("submitted"); }
      else if (Date.now() - t0 > 25000) {
        clearInterval(iv);
        if (captcha()) { report("filled", "The site asked for a captcha after Submit — tick it and Applyra submits for you.", { captcha: true, missing: [] }); watchCaptcha(); return; }
        const errs = [...qa("[aria-invalid=true], .error, .field-error, [class*='error']")].filter(visible).map((e) => e.innerText).filter(Boolean).slice(0, 3);
        report("filled", errs.length ? `The form flagged: ${errs.join("; ").slice(0, 160)}` : "Couldn't confirm the submission — please check the tab.");
      }
    }, 1000);
  }

  async function start() {
    const r = await send("getTask");
    if (!r || !r.task) return; // Only act on pages Applyra opened.
    task = r.task; profile = { ...(r.profile || {}), ...(task.profile || {}) };
    if (task.extra) window.__applyraExtra = Object.assign({}, task.extra, window.__applyraExtra || {});
    await sleep(1200); await run();
    // Landed on the confirmation page after a full page load (multi-page forms): confirm it.
    try { loadFlow(); if (!submitted && (steps > 0 || clickedApply) && (SUCCESS.test(((document.body || {}).innerText || "").slice(0, 20000)) || /\/(thank|thanks|confirmation|success|submitted)\b/i.test(location.pathname))) { submitted = true; report("submitted"); } } catch (e) {}
    const mo = new MutationObserver(debounce(() => { if (!submitted) { run(); if (SUCCESS.test((document.body || {}).innerText || "")) { submitted = true; report("submitted"); } } }, 900));
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15 * 60000);
  }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // Answers typed in the Applyra app come back here and the form continues.
  function applyAnswers(ans) {
    if (!ans || !Object.keys(ans).length) return;
    window.__applyraExtra = Object.assign({}, window.__applyraExtra || {}, ans);
    const box = panel && panel.getElementById("ask"); if (box) { box.style.display = "none"; box.innerHTML = ""; }
    askingFor = ""; lastReport = ""; run();
  }
  // Popup "Fill this page" — works on any form, no task needed.
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m && m.kind === "input") { applyAnswers(m.answers); return; }
    if (m && m.kind === "fillNow") { profile = m.profile; task = task || { files: m.files || null, coverLetter: "", answers: {} }; const r = fillAll(); reply(r); }
  });
  start();
})();
