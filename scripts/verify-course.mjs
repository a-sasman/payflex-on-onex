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
    const feedback = (await part.locator(".interaction-feedback").innerText()).trim();
    if (!feedback.startsWith("Correct. ") || /^Correct\.\s*Correct\./.test(feedback)) errors.push(`challenge part ${index + 1} has incorrect success feedback: ${feedback}`);
    await part.locator(".challenge-next").click();
  }
  const challenge = page.locator("branching-challenge");
  if (!(await challenge.isVisible()) || !(await challenge.locator('[data-part="3"]').isVisible()) || (await challenge.locator('[data-part="3"] .challenge-next').innerText()).trim() !== "Challenge complete") errors.push("completed Final Challenge did not remain visible on its final step");
  const completedPart = challenge.locator('[data-part="3"]');
  const reviewChoice = completedPart.locator('[data-correct="false"]').first();
  await reviewChoice.click();
  if (await reviewChoice.getAttribute("aria-pressed") !== "true" || !(await completedPart.locator(".interaction-feedback").innerText()).startsWith("Not quite.")) errors.push("completed Final Challenge choices cannot be reviewed");
  await completedPart.locator('[data-correct="true"]').click();
}

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 500 });
    const page = await context.newPage(); monitor(page, viewport.name);
    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    if (!response?.ok()) errors.push(`${viewport.name} returned HTTP ${response?.status() ?? "unknown"}`);
    if (await page.title() !== "Payflex on oneX") errors.push(`${viewport.name} has an incorrect title`);
    if (await page.locator("[data-progress-section]").count() !== 11) errors.push(`${viewport.name} does not render all 11 tracked course sections`);
    if (await page.locator(".course-links a").count() !== 6) errors.push(`${viewport.name} does not render the production navigation`);
    const mainText = await page.locator("main").innerText();
    for (const expected of ["Welcome", "The oneX journey", "Five Rules", "Exclusions", "Returns", "When Payflex is missing", "Final challenge", "021 937 4499", "Well done. You can now apply the Payflex rules on oneX."]) {
      if (!mainText.includes(expected)) errors.push(`${viewport.name} is missing learner content: ${expected}`);
    }
    if (/\[[A-Z][A-Z\s-]+\]/.test(mainText)) errors.push(`${viewport.name} contains placeholder copy`);
    if (/Quick Course|Hypnos|Cotton Origins/i.test(mainText)) errors.push(`${viewport.name} contains previous-course identity`);
    if (await page.locator(".rule-card-list .rule-card").count() !== 5) errors.push(`${viewport.name} does not render five rules`);
    if (await page.locator(".rule-card-list button, .rules-section .interaction-status").count()) errors.push(`${viewport.name} five rules still render interactive controls or selection status`);
    if (await page.locator("knowledge-check").count() !== 4 || await page.locator("knowledge-check input").count() !== 16) errors.push(`${viewport.name} does not render four four-option checks`);
    const prefixedOptions = await page.locator("knowledge-check .option-list span").evaluateAll((options) => options.filter((option) => /^[A-D]\.\s/.test(option.textContent ?? "")).map((option) => option.textContent));
    if (prefixedOptions.length) errors.push(`${viewport.name} knowledge-check options still show letter prefixes: ${prefixedOptions.join(", ")}`);
    if (await page.locator('knowledge-check button[type="submit"]').count()) errors.push(`${viewport.name} knowledge checks still render submit controls`);
    if (await page.locator("product-sort .sort-card").count() !== 6) errors.push(`${viewport.name} does not render the allowed/excluded sort`);
    const exclusionTypeStyles = await page.locator(".exclusions-section .policy-pill").evaluate((panel) => [...panel.querySelectorAll("h2, p")].map((element) => getComputedStyle(element).fontStyle));
    if (exclusionTypeStyles.some((fontStyle) => fontStyle !== "normal")) errors.push(`${viewport.name} exclusions copy is italicized`);
    const returnsPanel = page.locator(".returns-section .policy-pill");
    const returnsTypeStyles = await returnsPanel.evaluate((panel) => [...panel.querySelectorAll("h2, p")].map((element) => getComputedStyle(element).fontStyle));
    if (returnsTypeStyles.some((fontStyle) => fontStyle !== "normal")) errors.push(`${viewport.name} returns copy is italicized`);
    if (await returnsPanel.locator("p").count() !== 2 || !(await returnsPanel.innerText()).includes("Payflex returns are not yet supported in oneX.") || !(await returnsPanel.innerText()).includes("Example: A customer returns a dress originally bought with Payflex.")) errors.push(`${viewport.name} returns guidance or example is missing`);
    if (await page.locator("returns-journey, missing-step-reveal").count() !== 2) errors.push(`${viewport.name} is missing a journey or support steps`);
    const refundRules = page.locator("returns-journey");
    if ((await refundRules.locator("h3").textContent())?.trim() !== "Refund Rules" || !(await refundRules.locator(".journey-description").innerText()).startsWith("Returns work a little differently")) errors.push(`${viewport.name} refund-rules heading or description is missing`);
    if (await refundRules.locator(".journey-steps li").count() !== 3 || await refundRules.locator(".journey-steps li strong").count() !== 3 || await refundRules.locator(".journey-steps li em").count() !== 3) errors.push(`${viewport.name} does not render three refund rules with examples`);
    if (await page.locator("missing-step-reveal .missing-step-list li").count() !== 4 || await page.locator("missing-step-reveal button").count()) errors.push(`${viewport.name} support steps are not fully visible as static content`);
    if (!(await page.locator("missing-step-reveal").innerText()).includes("2. Clear the cache in Settings")) errors.push(`${viewport.name} support step 2 is not visible`);
    if (await page.locator("branching-challenge .challenge-part").count() !== 4) errors.push(`${viewport.name} does not render four challenge stages`);
    const correctChoicePositions = await page.locator("branching-challenge .challenge-part").evaluateAll((parts) => parts.map((part) => [...part.querySelectorAll("[data-choice]")].findIndex((choice) => choice.getAttribute("data-correct") === "true")));
    if (correctChoicePositions.some((position) => position <= 0) || new Set(correctChoicePositions).size < 3) errors.push(`${viewport.name} Final Challenge correct answers are not sufficiently mixed`);
    const footerCopy = page.locator(".return-copy");
    const footerStyle = await footerCopy.evaluate((copy) => ({ color: getComputedStyle(copy).color, cursor: getComputedStyle(copy).cursor, decoration: getComputedStyle(copy).textDecorationLine, pointerEvents: getComputedStyle(copy).pointerEvents, hasClickHandler: copy.onclick !== null }));
    if ((await footerCopy.innerText()).trim() !== "Return to People Connect to continue" || await page.locator(".course-footer button, .course-footer a").count() || await page.locator("#complete[data-progress-section]").count() || footerStyle.color !== "rgb(255, 255, 255)" || footerStyle.cursor !== "default" || footerStyle.decoration !== "none" || footerStyle.pointerEvents !== "none" || footerStyle.hasClickHandler) errors.push(`${viewport.name} return footer is not plain, static, or tracking-independent`);
    const completionCopy = page.locator(".completion-copy");
    const reminderBorder = await completionCopy.locator(".completion-reminder").evaluate((reminder) => getComputedStyle(reminder).borderTopWidth);
    if (await completionCopy.locator("p").count() !== 2 || reminderBorder !== "0px") errors.push(`${viewport.name} completion copy is not grouped without a border`);
    const missingTargets = await page.evaluate(() => [...document.querySelectorAll('.course-links a[href^="#"]')].map((link) => link.getAttribute("href")).filter((href) => !href || !document.querySelector(href)));
    if (missingTargets.length) errors.push(`${viewport.name} has missing navigation targets: ${missingTargets.join(", ")}`);
    const unloadedImages = await page.locator("img").evaluateAll((images) => images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")));
    if (unloadedImages.length) errors.push(`${viewport.name} has unloaded images: ${unloadedImages.join(", ")}`);
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, clipped: [...document.querySelectorAll("[data-progress-section]")].filter((element) => element.scrollHeight > element.clientHeight + 2 && getComputedStyle(element).overflowY === "hidden").map((element) => element.id) }));
    if (layout.overflow) errors.push(`${viewport.name} has horizontal page overflow`);
    if (layout.clipped.length) errors.push(`${viewport.name} has clipped sections: ${layout.clipped.join(", ")}`);

    const questionLayouts = await page.locator("knowledge-check .question-copy").evaluateAll((questions) => questions.map((question) => [...question.querySelectorAll(":scope > span")].map((line) => {
      const box = line.getBoundingClientRect();
      return { left: box.left, top: box.top, bottom: box.bottom };
    })));
    if (questionLayouts.length !== 4 || questionLayouts.some((lines) => lines.length !== 2 || Math.abs(lines[0].left - lines[1].left) > 1 || lines[1].top < lines[0].bottom)) {
      errors.push(`${viewport.name} one or more knowledge-check prompts are not on their own aligned line`);
    }
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
  const retryCheck = localPage.locator("knowledge-check").first();
  await retryCheck.locator('input[value="a"]').check();
  await localPage.reload({ waitUntil: "networkidle" });
  const reloadedCheck = localPage.locator("knowledge-check").first();
  if (await reloadedCheck.locator("input").first().isDisabled()) errors.push("knowledge check remained locked after reload");
  if (await reloadedCheck.locator("input:checked").count()) errors.push("knowledge check restored a visible answer after reload");
  if (await reloadedCheck.locator(".is-correct, .is-incorrect").count()) errors.push("knowledge check restored result colours after reload");
  await reloadedCheck.locator('input[value="b"]').check();
  if (!(await reloadedCheck.locator('input[value="b"]').evaluate((input) => input.closest("label")?.classList.contains("is-correct")))) errors.push("reloaded knowledge check could not accept a fresh answer");
  if ((await reloadedCheck.locator(".knowledge-feedback").textContent())?.trim() !== "Correct: All other tenders must be applied first. Payflex comes last and covers the full remaining balance.") errors.push("tender-order check did not display the exact storyboard feedback");
  await localContext.close();

  const standardContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await standardContext.addInitScript(() => {
    const calls = []; const stored = sessionStorage.getItem("payflex-lms-values"); const values = stored ? JSON.parse(stored) : { "cmi.core.lesson_status": "not attempted", "cmi.core.total_time": "0000:00:00.00" };
    const save = () => sessionStorage.setItem("payflex-lms-values", JSON.stringify(values));
    window.__lmsCalls = calls; window.__lmsValues = values;
    window.API = {
      LMSInitialize(value) { calls.push(["LMSInitialize", value]); return "true"; }, LMSGetValue(element) { calls.push(["LMSGetValue", element]); return values[element] ?? ""; },
      LMSSetValue(element, value) { calls.push(["LMSSetValue", element, value]); values[element] = value; save(); return "true"; }, LMSCommit(value) { calls.push(["LMSCommit", value]); save(); return "true"; }, LMSFinish(value) { calls.push(["LMSFinish", value]); return "true"; },
    };
  });
  const standardPage = await standardContext.newPage(); monitor(standardPage, "Oracle launch-completion LMS");
  await standardPage.goto(baseUrl, { waitUntil: "networkidle" });
  const launchResult = await standardPage.evaluate(() => ({ calls: [...window.__lmsCalls], values: { ...window.__lmsValues } }));
  const initializeIndex = launchResult.calls.findIndex(([method]) => method === "LMSInitialize");
  const launchCompletedIndex = launchResult.calls.findIndex(([method, element, value]) => method === "LMSSetValue" && element === "cmi.core.lesson_status" && value === "completed");
  const launchCommitIndex = launchResult.calls.findIndex(([method], index) => method === "LMSCommit" && index > launchCompletedIndex);
  if (initializeIndex < 0 || launchCompletedIndex <= initializeIndex || launchCommitIndex <= launchCompletedIndex || launchResult.values["cmi.core.lesson_status"] !== "completed" || launchResult.values["cmi.core.exit"] !== "") errors.push("SCORM did not mark completed and commit immediately after successful initialization");
  if (launchResult.calls.some((call) => /score|mastery|passed|failed/i.test(call.join(" ")))) errors.push("SCORM launch emitted score or pass/fail data");

  await standardPage.locator(".return-copy").scrollIntoViewIfNeeded();
  await standardPage.waitForTimeout(250);
  await standardPage.evaluate(() => { window.__lmsCalls.length = 0; });
  await standardPage.locator(".course-footer").hover();
  await standardPage.locator(".return-copy").evaluate((element) => element.click());
  const hoveredFooterStyle = await standardPage.locator(".return-copy").evaluate((element) => ({ decoration: getComputedStyle(element).textDecorationLine, borderBottom: getComputedStyle(element).borderBottomWidth }));
  if (hoveredFooterStyle.decoration !== "none" || hoveredFooterStyle.borderBottom !== "0px") errors.push("footer gains an underline or border on hover");
  await standardPage.waitForTimeout(100);
  if ((await standardPage.evaluate(() => window.__lmsCalls.length)) !== 0) errors.push("footer interaction or visibility produced LMS traffic");

  for (const section of await standardPage.locator("[data-progress-section]").all()) { await section.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" })); await standardPage.waitForTimeout(120); }
  await exerciseRequiredInteractions(standardPage);
  const activityStatusWrites = await standardPage.evaluate(() => window.__lmsCalls.filter(([method, element]) => method === "LMSSetValue" && (element === "cmi.core.lesson_status" || /score/i.test(element))));
  if (activityStatusWrites.length) errors.push("content activity changed LMS completion or score state");

  const closeResult = await standardPage.evaluate(() => { window.__lmsCalls.length = 0; const first = window.CourseSCORM.finish(); const second = window.CourseSCORM.finish(); return { first, second, calls: [...window.__lmsCalls], values: { ...window.__lmsValues } }; });
  if (!closeResult.first || !closeResult.second || closeResult.calls.filter(([method]) => method === "LMSFinish").length !== 1 || closeResult.values["cmi.core.lesson_status"] !== "completed" || closeResult.values["cmi.core.exit"] !== "") errors.push("SCORM closure did not preserve completion with one guarded LMSFinish");

  await standardPage.reload({ waitUntil: "networkidle" });
  if ((await standardPage.evaluate(() => window.__lmsValues["cmi.core.lesson_status"])) !== "completed") errors.push("completed LMS state did not survive reopen");
  const restartedChallenge = standardPage.locator("branching-challenge");
  const restartedFirstPart = restartedChallenge.locator('[data-part="0"]');
  if (!(await restartedChallenge.isVisible()) || !(await restartedFirstPart.isVisible()) || await restartedChallenge.locator('[aria-pressed="true"]').count() || (await restartedFirstPart.locator(".interaction-feedback").innerText()).trim() || !(await restartedFirstPart.locator(".challenge-next").isDisabled())) errors.push("Final Challenge did not restart cleanly at Part 1 after reopen");
  const storedChallengeState = await standardPage.evaluate(() => window.CourseState.getInteraction("final-challenge-activity"));
  if (storedChallengeState?.complete !== true || "current" in storedChallengeState || "answers" in storedChallengeState) errors.push("Final Challenge stored step or answer progress instead of completion only");
  await standardContext.close();
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}

if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("Payflex on oneX verification passed: content, assets, 11 responsive widths, static LMS-independent footer, launch completion with immediate commit, one guarded finish, mouse/keyboard/touch controls, knowledge checks, product sort, mixed-answer reset-on-load challenge, navigation and scroll-to-top.");
