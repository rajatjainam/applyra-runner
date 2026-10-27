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
    const task = { taskId: d.id, url: job.url, ats: job.ats, company: job.company, title: job.title, location: job.location || "", autoSubmit: true, background: true,
      profile: flatProfile(files.R, user.screening), coverLetter: a.pack.coverLetter, answers: { ...(a.pack.screening || {}), recruiterNote: a.pack.recruiterNote },
      files: [{ role: "resume", name: `${base}_Resume.pdf`, type: "application/pdf", data: files.resume }, { role: "cover", name: `${base}_Cover_Letter_${slug(job.company)}.pdf`, type: "application/pdf", data: files.letter }] };
    const stub = `({ runtime: { lastError: null, getURL: () => "", getManifest: () => ({ version: "cloud" }), onMessage: { addListener() {} },
      sendMessage: (m, cb) => { if (m && m.type === "getTask") cb && cb({ task: ${JSON.stringify(task)}, profile: {} }); else { (window.__applyraResults = window.__applyraResults || []).push(m && m.payload); cb && cb({}); } } } })`;
    const ctx = await browser.newContext({ userAgent: UA, locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript({ content: `(function (chrome) { const go = () => { ${FILLER} }; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go(); })(${stub});` });
    const page = await ctx.newPage();
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    let result = null, filledAt = 0;
    for (let i = 0; i < 75 && !result; i++) {
      await page.waitForTimeout(2000);
      const all = (await Promise.all(page.frames().map((f) => f.evaluate(() => window.__applyraResults || []).catch(() => [])))).flat().filter(Boolean);
      const sub = all.find((r) => r.status === "submitted"); if (sub) { result = sub; break; }
      const filled = all.filter((r) => r.status === "filled" || r.status === "failed").pop();
      if (filled) { if (!filledAt) filledAt = Date.now(); else if (Date.now() - filledAt > 30000) result = filled; }
    }
    console.log(`• ${job.title} @ ${job.company} [${job.ats}] → ${result && result.status === "submitted" ? "APPLIED" : "needs review: " + ((result && result.detail) || "no confirmation page")}`);
    if (result && result.status === "submitted") { await status(ref, "applied", { appliedAt: Date.now(), method: "cloud-auto", extDetail: "Submitted automatically from the cloud." }); done++; }
    else { await status(ref, "needs_review", { extDetail: `Cloud apply stopped: ${(result && result.detail) || "the form didn't confirm submission"}. Open it to finish.` }); review++; }
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
