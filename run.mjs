/* Applyra cloud runner — submits queued applications from GitHub's servers, so auto-apply works from a phone.
   For each application with status "queued": builds the tailored resume + cover letter PDFs (same designs as the app),
   opens the job form in Chromium, fills it with the same filler as the Chrome extension, and submits on supported forms.
   Anything it can't finish (captcha, unknown required question, login wall) goes to "Needs your review" in the app. */
import admin from "firebase-admin";
import fs from "fs";

const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
if (!sa.project_id) { console.error("FIREBASE_SA secret missing"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const MAX = Number(process.env.MAX_PER_RUN || 8);
const AUTOSUBMIT = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "teamtailor", "bamboohr"];

const queued = await db.collectionGroup("applications").where("status", "==", "queued").limit(MAX).get();
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
/* ---------- AI answers for questions the filler couldn't answer (free Gemini key, GitHub secret GEMINI_API_KEY) ---------- */
const GEMINI = process.env.GEMINI_API_KEY || "";
const AI_RULES = `You fill in job application questions for the candidate, in first person.
Rules:
1. Facts (years of experience, tools, certifications, degrees, employers, salary/CTC, notice period, visa/work authorisation, criminal or legal history, relatives at the company) come ONLY from the candidate data given. If the fact needed is not there, answer exactly "UNKNOWN". Never invent.
2. "Years of experience in X": count from the dated roles where X clearly applies; otherwise use total years only if X is the candidate's core field; else "UNKNOWN".
3. Willingness questions (travel, office days, shifts, start date, relocation, background check, assessments): answer from the candidate's stated preferences; if they don't cover it, answer "Yes" for reasonable conditions of this job, but follow the preferences when they contradict.
4. Choice questions: reply with exactly one of the given options, copied verbatim. Diversity / EEO questions: choose the "prefer not to say"/"decline" option if present.
5. Free-text questions: specific to this company and role, plain text, under 120 words (respect maxLength), built only from the candidate's real experience.
Reply ONLY with JSON: {"answers":[{"q":"question exactly as given","a":"answer or UNKNOWN","basis":"profile|preference|unknown"}]}`;
async function aiAnswers(questions, ctx) {
  const body = { systemInstruction: { parts: [{ text: AI_RULES }] }, contents: [{ role: "user", parts: [{ text: "CANDIDATE DATA:\n" + JSON.stringify(ctx).slice(0, 30000) + "\n\nQUESTIONS:\n" + JSON.stringify(questions) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 } };
  let last = "";
  for (const m of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { last = (d.error && d.error.message) || String(r.status); continue; }
    const t = ((((d.candidates || [])[0] || {}).content || {}).parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    try { return (JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)).answers || []); } catch (e) { last = "unreadable AI answer"; }
  }
  throw new Error("AI: " + last);
}
const results = async (page) => (await Promise.all(page.frames().map((f) => f.evaluate(() => window.__applyraResults || []).catch(() => [])))).flat().filter(Boolean);

const status = async (ref, s, extra = {}) => ref.set({ status: s, updatedAt: Date.now(), stages: FV.arrayUnion({ s, at: Date.now() }), ...extra }, { merge: true });

let done = 0, review = 0;
for (const d of queued.docs) {
  const ref = d.ref;
  const claimed = await db.runTransaction(async (t) => { const s = await t.get(ref); if (!s.exists || s.data().status !== "queued") return false; t.update(ref, { status: "applying", updatedAt: Date.now() }); return true; });
  if (!claimed) continue;
  const a = d.data(), job = a.job || {};
  try {
    if (!AUTOSUBMIT.includes(job.ats) || !a.pack) { await status(ref, "needs_review", { extDetail: "This form needs you (not a one-click form). Open it from the app." }); review++; continue; }
    const user = (await ref.parent.parent.get()).data() || {};
    const profile = user.profile || {};
    const files = await pdfPage.evaluate(async (x) => window.makeFiles(x.profile, x.override, x.tid, x.letter, x.job),
      { profile, override: a.pack.resume, tid: a.templateId || (user.settings || {}).applyTemplateId || "meridian", letter: a.pack.coverLetter, job: { title: job.title, company: job.company } });
    const base = slug(profile.name || "Resume");
    const extra = {}; (a.formAnswers || []).forEach((x) => { if (x && x.q && x.a) extra[x.q] = x.a; });
    const task = { extra, taskId: d.id, url: job.url, ats: job.ats, company: job.company, title: job.title, location: job.location || "", autoSubmit: true, background: true,
      profile: flatProfile(files.R, user.screening), coverLetter: a.pack.coverLetter, answers: { ...(a.pack.screening || {}), recruiterNote: a.pack.recruiterNote },
      files: [{ role: "resume", name: `${base}_Resume.pdf`, type: "application/pdf", data: files.resume }, { role: "cover", name: `${base}_Cover_Letter_${slug(job.company)}.pdf`, type: "application/pdf", data: files.letter }] };
    const stub = `({ runtime: { lastError: null, getURL: () => "", getManifest: () => ({ version: "cloud" }), onMessage: { addListener() {} },
      sendMessage: (m, cb) => { if (m && m.type === "getTask") cb && cb({ task: ${JSON.stringify(task)}, profile: {} }); else { (window.__applyraResults = window.__applyraResults || []).push(m && m.payload); cb && cb({}); } } } })`;
    const ctx = await browser.newContext({ userAgent: UA, locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript({ content: `(function (chrome) { const go = () => { ${FILLER} }; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go(); })(${stub});` });
    const page = await ctx.newPage();
    const target = await formUrl(job);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    let result = null, filledAt = 0;
    for (let i = 0; i < 75 && !result; i++) {
      await page.waitForTimeout(2000);
      const all = (await Promise.all(page.frames().map((f) => f.evaluate(() => window.__applyraResults || []).catch(() => [])))).flat().filter(Boolean);
      const sub = all.find((r) => r.status === "submitted"); if (sub) { result = sub; break; }
      const filled = all.filter((r) => r.status === "filled" || r.status === "failed").pop();
      if (filled) { if (!filledAt) filledAt = Date.now(); else if (Date.now() - filledAt > 30000) result = filled; }
    }
    /* AI step: answer the remaining questions, re-fill and submit */
    let aiNote = "", aiLog = null;
    const aiOn = a.aiRetry || ((user.settings || {}).autoApply || {}).aiFill !== false;
    if (aiOn && result && result.status === "filled" && (result.missing || []).length) {
      if (!GEMINI) aiNote = " (AI fill isn't switched on for the runner yet — run update-runner.sh and paste your Gemini key)";
      else {
        try {
          const ctx = { profile: files.R, standardAnswers: user.screening || {}, preferences: { modes: (user.prefs || {}).modes, locations: (user.prefs || {}).locations, overseas: (user.prefs || {}).overseas },
            job: { title: job.title, company: job.company, location: job.location }, tailoredScreening: a.pack.screening || {} };
          const ans = await aiAnswers(result.missing, ctx);
          const map = {}, unknown = [];
          result.missing.forEach((m) => { const x = ans.find((y) => y.q === m.q) || ans.find((y) => String(y.q).toLowerCase().trim() === m.q); if (x && x.a && !/^unknown$/i.test(String(x.a).trim())) map[m.q] = m.maxLength ? String(x.a).slice(0, m.maxLength) : String(x.a); else unknown.push(m.q); });
          aiLog = Object.entries(map).map(([q, v]) => ({ q, a: v }));
          if (Object.keys(map).length) {
            const before = (await results(page)).length;
            await Promise.all(page.frames().map((f) => f.evaluate((m) => { window.__applyraExtra = Object.assign(window.__applyraExtra || {}, m); if (window.__applyraRun) window.__applyraRun(); }, map).catch(() => {})));
            let next = null;
            for (let i = 0; i < 45 && !next; i++) {
              await page.waitForTimeout(2000);
              const all = await results(page), fresh = all.slice(before);
              const sub = all.find((r) => r.status === "submitted"); if (sub) { next = sub; break; }
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
    let shot = "";
    if (!result || result.status !== "submitted") { try { shot = "data:image/jpeg;base64," + (await page.screenshot({ type: "jpeg", quality: 40 })).toString("base64"); } catch (e) {} }
    const why = ((result && result.detail) || (diag && diag.detail) || "the site didn't confirm the submission") + aiNote;
    console.log(`• ${job.title} @ ${job.company} [${job.ats}] ${target} → ${result && result.status === "submitted" ? "APPLIED" : "needs review: " + why}`);
    if (result && result.status === "submitted") { await status(ref, "applied", { appliedAt: Date.now(), method: aiLog && aiLog.length ? "cloud-auto+ai" : "cloud-auto", extDetail: aiLog && aiLog.length ? `Submitted from the cloud. AI answered ${aiLog.length} question(s) — see below.` : "Submitted automatically from the cloud.", aiAnswers: aiLog || [], aiRetry: false }); done++; }
    else if (diag && diag.closed) { await status(ref, "skipped", { extDetail: `Cloud apply: ${why}.` }); review++; }
    else if (result && result.captcha) { await status(ref, "needs_review", { extDetail: "Everything is filled in, but the site asks a human to tick a captcha. Tap “Open & pre-fill form” (laptop) or “AI answers for this form → Open form & autofill” (phone), tick the captcha, and Applyra submits.", formUrl: target, robotShot: shot.length < 700000 ? shot : "", robotShotAt: Date.now(), aiAnswers: aiLog || [], aiRetry: false, openQuestions: [] }); review++; }
    else { await status(ref, "needs_review", { extDetail: `Cloud apply stopped: ${why}. Open it to finish.`, formUrl: target, robotShot: shot.length < 700000 ? shot : "", robotShotAt: Date.now(), aiAnswers: aiLog || [], aiRetry: false, openQuestions: ((result && result.missing) || []).map((m) => m.q) }); review++; }
    await ctx.close();
  } catch (e) {
    console.log(`• ${job.title} @ ${job.company} → error: ${String(e.message || e).slice(0, 160)}`);
    await status(ref, "needs_review", { extDetail: `Cloud apply error: ${String(e.message || e).slice(0, 200)}` }); review++;
  }
}
await db.doc("meta/status").set({ lastRunner: Date.now(), lastRunnerApplied: done, lastRunnerReview: review }, { merge: true });
console.log(`Applied ${done}, needs review ${review}`);
await browser.close();
process.exit(0);
