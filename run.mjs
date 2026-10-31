/* Applyra cloud runner — submits queued applications from GitHub's servers, so auto-apply works from a phone.
   For each application with status "queued": builds the tailored resume + cover letter PDFs (same designs as the app),
   opens the job form in Chromium, fills it with the same filler as the Chrome extension, and submits on supported forms.
   Anything it can't finish (captcha, unknown required question, login wall) goes to "Needs your review" in the app. */
import admin from "firebase-admin";
import fs from "fs";
import crypto from "crypto";

const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
if (!sa.project_id) { console.error("FIREBASE_SA secret missing"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const MAX = Number(process.env.MAX_PER_RUN || 6);
const AUTOSUBMIT = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "teamtailor", "bamboohr"];

const quotaMsg = (e) => /RESOURCE_EXHAUSTED|Quota exceeded|8 RESOURCE/i.test(String(e && (e.message || e))) ? "Firebase's free daily database limit is used up — it resets around 12:30 pm IST." : String(e && (e.message || e)).slice(0, 200);
// Recover jobs left at "applying" by a run that died (e.g. the daily database limit was hit mid-run).
try {
  const stuck = await db.collectionGroup("applications").where("status", "==", "applying").limit(20).get();
  for (const d of stuck.docs) {
    const x = d.data(), age = Date.now() - ((x.progress && x.progress.at) || x.updatedAt || 0);
    if (age > 25 * 60000) await d.ref.set({ status: "needs_review", updatedAt: Date.now(), extDetail: "The cloud robot stopped unexpectedly on this one (" + ((x.progress && x.progress.text) || "before starting") + "). Tap Retry cloud apply.", progress: { ...(x.progress || {}), pct: (x.progress && x.progress.pct) || 3, text: "Stopped unexpectedly — tap Retry", at: Date.now(), where: "cloud" } }, { merge: true });
  }
} catch (e) { console.log("stuck-check: " + quotaMsg(e)); }
let queued;
try { queued = await db.collectionGroup("applications").where("status", "==", "queued").limit(MAX).get(); }
catch (e) { console.log("Can't read the queue: " + quotaMsg(e)); if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "work=false\n"); process.exit(0); }
if (process.argv.includes("--check")) {
  console.log(`${queued.size} queued`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `work=${queued.size > 0}\n`);
  await db.doc("meta/status").set({ lastRunner: Date.now() }, { merge: true });
  process.exit(0);
}
if (queued.empty) { console.log("Nothing queued"); process.exit(0); }

const { chromium } = await import("playwright");
const APP_URL = (process.env.APP_URL || `https://${sa.project_id}.web.app`).replace(/\/$/, "");
const FILLER = fs.readFileSync(new URL("./filler.js", import.meta.url), "utf8");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
const pdfPage = await browser.newPage();
await pdfPage.goto(`${APP_URL}/runner.html`, { waitUntil: "load", timeout: 60000 });
await pdfPage.waitForFunction(() => window.runnerReady === true, null, { timeout: 60000 });

const slug = (s) => String(s || "").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 40);
function flatProfile(R, scr) {
  const sc = Object.assign({ noticePeriod: "30 days", currentCtc: "", expectedCtc: "", relocate: "Yes", workAuthIndia: "Yes", needSponsorship: "Yes, for roles outside India",
    gender: "Prefer not to say", heardFrom: "LinkedIn", nationality: "Indian", pronouns: "" }, scr || {});
  const parts = String(R.name || "").trim().split(/\s+/), cur = (R.experience || [])[0] || {}, edu = (R.education || [])[0] || {};
  const phone = String(R.phone || ""), digits = phone.replace(/\D/g, "");
  return { fullName: R.name, firstName: parts[0] || "", lastName: parts.slice(1).join(" "), email: R.email, phone,
    phoneNational: digits.length > 10 ? digits.slice(-10) : digits, phoneCountryCode: digits.length > 10 ? `+${digits.slice(0, digits.length - 10)}` : "+91",
    location: R.location, city: String(R.location || "").split(",")[0].trim(), country: /india/i.test(R.location || "") || !R.location ? "India" : "",
    linkedin: R.linkedin, website: R.website || R.linkedin, github: R.github, currentTitle: cur.title, currentCompany: cur.company,
    yearsExperience: String(R.yearsExperience || ""), headline: R.headline, summary: R.summary, school: edu.school, degree: edu.degree, gradYear: edu.year,
    skills: (R.skills || []).join(", "), employers: (R.experience || []).map((e) => e.company).filter(Boolean), ...sc };
}
/* Go straight to the application form itself — company sites often wrap these boards or redirect them. */
async function formUrl(job) {
  const u = String(job.url || ""); let m;
  if (job.ats === "greenhouse") {
    let slug, id;
    if ((m = u.match(/greenhouse\.io\/(?!embed)([^\/?#]+)\/jobs\/(\d+)/))) [slug, id] = [m[1], m[2]];
    if (!slug) { try { const jd = (await db.doc("jobs/" + job.id).get()).data() || {}; if (jd.source === "greenhouse" && String(jd.extId).includes(":")) [slug, id] = String(jd.extId).split(":"); } catch (e) {} }
    if (!id && (m = u.match(/[?&](?:gh_jid|token)=(\d+)/))) id = m[1];
    if (!slug && (m = u.match(/[?&]for=([^&]+)/))) slug = m[1];
    if (slug && id) return `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${id}`;
  }
  if ((m = u.match(/^(https:\/\/jobs\.(?:eu\.)?lever\.co\/[^\/?#]+\/[0-9a-f-]{36})(?:\/apply)?/))) return m[1] + "/apply";
  if ((m = u.match(/^(https:\/\/jobs\.ashbyhq\.com\/[^\/?#]+\/[0-9a-f-]{36})/))) return m[1] + "/application";
  // SmartRecruiters: the job page's "I'm interested" opens the one-page apply form at /oneclick-ui/company/<co>/publication/<uuid>
  if ((m = u.match(/^https:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([^\/?#]+)\/(\d+)/i))) {
    try { const h = await (await fetch(u.split("?")[0], { headers: { "User-Agent": UA } })).text(); const p = h.match(/publication\/([0-9a-f-]{36})/i);
      if (p) return `https://jobs.smartrecruiters.com/oneclick-ui/company/${m[1]}/publication/${p[1]}?dcr_ci=${m[1]}`; } catch (e) {}
    return u.split("?")[0];
  }
  if ((m = u.match(/^(https:\/\/apply\.workable\.com\/[^\/?#]+\/j\/[A-Z0-9]+)/i))) return m[1] + "/apply/";
  return u;
}
/* When the filler never reports, say what the page actually was. */
async function diagnose(page) {
  const info = (await Promise.all(page.frames().map((f) => f.evaluate(() => ({
    n: document.querySelectorAll("input:not([type=hidden]):not([type=search]), textarea, select").length,
    cap: !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], #challenge-form"),
    t: (document.body ? document.body.innerText : "").slice(0, 4000) })).catch(() => null)))).filter(Boolean);
  const text = info.map((x) => x.t).join("\n"), n = info.reduce((a, x) => a + x.n, 0), host = new URL(page.url()).hostname;
  if (/no longer (available|accepting|open)|position (has been )?(filled|closed)|job (is )?(closed|expired|not found)|page (you.re looking for )?(not found|doesn.t exist)|\b404\b/i.test(text)) return { closed: true, detail: "this job has closed on " + host };
  if (info.some((x) => x.cap) || /verify you are human|are you a robot|checking your browser/i.test(text)) return { detail: "the site showed a captcha / bot check (" + host + ")" };
  if (/sign in|log in|create (an )?account/i.test(text) && n < 6) return { detail: "the site asks you to sign in first (" + host + ")" };
  if (n < 3) return { detail: "no application form appeared on " + host + " (it may need a click-through)" };
  return { detail: "the form on " + host + " didn't respond to filling (" + n + " fields seen)" };
}
/* ---------- AI page agent: when the form engine can't move on, Gemini reads the live page and decides what to fill and click ---------- */
const AGENT_RULES = `You operate a job application website on behalf of the candidate, one page at a time, until the application is submitted.
You get CANDIDATE DATA, what you did in EARLIER STEPS, and PAGE NOW: fields (id, label, type, options, current value, required, error), buttons (id, text), visible errors and page text.
Reply ONLY with JSON: {"fill":[{"id":"f3","value":"..."}],"click":"button id or empty","status":"continue|submitted|verify_email|email_code|blocked","codeField":"field id when status is email_code","ask":[{"id":"f7","q":"question"}],"note":"one short line"}
Filling:
1. Fill every empty required field and FIX every field that shows an error (read the error: format, length, digits only…). Leave correct fields alone. Also fill optional fields you have real data for (LinkedIn URL, current company, etc.).
2. Facts (names, contact, address, employers, titles, dates, degrees, years, tools, certifications, CTC/salary, notice period, visa/work authorisation) come ONLY from the candidate data. "Years of X": compute from the dated roles. Phone: match the requested format (10 digits without +91 when there is a separate country-code field). Dates: the format the field shows.
3. Never invent a fact. If a required fact is missing: for choice fields pick a truthful neutral option ("Prefer not to say", "Decline to answer", "Negotiable", "Open to discussion", "Other"); for free text a truthful neutral answer ("Negotiable", "Open to discussion", "Happy to share during the interview process"). Only when nothing truthful fits (e.g. a digits-only current-salary field with no salary in the data) put it in "ask" — still fill and click everything else.
4. Willingness (relocation, travel, office days, shifts, background checks, assessments, start date): follow the candidate preferences; otherwise "Yes" for reasonable conditions.
5. Diversity / EEO / disability / veteran / gender-identity questions: the "prefer not to say"/"decline"/"I don't wish to answer" option. Required consent boxes (privacy, terms, data processing, information is accurate): "true". Never tick marketing/newsletter/SMS/job-alert boxes.
6. Free text (why this company, cover letter, summary, additional information): specific to this company and role, from the candidate's real experience; use the cover letter when a cover-letter text box appears; respect maxLength.
7. File fields: "resume" (or "cover" for a cover-letter upload) when empty. type "dropdown" = a button that opens a list: give the option text. type "combo" = type-ahead: give the text to search and pick.
Navigating:
8. Click the ONE button that moves the application forward: Apply / Apply now / I'm interested / Apply Manually / Next / Continue / Save and continue / Review / Submit / Submit application. On Workday's "Start your application" choose "Apply Manually". Never click: sign in or apply with Google, LinkedIn, Facebook, Apple, Indeed or SEEK; cancel; back; withdraw; save draft; delete; links to other jobs.
9. Career-site account: if the employer's own site requires an account and CANDIDATE DATA has siteAccount, use EXACTLY its email and password. siteAccount.existing true → sign in. Otherwise → create the account (email, password, confirm/verify password, required terms box), then continue; if the site says the account already exists, sign in instead. Wrong password / locked account → status "blocked" with note "login failed". No siteAccount → status "blocked".
10. The site says to check your email to verify/activate the account → status "verify_email". The page asks for a code sent by EMAIL (verification / security code / one-time code) → status "email_code" with codeField. A code sent by SMS/phone → "blocked".
11. status "submitted" ONLY when the page text confirms the application was received. "blocked" for a captcha, a closed job, or a page that needs a person. Otherwise "continue".`;
const AI_OK = () => !!(GEMINI || RUNNER_SECRET);
const normT = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
function bestIdx(list, want) {
  const w = normT(want), L = (list || []).map(normT); if (!w) return -1;
  let i = L.indexOf(w); if (i >= 0) return i;
  i = L.findIndex((x) => x && (x.startsWith(w) || w.startsWith(x))); if (i >= 0) return i;
  i = L.findIndex((x) => x && (x.includes(w) || w.includes(x))); if (i >= 0) return i;
  if (/^(yes|y)\b/.test(w)) return L.findIndex((x) => /^yes/.test(x));
  if (/^(no|n)\b/.test(w)) return L.findIndex((x) => /^no/.test(x));
  if (/prefer not|decline|don.?t wish/.test(w)) return L.findIndex((x) => /prefer not|decline|not to (say|disclose)|don.?t wish/.test(x));
  return -1;
}
async function pickOption(frame, want) {
  for (const f of [frame, frame.page().mainFrame()]) {
    const opts = f.locator("[role=option]:visible, [data-automation-id=promptOption]:visible, li[role=menuitem]:visible");
    const texts = await opts.allInnerTexts().catch(() => []); const i = bestIdx(texts.map((t) => t.split("\n")[0]), want);
    if (i >= 0) { await opts.nth(i).click({ timeout: 4000 }).catch(() => opts.nth(i).click({ force: true, timeout: 3000 })); return true; }
  }
  return false;
}
async function clickAid(frame, id) {
  const loc = frame.locator(`[data-aid="${id}"]`).first();
  try { await loc.click({ timeout: 6000 }); return true; } catch (e) {}
  try { await loc.click({ force: true, timeout: 3000 }); return true; } catch (e) {}
  return !!(await frame.evaluate((i) => window.__applyraClick && window.__applyraClick(i), id).catch(() => false));
}
/* Apply the AI's plan with real browser input (typing, clicks, list picks) — works on React/Angular/Workday forms. */
async function actPlan(frame, plan, snap, task) {
  let n = 0, clicked = "";
  for (const a of plan.fill || []) {
    const f = snap.fields.find((x) => x.id === a.id); if (!f || a.value == null || a.value === "") continue;
    const v = String(a.value), loc = frame.locator(`[data-aid="${a.id}"]`).first();
    try {
      if (f.type === "select") { const opts = await loc.evaluate((el) => [...el.options].map((o) => o.text.trim())); const i = bestIdx(opts, v); if (i < 0) continue; await loc.selectOption({ index: i }); }
      else if (f.type === "radio") { const i = bestIdx(f.options, v); const oid = (f.optionIds || [])[i]; if (!oid || !(await clickAid(frame, oid))) continue; }
      else if (f.type === "checkbox") { const want = /^(true|yes|1|checked|on)$/i.test(v); const is = await loc.isChecked().catch(() => null); if (is === want || !(await clickAid(frame, a.id))) continue; }
      else if (f.type === "file") { const file = task.files.find((x) => x.role === (/cover/i.test(v) ? "cover" : "resume")); if (!file) continue; await loc.setInputFiles({ name: file.name, mimeType: file.type, buffer: Buffer.from(file.data, "base64") }); }
      else if (f.type === "dropdown") {
        await clickAid(frame, a.id); await frame.waitForTimeout(800);
        if (!(await pickOption(frame, v))) { await frame.page().keyboard.type(v.slice(0, 25), { delay: 40 }); await frame.waitForTimeout(1000); if (!(await pickOption(frame, v))) { await frame.page().keyboard.press("Enter"); } }
      }
      else if (f.type === "combo") { await loc.click({ timeout: 4000 }).catch(() => {}); await loc.fill(""); await loc.pressSequentially(v.slice(0, 30), { delay: 35 }); await frame.waitForTimeout(1000); if (!(await pickOption(frame, v))) await loc.press("Enter"); }
      else { await loc.fill(v, { timeout: 6000 }); await loc.dispatchEvent("blur").catch(() => {}); }
      n++;
    } catch (e) { // fall back to the in-page setter
      const r = await frame.evaluate((p) => (window.__applyraAct ? window.__applyraAct(p) : { filled: 0 }), { fill: [a] }).catch(() => ({ filled: 0 }));
      n += r.filled || 0;
    }
    await frame.waitForTimeout(120);
  }
  if (plan.click) { const b = snap.buttons.find((x) => x.id === plan.click) || snap.fields.find((x) => x.id === plan.click); if (await clickAid(frame, plan.click)) clicked = (b && (b.text || b.label)) || "button"; }
  return { filled: n, clicked };
}
async function waitMail(kind, host, since, P, pct) {
  for (let i = 0; i < 20; i++) { // up to ~3 min
    try { const r = await backend("runnerMail", { kind, host, since }); if (r && (r.code || r.link)) return r; if (r && r.owner) MAIL_OWNER = r.owner; } catch (e) { return { error: String(e.message || e) }; }
    if (i === 0) await P(pct, kind === "code" ? "Waiting for the verification code email…" : "Waiting for the account verification email…");
    await new Promise((r) => setTimeout(r, 9000));
  }
  return {};
}
let MAIL_OWNER = "";
async function aiAgent(page, ctx, P, kept, opts = {}) {
  const hist = [], asks = new Map(); let lastSig = "", same = 0, usedPw = false, lastFormUrl = "";
  const t0 = opts.since || Date.now();
  for (let round = 1; round <= 24; round++) {
    if (kept.some((r) => r && r.status === "submitted")) return { status: "submitted", hist, usedPw };
    let best = null, bf = null;
    for (const f of page.frames()) {
      const sn = await f.evaluate(() => (window.__applyraSnap ? window.__applyraSnap() : null)).catch(() => null);
      if (!sn) continue;
      if (sn.done) { best = sn; bf = f; break; }
      if (!best || sn.fields.length * 10 + sn.buttons.length > best.fields.length * 10 + best.buttons.length) { best = sn; bf = f; }
    }
    if (!best) { await page.waitForTimeout(2500); continue; }
    if (best.done) return { status: "submitted", hist, usedPw };
    if (best.captcha) return { status: "captcha", hist, usedPw };
    if (best.auth && !ctx.siteAccount) return { status: "blocked", reason: "login", detail: "this site needs an account to apply (switch on “Let the robot create career-site accounts” in Settings)", hist };
    if (best.fields.length) lastFormUrl = best.url;
    const sig = JSON.stringify([best.url, best.fields.map((x) => x.label + "=" + x.value), best.errors]);
    if (sig === lastSig) { if (++same >= 3) return { status: "stuck", reason: "form", detail: best.errors.length ? "the form still shows: " + best.errors.join("; ").slice(0, 160) : "the page didn't move forward", ask: [...asks.values()], hist, usedPw }; } else same = 0;
    lastSig = sig;
    await P(Math.min(89, 50 + round * 2), `AI agent · step ${round}: reading ${new URL(best.url).hostname} (${best.fields.length} fields)`);
    let plan;
    try { plan = await gemJson(AGENT_RULES, "CANDIDATE DATA:\n" + JSON.stringify(ctx).slice(0, 24000) + "\n\nEARLIER STEPS:\n" + JSON.stringify(hist.slice(-6)) + "\n\nPAGE NOW:\n" + JSON.stringify(best).slice(0, 24000), 4096); }
    catch (e) { return { status: "error", reason: "ai", detail: String(e.message || e).slice(0, 160), hist, usedPw }; }
    plan = plan || {};
    if (plan.status === "submitted" && /thank|received|submitted|success|on its way|complete/i.test(best.text)) return { status: "submitted", hist, usedPw };
    if (plan.status === "blocked") return { status: "blocked", reason: /login|password|sign/i.test(plan.note || "") ? "login" : /captcha/i.test(plan.note || "") ? "captcha" : "blocked", detail: plan.note || "the site needs a person here", hist, usedPw };
    if (plan.status === "verify_email") {
      const r = await waitMail("link", new URL(best.url).hostname, t0, P, Math.min(89, 51 + round * 2));
      if (!r.link) return { status: "blocked", reason: "email", detail: r.error ? "couldn't read your Gmail (" + r.error + ")" : `the account verification email didn't arrive${MAIL_OWNER ? ` in ${MAIL_OWNER}` : ""}`, hist, usedPw };
      hist.push({ step: round, filled: [], clicked: "opened the verification link from your email", note: r.subject || "" });
      await page.goto(r.link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}); await page.waitForTimeout(4000);
      if (lastFormUrl && opts.target) await page.goto(opts.target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      ctx.siteAccount && (ctx.siteAccount.existing = true); await page.waitForTimeout(3000); continue;
    }
    if (plan.status === "email_code" && plan.codeField) {
      const r = await waitMail("code", new URL(best.url).hostname, t0, P, Math.min(89, 51 + round * 2));
      if (!r.code) return { status: "blocked", reason: "email", detail: r.error ? "couldn't read your Gmail (" + r.error + ")" : `the verification code email didn't arrive${MAIL_OWNER ? ` in ${MAIL_OWNER}` : ""}`, hist, usedPw };
      plan.fill = (plan.fill || []).filter((x) => x.id !== plan.codeField).concat([{ id: plan.codeField, value: r.code }]);
    }
    for (const q of plan.ask || []) { const fd = best.fields.find((x) => x.id === q.id); if (fd && !fd.value) asks.set(fd.label, { q: fd.label, type: fd.options ? "choice" : fd.type === "textarea" ? "long" : "short", options: fd.options || [], maxLength: fd.maxLength || 0 }); }
    if (!(plan.fill || []).length && !plan.click) return { status: asks.size ? "ask" : "stuck", reason: asks.size ? "ask" : "form", ask: [...asks.values()], detail: plan.note || "", hist, usedPw };
    if ((plan.fill || []).some((x) => (best.fields.find((y) => y.id === x.id) || {}).type === "password")) { usedPw = true; if (opts.onPassword) await opts.onPassword(); }
    const res = await actPlan(bf, plan, best, opts.task || { files: [] });
    hist.push({ step: round, filled: (plan.fill || []).map((x) => { const fd = best.fields.find((y) => y.id === x.id); return (fd ? fd.label.slice(0, 80) : x.id) + " = " + (fd && fd.type === "password" ? "••••••" : String(x.value).slice(0, 80)); }), clicked: res.clicked, note: plan.note || "" });
    await P(Math.min(90, 51 + round * 2), `AI agent · step ${round}: filled ${res.filled}${res.clicked ? ` · clicked “${res.clicked}”` : ""}`);
    await page.waitForTimeout(3500);
  }
  return { status: "stuck", reason: "form", detail: "the application has too many steps", ask: [...asks.values()], hist, usedPw };
}
/* ---------- AI answers for questions the filler couldn't answer (free Gemini key, GitHub secret GEMINI_API_KEY) ---------- */
const GEMINI = process.env.GEMINI_API_KEY || "";
/* Secure channel to your Apps Script backend (shared secret from update-runner.sh): AI with your backend keys, Gmail codes, link resolving. */
const RUNNER_SECRET = process.env.APPLYRA_RUNNER_SECRET || "";
let API_URL = process.env.API_URL || "";
async function backend(fn, data) {
  if (!RUNNER_SECRET) throw new Error("robot channel not set up — run update-runner.sh");
  if (!API_URL) { const c = (await db.doc("config/public").get()).data() || {}; API_URL = c.apiUrl || ""; }
  if (!API_URL) throw new Error("backend URL missing");
  const r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ fn, runner: RUNNER_SECRET, data }), redirect: "follow" });
  const j = await r.json().catch(() => ({ error: "backend replied " + r.status }));
  if (j.error) throw new Error(j.error);
  return j.data;
}
const ATS_RE = [["greenhouse", /greenhouse\.io/], ["lever", /lever\.co/], ["ashby", /ashbyhq\.com/], ["workable", /workable\.com/], ["smartrecruiters", /smartrecruiters\.com/], ["workday", /myworkdayjobs\.com|workday\.com/],
  ["linkedin", /linkedin\.com/], ["naukri", /naukri\.com/], ["indeed", /indeed\./], ["icims", /icims\.com/], ["taleo", /taleo\.net/], ["successfactors", /successfactors|sapsf/], ["oracle", /oraclecloud\.com/],
  ["bamboohr", /bamboohr\.com/], ["recruitee", /recruitee\.com/], ["teamtailor", /teamtailor\.com/], ["jobvite", /jobvite\.com/], ["zoho", /zohorecruit/], ["darwinbox", /darwinbox/], ["keka", /keka\.com/]];
const atsOf = (u) => (ATS_RE.find(([, re]) => re.test(String(u || "").toLowerCase())) || ["other"])[0];
function liApplyUrl(html) {
  const m = String(html || "").match(/id=["']applyUrl["'][^>]*>\s*<!--\s*"([^"]+)"/); if (!m) return "";
  const raw = m[1].replace(/&amp;/g, "&"), u = raw.match(/[?&]url=([^&]+)/);
  try { const d = u ? decodeURIComponent(u[1]) : raw; return /^https?:\/\//.test(d) && !/linkedin\.com/.test(d) ? d : ""; } catch (e) { return ""; }
}
/* The company's own application page behind a LinkedIn / Naukri listing ("" = LinkedIn Easy Apply / Naukri-only apply). */
async function resolveApply(job) {
  if (job.applyUrl) return job.applyUrl;
  const u = String(job.url || ""); let m;
  if ((m = u.match(/linkedin\.com\/.*?(?:jobs\/view\/(?:[^\/?#]*-)?|currentJobId=)(\d{6,})/))) {
    try { const h = await (await fetch("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/" + m[1], { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9" } })).text();
      const x = liApplyUrl(h); if (x) return x; if (h.length > 3000 && /top-card-layout/.test(h)) return ""; } catch (e) {}
  }
  try { const r = await backend("runnerResolve", { url: u }); return (r && r.url) || ""; } catch (e) { return ""; }
}
/* One account per employer career site (Workday tenants, iCIMS, Taleo…), kept in your private vault in Firestore. */
async function siteAccount(userRef, host, email) {
  const key = host.replace(/[^a-z0-9]+/gi, "_").slice(0, 120), vref = userRef.collection("vault").doc(key);
  const s = await vref.get(); if (s.exists && s.data().password) return { ref: vref, email: s.data().email || email, password: s.data().password, existing: !!s.data().created, saved: true };
  const pw = "Ap" + crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "x") + "7!";
  // saved to your vault the moment the robot first types it into the site (so a new login is never lost)
  return { ref: vref, email, password: pw, existing: false, saved: false, save: () => vref.set({ host, email, password: pw, createdAt: Date.now(), created: false, note: "Made by the Applyra cloud robot for job applications on this site." }) };
}
const AI_RULES = `You fill in job application questions for the candidate, in first person.
Rules:
1. Facts (years of experience, tools, certifications, degrees, employers, salary/CTC, notice period, visa/work authorisation, criminal or legal history, relatives at the company) come ONLY from the candidate data given. If the fact needed is not there, answer exactly "UNKNOWN". Never invent.
2. "Years of experience in X": count from the dated roles where X clearly applies; otherwise use total years only if X is the candidate's core field; else "UNKNOWN".
3. Willingness questions (travel, office days, shifts, start date, relocation, background check, assessments): answer from the candidate's stated preferences; if they don't cover it, answer "Yes" for reasonable conditions of this job, but follow the preferences when they contradict.
4. Choice questions: reply with exactly one of the given options, copied verbatim. Diversity / EEO questions: choose the "prefer not to say"/"decline" option if present.
5. Free-text questions: specific to this company and role, plain text, under 120 words (respect maxLength), built only from the candidate's real experience.
Reply ONLY with JSON: {"answers":[{"q":"question exactly as given","a":"answer or UNKNOWN","basis":"profile|preference|unknown"}]}`;
const GEM_BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com";
async function aiAnswers(questions, ctx) {
  return (await gemJson(AI_RULES, "CANDIDATE DATA:\n" + JSON.stringify(ctx).slice(0, 30000) + "\n\nQUESTIONS:\n" + JSON.stringify(questions))).answers || [];
}
async function gemJson(system, text, maxTok = 4096) {
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: maxTok } };
  let last = "";
  for (const m of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
    let r = null, d = {};
    if (!GEMINI && !process.env.GEMINI_API_KEY_2) { last = "no Gemini key on the runner"; break; }
    for (const key of [GEMINI, process.env.GEMINI_API_KEY_2].filter(Boolean)) { // second key when the first is out of quota
      r = await fetch(`${GEM_BASE}/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
      d = await r.json().catch(() => ({}));
      if (r.status !== 429) break;
    }
    if (!r.ok) { last = (d.error && d.error.message) || String(r.status); continue; }
    const t = ((((d.candidates || [])[0] || {}).content || {}).parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch (e) { last = "unreadable AI answer"; }
  }
  if (RUNNER_SECRET) { try { return await backend("runnerAi", { system, text, maxTok }); } catch (e) { last += (last ? " · " : "") + "backend: " + String(e.message || e).slice(0, 120); } }
  throw new Error("AI: " + (last || "no Gemini key on the runner"));
}
const results = async (page) => (await Promise.all(page.frames().map((f) => f.evaluate(() => window.__applyraResults || []).catch(() => [])))).flat().filter(Boolean);

/* Live progress for the app: 0–100 + a short log, written at most every 3 s (keeps Firestore writes low). */
function progressWriter(ref) {
  let log = [], last = 0, pct = 0, pending = null, timer = null;
  const flush = async () => { timer = null; if (!pending) return; const p = pending; pending = null; last = Date.now();
    await ref.set({ progress: { pct: p.pct, text: p.text, at: Date.now(), where: "cloud" }, progressLog: log.slice(-14) }, { merge: true }).catch(() => {}); };
  return (p, text, force) => {
    pct = Math.max(pct, Math.min(100, Math.round(p))); const entry = { pct, text: String(text || "").slice(0, 160), at: Date.now() };
    if (!log.length || log[log.length - 1].text !== entry.text) log.push(entry);
    pending = entry;
    if (force || Date.now() - last > 3000) return flush();
    if (!timer) timer = setTimeout(flush, 3000 - (Date.now() - last));
  };
}
const outbox = (ref, kind, job, detail) => db.doc("meta/outbox").set({ items: FV.arrayUnion({ uid: ref.parent.parent.id, kind, title: job.title || "", company: job.company || "", detail: String(detail || "").slice(0, 300), at: Date.now() }) }, { merge: true }).catch(() => {});
const status = async (ref, s, extra = {}) => ref.set({ status: s, updatedAt: Date.now(), stages: FV.arrayUnion({ s, at: Date.now() }), ...extra }, { merge: true });

let done = 0, review = 0;
for (const d of queued.docs) {
  const ref = d.ref;
  const claimed = await db.runTransaction(async (t) => { const s = await t.get(ref); if (!s.exists || s.data().status !== "queued") return false; t.update(ref, { status: "applying", updatedAt: Date.now() }); return true; });
  if (!claimed) continue;
  const a = d.data(); let job = { ...(a.job || {}) };
  const P = progressWriter(ref), jobStart = Date.now();
  await P(2, "Robot picked up your application", true);
  try {
    if (!a.pack) { await status(ref, "needs_review", { stopReason: "kit", extDetail: "No tailored kit yet — open it in the app and tap Apply again." }); review++; continue; }
    // LinkedIn / Naukri listings: apply on the company's own site behind them
    if (["linkedin", "naukri", "indeed"].includes(job.ats)) {
      await P(4, `Finding the company application behind this ${job.via || job.ats} listing`);
      const real = job.ats === "indeed" ? (job.applyUrl || "") : await resolveApply(job);
      if (!real || ["linkedin", "naukri", "indeed"].includes(atsOf(real))) {
        const why = job.ats === "linkedin" ? "This is a LinkedIn Easy Apply job — LinkedIn only accepts Easy Apply from your own logged-in LinkedIn (accounts that use robots get restricted). Your tailored resume and every answer are ready: tap “Easy Apply with answers ready”."
          : job.ats === "naukri" ? "This job is applied on Naukri itself (no company site behind it). Naukri flags robot applies, so tap “Apply on Naukri with answers ready” — it takes one tap." : "Indeed blocks robots. Tap “Open on Indeed” — your resume and answers are ready.";
        await status(ref, "needs_review", { stopReason: "portal", portal: true, extDetail: why, progress: { pct: 100, text: "Ready for your one tap on " + (job.via || job.ats), at: Date.now(), where: "cloud" } });
        outbox(ref, "input", job, why); review++; continue;
      }
      await P(6, "Company application found on " + new URL(real).hostname);
      job = { ...job, listingUrl: job.url, url: real, ats: atsOf(real) };
      await ref.set({ formUrl: real, job: { ...(a.job || {}), applyUrl: real } }, { merge: true }).catch(() => {});
    }
    const user = (await ref.parent.parent.get()).data() || {};
    const profile = user.profile || {};
    await P(5, "Building your tailored resume and cover letter PDFs");
    const files = await pdfPage.evaluate(async (x) => window.makeFiles(x.profile, x.override, x.tid, x.letter, x.job),
      { profile, override: a.pack.resume, tid: a.templateId || (user.settings || {}).applyTemplateId || "meridian", letter: a.pack.coverLetter, job: { title: job.title, company: job.company } });
    const base = slug(profile.name || "Resume");
    const extra = { ...((await ref.parent.parent.get()).data() || {}).learned }; (a.formAnswers || []).forEach((x) => { if (x && x.q && x.a) extra[x.q] = x.a; });
    const task = { extra, taskId: d.id, url: job.url, ats: job.ats, company: job.company, title: job.title, location: job.location || "", autoSubmit: true, submitAny: true, background: true,
      profile: flatProfile(files.R, user.screening), coverLetter: a.pack.coverLetter, answers: { ...(a.pack.screening || {}), recruiterNote: a.pack.recruiterNote },
      files: [{ role: "resume", name: `${base}_Resume.pdf`, type: "application/pdf", data: files.resume }, { role: "cover", name: `${base}_Cover_Letter_${slug(job.company)}.pdf`, type: "application/pdf", data: files.letter }] };
    const stub = `({ runtime: { lastError: null, getURL: () => "", getManifest: () => ({ version: "cloud" }), onMessage: { addListener() {} },
      sendMessage: (m, cb) => { if (m && m.type === "progress") { (window.__applyraProgress = window.__applyraProgress || []).push(m.payload); cb && cb({}); return; } if (m && (m.type === "needInput" || m.type === "learned")) { cb && cb({}); return; } if (m && m.type === "aiAsk") { (window.__applyraAI ? window.__applyraAI(m.payload) : Promise.resolve({})).then((a) => cb && cb({ answers: a || {} })).catch(() => cb && cb({ answers: {} })); return; } if (m && m.type === "getTask") cb && cb({ task: ${JSON.stringify(task)}, profile: {} }); else { (window.__applyraResults = window.__applyraResults || []).push(m && m.payload); try { window.__applyraReport && window.__applyraReport(m && m.payload); } catch (e) {} cb && cb({}); } } } })`;
    const ctx = await browser.newContext({ userAgent: UA, locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript({ content: `(function (chrome) { const go = () => { ${FILLER} }; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go(); })(${stub});` });
    // Page-by-page AI answers for multi-step forms (same rules as below: facts only from your profile).
    await ctx.exposeBinding("__applyraAI", async (_src, payload) => {
      if (!AI_OK()) return {};
      try {
        const ans = await aiAnswers((payload && payload.questions) || [], { profile: files.R, standardAnswers: user.screening || {}, preferences: { modes: (user.prefs || {}).modes, locations: (user.prefs || {}).locations },
          job: { title: job.title, company: job.company, location: job.location }, tailoredScreening: (a.pack || {}).screening || {} });
        const map = {}; ans.forEach((x) => { if (x && x.q && x.a && !/^unknown$/i.test(String(x.a).trim())) map[x.q] = String(x.a); });
        return map;
      } catch (e) { return {}; }
    });
    // Results go straight to the robot too, so a "submitted" report survives the jump to the thank-you page.
    const kept = [];
    await ctx.exposeBinding("__applyraReport", async (_src, payload) => { if (payload) kept.push(payload); return true; });
    const page = await ctx.newPage();
    const target = await formUrl(job);
    await P(7, "Opening " + new URL(target).hostname);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    let result = null, filledAt = 0, lastAct = Date.now(), seen = 0;
    for (let i = 0; i < 150 && !result; i++) { // up to ~5 min: multi-page forms
      await page.waitForTimeout(2000);
      const pr = (await Promise.all(page.frames().map((f) => f.evaluate(() => { const x = window.__applyraProgress || []; window.__applyraProgress = []; return x; }).catch(() => [])))).flat().filter(Boolean);
      for (const x of pr) await P(x.pct, x.text);
      if (pr.length) { filledAt = 0; lastAct = Date.now(); } // still moving through pages — don't treat an earlier page's report as final
      const all = kept.concat((await Promise.all(page.frames().map((f) => f.evaluate(() => window.__applyraResults || []).catch(() => [])))).flat().filter(Boolean));
      const sub = all.find((r) => r.status === "submitted"); if (sub) { result = sub; break; }
      const filled = all.filter((r) => r.status === "filled" || r.status === "failed").pop();
      if (all.length !== seen) { seen = all.length; lastAct = Date.now(); }
      if (filled) { if (!filledAt) filledAt = Date.now(); else if (Date.now() - filledAt > 12000) result = filled; }
      if (!result && Date.now() - lastAct > 25000) break; // nothing happening for 25 s — hand over to the AI agent
    }
    /* AI step: answer the remaining questions, re-fill and submit */
    let aiNote = "", aiLog = null;
    const aiOn = a.aiRetry || ((user.settings || {}).autoApply || {}).aiFill !== false;
    if (aiOn && result && result.status === "filled" && (result.missing || []).length) {
      if (!AI_OK()) aiNote = " (AI fill isn't switched on for the runner yet — run update-runner.sh)";
      else {
        try {
          const ctx = { profile: files.R, standardAnswers: user.screening || {}, preferences: { modes: (user.prefs || {}).modes, locations: (user.prefs || {}).locations, overseas: (user.prefs || {}).overseas },
            job: { title: job.title, company: job.company, location: job.location }, tailoredScreening: a.pack.screening || {} };
          const ans = await aiAnswers(result.missing, ctx);
          const map = {}, unknown = [];
          result.missing.forEach((m) => { const x = ans.find((y) => y.q === m.q) || ans.find((y) => String(y.q).toLowerCase().trim() === m.q); if (x && x.a && !/^unknown$/i.test(String(x.a).trim())) map[m.q] = m.maxLength ? String(x.a).slice(0, m.maxLength) : String(x.a); else unknown.push(m.q); });
          aiLog = Object.entries(map).map(([q, v]) => ({ q, a: v }));
          if (Object.keys(map).length) await P(86, `AI answered ${Object.keys(map).length} remaining question(s) — filling them in`);
          if (Object.keys(map).length) {
            const before = (await results(page)).length;
            await Promise.all(page.frames().map((f) => f.evaluate((m) => { window.__applyraExtra = Object.assign(window.__applyraExtra || {}, m); if (window.__applyraRun) window.__applyraRun(); }, map).catch(() => {})));
            let next = null;
            for (let i = 0; i < 45 && !next; i++) {
              await page.waitForTimeout(2000);
              const all = await results(page), fresh = all.slice(before);
              const sub = kept.concat(all).find((r) => r.status === "submitted"); if (sub) { next = sub; break; }
              if (i > 20 && fresh.length) next = fresh[fresh.length - 1];
            }
            if (next) result = next;
          }
          if (unknown.length && (!result || result.status !== "submitted")) aiNote = ` — AI couldn't answer from your profile: ${unknown.map((q) => `"${q}"`).join(", ")}`;
        } catch (e) { aiNote = ` (AI step failed: ${String(e.message || e).slice(0, 120)})`; }
      }
    }
    let diag = null;
    if (!result) diag = await diagnose(page);
    let agentLog = null;
    const accountsOn = ((user.settings || {}).autoApply || {}).accounts !== false;
    let account = null, agentReason = "";
    if ((!result || result.status !== "submitted") && !(diag && diag.closed) && !(result && result.auth && !accountsOn)) {
      if (!AI_OK()) aiNote = " (the AI agent needs your Gemini key on the runner — run update-runner.sh)";
      else {
        await P(50, "AI agent taking over to finish the application");
        const host = (() => { try { return new URL(page.url()).hostname; } catch (e) { return new URL(target).hostname; } })();
        if (accountsOn && !/linkedin|google|naukri|indeed|facebook/.test(host)) account = await siteAccount(ref.parent.parent, host, files.R.email || profile.email).catch(() => null);
        const ag = await aiAgent(page, { siteAccount: account ? { email: account.email, password: account.password, existing: account.existing } : undefined, profile: files.R, standardAnswers: user.screening || {}, learnedAnswers: user.learned || {}, formAnswers: a.formAnswers || [], preferences: { modes: (user.prefs || {}).modes, locations: (user.prefs || {}).locations, overseas: (user.prefs || {}).overseas },
          job: { title: job.title, company: job.company, location: job.location }, tailoredScreening: (a.pack || {}).screening || {}, coverLetter: String((a.pack || {}).coverLetter || "").slice(0, 2500) }, P, kept, { task, target, since: jobStart, onPassword: async () => { if (account && !account.saved && account.save) { account.saved = true; await account.save().catch(() => {}); } } });
        agentLog = ag.hist || []; agentReason = ag.reason || "";
        if (account && ag.usedPw) await account.ref.set({ created: true, lastUsed: Date.now(), lastJob: `${job.title} @ ${job.company}` }, { merge: true }).catch(() => {});
        if (ag.status === "submitted") { result = { status: "submitted" }; diag = null; }
        else if (ag.status === "captcha" || ag.reason === "captcha") result = { status: "filled", captcha: true, missing: [] };
        else if (ag.status === "ask" || (ag.ask || []).length) result = { status: "filled", detail: `needs your answer to ${(ag.ask || []).length} question(s) the AI can't answer truthfully from your profile`, missing: ag.ask || [] };
        else result = { status: "filled", detail: ag.detail || (result && result.detail) || "the site didn't confirm the submission", missing: (result && result.missing) || [] };
        if (diag && !diag.closed) diag = null;
      }
    }
    let shot = "";
    if (!result || result.status !== "submitted") { try { shot = "data:image/jpeg;base64," + (await page.screenshot({ type: "jpeg", quality: 40 })).toString("base64"); } catch (e) {} }
    const why = ((result && result.detail) || (diag && diag.detail) || "the site didn't confirm the submission") + aiNote;
    await P(result && result.status === "submitted" ? 100 : 95, result && result.status === "submitted" ? "Submitted ✓ — the site confirmed your application" : "Stopped: " + why.slice(0, 120), true);
    console.log(`• ${job.title} @ ${job.company} [${job.ats}] ${target} → ${result && result.status === "submitted" ? "APPLIED" : "needs review: " + why}`);
    if (result && result.status === "submitted") { await status(ref, "applied", { agentLog: (agentLog || []).slice(-14), appliedAt: Date.now(), method: (aiLog && aiLog.length) || (agentLog && agentLog.length) ? "cloud-auto+ai" : "cloud-auto", extDetail: aiLog && aiLog.length ? `Submitted from the cloud. AI answered ${aiLog.length} question(s) — see below.` : "Submitted automatically from the cloud.", aiAnswers: aiLog || [], aiRetry: false }); outbox(ref, "applied", job); done++; }
    else if (diag && diag.closed) { await status(ref, "skipped", { stopReason: "closed", extDetail: `Cloud apply: ${why}.` }); review++; }
    else if (result && result.captcha) { await status(ref, "needs_review", { stopReason: "captcha", extDetail: "Everything is filled in, but the site asks a human to tick a captcha. Tap “Open & pre-fill form” (laptop) or “AI answers for this form → Open form & autofill” (phone), tick the captcha, and Applyra submits.", formUrl: target, robotShot: shot.length < 700000 ? shot : "", robotShotAt: Date.now(), aiAnswers: aiLog || [], aiRetry: false, openQuestions: [] }); outbox(ref, "captcha", job, "tick the captcha"); review++; }
    else { await status(ref, "needs_review", { stopReason: agentReason || ((result && (result.missing || []).length) ? "ask" : result && result.auth ? "login" : "form"), agentLog: (agentLog || []).slice(-14), extDetail: `Cloud apply stopped: ${why}. Open it to finish.`, formUrl: target, robotShot: shot.length < 700000 ? shot : "", robotShotAt: Date.now(), aiAnswers: aiLog || [], aiRetry: false, openQuestions: ((result && result.missing) || []).map((m) => m.q), openQuestionsDet: ((result && result.missing) || []).slice(0, 12) }); outbox(ref, "input", job, why); review++; }
    await ctx.close();
  } catch (e) {
    console.log(`• ${job.title} @ ${job.company} → error: ${quotaMsg(e)}`);
    const transient = /timeout|net::ERR|Target (page|closed)|ECONNRESET|ETIMEDOUT|socket hang up|503|502|Navigation failed/i.test(String(e && e.message || e));
    if (transient && (a.retries || 0) < 2) { await status(ref, "queued", { retries: (a.retries || 0) + 1, extDetail: "Retrying after a network hiccup", progress: { pct: 1, text: "Network hiccup — retrying on the next run", at: Date.now(), where: "cloud" } }).catch(() => {}); continue; }
    await P(95, "Stopped: " + String(e.message || e).slice(0, 120), true);
    await status(ref, "needs_review", { stopReason: "error", extDetail: `Cloud apply error: ${quotaMsg(e)}` }).catch(() => {}); review++;
  }
}
await db.doc("meta/status").set({ lastRunner: Date.now(), lastRunnerApplied: done, lastRunnerReview: review }, { merge: true });
console.log(`Applied ${done}, needs review ${review}`);
await browser.close();
process.exit(0);
