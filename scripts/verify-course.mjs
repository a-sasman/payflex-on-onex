import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const mimeTypes = { ".css": "text/css", ".html": "text/html", ".jpg": "image/jpeg", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
const dist = path.resolve("dist");
let server;
let baseUrl = process.env.COURSE_URL;

if (!baseUrl) {
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      let target = path.resolve(dist, `.${pathname}`);
      if (!target.startsWith(dist + path.sep) && target !== dist) throw new Error("Invalid path");
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(target)] ?? "application/octet-stream" });
      response.end(await readFile(target));
    } catch { response.writeHead(404); response.end("Not found"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

const browser = await chromium.launch({ headless: true });
const errors = [];
const viewports = [
  { name: "desktop", width: 1440, height: 900 }, { name: "laptop", width: 1366, height: 768 },
  { name: "wide-small", width: 1200, height: 800 }, { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "tablet-small", width: 900, height: 900 }, { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "small-tablet", width: 600, height: 900 }, { name: "large-phone", width: 500, height: 900 },
  { name: "phone-430", width: 430, height: 932 }, { name: "phone-390", width: 390, height: 844 },
  { name: "phone-360", width: 360, height: 800 },
];

const monitor = (page, label) => {
  page.on("pageerror", (error) => errors.push(`${label} page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${label} console error: ${message.text()}`); });
  page.on("requestfailed", (request) => errors.push(`${label} request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
};

async function exerciseRequiredInteractions(page) {
  for (const check of await page.locator("knowledge-check").all()) {
    const correctId = await check.getAttribute("data-correct-id");
    await check.locator(`input[value="${correctId}"]`).check();
  }
  for (const card of await page.locator("product-sort .sort-card").all()) {
    const answer = await card.getAttribute("data-answer");
    await card.locator(`[data-choice="${answer}"]`).click();
  }
  for (let index = 0; index < 4; index += 1) {
    const part = page.locator(`branching-challenge [data-part="${index}"]`);
    await part.locator('[data-correct="true"]').click();
    await part.locator(".challenge-next").click();
  }
}

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 500 });
    const page = await context.newPage(); monitor(page, viewport.name);
    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    if (!response?.ok()) errors.push(`${viewport.name} returned HTTP ${response?.status() ?? "unknown"}`);
    if (await page.title() !== "Payflex on oneX") errors.push(`${viewport.name} has an incorrect title`);
    if (await page.locator("[data-progress-section]").count() !== 12) errors.push(`${viewport.name} does not render all 12 course sections`);
    if (await page.locator(".course-links a").count() !== 6) errors.push(`${viewport.name} does not render the production navigation`);
    const mainText = await page.locator("main").innerText();
    for (const expected of ["Welcome", "The oneX journey", "Five Rules", "Exclusions", "Returns", "When Payflex is missing", "Final challenge", "021 937 4499", "Well done. You can now apply the Payflex rules on oneX."]) {
      if (!mainText.includes(expected)) errors.push(`${viewport.name} is missing learner content: ${expected}`);
    }
    if (/\[[A-Z][A-Z\s-]+\]/.test(mainText)) errors.push(`${viewport.name} contains placeholder copy`);
    if (/Quick Course|Hypnos|Cotton Origins/i.test(mainText)) errors.push(`${viewport.name} contains previous-course identity`);
    if (await page.locator("rule-card-selector .rule-card").count() !== 5) errors.push(`${viewport.name} does not render five rules`);
    if (await page.locator("knowledge-check").count() !== 4 || await page.locator("knowledge-check input").count() !== 16) errors.push(`${viewport.name} does not render four four-option checks`);
    if (await page.locator('knowledge-check button[type="submit"]').count()) errors.push(`${viewport.name} knowledge checks still render submit controls`);
    if (await page.locator("product-sort .sort-card").count() !== 6) errors.push(`${viewport.name} does not render the allowed/excluded sort`);
    if (await page.locator("returns-journey, missing-step-reveal").count() !== 2) errors.push(`${viewport.name} is missing a journey or support steps`);
    if (await page.locator("missing-step-reveal .missing-step-list li").count() !== 4 || await page.locator("missing-step-reveal button").count()) errors.push(`${viewport.name} support steps are not fully visible as static content`);
    if (!(await page.locator("missing-step-reveal").innerText()).includes("2. Clear the cache in Settings")) errors.push(`${viewport.name} support step 2 is not visible`);
    if (await page.locator("branching-challenge .challenge-part").count() !== 4) errors.push(`${viewport.name} does not render four challenge stages`);
    const footerControl = page.locator(".return-button");
    const footerStyle = await footerControl.evaluate((button) => ({ color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }));
    if (await footerControl.locator("span").count() || footerStyle.color !== "rgb(255, 255, 255)" || footerStyle.background !== "rgba(0, 0, 0, 0)") errors.push(`${viewport.name} return footer is not plain white text`);
    if (!(await page.locator(".return-status").evaluate((status) => status.classList.contains("sr-only"))) || mainText.includes("Course requirements complete. You can return to People Connect.")) errors.push(`${viewport.name} renders the removed return status message`);
    const missingTargets = await page.evaluate(() => [...document.querySelectorAll('.course-links a[href^="#"]')].map((link) => link.getAttribute("href")).filter((href) => !href || !document.querySelector(href)));
    if (missingTargets.length) errors.push(`${viewport.name} has missing navigation targets: ${missingTargets.join(", ")}`);
    const unloadedImages = await page.locator("img").evaluateAll((images) => images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")));
    if (unloadedImages.length) errors.push(`${viewport.name} has unloaded images: ${unloadedImages.join(", ")}`);
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, clipped: [...document.querySelectorAll("[data-progress-section]")].filter((element) => element.scrollHeight > element.clientHeight + 2 && getComputedStyle(element).overflowY === "hidden").map((element) => element.id) }));
    if (layout.overflow) errors.push(`${viewport.name} has horizontal page overflow`);
    if (layout.clipped.length) errors.push(`${viewport.name} has clipped sections: ${layout.clipped.join(", ")}`);

    const firstRule = page.locator(".rule-card").first();
    if (viewport.width <= 500) await firstRule.tap(); else { await firstRule.focus(); await page.keyboard.press("Space"); }
    if (await firstRule.getAttribute("aria-pressed") !== "true") errors.push(`${viewport.name} cannot activate a rule card`);
    const firstCheck = page.locator("knowledge-check").first();
    await firstCheck.locator('input[value="a"]').check();
    if (!(await firstCheck.locator('input[value="a"]').evaluate((input) => input.closest("label")?.classList.contains("is-incorrect")))) errors.push(`${viewport.name} incorrect knowledge-check option was not marked`);
    if (await firstCheck.locator('input[value="b"]').evaluate((input) => input.closest("label")?.classList.contains("is-correct"))) errors.push(`${viewport.name} incorrect response revealed the correct knowledge-check option`);
    if (await firstCheck.locator(".knowledge-feedback").isVisible()) errors.push(`${viewport.name} incorrect response displayed correct-answer feedback`);
    if (await firstCheck.locator("input").first().isDisabled()) errors.push(`${viewport.name} incorrect knowledge-check response prevented another attempt`);
    await firstCheck.locator('input[value="d"]').check();
    if (await firstCheck.locator('input[value="a"]').evaluate((input) => input.closest("label")?.classList.contains("is-incorrect"))) errors.push(`${viewport.name} previous incorrect option remained marked after another attempt`);
    if (!(await firstCheck.locator('input[value="d"]').evaluate((input) => input.closest("label")?.classList.contains("is-incorrect")))) errors.push(`${viewport.name} alternative incorrect option was not marked`);
    await firstCheck.locator('input[value="b"]').check();
    if (!(await firstCheck.locator('input[value="b"]').evaluate((input) => input.closest("label")?.classList.contains("is-correct")))) errors.push(`${viewport.name} correct answer could not be selected after an incorrect attempt`);
    if (!(await firstCheck.locator("input").first().isDisabled())) errors.push(`${viewport.name} knowledge check did not lock after the correct answer`);
    if (!(await firstCheck.locator(".knowledge-feedback").isVisible())) errors.push(`${viewport.name} corrected response did not display feedback`);
    const secondCheck = page.locator("knowledge-check").nth(1);
    await secondCheck.locator('input[value="c"]').check();
    if (!(await secondCheck.locator('input[value="c"]').evaluate((input) => input.closest("label")?.classList.contains("is-correct")))) errors.push(`${viewport.name} correct knowledge-check option was not marked`);
    if (!(await secondCheck.locator(".knowledge-feedback").isVisible()) || !(await secondCheck.locator(".knowledge-feedback").textContent())?.startsWith("Correct:")) errors.push(`${viewport.name} correct knowledge-check feedback was not displayed`);

    if (viewport.width <= 1024) {
      const toggle = page.locator(".nav-toggle"); await toggle.click();
      if (await toggle.getAttribute("aria-expanded") !== "true" || !(await page.locator(".course-links").isVisible())) errors.push(`${viewport.name} mobile navigation did not open`);
      await page.locator('.course-links a[href="#five-rules"]').click();
      if (await toggle.getAttribute("aria-expanded") !== "false") errors.push(`${viewport.name} mobile navigation did not close`);
    }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => document.querySelector(".back-to-top")?.classList.contains("is-visible"));
    await page.locator(".back-to-top").click();
    await page.waitForFunction(() => window.scrollY === 0);
    await context.close();
  }

  const localContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const localPage = await localContext.newPage(); monitor(localPage, "local fallback");
  await localPage.goto(baseUrl, { waitUntil: "networkidle" });
  await localPage.locator(".rule-card").nth(2).click();
  const retryCheck = localPage.locator("knowledge-check").first();
  await retryCheck.locator('input[value="a"]').check();
  await localPage.reload({ waitUntil: "networkidle" });
  if (await localPage.locator(".rule-card").nth(2).getAttribute("aria-pressed") !== "true") errors.push("local interaction state did not survive reload");
  const reloadedCheck = localPage.locator("knowledge-check").first();
  if (await reloadedCheck.locator("input").first().isDisabled()) errors.push("knowledge check remained locked after reload");
  if (await reloadedCheck.locator("input:checked").count()) errors.push("knowledge check restored a visible answer after reload");
  if (await reloadedCheck.locator(".is-correct, .is-incorrect").count()) errors.push("knowledge check restored result colours after reload");
  await reloadedCheck.locator('input[value="b"]').check();
  if (!(await reloadedCheck.locator('input[value="b"]').evaluate((input) => input.closest("label")?.classList.contains("is-correct")))) errors.push("reloaded knowledge check could not accept a fresh answer");
  if ((await reloadedCheck.locator(".knowledge-feedback").textContent())?.trim() !== "Correct: All other tenders must be applied first. Payflex comes last and covers the full remaining balance.") errors.push("tender-order check did not display the exact storyboard feedback");
  if (await localPage.locator(".return-button").evaluate((button) => button.classList.contains("is-ready"))) errors.push("local course was ready for completion without required participation");
  await localContext.close();

  const incompleteContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await incompleteContext.addInitScript(() => {
    const calls = []; const values = { "cmi.core.lesson_status": "not attempted", "cmi.core.total_time": "0000:00:00.00" };
    window.__lmsCalls = calls; window.__lmsValues = values;
    window.API = {
      LMSInitialize(value) { calls.push(["LMSInitialize", value]); return "true"; }, LMSGetValue(element) { calls.push(["LMSGetValue", element]); return values[element] ?? ""; },
      LMSSetValue(element, value) { calls.push(["LMSSetValue", element, value]); values[element] = value; return "true"; }, LMSCommit(value) { calls.push(["LMSCommit", value]); return "true"; }, LMSFinish(value) { calls.push(["LMSFinish", value]); return "true"; },
    };
  });
  const incompletePage = await incompleteContext.newPage(); monitor(incompletePage, "incomplete LMS");
  await incompletePage.goto(baseUrl, { waitUntil: "networkidle" });
  if ((await incompletePage.evaluate(() => window.__lmsValues["cmi.core.lesson_status"])) !== "incomplete") errors.push("LMS launch did not remain incomplete");
  if (await incompletePage.evaluate(() => window.__lmsCalls.some(([method, element, value]) => method === "LMSSetValue" && element === "cmi.core.lesson_status" && value === "completed"))) errors.push("LMS launch auto-completed the course");
  await incompletePage.locator(".return-button").click({ force: true });
  if (await incompletePage.evaluate(() => window.__lmsCalls.some(([method, element, value]) => method === "LMSSetValue" && element === "cmi.core.lesson_status" && value === "completed"))) errors.push("premature return completed the course");
  const incompleteClose = await incompletePage.evaluate(() => { window.__lmsCalls.length = 0; const result = window.CourseSCORM.finish(); return { result, calls: window.__lmsCalls, values: window.__lmsValues }; });
  if (!incompleteClose.result || incompleteClose.values["cmi.core.lesson_status"] !== "incomplete" || incompleteClose.values["cmi.core.exit"] !== "suspend") errors.push("incomplete close did not preserve suspend state");
  await incompleteContext.close();

  const completeContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await completeContext.addInitScript(() => {
    const calls = []; const stored = sessionStorage.getItem("payflex-lms-values"); const values = stored ? JSON.parse(stored) : { "cmi.core.lesson_status": "not attempted", "cmi.core.total_time": "0000:00:00.00" };
    const save = () => sessionStorage.setItem("payflex-lms-values", JSON.stringify(values));
    window.__lmsCalls = calls; window.__lmsValues = values;
    window.API = {
      LMSInitialize(value) { calls.push(["LMSInitialize", value]); return "true"; }, LMSGetValue(element) { calls.push(["LMSGetValue", element]); return values[element] ?? ""; },
      LMSSetValue(element, value) { calls.push(["LMSSetValue", element, value]); values[element] = value; save(); return "true"; }, LMSCommit(value) { calls.push(["LMSCommit", value]); save(); return "true"; }, LMSFinish(value) { calls.push(["LMSFinish", value]); return "true"; },
    };
  });
  const completePage = await completeContext.newPage(); monitor(completePage, "earned completion LMS");
  await completePage.goto(baseUrl, { waitUntil: "networkidle" });
  for (const section of await completePage.locator("[data-progress-section]").all()) { await section.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" })); await completePage.waitForTimeout(120); }
  await exerciseRequiredInteractions(completePage);
  await completePage.locator("#complete").evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await completePage.waitForTimeout(250);
  try { await completePage.waitForFunction(() => document.querySelector(".return-button")?.classList.contains("is-ready"), undefined, { timeout: 3000 }); } catch { errors.push("return control did not unlock after all requirements"); }
  await completePage.evaluate(() => { window.__lmsCalls.length = 0; });
  await completePage.locator(".return-button").click();
  const completionResult = await completePage.evaluate(() => ({ calls: window.__lmsCalls, values: window.__lmsValues }));
  const completedIndex = completionResult.calls.findIndex(([method, element, value]) => method === "LMSSetValue" && element === "cmi.core.lesson_status" && value === "completed");
  const commitIndex = completionResult.calls.findIndex(([method], index) => method === "LMSCommit" && index > completedIndex);
  const finishIndex = completionResult.calls.findIndex(([method], index) => method === "LMSFinish" && index > commitIndex);
  if (completedIndex < 0 || commitIndex < 0 || finishIndex < 0) errors.push("earned completion did not set, commit and finish in order");
  if (completionResult.values["cmi.core.lesson_status"] !== "completed" || completionResult.values["cmi.core.exit"] !== "") errors.push("earned completion values were not retained");
  await completePage.reload({ waitUntil: "networkidle" });
  if ((await completePage.evaluate(() => window.__lmsValues["cmi.core.lesson_status"])) !== "completed") errors.push("completed LMS state did not survive reopen");
  if (!(await completePage.locator("branching-challenge").isHidden())) errors.push("completed Final Challenge panel was restored after reopen");
  await completeContext.close();
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}

if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("Payflex on oneX verification passed: content, assets, 11 responsive widths, mouse/keyboard/touch controls, instant retry-until-correct knowledge checks, correct sort, four successful challenge stages, local/LMS persistence, incomplete exit, earned completion, commit-before-finish, navigation and scroll-to-top.");
